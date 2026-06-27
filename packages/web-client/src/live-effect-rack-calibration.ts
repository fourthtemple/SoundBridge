import { boundedLiveEffectInteger, boundedOptionalNumber } from "./live-effect-rack-metrics";
import { calibrateLiveEffectRackPolicy } from "./live-effect-rack-policy";
import type {
  LiveEffectRackCalibration,
  LiveEffectRackCalibrationOptions,
  LiveEffectRackPolicyOptions
} from "./live-effect-rack-policy";
import type { LiveEffectRackChainHealth } from "./live-effect-rack-chain";
import type { LiveEffectRackFrameBatchHealth } from "./live-effect-rack-frame-batch";

const LIVE_EFFECT_CALIBRATION_WINDOW_SAMPLES = 256;

export interface LiveEffectRackCalibrationHealthSample {
  lastProcessDurationMs?: number;
  lastRenderDurationMs?: number;
  responseJitterBlocks?: number;
  lastResponseDeadlineLeadBlocks?: number;
  latencySamples?: number;
  pluginLatencySamples?: number;
  dryOutputBlocks?: number;
  droppedInputBlocks?: number;
  staleInputBlocks?: number;
  staleOutputBlocks?: number;
  responseDeadlineMisses?: number;
  renderTimeouts?: number;
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

interface LiveEffectRackCalibrationPressureCounters {
  droppedInputBlocks: number;
  staleInputBlocks: number;
  staleOutputBlocks: number;
  dryOutputBlocks: number;
  responseDeadlineMisses: number;
  renderTimeouts: number;
}

export interface LiveEffectRackChainCalibrationHealthSample
  extends Pick<
    LiveEffectRackChainHealth,
    "lastProcessDurationMs" | "latencySamples" | "lastResponseDeadlineLeadBlocks" | "responseJitterBlocks" | "responseDeadlineMisses"
  > {
  dryOutputBlocks?: unknown;
  bypassDryOutputBlocks?: unknown;
  lastDryReason?: unknown;
}

export interface LiveEffectRackFrameBatchCalibrationHealthSample
  extends Pick<
    LiveEffectRackFrameBatchHealth,
    | "maxDurationMs"
    | "totalDurationMs"
    | "latencySamples"
    | "reportedLatencySamples"
    | "lastResponseDeadlineLeadBlocks"
    | "responseJitterBlocks"
    | "responseDeadlineMisses"
  > {
  dryTargets?: unknown;
  bypassedTargets?: unknown;
  skippedTargets?: unknown;
  failedTargets?: unknown;
  processBudgetTripped?: unknown;
  processTimedOut?: unknown;
  processTimeoutTripped?: unknown;
}

export class LiveEffectRackCalibrationWindow {
  readonly options: LiveEffectRackCalibrationWindowOptions;
  readonly maxSamples: number;
  private processDurationsMs: number[] = [];
  private renderDurationsMs: number[] = [];
  private responseJitterBlocks: number[] = [];
  private deadlineLeadBlocks: number[] = [];
  private droppedInputBlocks = 0;
  private staleInputBlocks = 0;
  private staleOutputBlocks = 0;
  private dryOutputBlocks = 0;
  private responseDeadlineMisses = 0;
  private renderTimeouts = 0;
  private pressureBaseline?: LiveEffectRackCalibrationPressureCounters;
  private pluginLatencySamples?: number;
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
    this.recordLatency(health);
    if (processDuration !== undefined) { dropped = this.append(this.processDurationsMs, processDuration) || dropped; accepted = true; }
    if (renderDuration !== undefined) { dropped = this.append(this.renderDurationsMs, renderDuration) || dropped; accepted = true; }
    if (responseJitter !== undefined) { dropped = this.append(this.responseJitterBlocks, responseJitter) || dropped; accepted = true; }
    if (deadlineLead !== undefined) { dropped = this.append(this.deadlineLeadBlocks, deadlineLead) || dropped; accepted = true; }
    this.recordPressure(health);
    if (accepted && dropped) this.droppedSamples += 1;
    return this.snapshot();
  }

  reset(): void {
    this.processDurationsMs = [];
    this.renderDurationsMs = [];
    this.responseJitterBlocks = [];
    this.deadlineLeadBlocks = [];
    this.droppedInputBlocks = 0;
    this.staleInputBlocks = 0;
    this.staleOutputBlocks = 0;
    this.dryOutputBlocks = 0;
    this.responseDeadlineMisses = 0;
    this.renderTimeouts = 0;
    this.pressureBaseline = undefined;
    this.pluginLatencySamples = undefined;
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
      pluginLatencySamples: this.pluginLatencySamples ?? this.options.pluginLatencySamples,
      processDurationsMs: this.processDurationsMs,
      renderDurationsMs: this.renderDurationsMs,
      responseJitterBlocks: this.responseJitterBlocks,
      deadlineLeadBlocks: this.deadlineLeadBlocks,
      droppedInputBlocks: this.droppedInputBlocks,
      staleInputBlocks: this.staleInputBlocks,
      staleOutputBlocks: this.staleOutputBlocks,
      dryOutputBlocks: this.dryOutputBlocks,
      responseDeadlineMisses: this.responseDeadlineMisses,
      renderTimeouts: this.renderTimeouts
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

  private recordPressure(health: LiveEffectRackCalibrationHealthSample): void {
    const counters = this.pressureCounters(health);
    if (this.pressureBaseline === undefined) {
      this.pressureBaseline = counters;
      return;
    }
    this.droppedInputBlocks = Math.max(this.droppedInputBlocks, pressureCounterDelta(counters.droppedInputBlocks, this.pressureBaseline.droppedInputBlocks));
    this.staleInputBlocks = Math.max(this.staleInputBlocks, pressureCounterDelta(counters.staleInputBlocks, this.pressureBaseline.staleInputBlocks));
    this.staleOutputBlocks = Math.max(this.staleOutputBlocks, pressureCounterDelta(counters.staleOutputBlocks, this.pressureBaseline.staleOutputBlocks));
    this.dryOutputBlocks = Math.max(this.dryOutputBlocks, pressureCounterDelta(counters.dryOutputBlocks, this.pressureBaseline.dryOutputBlocks));
    this.responseDeadlineMisses = Math.max(this.responseDeadlineMisses, pressureCounterDelta(counters.responseDeadlineMisses, this.pressureBaseline.responseDeadlineMisses));
    this.renderTimeouts = Math.max(this.renderTimeouts, pressureCounterDelta(counters.renderTimeouts, this.pressureBaseline.renderTimeouts));
  }

  private recordLatency(health: LiveEffectRackCalibrationHealthSample): void {
    const pluginLatencySamples = boundedOptionalNumber(
      health.pluginLatencySamples ?? health.latencySamples,
      0,
      Number.MAX_SAFE_INTEGER
    );
    if (pluginLatencySamples !== undefined) {
      this.pluginLatencySamples = Math.floor(pluginLatencySamples);
    }
  }

  private pressureCounters(health: LiveEffectRackCalibrationHealthSample): LiveEffectRackCalibrationPressureCounters {
    return {
      droppedInputBlocks: boundedLiveEffectInteger(health.droppedInputBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      staleInputBlocks: boundedLiveEffectInteger(health.staleInputBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      staleOutputBlocks: boundedLiveEffectInteger(health.staleOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      dryOutputBlocks: boundedLiveEffectInteger(health.dryOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      responseDeadlineMisses: boundedLiveEffectInteger(health.responseDeadlineMisses, 0, 0, Number.MAX_SAFE_INTEGER),
      renderTimeouts: boundedLiveEffectInteger(health.renderTimeouts, 0, 0, Number.MAX_SAFE_INTEGER)
    };
  }
}

export class LiveEffectRackChainCalibrationWindow {
  private readonly window: LiveEffectRackCalibrationWindow;
  private dryOutputBlocks = 0;
  private bypassDryOutputBlocks = 0;

  constructor(options: LiveEffectRackCalibrationWindowOptions) {
    this.window = new LiveEffectRackCalibrationWindow(options);
  }

  get maxSamples(): number {
    return this.window.maxSamples;
  }

  record(health: LiveEffectRackChainCalibrationHealthSample): LiveEffectRackCalibrationWindowSnapshot {
    if (health.dryOutputBlocks !== undefined) {
      this.dryOutputBlocks = boundedLiveEffectInteger(health.dryOutputBlocks, this.dryOutputBlocks, 0, Number.MAX_SAFE_INTEGER);
      this.bypassDryOutputBlocks = boundedLiveEffectInteger(health.bypassDryOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER);
    } else if (health.lastDryReason !== undefined) {
      this.dryOutputBlocks = Math.min(Number.MAX_SAFE_INTEGER, this.dryOutputBlocks + 1);
      if (isChainBypassDryReason(health.lastDryReason)) this.bypassDryOutputBlocks = Math.min(Number.MAX_SAFE_INTEGER, this.bypassDryOutputBlocks + 1);
    }
    const pressureDryOutputBlocks = Math.max(0, this.dryOutputBlocks - Math.min(this.bypassDryOutputBlocks, this.dryOutputBlocks));
    return this.window.record({
      lastProcessDurationMs: health.lastProcessDurationMs,
      responseJitterBlocks: health.responseJitterBlocks,
      lastResponseDeadlineLeadBlocks: health.lastResponseDeadlineLeadBlocks,
      latencySamples: health.latencySamples,
      dryOutputBlocks: pressureDryOutputBlocks,
      responseDeadlineMisses: health.responseDeadlineMisses
    });
  }

  reset(): void {
    this.dryOutputBlocks = 0;
    this.bypassDryOutputBlocks = 0;
    this.window.reset();
  }

  snapshot(): LiveEffectRackCalibrationWindowSnapshot {
    return this.window.snapshot();
  }

  calibrate(): LiveEffectRackCalibration {
    return this.window.calibrate();
  }

  recommendedPolicyOptions(overrides: Partial<LiveEffectRackPolicyOptions> = {}): LiveEffectRackPolicyOptions {
    return this.window.recommendedPolicyOptions(overrides);
  }
}

function isChainBypassDryReason(reason: unknown): boolean {
  return reason === "chain-bypass" || reason === "chain-stage-bypass";
}

export class LiveEffectRackFrameBatchCalibrationWindow {
  private readonly window: LiveEffectRackCalibrationWindow;
  private dryOutputBlocks = 0;

  constructor(options: LiveEffectRackCalibrationWindowOptions) {
    this.window = new LiveEffectRackCalibrationWindow(options);
    this.seedPressureBaseline();
  }

  get maxSamples(): number {
    return this.window.maxSamples;
  }

  record(health: LiveEffectRackFrameBatchCalibrationHealthSample): LiveEffectRackCalibrationWindowSnapshot {
    if (this.hasDryPressure(health)) {
      this.dryOutputBlocks = Math.min(Number.MAX_SAFE_INTEGER, this.dryOutputBlocks + 1);
    }
    return this.window.record({
      lastProcessDurationMs: health.totalDurationMs,
      lastRenderDurationMs: health.maxDurationMs,
      responseJitterBlocks: health.responseJitterBlocks,
      lastResponseDeadlineLeadBlocks: health.lastResponseDeadlineLeadBlocks,
      latencySamples: health.latencySamples ?? health.reportedLatencySamples,
      dryOutputBlocks: this.dryOutputBlocks,
      responseDeadlineMisses: health.responseDeadlineMisses
    });
  }

  reset(): void {
    this.dryOutputBlocks = 0;
    this.window.reset();
    this.seedPressureBaseline();
  }

  snapshot(): LiveEffectRackCalibrationWindowSnapshot {
    return this.window.snapshot();
  }

  calibrate(): LiveEffectRackCalibration {
    return this.window.calibrate();
  }

  recommendedPolicyOptions(overrides: Partial<LiveEffectRackPolicyOptions> = {}): LiveEffectRackPolicyOptions {
    return this.window.recommendedPolicyOptions(overrides);
  }

  private hasDryPressure(health: LiveEffectRackFrameBatchCalibrationHealthSample): boolean {
    const dryTargets = boundedLiveEffectInteger(health.dryTargets, 0, 0, Number.MAX_SAFE_INTEGER);
    const bypassedTargets = boundedLiveEffectInteger(health.bypassedTargets, 0, 0, Number.MAX_SAFE_INTEGER);
    return (
      health.processBudgetTripped === true ||
      health.processTimedOut === true ||
      health.processTimeoutTripped === true ||
      dryTargets > bypassedTargets ||
      boundedLiveEffectInteger(health.skippedTargets, 0, 0, Number.MAX_SAFE_INTEGER) > 0 ||
      boundedLiveEffectInteger(health.failedTargets, 0, 0, Number.MAX_SAFE_INTEGER) > 0
    );
  }

  private seedPressureBaseline(): void {
    this.window.record({ dryOutputBlocks: 0 });
  }
}

export function createLiveEffectRackCalibrationWindow(options: LiveEffectRackCalibrationWindowOptions): LiveEffectRackCalibrationWindow {
  return new LiveEffectRackCalibrationWindow(options);
}

export function createLiveEffectRackChainCalibrationWindow(
  options: LiveEffectRackCalibrationWindowOptions
): LiveEffectRackChainCalibrationWindow {
  return new LiveEffectRackChainCalibrationWindow(options);
}

export function createLiveEffectRackFrameBatchCalibrationWindow(
  options: LiveEffectRackCalibrationWindowOptions
): LiveEffectRackFrameBatchCalibrationWindow {
  return new LiveEffectRackFrameBatchCalibrationWindow(options);
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

function pressureCounterDelta(current: number, baseline: number): number {
  return current >= baseline ? current - baseline : current;
}
