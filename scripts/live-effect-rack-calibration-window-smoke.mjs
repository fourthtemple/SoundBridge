import {
  createLiveEffectRackCalibrationWindow,
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

stressedWindow.reset();
const resetSnapshot = stressedWindow.snapshot();
assert(resetSnapshot.samples === 0, "live rack calibration window reset clears samples");
assert(resetSnapshot.droppedSamples === 0, "live rack calibration window reset clears dropped sample count");

console.log("Live effect rack calibration window smoke checks passed.");
