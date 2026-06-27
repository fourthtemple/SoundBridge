import {
  calibrateLivePerformanceAudioNodePolicy,
  createLivePerformanceAudioNodePolicy
} from "../packages/web-client/dist/soundbridge-client.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function near(actual, expected) {
  return Math.abs(actual - expected) < 0.000001;
}

function includesAll(values, expectedValues) {
  return expectedValues.every((value) => values.includes(value));
}

const policy = createLivePerformanceAudioNodePolicy({
  instanceId: "inst-audio-policy",
  inputChannels: 2,
  outputChannels: 2,
  sampleRate: 48000,
  maxBlockFrames: 128,
  pluginLatencySamples: 32,
  transportLatencySamples: 256
});
assert(policy.blockDurationMs === 2.667, "live AudioNode policy exposes block duration");
assert(policy.outputLatencyBlocks === 2, "live AudioNode policy exposes output latency blocks");
assert(policy.outputLatencySamples === 256 && policy.outputLatencyMs === 5.333, "live AudioNode policy exposes output latency timing");
assert(policy.maxOutputLatencyBlocks === 4 && policy.maxOutputLatencySamples === 512, "live AudioNode policy exposes adaptive latency ceiling");
assert(policy.maxInFlightBlocks === 4 && policy.maxQueuedOutputBlocks === 8, "live AudioNode policy exposes bounded queue depth");
assert(policy.sharedBufferBlocks === 8, "live AudioNode policy derives shared ring depth from live latency bounds");
assert(policy.audioRequestTimeoutMs === 250 && near(policy.audioRequestTimeoutBlocks, 93.75), "live AudioNode policy exposes audio timeout in blocks");
assert(policy.reportedLatencySamples === 288 && policy.reportedLatencyMs === 6, "live AudioNode policy combines plugin and transport latency");

const readyCalibration = calibrateLivePerformanceAudioNodePolicy({
  instanceId: "inst-ready",
  sampleRate: 48000,
  maxBlockFrames: 128,
  transportLatencySamples: 384,
  renderDurationsMs: [0.4, 0.5, 0.6],
  responseJitterBlocks: [0, 0.25, 0.5],
  deadlineLeadBlocks: [1, 1.25],
  safetyMarginBlocks: 0
});
assert(readyCalibration.realtimeReady === true, "live AudioNode calibration accepts in-budget measurements");
assert(readyCalibration.warnings.length === 0, "live AudioNode calibration stays quiet for in-budget measurements");
assert(readyCalibration.recommendedOutputLatencyBlocks === 3, "live AudioNode calibration preserves enough existing transport latency");
assert(readyCalibration.recommendedTransportLatencySamples === 384, "live AudioNode calibration preserves transport latency samples");
assert(readyCalibration.recommendedMaxOutputLatencyBlocks === 4, "live AudioNode calibration avoids growing max latency when existing ceiling is enough");

const stressedCalibration = calibrateLivePerformanceAudioNodePolicy({
  instanceId: "inst-stress",
  sampleRate: 48000,
  maxBlockFrames: 128,
  pluginLatencySamples: 64,
  renderDurationsMs: [2.6, 3.1, 4],
  responseJitterBlocks: [1, 2, 3],
  deadlineLeadBlocks: [1, -1, 0],
  underruns: 1,
  safetyMarginBlocks: 1
});
assert(stressedCalibration.realtimeReady === false, "live AudioNode calibration flags stressed measurements");
assert(stressedCalibration.observedRenderP95Ms === 4, "live AudioNode calibration reports render p95");
assert(stressedCalibration.observedResponseJitterP95Blocks === 3, "live AudioNode calibration reports jitter p95");
assert(stressedCalibration.observedDeadlineLeadMinBlocks === -1, "live AudioNode calibration reports missed deadline lead");
assert(stressedCalibration.recommendedOutputLatencyBlocks === 6, "live AudioNode calibration recommends bounded output latency");
assert(stressedCalibration.recommendedTransportLatencySamples === 768, "live AudioNode calibration converts recommended latency to samples");
assert(stressedCalibration.recommendedMaxOutputLatencyBlocks === 8, "live AudioNode calibration recommends adaptive latency headroom");
assert(stressedCalibration.recommendedSharedBufferBlocks === 12, "live AudioNode calibration recommends shared ring depth");
assert(stressedCalibration.recommendedReportedLatencySamples === 832, "live AudioNode calibration combines plugin and recommended transport latency");
assert(
  includesAll(stressedCalibration.warnings, [
    "audio-drop-pressure",
    "deadline-miss",
    "response-jitter",
    "render-over-block-budget",
    "increase-output-latency",
    "increase-max-output-latency",
    "increase-shared-buffer"
  ]),
  "live AudioNode calibration reports expected pressure warnings"
);

const boundedCalibration = calibrateLivePerformanceAudioNodePolicy({
  instanceId: "inst-bounded",
  sampleRate: 48000,
  maxBlockFrames: 128,
  renderDurationsMs: [Number.NaN, -1, 100000],
  responseJitterBlocks: Array(300).fill(200),
  deadlineLeadBlocks: [-100],
  safetyMarginBlocks: 99
});
assert(boundedCalibration.observedRenderP95Ms === 60000, "live AudioNode calibration clamps duration samples");
assert(boundedCalibration.observedResponseJitterP95Blocks === 64, "live AudioNode calibration clamps jitter samples");
assert(boundedCalibration.observedDeadlineLeadMinBlocks === -64, "live AudioNode calibration clamps deadline lead samples");
assert(boundedCalibration.recommendedOutputLatencyBlocks === 8, "live AudioNode calibration clamps recommended output latency");
assert(boundedCalibration.recommendedMaxOutputLatencyBlocks === 8, "live AudioNode calibration clamps recommended max output latency");
assert(boundedCalibration.recommendedSharedBufferBlocks === 12, "live AudioNode calibration keeps enough shared ring space at the clamp");
assert(boundedCalibration.recommendedAudioRequestTimeoutMs === 60000, "live AudioNode calibration clamps request timeout recommendations");

console.log("Live AudioNode policy smoke checks passed.");
