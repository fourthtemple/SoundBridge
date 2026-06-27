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
  targetResponseDeadlineLeadBlocks?: number;
  latencyPressureThresholdBlocks?: number;
  audioTransport?: "binary" | "json";
  audioTransferMode?: "auto" | "message" | "shared";
  sharedBufferBlocks?: number;
  maxBlockFrames?: number;
  workletUrl?: string;
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

  private constructor(context: AudioContext, client: SoundBridgeClient, options: Required<SoundBridgeAudioNodeOptions>) {
    super();
    this.client = client;
    this.instanceId = options.instanceId;
    this.sampleRate = context.sampleRate;
    this.maxInFlightBlocks = options.maxInFlightBlocks;
    this.audioTransport = options.audioTransport;
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
      targetResponseDeadlineLeadBlocks: boundedInteger(options.targetResponseDeadlineLeadBlocks, 1, 0, 16),
      latencyPressureThresholdBlocks: boundedInteger(options.latencyPressureThresholdBlocks, 4, 1, 64),
      audioTransport: options.audioTransport === "json" ? "json" : "binary",
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

  connect(destination: AudioNode, output?: number, input?: number): AudioNode {
    return this.node.connect(destination, output, input);
  }

  disconnect(): void {
    this.node.disconnect();
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
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
      renderEngine?: string;
      error?: unknown;
    };

    if (typed.type === "stats") {
      this.dispatchEvent(new CustomEvent("stats", { detail: typed }));
      return;
    }

    if (typed.type === "process-diagnostics") {
      this.dispatchEvent(new CustomEvent("process-diagnostics", { detail: typed }));
      return;
    }

    if (typed.type === "audio-error") {
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
      timestamp: performance.now()
    };
    const processed =
      this.audioTransport === "binary"
        ? this.client.processAudioBlockBinary(request)
        : this.client.processAudioBlock({ ...request, channels: binaryChannels.map((channel) => Array.from(channel)) });

    processed
      .then((response: AudioBlockResponse) => {
        if (this.destroyed) {
          return;
        }
        if (typeof response.renderEngine === "string") {
          this.dispatchEvent(
            new CustomEvent("process-diagnostics", {
              detail: {
                blockId: response.blockId,
                renderEngine: response.renderEngine
              }
            })
          );
        }
        this.node.port.postMessage({
          type: "processed",
          blockId: response.blockId,
          channels: response.channels,
          latencySamples: response.latencySamples
        });
      })
      .catch((error) => {
        if (this.destroyed) {
          return;
        }
        this.dispatchEvent(new CustomEvent("audio-error", { detail: error }));
      })
      .finally(() => {
        this.inFlightBlocks -= 1;
      });
  }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const integer = Math.floor(Number(value ?? fallback));
  return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
}
