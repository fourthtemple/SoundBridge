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

let recoveryNowMs = 0;
let recoveryDurationMs = 3;
const recoveryStage = {
  health: { healthy: true },
  async processBlock(request) {
    recoveryNowMs += recoveryDurationMs;
    return { blockId: request.blockId, channels: request.channels, latencySamples: 0, tailSamples: 0, infiniteTail: false, renderEngine: "chain-timeout-recovery", bypassed: false, healthy: true };
  }
};
const recoveryChain = createLiveEffectRackChain({
  stages: [recoveryStage],
  outputChannels: 1,
  maxBlockSize: 128,
  processTimeoutMs: 2,
  processTimeoutRecoveryBlocks: 2,
  nowMs: () => recoveryNowMs
});
const recoveryTrip = await recoveryChain.processBlock({ blockId: 2, channels: [[0.5]], sampleRate: 48000 });
assert(recoveryTrip.bypassed === true && recoveryChain.health.recoveryDryBlocksRemaining === 2, "chain timeout recovery reports full dry cooldown after trip");
recoveryDurationMs = 0;
await recoveryChain.processBlock({ blockId: 3, channels: [[0.25]], sampleRate: 48000 });
assert(recoveryChain.health.timeoutRecoveryDryBlocks === 1 && recoveryChain.health.recoveryDryBlocksRemaining === 1, "chain timeout recovery reports remaining dry cooldown");
await recoveryChain.processBlock({ blockId: 4, channels: [[0.25]], sampleRate: 48000 });
assert(recoveryChain.health.processTimeoutTripped === false && recoveryChain.health.recoveryDryBlocksRemaining === 0, "chain timeout recovery clears remaining dry cooldown");

console.log("Live effect rack chain timeout trip event smoke checks passed.");
