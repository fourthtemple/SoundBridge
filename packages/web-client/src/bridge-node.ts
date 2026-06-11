import type { AudioBlockResponse } from "../../protocol/src/messages";
import { SoundBridgeClient } from "./client";

export interface SoundBridgeAudioNodeOptions {
  instanceId: string;
  inputChannels?: number;
  outputChannels?: number;
  maxInFlightBlocks?: number;
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

  private constructor(context: AudioContext, client: SoundBridgeClient, options: Required<SoundBridgeAudioNodeOptions>) {
    super();
    this.client = client;
    this.instanceId = options.instanceId;
    this.sampleRate = context.sampleRate;
    this.maxInFlightBlocks = options.maxInFlightBlocks;
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
        maxInFlightBlocks: options.maxInFlightBlocks
      }
    });
    this.node.port.onmessage = (event) => this.handleWorkletMessage(event.data);
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
      maxInFlightBlocks: options.maxInFlightBlocks ?? 8,
      workletUrl: options.workletUrl ?? "/packages/web-client/dist/soundbridge-worklet.js"
    };
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
    };

    if (typed.type === "stats") {
      this.dispatchEvent(new CustomEvent("stats", { detail: typed }));
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
    const channels = typed.channels.map((channel) => Array.from(channel));
    const requestedFrames = Math.floor(Number(typed.frames ?? channels[0]?.length ?? 128));
    const frames = Number.isFinite(requestedFrames) ? Math.max(1, requestedFrames) : 128;
    const requestedSamplePosition = Math.floor(typed.blockId * frames);
    const samplePosition = Number.isFinite(requestedSamplePosition)
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, requestedSamplePosition))
      : 0;
    this.client
      .processAudioBlock({
        instanceId: this.instanceId,
        blockId: typed.blockId,
        sampleRate: this.sampleRate,
        channels,
        transport: {
          playing: true,
          samplePosition
        },
        timestamp: performance.now()
      })
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
