export interface SoundBridgeAudioNodeOptions {
  instanceId: string;
  inputChannels?: number;
  outputChannels?: number;
  maxInFlightBlocks?: number;
  maxQueuedOutputBlocks?: number;
  outputLatencyBlocks?: number;
  minOutputLatencyBlocks?: number;
  maxOutputLatencyBlocks?: number;
  adaptiveOutputLatency?: boolean;
  latencyMissThresholdBlocks?: number;
  latencyRecoveryBlocks?: number;
  targetResponseDeadlineLeadBlocks?: number;
  latencyPressureThresholdBlocks?: number;
  responseJitterThresholdBlocks?: number;
  statsIntervalBlocks?: number;
  audioTransport?: "binary" | "json";
  audioRequestTimeoutMs?: number;
  audioTransferMode?: "auto" | "message" | "shared";
  sharedBufferBlocks?: number;
  maxBlockFrames?: number;
  maxConsecutiveRenderBudgetMisses?: number;
  maxConsecutiveAudioErrors?: number;
  maxConsecutiveTransportPressureEvents?: number;
  bypassed?: boolean;
  workletUrl?: string;
}

export interface LivePerformanceAudioNodeOptions extends SoundBridgeAudioNodeOptions {}

export interface SoundBridgeAudioNodeHealth {
  healthy: boolean;
  instanceId: string;
  bypassed: boolean;
  bypassEvents: number;
  audioTransport: "binary" | "json";
  audioRequestTimeoutMs: number;
  inFlightBlocks: number;
  maxInFlightBlocks: number;
  queuedOutputBlocks: number;
  outputLatencyBlocks: number;
  transportLatencySamples: number;
  pluginLatencySamples: number;
  reportedLatencySamples: number;
  transportLatencyMs: number;
  pluginLatencyMs: number;
  reportedLatencyMs: number;
  latencyIncreases: number;
  latencyDecreases: number;
  latencyChangeEvents: number;
  latencyRefreshes: number;
  lastLatencyChangeDirection?: "increased" | "decreased" | "changed";
  responseDeadlineLeadSamples: number;
  responseJitterBlocks: number;
  responseJitterSamples: number;
  responseJitterThresholdBlocks: number;
  responseDeadlineMisses: number;
  responseDeadlineMissesSinceLastStats: number;
  staleOutputBlocks: number;
  droppedInputBlocks: number;
  underruns: number;
  sharedAudioEnabled: boolean;
  sharedInputDroppedBlocks: number;
  sharedOutputDroppedBlocks: number;
  transportPressureEvents: number;
  consecutiveTransportPressureEvents: number;
  maxConsecutiveTransportPressureEvents: number;
  transportPressureAutoBypassed: boolean;
  lastTransportPressureReasons: string[];
  lastRenderEngine?: string;
  lastRenderDurationMs?: number;
  lastRenderBudgetMs?: number;
  renderBudgetExceeded: boolean;
  renderBudgetMisses: number;
  maxConsecutiveRenderBudgetMisses: number;
  renderBudgetAutoBypassed: boolean;
  audioErrors: number;
  consecutiveAudioErrors: number;
  maxConsecutiveAudioErrors: number;
  audioErrorAutoBypassed: boolean;
  lastAudioError?: unknown;
  unhealthyReason?: "audio-error" | "render-budget-exceeded" | "transport-pressure" | "destroyed";
}

const LIVE_AUDIO_NODE_MAX_IN_FLIGHT_BLOCKS = 4;
const LIVE_AUDIO_NODE_MAX_QUEUED_OUTPUT_BLOCKS = 8;
const LIVE_AUDIO_NODE_OUTPUT_LATENCY_BLOCKS = 2;
const LIVE_AUDIO_NODE_MAX_OUTPUT_LATENCY_BLOCKS = 4;
const LIVE_AUDIO_NODE_LATENCY_RECOVERY_BLOCKS = 128;
const LIVE_AUDIO_NODE_LATENCY_PRESSURE_THRESHOLD_BLOCKS = 2;
const LIVE_AUDIO_NODE_RESPONSE_JITTER_THRESHOLD_BLOCKS = 2;
const LIVE_AUDIO_NODE_STATS_INTERVAL_BLOCKS = 32;
const LIVE_AUDIO_NODE_SHARED_BUFFER_BLOCKS = 4;
const LIVE_AUDIO_NODE_AUDIO_REQUEST_TIMEOUT_MS = 250;
const LIVE_AUDIO_NODE_CALIBRATION_SAMPLES = 256;

export interface LivePerformanceAudioNodePolicyOptions extends LivePerformanceAudioNodeOptions {
  sampleRate?: number;
  pluginLatencySamples?: number;
  transportLatencySamples?: number;
}

export interface LivePerformanceAudioNodeCalibrationOptions extends LivePerformanceAudioNodePolicyOptions {
  renderDurationsMs?: ArrayLike<number>;
  responseJitterBlocks?: ArrayLike<number>;
  deadlineLeadBlocks?: ArrayLike<number>;
  underruns?: number;
  droppedInputBlocks?: number;
  staleOutputBlocks?: number;
  sharedInputDroppedBlocks?: number;
  sharedOutputDroppedBlocks?: number;
  safetyMarginBlocks?: number;
}

export interface LivePerformanceAudioNodePolicy {
  options: SoundBridgeAudioNodeOptions;
  sampleRate: number;
  maxBlockFrames: number;
  blockDurationMs: number;
  outputLatencyBlocks: number;
  outputLatencySamples: number;
  outputLatencyMs: number;
  minOutputLatencyBlocks: number;
  maxOutputLatencyBlocks: number;
  maxOutputLatencySamples: number;
  maxOutputLatencyMs: number;
  maxInFlightBlocks: number;
  maxQueuedOutputBlocks: number;
  sharedBufferBlocks: number;
  audioRequestTimeoutMs: number;
  audioRequestTimeoutBlocks: number;
  latencyPressureThresholdBlocks: number;
  responseJitterThresholdBlocks: number;
  latencyRecoveryBlocks: number;
  statsIntervalBlocks: number;
  pluginLatencySamples: number;
  transportLatencySamples: number;
  reportedLatencySamples: number;
  reportedLatencyMs: number;
}

export interface LivePerformanceAudioNodeCalibration {
  policy: LivePerformanceAudioNodePolicy;
  observedRenderP95Ms?: number;
  observedResponseJitterP95Blocks?: number;
  observedDeadlineLeadMinBlocks?: number;
  recommendedOutputLatencyBlocks: number;
  recommendedTransportLatencySamples: number;
  recommendedMaxOutputLatencyBlocks: number;
  recommendedSharedBufferBlocks: number;
  recommendedAudioRequestTimeoutMs: number;
  recommendedReportedLatencySamples: number;
  recommendedReportedLatencyMs: number;
  realtimeReady: boolean;
  warnings: string[];
}

export function createLivePerformanceAudioNodeOptions(options: LivePerformanceAudioNodeOptions): SoundBridgeAudioNodeOptions {
  const maxQueuedOutputBlocks = boundedInteger(options.maxQueuedOutputBlocks, LIVE_AUDIO_NODE_MAX_QUEUED_OUTPUT_BLOCKS, 1, 64);
  const outputLatencyBlocks = boundedInteger(options.outputLatencyBlocks, Math.min(LIVE_AUDIO_NODE_OUTPUT_LATENCY_BLOCKS, maxQueuedOutputBlocks), 1, maxQueuedOutputBlocks);
  const maxOutputLatencyBlocks = boundedInteger(
    options.maxOutputLatencyBlocks,
    Math.min(maxQueuedOutputBlocks, Math.max(outputLatencyBlocks + 2, LIVE_AUDIO_NODE_MAX_OUTPUT_LATENCY_BLOCKS)),
    outputLatencyBlocks,
    maxQueuedOutputBlocks
  );
  const maxInFlightBlocks = boundedInteger(options.maxInFlightBlocks, LIVE_AUDIO_NODE_MAX_IN_FLIGHT_BLOCKS, 1, 64);
  const sharedBufferBlocks = boundedInteger(
    options.sharedBufferBlocks,
    Math.max(LIVE_AUDIO_NODE_SHARED_BUFFER_BLOCKS, maxInFlightBlocks + maxOutputLatencyBlocks),
    2,
    64
  );

  return {
    ...options,
    maxInFlightBlocks,
    maxQueuedOutputBlocks,
    outputLatencyBlocks,
    minOutputLatencyBlocks: boundedInteger(options.minOutputLatencyBlocks, 1, 1, outputLatencyBlocks),
    maxOutputLatencyBlocks,
    adaptiveOutputLatency: options.adaptiveOutputLatency !== false,
    latencyMissThresholdBlocks: boundedInteger(options.latencyMissThresholdBlocks, 2, 1, 32),
    latencyRecoveryBlocks: boundedInteger(options.latencyRecoveryBlocks, LIVE_AUDIO_NODE_LATENCY_RECOVERY_BLOCKS, 32, 8192),
    targetResponseDeadlineLeadBlocks: boundedInteger(options.targetResponseDeadlineLeadBlocks, 1, 0, 16),
    latencyPressureThresholdBlocks: boundedInteger(options.latencyPressureThresholdBlocks, LIVE_AUDIO_NODE_LATENCY_PRESSURE_THRESHOLD_BLOCKS, 1, 64),
    responseJitterThresholdBlocks: boundedInteger(options.responseJitterThresholdBlocks, LIVE_AUDIO_NODE_RESPONSE_JITTER_THRESHOLD_BLOCKS, 0, 64),
    statsIntervalBlocks: boundedInteger(options.statsIntervalBlocks, LIVE_AUDIO_NODE_STATS_INTERVAL_BLOCKS, 8, 1024),
    audioTransport: options.audioTransport === "json" ? "json" : "binary",
    audioRequestTimeoutMs: boundedInteger(options.audioRequestTimeoutMs, LIVE_AUDIO_NODE_AUDIO_REQUEST_TIMEOUT_MS, 0, 60000),
    audioTransferMode: options.audioTransferMode ?? "auto",
    sharedBufferBlocks,
    maxBlockFrames: boundedInteger(options.maxBlockFrames, 128, 1, 8192),
    maxConsecutiveRenderBudgetMisses: boundedInteger(options.maxConsecutiveRenderBudgetMisses, 2, 0, 1024),
    maxConsecutiveAudioErrors: boundedInteger(options.maxConsecutiveAudioErrors, 1, 0, 1024),
    maxConsecutiveTransportPressureEvents: boundedInteger(options.maxConsecutiveTransportPressureEvents, 3, 0, 1024),
    bypassed: options.bypassed === true
  };
}

export function createLivePerformanceAudioNodePolicy(options: LivePerformanceAudioNodePolicyOptions): LivePerformanceAudioNodePolicy {
  const normalized = createLivePerformanceAudioNodeOptions(options);
  const sampleRate = boundedInteger(options.sampleRate, 48000, 1, 384000);
  const maxBlockFrames = boundedInteger(normalized.maxBlockFrames, 128, 1, 8192);
  const blockDurationMs = audioNodeBlockDurationMs(sampleRate, maxBlockFrames);
  const pluginLatencySamples = boundedInteger(options.pluginLatencySamples, 0, 0, 1_048_576);
  const transportLatencySamples = boundedInteger(options.transportLatencySamples, normalized.outputLatencyBlocks * maxBlockFrames, 0, 1_048_576);
  const reportedLatencySamples = combinedAudioNodeLatencySamples(pluginLatencySamples, transportLatencySamples);
  return {
    options: normalized,
    sampleRate,
    maxBlockFrames,
    blockDurationMs: roundedAudioNodeNumber(blockDurationMs),
    outputLatencyBlocks: normalized.outputLatencyBlocks,
    outputLatencySamples: normalized.outputLatencyBlocks * maxBlockFrames,
    outputLatencyMs: audioNodeLatencyMilliseconds(normalized.outputLatencyBlocks * maxBlockFrames, sampleRate),
    minOutputLatencyBlocks: normalized.minOutputLatencyBlocks,
    maxOutputLatencyBlocks: normalized.maxOutputLatencyBlocks,
    maxOutputLatencySamples: normalized.maxOutputLatencyBlocks * maxBlockFrames,
    maxOutputLatencyMs: audioNodeLatencyMilliseconds(normalized.maxOutputLatencyBlocks * maxBlockFrames, sampleRate),
    maxInFlightBlocks: normalized.maxInFlightBlocks,
    maxQueuedOutputBlocks: normalized.maxQueuedOutputBlocks,
    sharedBufferBlocks: normalized.sharedBufferBlocks,
    audioRequestTimeoutMs: normalized.audioRequestTimeoutMs,
    audioRequestTimeoutBlocks: audioNodeBlockUnits(normalized.audioRequestTimeoutMs, blockDurationMs),
    latencyPressureThresholdBlocks: normalized.latencyPressureThresholdBlocks,
    responseJitterThresholdBlocks: normalized.responseJitterThresholdBlocks,
    latencyRecoveryBlocks: normalized.latencyRecoveryBlocks,
    statsIntervalBlocks: normalized.statsIntervalBlocks,
    pluginLatencySamples,
    transportLatencySamples,
    reportedLatencySamples,
    reportedLatencyMs: audioNodeLatencyMilliseconds(reportedLatencySamples, sampleRate)
  };
}

export function calibrateLivePerformanceAudioNodePolicy(options: LivePerformanceAudioNodeCalibrationOptions): LivePerformanceAudioNodeCalibration {
  const policy = createLivePerformanceAudioNodePolicy(options);
  const safetyBlocks = boundedOptionalNumber(options.safetyMarginBlocks, 0, 8) ?? 1;
  const observedRenderP95Ms = audioNodePercentileSample(options.renderDurationsMs, 0, 60000);
  const observedResponseJitterP95Blocks = audioNodePercentileSample(options.responseJitterBlocks, 0, 64);
  const observedDeadlineLeadMinBlocks = audioNodeMinimumSample(options.deadlineLeadBlocks, -64, 64);
  const currentLatencyBlocks = audioNodeLatencyBlocks(policy.transportLatencySamples, policy.maxBlockFrames);
  const hasDropPressure = audioNodeDropPressure(options);
  const pressureBlocks =
    Math.ceil((observedResponseJitterP95Blocks ?? 0) + Math.max(0, -(observedDeadlineLeadMinBlocks ?? 0)) + safetyBlocks) +
    (hasDropPressure ? 1 : 0);
  const recommendedOutputLatencyBlocks = boundedInteger(
    Math.max(currentLatencyBlocks, pressureBlocks),
    currentLatencyBlocks,
    policy.minOutputLatencyBlocks,
    policy.maxQueuedOutputBlocks
  );
  const maxOutputLatencyHeadroom = recommendedOutputLatencyBlocks > policy.maxOutputLatencyBlocks ? 2 : 0;
  const recommendedMaxOutputLatencyBlocks = boundedInteger(
    Math.max(policy.maxOutputLatencyBlocks, recommendedOutputLatencyBlocks + maxOutputLatencyHeadroom),
    policy.maxOutputLatencyBlocks,
    recommendedOutputLatencyBlocks,
    policy.maxQueuedOutputBlocks
  );
  const recommendedSharedBufferBlocks = boundedInteger(
    Math.max(policy.sharedBufferBlocks, policy.maxInFlightBlocks + recommendedMaxOutputLatencyBlocks),
    policy.sharedBufferBlocks,
    2,
    64
  );
  const recommendedAudioRequestTimeoutMs = roundedAudioNodeNumber(
    boundedOptionalNumber(Math.max(policy.audioRequestTimeoutMs, (observedRenderP95Ms ?? 0) + policy.blockDurationMs * safetyBlocks), 0, 60000) ??
      policy.audioRequestTimeoutMs
  );
  const recommendedTransportLatencySamples = boundedInteger(
    recommendedOutputLatencyBlocks * policy.maxBlockFrames,
    policy.transportLatencySamples,
    0,
    1_048_576
  );
  const recommendedReportedLatencySamples = combinedAudioNodeLatencySamples(policy.pluginLatencySamples, recommendedTransportLatencySamples);
  const warnings = audioNodeCalibrationWarnings({
    policy,
    observedRenderP95Ms,
    observedResponseJitterP95Blocks,
    observedDeadlineLeadMinBlocks,
    recommendedOutputLatencyBlocks,
    recommendedMaxOutputLatencyBlocks,
    recommendedSharedBufferBlocks,
    recommendedAudioRequestTimeoutMs,
    currentLatencyBlocks,
    hasDropPressure
  });
  return {
    policy,
    observedRenderP95Ms,
    observedResponseJitterP95Blocks,
    observedDeadlineLeadMinBlocks,
    recommendedOutputLatencyBlocks,
    recommendedTransportLatencySamples,
    recommendedMaxOutputLatencyBlocks,
    recommendedSharedBufferBlocks,
    recommendedAudioRequestTimeoutMs,
    recommendedReportedLatencySamples,
    recommendedReportedLatencyMs: audioNodeLatencyMilliseconds(recommendedReportedLatencySamples, policy.sampleRate),
    realtimeReady: warnings.length === 0,
    warnings
  };
}

export function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const integer = Math.floor(Number(value ?? fallback));
  return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
}

export function boundedOptionalNumber(value: unknown, min: number, max: number): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : undefined;
}

export function combinedAudioNodeLatencySamples(pluginLatencySamples: number, transportLatencySamples: number): number {
  return Math.min(1_048_576, pluginLatencySamples + transportLatencySamples);
}

export function audioNodeLatencyMilliseconds(samples: number, sampleRate: number): number {
  const boundedSamples = boundedInteger(samples, 0, 0, 1_048_576);
  const boundedSampleRate = boundedInteger(sampleRate, 48000, 1, 384000);
  return Number(((boundedSamples / boundedSampleRate) * 1000).toFixed(3));
}

function audioNodeBlockDurationMs(sampleRate: number, frames: number): number {
  return (boundedInteger(frames, 128, 1, 8192) / boundedInteger(sampleRate, 48000, 1, 384000)) * 1000;
}

function audioNodeBlockUnits(value: number, blockValue: number): number {
  return blockValue > 0 ? roundedAudioNodeNumber(value / blockValue) : 0;
}

function audioNodeLatencyBlocks(samples: number, frames: number): number {
  const boundedFrames = boundedInteger(frames, 128, 1, 8192);
  return boundedInteger(Math.ceil(boundedInteger(samples, 0, 0, 1_048_576) / boundedFrames), 0, 0, 8192);
}

function audioNodePercentileSample(samples: ArrayLike<number> | undefined, min: number, max: number): number | undefined {
  const values = boundedAudioNodeSamples(samples, min, max);
  if (values.length === 0) return undefined;
  values.sort((left, right) => left - right);
  return roundedAudioNodeNumber(values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] ?? 0);
}

function audioNodeMinimumSample(samples: ArrayLike<number> | undefined, min: number, max: number): number | undefined {
  const values = boundedAudioNodeSamples(samples, min, max);
  return values.length > 0 ? roundedAudioNodeNumber(Math.min(...values)) : undefined;
}

function boundedAudioNodeSamples(samples: ArrayLike<number> | undefined, min: number, max: number): number[] {
  const length = boundedInteger(samples?.length, 0, 0, LIVE_AUDIO_NODE_CALIBRATION_SAMPLES);
  const values: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const sample = Number(samples?.[index]);
    if (Number.isFinite(sample)) values.push(Math.max(min, Math.min(max, sample)));
  }
  return values;
}

function audioNodeDropPressure(options: LivePerformanceAudioNodeCalibrationOptions): boolean {
  return [options.underruns, options.droppedInputBlocks, options.staleOutputBlocks, options.sharedInputDroppedBlocks, options.sharedOutputDroppedBlocks]
    .some((value) => boundedInteger(value, 0, 0, Number.MAX_SAFE_INTEGER) > 0);
}

function audioNodeCalibrationWarnings(calibration: {
  policy: LivePerformanceAudioNodePolicy;
  observedRenderP95Ms?: number;
  observedResponseJitterP95Blocks?: number;
  observedDeadlineLeadMinBlocks?: number;
  recommendedOutputLatencyBlocks: number;
  recommendedMaxOutputLatencyBlocks: number;
  recommendedSharedBufferBlocks: number;
  recommendedAudioRequestTimeoutMs: number;
  currentLatencyBlocks: number;
  hasDropPressure: boolean;
}): string[] {
  const warnings: string[] = [];
  if (calibration.hasDropPressure) warnings.push("audio-drop-pressure");
  if ((calibration.observedDeadlineLeadMinBlocks ?? 0) < 0) warnings.push("deadline-miss");
  if ((calibration.observedResponseJitterP95Blocks ?? 0) > calibration.policy.responseJitterThresholdBlocks) warnings.push("response-jitter");
  if (exceedsAudioNodePolicy(calibration.observedRenderP95Ms ?? 0, calibration.policy.blockDurationMs)) warnings.push("render-over-block-budget");
  if (calibration.recommendedOutputLatencyBlocks > calibration.currentLatencyBlocks) warnings.push("increase-output-latency");
  if (calibration.recommendedMaxOutputLatencyBlocks > calibration.policy.maxOutputLatencyBlocks) warnings.push("increase-max-output-latency");
  if (calibration.recommendedSharedBufferBlocks > calibration.policy.sharedBufferBlocks) warnings.push("increase-shared-buffer");
  if (exceedsAudioNodePolicy(calibration.recommendedAudioRequestTimeoutMs, calibration.policy.audioRequestTimeoutMs)) warnings.push("increase-audio-timeout");
  return Array.from(new Set(warnings));
}

function exceedsAudioNodePolicy(value: number, policyValue: number): boolean {
  return value - policyValue > 0.001;
}

function roundedAudioNodeNumber(value: number): number {
  return Number(value.toFixed(3));
}
