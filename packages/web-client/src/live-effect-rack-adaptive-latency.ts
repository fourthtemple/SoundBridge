import { boundedLatencySamples, boundedLiveEffectInteger, combinedLatencySamples } from "./live-effect-rack-metrics";
import { LiveEffectRackCalibrationWindow, LiveEffectRackChainCalibrationWindow, LiveEffectRackFrameBatchCalibrationWindow } from "./live-effect-rack-calibration";
import type {
  LiveEffectRackChainCalibrationHealthSample,
  LiveEffectRackFrameBatchCalibrationHealthSample,
  LiveEffectRackCalibrationHealthSample,
  LiveEffectRackCalibrationWindowOptions,
  LiveEffectRackCalibrationWindowSnapshot,
  LiveEffectRackLatencyRefresher
} from "./live-effect-rack-calibration";
import type { LiveEffectRackDeadlinePressure, LiveEffectRackDeadlinePressureHealth } from "./live-effect-rack-scheduler";

const LIVE_EFFECT_ADAPTIVE_LATENCY_MIN_SAMPLES = 8;
const LIVE_EFFECT_ADAPTIVE_LATENCY_COOLDOWN_BLOCKS = 64;
const LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_STEP_BLOCKS = 4;
const LIVE_EFFECT_ADAPTIVE_LATENCY_RECOVERY_BLOCKS = 128;
const LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_RECOVERY_STEP_BLOCKS = 1;

export type LiveEffectRackAdaptiveLatencyDirection = "none" | "increase" | "decrease";

export interface LiveEffectRackAdaptiveLatencyTarget<T = unknown> extends LiveEffectRackLatencyRefresher<T> {
  readonly health: LiveEffectRackCalibrationHealthSample & { transportLatencySamples?: number };
}

export interface LiveEffectRackAdaptiveLatencyOptions<T = unknown> extends LiveEffectRackCalibrationWindowOptions {
  rack: LiveEffectRackAdaptiveLatencyTarget<T>;
  minSamples?: number;
  cooldownBlocks?: number;
  maxLatencyIncreaseBlocks?: number;
  latencyRecoveryBlocks?: number;
  maxLatencyDecreaseBlocks?: number;
  minTransportLatencySamples?: number;
  minTransportLatencyBlocks?: number;
}

export interface LiveEffectRackSchedulerAdaptiveLatencyScheduler {
  updateLatency(transportLatencySamples: unknown): number;
  updateDeadlinePressureFromHealth(
    health: LiveEffectRackDeadlinePressureHealth,
    calibration?: { warnings: string[] }
  ): unknown;
  snapshot(): { transportLatencySamples: number; deadlinePressure?: LiveEffectRackDeadlinePressure };
}

export interface LiveEffectRackChainSchedulerAdaptiveLatencyScheduler extends LiveEffectRackSchedulerAdaptiveLatencyScheduler {}

export interface LiveEffectRackFrameBatchSchedulerAdaptiveLatencyScheduler extends LiveEffectRackSchedulerAdaptiveLatencyScheduler {}

export interface LiveEffectRackSchedulerAdaptiveLatencyOptions extends LiveEffectRackCalibrationWindowOptions {
  scheduler: LiveEffectRackSchedulerAdaptiveLatencyScheduler;
  minSamples?: number;
  cooldownBlocks?: number;
  maxLatencyIncreaseBlocks?: number;
  latencyRecoveryBlocks?: number;
  maxLatencyDecreaseBlocks?: number;
  minTransportLatencySamples?: number;
  minTransportLatencyBlocks?: number;
}

export interface LiveEffectRackChainSchedulerAdaptiveLatencyOptions extends LiveEffectRackCalibrationWindowOptions {
  scheduler: LiveEffectRackChainSchedulerAdaptiveLatencyScheduler;
  minSamples?: number;
  cooldownBlocks?: number;
  maxLatencyIncreaseBlocks?: number;
  latencyRecoveryBlocks?: number;
  maxLatencyDecreaseBlocks?: number;
  minTransportLatencySamples?: number;
  minTransportLatencyBlocks?: number;
}

export interface LiveEffectRackFrameBatchSchedulerAdaptiveLatencyOptions extends LiveEffectRackCalibrationWindowOptions {
  scheduler: LiveEffectRackFrameBatchSchedulerAdaptiveLatencyScheduler;
  minSamples?: number;
  cooldownBlocks?: number;
  maxLatencyIncreaseBlocks?: number;
  latencyRecoveryBlocks?: number;
  maxLatencyDecreaseBlocks?: number;
  minTransportLatencySamples?: number;
  minTransportLatencyBlocks?: number;
}

export interface LiveEffectRackAdaptiveLatencySnapshot<T = unknown> extends LiveEffectRackCalibrationWindowSnapshot {
  applied: boolean;
  appliedDirection: LiveEffectRackAdaptiveLatencyDirection;
  currentTransportLatencySamples: number;
  targetTransportLatencySamples: number;
  cooldownBlocksRemaining: number;
  stableBlocks: number;
  recoveryBlocksRemaining: number;
  refreshResult?: T;
}

export interface LiveEffectRackSchedulerAdaptiveLatencySnapshot extends LiveEffectRackCalibrationWindowSnapshot {
  applied: boolean;
  appliedDirection: LiveEffectRackAdaptiveLatencyDirection;
  currentTransportLatencySamples: number;
  targetTransportLatencySamples: number;
  cooldownBlocksRemaining: number;
  stableBlocks: number;
  recoveryBlocksRemaining: number;
  deadlinePressure?: LiveEffectRackDeadlinePressure;
}

export interface LiveEffectRackChainSchedulerAdaptiveLatencySnapshot extends LiveEffectRackCalibrationWindowSnapshot {
  applied: boolean;
  appliedDirection: LiveEffectRackAdaptiveLatencyDirection;
  chainLatencySamples: number;
  currentTransportLatencySamples: number;
  targetTransportLatencySamples: number;
  cooldownBlocksRemaining: number;
  stableBlocks: number;
  recoveryBlocksRemaining: number;
  deadlinePressure?: LiveEffectRackDeadlinePressure;
}

export interface LiveEffectRackFrameBatchSchedulerAdaptiveLatencySnapshot extends LiveEffectRackCalibrationWindowSnapshot {
  applied: boolean;
  appliedDirection: LiveEffectRackAdaptiveLatencyDirection;
  batchLatencySamples: number;
  currentTransportLatencySamples: number;
  targetTransportLatencySamples: number;
  cooldownBlocksRemaining: number;
  stableBlocks: number;
  recoveryBlocksRemaining: number;
  deadlinePressure?: LiveEffectRackDeadlinePressure;
}

export class LiveEffectRackAdaptiveLatencyController<T = unknown> {
  readonly rack: LiveEffectRackAdaptiveLatencyTarget<T>;
  readonly minSamples: number;
  readonly cooldownBlocks: number;
  readonly maxLatencyIncreaseBlocks: number;
  readonly latencyRecoveryBlocks: number;
  readonly maxLatencyDecreaseBlocks: number;
  readonly minTransportLatencySamples: number;
  private readonly window: LiveEffectRackCalibrationWindow;
  private cooldownBlocksRemaining = 0;
  private stableBlocks = 0;

  constructor(options: LiveEffectRackAdaptiveLatencyOptions<T>) {
    const {
      rack,
      minSamples,
      cooldownBlocks,
      maxLatencyIncreaseBlocks,
      latencyRecoveryBlocks,
      maxLatencyDecreaseBlocks,
      minTransportLatencySamples,
      minTransportLatencyBlocks,
      ...windowOptions
    } = options;
    this.rack = rack;
    this.window = new LiveEffectRackCalibrationWindow(windowOptions);
    this.minSamples = boundedLiveEffectInteger(minSamples, LIVE_EFFECT_ADAPTIVE_LATENCY_MIN_SAMPLES, 1, 256);
    this.cooldownBlocks = boundedLiveEffectInteger(cooldownBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_COOLDOWN_BLOCKS, 0, 4096);
    this.maxLatencyIncreaseBlocks = boundedLiveEffectInteger(maxLatencyIncreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_STEP_BLOCKS, 1, 128);
    this.latencyRecoveryBlocks = boundedLiveEffectInteger(latencyRecoveryBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_RECOVERY_BLOCKS, 0, 4096);
    this.maxLatencyDecreaseBlocks = boundedLiveEffectInteger(maxLatencyDecreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_RECOVERY_STEP_BLOCKS, 1, 128);
    const maxBlockSize = boundedLiveEffectInteger(windowOptions.maxBlockSize, 128, 1, 8192);
    const minimumFromBlocks = minTransportLatencyBlocks === undefined
      ? undefined
      : boundedLiveEffectInteger(minTransportLatencyBlocks, 0, 0, 128) * maxBlockSize;
    this.minTransportLatencySamples = boundedLatencySamples(
      minTransportLatencySamples ?? minimumFromBlocks ?? windowOptions.transportLatencySamples,
      0
    );
  }

  async record(health: LiveEffectRackCalibrationHealthSample = this.rack.health): Promise<LiveEffectRackAdaptiveLatencySnapshot<T>> {
    if (this.cooldownBlocksRemaining > 0) {
      this.cooldownBlocksRemaining -= 1;
    }
    const snapshot = this.window.record(health);
    const currentTransportLatencySamples = boundedLatencySamples(
      this.rack.health.transportLatencySamples,
      snapshot.calibration.policy.transportLatencySamples
    );
    const maxIncreaseStepSamples = this.maxLatencyIncreaseBlocks * snapshot.calibration.policy.maxBlockSize;
    const recommendedTransportLatencySamples = snapshot.calibration.recommendedTransportLatencySamples;
    let targetTransportLatencySamples = Math.min(
      recommendedTransportLatencySamples,
      currentTransportLatencySamples + maxIncreaseStepSamples
    );
    let refreshResult: T | undefined;
    let applied = false;
    let appliedDirection: LiveEffectRackAdaptiveLatencyDirection = "none";
    if (this.shouldApply(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
      refreshResult = await this.rack.refreshLatency(targetTransportLatencySamples);
      applied = true;
      appliedDirection = "increase";
      this.cooldownBlocksRemaining = this.cooldownBlocks;
      this.stableBlocks = 0;
      this.window.reset();
    } else {
      this.recordStableBlock(snapshot);
      targetTransportLatencySamples = this.recoveryTarget(currentTransportLatencySamples, snapshot.calibration.policy.maxBlockSize);
      if (this.shouldRecover(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
        refreshResult = await this.rack.refreshLatency(targetTransportLatencySamples);
        applied = true;
        appliedDirection = "decrease";
        this.cooldownBlocksRemaining = this.cooldownBlocks;
        this.stableBlocks = 0;
        this.window.reset();
      }
    }
    return {
      ...snapshot,
      applied,
      appliedDirection,
      currentTransportLatencySamples,
      targetTransportLatencySamples,
      cooldownBlocksRemaining: this.cooldownBlocksRemaining,
      stableBlocks: this.stableBlocks,
      recoveryBlocksRemaining: Math.max(0, this.latencyRecoveryBlocks - this.stableBlocks),
      refreshResult
    };
  }

  reset(): void {
    this.window.reset();
    this.cooldownBlocksRemaining = 0;
    this.stableBlocks = 0;
  }

  private shouldApply(
    snapshot: LiveEffectRackCalibrationWindowSnapshot,
    targetTransportLatencySamples: number,
    currentTransportLatencySamples: number
  ): boolean {
    return (
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      targetTransportLatencySamples > currentTransportLatencySamples &&
      snapshot.calibration.warnings.includes("increase-transport-latency")
    );
  }

  private shouldRecover(
    snapshot: LiveEffectRackCalibrationWindowSnapshot,
    targetTransportLatencySamples: number,
    currentTransportLatencySamples: number
  ): boolean {
    return (
      this.latencyRecoveryBlocks > 0 &&
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      this.stableBlocks >= this.latencyRecoveryBlocks &&
      targetTransportLatencySamples < currentTransportLatencySamples &&
      snapshot.calibration.warnings.length === 0
    );
  }

  private recordStableBlock(snapshot: LiveEffectRackCalibrationWindowSnapshot): void {
    if (snapshot.samples >= this.minSamples && snapshot.calibration.warnings.length === 0) {
      this.stableBlocks = Math.min(4096, this.stableBlocks + 1);
      return;
    }
    if (snapshot.calibration.warnings.length > 0) {
      this.stableBlocks = 0;
    }
  }

  private recoveryTarget(currentTransportLatencySamples: number, maxBlockSize: number): number {
    const maxDecreaseStepSamples = this.maxLatencyDecreaseBlocks * maxBlockSize;
    return Math.max(
      this.minTransportLatencySamples,
      currentTransportLatencySamples - maxDecreaseStepSamples
    );
  }
}

export class LiveEffectRackSchedulerAdaptiveLatencyController {
  readonly scheduler: LiveEffectRackSchedulerAdaptiveLatencyScheduler;
  readonly minSamples: number;
  readonly cooldownBlocks: number;
  readonly maxLatencyIncreaseBlocks: number;
  readonly latencyRecoveryBlocks: number;
  readonly maxLatencyDecreaseBlocks: number;
  readonly minTransportLatencySamples: number;
  private readonly window: LiveEffectRackCalibrationWindow;
  private cooldownBlocksRemaining = 0;
  private stableBlocks = 0;

  constructor(options: LiveEffectRackSchedulerAdaptiveLatencyOptions) {
    const {
      scheduler,
      minSamples,
      cooldownBlocks,
      maxLatencyIncreaseBlocks,
      latencyRecoveryBlocks,
      maxLatencyDecreaseBlocks,
      minTransportLatencySamples,
      minTransportLatencyBlocks,
      ...windowOptions
    } = options;
    this.scheduler = scheduler;
    this.window = new LiveEffectRackCalibrationWindow(windowOptions);
    this.minSamples = boundedLiveEffectInteger(minSamples, LIVE_EFFECT_ADAPTIVE_LATENCY_MIN_SAMPLES, 1, 256);
    this.cooldownBlocks = boundedLiveEffectInteger(cooldownBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_COOLDOWN_BLOCKS, 0, 4096);
    this.maxLatencyIncreaseBlocks = boundedLiveEffectInteger(maxLatencyIncreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_STEP_BLOCKS, 1, 128);
    this.latencyRecoveryBlocks = boundedLiveEffectInteger(latencyRecoveryBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_RECOVERY_BLOCKS, 0, 4096);
    this.maxLatencyDecreaseBlocks = boundedLiveEffectInteger(maxLatencyDecreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_RECOVERY_STEP_BLOCKS, 1, 128);
    const maxBlockSize = boundedLiveEffectInteger(windowOptions.maxBlockSize, 128, 1, 8192);
    const minimumFromBlocks = minTransportLatencyBlocks === undefined
      ? undefined
      : boundedLiveEffectInteger(minTransportLatencyBlocks, 0, 0, 128) * maxBlockSize;
    this.minTransportLatencySamples = boundedLatencySamples(
      minTransportLatencySamples ?? minimumFromBlocks ?? windowOptions.transportLatencySamples,
      0
    );
  }

  record(health: LiveEffectRackCalibrationHealthSample): LiveEffectRackSchedulerAdaptiveLatencySnapshot {
    if (this.cooldownBlocksRemaining > 0) {
      this.cooldownBlocksRemaining -= 1;
    }
    const snapshot = this.window.record(health);
    const currentTransportLatencySamples = boundedLatencySamples(
      this.scheduler.snapshot().transportLatencySamples,
      snapshot.calibration.policy.transportLatencySamples
    );
    const maxBlockSize = snapshot.calibration.policy.maxBlockSize;
    let targetTransportLatencySamples = Math.min(
      snapshot.calibration.recommendedTransportLatencySamples,
      currentTransportLatencySamples + this.maxLatencyIncreaseBlocks * maxBlockSize
    );
    let applied = false;
    let appliedDirection: LiveEffectRackAdaptiveLatencyDirection = "none";
    if (this.shouldApply(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
      this.scheduler.updateLatency(targetTransportLatencySamples);
      this.scheduler.updateDeadlinePressureFromHealth(health, snapshot.calibration);
      applied = true;
      appliedDirection = "increase";
      this.cooldownBlocksRemaining = this.cooldownBlocks;
      this.stableBlocks = 0;
      this.window.reset();
    } else {
      this.scheduler.updateDeadlinePressureFromHealth(health, snapshot.calibration);
      this.recordStableBlock(snapshot);
      targetTransportLatencySamples = this.recoveryTarget(currentTransportLatencySamples, maxBlockSize);
      if (this.shouldRecover(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
        this.scheduler.updateLatency(targetTransportLatencySamples);
        this.scheduler.updateDeadlinePressureFromHealth(health, snapshot.calibration);
        applied = true;
        appliedDirection = "decrease";
        this.cooldownBlocksRemaining = this.cooldownBlocks;
        this.stableBlocks = 0;
        this.window.reset();
      }
    }
    const deadlinePressure = this.scheduler.snapshot().deadlinePressure;
    return {
      ...snapshot,
      applied,
      appliedDirection,
      currentTransportLatencySamples,
      targetTransportLatencySamples,
      cooldownBlocksRemaining: this.cooldownBlocksRemaining,
      stableBlocks: this.stableBlocks,
      recoveryBlocksRemaining: Math.max(0, this.latencyRecoveryBlocks - this.stableBlocks),
      deadlinePressure
    };
  }

  reset(): void {
    this.window.reset();
    this.cooldownBlocksRemaining = 0;
    this.stableBlocks = 0;
  }

  private shouldApply(
    snapshot: LiveEffectRackCalibrationWindowSnapshot,
    targetTransportLatencySamples: number,
    currentTransportLatencySamples: number
  ): boolean {
    return (
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      targetTransportLatencySamples > currentTransportLatencySamples &&
      snapshot.calibration.warnings.includes("increase-transport-latency")
    );
  }

  private shouldRecover(
    snapshot: LiveEffectRackCalibrationWindowSnapshot,
    targetTransportLatencySamples: number,
    currentTransportLatencySamples: number
  ): boolean {
    return (
      this.latencyRecoveryBlocks > 0 &&
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      this.stableBlocks >= this.latencyRecoveryBlocks &&
      targetTransportLatencySamples < currentTransportLatencySamples &&
      snapshot.calibration.warnings.length === 0
    );
  }

  private recordStableBlock(snapshot: LiveEffectRackCalibrationWindowSnapshot): void {
    if (snapshot.samples >= this.minSamples && snapshot.calibration.warnings.length === 0) {
      this.stableBlocks = Math.min(4096, this.stableBlocks + 1);
      return;
    }
    if (snapshot.calibration.warnings.length > 0) {
      this.stableBlocks = 0;
    }
  }

  private recoveryTarget(currentTransportLatencySamples: number, maxBlockSize: number): number {
    const maxDecreaseStepSamples = this.maxLatencyDecreaseBlocks * maxBlockSize;
    return Math.max(
      this.minTransportLatencySamples,
      currentTransportLatencySamples - maxDecreaseStepSamples
    );
  }
}

export class LiveEffectRackChainSchedulerAdaptiveLatencyController {
  readonly scheduler: LiveEffectRackChainSchedulerAdaptiveLatencyScheduler;
  readonly minSamples: number;
  readonly cooldownBlocks: number;
  readonly maxLatencyIncreaseBlocks: number;
  readonly latencyRecoveryBlocks: number;
  readonly maxLatencyDecreaseBlocks: number;
  readonly minAdditionalTransportLatencySamples: number;
  private readonly window: LiveEffectRackChainCalibrationWindow;
  private cooldownBlocksRemaining = 0;
  private stableBlocks = 0;

  constructor(options: LiveEffectRackChainSchedulerAdaptiveLatencyOptions) {
    const {
      scheduler,
      minSamples,
      cooldownBlocks,
      maxLatencyIncreaseBlocks,
      latencyRecoveryBlocks,
      maxLatencyDecreaseBlocks,
      minTransportLatencySamples,
      minTransportLatencyBlocks,
      ...windowOptions
    } = options;
    this.scheduler = scheduler;
    this.window = new LiveEffectRackChainCalibrationWindow(windowOptions);
    this.minSamples = boundedLiveEffectInteger(minSamples, LIVE_EFFECT_ADAPTIVE_LATENCY_MIN_SAMPLES, 1, 256);
    this.cooldownBlocks = boundedLiveEffectInteger(cooldownBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_COOLDOWN_BLOCKS, 0, 4096);
    this.maxLatencyIncreaseBlocks = boundedLiveEffectInteger(maxLatencyIncreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_STEP_BLOCKS, 1, 128);
    this.latencyRecoveryBlocks = boundedLiveEffectInteger(latencyRecoveryBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_RECOVERY_BLOCKS, 0, 4096);
    this.maxLatencyDecreaseBlocks = boundedLiveEffectInteger(maxLatencyDecreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_RECOVERY_STEP_BLOCKS, 1, 128);
    const maxBlockSize = boundedLiveEffectInteger(windowOptions.maxBlockSize, 128, 1, 8192);
    const minimumFromBlocks = minTransportLatencyBlocks === undefined
      ? undefined
      : boundedLiveEffectInteger(minTransportLatencyBlocks, 0, 0, 128) * maxBlockSize;
    this.minAdditionalTransportLatencySamples = boundedLatencySamples(
      minTransportLatencySamples ?? minimumFromBlocks ?? windowOptions.transportLatencySamples,
      0
    );
  }

  record(health: LiveEffectRackChainCalibrationHealthSample): LiveEffectRackChainSchedulerAdaptiveLatencySnapshot {
    if (this.cooldownBlocksRemaining > 0) {
      this.cooldownBlocksRemaining -= 1;
    }
    const snapshot = this.window.record(health);
    const currentTransportLatencySamples = boundedLatencySamples(
      this.scheduler.snapshot().transportLatencySamples,
      snapshot.calibration.policy.transportLatencySamples
    );
    const chainLatencySamples = boundedLatencySamples(health.latencySamples, 0);
    const maxBlockSize = snapshot.calibration.policy.maxBlockSize;
    const recommendedTotalLatencySamples = combinedLatencySamples(
      chainLatencySamples,
      snapshot.calibration.recommendedTransportLatencySamples
    );
    let targetTransportLatencySamples = Math.min(
      recommendedTotalLatencySamples,
      currentTransportLatencySamples + this.maxLatencyIncreaseBlocks * maxBlockSize
    );
    let applied = false;
    let appliedDirection: LiveEffectRackAdaptiveLatencyDirection = "none";
    if (this.shouldApply(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
      this.scheduler.updateLatency(targetTransportLatencySamples);
      this.scheduler.updateDeadlinePressureFromHealth(health, snapshot.calibration);
      applied = true;
      appliedDirection = "increase";
      this.cooldownBlocksRemaining = this.cooldownBlocks;
      this.stableBlocks = 0;
      this.window.reset();
    } else {
      this.scheduler.updateDeadlinePressureFromHealth(health, snapshot.calibration);
      this.recordStableBlock(snapshot);
      targetTransportLatencySamples = this.recoveryTarget(currentTransportLatencySamples, chainLatencySamples, maxBlockSize);
      if (this.shouldRecover(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
        this.scheduler.updateLatency(targetTransportLatencySamples);
        this.scheduler.updateDeadlinePressureFromHealth(health, snapshot.calibration);
        applied = true;
        appliedDirection = "decrease";
        this.cooldownBlocksRemaining = this.cooldownBlocks;
        this.stableBlocks = 0;
        this.window.reset();
      }
    }
    const deadlinePressure = this.scheduler.snapshot().deadlinePressure;
    return {
      ...snapshot,
      applied,
      appliedDirection,
      chainLatencySamples,
      currentTransportLatencySamples,
      targetTransportLatencySamples,
      cooldownBlocksRemaining: this.cooldownBlocksRemaining,
      stableBlocks: this.stableBlocks,
      recoveryBlocksRemaining: Math.max(0, this.latencyRecoveryBlocks - this.stableBlocks),
      deadlinePressure
    };
  }

  reset(): void {
    this.window.reset();
    this.cooldownBlocksRemaining = 0;
    this.stableBlocks = 0;
  }

  private shouldApply(
    snapshot: LiveEffectRackCalibrationWindowSnapshot,
    targetTransportLatencySamples: number,
    currentTransportLatencySamples: number
  ): boolean {
    return (
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      targetTransportLatencySamples > currentTransportLatencySamples &&
      snapshot.calibration.warnings.includes("increase-transport-latency")
    );
  }

  private shouldRecover(
    snapshot: LiveEffectRackCalibrationWindowSnapshot,
    targetTransportLatencySamples: number,
    currentTransportLatencySamples: number
  ): boolean {
    return (
      this.latencyRecoveryBlocks > 0 &&
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      this.stableBlocks >= this.latencyRecoveryBlocks &&
      targetTransportLatencySamples < currentTransportLatencySamples &&
      snapshot.calibration.warnings.length === 0
    );
  }

  private recordStableBlock(snapshot: LiveEffectRackCalibrationWindowSnapshot): void {
    if (snapshot.samples >= this.minSamples && snapshot.calibration.warnings.length === 0) {
      this.stableBlocks = Math.min(4096, this.stableBlocks + 1);
      return;
    }
    if (snapshot.calibration.warnings.length > 0) {
      this.stableBlocks = 0;
    }
  }

  private recoveryTarget(currentTransportLatencySamples: number, chainLatencySamples: number, maxBlockSize: number): number {
    const maxDecreaseStepSamples = this.maxLatencyDecreaseBlocks * maxBlockSize;
    return Math.max(
      combinedLatencySamples(chainLatencySamples, this.minAdditionalTransportLatencySamples),
      currentTransportLatencySamples - maxDecreaseStepSamples
    );
  }
}

export class LiveEffectRackFrameBatchSchedulerAdaptiveLatencyController {
  readonly scheduler: LiveEffectRackFrameBatchSchedulerAdaptiveLatencyScheduler;
  readonly minSamples: number;
  readonly cooldownBlocks: number;
  readonly maxLatencyIncreaseBlocks: number;
  readonly latencyRecoveryBlocks: number;
  readonly maxLatencyDecreaseBlocks: number;
  readonly minAdditionalTransportLatencySamples: number;
  private readonly window: LiveEffectRackFrameBatchCalibrationWindow;
  private cooldownBlocksRemaining = 0;
  private stableBlocks = 0;

  constructor(options: LiveEffectRackFrameBatchSchedulerAdaptiveLatencyOptions) {
    const {
      scheduler,
      minSamples,
      cooldownBlocks,
      maxLatencyIncreaseBlocks,
      latencyRecoveryBlocks,
      maxLatencyDecreaseBlocks,
      minTransportLatencySamples,
      minTransportLatencyBlocks,
      ...windowOptions
    } = options;
    this.scheduler = scheduler;
    this.window = new LiveEffectRackFrameBatchCalibrationWindow(windowOptions);
    this.minSamples = boundedLiveEffectInteger(minSamples, LIVE_EFFECT_ADAPTIVE_LATENCY_MIN_SAMPLES, 1, 256);
    this.cooldownBlocks = boundedLiveEffectInteger(cooldownBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_COOLDOWN_BLOCKS, 0, 4096);
    this.maxLatencyIncreaseBlocks = boundedLiveEffectInteger(maxLatencyIncreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_STEP_BLOCKS, 1, 128);
    this.latencyRecoveryBlocks = boundedLiveEffectInteger(latencyRecoveryBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_RECOVERY_BLOCKS, 0, 4096);
    this.maxLatencyDecreaseBlocks = boundedLiveEffectInteger(maxLatencyDecreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_RECOVERY_STEP_BLOCKS, 1, 128);
    const maxBlockSize = boundedLiveEffectInteger(windowOptions.maxBlockSize, 128, 1, 8192);
    const minimumFromBlocks = minTransportLatencyBlocks === undefined
      ? undefined
      : boundedLiveEffectInteger(minTransportLatencyBlocks, 0, 0, 128) * maxBlockSize;
    this.minAdditionalTransportLatencySamples = boundedLatencySamples(
      minTransportLatencySamples ?? minimumFromBlocks ?? windowOptions.transportLatencySamples,
      0
    );
  }

  record(health: LiveEffectRackFrameBatchCalibrationHealthSample): LiveEffectRackFrameBatchSchedulerAdaptiveLatencySnapshot {
    if (this.cooldownBlocksRemaining > 0) {
      this.cooldownBlocksRemaining -= 1;
    }
    const snapshot = this.window.record(health);
    const currentTransportLatencySamples = boundedLatencySamples(
      this.scheduler.snapshot().transportLatencySamples,
      snapshot.calibration.policy.transportLatencySamples
    );
    const batchLatencySamples = boundedLatencySamples(health.latencySamples ?? health.reportedLatencySamples, 0);
    const maxBlockSize = snapshot.calibration.policy.maxBlockSize;
    const recommendedTotalLatencySamples = combinedLatencySamples(
      batchLatencySamples,
      snapshot.calibration.recommendedTransportLatencySamples
    );
    let targetTransportLatencySamples = Math.min(
      recommendedTotalLatencySamples,
      currentTransportLatencySamples + this.maxLatencyIncreaseBlocks * maxBlockSize
    );
    let applied = false;
    let appliedDirection: LiveEffectRackAdaptiveLatencyDirection = "none";
    const pressureHealth: LiveEffectRackDeadlinePressureHealth = {};
    if (this.shouldApply(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
      this.scheduler.updateLatency(targetTransportLatencySamples);
      this.scheduler.updateDeadlinePressureFromHealth(pressureHealth, snapshot.calibration);
      applied = true;
      appliedDirection = "increase";
      this.cooldownBlocksRemaining = this.cooldownBlocks;
      this.stableBlocks = 0;
      this.window.reset();
    } else {
      this.scheduler.updateDeadlinePressureFromHealth(pressureHealth, snapshot.calibration);
      this.recordStableBlock(snapshot);
      targetTransportLatencySamples = this.recoveryTarget(currentTransportLatencySamples, batchLatencySamples, maxBlockSize);
      if (this.shouldRecover(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
        this.scheduler.updateLatency(targetTransportLatencySamples);
        this.scheduler.updateDeadlinePressureFromHealth(pressureHealth, snapshot.calibration);
        applied = true;
        appliedDirection = "decrease";
        this.cooldownBlocksRemaining = this.cooldownBlocks;
        this.stableBlocks = 0;
        this.window.reset();
      }
    }
    const deadlinePressure = this.scheduler.snapshot().deadlinePressure;
    return {
      ...snapshot,
      applied,
      appliedDirection,
      batchLatencySamples,
      currentTransportLatencySamples,
      targetTransportLatencySamples,
      cooldownBlocksRemaining: this.cooldownBlocksRemaining,
      stableBlocks: this.stableBlocks,
      recoveryBlocksRemaining: Math.max(0, this.latencyRecoveryBlocks - this.stableBlocks),
      deadlinePressure
    };
  }

  reset(): void {
    this.window.reset();
    this.cooldownBlocksRemaining = 0;
    this.stableBlocks = 0;
  }

  private shouldApply(
    snapshot: LiveEffectRackCalibrationWindowSnapshot,
    targetTransportLatencySamples: number,
    currentTransportLatencySamples: number
  ): boolean {
    return (
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      targetTransportLatencySamples > currentTransportLatencySamples &&
      snapshot.calibration.warnings.includes("increase-transport-latency")
    );
  }

  private shouldRecover(
    snapshot: LiveEffectRackCalibrationWindowSnapshot,
    targetTransportLatencySamples: number,
    currentTransportLatencySamples: number
  ): boolean {
    return (
      this.latencyRecoveryBlocks > 0 &&
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      this.stableBlocks >= this.latencyRecoveryBlocks &&
      targetTransportLatencySamples < currentTransportLatencySamples &&
      snapshot.calibration.warnings.length === 0
    );
  }

  private recordStableBlock(snapshot: LiveEffectRackCalibrationWindowSnapshot): void {
    if (snapshot.samples >= this.minSamples && snapshot.calibration.warnings.length === 0) {
      this.stableBlocks = Math.min(4096, this.stableBlocks + 1);
      return;
    }
    if (snapshot.calibration.warnings.length > 0) {
      this.stableBlocks = 0;
    }
  }

  private recoveryTarget(currentTransportLatencySamples: number, batchLatencySamples: number, maxBlockSize: number): number {
    const maxDecreaseStepSamples = this.maxLatencyDecreaseBlocks * maxBlockSize;
    return Math.max(
      combinedLatencySamples(batchLatencySamples, this.minAdditionalTransportLatencySamples),
      currentTransportLatencySamples - maxDecreaseStepSamples
    );
  }
}

export function createLiveEffectRackAdaptiveLatencyController<T>(
  options: LiveEffectRackAdaptiveLatencyOptions<T>
): LiveEffectRackAdaptiveLatencyController<T> {
  return new LiveEffectRackAdaptiveLatencyController(options);
}

export function createLiveEffectRackSchedulerAdaptiveLatencyController(
  options: LiveEffectRackSchedulerAdaptiveLatencyOptions
): LiveEffectRackSchedulerAdaptiveLatencyController {
  return new LiveEffectRackSchedulerAdaptiveLatencyController(options);
}

export function createLiveEffectRackChainSchedulerAdaptiveLatencyController(
  options: LiveEffectRackChainSchedulerAdaptiveLatencyOptions
): LiveEffectRackChainSchedulerAdaptiveLatencyController {
  return new LiveEffectRackChainSchedulerAdaptiveLatencyController(options);
}

export function createLiveEffectRackFrameBatchSchedulerAdaptiveLatencyController(
  options: LiveEffectRackFrameBatchSchedulerAdaptiveLatencyOptions
): LiveEffectRackFrameBatchSchedulerAdaptiveLatencyController {
  return new LiveEffectRackFrameBatchSchedulerAdaptiveLatencyController(options);
}
