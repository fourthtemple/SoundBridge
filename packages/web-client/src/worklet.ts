class SoundBridgeAudioProcessor extends AudioWorkletProcessor {
  private readonly outputChannels: number;
  private readonly maxQueuedOutputBlocks: number;
  private readonly outputLatencyBlocks: number;
  private blockId = 0;
  private underruns = 0;
  private processedBlocks = 0;
  private staleOutputBlocks = 0;
  private droppedInputBlocks = 0;
  private inFlightBlocks = 0;
  private readonly outputBlocks = new Map<number, Float32Array[]>();
  private readonly maxInFlightBlocks: number;
  private transportPort?: MessagePort;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const processorOptions = options.processorOptions ?? {};
    this.outputChannels = processorOptions.outputChannels ?? 2;
    this.maxInFlightBlocks = this.boundedInteger(processorOptions.maxInFlightBlocks, 8, 1, 64);
    this.maxQueuedOutputBlocks = this.boundedInteger(processorOptions.maxQueuedOutputBlocks, 16, 1, 64);
    this.outputLatencyBlocks = this.boundedInteger(
      processorOptions.outputLatencyBlocks,
      Math.min(2, this.maxQueuedOutputBlocks),
      1,
      this.maxQueuedOutputBlocks
    );
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    const frames = output[0]?.length ?? input[0]?.length ?? 128;
    const outgoing = this.copyInputBlock(input, frames);
    const currentBlockId = this.blockId++;
    const targetBlockId = currentBlockId - this.outputLatencyBlocks;
    const queued = targetBlockId >= 0 ? this.outputBlocks.get(targetBlockId) : undefined;

    if (queued) {
      this.outputBlocks.delete(targetBlockId);
      this.writeBlock(output, queued, frames);
      this.processedBlocks += 1;
    } else {
      this.writeBlock(output, outgoing, frames);
      this.underruns += 1;
    }
    this.dropStaleOutputBlocks(targetBlockId);

    const processMessage = {
      type: "process",
      blockId: currentBlockId,
      frames,
      channels: outgoing
    };
    const transfer = outgoing.map((channel) => channel.buffer);
    if (this.transportPort) {
      if (this.inFlightBlocks >= this.maxInFlightBlocks) {
        this.droppedInputBlocks += 1;
      } else {
        this.inFlightBlocks += 1;
        this.transportPort.postMessage(processMessage, transfer);
      }
    } else {
      this.port.postMessage(processMessage, transfer);
    }

    if (this.blockId % 128 === 0) {
      this.port.postMessage({
        type: "stats",
        processedBlocks: this.processedBlocks,
        underruns: this.underruns,
        queuedOutputBlocks: this.outputBlocks.size,
        outputLatencyBlocks: this.outputLatencyBlocks,
        staleOutputBlocks: this.staleOutputBlocks,
        droppedInputBlocks: this.droppedInputBlocks
      });
    }

    return true;
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") {
      return;
    }

    const typed = message as { type?: string; blockId?: number; channels?: number[][]; port?: MessagePort; renderEngine?: string; error?: unknown };
    if (typed.type === "destroy") {
      this.outputBlocks.clear();
      this.transportPort?.postMessage({ type: "destroy" });
      this.transportPort = undefined;
      return;
    }

    if (typed.type === "connect-transport" && typed.port) {
      this.transportPort = typed.port;
      this.transportPort.onmessage = (event) => this.handleMessage(event.data);
      return;
    }

    if (typed.type === "dropped") {
      this.droppedInputBlocks += 1;
      return;
    }

    if (typed.type === "audio-error") {
      this.inFlightBlocks = Math.max(0, this.inFlightBlocks - 1);
      this.port.postMessage({ type: "audio-error", error: typed.error });
      return;
    }

    if (typed.type !== "processed" || !Array.isArray(typed.channels)) {
      return;
    }
    this.inFlightBlocks = Math.max(0, this.inFlightBlocks - 1);

    const blockId = Math.floor(Number(typed.blockId));
    if (!Number.isFinite(blockId) || blockId < 0) {
      return;
    }

    if (blockId < this.blockId - this.outputLatencyBlocks) {
      this.staleOutputBlocks += 1;
      return;
    }

    if (this.outputBlocks.size >= this.maxQueuedOutputBlocks && !this.outputBlocks.has(blockId)) {
      this.dropOldestOutputBlock();
    }

    this.outputBlocks.set(blockId, typed.channels.slice(0, this.outputChannels).map((channel) => Float32Array.from(channel)));
    if (typeof typed.renderEngine === "string") {
      this.port.postMessage({ type: "process-diagnostics", blockId, renderEngine: typed.renderEngine });
    }
  }

  private copyInputBlock(input: Float32Array[], frames: number): Float32Array[] {
    const channels: Float32Array[] = [];
    for (let channelIndex = 0; channelIndex < this.outputChannels; channelIndex += 1) {
      const source = input[channelIndex] ?? input[0];
      const copy = new Float32Array(frames);
      if (source) {
        copy.set(source.subarray(0, frames));
      }
      channels.push(copy);
    }
    return channels;
  }

  private writeBlock(output: Float32Array[], block: Float32Array[], frames: number): void {
    for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
      const destination = output[channelIndex];
      const source = block[channelIndex] ?? block[0];
      if (!destination) {
        continue;
      }
      if (source) {
        destination.set(source.subarray(0, frames));
      } else {
        destination.fill(0);
      }
    }
  }

  private dropOldestOutputBlock(): void {
    let oldestBlockId = Number.POSITIVE_INFINITY;
    for (const blockId of this.outputBlocks.keys()) {
      oldestBlockId = Math.min(oldestBlockId, blockId);
    }
    if (Number.isFinite(oldestBlockId)) {
      this.outputBlocks.delete(oldestBlockId);
      this.staleOutputBlocks += 1;
    }
  }

  private dropStaleOutputBlocks(targetBlockId: number): void {
    if (targetBlockId < 0) {
      return;
    }
    for (const blockId of Array.from(this.outputBlocks.keys())) {
      if (blockId < targetBlockId) {
        this.outputBlocks.delete(blockId);
        this.staleOutputBlocks += 1;
      }
    }
  }

  private boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
    const integer = Math.floor(Number(value ?? fallback));
    return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
  }
}

registerProcessor("soundbridge-audio-processor", SoundBridgeAudioProcessor);
