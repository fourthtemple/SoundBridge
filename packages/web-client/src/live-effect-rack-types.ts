import type { AudioBlockResponse, HostTransportState, PluginMetadata } from "../../protocol/src/messages";
import type { SoundBridgeClient, BinaryAudioBlockRequest } from "./client";
import type { LiveEffectDryReason } from "./live-effect-rack-metrics";

export interface LiveEffectRackOptions {
  client: SoundBridgeClient;
  plugin: PluginMetadata;
  sampleRate: number;
  maxBlockSize: number;
  inputChannels?: number;
  outputChannels?: number;
  audioTransport?: "binary" | "json";
  maxInputAgeMs?: number;
  maxInFlightBlocks?: number;
  processBudgetMs?: number;
  processTimeoutMs?: number;
  transitionFadeSamples?: number;
  wetMix?: number;
  maxConsecutiveProcessBudgetMisses?: number;
  maxConsecutiveRenderBudgetMisses?: number;
  processBudgetRecoveryBlocks?: number;
  renderBudgetRecoveryBlocks?: number;
  processTimeoutRecoveryBlocks?: number;
  maxProcessTimeoutRecoveries?: number;
}

export interface LivePerformanceRackOptions extends LiveEffectRackOptions {
  maxInputAgeBlocks?: number;
  processBudgetBlocks?: number;
  processTimeoutBlocks?: number;
  transitionFadeBlocks?: number;
}

export interface LiveEffectBlockRequest {
  blockId: number;
  channels: ArrayLike<number>[];
  sampleRate?: number;
  inputBuses?: BinaryAudioBlockRequest["inputBuses"];
  transport?: HostTransportState;
  timestamp?: number;
  wetMix?: number;
}

export interface LiveEffectBlockResponse extends Omit<AudioBlockResponse, "channels"> {
  channels: ArrayLike<number>[];
  bypassed: boolean;
  healthy: boolean;
  error?: unknown;
}

export interface LiveEffectRackProcessOptions {
  skipOnDeadlinePressure?: boolean;
}

export interface LiveEffectRackHealth {
  bypassed: boolean;
  healthy: boolean;
  instanceId?: string;
  lastError?: unknown;
  latencySamples: number;
  pluginLatencySamples: number;
  transportLatencySamples: number;
  reportedLatencySamples: number;
  latencyMs: number;
  pluginLatencyMs: number;
  transportLatencyMs: number;
  reportedLatencyMs: number;
  processBudgetMisses: number;
  lastProcessDurationMs?: number;
  lastProcessBudgetMs?: number;
  processBudgetExceeded: boolean;
  lastResponseDeadlineLeadMs?: number; lastResponseDeadlineLeadBlocks?: number; responseJitterBlocks: number; responseDeadlineMisses: number;
  renderBudgetMisses: number;
  lastRenderDurationMs?: number;
  lastRenderBudgetMs?: number;
  renderBudgetExceeded: boolean;
  lastRenderTimeoutMs?: number;
  lastRenderTimeoutBudgetMs?: number;
  lastRenderTimeoutBudgetDeltaMs?: number;
  renderTimeouts: number;
  consecutiveRenderTimeouts: number;
  renderQuarantined: boolean;
  lastDryReason?: LiveEffectDryReason;
  unhealthyReason?: "processing-error" | "process-timeout" | "process-budget-exceeded" | "render-budget-exceeded" | "destroyed";
  recoveryDryBlocks: number;
  recoveryInProgress: boolean;
  processBudgetRecoveryBlocks: number;
  renderBudgetRecoveryBlocks: number;
  processTimeoutRecoveryBlocks: number;
  processTimeoutRecoveryAttempts: number;
  maxProcessTimeoutRecoveries: number;
  processBudgetMs: number;
  processTimeoutMs: number;
  maxInputAgeMs: number;
  inFlightBlocks: number;
  maxInFlightBlocks: number;
  droppedInputBlocks: number;
  staleInputBlocks: number;
  staleOutputBlocks: number;
  transitionFadeSamples: number;
  wetMix: number;
}
