import {
  LivePerformanceAudioNodeCalibrationWindow,
  boundedInteger
} from "./bridge-node-options";
import type {
  LivePerformanceAudioNodeCalibrationHealthSample,
  LivePerformanceAudioNodeCalibrationWindowOptions,
  LivePerformanceAudioNodeCalibrationWindowSnapshot,
  LivePerformanceAudioNodeLatencyRefresher
} from "./bridge-node-options";

const LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_MIN_SAMPLES = 8;
const LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_COOLDOWN_BLOCKS = 64;
const LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_MAX_STEP_BLOCKS = 4;
const LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_RECOVERY_BLOCKS = 128;
const LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_MAX_RECOVERY_STEP_BLOCKS = 1;

export type LivePerformanceAudioNodeAdaptiveLatencyDirection = "none" | "increase" | "decrease";
export type LivePerformanceAudioNodeRecreateRecommendationReason = "increase-max-output-latency" | "increase-shared-buffer" | "increase-audio-timeout";

export interface LivePerformanceAudioNodeAdaptiveLatencyTarget<T = unknown> extends LivePerformanceAudioNodeLatencyRefresher<T> {
  readonly health: LivePerformanceAudioNodeCalibrationHealthSample & { transportLatencySamples?: number };
}

export interface LivePerformanceAudioNodeAdaptiveLatencyOptions<T = unknown> extends LivePerformanceAudioNodeCalibrationWindowOptions {
  node: LivePerformanceAudioNodeAdaptiveLatencyTarget<T>;
  minSamples?: number;
  cooldownBlocks?: number;
  maxLatencyIncreaseBlocks?: number;
  latencyRecoveryBlocks?: number;
  maxLatencyDecreaseBlocks?: number;
  minTransportLatencySamples?: number;
  minTransportLatencyBlocks?: number;
}

export interface LivePerformanceAudioNodeAdaptiveLatencySnapshot<T = unknown> extends LivePerformanceAudioNodeCalibrationWindowSnapshot {
  applied: boolean;
  appliedDirection: LivePerformanceAudioNodeAdaptiveLatencyDirection;
  recreateRecommended: boolean;
  recreateReasons: LivePerformanceAudioNodeRecreateRecommendationReason[];
  currentTransportLatencySamples: number;
  targetTransportLatencySamples: number;
  cooldownBlocksRemaining: number;
  stableBlocks: number;
  recoveryBlocksRemaining: number;
  refreshResult?: T;
}

export class LivePerformanceAudioNodeAdaptiveLatencyController<T = unknown> {
  readonly node: LivePerformanceAudioNodeAdaptiveLatencyTarget<T>;
  readonly minSamples: number;
  readonly cooldownBlocks: number;
  readonly maxLatencyIncreaseBlocks: number;
  readonly latencyRecoveryBlocks: number;
  readonly maxLatencyDecreaseBlocks: number;
  readonly minTransportLatencySamples: number;
  private readonly window: LivePerformanceAudioNodeCalibrationWindow;
  private cooldownBlocksRemaining = 0;
  private stableBlocks = 0;

  constructor(options: LivePerformanceAudioNodeAdaptiveLatencyOptions<T>) {
    const {
      node,
      minSamples,
      cooldownBlocks,
      maxLatencyIncreaseBlocks,
      latencyRecoveryBlocks,
      maxLatencyDecreaseBlocks,
      minTransportLatencySamples,
      minTransportLatencyBlocks,
      ...windowOptions
    } = options;
    const maxBlockFrames = boundedInteger(windowOptions.maxBlockFrames, 128, 1, 8192);
    const minimumFromBlocks = minTransportLatencyBlocks === undefined
      ? undefined
      : boundedInteger(minTransportLatencyBlocks, 0, 0, 128) * maxBlockFrames;
    this.node = node;
    this.window = new LivePerformanceAudioNodeCalibrationWindow(windowOptions);
    this.minSamples = boundedInteger(minSamples, LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_MIN_SAMPLES, 1, 256);
    this.cooldownBlocks = boundedInteger(cooldownBlocks, LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_COOLDOWN_BLOCKS, 0, 4096);
    this.maxLatencyIncreaseBlocks = boundedInteger(maxLatencyIncreaseBlocks, LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_MAX_STEP_BLOCKS, 1, 128);
    this.latencyRecoveryBlocks = boundedInteger(latencyRecoveryBlocks, LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_RECOVERY_BLOCKS, 0, 4096);
    this.maxLatencyDecreaseBlocks = boundedInteger(maxLatencyDecreaseBlocks, LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_MAX_RECOVERY_STEP_BLOCKS, 1, 128);
    this.minTransportLatencySamples = boundedInteger(
      minTransportLatencySamples ?? minimumFromBlocks ?? windowOptions.transportLatencySamples,
      0,
      0,
      1_048_576
    );
  }

  async record(
    health: LivePerformanceAudioNodeCalibrationHealthSample = this.node.health
  ): Promise<LivePerformanceAudioNodeAdaptiveLatencySnapshot<T>> {
    if (this.cooldownBlocksRemaining > 0) this.cooldownBlocksRemaining -= 1;
    const snapshot = this.window.record(health);
    const recreateReasons = this.recreateReasons(snapshot);
    const currentTransportLatencySamples = boundedInteger(
      this.node.health.transportLatencySamples,
      snapshot.calibration.policy.transportLatencySamples,
      0,
      1_048_576
    );
    const maxBlockFrames = snapshot.calibration.policy.maxBlockFrames;
    let targetTransportLatencySamples = Math.min(
      snapshot.calibration.recommendedTransportLatencySamples,
      currentTransportLatencySamples + this.maxLatencyIncreaseBlocks * maxBlockFrames
    );
    let refreshResult: T | undefined;
    let applied = false;
    let appliedDirection: LivePerformanceAudioNodeAdaptiveLatencyDirection = "none";
    if (this.shouldApply(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
      refreshResult = await this.node.refreshLatency(targetTransportLatencySamples);
      applied = true;
      appliedDirection = "increase";
      this.cooldownBlocksRemaining = this.cooldownBlocks;
      this.stableBlocks = 0;
      this.window.reset();
    } else {
      this.recordStableBlock(snapshot);
      targetTransportLatencySamples = this.recoveryTarget(currentTransportLatencySamples, maxBlockFrames);
      if (this.shouldRecover(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
        refreshResult = await this.node.refreshLatency(targetTransportLatencySamples);
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
      recreateRecommended: recreateReasons.length > 0,
      recreateReasons,
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
    snapshot: LivePerformanceAudioNodeCalibrationWindowSnapshot,
    targetTransportLatencySamples: number,
    currentTransportLatencySamples: number
  ): boolean {
    return (
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      targetTransportLatencySamples > currentTransportLatencySamples &&
      snapshot.calibration.warnings.includes("increase-output-latency")
    );
  }

  private recreateReasons(
    snapshot: LivePerformanceAudioNodeCalibrationWindowSnapshot
  ): LivePerformanceAudioNodeRecreateRecommendationReason[] {
    if (snapshot.samples < this.minSamples) return [];
    const warnings = snapshot.calibration.warnings;
    const reasons: LivePerformanceAudioNodeRecreateRecommendationReason[] = [];
    if (warnings.includes("increase-max-output-latency")) reasons.push("increase-max-output-latency");
    if (warnings.includes("increase-shared-buffer")) reasons.push("increase-shared-buffer");
    if (warnings.includes("increase-audio-timeout")) reasons.push("increase-audio-timeout");
    return reasons;
  }

  private shouldRecover(
    snapshot: LivePerformanceAudioNodeCalibrationWindowSnapshot,
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

  private recordStableBlock(snapshot: LivePerformanceAudioNodeCalibrationWindowSnapshot): void {
    if (snapshot.samples >= this.minSamples && snapshot.calibration.warnings.length === 0) {
      this.stableBlocks = Math.min(4096, this.stableBlocks + 1);
      return;
    }
    if (snapshot.calibration.warnings.length > 0) this.stableBlocks = 0;
  }

  private recoveryTarget(currentTransportLatencySamples: number, maxBlockFrames: number): number {
    return Math.max(
      this.minTransportLatencySamples,
      currentTransportLatencySamples - this.maxLatencyDecreaseBlocks * maxBlockFrames
    );
  }
}

export function createLivePerformanceAudioNodeAdaptiveLatencyController<T>(
  options: LivePerformanceAudioNodeAdaptiveLatencyOptions<T>
): LivePerformanceAudioNodeAdaptiveLatencyController<T> {
  return new LivePerformanceAudioNodeAdaptiveLatencyController(options);
}
