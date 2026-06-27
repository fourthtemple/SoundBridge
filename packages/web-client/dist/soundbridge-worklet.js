class SoundBridgeAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options.processorOptions ?? {};
    this.outputChannels = processorOptions.outputChannels ?? 2;
    this.maxQueuedOutputBlocks = this.boundedInteger(processorOptions.maxQueuedOutputBlocks, 16, 1, 64);
    this.outputLatencyBlocks = this.boundedInteger(
      processorOptions.outputLatencyBlocks,
      Math.min(2, this.maxQueuedOutputBlocks),
      1,
      this.maxQueuedOutputBlocks
    );
    this.blockId = 0;
    this.underruns = 0;
    this.processedBlocks = 0;
    this.staleOutputBlocks = 0;
    this.droppedInputBlocks = 0;
    this.inFlightBlocks = 0;
    this.outputBlocks = new Map();
    this.maxInFlightBlocks = this.boundedInteger(processorOptions.maxInFlightBlocks, 8, 1, 64);
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  process(inputs, outputs) {
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

  handleMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "destroy") {
      this.outputBlocks.clear();
      this.transportPort?.postMessage({ type: "destroy" });
      this.transportPort = void 0;
      return;
    }

    if (message.type === "connect-transport" && message.port) {
      this.transportPort = message.port;
      this.transportPort.onmessage = (event) => this.handleMessage(event.data);
      return;
    }

    if (message.type === "dropped") {
      this.droppedInputBlocks += 1;
      return;
    }

    if (message.type === "audio-error") {
      this.inFlightBlocks = Math.max(0, this.inFlightBlocks - 1);
      this.port.postMessage({ type: "audio-error", error: message.error });
      return;
    }

    if (message.type !== "processed" || !Array.isArray(message.channels)) {
      return;
    }
    this.inFlightBlocks = Math.max(0, this.inFlightBlocks - 1);

    const blockId = Math.floor(Number(message.blockId));
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

    this.outputBlocks.set(blockId, message.channels.slice(0, this.outputChannels).map((channel) => Float32Array.from(channel)));
    if (typeof message.renderEngine === "string") {
      this.port.postMessage({ type: "process-diagnostics", blockId, renderEngine: message.renderEngine });
    }
  }

  copyInputBlock(input, frames) {
    const channels = [];
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

  writeBlock(output, block, frames) {
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

  dropOldestOutputBlock() {
    let oldestBlockId = Number.POSITIVE_INFINITY;
    for (const blockId of this.outputBlocks.keys()) {
      oldestBlockId = Math.min(oldestBlockId, blockId);
    }
    if (Number.isFinite(oldestBlockId)) {
      this.outputBlocks.delete(oldestBlockId);
      this.staleOutputBlocks += 1;
    }
  }

  dropStaleOutputBlocks(targetBlockId) {
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

  boundedInteger(value, fallback, min, max) {
    const integer = Math.floor(Number(value ?? fallback));
    return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
  }
}

registerProcessor("soundbridge-audio-processor", SoundBridgeAudioProcessor);
