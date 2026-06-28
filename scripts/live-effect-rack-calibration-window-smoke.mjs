import {
  createLiveEffectRackChain,
  createLiveEffectRackChainCalibrationWindow,
  createLiveEffectRackCalibrationWindow,
  createLiveEffectRackFrameBatchCalibrationWindow,
  liveEffectRackPolicyOptionsFromCalibration,
  refreshLiveEffectRackLatencyFromCalibration
} from "../packages/web-client/dist/soundbridge-client.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const readyWindow = createLiveEffectRackCalibrationWindow({
  sampleRate: 48000,
  maxBlockSize: 128,
  processBudgetMs: 8,
  processTimeoutMs: 12,
  transportLatencySamples: 256,
  safetyMarginBlocks: 1
});

let readySnapshot = readyWindow.snapshot();
assert(readySnapshot.samples === 0, "live rack calibration window starts empty");
assert(readySnapshot.droppedSamples === 0, "live rack calibration window starts without dropped samples");
assert(readyWindow.maxSamples === 256, "live rack calibration window defaults to the bounded policy sample cap");

readySnapshot = readyWindow.record({
  lastProcessDurationMs: 0.7,
  lastRenderDurationMs: 0.5,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1.25
});
assert(readySnapshot.samples === 1, "live rack calibration window records a health snapshot");
assert(readySnapshot.calibration.realtimeReady === true, "live rack calibration window accepts measurements inside existing safety headroom");
assert(readySnapshot.calibration.observedProcessP95Ms === 0.7, "live rack calibration window records process duration");
assert(readySnapshot.calibration.observedRenderP95Ms === 0.5, "live rack calibration window records render duration");
assert(readySnapshot.calibration.observedResponseJitterP95Blocks === 0.25, "live rack calibration window records response jitter");
assert(readySnapshot.calibration.observedDeadlineLeadMinBlocks === 1.25, "live rack calibration window records deadline lead");
assert(readySnapshot.recommendedPolicyOptions.processBudgetMs === 8, "live rack calibration snapshot includes existing budget policy");
assert(readySnapshot.recommendedPolicyOptions.processTimeoutMs === 12, "live rack calibration snapshot includes existing timeout policy");
assert(readySnapshot.recommendedPolicyOptions.transportLatencySamples === 256, "live rack calibration snapshot includes recommended latency policy");

const unchangedSnapshot = readyWindow.record({ lastProcessDurationMs: Number.NaN });
assert(unchangedSnapshot.samples === 1, "live rack calibration window ignores non-finite health samples");

const baselineWindow = createLiveEffectRackCalibrationWindow({
  sampleRate: 48000,
  maxBlockSize: 128,
  processBudgetMs: 8,
  processTimeoutMs: 12,
  transportLatencySamples: 256,
  safetyMarginBlocks: 0
});

const baselineSnapshot = baselineWindow.record({
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1,
  droppedInputBlocks: 7,
  staleInputBlocks: 3,
  staleOutputBlocks: 2,
  responseDeadlineMisses: 4,
  renderTimeouts: 1
});
assert(baselineSnapshot.calibration.realtimeReady === true, "live rack calibration window treats first pressure counters as the baseline");
assert(!baselineSnapshot.calibration.warnings.includes("dry-output-pressure"), "live rack calibration window ignores old dry-output pressure");
assert(!baselineSnapshot.calibration.warnings.includes("deadline-miss"), "live rack calibration window ignores old deadline misses");
assert(!baselineSnapshot.calibration.warnings.includes("process-timeout"), "live rack calibration window ignores old render timeouts");

const deltaSnapshot = baselineWindow.record({
  lastProcessDurationMs: 0.6,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1,
  droppedInputBlocks: 8,
  staleInputBlocks: 3,
  staleOutputBlocks: 2,
  dryOutputBlocks: 1,
  responseDeadlineMisses: 5,
  renderTimeouts: 2
});
assert(deltaSnapshot.calibration.warnings.includes("dry-output-pressure"), "live rack calibration window counts dry-output pressure deltas after the baseline");
assert(deltaSnapshot.calibration.warnings.includes("deadline-miss"), "live rack calibration window counts deadline-miss deltas after the baseline");
assert(deltaSnapshot.calibration.warnings.includes("process-timeout"), "live rack calibration window counts render-timeout deltas after the baseline");
assert(deltaSnapshot.calibration.warnings.includes("increase-process-timeout"), "live rack calibration window recommends timeout headroom after render-timeout deltas");
assert(deltaSnapshot.recommendedPolicyOptions.processTimeoutMs === 14.667, "live rack calibration window makes render-timeout pressure actionable");

baselineWindow.reset();
const resetBaselineSnapshot = baselineWindow.record({
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1,
  droppedInputBlocks: 8,
  staleInputBlocks: 3,
  staleOutputBlocks: 2,
  responseDeadlineMisses: 5,
  renderTimeouts: 2
});
assert(resetBaselineSnapshot.calibration.realtimeReady === true, "live rack calibration window reset also resets the pressure baseline");

const stressedWindow = createLiveEffectRackCalibrationWindow({
  sampleRate: 48000,
  maxBlockSize: 128,
  maxSamples: 2,
  processBudgetMs: 2,
  processTimeoutMs: 4,
  safetyMarginBlocks: 1
});

stressedWindow.record({
  lastProcessDurationMs: 0.4,
  lastRenderDurationMs: 0.3,
  responseJitterBlocks: 0,
  lastResponseDeadlineLeadBlocks: 1
});
stressedWindow.record({
  lastProcessDurationMs: 6,
  lastRenderDurationMs: 3.2,
  responseJitterBlocks: 2,
  lastResponseDeadlineLeadBlocks: -0.5
});
const stressedSnapshot = stressedWindow.record({
  lastProcessDurationMs: 7,
  lastRenderDurationMs: 3.4,
  responseJitterBlocks: 3,
  lastResponseDeadlineLeadBlocks: -1
});

assert(stressedSnapshot.samples === 2, "live rack calibration window keeps only bounded recent samples");
assert(stressedSnapshot.droppedSamples === 1, "live rack calibration window reports overwritten sample windows");
assert(stressedSnapshot.calibration.realtimeReady === false, "live rack calibration window flags stressed measurements");
assert(stressedSnapshot.calibration.observedProcessP95Ms === 7, "live rack calibration window keeps the recent process p95");
assert(stressedSnapshot.calibration.warnings.includes("process-over-budget"), "live rack calibration window warns on process budget pressure");
assert(stressedSnapshot.calibration.warnings.includes("render-over-block-budget"), "live rack calibration window warns on render budget pressure");
assert(stressedSnapshot.calibration.warnings.includes("deadline-miss"), "live rack calibration window warns on missed response deadlines");
assert(stressedSnapshot.calibration.warnings.includes("increase-transport-latency"), "live rack calibration window recommends latency for jitter pressure");
assert(stressedSnapshot.recommendedPolicyOptions.processBudgetMs === 9.667, "live rack calibration snapshot recommends a process budget with safety margin");
assert(stressedSnapshot.recommendedPolicyOptions.processTimeoutMs === 12.334, "live rack calibration snapshot recommends a timeout with safety margin");
assert(stressedSnapshot.recommendedPolicyOptions.transportLatencySamples === 640, "live rack calibration snapshot recommends latency samples");

const overriddenOptions = stressedWindow.recommendedPolicyOptions({
  sampleRate: 96000,
  maxBlockSize: 512,
  maxInFlightBlocks: 4,
  processBudgetMs: 1,
  transportLatencySamples: 0
});
assert(overriddenOptions.sampleRate === 48000, "live rack calibration recommendations keep the measured sample rate");
assert(overriddenOptions.maxBlockSize === 128, "live rack calibration recommendations keep the measured block size");
assert(overriddenOptions.maxInFlightBlocks === 4, "live rack calibration recommendations preserve host policy overrides");
assert(overriddenOptions.processBudgetMs === stressedSnapshot.recommendedPolicyOptions.processBudgetMs, "live rack calibration recommendations keep measured process budget advice");
assert(overriddenOptions.transportLatencySamples === stressedSnapshot.recommendedPolicyOptions.transportLatencySamples, "live rack calibration recommendations keep measured latency advice");

const copiedOptions = liveEffectRackPolicyOptionsFromCalibration(stressedSnapshot.calibration, { transitionFadeSamples: 64 });
assert(copiedOptions.transitionFadeSamples === 64, "live rack calibration helper preserves non-measured host overrides");
assert(copiedOptions.processTimeoutMs === stressedSnapshot.recommendedPolicyOptions.processTimeoutMs, "live rack calibration helper copies timeout advice");

const latencyRefreshes = [];
const refreshed = await refreshLiveEffectRackLatencyFromCalibration({
  async refreshLatency(transportLatencySamples) {
    latencyRefreshes.push(transportLatencySamples);
    return { transportLatencySamples };
  }
}, stressedSnapshot.calibration);
assert(latencyRefreshes.length === 1 && latencyRefreshes[0] === 640, "live rack calibration helper refreshes rack latency with recommended transport latency");
assert(refreshed.transportLatencySamples === 640, "live rack calibration helper returns the rack latency refresh result");

let chainNowMs = 0;
const chainStage = {
  durationMs: 1,
  latencySamples: 256,
  async processBlock(request) {
    chainNowMs += this.durationMs;
    return {
      blockId: request.blockId,
      channels: request.channels,
      latencySamples: this.latencySamples,
      renderEngine: "chain-calibration-stage",
      bypassed: false,
      healthy: true
    };
  }
};
const chain = createLiveEffectRackChain({
  stages: [chainStage],
  sampleRate: 48000,
  maxBlockSize: 128,
  processBudgetMs: 2,
  transitionFadeSamples: 64,
  nowMs: () => chainNowMs
});
const chainWindow = createLiveEffectRackChainCalibrationWindow({
  sampleRate: 48000,
  maxBlockSize: 128,
  processBudgetMs: 5,
  processTimeoutMs: 12,
  transportLatencySamples: 128,
  safetyMarginBlocks: 1
});
await chain.processBlock({ blockId: 20, channels: [[1, 1]], sampleRate: 48000 });
const chainReady = chainWindow.record(chain.health);
assert(chainReady.samples === 1, "live chain calibration window records chain health");
assert(chainReady.calibration.policy.pluginLatencySamples === 256, "live chain calibration window carries aggregate chain latency");
assert(chainReady.calibration.realtimeReady === true, "live chain calibration window accepts ready chain measurements");

chainStage.durationMs = 6;
await chain.processBlock({ blockId: 21, channels: [[1, 1]], sampleRate: 48000 });
const chainStressed = chainWindow.record(chain.health);
assert(chainStressed.calibration.warnings.includes("process-over-budget"), "live chain calibration window detects chain budget pressure");
assert(chainStressed.calibration.warnings.includes("deadline-miss"), "live chain calibration window detects chain deadline misses");
assert(chainStressed.recommendedPolicyOptions.processBudgetMs === 8.667, "live chain calibration window recommends a chain process budget");

chain.setBypassed(true);
await chain.processBlock({ blockId: 22, channels: [[1, 1]], sampleRate: 48000 });
const chainDry = chainWindow.record(chain.health);
assert(
  chain.health.dryOutputBlocks === 1 &&
    chain.health.bypassDryOutputBlocks === 1 &&
    !chainDry.calibration.warnings.includes("dry-output-pressure"),
  "live chain calibration window ignores intentional chain bypass dry output"
);
const chainPressureDry = chainWindow.record({
  lastProcessDurationMs: 1,
  latencySamples: 256,
  dryOutputBlocks: 2,
  bypassDryOutputBlocks: 1
});
assert(chainPressureDry.calibration.warnings.includes("dry-output-pressure"), "live chain calibration window still counts non-bypass dry output");

const bypassDryWindow = createLiveEffectRackChainCalibrationWindow({
  sampleRate: 48000,
  maxBlockSize: 128,
  processBudgetMs: 5,
  processTimeoutMs: 12
});
bypassDryWindow.record({ lastProcessDurationMs: 1, latencySamples: 0, dryOutputBlocks: 1, bypassDryOutputBlocks: 1 });
const bypassOnlyDrySample = bypassDryWindow.record({ lastProcessDurationMs: 1, latencySamples: 0, dryOutputBlocks: 2, bypassDryOutputBlocks: 2 });
assert(!bypassOnlyDrySample.calibration.warnings.includes("dry-output-pressure"), "live chain calibration window treats cumulative bypass-only dry output as stable");

const repeatDryWindow = createLiveEffectRackChainCalibrationWindow({
  sampleRate: 48000,
  maxBlockSize: 128,
  processBudgetMs: 5,
  processTimeoutMs: 12
});
repeatDryWindow.record({ lastProcessDurationMs: 1, latencySamples: 0, dryOutputBlocks: 1 });
const repeatedDrySample = repeatDryWindow.record({ lastProcessDurationMs: 1, latencySamples: 0, dryOutputBlocks: 1 });
assert(
  !repeatedDrySample.calibration.warnings.includes("dry-output-pressure"),
  "live chain calibration window does not count repeated snapshots as new dry output"
);
const nextDrySample = repeatDryWindow.record({ lastProcessDurationMs: 1, latencySamples: 0, dryOutputBlocks: 2 });
assert(
  nextDrySample.calibration.warnings.includes("dry-output-pressure"),
  "live chain calibration window uses cumulative chain dry output deltas"
);

const chainTimeoutWindow = createLiveEffectRackChainCalibrationWindow({
  sampleRate: 48000,
  maxBlockSize: 128,
  processBudgetMs: 5,
  processTimeoutMs: 12
});
chainTimeoutWindow.record({ lastProcessDurationMs: 1, latencySamples: 0, processTimedOut: false });
const chainTimeoutSample = chainTimeoutWindow.record({ lastProcessDurationMs: 12, latencySamples: 0, processTimedOut: true });
assert(
  chainTimeoutSample.calibration.warnings.includes("process-timeout"),
  "live chain calibration window reports chain process timeouts as timeout pressure"
);
assert(
  !chainTimeoutSample.calibration.warnings.includes("dry-output-pressure"),
  "live chain calibration window keeps timeout-only pressure separate from dry-output pressure"
);

const batchWindow = createLiveEffectRackFrameBatchCalibrationWindow({
  sampleRate: 48000,
  maxBlockSize: 128,
  processBudgetMs: 4,
  processTimeoutMs: 12,
  transportLatencySamples: 256,
  safetyMarginBlocks: 1
});
const batchReady = batchWindow.record({
  totalDurationMs: 1,
  maxDurationMs: 0.7,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: 1.5,
  responseDeadlineMisses: 0,
  latencySamples: 256,
  reportedLatencySamples: 384,
  dryTargets: 0,
  skippedTargets: 0,
  failedTargets: 0
});
assert(batchReady.samples === 1, "live frame batch calibration window records aggregate batch health");
assert(batchReady.calibration.policy.pluginLatencySamples === 256, "live frame batch calibration uses batch latency as plugin latency");
assert(batchReady.calibration.realtimeReady === true, "live frame batch calibration accepts a ready aggregate batch");

const batchPressure = batchWindow.record({
  totalDurationMs: 6,
  maxDurationMs: 3,
  responseJitterBlocks: 0.25,
  lastResponseDeadlineLeadBlocks: -0.5,
  responseDeadlineMisses: 1,
  latencySamples: 384,
  dryTargets: 1,
  skippedTargets: 1,
  failedTargets: 0,
  processBudgetTripped: true
});
assert(batchPressure.calibration.warnings.includes("dry-output-pressure"), "live frame batch calibration reports dry batch pressure on the first pressured frame");
assert(batchPressure.calibration.warnings.includes("deadline-miss"), "live frame batch calibration records aggregate deadline misses");
assert(batchPressure.calibration.warnings.includes("process-over-budget"), "live frame batch calibration detects aggregate process pressure");
assert(batchPressure.calibration.warnings.includes("render-over-block-budget"), "live frame batch calibration detects slow target pressure");
assert(batchPressure.calibration.observedDeadlineLeadMinBlocks === -0.5, "live frame batch calibration records aggregate deadline lead");
assert(batchPressure.recommendedPolicyOptions.processBudgetMs === 8.667, "live frame batch calibration recommends aggregate batch budget headroom");
assert(batchPressure.recommendedPolicyOptions.transportLatencySamples === 384, "live frame batch calibration recommends aggregate deadline headroom");

batchWindow.reset();
assert(batchWindow.snapshot().samples === 0, "live frame batch calibration window reset clears samples");

const batchTimeoutWindow = createLiveEffectRackFrameBatchCalibrationWindow({
  sampleRate: 48000,
  maxBlockSize: 128,
  processBudgetMs: 4,
  processTimeoutMs: 12,
  safetyMarginBlocks: 0
});
batchTimeoutWindow.record({ totalDurationMs: 1, maxDurationMs: 0.5, latencySamples: 0 });
const batchTimeoutPressure = batchTimeoutWindow.record({
  totalDurationMs: 1,
  maxDurationMs: 0.5,
  latencySamples: 0,
  processTimedOut: true
});
assert(
  batchTimeoutPressure.calibration.warnings.includes("dry-output-pressure"),
  "live frame batch calibration treats timeout-only health as dry pressure"
);
assert(
  batchTimeoutPressure.calibration.warnings.includes("process-timeout"),
  "live frame batch calibration reports timeout-only health as timeout pressure"
);
assert(
  batchTimeoutPressure.calibration.warnings.includes("increase-process-timeout") &&
    batchTimeoutPressure.recommendedPolicyOptions.processTimeoutMs === 14.667,
  "live frame batch calibration makes timeout-only health actionable"
);

const batchBypassWindow = createLiveEffectRackFrameBatchCalibrationWindow({
  sampleRate: 48000,
  maxBlockSize: 128,
  processBudgetMs: 4,
  processTimeoutMs: 12,
  safetyMarginBlocks: 0
});
batchBypassWindow.record({ totalDurationMs: 1, maxDurationMs: 0.5, latencySamples: 0, dryTargets: 0, bypassedTargets: 0 });
const bypassOnlyBatch = batchBypassWindow.record({
  totalDurationMs: 1,
  maxDurationMs: 0.5,
  latencySamples: 0,
  dryTargets: 1,
  bypassedTargets: 1,
  skippedTargets: 0,
  failedTargets: 0
});
assert(!bypassOnlyBatch.calibration.warnings.includes("dry-output-pressure"), "live frame batch calibration ignores intentionally bypassed dry targets");
const nonBypassedDryBatch = batchBypassWindow.record({
  totalDurationMs: 1,
  maxDurationMs: 0.5,
  latencySamples: 0,
  dryTargets: 2,
  bypassedTargets: 1,
  skippedTargets: 0,
  failedTargets: 0
});
assert(nonBypassedDryBatch.calibration.warnings.includes("dry-output-pressure"), "live frame batch calibration still flags non-bypassed dry targets");

chainWindow.reset();
const chainReset = chainWindow.snapshot();
assert(chainReset.samples === 0 && chainWindow.maxSamples === 256, "live chain calibration window resets its inner sample window");

stressedWindow.reset();
const resetSnapshot = stressedWindow.snapshot();
assert(resetSnapshot.samples === 0, "live rack calibration window reset clears samples");
assert(resetSnapshot.droppedSamples === 0, "live rack calibration window reset clears dropped sample count");

console.log("Live effect rack calibration window smoke checks passed.");
