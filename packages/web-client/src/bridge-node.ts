import type { AudioBlockResponse } from "../../protocol/src/messages";
import {
  audioNodeLatencyMilliseconds,
  boundedAudioNodeTransportPressureReasons,
  boundedInteger,
  boundedOptionalNumber,
  combinedAudioNodeLatencySamples,
  createLivePerformanceAudioNodeOptions,
  shouldAutoBypassAudioNodeTransportPressure
} from "./bridge-node-options";
import type { LivePerformanceAudioNodeOptions, SoundBridgeAudioNodeFallbackOutputEventDetail, SoundBridgeAudioNodeFallbackReason, SoundBridgeAudioNodeHealth, SoundBridgeAudioNodeOptions, SoundBridgeAudioNodeProcessTimeoutEventDetail, SoundBridgeAudioNodeTransportPressureReason } from "./bridge-node-options";
import { SoundBridgeClient } from "./client";
import { isRenderDeadlineProtocolError } from "./live-effect-rack-metrics";
import { liveTransportForBlock } from "./live-transport";

export { LivePerformanceAudioNodeCalibrationWindow, boundedAudioNodeTransportPressureReasons, calibrateLivePerformanceAudioNodePolicy, createLivePerformanceAudioNodeCalibrationWindow, createLivePerformanceAudioNodeOptions, createLivePerformanceAudioNodePolicy, livePerformanceAudioNodeOptionsFromCalibration, refreshLivePerformanceAudioNodeLatencyFromCalibration, shouldAutoBypassAudioNodeTransportPressure } from "./bridge-node-options";
export type { LivePerformanceAudioNodeCalibration, LivePerformanceAudioNodeCalibrationHealthSample, LivePerformanceAudioNodeCalibrationOptions, LivePerformanceAudioNodeCalibrationWindowOptions, LivePerformanceAudioNodeCalibrationWindowSnapshot, LivePerformanceAudioNodeLatencyRefresher, LivePerformanceAudioNodeOptions, LivePerformanceAudioNodePolicy, LivePerformanceAudioNodePolicyOptions, SoundBridgeAudioNodeFallbackOutputEventDetail, SoundBridgeAudioNodeFallbackReason, SoundBridgeAudioNodeHealth, SoundBridgeAudioNodeOptions, SoundBridgeAudioNodeProcessTimeoutEventDetail, SoundBridgeAudioNodeTransportPressureReason } from "./bridge-node-options";
export { LivePerformanceAudioNodeAdaptiveLatencyController, createLivePerformanceAudioNodeAdaptiveLatencyController } from "./live-audio-node-adaptive-latency";
export type { LivePerformanceAudioNodeAdaptiveLatencyDirection, LivePerformanceAudioNodeAdaptiveLatencyOptions, LivePerformanceAudioNodeAdaptiveLatencySnapshot, LivePerformanceAudioNodeAdaptiveLatencyTarget, LivePerformanceAudioNodeRecreateRecommendationReason } from "./live-audio-node-adaptive-latency";
export { LivePerformanceAudioNodeRecoveryController, createLivePerformanceAudioNodeRecoveryController } from "./live-audio-node-recovery";
export type { LivePerformanceAudioNodeRecoveryOptions, LivePerformanceAudioNodeRecoveryReason, LivePerformanceAudioNodeRecoverySnapshot, LivePerformanceAudioNodeRecoveryTarget } from "./live-audio-node-recovery";
export { LivePerformanceAudioNodeRecreateController, createLivePerformanceAudioNodeRecreateController } from "./live-audio-node-recreate";
export type { LivePerformanceAudioNodeRecreateOptions, LivePerformanceAudioNodeRecreateReason, LivePerformanceAudioNodeRecreateSnapshot, LivePerformanceAudioNodeRecreateTarget } from "./live-audio-node-recreate";

export class SoundBridgeAudioNode extends EventTarget {
  readonly node: AudioWorkletNode;

  private readonly client: SoundBridgeClient;
  private readonly instanceId: string;
  private readonly sampleRate: number;
  private readonly responseJitterThresholdBlocks: number;
  private inFlightBlocks = 0;
  private destroyed = false;
  private readonly maxInFlightBlocks: number; private readonly maxOutputLatencyBlocks: number; private readonly sharedBufferBlocks: number;
  private readonly audioTransport: "binary" | "json";
  private readonly audioRequestTimeoutMs: number;
  private bypassed = false;
  private bypassEvents = 0;
  private workletInFlightBlocks?: number;
  private queuedOutputBlocks = 0;
  private outputLatencyBlocks = 0;
  private transportLatencySamples = 0;
  private pluginLatencySamples = 0;
  private reportedLatencySamples = 0;
  private latencyIncreases = 0;
  private latencyDecreases = 0;
  private latencyChangeEvents = 0;
  private latencyRefreshes = 0;
  private lastLatencyChangeDirection?: SoundBridgeAudioNodeHealth["lastLatencyChangeDirection"];
  private responseDeadlineLeadSamples = 0;
  private responseJitterBlocks = 0;
  private responseJitterSamples = 0;
  private responseDeadlineMisses = 0;
  private responseDeadlineMissesSinceLastStats = 0;
  private fallbackOutputBlocks = 0;
  private lastFallbackReason?: SoundBridgeAudioNodeFallbackReason;
  private staleOutputBlocks = 0;
  private droppedInputBlocks = 0;
  private underruns = 0;
  private sharedAudioEnabled = false;
  private sharedInputQueuedBlocks = 0; private sharedOutputQueuedBlocks = 0;
  private sharedInputQueuedMaxBlocks = 0; private sharedOutputQueuedMaxBlocks = 0;
  private sharedInputDroppedBlocks = 0; private sharedOutputDroppedBlocks = 0;
  private sharedTransportStats = { inFlightBlocks: 0, inputBufferAllocations: 0, inputBufferReuses: 0, pooledInputBuffers: 0 };
  private transportPressureEvents = 0;
  private consecutiveTransportPressureEvents = 0;
  private maxConsecutiveTransportPressureEvents: number;
  private transportPressureAutoBypassed = false;
  private readonly transportPressureAutoBypassReasons?: SoundBridgeAudioNodeTransportPressureReason[];
  private lastTransportPressureReasons: string[] = [];
  private lastRenderEngine?: string;
  private lastRenderDurationMs?: number;
  private lastRenderBudgetMs?: number;
  private renderBudgetExceeded = false;
  private renderBudgetMisses = 0;
  private maxConsecutiveRenderBudgetMisses: number;
  private renderBudgetAutoBypassed = false;
  private audioErrors = 0;
  private consecutiveAudioErrors = 0;
  private maxConsecutiveAudioErrors: number;
  private audioErrorAutoBypassed = false;
  private lastAudioError?: unknown;
  private unhealthyReason?: SoundBridgeAudioNodeHealth["unhealthyReason"];

  private constructor(context: AudioContext, client: SoundBridgeClient, options: Required<SoundBridgeAudioNodeOptions>) {
    super();
    this.client = client;
    this.instanceId = options.instanceId;
    this.sampleRate = context.sampleRate;
    this.responseJitterThresholdBlocks = options.responseJitterThresholdBlocks;
    this.maxInFlightBlocks = options.maxInFlightBlocks; this.maxOutputLatencyBlocks = options.maxOutputLatencyBlocks; this.sharedBufferBlocks = options.sharedBufferBlocks;
    this.audioTransport = options.audioTransport;
    this.audioRequestTimeoutMs = options.audioRequestTimeoutMs;
    this.maxConsecutiveRenderBudgetMisses = options.maxConsecutiveRenderBudgetMisses;
    this.maxConsecutiveAudioErrors = options.maxConsecutiveAudioErrors;
    this.maxConsecutiveTransportPressureEvents = options.maxConsecutiveTransportPressureEvents;
    this.transportPressureAutoBypassReasons = options.transportPressureAutoBypassReasons;
    this.bypassed = options.bypassed;
    this.node = new AudioWorkletNode(context, "soundbridge-audio-processor", {
      numberOfInputs: options.inputChannels > 0 ? 1 : 0,
      numberOfOutputs: 1,
      channelCount: Math.max(1, options.inputChannels),
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
        latencyPressureThresholdBlocks: options.latencyPressureThresholdBlocks,
        responseJitterThresholdBlocks: options.responseJitterThresholdBlocks,
        statsIntervalBlocks: options.statsIntervalBlocks,
        bypassed: options.bypassed
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
      inputChannels: Math.max(0, Math.min(32, Math.floor(options.inputChannels ?? 2))),
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
      responseJitterThresholdBlocks: boundedInteger(options.responseJitterThresholdBlocks, 4, 0, 64),
      statsIntervalBlocks: boundedInteger(options.statsIntervalBlocks, 128, 8, 1024),
      audioTransport: options.audioTransport === "json" ? "json" : "binary",
      audioRequestTimeoutMs: boundedInteger(options.audioRequestTimeoutMs, 2000, 0, 60000),
      audioTransferMode: options.audioTransferMode ?? "auto",
      sharedBufferBlocks: boundedInteger(options.sharedBufferBlocks, 8, 2, 64),
      maxBlockFrames: boundedInteger(options.maxBlockFrames, 128, 1, 8192),
      maxConsecutiveRenderBudgetMisses: boundedInteger(options.maxConsecutiveRenderBudgetMisses, 0, 0, 1024),
      maxConsecutiveAudioErrors: boundedInteger(options.maxConsecutiveAudioErrors, 0, 0, 1024),
      maxConsecutiveTransportPressureEvents: boundedInteger(options.maxConsecutiveTransportPressureEvents, 0, 0, 1024),
      transportPressureAutoBypassReasons: boundedAudioNodeTransportPressureReasons(options.transportPressureAutoBypassReasons),
      bypassed: options.bypassed === true,
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

  setBypassed(bypassed: boolean): void {
    if (this.destroyed) {
      return;
    }
    if (!bypassed && this.unhealthyReason === "process-timeout") return;
    if (!bypassed) this.clearAutoBypassState();
    if (this.bypassed === bypassed) return;
    this.bypassed = bypassed;
    this.bypassEvents = Math.min(1024, this.bypassEvents + 1);
    this.node.port.postMessage({ type: "set-bypassed", bypassed });
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  retry(): boolean {
    if (this.destroyed || !this.clearAutoBypassState()) return false;
    if (this.bypassed) {
      this.bypassed = false;
      this.bypassEvents = Math.min(1024, this.bypassEvents + 1);
      this.node.port.postMessage({ type: "set-bypassed", bypassed: false });
    }
    this.dispatchEvent(new CustomEvent("retry", { detail: { health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return true;
  }

  async refreshLatency(transportLatencySamples = this.transportLatencySamples): Promise<SoundBridgeAudioNodeHealth> {
    if (this.destroyed) {
      return this.health;
    }
    const previous = {
      pluginLatencySamples: this.pluginLatencySamples,
      transportLatencySamples: this.transportLatencySamples,
      reportedLatencySamples: this.reportedLatencySamples
    };
    const requestedTransportLatencySamples = boundedInteger(transportLatencySamples, this.transportLatencySamples, 0, 1_048_576);
    const latency = await this.client.getLatency(this.instanceId, requestedTransportLatencySamples);
    this.pluginLatencySamples = boundedInteger(latency.pluginLatencySamples, this.pluginLatencySamples, 0, 1_048_576);
    this.transportLatencySamples = boundedInteger(latency.transportLatencySamples, requestedTransportLatencySamples, 0, 1_048_576);
    this.reportedLatencySamples = boundedInteger(
      latency.reportedLatencySamples,
      combinedAudioNodeLatencySamples(this.pluginLatencySamples, this.transportLatencySamples),
      0,
      1_048_576
    );
    this.latencyRefreshes = Math.min(1024, this.latencyRefreshes + 1);
    if (
      this.pluginLatencySamples !== previous.pluginLatencySamples ||
      this.transportLatencySamples !== previous.transportLatencySamples ||
      this.reportedLatencySamples !== previous.reportedLatencySamples
    ) {
      this.latencyChangeEvents = Math.min(1024, this.latencyChangeEvents + 1);
      this.lastLatencyChangeDirection = "changed";
      this.dispatchEvent(new CustomEvent("latencychange", { detail: { direction: "changed", previous, latency, health: this.health } }));
    }
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return this.health;
  }

  disconnect(): void {
    this.node.disconnect();
  }

  get health(): SoundBridgeAudioNodeHealth {
    return {
      healthy: !this.destroyed && this.unhealthyReason === undefined,
      instanceId: this.instanceId,
      bypassed: this.bypassed,
      bypassEvents: this.bypassEvents,
      audioTransport: this.audioTransport,
      audioRequestTimeoutMs: this.audioRequestTimeoutMs,
      inFlightBlocks: this.workletInFlightBlocks ?? this.inFlightBlocks,
      maxInFlightBlocks: this.maxInFlightBlocks,
      queuedOutputBlocks: this.queuedOutputBlocks,
      outputLatencyBlocks: this.outputLatencyBlocks, maxOutputLatencyBlocks: this.maxOutputLatencyBlocks,
      transportLatencySamples: this.transportLatencySamples,
      pluginLatencySamples: this.pluginLatencySamples,
      reportedLatencySamples: this.reportedLatencySamples,
      transportLatencyMs: audioNodeLatencyMilliseconds(this.transportLatencySamples, this.sampleRate),
      pluginLatencyMs: audioNodeLatencyMilliseconds(this.pluginLatencySamples, this.sampleRate),
      reportedLatencyMs: audioNodeLatencyMilliseconds(this.reportedLatencySamples, this.sampleRate),
      latencyIncreases: this.latencyIncreases,
      latencyDecreases: this.latencyDecreases,
      latencyChangeEvents: this.latencyChangeEvents,
      latencyRefreshes: this.latencyRefreshes,
      lastLatencyChangeDirection: this.lastLatencyChangeDirection,
      responseDeadlineLeadSamples: this.responseDeadlineLeadSamples,
      responseJitterBlocks: this.responseJitterBlocks,
      responseJitterSamples: this.responseJitterSamples,
      responseJitterThresholdBlocks: this.responseJitterThresholdBlocks,
      responseDeadlineMisses: this.responseDeadlineMisses,
      responseDeadlineMissesSinceLastStats: this.responseDeadlineMissesSinceLastStats,
      fallbackOutputBlocks: this.fallbackOutputBlocks,
      lastFallbackReason: this.lastFallbackReason,
      staleOutputBlocks: this.staleOutputBlocks,
      droppedInputBlocks: this.droppedInputBlocks,
      underruns: this.underruns,
      sharedAudioEnabled: this.sharedAudioEnabled, sharedBufferBlocks: this.sharedBufferBlocks,
      sharedInputQueuedBlocks: this.sharedInputQueuedBlocks, sharedInputQueuedMaxBlocks: this.sharedInputQueuedMaxBlocks,
      sharedOutputQueuedBlocks: this.sharedOutputQueuedBlocks, sharedOutputQueuedMaxBlocks: this.sharedOutputQueuedMaxBlocks,
      sharedInputDroppedBlocks: this.sharedInputDroppedBlocks,
      sharedOutputDroppedBlocks: this.sharedOutputDroppedBlocks,
      sharedTransportInFlightBlocks: this.sharedTransportStats.inFlightBlocks, sharedInputBufferAllocations: this.sharedTransportStats.inputBufferAllocations, sharedInputBufferReuses: this.sharedTransportStats.inputBufferReuses, sharedPooledInputBuffers: this.sharedTransportStats.pooledInputBuffers,
      transportPressureEvents: this.transportPressureEvents,
      consecutiveTransportPressureEvents: this.consecutiveTransportPressureEvents,
      maxConsecutiveTransportPressureEvents: this.maxConsecutiveTransportPressureEvents,
      transportPressureAutoBypassed: this.transportPressureAutoBypassed,
      transportPressureAutoBypassReasons: this.transportPressureAutoBypassReasons === undefined ? undefined : [...this.transportPressureAutoBypassReasons],
      lastTransportPressureReasons: [...this.lastTransportPressureReasons],
      lastRenderEngine: this.lastRenderEngine,
      lastRenderDurationMs: this.lastRenderDurationMs,
      lastRenderBudgetMs: this.lastRenderBudgetMs,
      renderBudgetExceeded: this.renderBudgetExceeded,
      renderBudgetMisses: this.renderBudgetMisses,
      maxConsecutiveRenderBudgetMisses: this.maxConsecutiveRenderBudgetMisses,
      renderBudgetAutoBypassed: this.renderBudgetAutoBypassed,
      audioErrors: this.audioErrors,
      consecutiveAudioErrors: this.consecutiveAudioErrors,
      maxConsecutiveAudioErrors: this.maxConsecutiveAudioErrors,
      audioErrorAutoBypassed: this.audioErrorAutoBypassed,
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
      sharedBufferBlocks?: number;
      sharedInputQueuedBlocks?: number;
      sharedOutputQueuedBlocks?: number;
      sharedInputDroppedBlocks?: number;
      sharedOutputDroppedBlocks?: number;
      sharedTransportInFlightBlocks?: number; sharedInputBufferAllocations?: number; sharedInputBufferReuses?: number; sharedPooledInputBuffers?: number;
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
      fallbackOutputBlocks?: number;
      lastFallbackReason?: string;
      renderDurationMs?: number;
      renderBudgetMs?: number;
      renderBudgetExceeded?: boolean;
      renderEngine?: string;
      latencySamples?: unknown;
      error?: unknown;
    };

    if (typed.type === "stats") {
      this.recordStats(typed);
      this.dispatchEvent(new CustomEvent("stats", { detail: { ...typed, sharedBufferBlocks: this.sharedBufferBlocks } }));
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
    const request = {
      instanceId: this.instanceId,
      blockId: typed.blockId,
      sampleRate: this.sampleRate,
      channels: binaryChannels,
      transport: liveTransportForBlock({
        sampleRate: this.sampleRate,
        maxBlockSize: frames,
        blockId: typed.blockId,
        reportedLatencySamples: typed.transportLatencySamples,
        compensateOutputLatency: true
      }),
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
        if (typeof response.renderEngine === "string" || typeof response.latencySamples === "number") {
          const diagnostics = {
            blockId: response.blockId,
            latencySamples: response.latencySamples,
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

  private recordStats(stats: {
    inFlightBlocks?: number;
    queuedOutputBlocks?: number;
    outputLatencyBlocks?: number;
    transportLatencySamples?: number;
    latencyIncreases?: number;
    latencyDecreases?: number;
    responseDeadlineLeadSamples?: number;
    responseJitterBlocks?: number;
    responseJitterSamples?: number;
    responseDeadlineMisses?: number;
    responseDeadlineMissesSinceLastStats?: number;
    fallbackOutputBlocks?: number;
    lastFallbackReason?: string;
    staleOutputBlocks?: number;
    droppedInputBlocks?: number;
    underruns?: number;
    sharedAudioEnabled?: boolean;
    sharedInputQueuedBlocks?: number; sharedInputQueuedMaxBlocks?: number;
    sharedOutputQueuedBlocks?: number; sharedOutputQueuedMaxBlocks?: number;
    sharedInputDroppedBlocks?: number;
    sharedOutputDroppedBlocks?: number;
    sharedTransportInFlightBlocks?: number; sharedInputBufferAllocations?: number; sharedInputBufferReuses?: number; sharedPooledInputBuffers?: number;
  }): void {
    const previous = {
      outputLatencyBlocks: this.outputLatencyBlocks,
      transportLatencySamples: this.transportLatencySamples,
      latencyIncreases: this.latencyIncreases,
      latencyDecreases: this.latencyDecreases,
      responseDeadlineMisses: this.responseDeadlineMisses,
      fallbackOutputBlocks: this.fallbackOutputBlocks,
      staleOutputBlocks: this.staleOutputBlocks,
      droppedInputBlocks: this.droppedInputBlocks,
      underruns: this.underruns,
      sharedInputDroppedBlocks: this.sharedInputDroppedBlocks,
      sharedOutputDroppedBlocks: this.sharedOutputDroppedBlocks
    };

    this.workletInFlightBlocks = boundedInteger(stats.inFlightBlocks, this.workletInFlightBlocks ?? 0, 0, 64);
    this.queuedOutputBlocks = boundedInteger(stats.queuedOutputBlocks, this.queuedOutputBlocks, 0, 64);
    this.outputLatencyBlocks = boundedInteger(stats.outputLatencyBlocks, this.outputLatencyBlocks, 0, 64);
    this.transportLatencySamples = boundedInteger(stats.transportLatencySamples, this.transportLatencySamples, 0, 1_048_576);
    this.reportedLatencySamples = combinedAudioNodeLatencySamples(this.pluginLatencySamples, this.transportLatencySamples);
    this.latencyIncreases = boundedInteger(stats.latencyIncreases, this.latencyIncreases, 0, Number.MAX_SAFE_INTEGER);
    this.latencyDecreases = boundedInteger(stats.latencyDecreases, this.latencyDecreases, 0, Number.MAX_SAFE_INTEGER);
    this.responseDeadlineLeadSamples =
      boundedOptionalNumber(stats.responseDeadlineLeadSamples, -1_048_576, 1_048_576) ?? this.responseDeadlineLeadSamples;
    this.responseJitterBlocks = boundedInteger(stats.responseJitterBlocks, this.responseJitterBlocks, 0, 64);
    this.responseJitterSamples = boundedInteger(stats.responseJitterSamples, this.responseJitterSamples, 0, 1_048_576);
    this.responseDeadlineMisses = boundedInteger(stats.responseDeadlineMisses, this.responseDeadlineMisses, 0, Number.MAX_SAFE_INTEGER);
    this.responseDeadlineMissesSinceLastStats = boundedInteger(
      stats.responseDeadlineMissesSinceLastStats,
      this.responseDeadlineMissesSinceLastStats,
      0,
      Number.MAX_SAFE_INTEGER
    );
    this.fallbackOutputBlocks = boundedInteger(stats.fallbackOutputBlocks, this.fallbackOutputBlocks, 0, Number.MAX_SAFE_INTEGER);
    this.lastFallbackReason = audioNodeFallbackReason(stats.lastFallbackReason);
    this.staleOutputBlocks = boundedInteger(stats.staleOutputBlocks, this.staleOutputBlocks, 0, Number.MAX_SAFE_INTEGER);
    this.droppedInputBlocks = boundedInteger(stats.droppedInputBlocks, this.droppedInputBlocks, 0, Number.MAX_SAFE_INTEGER);
    this.underruns = boundedInteger(stats.underruns, this.underruns, 0, Number.MAX_SAFE_INTEGER);
    this.sharedInputQueuedBlocks = boundedInteger(stats.sharedInputQueuedBlocks, this.sharedInputQueuedBlocks, 0, 64); this.sharedInputQueuedMaxBlocks = boundedInteger(stats.sharedInputQueuedMaxBlocks, this.sharedInputQueuedMaxBlocks, 0, 64);
    this.sharedOutputQueuedBlocks = boundedInteger(stats.sharedOutputQueuedBlocks, this.sharedOutputQueuedBlocks, 0, 64); this.sharedOutputQueuedMaxBlocks = boundedInteger(stats.sharedOutputQueuedMaxBlocks, this.sharedOutputQueuedMaxBlocks, 0, 64);
    this.sharedInputDroppedBlocks = boundedInteger(
      stats.sharedInputDroppedBlocks,
      this.sharedInputDroppedBlocks,
      0,
      Number.MAX_SAFE_INTEGER
    );
    this.sharedOutputDroppedBlocks = boundedInteger(
      stats.sharedOutputDroppedBlocks,
      this.sharedOutputDroppedBlocks,
      0,
      Number.MAX_SAFE_INTEGER
    );
    this.sharedTransportStats = { inFlightBlocks: boundedInteger(stats.sharedTransportInFlightBlocks, this.sharedTransportStats.inFlightBlocks, 0, 64), inputBufferAllocations: boundedInteger(stats.sharedInputBufferAllocations, this.sharedTransportStats.inputBufferAllocations, 0, Number.MAX_SAFE_INTEGER), inputBufferReuses: boundedInteger(stats.sharedInputBufferReuses, this.sharedTransportStats.inputBufferReuses, 0, Number.MAX_SAFE_INTEGER), pooledInputBuffers: boundedInteger(stats.sharedPooledInputBuffers, this.sharedTransportStats.pooledInputBuffers, 0, 2048) };
    if (typeof stats.sharedAudioEnabled === "boolean") {
      this.sharedAudioEnabled = stats.sharedAudioEnabled;
    }
    this.reportFallbackOutput(previous, stats);
    this.reportLatencyChange(previous, stats);
    this.reportTransportPressure(previous, stats);
  }

  private reportFallbackOutput(previous: { fallbackOutputBlocks: number }, stats: unknown): void {
    const deltaBlocks = Math.max(0, this.fallbackOutputBlocks - previous.fallbackOutputBlocks);
    if (deltaBlocks <= 0) return;
    const detail: SoundBridgeAudioNodeFallbackOutputEventDetail = { deltaBlocks, reason: this.lastFallbackReason, stats, health: this.health };
    this.dispatchEvent(new CustomEvent("fallback-output", { detail }));
  }

  private reportLatencyChange(
    previous: {
      outputLatencyBlocks: number;
      transportLatencySamples: number;
      latencyIncreases: number;
      latencyDecreases: number;
    },
    stats: unknown
  ): void {
    const changed =
      this.outputLatencyBlocks !== previous.outputLatencyBlocks ||
      this.transportLatencySamples !== previous.transportLatencySamples ||
      this.latencyIncreases > previous.latencyIncreases ||
      this.latencyDecreases > previous.latencyDecreases;
    if (!changed) {
      return;
    }
    const direction =
      this.latencyIncreases > previous.latencyIncreases
        ? "increased"
        : this.latencyDecreases > previous.latencyDecreases
          ? "decreased"
          : "changed";
    this.latencyChangeEvents = Math.min(1024, this.latencyChangeEvents + 1);
    this.lastLatencyChangeDirection = direction;
    this.dispatchEvent(new CustomEvent("latencychange", { detail: { direction, previous, stats, health: this.health } }));
  }

  private reportTransportPressure(
    previous: {
      responseDeadlineMisses: number;
      fallbackOutputBlocks: number;
      latencyIncreases: number;
      staleOutputBlocks: number;
      droppedInputBlocks: number;
      underruns: number;
      sharedInputDroppedBlocks: number;
      sharedOutputDroppedBlocks: number;
    },
    stats: { responseJitterBlocks?: number }
  ): void {
    const reasons: string[] = [];
    const deadlineMisses = Math.max(0, this.responseDeadlineMisses - previous.responseDeadlineMisses);
    if (this.responseDeadlineMisses > previous.responseDeadlineMisses) reasons.push("deadline-miss");
    if (this.latencyIncreases > previous.latencyIncreases && this.responseJitterThresholdBlocks > 0 && boundedOptionalNumber(stats.responseJitterBlocks, 0, 64) !== undefined && this.responseJitterBlocks >= this.responseJitterThresholdBlocks) reasons.push("response-jitter");
    if (this.fallbackOutputBlocks > previous.fallbackOutputBlocks && this.lastFallbackReason === "latency-safety") reasons.push("latency-safety");
    if (this.staleOutputBlocks > previous.staleOutputBlocks) reasons.push("stale-output");
    if (this.droppedInputBlocks > previous.droppedInputBlocks) reasons.push("dropped-input");
    if (this.underruns > previous.underruns) reasons.push("underrun");
    if (this.sharedInputDroppedBlocks > previous.sharedInputDroppedBlocks) reasons.push("shared-input-drop");
    if (this.sharedOutputDroppedBlocks > previous.sharedOutputDroppedBlocks) reasons.push("shared-output-drop");
    if (reasons.length === 0) {
      if (!this.transportPressureAutoBypassed) this.consecutiveTransportPressureEvents = 0;
      return;
    }
    const autoBypassPressure = shouldAutoBypassAudioNodeTransportPressure(reasons, this.transportPressureAutoBypassReasons);
    this.transportPressureEvents = Math.min(1024, this.transportPressureEvents + 1);
    if (autoBypassPressure) this.consecutiveTransportPressureEvents = Math.min(1024, this.consecutiveTransportPressureEvents + 1);
    else if (!this.transportPressureAutoBypassed) this.consecutiveTransportPressureEvents = 0;
    this.lastTransportPressureReasons = reasons;
    if (deadlineMisses > 0) this.dispatchEvent(new CustomEvent("response-deadline-missed", { detail: { deltaMisses: deadlineMisses, stats, health: this.health } }));
    this.dispatchEvent(new CustomEvent("transport-pressure", { detail: { reasons, stats, health: this.health } }));
    if (autoBypassPressure && this.maxConsecutiveTransportPressureEvents > 0 && this.consecutiveTransportPressureEvents >= this.maxConsecutiveTransportPressureEvents && !this.bypassed && !this.transportPressureAutoBypassed) {
      this.transportPressureAutoBypassed = true;
      this.unhealthyReason = "transport-pressure";
      this.setBypassed(true);
      this.dispatchEvent(new CustomEvent("transport-pressure-auto-bypassed", { detail: { reasons, stats, health: this.health } }));
    }
  }

  private recordProcessDiagnostics(diagnostics: {
    renderEngine?: unknown;
    renderDurationMs?: unknown;
    renderBudgetMs?: unknown;
    renderBudgetExceeded?: unknown;
    latencySamples?: unknown;
  }): void {
    const exceeded = diagnostics.renderBudgetExceeded === true;
    if (this.audioErrorAutoBypassed || (this.renderBudgetAutoBypassed && !exceeded)) return;
    this.clearAudioError();
    this.recordRenderLatency(diagnostics.latencySamples, diagnostics);
    if (typeof diagnostics.renderEngine === "string") {
      this.lastRenderEngine = diagnostics.renderEngine;
    }
    this.lastRenderDurationMs = boundedOptionalNumber(diagnostics.renderDurationMs, 0, 60000);
    this.lastRenderBudgetMs = boundedOptionalNumber(diagnostics.renderBudgetMs, 0, 60000);
    this.renderBudgetExceeded = exceeded;
    this.renderBudgetMisses = this.renderBudgetExceeded ? Math.min(1024, this.renderBudgetMisses + 1) : 0;
    if (this.renderBudgetExceeded) {
      this.dispatchEvent(new CustomEvent("render-budget-exceeded", { detail: { diagnostics, health: this.health } }));
      if (this.maxConsecutiveRenderBudgetMisses > 0 && this.renderBudgetMisses >= this.maxConsecutiveRenderBudgetMisses && !this.bypassed && !this.renderBudgetAutoBypassed) {
        this.renderBudgetAutoBypassed = true;
        this.unhealthyReason = "render-budget-exceeded";
        this.setBypassed(true);
        this.dispatchEvent(new CustomEvent("render-budget-tripped", { detail: { diagnostics, health: this.health } }));
        this.dispatchEvent(new CustomEvent("render-budget-auto-bypassed", { detail: { diagnostics, health: this.health } }));
      }
    }
  }

  private recordAudioError(error: unknown): void {
    const processTimedOut = isRenderDeadlineProtocolError(error);
    this.audioErrors = Math.min(1024, this.audioErrors + 1);
    this.consecutiveAudioErrors = Math.min(1024, this.consecutiveAudioErrors + 1);
    this.lastAudioError = error;
    this.unhealthyReason = processTimedOut ? "process-timeout" : "audio-error";
    let autoBypassed = false;
    if (this.maxConsecutiveAudioErrors > 0 && this.consecutiveAudioErrors >= this.maxConsecutiveAudioErrors && !this.bypassed && !this.audioErrorAutoBypassed) {
      this.audioErrorAutoBypassed = true;
      autoBypassed = true;
      this.setBypassed(true);
      this.dispatchEvent(new CustomEvent("audio-error-auto-bypassed", { detail: { error, health: this.health } }));
    }
    if (processTimedOut) {
      const detail: SoundBridgeAudioNodeProcessTimeoutEventDetail = { error, autoBypassed, health: this.health };
      this.dispatchEvent(new CustomEvent("process-timeout", { detail }));
      this.dispatchEvent(new CustomEvent("process-timeout-tripped", { detail }));
      if (autoBypassed) this.dispatchEvent(new CustomEvent("process-timeout-auto-bypassed", { detail }));
    }
  }

  private clearAudioError(): void {
    if (this.unhealthyReason === "audio-error" || this.unhealthyReason === "process-timeout") {
      this.lastAudioError = undefined;
      this.consecutiveAudioErrors = 0;
      this.unhealthyReason = undefined;
    }
  }

  private clearAutoBypassState(): boolean {
    if (!(this.renderBudgetAutoBypassed || this.audioErrorAutoBypassed || this.transportPressureAutoBypassed)) return false;
    if (this.unhealthyReason === "process-timeout") return false;
    this.renderBudgetAutoBypassed = this.audioErrorAutoBypassed = this.transportPressureAutoBypassed = false;
    this.renderBudgetExceeded = false;
    this.renderBudgetMisses = 0;
    this.consecutiveAudioErrors = 0;
    this.consecutiveTransportPressureEvents = 0;
    this.lastAudioError = undefined;
    if (this.unhealthyReason === "render-budget-exceeded" || this.unhealthyReason === "audio-error" || this.unhealthyReason === "process-timeout" || this.unhealthyReason === "transport-pressure") this.unhealthyReason = undefined;
    return true;
  }

  private recordRenderLatency(latencySamples: unknown, diagnostics: unknown): void {
    const pluginLatencySamples = boundedOptionalNumber(latencySamples, 0, 1_048_576);
    if (pluginLatencySamples === undefined || pluginLatencySamples === this.pluginLatencySamples) return;
    const previous = { pluginLatencySamples: this.pluginLatencySamples, transportLatencySamples: this.transportLatencySamples, reportedLatencySamples: this.reportedLatencySamples };
    this.pluginLatencySamples = pluginLatencySamples;
    this.reportedLatencySamples = combinedAudioNodeLatencySamples(this.pluginLatencySamples, this.transportLatencySamples);
    this.latencyChangeEvents = Math.min(1024, this.latencyChangeEvents + 1);
    this.lastLatencyChangeDirection = "changed";
    this.dispatchEvent(new CustomEvent("latencychange", { detail: { direction: "changed", previous, diagnostics, health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }
}

function audioNodeFallbackReason(reason: unknown): SoundBridgeAudioNodeFallbackReason | undefined {
  return reason === "bypass" || reason === "latency-safety" || reason === "underrun" ? reason : undefined;
}
