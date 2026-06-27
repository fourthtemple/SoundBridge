import {
  boundedLatencySamples,
  boundedLiveEffectInteger,
  boundedLiveEffectNumber,
  combinedLatencySamples,
  liveEffectBlockDurationMs,
  liveEffectBlockFrames,
  liveEffectLatencyMilliseconds
} from "./live-effect-rack-metrics";

const LIVE_PERFORMANCE_INPUT_AGE_BLOCKS = 4;
const LIVE_PERFORMANCE_PROCESS_BUDGET_BLOCKS = 1;
const LIVE_PERFORMANCE_PROCESS_BUDGET_MISSES = 3;
const LIVE_PERFORMANCE_PROCESS_TIMEOUT_BLOCKS = 4;
const LIVE_PERFORMANCE_TRANSITION_FADE_BLOCKS = 0.5;
const LIVE_PERFORMANCE_RECOVERY_BLOCKS = 16;
const LIVE_PERFORMANCE_PROCESS_TIMEOUT_RECOVERIES = 1;
const LIVE_EFFECT_CALIBRATION_SAMPLES = 256;

export interface LiveEffectRackPolicyOptions {
  sampleRate: number;
  maxBlockSize: number;
  maxInputAgeMs?: number;
  maxInputAgeBlocks?: number;
  maxInFlightBlocks?: number;
  processBudgetMs?: number;
  processBudgetBlocks?: number;
  processTimeoutMs?: number;
  processTimeoutBlocks?: number;
  transitionFadeSamples?: number;
  transitionFadeBlocks?: number;
  maxConsecutiveProcessBudgetMisses?: number;
  maxConsecutiveRenderBudgetMisses?: number;
  processBudgetRecoveryBlocks?: number;
  renderBudgetRecoveryBlocks?: number;
  processTimeoutRecoveryBlocks?: number;
  maxProcessTimeoutRecoveries?: number;
  pluginLatencySamples?: number;
  transportLatencySamples?: number;
}

export interface LiveEffectRackCalibrationOptions extends LiveEffectRackPolicyOptions {
  processDurationsMs?: ArrayLike<number>;
  renderDurationsMs?: ArrayLike<number>;
  responseJitterBlocks?: ArrayLike<number>;
  deadlineLeadBlocks?: ArrayLike<number>;
  droppedInputBlocks?: number;
  staleInputBlocks?: number;
  staleOutputBlocks?: number;
  dryOutputBlocks?: number;
  responseDeadlineMisses?: number;
  renderTimeouts?: number;
  safetyMarginBlocks?: number;
}

export interface LiveEffectRackPolicy {
  sampleRate: number;
  maxBlockSize: number;
  blockDurationMs: number;
  maxInputAgeMs: number;
  maxInputAgeBlocks: number;
  maxInFlightBlocks: number;
  processBudgetMs: number;
  processBudgetBlocks: number;
  processTimeoutMs: number;
  processTimeoutBlocks: number;
  transitionFadeSamples: number;
  transitionFadeBlocks: number;
  maxConsecutiveProcessBudgetMisses: number;
  maxConsecutiveRenderBudgetMisses: number;
  processBudgetRecoveryBlocks: number;
  renderBudgetRecoveryBlocks: number;
  processTimeoutRecoveryBlocks: number;
  maxProcessTimeoutRecoveries: number;
  pluginLatencySamples: number;
  transportLatencySamples: number;
  reportedLatencySamples: number;
  reportedLatencyMs: number;
}

export interface LiveEffectRackCalibration {
  policy: LiveEffectRackPolicy;
  observedProcessP95Ms?: number;
  observedRenderP95Ms?: number;
  observedResponseJitterP95Blocks?: number;
  observedDeadlineLeadMinBlocks?: number;
  recommendedProcessBudgetMs: number;
  recommendedProcessTimeoutMs: number;
  recommendedTransportLatencyBlocks: number;
  recommendedTransportLatencySamples: number;
  recommendedReportedLatencySamples: number;
  recommendedReportedLatencyMs: number;
  realtimeReady: boolean;
  warnings: string[];
}

export function createLiveEffectRackPolicy(options: LiveEffectRackPolicyOptions): LiveEffectRackPolicy {
  const sampleRate = boundedLiveEffectInteger(options.sampleRate, 48000, 1, 384000);
  const maxBlockSize = liveEffectBlockFrames(options.maxBlockSize);
  const blockDurationMs = liveEffectBlockDurationMs(sampleRate, maxBlockSize);
  const maxInputAgeBlocks = boundedLiveEffectNumber(options.maxInputAgeBlocks, LIVE_PERFORMANCE_INPUT_AGE_BLOCKS, 0, 128);
  const processBudgetBlocks = boundedLiveEffectNumber(options.processBudgetBlocks, LIVE_PERFORMANCE_PROCESS_BUDGET_BLOCKS, 0, 128);
  const processTimeoutBlocks = boundedLiveEffectNumber(options.processTimeoutBlocks, LIVE_PERFORMANCE_PROCESS_TIMEOUT_BLOCKS, 0, 128);
  const transitionFadeBlocks = boundedLiveEffectNumber(options.transitionFadeBlocks, LIVE_PERFORMANCE_TRANSITION_FADE_BLOCKS, 0, 8);
  const maxInputAgeMs = boundedLiveEffectNumber(options.maxInputAgeMs, blockDurationMs * maxInputAgeBlocks, 0, 60000);
  const processBudgetMs = boundedLiveEffectNumber(options.processBudgetMs, blockDurationMs * processBudgetBlocks, 0, 60000);
  const processTimeoutMs = boundedLiveEffectNumber(options.processTimeoutMs, blockDurationMs * processTimeoutBlocks, 0, 60000);
  const transitionFadeSamples = boundedLiveEffectInteger(options.transitionFadeSamples, Math.ceil(maxBlockSize * transitionFadeBlocks), 0, 4096);
  const pluginLatencySamples = boundedLatencySamples(options.pluginLatencySamples, 0);
  const transportLatencySamples = boundedLatencySamples(options.transportLatencySamples, 0);
  const reportedLatencySamples = combinedLatencySamples(pluginLatencySamples, transportLatencySamples);
  return {
    sampleRate,
    maxBlockSize,
    blockDurationMs: Number(blockDurationMs.toFixed(3)),
    maxInputAgeMs,
    maxInputAgeBlocks: liveEffectPolicyBlockUnits(maxInputAgeMs, blockDurationMs),
    maxInFlightBlocks: boundedLiveEffectInteger(options.maxInFlightBlocks, 1, 1, 32),
    processBudgetMs,
    processBudgetBlocks: liveEffectPolicyBlockUnits(processBudgetMs, blockDurationMs),
    processTimeoutMs,
    processTimeoutBlocks: liveEffectPolicyBlockUnits(processTimeoutMs, blockDurationMs),
    transitionFadeSamples,
    transitionFadeBlocks: liveEffectPolicyBlockUnits(transitionFadeSamples, maxBlockSize),
    maxConsecutiveProcessBudgetMisses: boundedLiveEffectInteger(options.maxConsecutiveProcessBudgetMisses, LIVE_PERFORMANCE_PROCESS_BUDGET_MISSES, 0, 1024),
    maxConsecutiveRenderBudgetMisses: boundedLiveEffectInteger(options.maxConsecutiveRenderBudgetMisses, 2, 0, 1024),
    processBudgetRecoveryBlocks: boundedLiveEffectInteger(options.processBudgetRecoveryBlocks, LIVE_PERFORMANCE_RECOVERY_BLOCKS, 0, 4096),
    renderBudgetRecoveryBlocks: boundedLiveEffectInteger(options.renderBudgetRecoveryBlocks, LIVE_PERFORMANCE_RECOVERY_BLOCKS, 0, 4096),
    processTimeoutRecoveryBlocks: boundedLiveEffectInteger(options.processTimeoutRecoveryBlocks, LIVE_PERFORMANCE_RECOVERY_BLOCKS, 0, 4096),
    maxProcessTimeoutRecoveries: boundedLiveEffectInteger(options.maxProcessTimeoutRecoveries, LIVE_PERFORMANCE_PROCESS_TIMEOUT_RECOVERIES, 0, 32),
    pluginLatencySamples,
    transportLatencySamples,
    reportedLatencySamples,
    reportedLatencyMs: liveEffectLatencyMilliseconds(reportedLatencySamples, sampleRate)
  };
}

export function calibrateLiveEffectRackPolicy(options: LiveEffectRackCalibrationOptions): LiveEffectRackCalibration {
  const policy = createLiveEffectRackPolicy(options);
  const safetyBlocks = boundedLiveEffectNumber(options.safetyMarginBlocks, 1, 0, 8);
  const safetyMs = policy.blockDurationMs * safetyBlocks;
  const observedProcessP95Ms = percentileSample(options.processDurationsMs, 0, 60000);
  const observedRenderP95Ms = percentileSample(options.renderDurationsMs, 0, 60000);
  const observedResponseJitterP95Blocks = percentileSample(options.responseJitterBlocks, 0, 64);
  const observedDeadlineLeadMinBlocks = minimumSample(options.deadlineLeadBlocks, -64, 64);
  const hasDryOutputPressure = liveEffectDropPressure(options);
  const hasResponseDeadlineMisses = boundedCalibrationCounter(options.responseDeadlineMisses) > 0;
  const hasRenderTimeouts = boundedCalibrationCounter(options.renderTimeouts) > 0;
  const currentLatencyBlocks = liveEffectPolicyBlockUnits(policy.transportLatencySamples, policy.maxBlockSize);
  const dryPressureLatencyBlocks = hasDryOutputPressure ? 1 : 0;
  const jitterLatencyBlocks = Math.ceil(
    (observedResponseJitterP95Blocks ?? 0) +
      Math.max(0, -(observedDeadlineLeadMinBlocks ?? 0)) +
      safetyBlocks
  ) + dryPressureLatencyBlocks;
  const recommendedTransportLatencyBlocks = boundedLiveEffectInteger(
    Math.max(currentLatencyBlocks, jitterLatencyBlocks),
    currentLatencyBlocks,
    0,
    128
  );
  const recommendedTransportLatencySamples = boundedLatencySamples(
    recommendedTransportLatencyBlocks * policy.maxBlockSize,
    policy.transportLatencySamples
  );
  const observedBudgetWithSafetyMs = Math.max(observedProcessP95Ms ?? 0, observedRenderP95Ms ?? 0) + safetyMs;
  const recommendedProcessBudgetMs = roundedPolicyNumber(
    boundedLiveEffectNumber(
      Math.max(policy.processBudgetMs, observedBudgetWithSafetyMs),
      policy.processBudgetMs,
      0,
      60000
    )
  );
  const recommendedProcessTimeoutMs = roundedPolicyNumber(
    boundedLiveEffectNumber(
      Math.max(policy.processTimeoutMs, recommendedProcessBudgetMs + safetyMs),
      policy.processTimeoutMs,
      0,
      60000
    )
  );
  const recommendedReportedLatencySamples = combinedLatencySamples(policy.pluginLatencySamples, recommendedTransportLatencySamples);
  const warnings = liveEffectCalibrationWarnings({
    policy,
    observedProcessP95Ms,
    observedRenderP95Ms,
    observedResponseJitterP95Blocks,
    observedDeadlineLeadMinBlocks,
    recommendedProcessBudgetMs,
    recommendedProcessTimeoutMs,
    recommendedTransportLatencyBlocks,
    currentLatencyBlocks,
    hasDryOutputPressure,
    hasResponseDeadlineMisses,
    hasRenderTimeouts
  });
  return {
    policy,
    observedProcessP95Ms,
    observedRenderP95Ms,
    observedResponseJitterP95Blocks,
    observedDeadlineLeadMinBlocks,
    recommendedProcessBudgetMs,
    recommendedProcessTimeoutMs,
    recommendedTransportLatencyBlocks,
    recommendedTransportLatencySamples,
    recommendedReportedLatencySamples,
    recommendedReportedLatencyMs: liveEffectLatencyMilliseconds(recommendedReportedLatencySamples, policy.sampleRate),
    realtimeReady: warnings.length === 0,
    warnings
  };
}

function liveEffectPolicyBlockUnits(value: number, blockValue: number): number {
  return blockValue > 0 ? Number((value / blockValue).toFixed(3)) : 0;
}

function percentileSample(samples: ArrayLike<number> | undefined, min: number, max: number): number | undefined {
  const values = boundedSamples(samples, min, max);
  if (values.length === 0) return undefined;
  values.sort((left, right) => left - right);
  return roundedPolicyNumber(values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] ?? 0);
}

function minimumSample(samples: ArrayLike<number> | undefined, min: number, max: number): number | undefined {
  const values = boundedSamples(samples, min, max);
  return values.length > 0 ? roundedPolicyNumber(Math.min(...values)) : undefined;
}

function boundedSamples(samples: ArrayLike<number> | undefined, min: number, max: number): number[] {
  const length = boundedLiveEffectInteger(samples?.length, 0, 0, LIVE_EFFECT_CALIBRATION_SAMPLES);
  const values: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const sample = Number(samples?.[index]);
    if (Number.isFinite(sample)) values.push(Math.max(min, Math.min(max, sample)));
  }
  return values;
}

function liveEffectCalibrationWarnings(calibration: {
  policy: LiveEffectRackPolicy;
  observedProcessP95Ms?: number;
  observedRenderP95Ms?: number;
  observedResponseJitterP95Blocks?: number;
  observedDeadlineLeadMinBlocks?: number;
  recommendedProcessBudgetMs: number;
  recommendedProcessTimeoutMs: number;
  recommendedTransportLatencyBlocks: number;
  currentLatencyBlocks: number;
  hasDryOutputPressure: boolean;
  hasResponseDeadlineMisses: boolean;
  hasRenderTimeouts: boolean;
}): string[] {
  const warnings: string[] = [];
  if (calibration.hasDryOutputPressure) warnings.push("dry-output-pressure");
  if (exceedsPolicy(calibration.observedProcessP95Ms ?? 0, calibration.policy.processBudgetMs)) warnings.push("process-over-budget");
  if (exceedsPolicy(calibration.observedRenderP95Ms ?? 0, calibration.policy.blockDurationMs)) warnings.push("render-over-block-budget");
  if ((calibration.observedDeadlineLeadMinBlocks ?? 0) < 0 || calibration.hasResponseDeadlineMisses) warnings.push("deadline-miss");
  if (calibration.hasRenderTimeouts) warnings.push("process-timeout");
  if ((calibration.observedResponseJitterP95Blocks ?? 0) > calibration.currentLatencyBlocks) warnings.push("response-jitter");
  if (exceedsPolicy(calibration.recommendedProcessBudgetMs, calibration.policy.processBudgetMs)) warnings.push("increase-process-budget");
  if (exceedsPolicy(calibration.recommendedProcessTimeoutMs, calibration.policy.processTimeoutMs)) warnings.push("increase-process-timeout");
  if (calibration.recommendedTransportLatencyBlocks > calibration.currentLatencyBlocks) warnings.push("increase-transport-latency");
  return Array.from(new Set(warnings));
}

function roundedPolicyNumber(value: number): number {
  return Number(value.toFixed(3));
}

function exceedsPolicy(value: number, policyValue: number): boolean {
  return value - policyValue > 0.001;
}

function liveEffectDropPressure(options: LiveEffectRackCalibrationOptions): boolean {
  return [options.droppedInputBlocks, options.staleInputBlocks, options.staleOutputBlocks, options.dryOutputBlocks]
    .some((value) => boundedCalibrationCounter(value) > 0);
}

function boundedCalibrationCounter(value: unknown): number {
  return boundedLiveEffectInteger(value, 0, 0, Number.MAX_SAFE_INTEGER);
}
