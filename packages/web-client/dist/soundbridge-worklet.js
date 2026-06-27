class SoundBridgeAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options.processorOptions ?? {};
    this.outputChannels = this.boundedInteger(processorOptions.outputChannels, 2, 1, 32);
    this.maxQueuedOutputBlocks = this.boundedInteger(processorOptions.maxQueuedOutputBlocks, 16, 1, 64);
    this.outputLatencyBlocks = this.boundedInteger(
      processorOptions.outputLatencyBlocks,
      Math.min(2, this.maxQueuedOutputBlocks),
      1,
      this.maxQueuedOutputBlocks
    );
    this.minOutputLatencyBlocks = this.boundedInteger(
      processorOptions.minOutputLatencyBlocks,
      1,
      1,
      this.outputLatencyBlocks
    );
    this.maxOutputLatencyBlocks = this.boundedInteger(
      processorOptions.maxOutputLatencyBlocks,
      Math.min(this.maxQueuedOutputBlocks, Math.max(this.outputLatencyBlocks + 2, 4)),
      this.outputLatencyBlocks,
      this.maxQueuedOutputBlocks
    );
    this.adaptiveOutputLatency = processorOptions.adaptiveOutputLatency !== false;
    this.latencyMissThresholdBlocks = this.boundedInteger(processorOptions.latencyMissThresholdBlocks, 2, 1, 32);
    this.latencyRecoveryBlocks = this.boundedInteger(processorOptions.latencyRecoveryBlocks, 512, 32, 8192);
    this.blockId = 0;
    this.lastFrames = 128;
    this.underruns = 0;
    this.processedBlocks = 0;
    this.staleOutputBlocks = 0;
    this.droppedInputBlocks = 0;
    this.latencyIncreases = 0;
    this.latencyDecreases = 0;
    this.sharedInputDroppedBlocks = 0;
    this.sharedOutputDroppedBlocks = 0;
    this.consecutiveLatencyMisses = 0;
    this.consecutiveOnTimeBlocks = 0;
    this.inputBufferAllocations = 0;
    this.inputBufferReuses = 0;
    this.pooledInputBuffers = 0;
    this.inFlightBlocks = 0;
    this.responseBlocks = 0;
    this.responseBlocksSinceLastStats = 0;
    this.responseDeadlineMisses = 0;
    this.responseDeadlineMissesSinceLastStats = 0;
    this.responseDeadlineLeadBlocks = 0;
    this.responseDeadlineLeadMinBlocks = void 0;
    this.responseDeadlineLeadMaxBlocks = void 0;
    this.outputBlocks = new Map();
    this.inputBufferPool = new Map();
    this.maxInFlightBlocks = this.boundedInteger(processorOptions.maxInFlightBlocks, 8, 1, 64);
    this.maxRecycledInputBuffers = this.outputChannels * Math.max(2, this.maxInFlightBlocks);
    this.sharedAudio = void 0;
    this.sharedAudioWakeMode = "none";
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  process(inputs, outputs) {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    const frames = output[0]?.length ?? input[0]?.length ?? 128;
    this.lastFrames = frames;
    this.drainSharedOutput();
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
    this.recordOutputTiming(Boolean(queued), targetBlockId);
    const staleDropped = this.dropStaleOutputBlocks(targetBlockId);
    if (staleDropped > 0) {
      this.recordLateOutput();
    }

    this.postProcessBlock(currentBlockId, frames, outgoing);

    if (this.blockId % 128 === 0) {
      const leadMinBlocks = this.responseDeadlineLeadMinBlocks ?? 0;
      const leadMaxBlocks = this.responseDeadlineLeadMaxBlocks ?? 0;
      const jitterBlocks = this.responseBlocksSinceLastStats > 0 ? leadMaxBlocks - leadMinBlocks : 0;
      this.port.postMessage({
        type: "stats",
        processedBlocks: this.processedBlocks,
        underruns: this.underruns,
        queuedOutputBlocks: this.outputBlocks.size,
        outputLatencyBlocks: this.outputLatencyBlocks,
        minOutputLatencyBlocks: this.minOutputLatencyBlocks,
        maxOutputLatencyBlocks: this.maxOutputLatencyBlocks,
        adaptiveOutputLatency: this.adaptiveOutputLatency,
        transportLatencySamples: this.transportLatencySamples(),
        latencyIncreases: this.latencyIncreases,
        latencyDecreases: this.latencyDecreases,
        sharedAudioEnabled: Boolean(this.sharedAudio),
        sharedAudioWakeMode: this.sharedAudioWakeMode,
        sharedInputQueuedBlocks: this.sharedAudio ? Atomics.load(this.sharedAudio.inputControl, SoundBridgeAudioProcessor.sharedAvailable) : 0,
        sharedOutputQueuedBlocks: this.sharedAudio ? Atomics.load(this.sharedAudio.outputControl, SoundBridgeAudioProcessor.sharedAvailable) : 0,
        sharedInputDroppedBlocks: this.sharedInputDroppedBlocks,
        sharedOutputDroppedBlocks: this.sharedOutputDroppedBlocks,
        staleOutputBlocks: this.staleOutputBlocks,
        droppedInputBlocks: this.droppedInputBlocks,
        inputBufferAllocations: this.inputBufferAllocations,
        inputBufferReuses: this.inputBufferReuses,
        pooledInputBuffers: this.pooledInputBuffers,
        inFlightBlocks: this.inFlightBlocks,
        responseBlocks: this.responseBlocks,
        responseBlocksSinceLastStats: this.responseBlocksSinceLastStats,
        responseDeadlineLeadBlocks: this.responseDeadlineLeadBlocks,
        responseDeadlineLeadMinBlocks: this.responseBlocksSinceLastStats > 0 ? leadMinBlocks : 0,
        responseDeadlineLeadMaxBlocks: this.responseBlocksSinceLastStats > 0 ? leadMaxBlocks : 0,
        responseDeadlineLeadSamples: this.responseDeadlineLeadBlocks * this.lastFrames,
        responseJitterBlocks: jitterBlocks,
        responseJitterSamples: jitterBlocks * this.lastFrames,
        responseDeadlineMisses: this.responseDeadlineMisses,
        responseDeadlineMissesSinceLastStats: this.responseDeadlineMissesSinceLastStats
      });
      this.resetResponseDeadlineWindow();
    }

    return true;
  }

  handleMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "destroy") {
      this.outputBlocks.clear();
      this.inputBufferPool.clear();
      this.resetResponseDeadlineState();
      this.pooledInputBuffers = 0;
      this.sharedAudio = void 0;
      this.sharedAudioWakeMode = "none";
      this.transportPort?.postMessage({ type: "destroy" });
      this.transportPort = void 0;
      return;
    }

    if (message.type === "connect-transport" && message.port) {
      this.transportPort = message.port;
      this.transportPort.onmessage = (event) => this.handleMessage(event.data);
      this.sharedAudio = this.normalizeSharedAudio(message.sharedAudio);
      this.sharedAudioWakeMode = this.sharedAudio ? "pending" : "none";
      return;
    }

    if (message.type === "shared-audio-status") {
      if (message.wakeMode === "atomics" || message.wakeMode === "timer") {
        this.sharedAudioWakeMode = message.wakeMode;
      }
      return;
    }

    if (message.type === "dropped") {
      this.droppedInputBlocks += 1;
      return;
    }

    if (message.type === "recycle-input" && Array.isArray(message.channels)) {
      this.recycleInputBlock(message.channels, message.frames);
      return;
    }

    if (message.type === "audio-error") {
      this.inFlightBlocks = Math.max(0, this.inFlightBlocks - 1);
      this.port.postMessage({ type: "audio-error", error: message.error });
      return;
    }

    if (message.type === "process-diagnostics" && typeof message.renderEngine === "string") {
      this.port.postMessage({ type: "process-diagnostics", blockId: message.blockId, renderEngine: message.renderEngine });
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

    this.recordResponseDeadline(blockId);
    if (blockId < this.blockId - this.outputLatencyBlocks) {
      this.staleOutputBlocks += 1;
      this.recordLateOutput();
      return;
    }

    if (this.outputBlocks.size >= this.maxQueuedOutputBlocks && !this.outputBlocks.has(blockId)) {
      this.dropOldestOutputBlock();
    }

    this.outputBlocks.set(blockId, message.channels.slice(0, this.outputChannels).map((channel) => this.outputChannelBlock(channel)));
    if (typeof message.renderEngine === "string") {
      this.port.postMessage({ type: "process-diagnostics", blockId, renderEngine: message.renderEngine });
    }
  }

  copyInputBlock(input, frames) {
    const channels = [];
    for (let channelIndex = 0; channelIndex < this.outputChannels; channelIndex += 1) {
      const source = input[channelIndex] ?? input[0];
      const copy = this.takeInputBuffer(frames);
      if (source) {
        copy.set(source.subarray(0, frames));
      } else {
        copy.fill(0);
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

  outputChannelBlock(channel) {
    return channel instanceof Float32Array ? channel : Float32Array.from(channel);
  }

  postProcessBlock(blockId, frames, channels) {
    const sharedResult = this.writeSharedInput(blockId, frames, channels);
    if (sharedResult === "sent") {
      this.recycleInputBlock(channels, frames);
      return;
    }
    if (sharedResult === "full") {
      this.droppedInputBlocks += 1;
      this.sharedInputDroppedBlocks += 1;
      this.recycleInputBlock(channels, frames);
      return;
    }
    const processMessage = {
      type: "process",
      blockId,
      frames,
      channels
    };
    const transfer = channels.map((channel) => channel.buffer);
    if (this.transportPort) {
      if (this.inFlightBlocks >= this.maxInFlightBlocks) {
        this.droppedInputBlocks += 1;
        this.recycleInputBlock(channels, frames);
      } else {
        this.inFlightBlocks += 1;
        this.transportPort.postMessage(processMessage, transfer);
      }
    } else {
      this.port.postMessage(processMessage, transfer);
    }
  }

  writeSharedInput(blockId, frames, channels) {
    const shared = this.sharedAudio;
    if (!shared || frames > shared.frames || channels.length > shared.channels) {
      return "unsupported";
    }
    const available = Atomics.load(shared.inputControl, SoundBridgeAudioProcessor.sharedAvailable);
    if (available >= shared.slots) {
      Atomics.add(shared.inputControl, SoundBridgeAudioProcessor.sharedDropped, 1);
      return "full";
    }
    const writeIndex = Atomics.load(shared.inputControl, SoundBridgeAudioProcessor.sharedWriteIndex) % shared.slots;
    this.writeSharedSlot(shared.inputControl, shared.inputAudio, writeIndex, blockId, frames, channels, shared);
    Atomics.store(shared.inputControl, SoundBridgeAudioProcessor.sharedWriteIndex, (writeIndex + 1) % shared.slots);
    Atomics.add(shared.inputControl, SoundBridgeAudioProcessor.sharedAvailable, 1);
    Atomics.notify(shared.inputControl, SoundBridgeAudioProcessor.sharedAvailable, 1);
    return "sent";
  }

  drainSharedOutput() {
    const shared = this.sharedAudio;
    if (!shared) {
      return;
    }
    while (Atomics.load(shared.outputControl, SoundBridgeAudioProcessor.sharedAvailable) > 0) {
      const readIndex = Atomics.load(shared.outputControl, SoundBridgeAudioProcessor.sharedReadIndex) % shared.slots;
      const metadataOffset = this.sharedSlotMetadataOffset(readIndex);
      const blockId = Atomics.load(shared.outputControl, metadataOffset + SoundBridgeAudioProcessor.sharedBlockIdOffset);
      const frames = Atomics.load(shared.outputControl, metadataOffset + SoundBridgeAudioProcessor.sharedBlockFramesOffset);
      const channels = Atomics.load(shared.outputControl, metadataOffset + SoundBridgeAudioProcessor.sharedBlockChannelsOffset);
      if (Number.isFinite(blockId) && blockId >= 0 && frames > 0 && frames <= shared.frames && channels > 0) {
        this.queueSharedOutputBlock(blockId, frames, Math.min(channels, this.outputChannels, shared.channels), readIndex, shared);
      } else {
        this.sharedOutputDroppedBlocks += 1;
      }
      Atomics.store(shared.outputControl, SoundBridgeAudioProcessor.sharedReadIndex, (readIndex + 1) % shared.slots);
      Atomics.sub(shared.outputControl, SoundBridgeAudioProcessor.sharedAvailable, 1);
    }
    this.sharedOutputDroppedBlocks += Atomics.exchange(shared.outputControl, SoundBridgeAudioProcessor.sharedDropped, 0);
  }

  queueSharedOutputBlock(blockId, frames, channels, slotIndex, shared) {
    this.recordResponseDeadline(blockId);
    if (blockId < this.blockId - this.outputLatencyBlocks) {
      this.staleOutputBlocks += 1;
      this.recordLateOutput();
      return;
    }
    if (this.outputBlocks.size >= this.maxQueuedOutputBlocks && !this.outputBlocks.has(blockId)) {
      this.dropOldestOutputBlock();
    }
    const outputChannels = [];
    const base = this.sharedAudioOffset(shared, slotIndex);
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      const channel = new Float32Array(frames);
      const sourceOffset = base + channelIndex * shared.frames;
      channel.set(shared.outputAudio.subarray(sourceOffset, sourceOffset + frames));
      outputChannels.push(channel);
    }
    this.outputBlocks.set(blockId, outputChannels);
  }

  writeSharedSlot(control, audio, slotIndex, blockId, frames, channels, shared) {
    const metadataOffset = this.sharedSlotMetadataOffset(slotIndex);
    Atomics.store(control, metadataOffset + SoundBridgeAudioProcessor.sharedBlockIdOffset, blockId);
    Atomics.store(control, metadataOffset + SoundBridgeAudioProcessor.sharedBlockFramesOffset, frames);
    Atomics.store(control, metadataOffset + SoundBridgeAudioProcessor.sharedBlockChannelsOffset, Math.min(channels.length, shared.channels));
    const base = this.sharedAudioOffset(shared, slotIndex);
    for (let channelIndex = 0; channelIndex < shared.channels; channelIndex += 1) {
      const offset = base + channelIndex * shared.frames;
      const source = channels[channelIndex] ?? channels[0];
      if (source) {
        audio.set(source.subarray(0, frames), offset);
        if (frames < shared.frames) {
          audio.fill(0, offset + frames, offset + shared.frames);
        }
      } else {
        audio.fill(0, offset, offset + shared.frames);
      }
    }
  }

  normalizeSharedAudio(value) {
    if (!value || typeof value !== "object" || typeof SharedArrayBuffer === "undefined") {
      return void 0;
    }
    const descriptor = value;
    const slots = this.boundedInteger(descriptor.slots, 0, 2, 64);
    const channels = this.boundedInteger(descriptor.channels, 0, 1, 32);
    const frames = this.boundedInteger(descriptor.frames, 0, 1, 8192);
    if (
      descriptor.version !== 1 ||
      !(descriptor.inputControl instanceof SharedArrayBuffer) ||
      !(descriptor.inputAudio instanceof SharedArrayBuffer) ||
      !(descriptor.outputControl instanceof SharedArrayBuffer) ||
      !(descriptor.outputAudio instanceof SharedArrayBuffer)
    ) {
      return void 0;
    }
    const controlInts = SoundBridgeAudioProcessor.sharedHeaderInts + slots * SoundBridgeAudioProcessor.sharedSlotInts;
    const audioSamples = slots * channels * frames;
    if (
      descriptor.inputControl.byteLength < controlInts * Int32Array.BYTES_PER_ELEMENT ||
      descriptor.outputControl.byteLength < controlInts * Int32Array.BYTES_PER_ELEMENT ||
      descriptor.inputAudio.byteLength < audioSamples * Float32Array.BYTES_PER_ELEMENT ||
      descriptor.outputAudio.byteLength < audioSamples * Float32Array.BYTES_PER_ELEMENT
    ) {
      return void 0;
    }
    return {
      slots,
      channels,
      frames,
      inputControl: new Int32Array(descriptor.inputControl),
      inputAudio: new Float32Array(descriptor.inputAudio),
      outputControl: new Int32Array(descriptor.outputControl),
      outputAudio: new Float32Array(descriptor.outputAudio)
    };
  }

  sharedSlotMetadataOffset(slotIndex) {
    return SoundBridgeAudioProcessor.sharedHeaderInts + slotIndex * SoundBridgeAudioProcessor.sharedSlotInts;
  }

  sharedAudioOffset(shared, slotIndex) {
    return slotIndex * shared.channels * shared.frames;
  }

  recordOutputTiming(onTime, targetBlockId) {
    if (!this.canAdaptLatency() || targetBlockId < 0) {
      return;
    }
    if (onTime) {
      this.consecutiveLatencyMisses = 0;
      this.consecutiveOnTimeBlocks += 1;
      if (
        this.outputLatencyBlocks > this.minOutputLatencyBlocks &&
        this.consecutiveOnTimeBlocks >= this.latencyRecoveryBlocks
      ) {
        this.outputLatencyBlocks -= 1;
        this.latencyDecreases += 1;
        this.consecutiveOnTimeBlocks = 0;
      }
      return;
    }
    this.consecutiveOnTimeBlocks = 0;
    this.consecutiveLatencyMisses += 1;
    if (
      this.outputLatencyBlocks < this.maxOutputLatencyBlocks &&
      this.consecutiveLatencyMisses >= this.latencyMissThresholdBlocks
    ) {
      this.outputLatencyBlocks += 1;
      this.latencyIncreases += 1;
      this.consecutiveLatencyMisses = 0;
    }
  }

  recordLateOutput() {
    if (!this.canAdaptLatency() || this.outputLatencyBlocks >= this.maxOutputLatencyBlocks) {
      return;
    }
    this.consecutiveOnTimeBlocks = 0;
    this.consecutiveLatencyMisses += 1;
    if (this.consecutiveLatencyMisses >= this.latencyMissThresholdBlocks) {
      this.outputLatencyBlocks += 1;
      this.latencyIncreases += 1;
      this.consecutiveLatencyMisses = 0;
    }
  }

  recordResponseDeadline(blockId) {
    const leadBlocks = blockId - (this.blockId - this.outputLatencyBlocks);
    this.responseBlocks += 1;
    this.responseBlocksSinceLastStats += 1;
    this.responseDeadlineLeadBlocks = leadBlocks;
    this.responseDeadlineLeadMinBlocks =
      this.responseDeadlineLeadMinBlocks === void 0 ? leadBlocks : Math.min(this.responseDeadlineLeadMinBlocks, leadBlocks);
    this.responseDeadlineLeadMaxBlocks =
      this.responseDeadlineLeadMaxBlocks === void 0 ? leadBlocks : Math.max(this.responseDeadlineLeadMaxBlocks, leadBlocks);
    if (leadBlocks < 0) {
      this.responseDeadlineMisses += 1;
      this.responseDeadlineMissesSinceLastStats += 1;
    }
  }

  resetResponseDeadlineWindow() {
    this.responseBlocksSinceLastStats = 0;
    this.responseDeadlineMissesSinceLastStats = 0;
    this.responseDeadlineLeadMinBlocks = void 0;
    this.responseDeadlineLeadMaxBlocks = void 0;
  }

  resetResponseDeadlineState() {
    this.responseBlocks = 0;
    this.responseDeadlineMisses = 0;
    this.responseDeadlineLeadBlocks = 0;
    this.resetResponseDeadlineWindow();
  }

  canAdaptLatency() {
    return this.adaptiveOutputLatency && Boolean(this.transportPort);
  }

  transportLatencySamples() {
    return this.outputLatencyBlocks * this.lastFrames;
  }

  takeInputBuffer(frames) {
    const pool = this.inputBufferPool.get(frames);
    const recycled = pool?.pop();
    if (recycled) {
      this.pooledInputBuffers = Math.max(0, this.pooledInputBuffers - 1);
      if (recycled.length === frames && recycled.buffer.byteLength >= frames * Float32Array.BYTES_PER_ELEMENT) {
        this.inputBufferReuses += 1;
        return recycled;
      }
    }
    this.inputBufferAllocations += 1;
    return new Float32Array(frames);
  }

  recycleInputBlock(channels, requestedFrames) {
    const frames = this.boundedInteger(requestedFrames, channels[0]?.length ?? 128, 1, 8192);
    const pool = this.inputBufferPool.get(frames) ?? [];
    const seenBuffers = new Set();
    for (const channel of channels) {
      if (
        this.pooledInputBuffers >= this.maxRecycledInputBuffers ||
        !(channel instanceof Float32Array) ||
        channel.length !== frames ||
        channel.byteOffset !== 0 ||
        !(channel.buffer instanceof ArrayBuffer) ||
        channel.byteLength !== channel.buffer.byteLength ||
        channel.buffer.byteLength < frames * Float32Array.BYTES_PER_ELEMENT ||
        seenBuffers.has(channel.buffer)
      ) {
        continue;
      }
      seenBuffers.add(channel.buffer);
      pool.push(channel);
      this.pooledInputBuffers += 1;
    }
    if (pool.length > 0) {
      this.inputBufferPool.set(frames, pool);
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
      return 0;
    }
    let dropped = 0;
    for (const blockId of Array.from(this.outputBlocks.keys())) {
      if (blockId < targetBlockId) {
        this.outputBlocks.delete(blockId);
        this.staleOutputBlocks += 1;
        dropped += 1;
      }
    }
    return dropped;
  }

  boundedInteger(value, fallback, min, max) {
    const integer = Math.floor(Number(value ?? fallback));
    return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
  }
}

SoundBridgeAudioProcessor.sharedHeaderInts = 8;
SoundBridgeAudioProcessor.sharedSlotInts = 4;
SoundBridgeAudioProcessor.sharedWriteIndex = 0;
SoundBridgeAudioProcessor.sharedReadIndex = 1;
SoundBridgeAudioProcessor.sharedAvailable = 2;
SoundBridgeAudioProcessor.sharedDropped = 3;
SoundBridgeAudioProcessor.sharedSlots = 4;
SoundBridgeAudioProcessor.sharedChannels = 5;
SoundBridgeAudioProcessor.sharedFrames = 6;
SoundBridgeAudioProcessor.sharedVersion = 7;
SoundBridgeAudioProcessor.sharedBlockIdOffset = 0;
SoundBridgeAudioProcessor.sharedBlockFramesOffset = 1;
SoundBridgeAudioProcessor.sharedBlockChannelsOffset = 2;

registerProcessor("soundbridge-audio-processor", SoundBridgeAudioProcessor);
