import { boundedLiveEffectInteger, boundedOptionalNumber } from "./live-effect-rack-metrics";
import { calibrateLiveEffectRackPolicy } from "./live-effect-rack-policy";
import type {
  LiveEffectRackCalibration,
  LiveEffectRackCalibrationOptions,
  LiveEffectRackPolicyOptions
} from "./live-effect-rack-policy";

const LIVE_EFFECT_CALIBRATION_WINDOW_SAMPLES = 256;

export interface LiveEffectRackCalibrationHealthSample {
  lastProcessDurationMs?: number;
  lastRenderDurationMs?: number;
  responseJitterBlocks?: number;
  lastResponseDeadlineLeadBlocks?: number;
}

export interface LiveEffectRackCalibrationWindowOptions extends LiveEffectRackPolicyOptions {
  maxSamples?: number;
  safetyMarginBlocks?: number;
}

export interface LiveEffectRackCalibrationWindowSnapshot {
  samples: number;
  droppedSamples: number;
  calibration: LiveEffectRackCalibration;
  recommendedPolicyOptions: LiveEffectRackPolicyOptions;
}

export interface LiveEffectRackLatencyRefresher<T = unknown> {
  refreshLatency(transportLatencySamples?: number): Promise<T>;
}

export class LiveEffectRackCalibrationWindow {
  readonly options: LiveEffectRackCalibrationWindowOptions;
  readonly maxSamples: number;
  private processDurationsMs: number[] = [];
  private renderDurationsMs: number[] = [];
  private responseJitterBlocks: number[] = [];
  private deadlineLeadBlocks: number[] = [];
  private droppedSamples = 0;

  constructor(options: LiveEffectRackCalibrationWindowOptions) {
    this.options = { ...options };
    this.maxSamples = boundedLiveEffectInteger(options.maxSamples, LIVE_EFFECT_CALIBRATION_WINDOW_SAMPLES, 1, LIVE_EFFECT_CALIBRATION_WINDOW_SAMPLES);
  }

  record(health: LiveEffectRackCalibrationHealthSample): LiveEffectRackCalibrationWindowSnapshot {
    let accepted = false;
    let dropped = false;
    const processDuration = boundedOptionalNumber(health.lastProcessDurationMs, 0, 60000);
    const renderDuration = boundedOptionalNumber(health.lastRenderDurationMs, 0, 60000);
    const responseJitter = boundedOptionalNumber(health.responseJitterBlocks, 0, 64);
    const deadlineLead = boundedOptionalNumber(health.lastResponseDeadlineLeadBlocks, -64, 64);
    if (processDuration !== undefined) { dropped = this.append(this.processDurationsMs, processDuration) || dropped; accepted = true; }
    if (renderDuration !== undefined) { dropped = this.append(this.renderDurationsMs, renderDuration) || dropped; accepted = true; }
    if (responseJitter !== undefined) { dropped = this.append(this.responseJitterBlocks, responseJitter) || dropped; accepted = true; }
    if (deadlineLead !== undefined) { dropped = this.append(this.deadlineLeadBlocks, deadlineLead) || dropped; accepted = true; }
    if (accepted && dropped) this.droppedSamples += 1;
    return this.snapshot();
  }

  reset(): void {
    this.processDurationsMs = [];
    this.renderDurationsMs = [];
    this.responseJitterBlocks = [];
    this.deadlineLeadBlocks = [];
    this.droppedSamples = 0;
  }

  snapshot(): LiveEffectRackCalibrationWindowSnapshot {
    const calibration = this.calibrate();
    return {
      samples: this.samples,
      droppedSamples: this.droppedSamples,
      calibration,
      recommendedPolicyOptions: liveEffectRackPolicyOptionsFromCalibration(calibration)
    };
  }

  calibrate(): LiveEffectRackCalibration {
    const options: LiveEffectRackCalibrationOptions = {
      ...this.options,
      processDurationsMs: this.processDurationsMs,
      renderDurationsMs: this.renderDurationsMs,
      responseJitterBlocks: this.responseJitterBlocks,
      deadlineLeadBlocks: this.deadlineLeadBlocks
    };
    return calibrateLiveEffectRackPolicy(options);
  }

  recommendedPolicyOptions(overrides: Partial<LiveEffectRackPolicyOptions> = {}): LiveEffectRackPolicyOptions {
    return liveEffectRackPolicyOptionsFromCalibration(this.calibrate(), overrides);
  }

  private get samples(): number {
    return Math.max(this.processDurationsMs.length, this.renderDurationsMs.length, this.responseJitterBlocks.length, this.deadlineLeadBlocks.length);
  }

  private append(samples: number[], value: number): boolean {
    samples.push(value);
    if (samples.length <= this.maxSamples) return false;
    samples.splice(0, samples.length - this.maxSamples);
    return true;
  }
}

export function createLiveEffectRackCalibrationWindow(options: LiveEffectRackCalibrationWindowOptions): LiveEffectRackCalibrationWindow {
  return new LiveEffectRackCalibrationWindow(options);
}

export function liveEffectRackPolicyOptionsFromCalibration(
  calibration: LiveEffectRackCalibration,
  overrides: Partial<LiveEffectRackPolicyOptions> = {}
): LiveEffectRackPolicyOptions {
  const policy = calibration.policy;
  const recommended: LiveEffectRackPolicyOptions = {
    sampleRate: policy.sampleRate,
    maxBlockSize: policy.maxBlockSize,
    maxInputAgeMs: policy.maxInputAgeMs,
    maxInFlightBlocks: policy.maxInFlightBlocks,
    transitionFadeSamples: policy.transitionFadeSamples,
    maxConsecutiveProcessBudgetMisses: policy.maxConsecutiveProcessBudgetMisses,
    maxConsecutiveRenderBudgetMisses: policy.maxConsecutiveRenderBudgetMisses,
    processBudgetRecoveryBlocks: policy.processBudgetRecoveryBlocks,
    renderBudgetRecoveryBlocks: policy.renderBudgetRecoveryBlocks,
    processTimeoutRecoveryBlocks: policy.processTimeoutRecoveryBlocks,
    maxProcessTimeoutRecoveries: policy.maxProcessTimeoutRecoveries,
    processBudgetMs: calibration.recommendedProcessBudgetMs,
    processTimeoutMs: calibration.recommendedProcessTimeoutMs,
    pluginLatencySamples: policy.pluginLatencySamples,
    transportLatencySamples: calibration.recommendedTransportLatencySamples
  };
  return {
    ...recommended,
    ...overrides,
    sampleRate: recommended.sampleRate,
    maxBlockSize: recommended.maxBlockSize,
    processBudgetMs: recommended.processBudgetMs,
    processTimeoutMs: recommended.processTimeoutMs,
    pluginLatencySamples: recommended.pluginLatencySamples,
    transportLatencySamples: recommended.transportLatencySamples
  };
}

export function refreshLiveEffectRackLatencyFromCalibration<T>(
  rack: LiveEffectRackLatencyRefresher<T>,
  calibration: LiveEffectRackCalibration
): Promise<T> {
  return rack.refreshLatency(calibration.recommendedTransportLatencySamples);
}
