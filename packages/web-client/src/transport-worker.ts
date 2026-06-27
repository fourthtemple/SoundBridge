import {
  __soundBridgeDecodeBinaryAudioEnvelope as decodeBinaryAudioEnvelope,
  __soundBridgeEncodeBinaryAudioEnvelope as encodeBinaryAudioEnvelope
} from "./client";

let socket: WebSocket | undefined;
let audioRequestSeq = 0;
const pendingRequests = new Map<string, ReturnType<typeof setTimeout> | undefined>();
const staleRequestIds = new Set<string>();
const pendingAudioPorts = new Map<string, PendingAudioPortRequest>();
const pendingSharedAudio = new Map<string, PendingSharedAudioRequest>();
const sharedAudioPorts = new Map<SharedAudioPort, AudioPortConfig>();
const SHARED_AUDIO_HEADER_INTS = 8;
const SHARED_AUDIO_SLOT_INTS = 4;
const SHARED_WRITE_INDEX = 0;
const SHARED_READ_INDEX = 1;
const SHARED_AVAILABLE = 2;
const SHARED_DROPPED = 3;
const SHARED_BLOCK_ID_OFFSET = 0;
const SHARED_BLOCK_FRAMES_OFFSET = 1;
const SHARED_BLOCK_CHANNELS_OFFSET = 2;
const SHARED_AUDIO_WAIT_TIMEOUT_MS = 100;
const SHARED_AUDIO_TIMER_POLL_MS = 1;

interface AudioPortConfig {
  instanceId: string;
  sampleRate: number;
  sessionToken: string;
  maxInFlightBlocks: number;
  audioRequestTimeoutMs: number;
  audioTransport: "binary" | "json";
}

interface PendingAudioPortRequest {
  port: MessagePort;
  blockId: number;
  timeout?: ReturnType<typeof setTimeout>;
}

interface PendingSharedAudioRequest {
  shared: SharedAudioPort;
  config: AudioPortConfig;
  blockId: number;
  timeout?: ReturnType<typeof setTimeout>;
}

interface SharedAudioPort {
  port: MessagePort;
  closed: boolean;
  wakeMode: "atomics" | "timer";
  inFlightBlocks: number;
  slots: number;
  channels: number;
  frames: number;
  pooledInputBuffers: number;
  inputBufferAllocations: number;
  inputBufferReuses: number;
  maxRecycledInputBuffers: number;
  inputBufferPool: Map<number, Float32Array[]>;
  inputControl: Int32Array;
  inputAudio: Float32Array;
  outputControl: Int32Array;
  outputAudio: Float32Array;
}

self.onmessage = (event: MessageEvent) => {
  const message = event.data;
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "connect") {
    connect(String(message.url ?? ""));
    return;
  }
  if (message.type === "request") {
    sendRequest(message.envelope, message.binaryAudioChannels, message.timeoutMs);
    return;
  }
  if (message.type === "audio-port" && message.port) {
    connectAudioPort(message.port, {
      instanceId: String(message.instanceId ?? ""),
      sampleRate: Number(message.sampleRate ?? 48000),
      sessionToken: String(message.sessionToken ?? ""),
      maxInFlightBlocks: boundedSharedInteger(message.maxInFlightBlocks, 8, 1, 64),
      audioRequestTimeoutMs: boundedSharedInteger(message.audioRequestTimeoutMs, 2000, 0, 60000),
      audioTransport: message.audioTransport === "json" ? "json" : "binary"
    }, message.sharedAudio);
    return;
  }
  if (message.type === "close") {
    socket?.close();
  }
};

function connect(url: string): void {
  socket?.close();
  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    post({ type: "connected" });
    resumeSharedAudioPumps();
  });
  socket.addEventListener("error", () => {
    post({ type: "connect-error", message: `Unable to connect to ${url}` });
  });
  socket.addEventListener("close", () => {
    clearPendingRequests();
    rejectPendingAudioRequests("SoundBridge worker transport closed before audio response.");
    post({ type: "closed" });
  });
  socket.addEventListener("message", (event) => {
    try {
      const envelope = typeof event.data === "string" ? JSON.parse(event.data) : decodeBinaryAudioEnvelope(event.data);
      if (routeAudioResponse(envelope)) {
        return;
      }
      if (routeGenericResponse(envelope)) {
        return;
      }
      post({ type: "message", envelope });
    } catch {
      post({ type: "protocol-error", message: "SoundBridge worker transport received an invalid message." });
    }
  });
}

function connectAudioPort(port: MessagePort, config: AudioPortConfig, sharedAudioDescriptor?: unknown): void {
  const sharedAudio = normalizeSharedAudioPort(port, sharedAudioDescriptor);
  port.onmessage = (event) => {
    const message = event.data;
    if (message?.type === "destroy") {
      if (sharedAudio) {
        sharedAudio.closed = true;
        sharedAudioPorts.delete(sharedAudio);
      }
      port.close();
      return;
    }
    if (message?.type === "process") {
      sendAudioProcess(port, config, message);
    }
  };
  if (sharedAudio) {
    sharedAudio.wakeMode = sharedAudioWakeMode();
    sharedAudioPorts.set(sharedAudio, config);
    port.postMessage({ type: "shared-audio-status", wakeMode: sharedAudio.wakeMode });
    pumpSharedAudio(config, sharedAudio);
  }
}

function sendAudioProcess(port: MessagePort, config: AudioPortConfig, message: { blockId?: number; frames?: number; channels?: ArrayLike<number>[] }): void {
  const channels = Array.isArray(message.channels) ? message.channels : [];
  const frames = boundedFrames(message.frames ?? channels[0]?.length ?? 128);
  const recyclableInput = recyclableInputChannels(channels, frames);
  const blockId = Math.floor(Number(message.blockId ?? 0));
  const samplePosition = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, blockId * frames));
  const binary = config.audioTransport === "binary";
  const payload = {
    instanceId: config.instanceId,
    blockId,
    sampleRate: config.sampleRate,
    ...(binary ? {} : { channels: channels.map((channel) => Array.from(channel)) }),
    transport: { playing: true, samplePosition },
    timestamp: performance.now(),
    renderTimeoutMs: config.audioRequestTimeoutMs > 0 ? config.audioRequestTimeoutMs : undefined
  };
  const envelope = {
    type: "request",
    id: `audio-${++audioRequestSeq}`,
    command: "processAudioBlock",
    sessionToken: config.sessionToken,
    payload
  };
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    recycleAudioInput(port, recyclableInput, frames);
    port.postMessage({ type: "audio-error", blockId, error: "SoundBridge worker transport is not connected." });
    return;
  }
  try {
    pendingAudioPorts.set(envelope.id, {
      port,
      blockId,
      timeout: startAudioRequestTimeout(config.audioRequestTimeoutMs, () => {
        pendingAudioPorts.delete(envelope.id);
        staleRequestIds.add(envelope.id);
        port.postMessage({ type: "audio-error", blockId, error: audioTimeoutMessage(config.audioRequestTimeoutMs) });
      })
    });
    socket.send(binary ? encodeBinaryAudioEnvelope(envelope, channels) : JSON.stringify(envelope));
    recycleAudioInput(port, recyclableInput, frames);
  } catch (error) {
    const pending = pendingAudioPorts.get(envelope.id);
    clearAudioRequestTimeout(pending?.timeout);
    pendingAudioPorts.delete(envelope.id);
    recycleAudioInput(port, recyclableInput, frames);
    port.postMessage({ type: "audio-error", blockId, error: String(error instanceof Error ? error.message : error) });
  }
}

function recyclableInputChannels(channels: ArrayLike<number>[], frames: number): Float32Array[] {
  return channels.filter(
    (channel): channel is Float32Array =>
      channel instanceof Float32Array &&
      channel.length === frames &&
      channel.byteOffset === 0 &&
      channel.buffer instanceof ArrayBuffer &&
      channel.byteLength === channel.buffer.byteLength &&
      channel.buffer.byteLength >= frames * Float32Array.BYTES_PER_ELEMENT
  );
}

function recycleAudioInput(port: MessagePort, channels: Float32Array[], frames: number): void {
  if (channels.length === 0) {
    return;
  }
  const transfer: ArrayBuffer[] = [];
  const recycled: Float32Array[] = [];
  const seenBuffers = new Set<ArrayBufferLike>();
  for (const channel of channels) {
    if (seenBuffers.has(channel.buffer)) {
      continue;
    }
    seenBuffers.add(channel.buffer);
    recycled.push(channel);
    transfer.push(channel.buffer as ArrayBuffer);
  }
  try {
    port.postMessage({ type: "recycle-input", frames, channels: recycled }, transfer);
  } catch {
    // Recycling is a realtime optimization; processing must continue if a host rejects transfer.
  }
}

function routeAudioResponse(envelope: { id?: string; ok?: boolean; payload?: unknown; error?: unknown }): boolean {
  const pendingShared = envelope.id ? pendingSharedAudio.get(envelope.id) : undefined;
  if (pendingShared) {
    const { shared, config } = pendingShared;
    clearAudioRequestTimeout(pendingShared.timeout);
    pendingSharedAudio.delete(envelope.id ?? "");
    shared.inFlightBlocks = Math.max(0, shared.inFlightBlocks - 1);
    if (envelope.ok && envelope.payload && typeof envelope.payload === "object") {
      const payload = envelope.payload as { blockId?: number; channels?: ArrayLike<number>[]; renderDurationMs?: number; renderBudgetMs?: number; renderBudgetExceeded?: boolean; renderEngine?: string };
      writeSharedOutputBlock(shared, Math.floor(Number(payload.blockId ?? 0)), Array.isArray(payload.channels) ? payload.channels : []);
      if (typeof payload.renderEngine === "string") {
        shared.port.postMessage({ type: "process-diagnostics", blockId: payload.blockId, renderEngine: payload.renderEngine, renderDurationMs: payload.renderDurationMs, renderBudgetMs: payload.renderBudgetMs, renderBudgetExceeded: payload.renderBudgetExceeded });
      }
    } else {
      shared.port.postMessage({ type: "audio-error", error: envelope.error });
    }
    pumpSharedAudio(config, shared);
    return true;
  }
  const pendingPort = envelope.id ? pendingAudioPorts.get(envelope.id) : undefined;
  if (!pendingPort) {
    return false;
  }
  clearAudioRequestTimeout(pendingPort.timeout);
  pendingAudioPorts.delete(envelope.id ?? "");
  if (envelope.ok && envelope.payload && typeof envelope.payload === "object") {
    const payload = envelope.payload as { blockId?: number; channels?: ArrayLike<number>[]; latencySamples?: number; renderDurationMs?: number; renderBudgetMs?: number; renderBudgetExceeded?: boolean; renderEngine?: string };
    const channels = Array.isArray(payload.channels) ? payload.channels : [];
    pendingPort.port.postMessage(
      {
        type: "processed",
        blockId: payload.blockId,
        channels,
        latencySamples: payload.latencySamples,
        renderDurationMs: payload.renderDurationMs,
        renderBudgetMs: payload.renderBudgetMs,
        renderBudgetExceeded: payload.renderBudgetExceeded,
        renderEngine: payload.renderEngine
      },
      transferableChannelBuffers(channels)
    );
  } else {
    pendingPort.port.postMessage({ type: "audio-error", blockId: pendingPort.blockId, error: envelope.error });
  }
  return true;
}

function transferableChannelBuffers(channels: ArrayLike<number>[]): ArrayBuffer[] {
  const transfer: ArrayBuffer[] = [];
  const seenBuffers = new Set<ArrayBufferLike>();
  for (const channel of channels) {
    if (
      channel instanceof Float32Array &&
      channel.byteOffset === 0 &&
      channel.buffer instanceof ArrayBuffer &&
      channel.byteLength === channel.buffer.byteLength &&
      !seenBuffers.has(channel.buffer)
    ) {
      seenBuffers.add(channel.buffer);
      transfer.push(channel.buffer as ArrayBuffer);
    }
  }
  return transfer;
}

function pumpSharedAudio(config: AudioPortConfig, shared: SharedAudioPort): void {
  if (shared.closed || !isSocketOpen()) {
    return;
  }
  drainSharedAudio(config, shared);
  scheduleSharedAudioPump(config, shared);
}

function scheduleSharedAudioPump(config: AudioPortConfig, shared: SharedAudioPort): void {
  if (shared.closed || !isSocketOpen()) {
    return;
  }
  if (shared.wakeMode === "atomics" && typeof Atomics.waitAsync === "function" && Atomics.load(shared.inputControl, SHARED_AVAILABLE) === 0) {
    const waitResult = Atomics.waitAsync(shared.inputControl, SHARED_AVAILABLE, 0, SHARED_AUDIO_WAIT_TIMEOUT_MS);
    if (waitResult.async) {
      waitResult.value.then(
        () => pumpSharedAudio(config, shared),
        () => pumpSharedAudio(config, shared)
      );
      return;
    }
  }
  const queued = Atomics.load(shared.inputControl, SHARED_AVAILABLE);
  setTimeout(() => pumpSharedAudio(config, shared), queued > 0 && shared.inFlightBlocks < config.maxInFlightBlocks ? 0 : SHARED_AUDIO_TIMER_POLL_MS);
}

function resumeSharedAudioPumps(): void {
  for (const [shared, config] of sharedAudioPorts) {
    pumpSharedAudio(config, shared);
  }
}

function isSocketOpen(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

function drainSharedAudio(config: AudioPortConfig, shared: SharedAudioPort): void {
  while (!shared.closed && shared.inFlightBlocks < config.maxInFlightBlocks && Atomics.load(shared.inputControl, SHARED_AVAILABLE) > 0) {
    const readIndex = Atomics.load(shared.inputControl, SHARED_READ_INDEX) % shared.slots;
    const block = readSharedInputBlock(shared, readIndex);
    Atomics.store(shared.inputControl, SHARED_READ_INDEX, (readIndex + 1) % shared.slots);
    Atomics.sub(shared.inputControl, SHARED_AVAILABLE, 1);
    sendSharedAudioProcess(config, shared, block);
  }
}

function sendSharedAudioProcess(
  config: AudioPortConfig,
  shared: SharedAudioPort,
  block: { blockId: number; frames: number; channels: Float32Array[] }
): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    recycleSharedInputBlock(shared, block.channels, block.frames);
    shared.port.postMessage({ type: "audio-error", blockId: block.blockId, error: "SoundBridge worker transport is not connected." });
    return;
  }
  const samplePosition = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, block.blockId * block.frames));
  const binary = config.audioTransport === "binary";
  const payload = {
    instanceId: config.instanceId,
    blockId: block.blockId,
    sampleRate: config.sampleRate,
    ...(binary ? {} : { channels: block.channels.map((channel) => Array.from(channel)) }),
    transport: { playing: true, samplePosition },
    timestamp: performance.now(),
    renderTimeoutMs: config.audioRequestTimeoutMs > 0 ? config.audioRequestTimeoutMs : undefined
  };
  const envelope = {
    type: "request",
    id: `audio-${++audioRequestSeq}`,
    command: "processAudioBlock",
    sessionToken: config.sessionToken,
    payload
  };
  try {
    shared.inFlightBlocks += 1;
    pendingSharedAudio.set(envelope.id, {
      shared,
      config,
      blockId: block.blockId,
      timeout: startAudioRequestTimeout(config.audioRequestTimeoutMs, () => {
        const pending = pendingSharedAudio.get(envelope.id);
        if (!pending) {
          return;
        }
        pendingSharedAudio.delete(envelope.id);
        staleRequestIds.add(envelope.id);
        shared.inFlightBlocks = Math.max(0, shared.inFlightBlocks - 1);
        shared.port.postMessage({ type: "audio-error", blockId: block.blockId, error: audioTimeoutMessage(config.audioRequestTimeoutMs) });
        pumpSharedAudio(config, shared);
      })
    });
    socket.send(binary ? encodeBinaryAudioEnvelope(envelope, block.channels) : JSON.stringify(envelope));
    recycleSharedInputBlock(shared, block.channels, block.frames);
  } catch (error) {
    const pending = pendingSharedAudio.get(envelope.id);
    clearAudioRequestTimeout(pending?.timeout);
    pendingSharedAudio.delete(envelope.id);
    shared.inFlightBlocks = Math.max(0, shared.inFlightBlocks - 1);
    recycleSharedInputBlock(shared, block.channels, block.frames);
    shared.port.postMessage({ type: "audio-error", blockId: block.blockId, error: String(error instanceof Error ? error.message : error) });
  }
}

function startAudioRequestTimeout(timeoutMs: number, onTimeout: () => void): ReturnType<typeof setTimeout> | undefined {
  return timeoutMs > 0 ? setTimeout(onTimeout, timeoutMs) : undefined;
}

function clearAudioRequestTimeout(timeout: ReturnType<typeof setTimeout> | undefined): void {
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
}

function audioTimeoutMessage(timeoutMs: number): string {
  return `SoundBridge audio request timed out after ${timeoutMs} ms.`;
}

function rejectPendingAudioRequests(error: string): void {
  for (const [id, pending] of pendingAudioPorts) {
    clearAudioRequestTimeout(pending.timeout);
    pending.port.postMessage({ type: "audio-error", blockId: pending.blockId, error });
    pendingAudioPorts.delete(id);
  }
  for (const [id, pending] of pendingSharedAudio) {
    clearAudioRequestTimeout(pending.timeout);
    pending.shared.inFlightBlocks = Math.max(0, pending.shared.inFlightBlocks - 1);
    pending.shared.port.postMessage({ type: "audio-error", blockId: pending.blockId, error });
    pendingSharedAudio.delete(id);
  }
}

function readSharedInputBlock(shared: SharedAudioPort, slotIndex: number): { blockId: number; frames: number; channels: Float32Array[] } {
  const metadataOffset = sharedSlotMetadataOffset(slotIndex);
  const blockId = Atomics.load(shared.inputControl, metadataOffset + SHARED_BLOCK_ID_OFFSET);
  const frames = Math.min(shared.frames, boundedFrames(Atomics.load(shared.inputControl, metadataOffset + SHARED_BLOCK_FRAMES_OFFSET)));
  const channelCount = Math.max(1, Math.min(shared.channels, Atomics.load(shared.inputControl, metadataOffset + SHARED_BLOCK_CHANNELS_OFFSET)));
  const channels: Float32Array[] = [];
  const base = sharedAudioOffset(shared, slotIndex);
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const offset = base + channelIndex * shared.frames;
    const channel = takeSharedInputBuffer(shared, frames);
    channel.set(shared.inputAudio.subarray(offset, offset + frames));
    channels.push(channel);
  }
  return { blockId, frames, channels };
}

function takeSharedInputBuffer(shared: SharedAudioPort, frames: number): Float32Array {
  const pool = shared.inputBufferPool.get(frames);
  const recycled = pool?.pop();
  if (recycled) {
    shared.pooledInputBuffers = Math.max(0, shared.pooledInputBuffers - 1);
    if (recycled.length === frames && recycled.buffer.byteLength >= frames * Float32Array.BYTES_PER_ELEMENT) {
      shared.inputBufferReuses += 1;
      return recycled;
    }
  }
  shared.inputBufferAllocations += 1;
  return new Float32Array(frames);
}

function recycleSharedInputBlock(shared: SharedAudioPort, channels: Float32Array[], frames: number): void {
  const pool = shared.inputBufferPool.get(frames) ?? [];
  const seenBuffers = new Set<ArrayBufferLike>();
  for (const channel of channels) {
    if (
      shared.pooledInputBuffers >= shared.maxRecycledInputBuffers ||
      channel.length !== frames ||
      channel.byteOffset !== 0 ||
      !(channel.buffer instanceof ArrayBuffer) ||
      channel.byteLength !== channel.buffer.byteLength ||
      seenBuffers.has(channel.buffer)
    ) {
      continue;
    }
    seenBuffers.add(channel.buffer);
    pool.push(channel);
    shared.pooledInputBuffers += 1;
  }
  if (pool.length > 0) {
    shared.inputBufferPool.set(frames, pool);
  }
}

function writeSharedOutputBlock(shared: SharedAudioPort, blockId: number, channels: ArrayLike<number>[]): void {
  const frames = Math.min(shared.frames, boundedFrames(channels[0]?.length ?? shared.frames));
  const channelCount = Math.min(shared.channels, channels.length);
  const available = Atomics.load(shared.outputControl, SHARED_AVAILABLE);
  const outputFull = available >= shared.slots;
  if (outputFull) {
    Atomics.add(shared.outputControl, SHARED_DROPPED, 1);
  }
  const writeIndex = outputFull
    ? Atomics.load(shared.outputControl, SHARED_READ_INDEX) % shared.slots
    : Atomics.load(shared.outputControl, SHARED_WRITE_INDEX) % shared.slots;
  const metadataOffset = sharedSlotMetadataOffset(writeIndex);
  Atomics.store(shared.outputControl, metadataOffset + SHARED_BLOCK_ID_OFFSET, blockId);
  Atomics.store(shared.outputControl, metadataOffset + SHARED_BLOCK_FRAMES_OFFSET, frames);
  Atomics.store(shared.outputControl, metadataOffset + SHARED_BLOCK_CHANNELS_OFFSET, channelCount);
  const base = sharedAudioOffset(shared, writeIndex);
  for (let channelIndex = 0; channelIndex < shared.channels; channelIndex += 1) {
    const offset = base + channelIndex * shared.frames;
    const source = channels[channelIndex] ?? channels[0];
    if (source) {
      for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
        const sample = Number(source[frameIndex] ?? 0);
        shared.outputAudio[offset + frameIndex] = Number.isFinite(sample) ? sample : 0;
      }
      if (frames < shared.frames) {
        shared.outputAudio.fill(0, offset + frames, offset + shared.frames);
      }
    } else {
      shared.outputAudio.fill(0, offset, offset + shared.frames);
    }
  }
  Atomics.store(shared.outputControl, SHARED_WRITE_INDEX, (writeIndex + 1) % shared.slots);
  if (outputFull) {
    Atomics.store(shared.outputControl, SHARED_READ_INDEX, (writeIndex + 1) % shared.slots);
  } else {
    Atomics.add(shared.outputControl, SHARED_AVAILABLE, 1);
  }
  Atomics.notify(shared.outputControl, SHARED_AVAILABLE, 1);
}

function normalizeSharedAudioPort(port: MessagePort, value: unknown): SharedAudioPort | undefined {
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
  const slots = boundedSharedInteger(descriptor.slots, 0, 2, 64);
  const channels = boundedSharedInteger(descriptor.channels, 0, 1, 32);
  const frames = boundedSharedInteger(descriptor.frames, 0, 1, 8192);
  if (
    descriptor.version !== 1 ||
    !(descriptor.inputControl instanceof SharedArrayBuffer) ||
    !(descriptor.inputAudio instanceof SharedArrayBuffer) ||
    !(descriptor.outputControl instanceof SharedArrayBuffer) ||
    !(descriptor.outputAudio instanceof SharedArrayBuffer)
  ) {
    return undefined;
  }
  return {
    port,
    closed: false,
    wakeMode: "timer",
    inFlightBlocks: 0,
    slots,
    channels,
    frames,
    pooledInputBuffers: 0,
    inputBufferAllocations: 0,
    inputBufferReuses: 0,
    maxRecycledInputBuffers: channels * Math.max(2, slots),
    inputBufferPool: new Map(),
    inputControl: new Int32Array(descriptor.inputControl),
    inputAudio: new Float32Array(descriptor.inputAudio),
    outputControl: new Int32Array(descriptor.outputControl),
    outputAudio: new Float32Array(descriptor.outputAudio)
  };
}

function sharedAudioWakeMode(): "atomics" | "timer" {
  return typeof Atomics.waitAsync === "function" ? "atomics" : "timer";
}

function sharedSlotMetadataOffset(slotIndex: number): number {
  return SHARED_AUDIO_HEADER_INTS + slotIndex * SHARED_AUDIO_SLOT_INTS;
}

function sharedAudioOffset(shared: SharedAudioPort, slotIndex: number): number {
  return slotIndex * shared.channels * shared.frames;
}

function boundedSharedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const integer = Math.floor(Number(value ?? fallback));
  return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
}

function boundedFrames(value: unknown): number {
  const frames = Math.floor(Number(value));
  return Number.isFinite(frames) ? Math.max(1, Math.min(8192, frames)) : 128;
}

function sendRequest(envelope: unknown, binaryAudioChannels?: ArrayLike<number>[], timeoutMs?: unknown): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    post({ type: "send-error", id: requestId(envelope), message: "SoundBridge worker transport is not connected." });
    return;
  }
  const id = requestId(envelope);
  const boundedTimeoutMs = boundedSharedInteger(timeoutMs, 0, 0, 60000);
  try {
    if (id) {
      pendingRequests.set(id, startAudioRequestTimeout(boundedTimeoutMs, () => {
        pendingRequests.delete(id);
        staleRequestIds.add(id);
        post({ type: "send-error", id, message: requestTimeoutMessage(boundedTimeoutMs) });
      }));
    }
    socket.send(binaryAudioChannels ? encodeBinaryAudioEnvelope(envelope, binaryAudioChannels) : JSON.stringify(envelope));
  } catch (error) {
    clearAudioRequestTimeout(id ? pendingRequests.get(id) : undefined);
    if (id) {
      pendingRequests.delete(id);
    }
    post({ type: "send-error", id, message: String(error instanceof Error ? error.message : error) });
  }
}

function requestId(envelope: unknown): string | undefined {
  return envelope && typeof envelope === "object" ? String((envelope as { id?: unknown }).id ?? "") : undefined;
}

function routeGenericResponse(envelope: { type?: string; id?: string }): boolean {
  if (envelope.type !== "response" || typeof envelope.id !== "string") {
    return false;
  }
  if (staleRequestIds.delete(envelope.id)) {
    return true;
  }
  if (!pendingRequests.has(envelope.id)) {
    return false;
  }
  clearAudioRequestTimeout(pendingRequests.get(envelope.id));
  pendingRequests.delete(envelope.id);
  post({ type: "message", envelope });
  return true;
}

function clearPendingRequests(): void {
  for (const timeout of pendingRequests.values()) {
    clearAudioRequestTimeout(timeout);
  }
  pendingRequests.clear();
  staleRequestIds.clear();
}

function requestTimeoutMessage(timeoutMs: number): string {
  return `SoundBridge worker request timed out after ${timeoutMs} ms.`;
}

function post(message: unknown): void {
  self.postMessage(message);
}
