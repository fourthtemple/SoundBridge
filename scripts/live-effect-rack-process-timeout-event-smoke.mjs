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
let timeoutEventDetail;
let effectErrorEvents = 0;
timeoutRack.addEventListener("process-timeout", (event) => {
  timeoutEvents += 1;
  timeoutEventDetail = event.detail;
});
timeoutRack.addEventListener("effect-error", () => {
  effectErrorEvents += 1;
});
const timedOut = await timeoutRack.processBlock({ blockId: 1, channels: [[0.5]] });
assert(timedOut.bypassed === true && timedOut.healthy === false, "live rack process timeout fails dry");
assert(timeoutClient.timeouts.at(-1) === 1, "live rack process timeout passes bounded request timeout");
assert(timeoutEvents === 1 && effectErrorEvents === 1, "live rack emits process-timeout beside generic effect-error");
assert(
  timeoutEventDetail.health.unhealthyReason === "process-timeout" &&
    timeoutEventDetail.error?.name === "SoundBridgeLiveEffectTimeout",
  "live rack process-timeout event carries timeout health and error"
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
failureRack.addEventListener("process-timeout", () => {
  unexpectedTimeoutEvents += 1;
});
const failed = await failureRack.processBlock({ blockId: 2, channels: [[0.25]] });
assert(failed.bypassed === true && failureRack.health.unhealthyReason === "processing-error", "live rack still classifies ordinary processing errors");
assert(unexpectedTimeoutEvents === 0, "live rack does not emit process-timeout for ordinary processing errors");
await failureRack.destroy();

console.log("Live effect rack process-timeout event smoke checks passed.");
