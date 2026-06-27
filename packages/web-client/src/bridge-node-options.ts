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
  statsIntervalBlocks?: number;
  audioTransport?: "binary" | "json";
  audioRequestTimeoutMs?: number;
  audioTransferMode?: "auto" | "message" | "shared";
  sharedBufferBlocks?: number;
  maxBlockFrames?: number;
  maxConsecutiveRenderBudgetMisses?: number;
  maxConsecutiveAudioErrors?: number;
  maxConsecutiveTransportPressureEvents?: number;
  bypassed?: boolean;
  workletUrl?: string;
}

export interface LivePerformanceAudioNodeOptions extends SoundBridgeAudioNodeOptions {}

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
  responseJitterSamples: number;
  responseDeadlineMisses: number;
  responseDeadlineMissesSinceLastStats: number;
  staleOutputBlocks: number;
  droppedInputBlocks: number;
  underruns: number;
  sharedAudioEnabled: boolean;
  sharedInputDroppedBlocks: number;
  sharedOutputDroppedBlocks: number;
  transportPressureEvents: number;
  consecutiveTransportPressureEvents: number;
  maxConsecutiveTransportPressureEvents: number;
  transportPressureAutoBypassed: boolean;
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
  unhealthyReason?: "audio-error" | "render-budget-exceeded" | "transport-pressure" | "destroyed";
}

const LIVE_AUDIO_NODE_MAX_IN_FLIGHT_BLOCKS = 4;
const LIVE_AUDIO_NODE_MAX_QUEUED_OUTPUT_BLOCKS = 8;
const LIVE_AUDIO_NODE_OUTPUT_LATENCY_BLOCKS = 2;
const LIVE_AUDIO_NODE_MAX_OUTPUT_LATENCY_BLOCKS = 4;
const LIVE_AUDIO_NODE_LATENCY_RECOVERY_BLOCKS = 128;
const LIVE_AUDIO_NODE_LATENCY_PRESSURE_THRESHOLD_BLOCKS = 2;
const LIVE_AUDIO_NODE_STATS_INTERVAL_BLOCKS = 32;
const LIVE_AUDIO_NODE_SHARED_BUFFER_BLOCKS = 4;
const LIVE_AUDIO_NODE_AUDIO_REQUEST_TIMEOUT_MS = 250;

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
    statsIntervalBlocks: boundedInteger(options.statsIntervalBlocks, LIVE_AUDIO_NODE_STATS_INTERVAL_BLOCKS, 8, 1024),
    audioTransport: options.audioTransport === "json" ? "json" : "binary",
    audioRequestTimeoutMs: boundedInteger(options.audioRequestTimeoutMs, LIVE_AUDIO_NODE_AUDIO_REQUEST_TIMEOUT_MS, 0, 60000),
    audioTransferMode: options.audioTransferMode ?? "auto",
    sharedBufferBlocks,
    maxBlockFrames: boundedInteger(options.maxBlockFrames, 128, 1, 8192),
    maxConsecutiveRenderBudgetMisses: boundedInteger(options.maxConsecutiveRenderBudgetMisses, 2, 0, 1024),
    maxConsecutiveAudioErrors: boundedInteger(options.maxConsecutiveAudioErrors, 1, 0, 1024),
    maxConsecutiveTransportPressureEvents: boundedInteger(options.maxConsecutiveTransportPressureEvents, 3, 0, 1024)
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

export function combinedAudioNodeLatencySamples(pluginLatencySamples: number, transportLatencySamples: number): number {
  return Math.min(1_048_576, pluginLatencySamples + transportLatencySamples);
}

export function audioNodeLatencyMilliseconds(samples: number, sampleRate: number): number {
  const boundedSamples = boundedInteger(samples, 0, 0, 1_048_576);
  const boundedSampleRate = boundedInteger(sampleRate, 48000, 1, 384000);
  return Number(((boundedSamples / boundedSampleRate) * 1000).toFixed(3));
}
