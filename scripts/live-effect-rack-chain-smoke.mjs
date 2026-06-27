import {
  createLiveEffectRackBlockScheduler,
  createLiveEffectRackChain
} from "../packages/web-client/dist/soundbridge-client.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

let fakeNowMs = 0;

class FakeStage {
  constructor(name, gain, latencySamples = 0, tailSamples = 0, durationMs = 0) {
    this.name = name;
    this.gain = gain;
    this.latencySamples = latencySamples;
    this.tailSamples = tailSamples;
    this.durationMs = durationMs;
    this.requests = [];
    this.health = { instanceId: `inst-${name}` };
  }

  async processBlock(request) {
    this.requests.push(request);
    fakeNowMs += this.durationMs;
    return {
      blockId: request.blockId,
      channels: request.channels.map((channel) => Array.from(channel, (sample) => sample * this.gain)),
      latencySamples: this.latencySamples,
      tailSamples: this.tailSamples,
      infiniteTail: false,
      renderEngine: `stage-${this.name}`,
      bypassed: false,
      healthy: true
    };
  }
}

const left = new FakeStage("left", 2, 12, 3);
const right = new FakeStage("right", 0.5, 5, 7);
const chain = createLiveEffectRackChain({
  stages: [left, right],
  outputChannels: 2,
  maxBlockSize: 4
});

const response = await chain.processBlock(
  {
    blockId: 4,
    channels: [[1, 2, 3, 4], [0.5, 1, 1.5, 2]],
    sampleRate: 48000,
    timestamp: 10
  },
  { stageWetMixes: [0.25, 0.75] }
);

assert(response.channels[0][0] === 1 && response.channels[1][3] === 2, "live rack chain pipes stage output into later stages");
assert(response.latencySamples === 17 && response.tailSamples === 10, "live rack chain accumulates bounded latency and tail");
assert(response.stageCount === 2 && response.processedStages === 2, "live rack chain reports processed stages");
assert(response.stageResults[0].instanceId === "inst-left", "live rack chain reports stage instance ids");
assert(left.requests[0].wetMix === 0.25 && right.requests[0].wetMix === 0.75, "live rack chain applies per-stage wet mix overrides");
assert(response.chainProcessBudgetExceeded === false && response.chainProcessBudgetMisses === 0, "live rack chain starts without chain budget pressure");

fakeNowMs = 0;
const timedChain = createLiveEffectRackChain({
  stages: [new FakeStage("timed-left", 1, 0, 0, 4), new FakeStage("timed-right", 1, 0, 0, 5)],
  outputChannels: 1,
  maxBlockSize: 2,
  processBudgetMs: 12,
  maxConsecutiveProcessBudgetMisses: 2,
  nowMs: () => fakeNowMs
});
const timed = await timedChain.processBlock({ blockId: 5, channels: [[1, 1]], sampleRate: 48000 });
assert(timed.chainProcessDurationMs === 9, "live rack chain reports bounded chain process duration");
assert(timed.chainProcessBudgetMs === 12 && timed.chainProcessBudgetExceeded === false, "live rack chain reports in-budget chain timing");
assert(timed.stageResults[0].durationMs === 4 && timed.stageResults[1].durationMs === 5, "live rack chain reports per-stage duration");

fakeNowMs = 0;
const pressureStage = new FakeStage("pressure", 4, 0, 0, 3);
const pressureChain = createLiveEffectRackChain({
  stages: [pressureStage],
  outputChannels: 1,
  maxBlockSize: 2,
  processBudgetMs: 2,
  maxConsecutiveProcessBudgetMisses: 2,
  nowMs: () => fakeNowMs
});
const firstPressure = await pressureChain.processBlock({ blockId: 6, channels: [[1, 1]], sampleRate: 48000 });
const secondPressure = await pressureChain.processBlock({ blockId: 7, channels: [[1, 1]], sampleRate: 48000 });
assert(firstPressure.chainProcessBudgetExceeded === true && firstPressure.chainProcessBudgetMisses === 1, "live rack chain counts first chain budget miss");
assert(firstPressure.healthy === true && firstPressure.chainProcessBudgetTripped === false, "live rack chain observes initial budget pressure before tripping");
assert(firstPressure.channels[0][0] === 4, "live rack chain keeps the first over-budget block wet before tripping");
assert(secondPressure.chainProcessBudgetMisses === 2 && secondPressure.chainProcessBudgetTripped === true, "live rack chain trips after bounded repeated misses");
assert(
  secondPressure.bypassed === true &&
    secondPressure.healthy === false &&
    secondPressure.error instanceof Error &&
    secondPressure.renderEngine === "chain-process-budget-exceeded" &&
    secondPressure.chainUnhealthyReason === "process-budget-exceeded" &&
    secondPressure.channels[0][0] === 1,
  "live rack chain fails dry on repeated chain budget pressure"
);
const thirdPressure = await pressureChain.processBlock({ blockId: 8, channels: [[2, 2]], sampleRate: 48000 });
assert(thirdPressure.bypassed === true && thirdPressure.channels[0][0] === 2, "tripped live rack chains stay dry");
assert(pressureStage.requests.length === 2, "tripped live rack chains stop calling slow stages");
assert(pressureChain.retry() === true, "live rack chain retry clears recoverable chain budget pressure");
const retriedPressure = await pressureChain.processBlock({ blockId: 9, channels: [[1, 1]], sampleRate: 48000 });
assert(retriedPressure.healthy === true && retriedPressure.channels[0][0] === 4, "retried live rack chains resume wet processing");
assert(pressureChain.retry() === false, "live rack chain retry only succeeds for active recoverable pressure");

const scheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 4,
  maxInputAgeMs: 1,
  nowMs: () => 20
});
const staleScheduled = scheduler.schedule([[0.2, 0.1]], { timestamp: 10 });
const staleResponse = await chain.processScheduledBlock(staleScheduled);
assert(staleResponse.bypassed === true, "live rack chain bypasses stale scheduled blocks");
assert(staleResponse.processedStages === 0 && left.requests.length === 1, "live rack chain does not process stale scheduled blocks");
assert(staleResponse.renderEngine === "chain-stale-input", "live rack chain labels stale scheduled bypasses");

const throwingStage = {
  health: { instanceId: "inst-throw" },
  async processBlock() {
    throw new Error("stage failed");
  }
};
const failingChain = createLiveEffectRackChain({ stages: [left, throwingStage, right], outputChannels: 2, maxBlockSize: 4 });
const failed = await failingChain.processBlock({ blockId: 10, channels: [[1, 1], [2, 2]], sampleRate: 48000 });
assert(failed.healthy === false && failed.failedStageIndex === 1, "live rack chain reports the failing stage");
assert(failed.processedStages === 2 && failed.stageResults[1].healthy === false, "live rack chain records the failed stage result");
assert(failed.channels[0][0] === 2 && failed.channels[1][0] === 4, "live rack chain fails dry to last known audio");

const empty = await createLiveEffectRackChain({ stages: [], outputChannels: 2, maxBlockSize: 4 })
  .processBlock({ blockId: 1, channels: [[0.4, 0.3]], sampleRate: 48000 });
assert(empty.bypassed === true && empty.renderEngine === "chain-empty", "live rack chain bypasses empty chains");
assert(empty.channels.length === 2, "live rack chain bounds empty-chain output channels");

console.log("Live effect rack chain smoke checks passed.");
