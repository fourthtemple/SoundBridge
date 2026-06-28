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
  transportPressureAutoBypassReasons?: ArrayLike<SoundBridgeAudioNodeTransportPressureReason>;
  bypassed?: boolean;
  workletUrl?: string;
}

export interface LivePerformanceAudioNodeOptions extends SoundBridgeAudioNodeOptions {}

export type SoundBridgeAudioNodeFallbackReason = "bypass" | "latency-safety" | "underrun";
export type SoundBridgeAudioNodeTransportPressureReason =
  | "deadline-miss"
  | "dropped-input"
  | "latency-safety"
  | "response-jitter"
  | "shared-input-drop"
  | "shared-output-drop"
  | "stale-output"
  | "underrun";

export interface SoundBridgeAudioNodeFallbackOutputEventDetail {
  deltaBlocks: number;
  reason?: SoundBridgeAudioNodeFallbackReason;
  stats: unknown;
  health: SoundBridgeAudioNodeHealth;
}

export interface SoundBridgeAudioNodeProcessTimeoutEventDetail {
  error: unknown;
  autoBypassed: boolean;
  health: SoundBridgeAudioNodeHealth;
}

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
  fallbackOutputBlocks: number;
  lastFallbackReason?: SoundBridgeAudioNodeFallbackReason;
  staleOutputBlocks: number;
  droppedInputBlocks: number;
  underruns: number;
  sharedAudioEnabled: boolean;
  sharedInputQueuedBlocks: number;
  sharedInputQueuedMaxBlocks: number;
  sharedOutputQueuedBlocks: number;
  sharedOutputQueuedMaxBlocks: number;
  sharedInputDroppedBlocks: number;
  sharedOutputDroppedBlocks: number;
  sharedTransportInFlightBlocks: number;
  sharedInputBufferAllocations: number;
  sharedInputBufferReuses: number;
  sharedPooledInputBuffers: number;
  transportPressureEvents: number;
  consecutiveTransportPressureEvents: number;
  maxConsecutiveTransportPressureEvents: number;
  transportPressureAutoBypassed: boolean;
  transportPressureAutoBypassReasons?: SoundBridgeAudioNodeTransportPressureReason[];
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
  unhealthyReason?: "audio-error" | "process-timeout" | "render-budget-exceeded" | "transport-pressure" | "destroyed";
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
  fallbackOutputBlocks?: number;
  droppedInputBlocks?: number;
  staleOutputBlocks?: number;
  sharedInputQueuedBlocks?: number;
  sharedInputQueuedMaxBlocks?: number;
  sharedOutputQueuedBlocks?: number;
  sharedOutputQueuedMaxBlocks?: number;
  sharedInputDroppedBlocks?: number;
  sharedOutputDroppedBlocks?: number;
  sharedInputBufferAllocations?: number;
  responseDeadlineMisses?: number;
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
  observedSharedQueueMaxBlocks?: number;
  observedSharedInputBufferAllocations?: number;
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

export interface LivePerformanceAudioNodeCalibrationHealthSample {
  lastRenderDurationMs?: number;
  responseJitterBlocks?: number;
  responseDeadlineLeadSamples?: number;
  underruns?: number;
  fallbackOutputBlocks?: number;
  droppedInputBlocks?: number;
  staleOutputBlocks?: number;
  sharedInputQueuedBlocks?: number;
  sharedInputQueuedMaxBlocks?: number;
  sharedOutputQueuedBlocks?: number;
  sharedOutputQueuedMaxBlocks?: number;
  sharedInputDroppedBlocks?: number;
  sharedOutputDroppedBlocks?: number;
  sharedInputBufferAllocations?: number;
  responseDeadlineMisses?: number;
}

export interface LivePerformanceAudioNodeCalibrationWindowOptions extends LivePerformanceAudioNodePolicyOptions {
  maxSamples?: number;
  safetyMarginBlocks?: number;
}

export interface LivePerformanceAudioNodeCalibrationWindowSnapshot {
  samples: number;
  droppedSamples: number;
  calibration: LivePerformanceAudioNodeCalibration;
  recommendedOptions: SoundBridgeAudioNodeOptions;
}

export interface LivePerformanceAudioNodeLatencyRefresher<T = unknown> {
  refreshLatency(transportLatencySamples?: number): Promise<T>;
}

interface LivePerformanceAudioNodeCalibrationPressureCounters {
  underruns: number;
  fallbackOutputBlocks: number;
  droppedInputBlocks: number;
  staleOutputBlocks: number;
  sharedInputDroppedBlocks: number;
  sharedOutputDroppedBlocks: number;
  sharedInputBufferAllocations: number;
  responseDeadlineMisses: number;
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
    transportPressureAutoBypassReasons: boundedAudioNodeTransportPressureReasons(options.transportPressureAutoBypassReasons),
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
  const observedSharedQueueMaxBlocks = audioNodeSharedQueueMaxBlocks(options);
  const observedSharedInputBufferAllocations = boundedInteger(options.sharedInputBufferAllocations, 0, 0, Number.MAX_SAFE_INTEGER);
  const currentLatencyBlocks = audioNodeLatencyBlocks(policy.transportLatencySamples, policy.maxBlockFrames);
  const hasDropPressure = audioNodeDropPressure(options);
  const hasResponseDeadlineMisses = boundedInteger(options.responseDeadlineMisses, 0, 0, Number.MAX_SAFE_INTEGER) > 0;
  const pressureBlocks =
    Math.ceil((observedResponseJitterP95Blocks ?? 0) + Math.max(0, -(observedDeadlineLeadMinBlocks ?? 0)) + safetyBlocks) +
    (hasDropPressure ? 1 : 0) +
    (hasResponseDeadlineMisses ? 1 : 0);
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
    Math.max(
      policy.sharedBufferBlocks + (observedSharedInputBufferAllocations > 0 ? Math.max(1, safetyBlocks) : 0),
      policy.maxInFlightBlocks + recommendedMaxOutputLatencyBlocks,
      (observedSharedQueueMaxBlocks ?? 0) + safetyBlocks + 1
    ),
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
    observedSharedQueueMaxBlocks,
    observedSharedInputBufferAllocations,
    recommendedOutputLatencyBlocks,
    recommendedMaxOutputLatencyBlocks,
    recommendedSharedBufferBlocks,
    recommendedAudioRequestTimeoutMs,
    currentLatencyBlocks,
    hasDropPressure,
    hasResponseDeadlineMisses
  });
  return {
    policy,
    observedRenderP95Ms,
    observedResponseJitterP95Blocks,
    observedDeadlineLeadMinBlocks,
    observedSharedQueueMaxBlocks,
    observedSharedInputBufferAllocations,
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

export function boundedAudioNodeTransportPressureReasons(
  reasons: ArrayLike<SoundBridgeAudioNodeTransportPressureReason> | undefined
): SoundBridgeAudioNodeTransportPressureReason[] | undefined {
  if (reasons === undefined || reasons === null) return undefined;
  const values: SoundBridgeAudioNodeTransportPressureReason[] = [];
  const length = boundedInteger(reasons.length, 0, 0, 16);
  for (let index = 0; index < length; index += 1) {
    const reason = audioNodeTransportPressureReason(reasons[index]);
    if (reason !== undefined && !values.includes(reason)) values.push(reason);
  }
  return values;
}

export function shouldAutoBypassAudioNodeTransportPressure(
  reasons: ArrayLike<unknown>,
  autoBypassReasons?: ArrayLike<SoundBridgeAudioNodeTransportPressureReason>
): boolean {
  if (autoBypassReasons === undefined || autoBypassReasons === null) return true;
  const allowed = boundedAudioNodeTransportPressureReasons(autoBypassReasons) ?? [];
  const length = boundedInteger(reasons.length, 0, 0, 16);
  for (let index = 0; index < length; index += 1) {
    const reason = audioNodeTransportPressureReason(reasons[index]);
    if (reason !== undefined && allowed.includes(reason)) return true;
  }
  return false;
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
  return [options.underruns, options.fallbackOutputBlocks, options.droppedInputBlocks, options.staleOutputBlocks, options.sharedInputDroppedBlocks, options.sharedOutputDroppedBlocks]
    .some((value) => boundedInteger(value, 0, 0, Number.MAX_SAFE_INTEGER) > 0);
}

function audioNodeSharedQueueMaxBlocks(options: LivePerformanceAudioNodeCalibrationOptions): number | undefined {
  const inputQueued = boundedOptionalNumber(options.sharedInputQueuedMaxBlocks ?? options.sharedInputQueuedBlocks, 0, 64);
  const outputQueued = boundedOptionalNumber(options.sharedOutputQueuedMaxBlocks ?? options.sharedOutputQueuedBlocks, 0, 64);
  if (inputQueued === undefined && outputQueued === undefined) return undefined;
  return Math.max(boundedInteger(inputQueued, 0, 0, 64), boundedInteger(outputQueued, 0, 0, 64));
}

function audioNodeTransportPressureReason(reason: unknown): SoundBridgeAudioNodeTransportPressureReason | undefined {
  return reason === "deadline-miss" ||
    reason === "dropped-input" ||
    reason === "latency-safety" ||
    reason === "response-jitter" ||
    reason === "shared-input-drop" ||
    reason === "shared-output-drop" ||
    reason === "stale-output" ||
    reason === "underrun"
    ? reason
    : undefined;
}

function audioNodeCalibrationWarnings(calibration: {
  policy: LivePerformanceAudioNodePolicy;
  observedRenderP95Ms?: number;
  observedResponseJitterP95Blocks?: number;
  observedDeadlineLeadMinBlocks?: number;
  observedSharedQueueMaxBlocks?: number;
  observedSharedInputBufferAllocations?: number;
  recommendedOutputLatencyBlocks: number;
  recommendedMaxOutputLatencyBlocks: number;
  recommendedSharedBufferBlocks: number;
  recommendedAudioRequestTimeoutMs: number;
  currentLatencyBlocks: number;
  hasDropPressure: boolean;
  hasResponseDeadlineMisses: boolean;
}): string[] {
  const warnings: string[] = [];
  if (calibration.hasDropPressure) warnings.push("audio-drop-pressure");
  if ((calibration.observedDeadlineLeadMinBlocks ?? 0) < 0 || calibration.hasResponseDeadlineMisses) warnings.push("deadline-miss");
  if ((calibration.observedResponseJitterP95Blocks ?? 0) > calibration.policy.responseJitterThresholdBlocks) warnings.push("response-jitter");
  if ((calibration.observedSharedQueueMaxBlocks ?? 0) >= Math.max(1, calibration.policy.sharedBufferBlocks - 1)) warnings.push("shared-ring-pressure");
  if ((calibration.observedSharedInputBufferAllocations ?? 0) > 0) warnings.push("shared-buffer-allocation");
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

export class LivePerformanceAudioNodeCalibrationWindow {
  readonly options: LivePerformanceAudioNodeCalibrationWindowOptions;
  readonly maxSamples: number;
  private renderDurationsMs: number[] = [];
  private responseJitterBlocks: number[] = [];
  private deadlineLeadBlocks: number[] = [];
  private underruns = 0;
  private fallbackOutputBlocks = 0;
  private droppedInputBlocks = 0;
  private staleOutputBlocks = 0;
  private sharedInputDroppedBlocks = 0;
  private sharedOutputDroppedBlocks = 0;
  private sharedInputBufferAllocations = 0;
  private responseDeadlineMisses = 0;
  private sharedInputQueuedBlocks = 0;
  private sharedOutputQueuedBlocks = 0;
  private pressureBaseline?: LivePerformanceAudioNodeCalibrationPressureCounters;
  private droppedSamples = 0;

  constructor(options: LivePerformanceAudioNodeCalibrationWindowOptions) {
    this.options = { ...options };
    this.maxSamples = boundedInteger(options.maxSamples, LIVE_AUDIO_NODE_CALIBRATION_SAMPLES, 1, LIVE_AUDIO_NODE_CALIBRATION_SAMPLES);
  }

  record(health: LivePerformanceAudioNodeCalibrationHealthSample): LivePerformanceAudioNodeCalibrationWindowSnapshot {
    let accepted = false;
    let dropped = false;
    const renderDuration = boundedOptionalNumber(health.lastRenderDurationMs, 0, 60000);
    const responseJitter = boundedOptionalNumber(health.responseJitterBlocks, 0, 64);
    const deadlineLead = audioNodeDeadlineLeadBlocks(health.responseDeadlineLeadSamples, this.options.maxBlockFrames);
    if (renderDuration !== undefined) { dropped = this.append(this.renderDurationsMs, renderDuration) || dropped; accepted = true; }
    if (responseJitter !== undefined) { dropped = this.append(this.responseJitterBlocks, responseJitter) || dropped; accepted = true; }
    if (deadlineLead !== undefined) { dropped = this.append(this.deadlineLeadBlocks, deadlineLead) || dropped; accepted = true; }
    this.recordPressure(health);
    if (accepted && dropped) this.droppedSamples += 1;
    return this.snapshot();
  }

  reset(): void {
    this.renderDurationsMs = [];
    this.responseJitterBlocks = [];
    this.deadlineLeadBlocks = [];
    this.underruns = 0;
    this.fallbackOutputBlocks = 0;
    this.droppedInputBlocks = 0;
    this.staleOutputBlocks = 0;
    this.sharedInputDroppedBlocks = 0;
    this.sharedOutputDroppedBlocks = 0;
    this.sharedInputBufferAllocations = 0;
    this.responseDeadlineMisses = 0;
    this.sharedInputQueuedBlocks = 0;
    this.sharedOutputQueuedBlocks = 0;
    this.pressureBaseline = undefined;
    this.droppedSamples = 0;
  }

  snapshot(): LivePerformanceAudioNodeCalibrationWindowSnapshot {
    const calibration = this.calibrate();
    return {
      samples: this.samples,
      droppedSamples: this.droppedSamples,
      calibration,
      recommendedOptions: livePerformanceAudioNodeOptionsFromCalibration(calibration)
    };
  }

  calibrate(): LivePerformanceAudioNodeCalibration {
    return calibrateLivePerformanceAudioNodePolicy({
      ...this.options,
      renderDurationsMs: this.renderDurationsMs,
      responseJitterBlocks: this.responseJitterBlocks,
      deadlineLeadBlocks: this.deadlineLeadBlocks,
      underruns: this.underruns,
      fallbackOutputBlocks: this.fallbackOutputBlocks,
      droppedInputBlocks: this.droppedInputBlocks,
      staleOutputBlocks: this.staleOutputBlocks,
      sharedInputDroppedBlocks: this.sharedInputDroppedBlocks,
      sharedOutputDroppedBlocks: this.sharedOutputDroppedBlocks,
      sharedInputBufferAllocations: this.sharedInputBufferAllocations,
      responseDeadlineMisses: this.responseDeadlineMisses,
      sharedInputQueuedBlocks: this.sharedInputQueuedBlocks,
      sharedOutputQueuedBlocks: this.sharedOutputQueuedBlocks
    });
  }

  recommendedOptions(overrides: Partial<SoundBridgeAudioNodeOptions> = {}): SoundBridgeAudioNodeOptions {
    return livePerformanceAudioNodeOptionsFromCalibration(this.calibrate(), overrides);
  }

  private get samples(): number {
    return Math.max(this.renderDurationsMs.length, this.responseJitterBlocks.length, this.deadlineLeadBlocks.length);
  }

  private append(samples: number[], value: number): boolean {
    samples.push(value);
    if (samples.length <= this.maxSamples) return false;
    samples.splice(0, samples.length - this.maxSamples);
    return true;
  }

  private recordPressure(health: LivePerformanceAudioNodeCalibrationHealthSample): void {
    this.sharedInputQueuedBlocks = Math.max(this.sharedInputQueuedBlocks, boundedInteger(health.sharedInputQueuedMaxBlocks ?? health.sharedInputQueuedBlocks, 0, 0, 64));
    this.sharedOutputQueuedBlocks = Math.max(this.sharedOutputQueuedBlocks, boundedInteger(health.sharedOutputQueuedMaxBlocks ?? health.sharedOutputQueuedBlocks, 0, 0, 64));
    const counters = this.pressureCounters(health);
    if (this.pressureBaseline === undefined) {
      this.pressureBaseline = counters;
      return;
    }
    this.underruns = Math.max(this.underruns, pressureCounterDelta(counters.underruns, this.pressureBaseline.underruns));
    this.fallbackOutputBlocks = Math.max(this.fallbackOutputBlocks, pressureCounterDelta(counters.fallbackOutputBlocks, this.pressureBaseline.fallbackOutputBlocks));
    this.droppedInputBlocks = Math.max(this.droppedInputBlocks, pressureCounterDelta(counters.droppedInputBlocks, this.pressureBaseline.droppedInputBlocks));
    this.staleOutputBlocks = Math.max(this.staleOutputBlocks, pressureCounterDelta(counters.staleOutputBlocks, this.pressureBaseline.staleOutputBlocks));
    this.sharedInputDroppedBlocks = Math.max(this.sharedInputDroppedBlocks, pressureCounterDelta(counters.sharedInputDroppedBlocks, this.pressureBaseline.sharedInputDroppedBlocks));
    this.sharedOutputDroppedBlocks = Math.max(this.sharedOutputDroppedBlocks, pressureCounterDelta(counters.sharedOutputDroppedBlocks, this.pressureBaseline.sharedOutputDroppedBlocks));
    this.sharedInputBufferAllocations = Math.max(this.sharedInputBufferAllocations, pressureCounterDelta(counters.sharedInputBufferAllocations, this.pressureBaseline.sharedInputBufferAllocations));
    this.responseDeadlineMisses = Math.max(this.responseDeadlineMisses, pressureCounterDelta(counters.responseDeadlineMisses, this.pressureBaseline.responseDeadlineMisses));
  }

  private pressureCounters(health: LivePerformanceAudioNodeCalibrationHealthSample): LivePerformanceAudioNodeCalibrationPressureCounters {
    return {
      underruns: boundedInteger(health.underruns, 0, 0, Number.MAX_SAFE_INTEGER),
      fallbackOutputBlocks: boundedInteger(health.fallbackOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      droppedInputBlocks: boundedInteger(health.droppedInputBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      staleOutputBlocks: boundedInteger(health.staleOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      sharedInputDroppedBlocks: boundedInteger(health.sharedInputDroppedBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      sharedOutputDroppedBlocks: boundedInteger(health.sharedOutputDroppedBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      sharedInputBufferAllocations: boundedInteger(health.sharedInputBufferAllocations, 0, 0, Number.MAX_SAFE_INTEGER),
      responseDeadlineMisses: boundedInteger(health.responseDeadlineMisses, 0, 0, Number.MAX_SAFE_INTEGER)
    };
  }
}

export function createLivePerformanceAudioNodeCalibrationWindow(options: LivePerformanceAudioNodeCalibrationWindowOptions): LivePerformanceAudioNodeCalibrationWindow {
  return new LivePerformanceAudioNodeCalibrationWindow(options);
}

export function livePerformanceAudioNodeOptionsFromCalibration(
  calibration: LivePerformanceAudioNodeCalibration,
  overrides: Partial<SoundBridgeAudioNodeOptions> = {}
): SoundBridgeAudioNodeOptions {
  const recommended: SoundBridgeAudioNodeOptions = {
    ...calibration.policy.options,
    outputLatencyBlocks: calibration.recommendedOutputLatencyBlocks,
    maxOutputLatencyBlocks: calibration.recommendedMaxOutputLatencyBlocks,
    sharedBufferBlocks: calibration.recommendedSharedBufferBlocks,
    audioRequestTimeoutMs: calibration.recommendedAudioRequestTimeoutMs
  };
  return {
    ...recommended,
    ...overrides,
    outputLatencyBlocks: recommended.outputLatencyBlocks,
    maxOutputLatencyBlocks: recommended.maxOutputLatencyBlocks,
    sharedBufferBlocks: recommended.sharedBufferBlocks,
    audioRequestTimeoutMs: recommended.audioRequestTimeoutMs
  };
}

export function refreshLivePerformanceAudioNodeLatencyFromCalibration<T>(
  node: LivePerformanceAudioNodeLatencyRefresher<T>,
  calibration: LivePerformanceAudioNodeCalibration
): Promise<T> {
  return node.refreshLatency(calibration.recommendedTransportLatencySamples);
}

function audioNodeDeadlineLeadBlocks(responseDeadlineLeadSamples: unknown, maxBlockFrames: unknown): number | undefined {
  const leadSamples = boundedOptionalNumber(responseDeadlineLeadSamples, -1_048_576, 1_048_576);
  if (leadSamples === undefined) return undefined;
  return roundedAudioNodeNumber(leadSamples / boundedInteger(Number(maxBlockFrames), 128, 1, 8192));
}

function pressureCounterDelta(current: number, baseline: number): number {
  return current >= baseline ? current - baseline : current;
}
