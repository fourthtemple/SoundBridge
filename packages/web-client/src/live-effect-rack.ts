import type {
  AudioBlockRequest,
  AudioBlockResponse,
  CreateInstanceResponse,
  HostTransportState,
  PluginMetadata
} from "../../protocol/src/messages";
import { SoundBridgeClient } from "./client";
import type { BinaryAudioBlockRequest, BinaryAudioBusBlock } from "./client";

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
  processTimeoutMs?: number;
  transitionFadeSamples?: number;
  maxConsecutiveRenderBudgetMisses?: number;
  renderBudgetRecoveryBlocks?: number;
}

export interface LivePerformanceRackOptions extends LiveEffectRackOptions {
  maxInputAgeBlocks?: number;
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
  renderBudgetMisses: number;
  lastRenderDurationMs?: number;
  lastRenderBudgetMs?: number;
  renderBudgetExceeded: boolean;
  unhealthyReason?: "processing-error" | "process-timeout" | "render-budget-exceeded" | "destroyed";
  recoveryDryBlocks: number;
  renderBudgetRecoveryBlocks: number;
  processTimeoutMs: number;
  maxInputAgeMs: number;
  inFlightBlocks: number;
  maxInFlightBlocks: number;
  droppedInputBlocks: number;
  staleInputBlocks: number;
  transitionFadeSamples: number;
}

const LIVE_PERFORMANCE_INPUT_AGE_BLOCKS = 4;
const LIVE_PERFORMANCE_PROCESS_TIMEOUT_BLOCKS = 4;
const LIVE_PERFORMANCE_TRANSITION_FADE_BLOCKS = 0.5;
const LIVE_PERFORMANCE_RECOVERY_BLOCKS = 16;

export function createLivePerformanceRackOptions(options: LivePerformanceRackOptions): LiveEffectRackOptions {
  const {
    maxInputAgeBlocks,
    processTimeoutBlocks,
    transitionFadeBlocks,
    ...rackOptions
  } = options;
  const blockMs = liveEffectBlockDurationMs(options.sampleRate, options.maxBlockSize);
  const blockFrames = liveEffectBlockFrames(options.maxBlockSize);
  const inputAgeBlocks = boundedLiveEffectNumber(maxInputAgeBlocks, LIVE_PERFORMANCE_INPUT_AGE_BLOCKS, 0, 128);
  const timeoutBlocks = boundedLiveEffectNumber(processTimeoutBlocks, LIVE_PERFORMANCE_PROCESS_TIMEOUT_BLOCKS, 0, 128);
  const fadeBlocks = boundedLiveEffectNumber(transitionFadeBlocks, LIVE_PERFORMANCE_TRANSITION_FADE_BLOCKS, 0, 8);

  return {
    ...rackOptions,
    audioTransport: options.audioTransport ?? "binary",
    maxInputAgeMs: boundedLiveEffectNumber(options.maxInputAgeMs, blockMs * inputAgeBlocks, 0, 60000),
    maxInFlightBlocks: boundedLiveEffectInteger(options.maxInFlightBlocks, 1, 1, 32),
    processTimeoutMs: boundedLiveEffectNumber(options.processTimeoutMs, blockMs * timeoutBlocks, 0, 60000),
    transitionFadeSamples: boundedLiveEffectInteger(options.transitionFadeSamples, Math.ceil(blockFrames * fadeBlocks), 0, 4096),
    maxConsecutiveRenderBudgetMisses: boundedLiveEffectInteger(options.maxConsecutiveRenderBudgetMisses, 2, 0, 1024),
    renderBudgetRecoveryBlocks: boundedLiveEffectInteger(options.renderBudgetRecoveryBlocks, LIVE_PERFORMANCE_RECOVERY_BLOCKS, 0, 4096)
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
  readonly processTimeoutMs: number;
  readonly transitionFadeSamples: number;
  readonly maxConsecutiveRenderBudgetMisses: number;
  readonly renderBudgetRecoveryBlocks: number;

  private created?: CreateInstanceResponse;
  private bypassed = false;
  private healthy = true;
  private lastError?: unknown;
  private unhealthyReason?: LiveEffectRackHealth["unhealthyReason"];
  private recoveryDryBlocks = 0;
  private inFlightEpoch = 0;
  private inFlightBlocks = 0;
  private droppedInputBlocks = 0;
  private staleInputBlocks = 0;
  private renderBudgetMisses = 0;
  private lastRenderDurationMs?: number;
  private lastRenderBudgetMs?: number;
  private lastRenderBudgetExceeded = false;
  private lastOutputPath?: "wet" | "dry";
  private lastOutputTail?: number[];

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
    this.processTimeoutMs = boundedLiveEffectNumber(options.processTimeoutMs, 0, 0, 60000);
    this.transitionFadeSamples = boundedLiveEffectInteger(options.transitionFadeSamples, 0, 0, 4096);
    this.maxConsecutiveRenderBudgetMisses = boundedLiveEffectInteger(options.maxConsecutiveRenderBudgetMisses, 3, 0, 1024);
    this.renderBudgetRecoveryBlocks = boundedLiveEffectInteger(options.renderBudgetRecoveryBlocks, 0, 0, 4096);
  }

  static async create(options: LiveEffectRackOptions): Promise<SoundBridgeLiveEffectRack> {
    const rack = new SoundBridgeLiveEffectRack(options);
    await rack.createInstance();
    return rack;
  }

  static createLivePerformance(options: LivePerformanceRackOptions): Promise<SoundBridgeLiveEffectRack> {
    return SoundBridgeLiveEffectRack.create(createLivePerformanceRackOptions(options));
  }

  get instanceId(): string | undefined {
    return this.created?.instanceId;
  }

  get health(): LiveEffectRackHealth {
    return {
      bypassed: this.bypassed,
      healthy: this.healthy,
      instanceId: this.instanceId,
      lastError: this.lastError,
      latencySamples: this.created?.latencySamples ?? 0,
      renderBudgetMisses: this.renderBudgetMisses,
      lastRenderDurationMs: this.lastRenderDurationMs,
      lastRenderBudgetMs: this.lastRenderBudgetMs,
      renderBudgetExceeded: this.lastRenderBudgetExceeded,
      unhealthyReason: this.unhealthyReason,
      recoveryDryBlocks: this.recoveryDryBlocks,
      renderBudgetRecoveryBlocks: this.renderBudgetRecoveryBlocks,
      processTimeoutMs: this.processTimeoutMs,
      maxInputAgeMs: this.maxInputAgeMs,
      inFlightBlocks: this.inFlightBlocks,
      maxInFlightBlocks: this.maxInFlightBlocks,
      droppedInputBlocks: this.droppedInputBlocks,
      staleInputBlocks: this.staleInputBlocks,
      transitionFadeSamples: this.transitionFadeSamples
    };
  }

  setBypassed(bypassed: boolean): void {
    this.bypassed = bypassed;
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  async recreate(): Promise<void> {
    await this.destroyInstance().catch(() => undefined);
    await this.createInstance();
  }

  async destroy(): Promise<void> {
    await this.destroyInstance();
    this.healthy = false;
    this.unhealthyReason = "destroyed";
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  async refreshLatency(transportLatencySamples = 0): Promise<LiveEffectRackHealth> {
    if (!this.instanceId || !this.healthy) {
      return this.health;
    }
    const latency = await this.client.getLatency(this.instanceId, transportLatencySamples);
    if (this.created) {
      this.created.latencySamples = latency.pluginLatencySamples;
    }
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return this.health;
  }

  async processBlock(request: LiveEffectBlockRequest): Promise<LiveEffectBlockResponse> {
    if (this.bypassed || !this.instanceId || !this.healthy) {
      const response = this.dryResponse(request, undefined);
      this.maybeRecoverFromRenderPressure();
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

    try {
      const processRequest: BinaryAudioBlockRequest = {
        instanceId: this.instanceId,
        blockId: request.blockId,
        sampleRate: request.sampleRate ?? this.sampleRate,
        channels: request.channels,
        inputBuses: request.inputBuses,
        transport: request.transport,
        timestamp: request.timestamp
      };
      const processed =
        this.audioTransport === "binary"
          ? this.client.processAudioBlockBinary(processRequest)
          : this.client.processAudioBlock({
              ...processRequest,
              channels: cloneChannels(request.channels),
              inputBuses: cloneBusBlocks(request.inputBuses)
            });
      this.inFlightBlocks += 1;
      const inFlightEpoch = this.inFlightEpoch;
      processed.then(() => this.releaseInFlightBlock(inFlightEpoch), () => this.releaseInFlightBlock(inFlightEpoch));
      const response = await withLiveEffectTimeout(processed, this.processTimeoutMs);
      if (this.recordRenderBudget(response)) {
        const error = new Error("render_budget_exceeded");
        this.failClosed(error, "render-budget-exceeded");
        return this.dryResponse(request, error);
      }
      return this.finishResponse({ ...response, bypassed: false, healthy: true });
    } catch (error) {
      this.failClosed(error, liveEffectFailureReason(error));
      return this.dryResponse(request, error);
    }
  }

  private async createInstance(): Promise<void> {
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
    this.inFlightEpoch += 1;
    this.inFlightBlocks = 0;
    this.droppedInputBlocks = 0;
    this.staleInputBlocks = 0;
    this.renderBudgetMisses = 0;
    this.lastRenderDurationMs = undefined;
    this.lastRenderBudgetMs = undefined;
    this.lastRenderBudgetExceeded = false;
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
      channels: dryChannels(request.channels, this.outputChannels),
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

  private failClosed(error: unknown, reason: LiveEffectRackHealth["unhealthyReason"]): void {
    this.healthy = false;
    this.lastError = error;
    this.unhealthyReason = reason;
    this.recoveryDryBlocks = 0;
    this.dispatchEvent(new CustomEvent("effect-error", { detail: { error, health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
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

  private finishResponse(response: LiveEffectBlockResponse): LiveEffectBlockResponse {
    const outputPath = response.bypassed ? "dry" : "wet";
    const channels = transitionOutputChannels(response.channels, this.lastOutputTail, this.lastOutputPath, outputPath, this.transitionFadeSamples);
    this.lastOutputTail = outputTail(channels, this.outputChannels);
    this.lastOutputPath = outputPath;
    return channels === response.channels ? response : { ...response, channels };
  }
}

function boundedChannelCount(value: number): number {
  const channels = Math.floor(Number(value));
  return Number.isFinite(channels) ? Math.max(1, Math.min(32, channels)) : 2;
}

function boundedLiveEffectInteger(value: unknown, fallback: number, min: number, max: number): number {
  const integer = Math.floor(Number(value ?? fallback));
  return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
}

function boundedLiveEffectNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function liveEffectBlockDurationMs(sampleRate: number, maxBlockSize: number): number {
  const rate = Number(sampleRate);
  const frames = Number(maxBlockSize);
  return Number.isFinite(rate) && rate > 0 && Number.isFinite(frames) && frames > 0 ? (frames / rate) * 1000 : 0;
}

function liveEffectBlockFrames(maxBlockSize: number): number {
  const frames = Math.floor(Number(maxBlockSize));
  return Number.isFinite(frames) && frames > 0 ? Math.min(frames, 8192) : 0;
}

function boundedOptionalNumber(value: unknown, min: number, max: number): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : undefined;
}

async function withLiveEffectTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(liveEffectTimeoutError()), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function liveEffectTimeoutError(): Error {
  const error = new Error("process_block_timeout");
  error.name = "SoundBridgeLiveEffectTimeout";
  return error;
}

function liveEffectFailureReason(error: unknown): LiveEffectRackHealth["unhealthyReason"] {
  return error instanceof Error && error.name === "SoundBridgeLiveEffectTimeout" ? "process-timeout" : "processing-error";
}

function liveEffectNowMs(): number {
  return typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();
}

function transitionOutputChannels(channels: ArrayLike<number>[], previousTail: number[] | undefined, previousPath: "wet" | "dry" | undefined, outputPath: "wet" | "dry", fadeSamples: number): ArrayLike<number>[] {
  if (fadeSamples <= 0 || !previousTail || previousPath === undefined || previousPath === outputPath) {
    return channels;
  }
  return channels.map((source, channelIndex) => {
    const output = Array.from(source);
    const fade = Math.min(output.length, fadeSamples);
    const previous = previousTail[channelIndex % previousTail.length] ?? 0;
    for (let frame = 0; frame < fade; frame += 1) {
      const wet = (frame + 1) / (fade + 1);
      output[frame] = previous * (1 - wet) + output[frame] * wet;
    }
    return output;
  });
}

function outputTail(channels: ArrayLike<number>[], outputChannels: number): number[] {
  return Array.from({ length: outputChannels }, (_, index) => {
    const channel = channels.length > 0 ? channels[index % channels.length] : undefined;
    const sample = Number(channel?.[Math.max(0, channel.length - 1)] ?? 0);
    return Number.isFinite(sample) ? sample : 0;
  });
}

function cloneChannels(channels: ArrayLike<number>[]): number[][] {
  return channels.map((channel) => Array.from(channel));
}

function cloneBusBlocks(buses?: BinaryAudioBusBlock[]): AudioBlockRequest["inputBuses"] {
  return buses?.map((bus) => ({ index: bus.index, channels: cloneChannels(bus.channels) }));
}

function dryChannels(channels: ArrayLike<number>[], outputChannels: number): number[][] {
  const frames = channels[0]?.length ?? 0;
  return Array.from({ length: outputChannels }, (_, index) => {
    const source = channels.length > 0 ? channels[index % channels.length] : undefined;
    return source ? Array.from(source) : Array.from({ length: frames }, () => 0);
  });
}
