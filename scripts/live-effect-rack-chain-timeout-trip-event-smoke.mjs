import { createLiveEffectRackChain } from "../packages/web-client/dist/soundbridge-client.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let nowMs = 0;

const hangingStage = {
  health: { healthy: true },
  async processBlock() {
    return new Promise(() => undefined);
  }
};

const chain = createLiveEffectRackChain({
  stages: [hangingStage],
  outputChannels: 1,
  maxBlockSize: 128,
  processTimeoutMs: 1,
  nowMs: () => nowMs
});
let timeoutEvents = 0;
let timeoutTripEvents = 0;
let timeoutDetail;
let timeoutTripDetail;
chain.addEventListener("chain-process-timeout", (event) => {
  timeoutEvents += 1;
  timeoutDetail = event.detail;
});
chain.addEventListener("chain-process-timeout-tripped", (event) => {
  timeoutTripEvents += 1;
  timeoutTripDetail = event.detail;
});

const timedOut = await chain.processBlock({ blockId: 1, channels: [[0.5]], sampleRate: 48000 });
assert(timedOut.bypassed === true && timedOut.renderEngine === "chain-process-timeout", "chain returns dry output on aggregate timeout");
assert(timedOut.chainProcessTimedOut === true && timedOut.chainUnhealthyReason === "process-timeout", "chain response records timeout trip state");
assert(chain.health.processTimeoutTripped === true && chain.health.healthy === false, "chain health records timeout trip state");
assert(timeoutEvents === 1 && timeoutTripEvents === 1, "chain emits timeout and timeout-trip events");
assert(timeoutDetail.response === timedOut && timeoutDetail.health.processTimeoutTripped === true, "chain timeout event includes tripped health");
assert(timeoutTripDetail.response === timedOut, "chain timeout trip event includes timeout response");
assert(timeoutTripDetail.health.processTimeoutTripped === true, "chain timeout trip event includes tripped health");

console.log("Live effect rack chain timeout trip event smoke checks passed.");
