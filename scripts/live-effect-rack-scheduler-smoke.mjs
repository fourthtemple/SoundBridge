import {
  createLiveEffectRackBlockScheduler,
  createLiveEffectRackCalibrationWindow,
  createLiveEffectRackChain,
  createLiveEffectRackChainCalibrationWindow,
  createLiveEffectRackFrameBatchProcessor,
  createLivePerformanceFrameBatchProcessor,
  createLivePerformanceFrameBatchProcessorOptions
} from "../packages/web-client/dist/soundbridge-client.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function near(left, right, epsilon = 0.000001) {
  return Math.abs(left - right) <= epsilon;
}

let now = 1000;
const scheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  startBlockId: 10,
  startSamplePosition: 1280,
  transportLatencySamples: 256,
  maxInputAgeMs: 6,
  transport: {
    tempo: 128,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4
  },
  nowMs: () => now
});

const first = scheduler.schedule([[1, 0]]);
assert(first.request.blockId === 10, "live rack scheduler starts from the configured block id");
assert(first.samplePosition === 1280, "live rack scheduler starts from the configured sample position");
assert(first.request.timestamp === 1000 && first.captureAgeMs === 0, "live rack scheduler stamps fresh captures");
assert(first.transport.samplePosition === 1536, "live rack scheduler compensates transport latency");
assert(first.transport.tempo === 128, "live rack scheduler carries base transport metadata");
assert(first.stale === false, "live rack scheduler marks fresh captures as live");

now = 1002;
const second = scheduler.schedule([[0.5]], {
  wetMix: 0.25,
  transportOptions: { playing: false, tempo: 96 }
});
assert(second.request.blockId === 11, "live rack scheduler advances block ids");
assert(second.samplePosition === 1408, "live rack scheduler advances sample positions");
assert(second.request.wetMix === 0.25, "live rack scheduler preserves per-block wet mix");
assert(second.transport.playing === false && second.transport.tempo === 96, "live rack scheduler applies per-block transport overrides");
assert(second.transport.samplePosition === 1664, "live rack scheduler keeps latency compensation after advancing");

scheduler.updateFromRackHealth({
  transportLatencySamples: 512,
  lastResponseDeadlineLeadBlocks: 0.5,
  responseJitterBlocks: 5,
  responseDeadlineMisses: 2
});
now = 1010;
const stale = scheduler.schedule([[0.25]], { timestamp: 1000 });
assert(stale.stale === true && stale.captureAgeMs === 10, "live rack scheduler detects stale captured audio");
assert(stale.transport.samplePosition === 2048, "live rack scheduler uses updated rack transport latency");
assert(
  stale.deadlinePressure.pressure &&
    stale.deadlinePressure.reasons.includes("deadline-miss") &&
    stale.deadlinePressure.reasons.includes("low-deadline-lead") &&
    stale.deadlinePressure.reasons.includes("response-jitter"),
  "live rack scheduler carries deadline pressure into scheduled blocks"
);
scheduler.updateFromRackHealth({
  transportLatencySamples: 512,
  lastResponseDeadlineLeadBlocks: 2,
  responseJitterBlocks: 1,
  responseDeadlineMisses: 2
});
assert(scheduler.snapshot().deadlinePressure.pressure === false, "live rack scheduler clears pressure after stable rack health");

const rackWindow = createLiveEffectRackCalibrationWindow({
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 0,
  processBudgetMs: 12,
  processTimeoutMs: 16,
  safetyMarginBlocks: 0
});
rackWindow.record({
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0,
  lastResponseDeadlineLeadBlocks: 1,
  dryOutputBlocks: 0
});
const rackCalibration = rackWindow.record({
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0,
  lastResponseDeadlineLeadBlocks: 1,
  dryOutputBlocks: 1
}).calibration;
const rackCalibrationScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 0,
  nowMs: () => now
});
rackCalibrationScheduler.updateFromRackCalibration({
  lastResponseDeadlineLeadBlocks: 1,
  responseJitterBlocks: 0,
  responseDeadlineMisses: 0
}, rackCalibration);
const calibratedRack = rackCalibrationScheduler.schedule([[0.1]], { samplePosition: 0, timestamp: now });
assert(
  calibratedRack.transport.samplePosition === 128 &&
    rackCalibrationScheduler.snapshot().deadlinePressure.reasons.includes("dry-output-pressure") &&
    rackCalibrationScheduler.snapshot().deadlinePressure.reasons.includes("increase-transport-latency"),
  "live rack scheduler applies calibrated single-rack latency and pressure recommendations"
);

const chain = createLiveEffectRackChain({
  stages: [{
    async processBlock(request) {
      return {
        blockId: request.blockId,
        channels: request.channels,
        latencySamples: 640,
        renderEngine: "latency-stage",
        bypassed: false,
        healthy: true
      };
    }
  }],
  sampleRate: 48000,
  maxBlockSize: 128
});
await chain.processBlock({ blockId: 99, channels: [[0.1]], sampleRate: 48000 });
scheduler.updateFromChainHealth(chain.health);
now = 1011;
const chainCompensated = scheduler.schedule([[0.2]], { timestamp: now });
assert(chainCompensated.transport.samplePosition === 2304, "live rack scheduler can compensate from chain aggregate latency");

const chainWindow = createLiveEffectRackChainCalibrationWindow({
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 128,
  processBudgetMs: 12,
  processTimeoutMs: 16,
  safetyMarginBlocks: 1
});
const chainCalibration = chainWindow.record(chain.health).calibration;
scheduler.updateFromChainCalibration(chain.health, chainCalibration);
now = 1012;
const calibratedChain = scheduler.schedule([[0.3]], { timestamp: now });
assert(calibratedChain.transport.samplePosition === 2560, "live rack scheduler applies calibrated chain latency compensation");

const pressureScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 0,
  nowMs: () => now
});
pressureScheduler.updateFromChainCalibration(
  {
    latencySamples: 0,
    lastResponseDeadlineLeadBlocks: 0.25,
    responseJitterBlocks: 3,
    responseDeadlineMisses: 1
  },
  {
    recommendedTransportLatencySamples: 512,
    warnings: ["deadline-miss", "dry-output-pressure", "response-jitter", "increase-transport-latency"]
  }
);
const pressuredSnapshot = pressureScheduler.snapshot();
assert(
  pressuredSnapshot.transportLatencyBlocks === 4 &&
    pressuredSnapshot.deadlinePressure.reasons.includes("dry-output-pressure") &&
    pressuredSnapshot.deadlinePressure.reasons.includes("increase-transport-latency"),
  "live rack scheduler exposes calibrated dry-output and latency pressure recommendations"
);
pressureScheduler.updateFromChainHealth({
  latencySamples: 512,
  lastResponseDeadlineLeadBlocks: 2,
  responseJitterBlocks: 1,
  responseDeadlineMisses: 1
});
assert(
  pressureScheduler.snapshot().deadlinePressure.pressure === false,
  "live rack scheduler resolves chain pressure when added latency covers jitter and lead"
);

const overrideScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 0,
  nowMs: () => now
});
overrideScheduler.updateFromRackHealth({
  transportLatencySamples: 0,
  lastResponseDeadlineLeadBlocks: 2,
  responseJitterBlocks: 3,
  responseDeadlineMisses: 0
});
const overrideLatencyBlock = overrideScheduler.schedule([[0.1]], { transportLatencySamples: 512 });
assert(
  overrideScheduler.snapshot().deadlinePressure.pressure === true &&
    overrideLatencyBlock.deadlinePressure.pressure === false &&
    overrideLatencyBlock.deadlinePressure.transportLatencyBlocks === 4,
  "live rack scheduler evaluates per-block pressure against per-block transport latency"
);

const explicitTransport = { playing: false, samplePosition: 7 };
const explicit = scheduler.schedule([[0.1]], { transport: explicitTransport, timestamp: now });
assert(explicit.transport === explicitTransport, "live rack scheduler preserves explicit host transport");
assert(explicit.request.transport === explicitTransport, "live rack scheduler passes explicit transport into the request");

scheduler.reset({ nextBlockId: 4, nextSamplePosition: 512 });
const reset = scheduler.schedule([[0.2]]);
assert(reset.blockId === 4 && reset.samplePosition === 512, "live rack scheduler reset sets the next block position");
assert(scheduler.snapshot().nextBlockId === 5, "live rack scheduler snapshot reports the next block id");
assert(scheduler.snapshot().transportLatencySamples === 768, "live rack scheduler snapshot reports current latency compensation");

now = 2000;
const frameScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  startBlockId: 100,
  startSamplePosition: 12800,
  transportLatencySamples: 256,
  maxInputAgeMs: 4,
  transport: { playing: true, tempo: 126 },
  nowMs: () => now
});
const frame = frameScheduler.captureFrame();
const deckA = frameScheduler.scheduleFromFrame(frame, [[1, 0]], { wetMix: 0.5 });
now = 2010;
const deckB = frameScheduler.scheduleFromFrame(frame, [[0, 1]], {
  inputBuses: [{ index: 1, channels: [[0.25, 0.25]] }]
});
assert(
  deckA.blockId === 100 &&
    deckB.blockId === 100 &&
    deckA.samplePosition === 12800 &&
    deckB.samplePosition === 12800,
  "live rack scheduler can reuse one frame across multiple live targets"
);
assert(
  deckA.timestamp === 2000 &&
    deckB.timestamp === 2000 &&
    deckA.captureAgeMs === 0 &&
    deckB.captureAgeMs === 0 &&
    deckB.stale === false,
  "live rack scheduler preserves shared frame freshness for multi-target processing"
);
assert(
  deckA.transport === deckB.transport &&
    deckA.transport.samplePosition === 13056 &&
    deckA.transport.tempo === 126,
  "live rack scheduler shares one latency-compensated transport across a frame"
);
assert(deckA.request.wetMix === 0.5, "live rack scheduler keeps per-target wet mix when reusing a frame");
assert(deckB.request.inputBuses?.[0]?.index === 1, "live rack scheduler keeps per-target input buses when reusing a frame");
assert(frameScheduler.snapshot().nextBlockId === 101, "live rack scheduler advances only once for a reusable frame");
const nextFrameBlock = frameScheduler.schedule([[0.3]]);
assert(nextFrameBlock.blockId === 101, "live rack scheduler resumes after the captured multi-target frame");

now = 3000;
const batchScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  startBlockId: 200,
  startSamplePosition: 25600,
  transportLatencySamples: 384,
  transport: { playing: true, tempo: 124 },
  nowMs: () => now
});
const liveBatchOptions = createLivePerformanceFrameBatchProcessorOptions({
  scheduler: batchScheduler,
  sampleRate: 48000,
  maxBlockSize: 128,
  processBudgetBlocks: 2,
  processTimeoutBlocks: 3
});
assert(
  near(liveBatchOptions.processBudgetMs, (128 / 48000) * 1000 * 2) &&
    near(liveBatchOptions.processTimeoutMs, (128 / 48000) * 1000 * 3) &&
    liveBatchOptions.maxConsecutiveProcessBudgetMisses === 3 &&
    liveBatchOptions.processBudgetRecoveryBlocks === 16 &&
    liveBatchOptions.processTimeoutRecoveryBlocks === 16,
  "live frame batch preset converts block policies into bounded processor options"
);
const liveBatchProcessor = createLivePerformanceFrameBatchProcessor({
  scheduler: batchScheduler,
  sampleRate: 48000,
  maxBlockSize: 128,
  processBudgetBlocks: 2,
  processTimeoutBlocks: 3
});
assert(
  liveBatchProcessor.processBudgetMs === liveBatchOptions.processBudgetMs &&
    liveBatchProcessor.processTimeoutMs === liveBatchOptions.processTimeoutMs,
  "live frame batch preset creates a processor with live budget and timeout defaults"
);
const processedTargets = [];
const deckTarget = {
  health: { healthy: true, reportedLatencySamples: 640 },
  async processScheduledBlock(scheduled, options) {
    processedTargets.push({ id: "deck", scheduled, options });
    return {
      blockId: scheduled.blockId,
      channels: scheduled.request.channels,
      latencySamples: 64,
      renderEngine: "deck-effect",
      bypassed: false,
      healthy: true
    };
  }
};
const sendTarget = {
  health: { healthy: true, reportedLatencySamples: 128 },
  async processScheduledBlock(scheduled, options) {
    processedTargets.push({ id: "send", scheduled, options });
    return {
      blockId: scheduled.blockId,
      channels: scheduled.request.channels,
      latencySamples: 0,
      renderEngine: "dry-bypass",
      bypassed: true,
      healthy: true
    };
  }
};
const batchProcessor = createLiveEffectRackFrameBatchProcessor({
  scheduler: batchScheduler,
  maxTargets: 4,
  nowMs: () => now
});
const batch = await batchProcessor.process([
  { id: "deck-a", target: deckTarget, channels: [[1, 0]], processOptions: { role: "deck" } },
  { id: "send-a", target: sendTarget, channels: [[0, 1]], scheduleOptions: { wetMix: 0.25 } }
]);
assert(batch.frame.blockId === 200 && batchScheduler.snapshot().nextBlockId === 201, "live frame batch captures one shared scheduler frame");
assert(batch.targetCount === 2 && batch.processedTargets === 2 && batch.failedTargets === 0, "live frame batch processes every target");
assert(batch.dryTargets === 1 && batch.bypassedTargets === 1 && batch.healthy === true, "live frame batch aggregates dry and health status");
assert(batch.reportedLatencySamples === 640 && batch.latencySamples === 64, "live frame batch exposes max target latency");
assert(
  processedTargets[0].scheduled.blockId === processedTargets[1].scheduled.blockId &&
    processedTargets[0].scheduled.samplePosition === processedTargets[1].scheduled.samplePosition &&
    processedTargets[0].scheduled.transport === processedTargets[1].scheduled.transport,
  "live frame batch reuses one transport frame across targets"
);
assert(processedTargets[0].options.role === "deck", "live frame batch passes per-target process options");
assert(batch.results[1].scheduled.request.wetMix === 0.25, "live frame batch passes per-target schedule options");

let staleBatchTargetCalls = 0;
let staleBatchEvents = 0;
const staleBatchScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  maxInputAgeMs: 2,
  nowMs: () => now
});
const staleBatchProcessor = createLiveEffectRackFrameBatchProcessor({
  scheduler: staleBatchScheduler,
  nowMs: () => now
});
staleBatchProcessor.addEventListener("frame-batch-stale-input", (event) => {
  staleBatchEvents += 1;
  assert(event.detail.result.frame.stale === true, "live frame batch stale events include the stale shared frame");
});
const staleBatch = await staleBatchProcessor.process(
  [{
    id: "stale-deck",
    target: { health: { healthy: true, reportedLatencySamples: 320 }, async processScheduledBlock() { staleBatchTargetCalls += 1; } },
    channels: [[0.25, 0.75]]
  }],
  { frameOptions: { timestamp: now - 10 } }
);
assert(
  staleBatch.processedTargets === 0 &&
    staleBatch.skippedTargets === 1 &&
    staleBatch.failedTargets === 0 &&
    staleBatch.dryTargets === 1 &&
    staleBatch.bypassedTargets === 0 &&
    staleBatch.healthy === true &&
    staleBatch.reportedLatencySamples === 320 &&
    staleBatch.results[0].response.renderEngine === "frame-batch-stale-input" &&
    staleBatchTargetCalls === 0 &&
    staleBatchEvents === 1,
  "live frame batch fails dry before processing stale shared-frame targets"
);

const batchLatencyScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  startBlockId: 250,
  startSamplePosition: 32000,
  nowMs: () => now
});
assert(batchLatencyScheduler.updateFromFrameBatchHealth({ reportedLatencySamples: 96 }) === 96, "live scheduler accepts frame-batch reported latency");
const batchLatencyBlock = batchLatencyScheduler.schedule([[1]]);
assert(batchLatencyBlock.transport.samplePosition === 32096, "live scheduler compensates transport from frame-batch health");
assert(
  batchLatencyScheduler.updateFromFrameBatchCalibration(batch, {
    recommendedTransportLatencySamples: 128,
    warnings: ["increase-transport-latency"]
  }) === 192,
  "live scheduler combines frame-batch latency and calibrated headroom"
);
const calibratedBatchBlock = batchLatencyScheduler.schedule([[1]]);
assert(
  calibratedBatchBlock.transport.samplePosition === 32320 &&
    calibratedBatchBlock.deadlinePressure.reasons.includes("increase-transport-latency"),
  "live scheduler applies frame-batch calibration to shared-frame pressure"
);

now = 3500;
let telemetryDurationMs = 10;
let telemetryTargetCalls = 0;
const telemetryScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 1000,
  maxBlockSize: 10,
  startBlockId: 275,
  startSamplePosition: 2750,
  nowMs: () => now
});
const telemetryTarget = {
  async processScheduledBlock(scheduled) {
    telemetryTargetCalls += 1;
    now += telemetryDurationMs;
    return {
      blockId: scheduled.blockId,
      channels: scheduled.request.channels,
      latencySamples: 0,
      renderEngine: "deadline-telemetry",
      bypassed: false,
      healthy: true
    };
  }
};
const telemetryProcessor = createLiveEffectRackFrameBatchProcessor({
  scheduler: telemetryScheduler,
  processBudgetMs: 20,
  nowMs: () => now
});
const leadBatch = await telemetryProcessor.process([{ target: telemetryTarget, channels: [Array(10).fill(1)] }]);
telemetryDurationMs = 30;
const missedBatch = await telemetryProcessor.process([{ target: telemetryTarget, channels: [Array(10).fill(1)] }]);
telemetryScheduler.updateFromFrameBatchHealth(telemetryProcessor.health);
assert(
  leadBatch.lastResponseDeadlineLeadBlocks === 1 &&
    missedBatch.lastResponseDeadlineLeadMs === -10 &&
    missedBatch.lastResponseDeadlineLeadBlocks === -1 &&
    missedBatch.responseJitterBlocks === 2 &&
    telemetryProcessor.health.responseDeadlineMisses === 1,
  "live frame batch exposes aggregate deadline lead and jitter telemetry"
);
assert(
  telemetryScheduler.snapshot().deadlinePressure.reasons.includes("deadline-miss") &&
    telemetryScheduler.snapshot().deadlinePressure.reasons.includes("low-deadline-lead"),
  "live scheduler consumes frame-batch deadline telemetry as pressure"
);
const filteredPressureBatch = await telemetryProcessor.process(
  [{ target: telemetryTarget, channels: [Array(10).fill(1)] }],
  { skipOnDeadlinePressure: true, skipOnDeadlinePressureReasons: ["dry-output-pressure"] }
);
assert(
  filteredPressureBatch.processedTargets === 1 && telemetryTargetCalls === 3,
  "live frame batch pressure reason filters keep unmatched pressure wet"
);
let batchDeadlinePressureEvents = 0;
telemetryProcessor.addEventListener("frame-batch-deadline-pressure", (event) => {
  batchDeadlinePressureEvents += 1;
  assert(event.detail.result.skippedTargets === 1, "live frame batch deadline-pressure events include skipped results");
});
const deadlineSkipTarget = {
  health: { healthy: true, reportedLatencySamples: 256 },
  async processScheduledBlock() {
    throw new Error("deadline pressure skip should not process targets");
  }
};
const deadlineSkippedBatch = await telemetryProcessor.process(
  [{ id: "pressure-deck", target: deadlineSkipTarget, channels: [Array(10).fill(0.5)] }],
  { skipOnDeadlinePressure: true, skipOnDeadlinePressureReasons: ["deadline-miss"] }
);
assert(
  deadlineSkippedBatch.processedTargets === 0 &&
    deadlineSkippedBatch.skippedTargets === 1 &&
    deadlineSkippedBatch.failedTargets === 0 &&
    deadlineSkippedBatch.dryTargets === 1 &&
    deadlineSkippedBatch.bypassedTargets === 0 &&
    deadlineSkippedBatch.healthy === true &&
    deadlineSkippedBatch.reportedLatencySamples === 256 &&
    deadlineSkippedBatch.results[0].response.renderEngine === "frame-batch-deadline-pressure" &&
    batchDeadlinePressureEvents === 1,
  "live frame batch can fail dry before starting deadline-pressured shared-frame targets"
);

const badBatch = await batchProcessor.process([
  { id: "bad-slot", target: {}, channels: [[0]] }
]);
assert(
  badBatch.targetCount === 1 &&
    badBatch.processedTargets === 0 &&
    badBatch.failedTargets === 1 &&
    badBatch.healthy === false,
  "live frame batch reports invalid targets without rejecting the whole frame"
);

now = 4000;
let budgetTargetCalls = 0;
let budgetDurationMs = 5;
const budgetScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  startBlockId: 300,
  startSamplePosition: 38400,
  nowMs: () => now
});
const budgetTarget = {
  health: { healthy: true, reportedLatencySamples: 64 },
  async processScheduledBlock(scheduled) {
    budgetTargetCalls += 1;
    now += budgetDurationMs;
    return {
      blockId: scheduled.blockId,
      channels: scheduled.request.channels,
      latencySamples: 32,
      renderEngine: "budget-target",
      bypassed: false,
      healthy: true
    };
  }
};
const budgetProcessor = createLiveEffectRackFrameBatchProcessor({
  scheduler: budgetScheduler,
  processBudgetMs: 2,
  maxConsecutiveProcessBudgetMisses: 1,
  nowMs: () => now
});
const budgetEvents = { exceeded: 0, tripped: 0, retry: 0, health: 0 };
budgetProcessor.addEventListener("frame-batch-process-budget-exceeded", (event) => {
  budgetEvents.exceeded += 1;
  assert(event.detail.health.processBudgetTripped === true, "live frame batch exceeded events include tripped health");
});
budgetProcessor.addEventListener("frame-batch-process-budget-tripped", (event) => {
  budgetEvents.tripped += 1;
  assert(event.detail.result.processBudgetTripped === true, "live frame batch trip events include the tripped result");
});
budgetProcessor.addEventListener("retry", (event) => {
  budgetEvents.retry += 1;
  assert(event.detail.health.processBudgetTripped === false, "live frame batch retry events include cleared health");
});
budgetProcessor.addEventListener("healthchange", () => {
  budgetEvents.health += 1;
});
const budgetTrip = await budgetProcessor.process([
  { id: "deck-budget", target: budgetTarget, channels: [[0.75, 0.25]] }
]);
assert(
  budgetTrip.processBudgetExceeded === true &&
    budgetTrip.processBudgetTripped === true &&
    budgetTrip.processBudgetMisses === 1,
  "live frame batch trips after repeated aggregate budget pressure"
);
assert(
  budgetTrip.processedTargets === 0 &&
    budgetTrip.skippedTargets === 1 &&
    budgetTrip.dryTargets === 1 &&
    budgetTrip.bypassedTargets === 0 &&
    budgetTrip.results[0].response.renderEngine === "frame-batch-process-budget-exceeded",
  "live frame batch returns dry skipped results when the aggregate budget trips"
);
assert(
  budgetEvents.exceeded === 1 &&
    budgetEvents.tripped === 1 &&
    budgetEvents.health >= 1 &&
    budgetProcessor.health.processBudgetTripped === true &&
    budgetProcessor.health.skippedTargets === 1,
  "live frame batch exposes aggregate budget pressure through events and health"
);
const budgetDry = await budgetProcessor.process([
  { id: "deck-budget", target: budgetTarget, channels: [[0.5, 0.5]] }
]);
assert(
  budgetTargetCalls === 1 &&
    budgetDry.processedTargets === 0 &&
    budgetDry.skippedTargets === 1 &&
    budgetDry.processBudgetTripped === true,
  "live frame batch stays dry while the aggregate budget trip is active"
);
assert(budgetProcessor.retry() === true, "live frame batch retry clears an aggregate budget trip");
assert(
  budgetEvents.retry === 1 &&
    budgetProcessor.health.processBudgetTripped === false &&
    budgetProcessor.health.targetCount === 0,
  "live frame batch health clears after manual retry"
);
budgetDurationMs = 0;
const budgetRecovered = await budgetProcessor.process([
  { id: "deck-budget", target: budgetTarget, channels: [[0.25, 0.75]] }
]);
assert(
  budgetTargetCalls === 2 &&
    budgetRecovered.processedTargets === 1 &&
    budgetRecovered.processBudgetTripped === false &&
    budgetRecovered.healthy === true,
  "live frame batch retry re-arms normal processing after budget pressure"
);

now = 5000;
let recoveryTargetCalls = 0;
let recoveryDurationMs = 5;
const recoveryScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  startBlockId: 400,
  startSamplePosition: 51200,
  maxInputAgeMs: 1,
  nowMs: () => now
});
const recoveryTarget = {
  health: { healthy: true },
  async processScheduledBlock(scheduled) {
    recoveryTargetCalls += 1;
    now += recoveryDurationMs;
    return {
      blockId: scheduled.blockId,
      channels: scheduled.request.channels,
      latencySamples: 0,
      renderEngine: "recovery-target",
      bypassed: false,
      healthy: true
    };
  }
};
const recoveryProcessor = createLiveEffectRackFrameBatchProcessor({
  scheduler: recoveryScheduler,
  processBudgetMs: 2,
  maxConsecutiveProcessBudgetMisses: 1,
  processBudgetRecoveryBlocks: 1,
  nowMs: () => now
});
let recoveredEvents = 0;
recoveryProcessor.addEventListener("frame-batch-process-budget-recovered", (event) => {
  recoveredEvents += 1;
  assert(event.detail.health.processBudgetTripped === false, "live frame batch recovered events include cleared health");
});
await recoveryProcessor.process([{ id: "recovering", target: recoveryTarget, channels: [[1]] }]);
const recoveryDry = await recoveryProcessor.process(
  [{ id: "recovering", target: recoveryTarget, channels: [[1]] }],
  { frameOptions: { timestamp: now - 10 } }
);
assert(
  recoveryTargetCalls === 1 &&
    recoveryDry.skippedTargets === 1 &&
    recoveryDry.results[0].response.renderEngine === "frame-batch-process-budget-exceeded" &&
    recoveredEvents === 1 &&
    recoveryProcessor.health.processBudgetTripped === false,
  "live frame batch can auto-recover after a bounded dry budget window even when the next shared frame is stale"
);

now = 6000;
let timeoutTargetCalls = 0;
const timeoutScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  startBlockId: 500,
  startSamplePosition: 64000,
  nowMs: () => now
});
const timeoutTarget = {
  health: { healthy: true },
  async processScheduledBlock() {
    timeoutTargetCalls += 1;
    return new Promise(() => undefined);
  }
};
const timeoutProcessor = createLiveEffectRackFrameBatchProcessor({
  scheduler: timeoutScheduler,
  processTimeoutMs: 1,
  processTimeoutRecoveryBlocks: 1,
  nowMs: () => now
});
const timeoutEvents = { timeout: 0, tripped: 0, recovered: 0 };
timeoutProcessor.addEventListener("frame-batch-process-timeout", (event) => {
  timeoutEvents.timeout += 1;
  assert(event.detail.health.processTimeoutTripped === true, "live frame batch timeout events include tripped timeout health");
});
timeoutProcessor.addEventListener("frame-batch-process-timeout-tripped", (event) => {
  timeoutEvents.tripped += 1;
  assert(event.detail.result.processTimedOut === true, "live frame batch timeout trip events include timeout result details");
});
timeoutProcessor.addEventListener("frame-batch-process-timeout-recovered", (event) => {
  timeoutEvents.recovered += 1;
  assert(event.detail.health.processTimeoutTripped === false, "live frame batch timeout recovery events include cleared health");
});
const timeoutTrip = await timeoutProcessor.process([
  { id: "timeout-deck", target: timeoutTarget, channels: [[1, 0]] }
]);
assert(
  timeoutTrip.processTimedOut === true &&
    timeoutTrip.processTimeoutTripped === true &&
    timeoutTrip.processTimeouts === 1 &&
    timeoutTrip.totalDurationMs === 1,
  "live frame batch trips on a bounded aggregate process timeout"
);
assert(
  timeoutTrip.processedTargets === 0 &&
    timeoutTrip.skippedTargets === 1 &&
    timeoutTrip.dryTargets === 1 &&
    timeoutTrip.bypassedTargets === 0 &&
    timeoutTrip.results[0].response.renderEngine === "frame-batch-process-timeout",
  "live frame batch returns dry skipped results when the aggregate timeout trips"
);
assert(
  timeoutEvents.timeout === 1 &&
    timeoutEvents.tripped === 1 &&
    timeoutProcessor.health.processTimeoutTripped === true &&
    timeoutProcessor.health.skippedTargets === 1,
  "live frame batch exposes aggregate timeout pressure through events and health"
);
const timeoutDry = await timeoutProcessor.process([
  { id: "timeout-deck", target: timeoutTarget, channels: [[0, 1]] }
]);
assert(
  timeoutTargetCalls === 1 &&
    timeoutDry.processedTargets === 0 &&
    timeoutDry.skippedTargets === 1 &&
    timeoutDry.processTimeoutTripped === true &&
    timeoutEvents.recovered === 1 &&
    timeoutProcessor.health.processTimeoutTripped === false,
  "live frame batch can auto-recover after a bounded dry timeout window"
);

console.log("Live effect rack scheduler smoke checks passed.");
