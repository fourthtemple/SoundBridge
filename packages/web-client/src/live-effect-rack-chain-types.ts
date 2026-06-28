import type { LiveEffectBlockRequest, LiveEffectBlockResponse, LiveEffectRackHealth } from "./live-effect-rack-types";
import type { LiveEffectRackDeadlinePressure, LiveEffectRackDeadlinePressureSkipOptions } from "./live-effect-rack-scheduler";

export type LiveEffectRackChainDryReason =
  | "chain-bypass"
  | "chain-deadline-pressure"
  | "chain-empty"
  | "chain-process-budget-exceeded"
  | "chain-process-timeout"
  | "chain-stage-bypass"
  | "chain-stage-error"
  | "chain-stale-input";

export interface LiveEffectRackChainStage {
  readonly health?: Partial<LiveEffectRackHealth>;
  processBlock(request: LiveEffectBlockRequest): Promise<LiveEffectBlockResponse>;
}

export interface LiveEffectRackChainOptions {
  stages: ArrayLike<LiveEffectRackChainStage>;
  bypassed?: boolean;
  wetMix?: number;
  sampleRate?: number;
  maxStages?: number;
  outputChannels?: number;
  maxBlockSize?: number;
  processBudgetMs?: number;
  processTimeoutMs?: number;
  maxConsecutiveProcessBudgetMisses?: number;
  processBudgetRecoveryBlocks?: number;
  processTimeoutRecoveryBlocks?: number;
  transitionFadeSamples?: number;
  nowMs?: () => number;
}

export interface LivePerformanceRackChainOptions extends LiveEffectRackChainOptions {
  processBudgetBlocks?: number;
  processTimeoutBlocks?: number;
  transitionFadeBlocks?: number;
}

export interface LiveEffectRackChainProcessOptions extends LiveEffectRackDeadlinePressureSkipOptions {
  wetMix?: number;
  stageWetMixes?: ArrayLike<number>;
}

export interface LiveEffectRackChainStageResult {
  index: number;
  bypassed: boolean;
  healthy: boolean;
  instanceId?: string;
  renderEngine?: string;
  lastDryReason?: string;
  durationMs?: number;
  error?: unknown;
}

export interface LiveEffectRackChainResponse extends LiveEffectBlockResponse {
  stageCount: number;
  processedStages: number;
  failedStageIndex?: number;
  stageResults: LiveEffectRackChainStageResult[];
  chainProcessDurationMs?: number;
  chainProcessBudgetMs?: number;
  chainProcessBudgetExceeded: boolean;
  chainProcessTimeoutMs?: number;
  chainProcessTimedOut: boolean;
  chainProcessBudgetMisses: number;
  chainProcessBudgetTripped: boolean;
  chainUnhealthyReason?: "process-budget-exceeded" | "process-timeout";
}

export interface LiveEffectRackChainHealth {
  bypassed: boolean;
  wetMix: number;
  sampleRate: number;
  latencySamples: number;
  latencyMs: number;
  tailSamples: number;
  tailMs: number;
  infiniteTail: boolean;
  healthy: boolean;
  stageHealthy: boolean;
  stageCount: number;
  processedStages: number;
  failedStageIndex?: number;
  stageResults: LiveEffectRackChainStageResult[];
  lastStageError?: unknown;
  lastDryReason?: LiveEffectRackChainDryReason;
  dryOutputBlocks: number;
  bypassDryOutputBlocks: number;
  processBudgetMs: number;
  processTimeoutMs: number;
  maxConsecutiveProcessBudgetMisses: number;
  processBudgetRecoveryBlocks: number;
  processTimeoutRecoveryBlocks: number;
  transitionFadeSamples: number;
  processBudgetMisses: number;
  lastProcessDurationMs?: number;
  lastProcessBudgetMs?: number;
  processBudgetExceeded: boolean;
  processTimedOut: boolean;
  lastResponseDeadlineLeadMs?: number;
  lastResponseDeadlineLeadBlocks?: number;
  responseJitterBlocks: number;
  responseDeadlineMisses: number;
  processBudgetTripped: boolean;
  processTimeoutTripped: boolean;
  recoveryDryBlocks: number;
  timeoutRecoveryDryBlocks: number;
  recoveryDryBlocksRemaining: number;
  unhealthyReason?: "process-budget-exceeded" | "process-timeout";
  lastError?: unknown;
}

export interface LiveEffectRackChainDryOutputEventDetail {
  response: LiveEffectRackChainResponse;
  health: LiveEffectRackChainHealth;
  reason: LiveEffectRackChainDryReason;
  deadlinePressure?: LiveEffectRackDeadlinePressure;
}
