import {
  createLiveEffectRackAdaptiveLatencyController,
  createLiveEffectRackBlockScheduler,
  createLiveEffectRackSchedulerAdaptiveLatencyController,
  createLiveEffectRackChainSchedulerAdaptiveLatencyController,
  createLiveEffectRackFrameBatchSchedulerAdaptiveLatencyController
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

const dryPressureRack = new FakeRack();
dryPressureRack.health = { ...dryPressureRack.health, transportLatencySamples: 0 };
const dryPressureController = createLiveEffectRackAdaptiveLatencyController({
  rack: dryPressureRack,
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 0,
  processBudgetMs: 8,
  processTimeoutMs: 12,
  minSamples: 2,
  cooldownBlocks: 0,
  maxLatencyIncreaseBlocks: 1,
  safetyMarginBlocks: 0
});
await dryPressureController.record({
  ...dryPressureRack.health,
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0,
  lastResponseDeadlineLeadBlocks: 1,
  dryOutputBlocks: 0
});
const dryPressureRaise = await dryPressureController.record({
  ...dryPressureRack.health,
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0,
  lastResponseDeadlineLeadBlocks: 1,
  dryOutputBlocks: 1
});
assert(dryPressureRaise.applied === true, "adaptive rack latency reacts to dry-output pressure before deadline samples");
assert(dryPressureRaise.appliedDirection === "increase", "adaptive rack latency treats dry-output pressure as upward pressure");
assert(dryPressureRaise.targetTransportLatencySamples === 128, "adaptive rack latency adds one dry-pressure safety block");
assert(dryPressureRack.refreshes.length === 1 && dryPressureRack.refreshes[0] === 128, "adaptive rack latency refreshes the rack after dry-output pressure");

const rackScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 256
});
const rackSchedulerController = createLiveEffectRackSchedulerAdaptiveLatencyController({
  scheduler: rackScheduler,
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

const schedulerReady = rackSchedulerController.record({
  pluginLatencySamples: 64,
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1,
  responseDeadlineMisses: 0
});
assert(schedulerReady.applied === false, "adaptive rack scheduler latency waits for enough rack samples");
assert(schedulerReady.currentTransportLatencySamples === 256, "adaptive rack scheduler latency reads scheduler latency");
assert(schedulerReady.targetTransportLatencySamples === 256, "adaptive rack scheduler latency keeps stable latency unchanged");

const schedulerRaise = rackSchedulerController.record({
  pluginLatencySamples: 64,
  lastProcessDurationMs: 0.6,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 4,
  lastResponseDeadlineLeadBlocks: -1,
  responseDeadlineMisses: 1
});
assert(schedulerRaise.applied === true, "adaptive rack scheduler latency applies pressure recommendations");
assert(schedulerRaise.appliedDirection === "increase", "adaptive rack scheduler latency reports upward changes");
assert(schedulerRaise.targetTransportLatencySamples === 512, "adaptive rack scheduler latency caps one increase to the configured step");
assert(rackScheduler.snapshot().transportLatencySamples === 512, "adaptive rack scheduler latency updates the scheduler");
assert(
  rackScheduler.snapshot().deadlinePressure.reasons.includes("increase-transport-latency"),
  "adaptive rack scheduler latency keeps scheduler pressure observable after an increase"
);
assert(
  schedulerRaise.deadlinePressure?.reasons.includes("increase-transport-latency"),
  "adaptive rack scheduler latency snapshots include scheduler pressure reasons"
);

const schedulerCooldown = rackSchedulerController.record({
  pluginLatencySamples: 64,
  lastProcessDurationMs: 0.6,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 4,
  lastResponseDeadlineLeadBlocks: -1,
  responseDeadlineMisses: 1
});
assert(schedulerCooldown.applied === false, "adaptive rack scheduler latency observes cooldown between increases");

rackSchedulerController.reset();
rackSchedulerController.record({
  pluginLatencySamples: 64,
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1,
  responseDeadlineMisses: 1
});
const schedulerStable = rackSchedulerController.record({
  pluginLatencySamples: 64,
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1,
  responseDeadlineMisses: 1
});
assert(
  schedulerStable.applied === false && schedulerStable.stableBlocks === 1,
  "adaptive rack scheduler latency counts stable recovery blocks"
);
const schedulerRecovery = rackSchedulerController.record({
  pluginLatencySamples: 64,
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1,
  responseDeadlineMisses: 1
});
assert(schedulerRecovery.applied === true, "adaptive rack scheduler latency recovers downward after stable rack health");
assert(schedulerRecovery.appliedDirection === "decrease", "adaptive rack scheduler latency reports downward scheduler changes");
assert(schedulerRecovery.targetTransportLatencySamples === 384, "adaptive rack scheduler latency recovers in bounded one-block steps");
assert(rackScheduler.snapshot().transportLatencySamples === 384, "adaptive rack scheduler latency applies the recovery target");
assert(schedulerRecovery.deadlinePressure?.pressure === false, "adaptive rack scheduler latency snapshots show recovered pressure");

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
assert(
  chainRaise.deadlinePressure?.reasons.includes("increase-transport-latency"),
  "adaptive chain scheduler latency snapshots include scheduler pressure reasons"
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
  responseDeadlineMisses: 1,
  dryOutputBlocks: 1,
  bypassDryOutputBlocks: 1
});
const chainStable = chainController.record({
  latencySamples: 128,
  lastProcessDurationMs: 0.5,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1,
  responseDeadlineMisses: 1,
  dryOutputBlocks: 2,
  bypassDryOutputBlocks: 2
});
assert(chainStable.applied === false && chainStable.stableBlocks === 1, "adaptive chain scheduler latency counts bypass-only chain dry output as stable recovery blocks");
const chainRecovery = chainController.record({
  latencySamples: 128,
  lastProcessDurationMs: 0.5,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1,
  responseDeadlineMisses: 1,
  dryOutputBlocks: 3,
  bypassDryOutputBlocks: 3
});
assert(chainRecovery.applied === true, "adaptive chain scheduler latency recovers downward after stable chain health");
assert(chainRecovery.appliedDirection === "decrease", "adaptive chain scheduler latency reports downward scheduler changes");
assert(chainRecovery.targetTransportLatencySamples === 512, "adaptive chain scheduler latency recovers in bounded one-block steps");
assert(chainScheduler.snapshot().transportLatencySamples === 512, "adaptive chain scheduler latency applies the recovery target");
assert(chainRecovery.deadlinePressure?.pressure === false, "adaptive chain scheduler latency snapshots show recovered pressure");

const chainTimeoutScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 0
});
const chainTimeoutController = createLiveEffectRackChainSchedulerAdaptiveLatencyController({
  scheduler: chainTimeoutScheduler,
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 0,
  processBudgetMs: 4,
  processTimeoutMs: 12,
  minSamples: 1,
  cooldownBlocks: 0,
  safetyMarginBlocks: 0
});
chainTimeoutController.record({
  latencySamples: 0,
  lastProcessDurationMs: 1,
  processTimedOut: false
});
const chainTimeoutPressure = chainTimeoutController.record({
  latencySamples: 0,
  lastProcessDurationMs: 1,
  processTimedOut: true
});
assert(
  chainTimeoutPressure.deadlinePressure?.reasons.includes("process-timeout") &&
    chainTimeoutPressure.deadlinePressure?.reasons.includes("increase-process-timeout"),
  "adaptive chain scheduler latency surfaces timeout calibration pressure"
);

const batchScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 128
});
const batchController = createLiveEffectRackFrameBatchSchedulerAdaptiveLatencyController({
  scheduler: batchScheduler,
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 0,
  processBudgetMs: 8,
  processTimeoutMs: 12,
  minSamples: 2,
  cooldownBlocks: 1,
  maxLatencyIncreaseBlocks: 2,
  latencyRecoveryBlocks: 2,
  maxLatencyDecreaseBlocks: 1,
  minTransportLatencyBlocks: 0,
  safetyMarginBlocks: 0
});

const batchReady = batchController.record({
  totalDurationMs: 1,
  maxDurationMs: 0.5,
  responseJitterBlocks: 0,
  lastResponseDeadlineLeadBlocks: 1,
  responseDeadlineMisses: 0,
  latencySamples: 128,
  dryTargets: 0,
  skippedTargets: 0,
  failedTargets: 0
});
assert(batchReady.applied === false, "adaptive frame batch scheduler latency waits for enough batch samples");
assert(batchReady.batchLatencySamples === 128, "adaptive frame batch scheduler latency reports aggregate batch latency");
assert(batchReady.currentTransportLatencySamples === 128, "adaptive frame batch scheduler latency reads the scheduler latency");
assert(batchReady.targetTransportLatencySamples === 128, "adaptive frame batch scheduler latency keeps stable batch latency unchanged");

const batchRaise = batchController.record({
  totalDurationMs: 1,
  maxDurationMs: 0.5,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: -0.5,
  responseDeadlineMisses: 1,
  latencySamples: 128,
  dryTargets: 1,
  skippedTargets: 1,
  failedTargets: 0,
  processBudgetTripped: true
});
assert(batchRaise.applied === true, "adaptive frame batch scheduler latency applies dry-pressure recommendations");
assert(batchRaise.appliedDirection === "increase", "adaptive frame batch scheduler latency reports upward changes");
assert(batchRaise.targetTransportLatencySamples === 384, "adaptive frame batch scheduler latency adds aggregate deadline headroom");
assert(batchScheduler.snapshot().transportLatencySamples === 384, "adaptive frame batch scheduler latency updates the scheduler");
assert(
  batchScheduler.snapshot().deadlinePressure.reasons.includes("dry-output-pressure"),
  "adaptive frame batch scheduler latency keeps batch dry pressure observable"
);
assert(
  batchRaise.deadlinePressure?.reasons.includes("deadline-miss") &&
    batchRaise.deadlinePressure?.reasons.includes("low-deadline-lead") &&
    batchRaise.deadlinePressure?.reasons.includes("increase-transport-latency"),
  "adaptive frame batch scheduler latency snapshots include aggregate deadline pressure reasons"
);

const batchTimeoutScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 0
});
const batchTimeoutController = createLiveEffectRackFrameBatchSchedulerAdaptiveLatencyController({
  scheduler: batchTimeoutScheduler,
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 0,
  processBudgetMs: 4,
  processTimeoutMs: 12,
  minSamples: 1,
  cooldownBlocks: 0,
  safetyMarginBlocks: 0
});
batchTimeoutController.record({ totalDurationMs: 1, maxDurationMs: 0.5, latencySamples: 0, processTimedOut: false });
const batchTimeoutPressure = batchTimeoutController.record({
  totalDurationMs: 1,
  maxDurationMs: 0.5,
  latencySamples: 0,
  processTimedOut: true,
  dryTargets: 1,
  skippedTargets: 1,
  failedTargets: 0
});
assert(
  batchTimeoutPressure.deadlinePressure?.reasons.includes("process-timeout") &&
    batchTimeoutPressure.deadlinePressure?.reasons.includes("increase-process-timeout"),
  "adaptive frame batch scheduler latency surfaces timeout calibration pressure"
);

const batchCooldown = batchController.record({
  totalDurationMs: 1,
  maxDurationMs: 0.5,
  responseJitterBlocks: 0,
  lastResponseDeadlineLeadBlocks: 1,
  responseDeadlineMisses: 0,
  latencySamples: 128,
  dryTargets: 1,
  skippedTargets: 0,
  failedTargets: 0
});
assert(batchCooldown.applied === false, "adaptive frame batch scheduler latency observes cooldown between increases");

batchController.reset();
batchController.record({
  totalDurationMs: 1,
  maxDurationMs: 0.5,
  responseJitterBlocks: 0,
  lastResponseDeadlineLeadBlocks: 1,
  responseDeadlineMisses: 0,
  latencySamples: 128,
  dryTargets: 1,
  bypassedTargets: 1,
  skippedTargets: 0,
  failedTargets: 0
});
const batchStable = batchController.record({
  totalDurationMs: 1,
  maxDurationMs: 0.5,
  responseJitterBlocks: 0,
  lastResponseDeadlineLeadBlocks: 1,
  responseDeadlineMisses: 0,
  latencySamples: 128,
  dryTargets: 1,
  bypassedTargets: 1,
  skippedTargets: 0,
  failedTargets: 0
});
assert(batchStable.applied === false && batchStable.stableBlocks === 1, "adaptive frame batch scheduler latency counts bypass-only batches as stable recovery blocks");
const batchRecovery = batchController.record({
  totalDurationMs: 1,
  maxDurationMs: 0.5,
  responseJitterBlocks: 0,
  lastResponseDeadlineLeadBlocks: 1,
  responseDeadlineMisses: 0,
  latencySamples: 128,
  dryTargets: 1,
  bypassedTargets: 1,
  skippedTargets: 0,
  failedTargets: 0
});
assert(batchRecovery.applied === true, "adaptive frame batch scheduler latency recovers downward after stable batch health");
assert(batchRecovery.appliedDirection === "decrease", "adaptive frame batch scheduler latency reports downward scheduler changes");
assert(batchRecovery.targetTransportLatencySamples === 256, "adaptive frame batch scheduler latency recovers in bounded one-block steps");
assert(batchScheduler.snapshot().transportLatencySamples === 256, "adaptive frame batch scheduler latency applies the recovery target");
assert(batchRecovery.deadlinePressure?.pressure === false, "adaptive frame batch scheduler latency snapshots show recovered pressure");

console.log("Live effect rack adaptive latency smoke checks passed.");
