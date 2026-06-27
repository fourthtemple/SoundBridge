import type {
  AudioBlockRequest,
  AudioBlockResponse,
  CreateInstanceResponse,
  HostTransportState,
  PluginMetadata
} from "../../protocol/src/messages";
import { SoundBridgeClient } from "./client";

export interface LiveEffectRackOptions {
  client: SoundBridgeClient;
  plugin: PluginMetadata;
  sampleRate: number;
  maxBlockSize: number;
  inputChannels?: number;
  outputChannels?: number;
}

export interface LiveEffectBlockRequest {
  blockId: number;
  channels: number[][];
  sampleRate?: number;
  inputBuses?: AudioBlockRequest["inputBuses"];
  transport?: HostTransportState;
  timestamp?: number;
}

export interface LiveEffectBlockResponse extends AudioBlockResponse {
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
}

export class SoundBridgeLiveEffectRack extends EventTarget {
  readonly client: SoundBridgeClient;
  readonly plugin: PluginMetadata;
  readonly sampleRate: number;
  readonly maxBlockSize: number;
  readonly inputChannels: number;
  readonly outputChannels: number;

  private created?: CreateInstanceResponse;
  private bypassed = false;
  private healthy = true;
  private lastError?: unknown;

  private constructor(options: LiveEffectRackOptions) {
    super();
    this.client = options.client;
    this.plugin = options.plugin;
    this.sampleRate = options.sampleRate;
    this.maxBlockSize = options.maxBlockSize;
    this.inputChannels = boundedChannelCount(options.inputChannels ?? options.plugin.inputs ?? 2);
    this.outputChannels = boundedChannelCount(options.outputChannels ?? options.plugin.outputs ?? this.inputChannels);
  }

  static async create(options: LiveEffectRackOptions): Promise<SoundBridgeLiveEffectRack> {
    const rack = new SoundBridgeLiveEffectRack(options);
    await rack.createInstance();
    return rack;
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
      latencySamples: this.created?.latencySamples ?? 0
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
      return this.dryResponse(request, undefined);
    }

    try {
      const response = await this.client.processAudioBlock({
        instanceId: this.instanceId,
        blockId: request.blockId,
        sampleRate: request.sampleRate ?? this.sampleRate,
        channels: cloneChannels(request.channels),
        inputBuses: request.inputBuses,
        transport: request.transport,
        timestamp: request.timestamp
      });
      return { ...response, bypassed: false, healthy: true };
    } catch (error) {
      this.healthy = false;
      this.lastError = error;
      this.dispatchEvent(new CustomEvent("effect-error", { detail: { error, health: this.health } }));
      this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
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
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  private async destroyInstance(): Promise<void> {
    const instanceId = this.instanceId;
    this.created = undefined;
    if (instanceId) {
      await this.client.destroyInstance(instanceId);
    }
  }

  private dryResponse(request: LiveEffectBlockRequest, error: unknown): LiveEffectBlockResponse {
    return {
      blockId: request.blockId,
      channels: dryChannels(request.channels, this.outputChannels),
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine: "dry-bypass",
      bypassed: true,
      healthy: this.healthy,
      error
    };
  }
}

function boundedChannelCount(value: number): number {
  const channels = Math.floor(Number(value));
  return Number.isFinite(channels) ? Math.max(1, Math.min(32, channels)) : 2;
}

function cloneChannels(channels: number[][]): number[][] {
  return channels.map((channel) => Array.from(channel));
}

function dryChannels(channels: number[][], outputChannels: number): number[][] {
  const frames = channels[0]?.length ?? 0;
  return Array.from({ length: outputChannels }, (_, index) => {
    const source = channels.length > 0 ? channels[index % channels.length] : undefined;
    return source ? Array.from(source) : Array.from({ length: frames }, () => 0);
  });
}
