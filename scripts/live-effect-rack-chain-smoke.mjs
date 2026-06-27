import {
  createLiveEffectRackBlockScheduler,
  createLiveEffectRackChain
} from "../packages/web-client/dist/soundbridge-client.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function near(value, expected, tolerance = 0.000001) {
  return Math.abs(value - expected) <= tolerance;
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
const fadeStage = new FakeStage("fade", 4, 0, 0, 0);
const fadeChain = createLiveEffectRackChain({
  stages: [fadeStage],
  outputChannels: 1,
  maxBlockSize: 3,
  processBudgetMs: 1,
  maxConsecutiveProcessBudgetMisses: 1,
  transitionFadeSamples: 2,
  nowMs: () => fakeNowMs
});
const fadeWet = await fadeChain.processBlock({ blockId: 50, channels: [[1, 1, 1]], sampleRate: 48000 });
assert(fadeWet.channels[0][0] === 4 && fadeChain.health.transitionFadeSamples === 2, "live rack chain exposes transition fade policy");
fadeStage.durationMs = 2;
const fadedDry = await fadeChain.processBlock({ blockId: 51, channels: [[0, 0, 0]], sampleRate: 48000 });
assert(
  fadedDry.bypassed === true &&
    near(fadedDry.channels[0][0], 8 / 3) &&
    near(fadedDry.channels[0][1], 4 / 3) &&
    fadedDry.channels[0][2] === 0,
  "live rack chain fades wet output into dry failover"
);
assert(fadeChain.retry() === true, "live rack chain fade test can retry after pressure");
fadeStage.durationMs = 0;
const fadedWet = await fadeChain.processBlock({ blockId: 52, channels: [[1, 1, 1]], sampleRate: 48000 });
assert(
  fadedWet.bypassed === false &&
    near(fadedWet.channels[0][0], 4 / 3) &&
    near(fadedWet.channels[0][1], 8 / 3) &&
    fadedWet.channels[0][2] === 4,
  "live rack chain fades dry output back into wet processing"
);

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
let budgetEvents = 0;
let tripEvents = 0;
let healthEvents = 0;
let retryEvents = 0;
pressureChain.addEventListener("chain-process-budget-exceeded", (event) => {
  budgetEvents += 1;
  assert(event.detail.health.processBudgetExceeded === true, "live rack chain budget events include pressure health");
});
pressureChain.addEventListener("chain-process-budget-tripped", (event) => {
  tripEvents += 1;
  assert(event.detail.health.unhealthyReason === "process-budget-exceeded", "live rack chain trip events include unhealthy reason");
});
pressureChain.addEventListener("healthchange", () => {
  healthEvents += 1;
});
pressureChain.addEventListener("retry", (event) => {
  retryEvents += 1;
  assert(event.detail.health.healthy === true, "live rack chain retry events include recovered health");
});
assert(
  pressureChain.health.healthy === true &&
    pressureChain.health.stageCount === 1 &&
    pressureChain.health.processBudgetMisses === 0,
  "live rack chain exposes initial health"
);
const firstPressure = await pressureChain.processBlock({ blockId: 6, channels: [[1, 1]], sampleRate: 48000 });
const secondPressure = await pressureChain.processBlock({ blockId: 7, channels: [[1, 1]], sampleRate: 48000 });
assert(firstPressure.chainProcessBudgetExceeded === true && firstPressure.chainProcessBudgetMisses === 1, "live rack chain counts first chain budget miss");
assert(firstPressure.healthy === true && firstPressure.chainProcessBudgetTripped === false, "live rack chain observes initial budget pressure before tripping");
assert(firstPressure.channels[0][0] === 4, "live rack chain keeps the first over-budget block wet before tripping");
assert(
  pressureChain.health.processBudgetMisses === 2 &&
    pressureChain.health.lastProcessDurationMs === 3 &&
    pressureChain.health.processBudgetExceeded === true,
  "live rack chain health records process pressure"
);
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
assert(
  pressureChain.health.healthy === false &&
    pressureChain.health.processBudgetTripped === true &&
    pressureChain.health.lastError instanceof Error,
  "live rack chain health exposes tripped pressure"
);
assert(budgetEvents === 2 && tripEvents === 1 && healthEvents === 2, "live rack chain emits bounded pressure events");
const thirdPressure = await pressureChain.processBlock({ blockId: 8, channels: [[2, 2]], sampleRate: 48000 });
assert(thirdPressure.bypassed === true && thirdPressure.channels[0][0] === 2, "tripped live rack chains stay dry");
assert(pressureStage.requests.length === 2, "tripped live rack chains stop calling slow stages");
assert(pressureChain.retry() === true, "live rack chain retry clears recoverable chain budget pressure");
assert(
  pressureChain.health.healthy === true &&
    pressureChain.health.processBudgetMisses === 0 &&
    pressureChain.health.processBudgetExceeded === false,
  "live rack chain retry resets health"
);
const retriedPressure = await pressureChain.processBlock({ blockId: 9, channels: [[1, 1]], sampleRate: 48000 });
assert(retriedPressure.healthy === true && retriedPressure.channels[0][0] === 4, "retried live rack chains resume wet processing");
assert(pressureChain.retry() === false, "live rack chain retry only succeeds for active recoverable pressure");
assert(
  budgetEvents === 3 &&
    tripEvents === 1 &&
    healthEvents === 4 &&
    retryEvents === 1,
  "live rack chain emits retry and post-retry pressure events"
);

fakeNowMs = 0;
const recoveryStage = new FakeStage("recovery", 3, 0, 0, 3);
const recoveryChain = createLiveEffectRackChain({
  stages: [recoveryStage],
  outputChannels: 1,
  maxBlockSize: 2,
  processBudgetMs: 2,
  maxConsecutiveProcessBudgetMisses: 1,
  processBudgetRecoveryBlocks: 2,
  nowMs: () => fakeNowMs
});
let recoveredEvents = 0;
recoveryChain.addEventListener("chain-process-budget-recovered", (event) => {
  recoveredEvents += 1;
  assert(event.detail.health.healthy === true, "live rack chain recovery events include healthy state");
});
const recoveryTrip = await recoveryChain.processBlock({ blockId: 10, channels: [[1, 1]], sampleRate: 48000 });
assert(recoveryTrip.bypassed === true && recoveryChain.health.healthy === false, "live rack chain recovery starts from a dry trip");
const recoveryCooldownOne = await recoveryChain.processBlock({ blockId: 11, channels: [[2, 2]], sampleRate: 48000 });
assert(
  recoveryCooldownOne.bypassed === true &&
    recoveryChain.health.recoveryDryBlocks === 1 &&
    recoveryChain.health.healthy === false,
  "live rack chain recovery waits through bounded dry cooldown blocks"
);
const recoveryCooldownTwo = await recoveryChain.processBlock({ blockId: 12, channels: [[2, 2]], sampleRate: 48000 });
assert(recoveryCooldownTwo.bypassed === true && recoveryChain.health.healthy === true, "live rack chain recovers after dry cooldown");
assert(recoveryStage.requests.length === 1 && recoveredEvents === 1, "live rack chain recovery does not process during cooldown");
const recoveredBlock = await recoveryChain.processBlock({ blockId: 13, channels: [[1, 1]], sampleRate: 48000 });
assert(recoveredBlock.bypassed === true && recoveredBlock.channels[0][0] === 1, "live rack chain can trip again after automatic recovery");

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
const failed = await failingChain.processBlock({ blockId: 14, channels: [[1, 1], [2, 2]], sampleRate: 48000 });
assert(failed.healthy === false && failed.failedStageIndex === 1, "live rack chain reports the failing stage");
assert(failed.processedStages === 2 && failed.stageResults[1].healthy === false, "live rack chain records the failed stage result");
assert(failed.channels[0][0] === 2 && failed.channels[1][0] === 4, "live rack chain fails dry to last known audio");

const empty = await createLiveEffectRackChain({ stages: [], outputChannels: 2, maxBlockSize: 4 })
  .processBlock({ blockId: 1, channels: [[0.4, 0.3]], sampleRate: 48000 });
assert(empty.bypassed === true && empty.renderEngine === "chain-empty", "live rack chain bypasses empty chains");
assert(empty.channels.length === 2, "live rack chain bounds empty-chain output channels");

console.log("Live effect rack chain smoke checks passed.");
