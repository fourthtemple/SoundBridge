import { boundedInteger } from "./bridge-node-options";
import type { SoundBridgeAudioNodeHealth } from "./bridge-node-options";

const LIVE_AUDIO_NODE_RECREATE_BLOCKS = 16;
const LIVE_AUDIO_NODE_RECREATE_ATTEMPTS = 1;

export type LivePerformanceAudioNodeRecreateReason = "process-timeout";

export interface LivePerformanceAudioNodeRecreateTarget {
  readonly health: SoundBridgeAudioNodeHealth;
}

export interface LivePerformanceAudioNodeRecreateOptions<T = unknown> {
  node: LivePerformanceAudioNodeRecreateTarget;
  recreate: (health: SoundBridgeAudioNodeHealth) => T | Promise<T>;
  recreateBlocks?: number;
  maxRecreateAttempts?: number;
}

export interface LivePerformanceAudioNodeRecreateSnapshot<T = unknown> {
  applied: boolean;
  active: boolean;
  exhausted: boolean;
  reason?: LivePerformanceAudioNodeRecreateReason;
  dryBlocks: number;
  recreateBlocks: number;
  recreateBlocksRemaining: number;
  recreateAttempts: number;
  maxRecreateAttempts: number;
  health: SoundBridgeAudioNodeHealth;
  result?: T;
  error?: unknown;
}

export class LivePerformanceAudioNodeRecreateController<T = unknown> {
  readonly node: LivePerformanceAudioNodeRecreateTarget;
  readonly recreateBlocks: number;
  readonly maxRecreateAttempts: number;
  private readonly recreateTarget: (health: SoundBridgeAudioNodeHealth) => T | Promise<T>;
  private recreateAttempts = 0;
  private dryBlocks = 0;
  private lastFallbackOutputBlocks?: number;
  private activeReason?: LivePerformanceAudioNodeRecreateReason;

  constructor(options: LivePerformanceAudioNodeRecreateOptions<T>) {
    this.node = options.node;
    this.recreateTarget = options.recreate;
    this.recreateBlocks = boundedInteger(options.recreateBlocks, LIVE_AUDIO_NODE_RECREATE_BLOCKS, 0, 4096);
    this.maxRecreateAttempts = boundedInteger(options.maxRecreateAttempts, LIVE_AUDIO_NODE_RECREATE_ATTEMPTS, 0, 1024);
  }

  async record(health: SoundBridgeAudioNodeHealth = this.node.health): Promise<LivePerformanceAudioNodeRecreateSnapshot<T>> {
    const reason = this.recreateReason(health);
    if (reason === undefined) {
      this.resetWindow(health);
      return this.snapshot(false, false, false, undefined, health);
    }
    if (reason !== this.activeReason) {
      this.activeReason = reason;
      this.dryBlocks = 0;
      this.lastFallbackOutputBlocks = boundedInteger(health.fallbackOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER);
    } else {
      this.recordDryBlocks(health);
    }
    const exhausted = this.recreateAttempts >= this.maxRecreateAttempts;
    if (!exhausted && this.dryBlocks >= this.recreateBlocks) {
      this.recreateAttempts = Math.min(1024, this.recreateAttempts + 1);
      try {
        const result = await this.recreateTarget(health);
        const snapshot = this.snapshot(true, true, this.recreateAttempts >= this.maxRecreateAttempts, reason, this.node.health, result);
        this.resetWindow(this.node.health);
        return snapshot;
      } catch (error) {
        return this.snapshot(false, true, this.recreateAttempts >= this.maxRecreateAttempts, reason, health, undefined, error);
      }
    }
    return this.snapshot(false, true, exhausted, reason, health);
  }

  reset(): void {
    this.recreateAttempts = 0;
    this.dryBlocks = 0;
    this.lastFallbackOutputBlocks = undefined;
    this.activeReason = undefined;
  }

  private recreateReason(health: SoundBridgeAudioNodeHealth): LivePerformanceAudioNodeRecreateReason | undefined {
    return health.bypassed && health.unhealthyReason === "process-timeout" ? "process-timeout" : undefined;
  }

  private recordDryBlocks(health: SoundBridgeAudioNodeHealth): void {
    const fallbackBlocks = boundedInteger(health.fallbackOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER);
    if (this.lastFallbackOutputBlocks === undefined) {
      this.lastFallbackOutputBlocks = fallbackBlocks;
      return;
    }
    this.dryBlocks = Math.min(Number.MAX_SAFE_INTEGER, this.dryBlocks + Math.max(0, fallbackBlocks - this.lastFallbackOutputBlocks));
    this.lastFallbackOutputBlocks = fallbackBlocks;
  }

  private resetWindow(health: SoundBridgeAudioNodeHealth): void {
    this.dryBlocks = 0;
    this.lastFallbackOutputBlocks = boundedInteger(health.fallbackOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER);
    this.activeReason = undefined;
  }

  private snapshot(
    applied: boolean,
    active: boolean,
    exhausted: boolean,
    reason: LivePerformanceAudioNodeRecreateReason | undefined,
    health: SoundBridgeAudioNodeHealth,
    result?: T,
    error?: unknown
  ): LivePerformanceAudioNodeRecreateSnapshot<T> {
    return {
      applied,
      active,
      exhausted,
      reason,
      dryBlocks: this.dryBlocks,
      recreateBlocks: this.recreateBlocks,
      recreateBlocksRemaining: Math.max(0, this.recreateBlocks - this.dryBlocks),
      recreateAttempts: this.recreateAttempts,
      maxRecreateAttempts: this.maxRecreateAttempts,
      health,
      result,
      error
    };
  }
}

export function createLivePerformanceAudioNodeRecreateController<T = unknown>(
  options: LivePerformanceAudioNodeRecreateOptions<T>
): LivePerformanceAudioNodeRecreateController<T> {
  return new LivePerformanceAudioNodeRecreateController(options);
}
