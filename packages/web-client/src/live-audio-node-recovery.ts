import { boundedInteger } from "./bridge-node-options";
import type { SoundBridgeAudioNodeHealth } from "./bridge-node-options";

const LIVE_AUDIO_NODE_RECOVERY_BLOCKS = 16;
const LIVE_AUDIO_NODE_RECOVERY_ATTEMPTS = 1;

export type LivePerformanceAudioNodeRecoveryReason = "audio-error" | "render-budget" | "transport-pressure";

export interface LivePerformanceAudioNodeRecoveryTarget {
  readonly health: SoundBridgeAudioNodeHealth;
  retry(): boolean;
}

export interface LivePerformanceAudioNodeRecoveryOptions {
  node: LivePerformanceAudioNodeRecoveryTarget;
  recoveryBlocks?: number;
  maxRetryAttempts?: number;
  recoverTransportPressure?: boolean;
  recoverRenderBudget?: boolean;
  recoverAudioErrors?: boolean;
}

export interface LivePerformanceAudioNodeRecoverySnapshot {
  applied: boolean;
  active: boolean;
  exhausted: boolean;
  reason?: LivePerformanceAudioNodeRecoveryReason;
  dryBlocks: number;
  recoveryBlocks: number;
  recoveryBlocksRemaining: number;
  retryAttempts: number;
  maxRetryAttempts: number;
  health: SoundBridgeAudioNodeHealth;
}

export class LivePerformanceAudioNodeRecoveryController {
  readonly node: LivePerformanceAudioNodeRecoveryTarget;
  readonly recoveryBlocks: number;
  readonly maxRetryAttempts: number;
  readonly recoverTransportPressure: boolean;
  readonly recoverRenderBudget: boolean;
  readonly recoverAudioErrors: boolean;
  private retryAttempts = 0;
  private dryBlocks = 0;
  private lastFallbackOutputBlocks?: number;
  private activeReason?: LivePerformanceAudioNodeRecoveryReason;

  constructor(options: LivePerformanceAudioNodeRecoveryOptions) {
    this.node = options.node;
    this.recoveryBlocks = boundedInteger(options.recoveryBlocks, LIVE_AUDIO_NODE_RECOVERY_BLOCKS, 0, 4096);
    this.maxRetryAttempts = boundedInteger(options.maxRetryAttempts, LIVE_AUDIO_NODE_RECOVERY_ATTEMPTS, 0, 1024);
    this.recoverTransportPressure = options.recoverTransportPressure !== false;
    this.recoverRenderBudget = options.recoverRenderBudget !== false;
    this.recoverAudioErrors = options.recoverAudioErrors === true;
  }

  record(health: SoundBridgeAudioNodeHealth = this.node.health): LivePerformanceAudioNodeRecoverySnapshot {
    const reason = this.recoveryReason(health);
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
    const exhausted = this.retryAttempts >= this.maxRetryAttempts;
    if (!exhausted && this.dryBlocks >= this.recoveryBlocks) {
      const applied = this.node.retry();
      if (applied) {
        this.retryAttempts = Math.min(1024, this.retryAttempts + 1);
        const snapshot = this.snapshot(true, true, this.retryAttempts >= this.maxRetryAttempts, reason, this.node.health);
        this.resetWindow(this.node.health);
        return snapshot;
      }
    }
    return this.snapshot(false, true, exhausted, reason, health);
  }

  reset(): void {
    this.retryAttempts = 0;
    this.dryBlocks = 0;
    this.lastFallbackOutputBlocks = undefined;
    this.activeReason = undefined;
  }

  private recoveryReason(health: SoundBridgeAudioNodeHealth): LivePerformanceAudioNodeRecoveryReason | undefined {
    if (!health.bypassed) return undefined;
    if (this.recoverTransportPressure && health.transportPressureAutoBypassed) return "transport-pressure";
    if (this.recoverRenderBudget && health.renderBudgetAutoBypassed) return "render-budget";
    if (this.recoverAudioErrors && health.audioErrorAutoBypassed) return "audio-error";
    return undefined;
  }

  private recordDryBlocks(health: SoundBridgeAudioNodeHealth): void {
    const fallbackBlocks = boundedInteger(health.fallbackOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER);
    if (this.lastFallbackOutputBlocks === undefined) {
      this.lastFallbackOutputBlocks = fallbackBlocks;
      return;
    }
    this.dryBlocks = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.dryBlocks + Math.max(0, fallbackBlocks - this.lastFallbackOutputBlocks)
    );
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
    reason: LivePerformanceAudioNodeRecoveryReason | undefined,
    health: SoundBridgeAudioNodeHealth
  ): LivePerformanceAudioNodeRecoverySnapshot {
    return {
      applied,
      active,
      exhausted,
      reason,
      dryBlocks: this.dryBlocks,
      recoveryBlocks: this.recoveryBlocks,
      recoveryBlocksRemaining: Math.max(0, this.recoveryBlocks - this.dryBlocks),
      retryAttempts: this.retryAttempts,
      maxRetryAttempts: this.maxRetryAttempts,
      health
    };
  }
}

export function createLivePerformanceAudioNodeRecoveryController(
  options: LivePerformanceAudioNodeRecoveryOptions
): LivePerformanceAudioNodeRecoveryController {
  return new LivePerformanceAudioNodeRecoveryController(options);
}
