import {
  createLiveEffectRackAdaptiveLatencyController,
  createLiveEffectRackBlockScheduler,
  createLiveEffectRackChainSchedulerAdaptiveLatencyController
} from "../packages/web-client/dist/soundbridge-client.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

class FakeRack {
  constructor() {
    this.health = { transportLatencySamples: 256 };
    this.refreshes = [];
  }

  async refreshLatency(transportLatencySamples) {
    this.refreshes.push(transportLatencySamples);
    this.health = { ...this.health, transportLatencySamples };
    return this.health;
  }
}

const rack = new FakeRack();
const controller = createLiveEffectRackAdaptiveLatencyController({
  rack,
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 256,
  processBudgetMs: 8,
  processTimeoutMs: 12,
  minSamples: 2,
  cooldownBlocks: 2,
  maxLatencyIncreaseBlocks: 2,
  latencyRecoveryBlocks: 2,
  maxLatencyDecreaseBlocks: 1,
  minTransportLatencyBlocks: 2,
  safetyMarginBlocks: 1
});

const ready = await controller.record({
  ...rack.health,
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1
});
assert(ready.applied === false, "adaptive rack latency waits for enough health samples");
assert(ready.currentTransportLatencySamples === 256, "adaptive rack latency reports current transport latency");
assert(ready.targetTransportLatencySamples === 256, "adaptive rack latency keeps in-budget latency unchanged");

const firstRaise = await controller.record({
  ...rack.health,
  lastProcessDurationMs: 0.6,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 4,
  lastResponseDeadlineLeadBlocks: -1
});
assert(firstRaise.applied === true, "adaptive rack latency applies upward recommendations under jitter pressure");
assert(firstRaise.appliedDirection === "increase", "adaptive rack latency reports upward changes");
assert(firstRaise.targetTransportLatencySamples === 512, "adaptive rack latency caps one increase to the configured step");
assert(firstRaise.cooldownBlocksRemaining === 2, "adaptive rack latency starts a bounded cooldown after applying");
assert(firstRaise.stableBlocks === 0, "adaptive rack latency clears stable recovery blocks after pressure");
assert(rack.refreshes.length === 1 && rack.refreshes[0] === 512, "adaptive rack latency refreshes the rack with the capped target");
assert(firstRaise.refreshResult.transportLatencySamples === 512, "adaptive rack latency returns the refresh result");

const cooldown = await controller.record({
  ...rack.health,
  lastProcessDurationMs: 0.6,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 4,
  lastResponseDeadlineLeadBlocks: -1
});
assert(cooldown.applied === false, "adaptive rack latency observes cooldown between increases");
assert(cooldown.appliedDirection === "none", "adaptive rack latency reports no-op cooldown samples");
assert(cooldown.cooldownBlocksRemaining === 1, "adaptive rack latency counts cooldown in recorded blocks");
assert(rack.refreshes.length === 1, "adaptive rack latency does not refresh while cooling down");

const secondRaise = await controller.record({
  ...rack.health,
  lastProcessDurationMs: 0.6,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 4,
  lastResponseDeadlineLeadBlocks: -1
});
assert(secondRaise.applied === true, "adaptive rack latency can apply again after cooldown");
assert(secondRaise.appliedDirection === "increase", "adaptive rack latency reports repeated upward changes");
assert(secondRaise.targetTransportLatencySamples === 768, "adaptive rack latency advances by one bounded step after cooldown");
assert(rack.refreshes.length === 2 && rack.refreshes[1] === 768, "adaptive rack latency refreshes with the next bounded target");

controller.reset();
const afterReset = await controller.record({
  ...rack.health,
  lastProcessDurationMs: 0.6,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 4,
  lastResponseDeadlineLeadBlocks: -1
});
assert(afterReset.applied === false, "adaptive rack latency reset clears sample and cooldown state");

controller.reset();
const stableOne = await controller.record({
  ...rack.health,
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1
});
assert(stableOne.applied === false, "adaptive rack latency waits for a stable recovery window");
assert(stableOne.recoveryBlocksRemaining === 2, "adaptive rack latency reports recovery wait before enough samples");

const stableTwo = await controller.record({
  ...rack.health,
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1
});
assert(stableTwo.applied === false, "adaptive rack latency waits for enough stable recovery blocks");
assert(stableTwo.stableBlocks === 1, "adaptive rack latency counts stable blocks after the minimum window");
assert(stableTwo.recoveryBlocksRemaining === 1, "adaptive rack latency reports remaining stable recovery blocks");

const firstRecovery = await controller.record({
  ...rack.health,
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1
});
assert(firstRecovery.applied === true, "adaptive rack latency recovers downward after stable health");
assert(firstRecovery.appliedDirection === "decrease", "adaptive rack latency reports downward recovery changes");
assert(firstRecovery.targetTransportLatencySamples === 640, "adaptive rack latency recovers in bounded one-block steps");
assert(rack.refreshes.length === 3 && rack.refreshes[2] === 640, "adaptive rack latency refreshes with the bounded recovery target");

controller.reset();
rack.health = { ...rack.health, transportLatencySamples: 256 };
await controller.record({
  ...rack.health,
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1
});
await controller.record({
  ...rack.health,
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1
});
const floorRecovery = await controller.record({
  ...rack.health,
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1
});
assert(floorRecovery.applied === false, "adaptive rack latency does not recover below the configured latency floor");

const chainScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 384
});
const chainController = createLiveEffectRackChainSchedulerAdaptiveLatencyController({
  scheduler: chainScheduler,
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 256,
  processBudgetMs: 8,
  processTimeoutMs: 12,
  minSamples: 2,
  cooldownBlocks: 1,
  maxLatencyIncreaseBlocks: 2,
  latencyRecoveryBlocks: 2,
  maxLatencyDecreaseBlocks: 1,
  minTransportLatencyBlocks: 2,
  safetyMarginBlocks: 1
});

const chainReady = chainController.record({
  latencySamples: 128,
  lastProcessDurationMs: 0.5,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1,
  responseDeadlineMisses: 0
});
assert(chainReady.applied === false, "adaptive chain scheduler latency waits for enough chain samples");
assert(chainReady.currentTransportLatencySamples === 384, "adaptive chain scheduler latency reads the scheduler latency");
assert(chainReady.targetTransportLatencySamples === 384, "adaptive chain scheduler latency keeps stable chain latency unchanged");

const chainRaise = chainController.record({
  latencySamples: 128,
  lastProcessDurationMs: 0.6,
  responseJitterBlocks: 4,
  lastResponseDeadlineLeadBlocks: -1,
  responseDeadlineMisses: 1
});
assert(chainRaise.applied === true, "adaptive chain scheduler latency applies pressure recommendations");
assert(chainRaise.appliedDirection === "increase", "adaptive chain scheduler latency reports upward changes");
assert(chainRaise.chainLatencySamples === 128, "adaptive chain scheduler latency reports aggregate chain latency");
assert(chainRaise.targetTransportLatencySamples === 640, "adaptive chain scheduler latency caps one increase to the configured step");
assert(chainScheduler.snapshot().transportLatencySamples === 640, "adaptive chain scheduler latency updates the scheduler");
assert(
  chainScheduler.snapshot().deadlinePressure.reasons.includes("increase-transport-latency"),
  "adaptive chain scheduler latency keeps scheduler pressure observable after an increase"
);

const chainCooldown = chainController.record({
  latencySamples: 128,
  lastProcessDurationMs: 0.6,
  responseJitterBlocks: 4,
  lastResponseDeadlineLeadBlocks: -1,
  responseDeadlineMisses: 1
});
assert(chainCooldown.applied === false, "adaptive chain scheduler latency observes sample windows after applying");

chainController.reset();
chainController.record({
  latencySamples: 128,
  lastProcessDurationMs: 0.5,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1,
  responseDeadlineMisses: 1
});
const chainStable = chainController.record({
  latencySamples: 128,
  lastProcessDurationMs: 0.5,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1,
  responseDeadlineMisses: 1
});
assert(chainStable.applied === false && chainStable.stableBlocks === 1, "adaptive chain scheduler latency counts stable recovery blocks");
const chainRecovery = chainController.record({
  latencySamples: 128,
  lastProcessDurationMs: 0.5,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1,
  responseDeadlineMisses: 1
});
assert(chainRecovery.applied === true, "adaptive chain scheduler latency recovers downward after stable chain health");
assert(chainRecovery.appliedDirection === "decrease", "adaptive chain scheduler latency reports downward scheduler changes");
assert(chainRecovery.targetTransportLatencySamples === 512, "adaptive chain scheduler latency recovers in bounded one-block steps");
assert(chainScheduler.snapshot().transportLatencySamples === 512, "adaptive chain scheduler latency applies the recovery target");

console.log("Live effect rack adaptive latency smoke checks passed.");
