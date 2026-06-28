import { SoundBridgeLiveEffectRack } from "../packages/web-client/dist/soundbridge-client.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const plugin = {
  pluginId: "mock.live-rack-process-timeout-event",
  format: "mock",
  inputs: 1,
  outputs: 1
};

function createClient(processAudioBlockBinary) {
  let created = 0;
  return {
    timeouts: [],
    async createInstance() {
      created += 1;
      return { instanceId: `inst-${created}`, latencySamples: 0 };
    },
    async destroyInstance() {},
    processAudioBlockBinary(request, timeoutMs) {
      this.timeouts.push(timeoutMs);
      return processAudioBlockBinary(request, timeoutMs);
    }
  };
}

const timeoutClient = createClient(() => new Promise(() => undefined));
const timeoutRack = await SoundBridgeLiveEffectRack.create({
  client: timeoutClient,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128,
  processTimeoutMs: 1
});
let timeoutEvents = 0;
let timeoutTripEvents = 0;
let timeoutEventDetail;
let timeoutTripEventDetail;
let effectErrorEvents = 0;
timeoutRack.addEventListener("process-timeout", (event) => {
  timeoutEvents += 1;
  timeoutEventDetail = event.detail;
});
timeoutRack.addEventListener("process-timeout-tripped", (event) => {
  timeoutTripEvents += 1;
  timeoutTripEventDetail = event.detail;
});
timeoutRack.addEventListener("effect-error", () => {
  effectErrorEvents += 1;
});
const timedOut = await timeoutRack.processBlock({ blockId: 1, channels: [[0.5]] });
assert(timedOut.bypassed === true && timedOut.healthy === false, "live rack process timeout fails dry");
assert(timeoutRack.health.processTimeoutRecoveryExhausted === true, "live rack reports unavailable timeout recovery as exhausted");
assert(timeoutClient.timeouts.at(-1) === 1, "live rack process timeout passes bounded request timeout");
assert(timeoutEvents === 1 && timeoutTripEvents === 1 && effectErrorEvents === 1, "live rack emits timeout and timeout-trip events beside generic effect-error");
assert(
  timeoutEventDetail.health.unhealthyReason === "process-timeout" &&
    timeoutEventDetail.error?.name === "SoundBridgeLiveEffectTimeout",
  "live rack process-timeout event carries timeout health and error"
);
assert(
  timeoutTripEventDetail.health.unhealthyReason === "process-timeout" &&
    timeoutTripEventDetail.error?.name === "SoundBridgeLiveEffectTimeout",
  "live rack process-timeout trip event carries timeout health and error"
);
await timeoutRack.destroy();

const failureClient = createClient(async () => {
  throw new Error("plain processing failure");
});
const failureRack = await SoundBridgeLiveEffectRack.create({
  client: failureClient,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128
});
let unexpectedTimeoutEvents = 0;
let unexpectedTimeoutTripEvents = 0;
failureRack.addEventListener("process-timeout", () => {
  unexpectedTimeoutEvents += 1;
});
failureRack.addEventListener("process-timeout-tripped", () => {
  unexpectedTimeoutTripEvents += 1;
});
const failed = await failureRack.processBlock({ blockId: 2, channels: [[0.25]] });
assert(failed.bypassed === true && failureRack.health.unhealthyReason === "processing-error", "live rack still classifies ordinary processing errors");
assert(unexpectedTimeoutEvents === 0 && unexpectedTimeoutTripEvents === 0, "live rack does not emit timeout events for ordinary processing errors");
await failureRack.destroy();

const cappedRecoveryClient = createClient(() => new Promise(() => undefined));
const cappedRecoveryRack = await SoundBridgeLiveEffectRack.create({
  client: cappedRecoveryClient,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128,
  processTimeoutMs: 1,
  processTimeoutRecoveryBlocks: 1,
  maxProcessTimeoutRecoveries: 1
});
await cappedRecoveryRack.processBlock({ blockId: 3, channels: [[0.5]] });
assert(cappedRecoveryRack.health.processTimeoutRecoveryExhausted === false, "live rack does not report timeout recovery exhausted before its cooldown");
await cappedRecoveryRack.processBlock({ blockId: 4, channels: [[0.5]] });
await new Promise((resolve) => setTimeout(resolve, 0));
await cappedRecoveryRack.processBlock({ blockId: 5, channels: [[0.5]] });
assert(cappedRecoveryRack.health.processTimeoutRecoveryExhausted === true, "live rack reports exhausted timeout recovery after the retry cap");
await cappedRecoveryRack.destroy();

console.log("Live effect rack process-timeout event smoke checks passed.");
