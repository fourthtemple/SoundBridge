import type { AudioBlockResponse } from "../../protocol/src/messages";
import { SoundBridgeClient } from "./client";

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
  audioTransport?: "binary" | "json";
  audioRequestTimeoutMs?: number;
  audioTransferMode?: "auto" | "message" | "shared";
  sharedBufferBlocks?: number;
  maxBlockFrames?: number;
  workletUrl?: string;
}

export interface LivePerformanceAudioNodeOptions extends SoundBridgeAudioNodeOptions {}

export interface SoundBridgeAudioNodeHealth {
  healthy: boolean;
  instanceId: string;
  audioTransport: "binary" | "json";
  audioRequestTimeoutMs: number;
  inFlightBlocks: number;
  maxInFlightBlocks: number;
  lastRenderEngine?: string;
  lastRenderDurationMs?: number;
  lastRenderBudgetMs?: number;
  renderBudgetExceeded: boolean;
  renderBudgetMisses: number;
  audioErrors: number;
  lastAudioError?: unknown;
  unhealthyReason?: "audio-error" | "destroyed";
}

const LIVE_AUDIO_NODE_MAX_IN_FLIGHT_BLOCKS = 4;
const LIVE_AUDIO_NODE_MAX_QUEUED_OUTPUT_BLOCKS = 8;
const LIVE_AUDIO_NODE_OUTPUT_LATENCY_BLOCKS = 2;
const LIVE_AUDIO_NODE_MAX_OUTPUT_LATENCY_BLOCKS = 4;
const LIVE_AUDIO_NODE_LATENCY_RECOVERY_BLOCKS = 128;
const LIVE_AUDIO_NODE_LATENCY_PRESSURE_THRESHOLD_BLOCKS = 2;
const LIVE_AUDIO_NODE_SHARED_BUFFER_BLOCKS = 4;
const LIVE_AUDIO_NODE_AUDIO_REQUEST_TIMEOUT_MS = 250;

export function createLivePerformanceAudioNodeOptions(options: LivePerformanceAudioNodeOptions): SoundBridgeAudioNodeOptions {
  const maxQueuedOutputBlocks = boundedInteger(
    options.maxQueuedOutputBlocks,
    LIVE_AUDIO_NODE_MAX_QUEUED_OUTPUT_BLOCKS,
    1,
    64
  );
  const outputLatencyBlocks = boundedInteger(
    options.outputLatencyBlocks,
    Math.min(LIVE_AUDIO_NODE_OUTPUT_LATENCY_BLOCKS, maxQueuedOutputBlocks),
    1,
    maxQueuedOutputBlocks
  );
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
    latencyPressureThresholdBlocks: boundedInteger(
      options.latencyPressureThresholdBlocks,
      LIVE_AUDIO_NODE_LATENCY_PRESSURE_THRESHOLD_BLOCKS,
      1,
      64
    ),
    audioTransport: options.audioTransport === "json" ? "json" : "binary",
    audioRequestTimeoutMs: boundedInteger(options.audioRequestTimeoutMs, LIVE_AUDIO_NODE_AUDIO_REQUEST_TIMEOUT_MS, 0, 60000),
    audioTransferMode: options.audioTransferMode ?? "auto",
    sharedBufferBlocks,
    maxBlockFrames: boundedInteger(options.maxBlockFrames, 128, 1, 8192)
  };
}

export class SoundBridgeAudioNode extends EventTarget {
  readonly node: AudioWorkletNode;

  private readonly client: SoundBridgeClient;
  private readonly instanceId: string;
  private readonly sampleRate: number;
  private inFlightBlocks = 0;
  private destroyed = false;
  private readonly maxInFlightBlocks: number;
  private readonly audioTransport: "binary" | "json";
  private readonly audioRequestTimeoutMs: number;
  private lastRenderEngine?: string;
  private lastRenderDurationMs?: number;
  private lastRenderBudgetMs?: number;
  private renderBudgetExceeded = false;
  private renderBudgetMisses = 0;
  private audioErrors = 0;
  private lastAudioError?: unknown;
  private unhealthyReason?: SoundBridgeAudioNodeHealth["unhealthyReason"];

  private constructor(context: AudioContext, client: SoundBridgeClient, options: Required<SoundBridgeAudioNodeOptions>) {
    super();
    this.client = client;
    this.instanceId = options.instanceId;
    this.sampleRate = context.sampleRate;
    this.maxInFlightBlocks = options.maxInFlightBlocks;
    this.audioTransport = options.audioTransport;
    this.audioRequestTimeoutMs = options.audioRequestTimeoutMs;
    this.node = new AudioWorkletNode(context, "soundbridge-audio-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: options.inputChannels,
      channelCountMode: "explicit",
      outputChannelCount: [options.outputChannels],
      processorOptions: {
        instanceId: options.instanceId,
        inputChannels: options.inputChannels,
        outputChannels: options.outputChannels,
        maxInFlightBlocks: options.maxInFlightBlocks,
        maxQueuedOutputBlocks: options.maxQueuedOutputBlocks,
        outputLatencyBlocks: options.outputLatencyBlocks,
        minOutputLatencyBlocks: options.minOutputLatencyBlocks,
        maxOutputLatencyBlocks: options.maxOutputLatencyBlocks,
        adaptiveOutputLatency: options.adaptiveOutputLatency,
        latencyMissThresholdBlocks: options.latencyMissThresholdBlocks,
        latencyRecoveryBlocks: options.latencyRecoveryBlocks,
        targetResponseDeadlineLeadBlocks: options.targetResponseDeadlineLeadBlocks,
        latencyPressureThresholdBlocks: options.latencyPressureThresholdBlocks
      }
    });
    this.node.port.onmessage = (event) => this.handleWorkletMessage(event.data);
    const transportConnection = client.createAudioWorkletTransportConnection({
      instanceId: options.instanceId,
      sampleRate: context.sampleRate,
      maxInFlightBlocks: options.maxInFlightBlocks,
      audioTransport: options.audioTransport,
      audioRequestTimeoutMs: options.audioRequestTimeoutMs,
      audioTransferMode: options.audioTransferMode,
      channels: Math.max(options.inputChannels, options.outputChannels),
      maxBlockFrames: options.maxBlockFrames,
      sharedBufferBlocks: options.sharedBufferBlocks
    });
    if (transportConnection) {
      this.node.port.postMessage(
        { type: "connect-transport", port: transportConnection.port, sharedAudio: transportConnection.sharedAudio },
        [transportConnection.port]
      );
    }
  }

  static async create(
    context: AudioContext,
    client: SoundBridgeClient,
    options: SoundBridgeAudioNodeOptions
  ): Promise<SoundBridgeAudioNode> {
    const normalized: Required<SoundBridgeAudioNodeOptions> = {
      instanceId: options.instanceId,
      inputChannels: Math.max(1, Math.min(32, Math.floor(options.inputChannels ?? 2))),
      outputChannels: Math.max(1, Math.min(32, Math.floor(options.outputChannels ?? 2))),
      maxInFlightBlocks: boundedInteger(options.maxInFlightBlocks, 8, 1, 64),
      maxQueuedOutputBlocks: boundedInteger(options.maxQueuedOutputBlocks, 16, 1, 64),
      outputLatencyBlocks: 1,
      minOutputLatencyBlocks: 1,
      maxOutputLatencyBlocks: 4,
      adaptiveOutputLatency: options.adaptiveOutputLatency !== false,
      latencyMissThresholdBlocks: boundedInteger(options.latencyMissThresholdBlocks, 2, 1, 32),
      latencyRecoveryBlocks: boundedInteger(options.latencyRecoveryBlocks, 512, 32, 8192),
      targetResponseDeadlineLeadBlocks: boundedInteger(options.targetResponseDeadlineLeadBlocks, 1, 0, 16),
      latencyPressureThresholdBlocks: boundedInteger(options.latencyPressureThresholdBlocks, 4, 1, 64),
      audioTransport: options.audioTransport === "json" ? "json" : "binary",
      audioRequestTimeoutMs: boundedInteger(options.audioRequestTimeoutMs, 2000, 0, 60000),
      audioTransferMode: options.audioTransferMode ?? "auto",
      sharedBufferBlocks: boundedInteger(options.sharedBufferBlocks, 8, 2, 64),
      maxBlockFrames: boundedInteger(options.maxBlockFrames, 128, 1, 8192),
      workletUrl: options.workletUrl ?? "/packages/web-client/dist/soundbridge-worklet.js"
    };
    normalized.outputLatencyBlocks = boundedInteger(
      options.outputLatencyBlocks,
      Math.min(2, normalized.maxQueuedOutputBlocks),
      1,
      normalized.maxQueuedOutputBlocks
    );
    normalized.minOutputLatencyBlocks = boundedInteger(
      options.minOutputLatencyBlocks,
      1,
      1,
      normalized.outputLatencyBlocks
    );
    normalized.maxOutputLatencyBlocks = boundedInteger(
      options.maxOutputLatencyBlocks,
      Math.min(normalized.maxQueuedOutputBlocks, Math.max(normalized.outputLatencyBlocks + 2, 4)),
      normalized.outputLatencyBlocks,
      normalized.maxQueuedOutputBlocks
    );
    await context.audioWorklet.addModule(normalized.workletUrl);
    return new SoundBridgeAudioNode(context, client, normalized);
  }

  static createLivePerformance(
    context: AudioContext,
    client: SoundBridgeClient,
    options: LivePerformanceAudioNodeOptions
  ): Promise<SoundBridgeAudioNode> {
    return SoundBridgeAudioNode.create(context, client, createLivePerformanceAudioNodeOptions(options));
  }

  connect(destination: AudioNode, output?: number, input?: number): AudioNode {
    return this.node.connect(destination, output, input);
  }

  disconnect(): void {
    this.node.disconnect();
  }

  get health(): SoundBridgeAudioNodeHealth {
    return {
      healthy: !this.destroyed && this.unhealthyReason === undefined,
      instanceId: this.instanceId,
      audioTransport: this.audioTransport,
      audioRequestTimeoutMs: this.audioRequestTimeoutMs,
      inFlightBlocks: this.inFlightBlocks,
      maxInFlightBlocks: this.maxInFlightBlocks,
      lastRenderEngine: this.lastRenderEngine,
      lastRenderDurationMs: this.lastRenderDurationMs,
      lastRenderBudgetMs: this.lastRenderBudgetMs,
      renderBudgetExceeded: this.renderBudgetExceeded,
      renderBudgetMisses: this.renderBudgetMisses,
      audioErrors: this.audioErrors,
      lastAudioError: this.lastAudioError,
      unhealthyReason: this.unhealthyReason
    };
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.unhealthyReason = "destroyed";
    this.node.port.postMessage({ type: "destroy" });
    await this.client.destroyInstance(this.instanceId);
  }

  private handleWorkletMessage(message: unknown): void {
    if (this.destroyed || !message || typeof message !== "object") {
      return;
    }

    const typed = message as {
      type?: string;
      blockId?: number;
      channels?: Float32Array[] | number[][];
      frames?: number;
      underruns?: number;
      queuedOutputBlocks?: number;
      outputLatencyBlocks?: number;
      minOutputLatencyBlocks?: number;
      maxOutputLatencyBlocks?: number;
      adaptiveOutputLatency?: boolean;
      targetResponseDeadlineLeadBlocks?: number;
      latencyPressureThresholdBlocks?: number;
      latencyMissThresholdBlocks?: number;
      latencyRecoveryBlocks?: number;
      transportLatencySamples?: number;
      latencyIncreases?: number;
      latencyDecreases?: number;
      consecutiveLowDeadlineLeadBlocks?: number;
      latencySafetyBlocks?: number;
      latencySafetyInsertions?: number;
      sharedAudioEnabled?: boolean;
      sharedAudioWakeMode?: string;
      sharedInputQueuedBlocks?: number;
      sharedOutputQueuedBlocks?: number;
      sharedInputDroppedBlocks?: number;
      sharedOutputDroppedBlocks?: number;
      staleOutputBlocks?: number;
      droppedInputBlocks?: number;
      inputBufferAllocations?: number;
      inputBufferReuses?: number;
      pooledInputBuffers?: number;
      outputBufferAllocations?: number;
      outputBufferReuses?: number;
      pooledOutputBuffers?: number;
      inFlightBlocks?: number;
      responseBlocks?: number;
      responseBlocksSinceLastStats?: number;
      responseDeadlineLeadBlocks?: number;
      responseDeadlineLeadMinBlocks?: number;
      responseDeadlineLeadMaxBlocks?: number;
      responseDeadlineLeadSamples?: number;
      responseJitterBlocks?: number;
      responseJitterSamples?: number;
      responseDeadlineMisses?: number;
      responseDeadlineMissesSinceLastStats?: number;
      renderDurationMs?: number;
      renderBudgetMs?: number;
      renderBudgetExceeded?: boolean;
      renderEngine?: string;
      error?: unknown;
    };

    if (typed.type === "stats") {
      this.dispatchEvent(new CustomEvent("stats", { detail: typed }));
      return;
    }

    if (typed.type === "process-diagnostics") {
      this.recordProcessDiagnostics(typed);
      this.dispatchEvent(new CustomEvent("process-diagnostics", { detail: typed }));
      return;
    }

    if (typed.type === "audio-error") {
      this.recordAudioError(typed.error ?? typed);
      this.dispatchEvent(new CustomEvent("audio-error", { detail: typed.error ?? typed }));
      return;
    }

    if (typed.type !== "process" || typeof typed.blockId !== "number" || !Array.isArray(typed.channels)) {
      return;
    }

    if (this.inFlightBlocks >= this.maxInFlightBlocks) {
      this.node.port.postMessage({ type: "dropped", blockId: typed.blockId });
      return;
    }

    this.inFlightBlocks += 1;
    const binaryChannels = typed.channels as ArrayLike<number>[];
    const requestedFrames = Math.floor(Number(typed.frames ?? binaryChannels[0]?.length ?? 128));
    const frames = Number.isFinite(requestedFrames) ? Math.max(1, requestedFrames) : 128;
    const requestedSamplePosition = Math.floor(typed.blockId * frames);
    const samplePosition = Number.isFinite(requestedSamplePosition)
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, requestedSamplePosition))
      : 0;
    const request = {
      instanceId: this.instanceId,
      blockId: typed.blockId,
      sampleRate: this.sampleRate,
      channels: binaryChannels,
      transport: {
        playing: true,
        samplePosition
      },
      timestamp: performance.now(),
      renderTimeoutMs: this.audioRequestTimeoutMs > 0 ? this.audioRequestTimeoutMs : undefined
    };
    const processed =
      this.audioTransport === "binary"
        ? this.client.processAudioBlockBinary(request, this.audioRequestTimeoutMs)
        : this.client.processAudioBlock(
            { ...request, channels: binaryChannels.map((channel) => Array.from(channel)) },
            this.audioRequestTimeoutMs
          );

    processed
      .then((response: AudioBlockResponse) => {
        if (this.destroyed) {
          return;
        }
        this.clearAudioError();
        if (typeof response.renderEngine === "string") {
          const diagnostics = {
            blockId: response.blockId,
            renderEngine: response.renderEngine,
            renderDurationMs: response.renderDurationMs,
            renderBudgetMs: response.renderBudgetMs,
            renderBudgetExceeded: response.renderBudgetExceeded
          };
          this.recordProcessDiagnostics(diagnostics);
          this.dispatchEvent(
            new CustomEvent("process-diagnostics", {
              detail: diagnostics
            })
          );
        }
        this.node.port.postMessage({
          type: "processed",
          blockId: response.blockId,
          channels: response.channels,
          latencySamples: response.latencySamples,
          renderDurationMs: response.renderDurationMs,
          renderBudgetMs: response.renderBudgetMs,
          renderBudgetExceeded: response.renderBudgetExceeded
        });
      })
      .catch((error) => {
        if (this.destroyed) {
          return;
        }
        this.recordAudioError(error);
        this.dispatchEvent(new CustomEvent("audio-error", { detail: error }));
        this.node.port.postMessage({ type: "audio-error", blockId: typed.blockId, error: String(error instanceof Error ? error.message : error) });
      })
      .finally(() => {
        this.inFlightBlocks -= 1;
      });
  }

  private recordProcessDiagnostics(diagnostics: {
    renderEngine?: unknown;
    renderDurationMs?: unknown;
    renderBudgetMs?: unknown;
    renderBudgetExceeded?: unknown;
  }): void {
    this.clearAudioError();
    if (typeof diagnostics.renderEngine === "string") {
      this.lastRenderEngine = diagnostics.renderEngine;
    }
    this.lastRenderDurationMs = boundedOptionalNumber(diagnostics.renderDurationMs, 0, 60000);
    this.lastRenderBudgetMs = boundedOptionalNumber(diagnostics.renderBudgetMs, 0, 60000);
    this.renderBudgetExceeded = diagnostics.renderBudgetExceeded === true;
    this.renderBudgetMisses = this.renderBudgetExceeded ? Math.min(1024, this.renderBudgetMisses + 1) : 0;
    if (this.renderBudgetExceeded) {
      this.dispatchEvent(new CustomEvent("render-budget-exceeded", { detail: { diagnostics, health: this.health } }));
    }
  }

  private recordAudioError(error: unknown): void {
    this.audioErrors = Math.min(1024, this.audioErrors + 1);
    this.lastAudioError = error;
    this.unhealthyReason = "audio-error";
  }

  private clearAudioError(): void {
    if (this.unhealthyReason === "audio-error") {
      this.lastAudioError = undefined;
      this.unhealthyReason = undefined;
    }
  }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const integer = Math.floor(Number(value ?? fallback));
  return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
}

function boundedOptionalNumber(value: unknown, min: number, max: number): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : undefined;
}
