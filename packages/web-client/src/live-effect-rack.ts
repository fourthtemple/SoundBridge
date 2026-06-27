import type {
  AudioBlockResponse,
  CreateInstanceResponse,
  HostTransportState,
  PluginMetadata
} from "../../protocol/src/messages";
import { SoundBridgeClient } from "./client";
import type { BinaryAudioBlockRequest } from "./client";
import {
  boundedLiveEffectBusBlocks,
  boundedLiveEffectChannels,
  cloneBusBlocks,
  cloneChannels,
  dryChannels,
  outputTail,
  transitionOutputChannels,
  wetMixedChannels
} from "./live-effect-rack-audio";
import {
  boundedChannelCount,
  boundedLatencySamples,
  boundedLiveEffectInteger,
  boundedLiveEffectNumber,
  boundedOptionalNumber,
  combinedLatencySamples,
  isRecoverablePressureReason,
  isRenderDeadlineProtocolError,
  liveEffectDryReason,
  liveEffectFailureReason,
  liveEffectLatencyMilliseconds,
  liveEffectNowMs,
  liveEffectRackTiming,
  renderDeadlineDetails,
  withLiveEffectTimeout
} from "./live-effect-rack-metrics";
import type { LiveEffectDryReason, LiveEffectRackTiming } from "./live-effect-rack-metrics";
import { createLiveEffectRackPolicy } from "./live-effect-rack-policy";
export { calibrateLiveEffectRackPolicy, createLiveEffectRackPolicy } from "./live-effect-rack-policy";
export type { LiveEffectRackCalibration, LiveEffectRackCalibrationOptions, LiveEffectRackPolicy, LiveEffectRackPolicyOptions } from "./live-effect-rack-policy";
export { LiveEffectRackCalibrationWindow, LiveEffectRackChainCalibrationWindow, createLiveEffectRackCalibrationWindow, createLiveEffectRackChainCalibrationWindow, liveEffectRackPolicyOptionsFromCalibration, refreshLiveEffectRackLatencyFromCalibration } from "./live-effect-rack-calibration";
export type { LiveEffectRackCalibrationHealthSample, LiveEffectRackCalibrationWindowOptions, LiveEffectRackCalibrationWindowSnapshot, LiveEffectRackChainCalibrationHealthSample, LiveEffectRackLatencyRefresher } from "./live-effect-rack-calibration";
import { liveTransportForBlock } from "./live-transport";
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

export function createLivePerformanceRackOptions(options: LivePerformanceRackOptions): LiveEffectRackOptions {
  const {
    maxInputAgeBlocks,
    processBudgetBlocks,
    processTimeoutBlocks,
    transitionFadeBlocks,
    ...rackOptions
  } = options;
  const policy = createLiveEffectRackPolicy({
    ...options,
    maxInputAgeBlocks,
    processBudgetBlocks,
    processTimeoutBlocks,
    transitionFadeBlocks
  });
  return {
    ...rackOptions,
    audioTransport: options.audioTransport ?? "binary",
    maxInputAgeMs: policy.maxInputAgeMs,
    maxInFlightBlocks: policy.maxInFlightBlocks,
    processBudgetMs: policy.processBudgetMs,
    processTimeoutMs: policy.processTimeoutMs,
    transitionFadeSamples: policy.transitionFadeSamples,
    maxConsecutiveProcessBudgetMisses: policy.maxConsecutiveProcessBudgetMisses,
    maxConsecutiveRenderBudgetMisses: policy.maxConsecutiveRenderBudgetMisses,
    processBudgetRecoveryBlocks: policy.processBudgetRecoveryBlocks,
    renderBudgetRecoveryBlocks: policy.renderBudgetRecoveryBlocks,
    processTimeoutRecoveryBlocks: policy.processTimeoutRecoveryBlocks,
    maxProcessTimeoutRecoveries: policy.maxProcessTimeoutRecoveries
  };
}

export class SoundBridgeLiveEffectRack extends EventTarget {
  readonly client: SoundBridgeClient;
  readonly plugin: PluginMetadata;
  readonly sampleRate: number;
  readonly maxBlockSize: number;
  readonly inputChannels: number;
  readonly outputChannels: number;
  readonly audioTransport: "binary" | "json";
  readonly maxInputAgeMs: number;
  readonly maxInFlightBlocks: number;
  readonly processBudgetMs: number;
  readonly processTimeoutMs: number;
  readonly transitionFadeSamples: number;
  readonly maxConsecutiveProcessBudgetMisses: number;
  readonly maxConsecutiveRenderBudgetMisses: number;
  readonly processBudgetRecoveryBlocks: number;
  readonly renderBudgetRecoveryBlocks: number;
  readonly processTimeoutRecoveryBlocks: number;
  readonly maxProcessTimeoutRecoveries: number;

  private wetMix: number;
  private created?: CreateInstanceResponse;
  private destroyed = false;
  private bypassed = false;
  private healthy = true;
  private lastError?: unknown;
  private unhealthyReason?: LiveEffectRackHealth["unhealthyReason"];
  private recoveryDryBlocks = 0;
  private recoveryInProgress = false;
  private processTimeoutRecoveryAttempts = 0;
  private outputStateVersion = 0;
  private inFlightEpoch = 0;
  private inFlightBlocks = 0;
  private droppedInputBlocks = 0;
  private staleInputBlocks = 0;
  private staleOutputBlocks = 0;
  private processBudgetMisses = 0;
  private lastProcessDurationMs?: number;
  private lastProcessBudgetMs?: number;
  private lastProcessBudgetExceeded = false;
  private lastResponseDeadlineLeadMs?: number; private lastResponseDeadlineLeadBlocks?: number; private responseDeadlineLeadMinBlocks?: number; private responseDeadlineLeadMaxBlocks?: number; private responseJitterBlocks = 0; private responseDeadlineMisses = 0;
  private renderBudgetMisses = 0;
  private lastRenderDurationMs?: number;
  private lastRenderBudgetMs?: number;
  private lastRenderBudgetExceeded = false;
  private lastRenderTimeoutMs?: number;
  private lastRenderTimeoutBudgetMs?: number;
  private lastRenderTimeoutBudgetDeltaMs?: number;
  private renderTimeouts = 0;
  private consecutiveRenderTimeouts = 0;
  private renderQuarantined = false;
  private lastDryReason?: LiveEffectDryReason;
  private lastOutputPath?: "wet" | "dry";
  private lastOutputTail?: number[];
  private transportLatencySamples = 0;
  private reportedLatencySamples = 0;

  private constructor(options: LiveEffectRackOptions) {
    super();
    this.client = options.client;
    this.plugin = options.plugin;
    this.sampleRate = options.sampleRate;
    this.maxBlockSize = options.maxBlockSize;
    this.inputChannels = boundedChannelCount(options.inputChannels ?? options.plugin.inputs ?? 2);
    this.outputChannels = boundedChannelCount(options.outputChannels ?? options.plugin.outputs ?? this.inputChannels);
    this.audioTransport = options.audioTransport === "json" ? "json" : "binary";
    this.maxInputAgeMs = boundedLiveEffectNumber(options.maxInputAgeMs, 0, 0, 60000);
    this.maxInFlightBlocks = boundedLiveEffectInteger(options.maxInFlightBlocks, 1, 1, 32);
    this.processBudgetMs = boundedLiveEffectNumber(options.processBudgetMs, 0, 0, 60000);
    this.processTimeoutMs = boundedLiveEffectNumber(options.processTimeoutMs, 0, 0, 60000);
    this.transitionFadeSamples = boundedLiveEffectInteger(options.transitionFadeSamples, 0, 0, 4096);
    this.maxConsecutiveProcessBudgetMisses = boundedLiveEffectInteger(options.maxConsecutiveProcessBudgetMisses, 0, 0, 1024);
    this.maxConsecutiveRenderBudgetMisses = boundedLiveEffectInteger(options.maxConsecutiveRenderBudgetMisses, 3, 0, 1024);
    this.processBudgetRecoveryBlocks = boundedLiveEffectInteger(options.processBudgetRecoveryBlocks, 0, 0, 4096);
    this.renderBudgetRecoveryBlocks = boundedLiveEffectInteger(options.renderBudgetRecoveryBlocks, 0, 0, 4096);
    this.processTimeoutRecoveryBlocks = boundedLiveEffectInteger(options.processTimeoutRecoveryBlocks, 0, 0, 4096);
    this.maxProcessTimeoutRecoveries = boundedLiveEffectInteger(options.maxProcessTimeoutRecoveries, 0, 0, 32);
    this.wetMix = boundedWetMix(options.wetMix, 1);
  }

  static async create(options: LiveEffectRackOptions): Promise<SoundBridgeLiveEffectRack> { const rack = new SoundBridgeLiveEffectRack(options); await rack.createInstance(); return rack; }
  static createLivePerformance(options: LivePerformanceRackOptions): Promise<SoundBridgeLiveEffectRack> {
    return SoundBridgeLiveEffectRack.create(createLivePerformanceRackOptions(options));
  }
  get instanceId(): string | undefined {
    return this.created?.instanceId;
  }
  get timing(): LiveEffectRackTiming { return liveEffectRackTiming(this.sampleRate, this.maxBlockSize, this.created?.latencySamples ?? 0, this.transportLatencySamples, this.reportedLatencySamples, this.processBudgetMs, this.processTimeoutMs, this.maxInputAgeMs, this.transitionFadeSamples); }
  get health(): LiveEffectRackHealth {
    return {
      bypassed: this.bypassed,
      healthy: this.healthy,
      instanceId: this.instanceId,
      lastError: this.lastError,
      latencySamples: this.created?.latencySamples ?? 0,
      pluginLatencySamples: this.created?.latencySamples ?? 0,
      transportLatencySamples: this.transportLatencySamples,
      reportedLatencySamples: this.reportedLatencySamples,
      latencyMs: liveEffectLatencyMilliseconds(this.created?.latencySamples ?? 0, this.sampleRate),
      pluginLatencyMs: liveEffectLatencyMilliseconds(this.created?.latencySamples ?? 0, this.sampleRate),
      transportLatencyMs: liveEffectLatencyMilliseconds(this.transportLatencySamples, this.sampleRate),
      reportedLatencyMs: liveEffectLatencyMilliseconds(this.reportedLatencySamples, this.sampleRate),
      processBudgetMisses: this.processBudgetMisses,
      lastProcessDurationMs: this.lastProcessDurationMs,
      lastProcessBudgetMs: this.lastProcessBudgetMs,
      processBudgetExceeded: this.lastProcessBudgetExceeded,
      lastResponseDeadlineLeadMs: this.lastResponseDeadlineLeadMs, lastResponseDeadlineLeadBlocks: this.lastResponseDeadlineLeadBlocks, responseJitterBlocks: this.responseJitterBlocks, responseDeadlineMisses: this.responseDeadlineMisses,
      renderBudgetMisses: this.renderBudgetMisses,
      lastRenderDurationMs: this.lastRenderDurationMs,
      lastRenderBudgetMs: this.lastRenderBudgetMs,
      renderBudgetExceeded: this.lastRenderBudgetExceeded,
      lastRenderTimeoutMs: this.lastRenderTimeoutMs,
      lastRenderTimeoutBudgetMs: this.lastRenderTimeoutBudgetMs,
      lastRenderTimeoutBudgetDeltaMs: this.lastRenderTimeoutBudgetDeltaMs,
      renderTimeouts: this.renderTimeouts,
      consecutiveRenderTimeouts: this.consecutiveRenderTimeouts,
      renderQuarantined: this.renderQuarantined,
      lastDryReason: this.lastDryReason,
      unhealthyReason: this.unhealthyReason,
      recoveryDryBlocks: this.recoveryDryBlocks,
      recoveryInProgress: this.recoveryInProgress,
      processBudgetRecoveryBlocks: this.processBudgetRecoveryBlocks,
      renderBudgetRecoveryBlocks: this.renderBudgetRecoveryBlocks,
      processTimeoutRecoveryBlocks: this.processTimeoutRecoveryBlocks,
      processTimeoutRecoveryAttempts: this.processTimeoutRecoveryAttempts,
      maxProcessTimeoutRecoveries: this.maxProcessTimeoutRecoveries,
      processBudgetMs: this.processBudgetMs,
      processTimeoutMs: this.processTimeoutMs,
      maxInputAgeMs: this.maxInputAgeMs,
      inFlightBlocks: this.inFlightBlocks,
      maxInFlightBlocks: this.maxInFlightBlocks,
      droppedInputBlocks: this.droppedInputBlocks,
      staleInputBlocks: this.staleInputBlocks,
      staleOutputBlocks: this.staleOutputBlocks,
      transitionFadeSamples: this.transitionFadeSamples,
      wetMix: this.wetMix
    };
  }
  setBypassed(bypassed: boolean): void {
    if (this.bypassed !== bypassed) {
      this.outputStateVersion += 1;
    }
    this.bypassed = bypassed;
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }
  setWetMix(wetMix: number): void {
    const bounded = boundedWetMix(wetMix, this.wetMix);
    if (bounded === this.wetMix) {
      return;
    }
    this.wetMix = bounded;
    this.dispatchEvent(new CustomEvent("wetmixchange", { detail: this.health }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  retry(): boolean {
    if (this.destroyed || !this.instanceId || !isRecoverablePressureReason(this.unhealthyReason)) {
      return false;
    }
    this.healthy = true;
    this.lastError = undefined;
    this.unhealthyReason = undefined;
    this.recoveryDryBlocks = 0;
    this.recoveryInProgress = false;
    this.processBudgetMisses = 0;
    this.lastProcessBudgetExceeded = false;
    this.renderBudgetMisses = 0;
    this.lastRenderBudgetExceeded = false;
    this.dispatchEvent(new CustomEvent("retry", { detail: { health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return true;
  }

  getParameters(): ReturnType<SoundBridgeClient["getParameters"]> { return this.client.getParameters(this.requireControllableInstance()); }
  setPreset(presetId: string): ReturnType<SoundBridgeClient["setPreset"]> { return this.client.setPreset(this.requireControllableInstance(), presetId); }
  setParameter(parameterId: string, normalizedValue: number): ReturnType<SoundBridgeClient["setParameter"]> { return this.client.setParameter(this.requireControllableInstance(), parameterId, normalizedValue); }
  setParameterEvents(events: Parameters<SoundBridgeClient["setParameterEvents"]>[1]): ReturnType<SoundBridgeClient["setParameterEvents"]> { return this.client.setParameterEvents(this.requireControllableInstance(), events); }
  setParameterCurve(
    parameterId: string,
    points: Parameters<SoundBridgeClient["setParameterCurve"]>[2],
    interpolation: Parameters<SoundBridgeClient["setParameterCurve"]>[3] = "linear"
  ): ReturnType<SoundBridgeClient["setParameterCurve"]> {
    return this.client.setParameterCurve(this.requireControllableInstance(), parameterId, points, interpolation);
  }
  setAutomationLane(parameterId: string, points: Parameters<SoundBridgeClient["setAutomationLane"]>[2]): ReturnType<SoundBridgeClient["setAutomationLane"]> { return this.client.setAutomationLane(this.requireControllableInstance(), parameterId, points); }
  clearAutomationLane(parameterId?: string): ReturnType<SoundBridgeClient["clearAutomationLane"]> { return this.client.clearAutomationLane(this.requireControllableInstance(), parameterId); }
  sendMidiEvents(events: Parameters<SoundBridgeClient["sendMidiEvents"]>[1]): ReturnType<SoundBridgeClient["sendMidiEvents"]> { return this.client.sendMidiEvents(this.requireControllableInstance(), events); }

  async recreate(): Promise<void> {
    this.destroyed = false;
    this.recoveryInProgress = false;
    this.processTimeoutRecoveryAttempts = 0;
    await this.destroyInstance().catch(() => undefined);
    await this.createInstance();
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.recoveryInProgress = false;
    await this.destroyInstance();
    this.healthy = false;
    this.unhealthyReason = "destroyed";
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  async refreshLatency(transportLatencySamples = 0): Promise<LiveEffectRackHealth> {
    if (!this.instanceId || !this.healthy) {
      return this.health;
    }
    const requestedTransportLatencySamples = boundedLatencySamples(transportLatencySamples, 0);
    const previousPluginLatencySamples = this.created?.latencySamples ?? 0;
    const previousTransportLatencySamples = this.transportLatencySamples;
    const previousReportedLatencySamples = this.reportedLatencySamples;
    const latency = await this.client.getLatency(this.instanceId, requestedTransportLatencySamples);
    const pluginLatencySamples = boundedLatencySamples(latency.pluginLatencySamples, previousPluginLatencySamples);
    const boundedTransportLatencySamples = boundedLatencySamples(
      latency.transportLatencySamples,
      previousTransportLatencySamples
    );
    if (this.created) {
      this.created.latencySamples = pluginLatencySamples;
    }
    this.transportLatencySamples = boundedTransportLatencySamples;
    this.reportedLatencySamples = combinedLatencySamples(pluginLatencySamples, boundedTransportLatencySamples);
    if (
      pluginLatencySamples !== previousPluginLatencySamples ||
      boundedTransportLatencySamples !== previousTransportLatencySamples ||
      this.reportedLatencySamples !== previousReportedLatencySamples
    ) {
      this.dispatchEvent(new CustomEvent("latencychange", { detail: this.health }));
    }
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return this.health;
  }

  async processBlock(request: LiveEffectBlockRequest): Promise<LiveEffectBlockResponse> {
    if (this.bypassed || !this.instanceId || !this.healthy) {
      const response = this.dryResponse(request, undefined);
      this.maybeRecoverFromFailure();
      return response;
    }
    if (this.isStaleInput(request.timestamp)) {
      this.staleInputBlocks = Math.min(1024, this.staleInputBlocks + 1);
      const response = this.dryResponse(request, undefined, "dry-stale-input");
      this.dispatchEvent(new CustomEvent("stale-input", { detail: { response, health: this.health } }));
      return response;
    }
    if (this.inFlightBlocks >= this.maxInFlightBlocks) {
      this.droppedInputBlocks = Math.min(1024, this.droppedInputBlocks + 1);
      const response = this.dryResponse(request, undefined, "dry-backpressure");
      this.dispatchEvent(new CustomEvent("input-backpressure", { detail: { response, health: this.health } }));
      return response;
    }
    let inFlightEpoch = this.inFlightEpoch;
    let outputStateVersion = this.outputStateVersion;
    const processStartedAt = liveEffectNowMs();
    try {
      const processRequest: BinaryAudioBlockRequest = {
        instanceId: this.instanceId,
        blockId: request.blockId,
        sampleRate: request.sampleRate ?? this.sampleRate,
        channels: boundedLiveEffectChannels(request.channels, this.inputChannels, this.maxBlockSize),
        inputBuses: boundedLiveEffectBusBlocks(request.inputBuses, this.maxBlockSize),
        transport: request.transport ?? liveTransportForBlock({ sampleRate: request.sampleRate ?? this.sampleRate, maxBlockSize: this.maxBlockSize, blockId: request.blockId, reportedLatencySamples: this.transportLatencySamples, compensateOutputLatency: true }),
        timestamp: request.timestamp,
        renderTimeoutMs: this.processTimeoutMs > 0 ? this.processTimeoutMs : undefined
      };
      const requestTimeoutMs = this.processTimeoutMs > 0 ? this.processTimeoutMs : undefined;
      const processed =
        this.audioTransport === "binary"
          ? this.client.processAudioBlockBinary(processRequest, requestTimeoutMs)
          : this.client.processAudioBlock(
              {
                ...processRequest,
                channels: cloneChannels(processRequest.channels, this.maxBlockSize),
                inputBuses: cloneBusBlocks(processRequest.inputBuses, this.maxBlockSize)
              },
              requestTimeoutMs
            );
      this.inFlightBlocks += 1;
      inFlightEpoch = this.inFlightEpoch;
      outputStateVersion = this.outputStateVersion;
      processed.then(() => this.releaseInFlightBlock(inFlightEpoch), () => this.releaseInFlightBlock(inFlightEpoch));
      const response = await withLiveEffectTimeout(processed, this.processTimeoutMs);
      if (this.outputStateChanged(inFlightEpoch, outputStateVersion)) {
        return this.dryResponse(request, undefined, this.bypassed ? "dry-bypass" : "dry-state-changed");
      }
      if (this.recordProcessBudget(liveEffectNowMs() - processStartedAt)) {
        const error = new Error("process_budget_exceeded");
        this.failClosed(error, "process-budget-exceeded");
        return this.dryResponse(request, error);
      }
      if (this.isStaleInput(request.timestamp)) {
        this.staleOutputBlocks = Math.min(1024, this.staleOutputBlocks + 1);
        const dry = this.dryResponse(request, undefined, "dry-stale-output");
        this.dispatchEvent(new CustomEvent("stale-output", { detail: { response: dry, health: this.health } }));
        return dry;
      }
      this.recordResponseLatency(response);
      if (this.recordRenderBudget(response)) {
        const error = new Error("render_budget_exceeded");
        this.failClosed(error, "render-budget-exceeded");
        return this.dryResponse(request, error);
      }
      return this.finishResponse({ ...response, bypassed: false, healthy: true }, processRequest.channels, request.wetMix);
    } catch (error) {
      if (this.outputStateChanged(inFlightEpoch, outputStateVersion)) {
        return this.dryResponse(request, undefined, this.bypassed ? "dry-bypass" : "dry-state-changed");
      }
      this.recordProcessBudget(liveEffectNowMs() - processStartedAt);
      this.failClosed(error, liveEffectFailureReason(error));
      return this.dryResponse(request, error);
    }
  }
  private async createInstance(): Promise<void> {
    this.destroyed = false;
    this.created = await this.client.createInstance({
      pluginId: this.plugin.pluginId,
      format: this.plugin.format,
      sampleRate: this.sampleRate,
      maxBlockSize: this.maxBlockSize,
      inputChannels: this.inputChannels,
      outputChannels: this.outputChannels
    });
    this.healthy = true;
    this.lastError = undefined;
    this.unhealthyReason = undefined;
    this.recoveryDryBlocks = 0;
    this.recoveryInProgress = false;
    this.inFlightEpoch += 1;
    this.inFlightBlocks = 0;
    this.droppedInputBlocks = 0;
    this.staleInputBlocks = 0;
    this.staleOutputBlocks = 0;
    this.processBudgetMisses = 0;
    this.lastProcessDurationMs = undefined;
    this.lastProcessBudgetMs = undefined;
    this.lastProcessBudgetExceeded = false;
    this.lastResponseDeadlineLeadMs = this.lastResponseDeadlineLeadBlocks = this.responseDeadlineLeadMinBlocks = this.responseDeadlineLeadMaxBlocks = undefined; this.responseJitterBlocks = this.responseDeadlineMisses = 0;
    this.transportLatencySamples = 0;
    this.reportedLatencySamples = this.created.latencySamples;
    this.renderBudgetMisses = 0;
    this.lastRenderDurationMs = undefined;
    this.lastRenderBudgetMs = undefined;
    this.lastRenderBudgetExceeded = false;
    this.lastRenderTimeoutMs = undefined;
    this.lastRenderTimeoutBudgetMs = undefined;
    this.lastRenderTimeoutBudgetDeltaMs = undefined;
    this.renderTimeouts = 0;
    this.consecutiveRenderTimeouts = 0;
    this.renderQuarantined = false;
    this.lastDryReason = undefined;
    this.lastOutputPath = undefined;
    this.lastOutputTail = undefined;
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  private async destroyInstance(): Promise<void> {
    const instanceId = this.instanceId;
    this.created = undefined;
    this.inFlightEpoch += 1;
    this.inFlightBlocks = 0;
    if (instanceId) {
      await this.client.destroyInstance(instanceId);
    }
  }

  private dryResponse(request: LiveEffectBlockRequest, error: unknown, renderEngine = "dry-bypass"): LiveEffectBlockResponse {
    return this.finishResponse({
      blockId: request.blockId,
      channels: dryChannels(request.channels, this.outputChannels, this.maxBlockSize),
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine,
      bypassed: true,
      healthy: this.healthy,
      error
    });
  }
  private recordRenderBudget(response: AudioBlockResponse): boolean {
    this.lastRenderDurationMs = boundedOptionalNumber(response.renderDurationMs, 0, 60000);
    this.lastRenderBudgetMs = boundedOptionalNumber(response.renderBudgetMs, 0, 60000);
    this.lastRenderBudgetExceeded = response.renderBudgetExceeded === true;
    this.renderBudgetMisses = this.lastRenderBudgetExceeded ? Math.min(1024, this.renderBudgetMisses + 1) : 0;
    if (this.lastRenderBudgetExceeded) {
      this.dispatchEvent(new CustomEvent("render-budget-exceeded", { detail: { response, health: this.health } }));
    }
    return this.maxConsecutiveRenderBudgetMisses > 0 && this.renderBudgetMisses >= this.maxConsecutiveRenderBudgetMisses;
  }

  private recordProcessBudget(durationMs: number): boolean {
    this.lastProcessDurationMs = boundedOptionalNumber(durationMs, 0, 60000);
    this.lastProcessBudgetMs = this.processBudgetMs > 0 ? this.processBudgetMs : undefined;
    this.recordResponseDeadlineLead();
    this.lastProcessBudgetExceeded = this.processBudgetMs > 0 && (this.lastProcessDurationMs ?? 0) > this.processBudgetMs;
    this.processBudgetMisses = this.lastProcessBudgetExceeded ? Math.min(1024, this.processBudgetMisses + 1) : 0;
    if (this.lastProcessBudgetExceeded) {
      this.dispatchEvent(new CustomEvent("process-budget-exceeded", { detail: { durationMs: this.lastProcessDurationMs, health: this.health } }));
    }
    return this.maxConsecutiveProcessBudgetMisses > 0 && this.processBudgetMisses >= this.maxConsecutiveProcessBudgetMisses;
  }

  private recordResponseDeadlineLead(): void {
    if (!this.lastProcessBudgetMs || this.lastProcessDurationMs === undefined) return;
    this.lastResponseDeadlineLeadMs = boundedOptionalNumber(this.lastProcessBudgetMs - this.lastProcessDurationMs, -60000, 60000);
    this.lastResponseDeadlineLeadBlocks = this.lastResponseDeadlineLeadMs === undefined ? undefined : Number((this.lastResponseDeadlineLeadMs / (this.maxBlockSize / this.sampleRate * 1000)).toFixed(3));
    this.responseDeadlineLeadMinBlocks = Math.min(this.responseDeadlineLeadMinBlocks ?? this.lastResponseDeadlineLeadBlocks ?? 0, this.lastResponseDeadlineLeadBlocks ?? 0);
    this.responseDeadlineLeadMaxBlocks = Math.max(this.responseDeadlineLeadMaxBlocks ?? this.lastResponseDeadlineLeadBlocks ?? 0, this.lastResponseDeadlineLeadBlocks ?? 0);
    this.responseJitterBlocks = Number(((this.responseDeadlineLeadMaxBlocks ?? 0) - (this.responseDeadlineLeadMinBlocks ?? 0)).toFixed(3));
    if ((this.lastResponseDeadlineLeadMs ?? 0) < 0) this.responseDeadlineMisses = Math.min(1024, this.responseDeadlineMisses + 1);
  }

  private recordResponseLatency(response: AudioBlockResponse): void {
    if (!this.created) {
      return;
    }
    const latencySamples = boundedLatencySamples(response.latencySamples, this.created.latencySamples);
    if (latencySamples === this.created.latencySamples) {
      return;
    }
    this.created.latencySamples = latencySamples;
    this.reportedLatencySamples = combinedLatencySamples(latencySamples, this.transportLatencySamples);
    this.dispatchEvent(new CustomEvent("latencychange", { detail: this.health }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  private maybeRecoverFromFailure(): void {
    if (this.unhealthyReason === "render-budget-exceeded") {
      this.maybeRecoverFromRenderPressure();
    } else if (this.unhealthyReason === "process-budget-exceeded") {
      this.maybeRecoverFromProcessBudget();
    } else if (this.unhealthyReason === "process-timeout") {
      this.maybeRecoverFromProcessTimeout();
    }
  }

  private maybeRecoverFromRenderPressure(): void {
    if (this.healthy || this.unhealthyReason !== "render-budget-exceeded" || this.renderBudgetRecoveryBlocks <= 0) {
      return;
    }
    this.recoveryDryBlocks = Math.min(4096, this.recoveryDryBlocks + 1);
    if (this.recoveryDryBlocks < this.renderBudgetRecoveryBlocks) {
      return;
    }
    this.healthy = true;
    this.lastError = undefined;
    this.unhealthyReason = undefined;
    this.recoveryDryBlocks = 0;
    this.renderBudgetMisses = 0;
    this.lastRenderBudgetExceeded = false;
    this.dispatchEvent(new CustomEvent("render-budget-recovered", { detail: { health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  private maybeRecoverFromProcessBudget(): void {
    if (this.healthy || this.unhealthyReason !== "process-budget-exceeded" || this.processBudgetRecoveryBlocks <= 0) {
      return;
    }
    this.recoveryDryBlocks = Math.min(4096, this.recoveryDryBlocks + 1);
    if (this.recoveryDryBlocks < this.processBudgetRecoveryBlocks) {
      return;
    }
    this.healthy = true;
    this.lastError = undefined;
    this.unhealthyReason = undefined;
    this.recoveryDryBlocks = 0;
    this.processBudgetMisses = 0;
    this.lastProcessBudgetExceeded = false;
    this.dispatchEvent(new CustomEvent("process-budget-recovered", { detail: { health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  private maybeRecoverFromProcessTimeout(): void {
    if (this.healthy || this.destroyed || this.unhealthyReason !== "process-timeout" || this.recoveryInProgress) {
      return;
    }
    if (this.maxProcessTimeoutRecoveries <= 0 || this.processTimeoutRecoveryAttempts >= this.maxProcessTimeoutRecoveries) {
      return;
    }
    this.recoveryDryBlocks = Math.min(4096, this.recoveryDryBlocks + 1);
    if (this.recoveryDryBlocks < this.processTimeoutRecoveryBlocks) {
      return;
    }
    this.recoveryInProgress = true;
    this.processTimeoutRecoveryAttempts = Math.min(32, this.processTimeoutRecoveryAttempts + 1);
    this.dispatchEvent(new CustomEvent("process-timeout-recovery-started", { detail: { health: this.health } }));
    this.recoverFromProcessTimeout();
  }

  private async recoverFromProcessTimeout(): Promise<void> {
    try {
      await this.destroyInstance().catch(() => undefined);
      if (this.destroyed) {
        return;
      }
      await this.createInstance();
      this.dispatchEvent(new CustomEvent("process-timeout-recovered", { detail: { health: this.health } }));
    } catch (error) {
      if (this.destroyed) {
        return;
      }
      this.recoveryInProgress = false;
      this.failClosed(error, "processing-error");
    }
  }

  private failClosed(error: unknown, reason: LiveEffectRackHealth["unhealthyReason"]): void {
    this.healthy = false;
    this.lastError = error;
    this.unhealthyReason = reason;
    this.recordRenderDeadlineDiagnostics(error);
    this.recoveryDryBlocks = 0;
    this.recoveryInProgress = false;
    this.dispatchEvent(new CustomEvent("effect-error", { detail: { error, health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  private recordRenderDeadlineDiagnostics(error: unknown): void {
    if (!isRenderDeadlineProtocolError(error)) {
      return;
    }
    const details = renderDeadlineDetails(error);
    this.lastRenderTimeoutMs = boundedOptionalNumber(details.renderTimeoutMs, 0, 60000);
    this.lastRenderTimeoutBudgetMs = boundedOptionalNumber(details.renderBudgetMs, 0, 60000);
    this.lastRenderTimeoutBudgetDeltaMs = boundedOptionalNumber(details.renderTimeoutBudgetDeltaMs, -60000, 60000);
    this.renderTimeouts = boundedLiveEffectInteger(details.renderTimeouts, Math.max(1, this.renderTimeouts), 0, 1_000_000);
    this.consecutiveRenderTimeouts = boundedLiveEffectInteger(
      details.consecutiveRenderTimeouts,
      Math.max(1, this.consecutiveRenderTimeouts),
      0,
      1_000_000
    );
    this.renderQuarantined = details.renderQuarantined === true || error.code === "render_quarantined" || error.code === "render_timeout";
  }

  private isStaleInput(timestamp: unknown): boolean {
    const capturedAt = Number(timestamp);
    return this.maxInputAgeMs > 0 && Number.isFinite(capturedAt) && liveEffectNowMs() - capturedAt > this.maxInputAgeMs;
  }

  private releaseInFlightBlock(epoch: number): void {
    if (epoch !== this.inFlightEpoch) {
      return;
    }
    this.inFlightBlocks = Math.max(0, this.inFlightBlocks - 1);
  }

  private outputStateChanged(epoch: number, stateVersion: number): boolean {
    return (
      epoch !== this.inFlightEpoch ||
      stateVersion !== this.outputStateVersion ||
      this.destroyed ||
      this.bypassed ||
      !this.instanceId ||
      !this.healthy
    );
  }

  private requireControllableInstance(): string {
    if (this.destroyed || !this.instanceId || !this.healthy) {
      throw new Error("SoundBridgeLiveEffectRack is not controllable while destroyed, missing an instance, or unhealthy.");
    }
    return this.instanceId;
  }

  private finishResponse(response: LiveEffectBlockResponse, dryInput?: ArrayLike<number>[], wetMixOverride?: number): LiveEffectBlockResponse {
    const outputPath = response.bypassed ? "dry" : "wet";
    const dryReason = response.bypassed ? liveEffectDryReason(response.renderEngine, this.unhealthyReason) : undefined;
    if (this.lastDryReason !== dryReason) { this.lastDryReason = dryReason; this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health })); }
    const mixed = response.bypassed ? boundedLiveEffectChannels(response.channels, this.outputChannels, this.maxBlockSize) : wetMixedChannels(response.channels, dryInput, this.outputChannels, boundedWetMix(wetMixOverride, this.wetMix), this.maxBlockSize);
    const channels = transitionOutputChannels(mixed, this.lastOutputTail, this.lastOutputPath, outputPath, this.transitionFadeSamples);
    this.lastOutputTail = outputTail(channels, this.outputChannels);
    this.lastOutputPath = outputPath;
    return channels === response.channels ? response : { ...response, channels };
  }
}

function boundedWetMix(value: unknown, fallback: number): number {
  return boundedLiveEffectNumber(value, fallback, 0, 1);
}
