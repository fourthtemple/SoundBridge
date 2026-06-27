import {
  SoundBridgeAudioNode,
  boundedAudioNodeTransportPressureReasons,
  calibrateLivePerformanceAudioNodePolicy,
  createLivePerformanceAudioNodeAdaptiveLatencyController,
  createLivePerformanceAudioNodeCalibrationWindow,
  createLivePerformanceAudioNodeOptions,
  createLivePerformanceAudioNodePolicy,
  livePerformanceAudioNodeOptionsFromCalibration,
  refreshLivePerformanceAudioNodeLatencyFromCalibration,
  shouldAutoBypassAudioNodeTransportPressure
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

assert(
  boundedAudioNodeTransportPressureReasons(["deadline-miss", "invalid", "deadline-miss", "shared-output-drop"]).join(",") === "deadline-miss,shared-output-drop",
  "live AudioNode transport pressure reason filters are bounded and deduplicated"
);
assert(shouldAutoBypassAudioNodeTransportPressure(["response-jitter"], undefined) === true, "live AudioNode auto-bypass defaults to any pressure reason");
assert(
  shouldAutoBypassAudioNodeTransportPressure(["response-jitter"], ["deadline-miss"]) === false &&
    shouldAutoBypassAudioNodeTransportPressure(["response-jitter", "deadline-miss"], ["deadline-miss"]) === true,
  "live AudioNode auto-bypass can be filtered to selected pressure reasons"
);

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

const readyWindow = createLivePerformanceAudioNodeCalibrationWindow({
  instanceId: "inst-ready-window",
  sampleRate: 48000,
  maxBlockFrames: 128,
  transportLatencySamples: 384,
  safetyMarginBlocks: 0
});
let readySnapshot = readyWindow.snapshot();
assert(readySnapshot.samples === 0 && readySnapshot.droppedSamples === 0, "live AudioNode calibration window starts empty");
readySnapshot = readyWindow.record({
  lastRenderDurationMs: 0.5,
  responseJitterBlocks: 0.25,
  responseDeadlineLeadSamples: 160
});
assert(readySnapshot.samples === 1, "live AudioNode calibration window records health snapshots");
assert(readySnapshot.calibration.realtimeReady === true, "live AudioNode calibration window accepts in-budget health");
assert(readySnapshot.calibration.observedDeadlineLeadMinBlocks === 1.25, "live AudioNode calibration window converts deadline lead samples to blocks");
assert(readySnapshot.recommendedOptions.outputLatencyBlocks === 3, "live AudioNode calibration window recommends output latency options");
assert(readySnapshot.recommendedOptions.audioRequestTimeoutMs === 250, "live AudioNode calibration window carries timeout options");
const unchangedReadySnapshot = readyWindow.record({ lastRenderDurationMs: Number.NaN });
assert(unchangedReadySnapshot.samples === 1, "live AudioNode calibration window ignores non-finite samples");

const baselineWindow = createLivePerformanceAudioNodeCalibrationWindow({
  instanceId: "inst-baseline-window",
  sampleRate: 48000,
  maxBlockFrames: 128,
  transportLatencySamples: 256,
  safetyMarginBlocks: 0
});
const baselineSnapshot = baselineWindow.record({
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  responseDeadlineLeadSamples: 128,
  underruns: 9,
  fallbackOutputBlocks: 4,
  droppedInputBlocks: 3,
  staleOutputBlocks: 2,
  sharedInputDroppedBlocks: 1,
  sharedOutputDroppedBlocks: 1,
  responseDeadlineMisses: 4
});
assert(baselineSnapshot.calibration.realtimeReady === true, "live AudioNode calibration window treats first pressure counters as the baseline");
assert(!baselineSnapshot.calibration.warnings.includes("audio-drop-pressure"), "live AudioNode calibration window ignores pressure before the window starts");
const deltaSnapshot = baselineWindow.record({
  lastRenderDurationMs: 0.5,
  responseJitterBlocks: 0.25,
  responseDeadlineLeadSamples: 128,
  underruns: 9,
  fallbackOutputBlocks: 5,
  droppedInputBlocks: 3,
  staleOutputBlocks: 2,
  sharedInputDroppedBlocks: 1,
  sharedOutputDroppedBlocks: 1,
  responseDeadlineMisses: 5
});
assert(deltaSnapshot.calibration.warnings.includes("audio-drop-pressure"), "live AudioNode calibration window counts pressure deltas after the baseline");
assert(deltaSnapshot.calibration.warnings.includes("deadline-miss"), "live AudioNode calibration window counts deadline-miss deltas after the baseline");
baselineWindow.reset();
const resetBaselineSnapshot = baselineWindow.record({
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0.25,
  responseDeadlineLeadSamples: 128,
  underruns: 10
});
assert(resetBaselineSnapshot.calibration.realtimeReady === true, "live AudioNode calibration window reset also resets the pressure baseline");

const sharedQueueCalibration = calibrateLivePerformanceAudioNodePolicy({
  instanceId: "inst-shared-queue",
  sampleRate: 48000,
  maxBlockFrames: 128,
  sharedBufferBlocks: 8,
  sharedInputQueuedBlocks: 7,
  sharedOutputQueuedBlocks: 2,
  safetyMarginBlocks: 1
});
assert(sharedQueueCalibration.observedSharedQueueMaxBlocks === 7, "live AudioNode calibration reports shared queue depth");
assert(sharedQueueCalibration.recommendedSharedBufferBlocks === 9, "live AudioNode calibration recommends shared ring headroom before drops");
assert(
  includesAll(sharedQueueCalibration.warnings, ["shared-ring-pressure", "increase-shared-buffer"]),
  "live AudioNode calibration warns on near-full shared rings"
);

const sharedQueueWindow = createLivePerformanceAudioNodeCalibrationWindow({
  instanceId: "inst-shared-queue-window",
  sampleRate: 48000,
  maxBlockFrames: 128,
  sharedBufferBlocks: 8,
  safetyMarginBlocks: 1
});
const sharedQueueSnapshot = sharedQueueWindow.record({
  lastRenderDurationMs: 0.5,
  responseJitterBlocks: 0.25,
  responseDeadlineLeadSamples: 128,
  sharedInputQueuedBlocks: 7
});
assert(sharedQueueSnapshot.calibration.observedSharedQueueMaxBlocks === 7, "live AudioNode calibration window keeps shared queue gauges");
assert(sharedQueueSnapshot.recommendedOptions.sharedBufferBlocks === 9, "live AudioNode calibration window recommends shared ring headroom");

const deadlineCounterCalibration = calibrateLivePerformanceAudioNodePolicy({
  instanceId: "inst-deadline-counter",
  sampleRate: 48000,
  maxBlockFrames: 128,
  transportLatencySamples: 128,
  deadlineLeadBlocks: [1],
  responseDeadlineMisses: 1,
  safetyMarginBlocks: 1
});
assert(deadlineCounterCalibration.warnings.includes("deadline-miss"), "live AudioNode calibration uses explicit deadline-miss counters");
assert(deadlineCounterCalibration.recommendedOutputLatencyBlocks === 2, "live AudioNode deadline-miss counters add latency headroom");
assert(deadlineCounterCalibration.recommendedTransportLatencySamples === 256, "live AudioNode deadline-miss counters update transport latency advice");

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

const stressedWindow = createLivePerformanceAudioNodeCalibrationWindow({
  instanceId: "inst-stress-window",
  sampleRate: 48000,
  maxBlockFrames: 128,
  maxSamples: 2,
  pluginLatencySamples: 64,
  safetyMarginBlocks: 1
});
stressedWindow.record({
  lastRenderDurationMs: 2.6,
  responseJitterBlocks: 1,
  responseDeadlineLeadSamples: 128
});
stressedWindow.record({
  lastRenderDurationMs: 4,
  responseJitterBlocks: 3,
  responseDeadlineLeadSamples: -128,
  underruns: 1,
  sharedInputDroppedBlocks: 1
});
const stressedSnapshot = stressedWindow.record({
  lastRenderDurationMs: 4.2,
  responseJitterBlocks: 3.25,
  responseDeadlineLeadSamples: -160,
  droppedInputBlocks: 2
});
assert(stressedSnapshot.samples === 2, "live AudioNode calibration window keeps bounded recent samples");
assert(stressedSnapshot.droppedSamples === 1, "live AudioNode calibration window reports overwritten sample windows");
assert(stressedSnapshot.calibration.realtimeReady === false, "live AudioNode calibration window flags stressed health");
assert(stressedSnapshot.calibration.warnings.includes("audio-drop-pressure"), "live AudioNode calibration window keeps pressure counters");
assert(stressedSnapshot.recommendedOptions.outputLatencyBlocks === 7, "live AudioNode calibration window recommends output latency from jitter and pressure");
assert(stressedSnapshot.recommendedOptions.maxOutputLatencyBlocks === 8, "live AudioNode calibration window recommends max latency headroom");
assert(stressedSnapshot.recommendedOptions.sharedBufferBlocks === 12, "live AudioNode calibration window recommends shared ring depth");

const overriddenOptions = stressedWindow.recommendedOptions({
  instanceId: "inst-next",
  inputChannels: 4,
  outputLatencyBlocks: 1,
  sharedBufferBlocks: 2
});
assert(overriddenOptions.instanceId === "inst-next", "live AudioNode calibration recommendations allow next-instance overrides");
assert(overriddenOptions.inputChannels === 4, "live AudioNode calibration recommendations preserve host channel overrides");
assert(overriddenOptions.outputLatencyBlocks === 7, "live AudioNode calibration recommendations keep measured output latency advice");
assert(overriddenOptions.sharedBufferBlocks === 12, "live AudioNode calibration recommendations keep measured shared-buffer advice");

const copiedOptions = livePerformanceAudioNodeOptionsFromCalibration(stressedSnapshot.calibration, { audioTransferMode: "message" });
assert(copiedOptions.audioTransferMode === "message", "live AudioNode calibration helper preserves non-measured host overrides");
assert(copiedOptions.maxOutputLatencyBlocks === stressedSnapshot.recommendedOptions.maxOutputLatencyBlocks, "live AudioNode calibration helper copies max latency advice");

const latencyRefreshes = [];
const refreshed = await refreshLivePerformanceAudioNodeLatencyFromCalibration({
  async refreshLatency(transportLatencySamples) {
    latencyRefreshes.push(transportLatencySamples);
    return { transportLatencySamples };
  }
}, stressedSnapshot.calibration);
assert(latencyRefreshes.length === 1 && latencyRefreshes[0] === 896, "live AudioNode calibration helper refreshes latency with recommended transport latency");
assert(refreshed.transportLatencySamples === 896, "live AudioNode calibration helper returns the latency refresh result");

const filteredLiveOptions = createLivePerformanceAudioNodeOptions({
  instanceId: "inst-filtered-live",
  transportPressureAutoBypassReasons: ["deadline-miss", "response-jitter", "deadline-miss"]
});
assert(
  filteredLiveOptions.transportPressureAutoBypassReasons.join(",") === "deadline-miss,response-jitter",
  "live AudioNode options normalize transport-pressure auto-bypass filters"
);

class FakeAudioNodePort {
  onmessage = undefined;
  messages = [];
  postMessage(message) {
    this.messages.push(message);
  }
}
class FakeAudioWorkletNodeForPolicy {
  static last;
  constructor(_context, _name, options) {
    this.options = options;
    this.port = new FakeAudioNodePort();
    FakeAudioWorkletNodeForPolicy.last = this;
  }
  connect(destination) {
    return destination;
  }
  disconnect() {}
}
const previousAudioWorkletNode = globalThis.AudioWorkletNode;
globalThis.AudioWorkletNode = FakeAudioWorkletNodeForPolicy;
const filteredNode = new SoundBridgeAudioNode(
  { sampleRate: 48000 },
  { createAudioWorkletTransportConnection: () => undefined, destroyInstance: async () => undefined },
  {
    ...createLivePerformanceAudioNodeOptions({
      instanceId: "inst-filtered-node",
      maxConsecutiveTransportPressureEvents: 2,
      transportPressureAutoBypassReasons: ["deadline-miss"]
    }),
    workletUrl: "/unused-worklet.js"
  }
);
globalThis.AudioWorkletNode = previousAudioWorkletNode;
let filteredPressureEvents = 0;
let filteredAutoBypassEvents = 0;
filteredNode.addEventListener("transport-pressure", () => {
  filteredPressureEvents += 1;
});
filteredNode.addEventListener("transport-pressure-auto-bypassed", () => {
  filteredAutoBypassEvents += 1;
});
const filteredStatsBase = {
  type: "stats",
  outputLatencyBlocks: 2,
  transportLatencySamples: 256,
  responseJitterBlocks: 3,
  responseJitterSamples: 384,
  responseDeadlineMisses: 0,
  staleOutputBlocks: 0,
  droppedInputBlocks: 0,
  underruns: 0,
  sharedInputDroppedBlocks: 0,
  sharedOutputDroppedBlocks: 0
};
FakeAudioWorkletNodeForPolicy.last.port.onmessage({ data: { ...filteredStatsBase, latencyIncreases: 1 } });
FakeAudioWorkletNodeForPolicy.last.port.onmessage({ data: { ...filteredStatsBase, latencyIncreases: 2 } });
assert(filteredPressureEvents === 2, "filtered AudioNode still emits transport-pressure for soft pressure");
assert(filteredNode.health.consecutiveTransportPressureEvents === 0, "filtered AudioNode does not count unmatched pressure toward auto-bypass");
assert(filteredNode.health.bypassed === false && filteredAutoBypassEvents === 0, "filtered AudioNode does not auto-bypass on unmatched pressure");
assert(filteredNode.health.transportPressureAutoBypassReasons.join(",") === "deadline-miss", "filtered AudioNode health reports auto-bypass reasons");
FakeAudioWorkletNodeForPolicy.last.port.onmessage({ data: { ...filteredStatsBase, latencyIncreases: 2, responseDeadlineMisses: 1 } });
assert(filteredNode.health.consecutiveTransportPressureEvents === 1, "filtered AudioNode starts the auto-bypass streak on matched pressure");
FakeAudioWorkletNodeForPolicy.last.port.onmessage({ data: { ...filteredStatsBase, latencyIncreases: 2, responseDeadlineMisses: 2 } });
assert(filteredNode.health.bypassed === true, "filtered AudioNode auto-bypasses after sustained matched pressure");
assert(filteredAutoBypassEvents === 1, "filtered AudioNode emits auto-bypass after matched pressure threshold");

const adaptiveNode = {
  health: {
    lastRenderDurationMs: 0.5,
    responseJitterBlocks: 3,
    responseDeadlineLeadSamples: -128,
    transportLatencySamples: 128
  },
  refreshes: [],
  async refreshLatency(transportLatencySamples) {
    this.refreshes.push(transportLatencySamples);
    this.health.transportLatencySamples = transportLatencySamples;
    return { transportLatencySamples };
  }
};
const adaptiveController = createLivePerformanceAudioNodeAdaptiveLatencyController({
  node: adaptiveNode,
  instanceId: "inst-audio-node-adaptive",
  sampleRate: 48000,
  maxBlockFrames: 128,
  transportLatencySamples: 128,
  minSamples: 2,
  cooldownBlocks: 0,
  maxLatencyIncreaseBlocks: 2,
  latencyRecoveryBlocks: 2,
  maxLatencyDecreaseBlocks: 1,
  minTransportLatencyBlocks: 1,
  safetyMarginBlocks: 1
});
const pressureNoApply = await adaptiveController.record();
assert(pressureNoApply.applied === false && adaptiveNode.refreshes.length === 0, "live AudioNode adaptive latency waits for enough pressure samples");
const pressureApplied = await adaptiveController.record();
assert(pressureApplied.applied === true, "live AudioNode adaptive latency applies after sustained pressure");
assert(pressureApplied.appliedDirection === "increase", "live AudioNode adaptive latency reports increase direction");
assert(adaptiveNode.refreshes[0] === 384, "live AudioNode adaptive latency caps increase steps");
assert(pressureApplied.refreshResult.transportLatencySamples === 384, "live AudioNode adaptive latency returns refresh results");
adaptiveNode.health = {
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0,
  responseDeadlineLeadSamples: 256,
  transportLatencySamples: adaptiveNode.health.transportLatencySamples
};
const stableOne = await adaptiveController.record();
assert(stableOne.applied === false && stableOne.stableBlocks === 0, "live AudioNode adaptive latency waits for enough stable samples");
const stableTwo = await adaptiveController.record();
assert(stableTwo.applied === false && stableTwo.stableBlocks === 1, "live AudioNode adaptive latency waits through stable recovery blocks");
const stableThree = await adaptiveController.record();
assert(stableThree.applied === true && stableThree.appliedDirection === "decrease", "live AudioNode adaptive latency recovers after stable health");
assert(adaptiveNode.refreshes.at(-1) === 256, "live AudioNode adaptive latency caps recovery steps");
adaptiveController.reset();
const resetStable = await adaptiveController.record();
assert(resetStable.stableBlocks === 0, "live AudioNode adaptive latency reset clears stable recovery state");

stressedWindow.reset();
const resetSnapshot = stressedWindow.snapshot();
assert(resetSnapshot.samples === 0 && resetSnapshot.droppedSamples === 0, "live AudioNode calibration window reset clears samples");

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
