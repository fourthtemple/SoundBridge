class SoundBridgeAudioProcessor extends AudioWorkletProcessor {
  private static readonly sharedHeaderInts = 8;
  private static readonly sharedSlotInts = 4;
  private static readonly sharedWriteIndex = 0;
  private static readonly sharedReadIndex = 1;
  private static readonly sharedAvailable = 2;
  private static readonly sharedDropped = 3;
  private static readonly sharedSlots = 4;
  private static readonly sharedChannels = 5;
  private static readonly sharedFrames = 6;
  private static readonly sharedVersion = 7;
  private static readonly sharedBlockIdOffset = 0;
  private static readonly sharedBlockFramesOffset = 1;
  private static readonly sharedBlockChannelsOffset = 2;

  private readonly outputChannels: number;
  private readonly maxQueuedOutputBlocks: number;
  private outputLatencyBlocks: number;
  private readonly minOutputLatencyBlocks: number;
  private readonly maxOutputLatencyBlocks: number;
  private readonly adaptiveOutputLatency: boolean;
  private readonly latencyMissThresholdBlocks: number;
  private readonly latencyRecoveryBlocks: number;
  private readonly targetResponseDeadlineLeadBlocks: number;
  private readonly latencyPressureThresholdBlocks: number;
  private blockId = 0;
  private lastFrames = 128;
  private underruns = 0;
  private processedBlocks = 0;
  private staleOutputBlocks = 0;
  private droppedInputBlocks = 0;
  private latencyIncreases = 0;
  private latencyDecreases = 0;
  private sharedInputDroppedBlocks = 0;
  private sharedOutputDroppedBlocks = 0;
  private consecutiveLatencyMisses = 0;
  private consecutiveOnTimeBlocks = 0;
  private consecutiveLowDeadlineLeadBlocks = 0;
  private latencySafetyBlocks = 0;
  private latencySafetyInsertions = 0;
  private inputBufferAllocations = 0;
  private inputBufferReuses = 0;
  private pooledInputBuffers = 0;
  private outputBufferAllocations = 0;
  private outputBufferReuses = 0;
  private pooledOutputBuffers = 0;
  private inFlightBlocks = 0;
  private responseBlocks = 0;
  private responseBlocksSinceLastStats = 0;
  private responseDeadlineMisses = 0;
  private responseDeadlineMissesSinceLastStats = 0;
  private responseDeadlineLeadBlocks = 0;
  private responseDeadlineLeadMinBlocks?: number;
  private responseDeadlineLeadMaxBlocks?: number;
  private readonly outputBlocks = new Map<number, Float32Array[]>();
  private readonly inputBufferPool = new Map<number, Float32Array[]>();
  private readonly outputBufferPool = new Map<number, Float32Array[]>();
  private readonly maxInFlightBlocks: number;
  private readonly maxRecycledInputBuffers: number;
  private readonly maxRecycledOutputBuffers: number;
  private transportPort?: MessagePort;
  private sharedAudio?: NormalizedSharedAudio;
  private sharedAudioWakeMode: "none" | "pending" | "atomics" | "timer" = "none";

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const processorOptions = options.processorOptions ?? {};
    this.outputChannels = this.boundedInteger(processorOptions.outputChannels, 2, 1, 32);
    this.maxInFlightBlocks = this.boundedInteger(processorOptions.maxInFlightBlocks, 8, 1, 64);
    this.maxRecycledInputBuffers = this.outputChannels * Math.max(2, this.maxInFlightBlocks);
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
    this.targetResponseDeadlineLeadBlocks = this.boundedInteger(processorOptions.targetResponseDeadlineLeadBlocks, 1, 0, 16);
    this.latencyPressureThresholdBlocks = this.boundedInteger(processorOptions.latencyPressureThresholdBlocks, 4, 1, 64);
    this.maxRecycledOutputBuffers = this.outputChannels * Math.max(2, this.maxQueuedOutputBlocks + this.maxOutputLatencyBlocks);
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    const frames = output[0]?.length ?? input[0]?.length ?? 128;
    this.lastFrames = frames;
    this.drainSharedOutput();
    const outgoing = this.copyInputBlock(input, frames);
    const currentBlockId = this.blockId++;
    const insertingSafetyBlock = this.latencySafetyBlocks > 0;
    const targetBlockId = insertingSafetyBlock ? -1 : currentBlockId - this.outputLatencyBlocks;
    const queued = targetBlockId >= 0 ? this.outputBlocks.get(targetBlockId) : undefined;

    if (queued) {
      this.outputBlocks.delete(targetBlockId);
      this.writeBlock(output, queued, frames);
      this.recycleOutputBlock(queued, frames);
      this.processedBlocks += 1;
    } else if (insertingSafetyBlock) {
      this.writeBlock(output, outgoing, frames);
      this.latencySafetyBlocks -= 1;
      this.latencySafetyInsertions += 1;
    } else {
      this.writeBlock(output, outgoing, frames);
      this.underruns += 1;
    }
    if (!insertingSafetyBlock) {
      this.recordOutputTiming(Boolean(queued), targetBlockId);
      const staleDropped = this.dropStaleOutputBlocks(targetBlockId);
      if (staleDropped > 0) {
        this.recordLateOutput();
      }
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
        targetResponseDeadlineLeadBlocks: this.targetResponseDeadlineLeadBlocks,
        latencyPressureThresholdBlocks: this.latencyPressureThresholdBlocks,
        latencyMissThresholdBlocks: this.latencyMissThresholdBlocks,
        latencyRecoveryBlocks: this.latencyRecoveryBlocks,
        transportLatencySamples: this.transportLatencySamples(),
        latencyIncreases: this.latencyIncreases,
        latencyDecreases: this.latencyDecreases,
        consecutiveLowDeadlineLeadBlocks: this.consecutiveLowDeadlineLeadBlocks,
        latencySafetyBlocks: this.latencySafetyBlocks,
        latencySafetyInsertions: this.latencySafetyInsertions,
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
        outputBufferAllocations: this.outputBufferAllocations,
        outputBufferReuses: this.outputBufferReuses,
        pooledOutputBuffers: this.pooledOutputBuffers,
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

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") {
      return;
    }

    const typed = message as {
      type?: string;
      blockId?: number;
      frames?: number;
      channels?: ArrayLike<number>[];
      port?: MessagePort;
      sharedAudio?: unknown;
      wakeMode?: unknown;
      renderDurationMs?: number;
      renderBudgetMs?: number;
      renderBudgetExceeded?: boolean;
      renderEngine?: string;
      error?: unknown;
    };
    if (typed.type === "destroy") {
      this.outputBlocks.clear();
      this.inputBufferPool.clear();
      this.outputBufferPool.clear();
      this.resetResponseDeadlineState();
      this.pooledInputBuffers = 0;
      this.pooledOutputBuffers = 0;
      this.sharedAudio = undefined;
      this.sharedAudioWakeMode = "none";
      this.transportPort?.postMessage({ type: "destroy" });
      this.transportPort = undefined;
      return;
    }

    if (typed.type === "connect-transport" && typed.port) {
      this.transportPort = typed.port;
      this.transportPort.onmessage = (event) => this.handleMessage(event.data);
      this.sharedAudio = this.normalizeSharedAudio(typed.sharedAudio);
      this.sharedAudioWakeMode = this.sharedAudio ? "pending" : "none";
      return;
    }

    if (typed.type === "shared-audio-status") {
      if (typed.wakeMode === "atomics" || typed.wakeMode === "timer") {
        this.sharedAudioWakeMode = typed.wakeMode;
      }
      return;
    }

    if (typed.type === "dropped") {
      this.inFlightBlocks = Math.max(0, this.inFlightBlocks - 1);
      this.droppedInputBlocks += 1;
      return;
    }

    if (typed.type === "recycle-input" && Array.isArray(typed.channels)) {
      this.recycleInputBlock(typed.channels, typed.frames);
      return;
    }

    if (typed.type === "audio-error") {
      this.inFlightBlocks = Math.max(0, this.inFlightBlocks - 1);
      this.port.postMessage({ type: "audio-error", error: typed.error });
      return;
    }

    if (typed.type === "process-diagnostics" && typeof typed.renderEngine === "string") {
      this.port.postMessage({ type: "process-diagnostics", blockId: typed.blockId, renderEngine: typed.renderEngine, renderDurationMs: typed.renderDurationMs, renderBudgetMs: typed.renderBudgetMs, renderBudgetExceeded: typed.renderBudgetExceeded });
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

    this.recordResponseDeadline(blockId);
    if (blockId < this.blockId - this.outputLatencyBlocks) {
      this.staleOutputBlocks += 1;
      this.recordLateOutput();
      return;
    }

    if (this.outputBlocks.size >= this.maxQueuedOutputBlocks && !this.outputBlocks.has(blockId)) {
      this.dropOldestOutputBlock();
    }

    this.queueOutputBlock(blockId, typed.channels.slice(0, this.outputChannels).map((channel) => this.outputChannelBlock(channel)));
    if (typeof typed.renderEngine === "string") {
      this.port.postMessage({ type: "process-diagnostics", blockId, renderEngine: typed.renderEngine, renderDurationMs: typed.renderDurationMs, renderBudgetMs: typed.renderBudgetMs, renderBudgetExceeded: typed.renderBudgetExceeded });
    }
  }

  private copyInputBlock(input: Float32Array[], frames: number): Float32Array[] {
    const channels: Float32Array[] = [];
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

  private outputChannelBlock(channel: ArrayLike<number>): Float32Array {
    return channel instanceof Float32Array ? channel : Float32Array.from(channel);
  }

  private postProcessBlock(blockId: number, frames: number, channels: Float32Array[]): void {
    const sharedResult = this.writeSharedInput(blockId, frames, channels);
    if (sharedResult === "sent") {
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
    if (this.inFlightBlocks >= this.maxInFlightBlocks) {
      this.droppedInputBlocks += 1;
      this.recycleInputBlock(channels, frames);
      return;
    }
    this.inFlightBlocks += 1;
    (this.transportPort ?? this.port).postMessage(processMessage, transfer);
  }

  private writeSharedInput(blockId: number, frames: number, channels: Float32Array[]): "sent" | "unsupported" {
    const shared = this.sharedAudio;
    if (!shared || frames > shared.frames || channels.length > shared.channels) {
      return "unsupported";
    }
    const available = Atomics.load(shared.inputControl, SoundBridgeAudioProcessor.sharedAvailable);
    const inputFull = available >= shared.slots;
    if (inputFull) {
      Atomics.add(shared.inputControl, SoundBridgeAudioProcessor.sharedDropped, 1);
      this.droppedInputBlocks += 1;
      this.sharedInputDroppedBlocks += 1;
    }
    const writeIndex = inputFull
      ? Atomics.load(shared.inputControl, SoundBridgeAudioProcessor.sharedReadIndex) % shared.slots
      : Atomics.load(shared.inputControl, SoundBridgeAudioProcessor.sharedWriteIndex) % shared.slots;
    this.writeSharedSlot(shared.inputControl, shared.inputAudio, writeIndex, blockId, frames, channels, shared);
    Atomics.store(shared.inputControl, SoundBridgeAudioProcessor.sharedWriteIndex, (writeIndex + 1) % shared.slots);
    if (inputFull) {
      Atomics.store(shared.inputControl, SoundBridgeAudioProcessor.sharedReadIndex, (writeIndex + 1) % shared.slots);
    } else {
      Atomics.add(shared.inputControl, SoundBridgeAudioProcessor.sharedAvailable, 1);
    }
    Atomics.notify(shared.inputControl, SoundBridgeAudioProcessor.sharedAvailable, 1);
    return "sent";
  }

  private drainSharedOutput(): void {
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

  private queueSharedOutputBlock(
    blockId: number,
    frames: number,
    channels: number,
    slotIndex: number,
    shared: NormalizedSharedAudio
  ): void {
    this.recordResponseDeadline(blockId);
    if (blockId < this.blockId - this.outputLatencyBlocks) {
      this.staleOutputBlocks += 1;
      this.recordLateOutput();
      return;
    }
    if (this.outputBlocks.size >= this.maxQueuedOutputBlocks && !this.outputBlocks.has(blockId)) {
      this.dropOldestOutputBlock();
    }
    const outputChannels: Float32Array[] = [];
    const base = this.sharedAudioOffset(shared, slotIndex);
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      const channel = this.takeOutputBuffer(frames);
      const sourceOffset = base + channelIndex * shared.frames;
      channel.set(shared.outputAudio.subarray(sourceOffset, sourceOffset + frames));
      outputChannels.push(channel);
    }
    this.queueOutputBlock(blockId, outputChannels);
  }

  private queueOutputBlock(blockId: number, channels: Float32Array[]): void {
    const existing = this.outputBlocks.get(blockId);
    if (existing && existing !== channels) {
      this.recycleOutputBlock(existing, existing[0]?.length);
    }
    this.outputBlocks.set(blockId, channels);
  }

  private writeSharedSlot(
    control: Int32Array,
    audio: Float32Array,
    slotIndex: number,
    blockId: number,
    frames: number,
    channels: Float32Array[],
    shared: NormalizedSharedAudio
  ): void {
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

  private normalizeSharedAudio(value: unknown): NormalizedSharedAudio | undefined {
    if (!value || typeof value !== "object" || typeof SharedArrayBuffer === "undefined") {
      return undefined;
    }
    const descriptor = value as {
      version?: unknown;
      slots?: unknown;
      channels?: unknown;
      frames?: unknown;
      inputControl?: unknown;
      inputAudio?: unknown;
      outputControl?: unknown;
      outputAudio?: unknown;
    };
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
      return undefined;
    }
    const controlInts = SoundBridgeAudioProcessor.sharedHeaderInts + slots * SoundBridgeAudioProcessor.sharedSlotInts;
    const audioSamples = slots * channels * frames;
    if (
      descriptor.inputControl.byteLength < controlInts * Int32Array.BYTES_PER_ELEMENT ||
      descriptor.outputControl.byteLength < controlInts * Int32Array.BYTES_PER_ELEMENT ||
      descriptor.inputAudio.byteLength < audioSamples * Float32Array.BYTES_PER_ELEMENT ||
      descriptor.outputAudio.byteLength < audioSamples * Float32Array.BYTES_PER_ELEMENT
    ) {
      return undefined;
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

  private sharedSlotMetadataOffset(slotIndex: number): number {
    return SoundBridgeAudioProcessor.sharedHeaderInts + slotIndex * SoundBridgeAudioProcessor.sharedSlotInts;
  }

  private sharedAudioOffset(shared: NormalizedSharedAudio, slotIndex: number): number {
    return slotIndex * shared.channels * shared.frames;
  }

  private recordOutputTiming(onTime: boolean, targetBlockId: number): void {
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
        this.consecutiveLowDeadlineLeadBlocks = 0;
      }
      return;
    }
    this.consecutiveOnTimeBlocks = 0;
    this.consecutiveLatencyMisses += 1;
    if (this.consecutiveLatencyMisses >= this.latencyMissThresholdBlocks) {
      this.raiseOutputLatency(true);
    }
  }

  private recordLateOutput(): void {
    if (!this.canAdaptLatency() || this.outputLatencyBlocks >= this.maxOutputLatencyBlocks) {
      return;
    }
    this.consecutiveOnTimeBlocks = 0;
    this.consecutiveLatencyMisses += 1;
    if (this.consecutiveLatencyMisses >= this.latencyMissThresholdBlocks) {
      this.raiseOutputLatency(true);
    }
  }

  private recordResponseDeadline(blockId: number): void {
    const leadBlocks = blockId - (this.blockId - this.outputLatencyBlocks);
    this.responseBlocks += 1;
    this.responseBlocksSinceLastStats += 1;
    this.responseDeadlineLeadBlocks = leadBlocks;
    this.responseDeadlineLeadMinBlocks =
      this.responseDeadlineLeadMinBlocks === undefined ? leadBlocks : Math.min(this.responseDeadlineLeadMinBlocks, leadBlocks);
    this.responseDeadlineLeadMaxBlocks =
      this.responseDeadlineLeadMaxBlocks === undefined ? leadBlocks : Math.max(this.responseDeadlineLeadMaxBlocks, leadBlocks);
    if (leadBlocks < 0) {
      this.responseDeadlineMisses += 1;
      this.responseDeadlineMissesSinceLastStats += 1;
    }
    this.recordLatencyPressure(leadBlocks);
  }

  private recordLatencyPressure(leadBlocks: number): void {
    if (!this.canAdaptLatency()) {
      return;
    }
    if (leadBlocks >= this.targetResponseDeadlineLeadBlocks) {
      this.consecutiveLowDeadlineLeadBlocks = 0;
      return;
    }
    this.consecutiveOnTimeBlocks = 0;
    this.consecutiveLowDeadlineLeadBlocks += 1;
    if (this.consecutiveLowDeadlineLeadBlocks >= this.latencyPressureThresholdBlocks) {
      this.raiseOutputLatency(true);
    }
  }

  private raiseOutputLatency(insertSafetyBlock = false): void {
    if (this.outputLatencyBlocks >= this.maxOutputLatencyBlocks) {
      this.consecutiveLatencyMisses = 0;
      this.consecutiveLowDeadlineLeadBlocks = 0;
      return;
    }
    this.outputLatencyBlocks += 1;
    if (insertSafetyBlock) {
      this.latencySafetyBlocks += 1;
    }
    this.latencyIncreases += 1;
    this.consecutiveLatencyMisses = 0;
    this.consecutiveLowDeadlineLeadBlocks = 0;
    this.consecutiveOnTimeBlocks = 0;
  }

  private resetResponseDeadlineWindow(): void {
    this.responseBlocksSinceLastStats = 0;
    this.responseDeadlineMissesSinceLastStats = 0;
    this.responseDeadlineLeadMinBlocks = undefined;
    this.responseDeadlineLeadMaxBlocks = undefined;
  }

  private resetResponseDeadlineState(): void {
    this.responseBlocks = 0;
    this.responseDeadlineMisses = 0;
    this.responseDeadlineLeadBlocks = 0;
    this.consecutiveLowDeadlineLeadBlocks = 0;
    this.latencySafetyBlocks = 0;
    this.latencySafetyInsertions = 0;
    this.resetResponseDeadlineWindow();
  }

  private canAdaptLatency(): boolean {
    return this.adaptiveOutputLatency && Boolean(this.transportPort);
  }

  private transportLatencySamples(): number {
    return this.outputLatencyBlocks * this.lastFrames;
  }

  private takeInputBuffer(frames: number): Float32Array {
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

  private takeOutputBuffer(frames: number): Float32Array {
    const pool = this.outputBufferPool.get(frames);
    const recycled = pool?.pop();
    if (recycled) {
      this.pooledOutputBuffers = Math.max(0, this.pooledOutputBuffers - 1);
      if (recycled.length === frames && recycled.buffer.byteLength >= frames * Float32Array.BYTES_PER_ELEMENT) {
        this.outputBufferReuses += 1;
        return recycled;
      }
    }
    this.outputBufferAllocations += 1;
    return new Float32Array(frames);
  }

  private recycleInputBlock(channels: ArrayLike<number>[], requestedFrames: unknown): void {
    const frames = this.boundedInteger(requestedFrames, channels[0]?.length ?? 128, 1, 8192);
    const pool = this.inputBufferPool.get(frames) ?? [];
    const seenBuffers = new Set<ArrayBufferLike>();
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

  private recycleOutputBlock(channels: ArrayLike<number>[], requestedFrames: unknown): void {
    const frames = this.boundedInteger(requestedFrames, channels[0]?.length ?? 128, 1, 8192);
    const pool = this.outputBufferPool.get(frames) ?? [];
    const seenBuffers = new Set<ArrayBufferLike>();
    for (const channel of channels) {
      if (
        this.pooledOutputBuffers >= this.maxRecycledOutputBuffers ||
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
      this.pooledOutputBuffers += 1;
    }
    if (pool.length > 0) {
      this.outputBufferPool.set(frames, pool);
    }
  }

  private dropOldestOutputBlock(): void {
    let oldestBlockId = Number.POSITIVE_INFINITY;
    for (const blockId of this.outputBlocks.keys()) {
      oldestBlockId = Math.min(oldestBlockId, blockId);
    }
    if (Number.isFinite(oldestBlockId)) {
      const block = this.outputBlocks.get(oldestBlockId);
      this.outputBlocks.delete(oldestBlockId);
      if (block) {
        this.recycleOutputBlock(block, block[0]?.length);
      }
      this.staleOutputBlocks += 1;
    }
  }

  private dropStaleOutputBlocks(targetBlockId: number): number {
    if (targetBlockId < 0) {
      return 0;
    }
    let dropped = 0;
    for (const blockId of Array.from(this.outputBlocks.keys())) {
      if (blockId < targetBlockId) {
        const block = this.outputBlocks.get(blockId);
        this.outputBlocks.delete(blockId);
        if (block) {
          this.recycleOutputBlock(block, block[0]?.length);
        }
        this.staleOutputBlocks += 1;
        dropped += 1;
      }
    }
    return dropped;
  }

  private boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
    const integer = Math.floor(Number(value ?? fallback));
    return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
  }
}

interface NormalizedSharedAudio {
  slots: number;
  channels: number;
  frames: number;
  inputControl: Int32Array;
  inputAudio: Float32Array;
  outputControl: Int32Array;
  outputAudio: Float32Array;
}

registerProcessor("soundbridge-audio-processor", SoundBridgeAudioProcessor);
