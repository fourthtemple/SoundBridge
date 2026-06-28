import {
  __soundBridgeDecodeBinaryAudioEnvelope as decodeBinaryAudioEnvelope,
  __soundBridgeEncodeBinaryAudioEnvelope as encodeBinaryAudioEnvelope,
  liveTransportForBlock
} from "./soundbridge-client.js";

let socket;
let audioRequestSeq = 0;
const pendingRequests = /* @__PURE__ */ new Map();
const staleRequestIds = /* @__PURE__ */ new Set();
const pendingAudioPorts = /* @__PURE__ */ new Map();
const pendingSharedAudio = /* @__PURE__ */ new Map();
const sharedAudioPorts = /* @__PURE__ */ new Map();
const SHARED_AUDIO_HEADER_INTS = 8;
const SHARED_AUDIO_SLOT_INTS = 4;
const SHARED_WRITE_INDEX = 0;
const SHARED_READ_INDEX = 1;
const SHARED_AVAILABLE = 2;
const SHARED_DROPPED = 3;
const SHARED_BLOCK_ID_OFFSET = 0;
const SHARED_BLOCK_FRAMES_OFFSET = 1;
const SHARED_BLOCK_CHANNELS_OFFSET = 2;
const SHARED_BLOCK_TRANSPORT_LATENCY_OFFSET = 3;
const SHARED_AUDIO_WAIT_TIMEOUT_MS = 100;
const SHARED_AUDIO_TIMER_POLL_MS = 1;
const STALE_REQUEST_ID_LIMIT = 1024;

self.onmessage = (event) => {
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

function connect(url) {
  const previousSocket = socket;
  if (previousSocket) {
    socket = undefined;
    clearPendingRequests();
    rejectPendingAudioRequests("SoundBridge worker transport closed before reconnect.");
    post({ type: "closed" });
    previousSocket.close();
  }
  const activeSocket = new WebSocket(url);
  socket = activeSocket;
  activeSocket.binaryType = "arraybuffer";
  activeSocket.addEventListener("open", () => {
    if (!isCurrentSocket(activeSocket)) {
      return;
    }
    post({ type: "connected" });
    resumeSharedAudioPumps();
  });
  activeSocket.addEventListener("error", () => {
    if (!isCurrentSocket(activeSocket)) {
      return;
    }
    post({ type: "connect-error", message: `Unable to connect to ${url}` });
  });
  activeSocket.addEventListener("close", () => {
    if (!isCurrentSocket(activeSocket)) {
      return;
    }
    socket = undefined;
    clearPendingRequests();
    rejectPendingAudioRequests("SoundBridge worker transport closed before audio response.");
    post({ type: "closed" });
  });
  activeSocket.addEventListener("message", (event) => {
    if (!isCurrentSocket(activeSocket)) {
      return;
    }
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

function isCurrentSocket(candidate) {
  return socket === candidate;
}

function connectAudioPort(port, config, sharedAudioDescriptor) {
  const sharedAudio = normalizeSharedAudioPort(port, sharedAudioDescriptor);
  port.onmessage = (event) => {
    const message = event.data;
    if (message?.type === "destroy") {
      closeAudioPort(port, sharedAudio);
      return;
    }
    if (message?.type === "process") {
      sendAudioProcess(port, config, message);
    }
  };
  if (sharedAudio) {
    sharedAudio.wakeMode = sharedAudioWakeMode();
    sharedAudioPorts.set(sharedAudio, config);
    port.postMessage({ type: "shared-audio-status", wakeMode: sharedAudio.wakeMode, ...sharedAudioStatusFields(sharedAudio) });
    pumpSharedAudio(config, sharedAudio);
  }
}

function closeAudioPort(port, sharedAudio) {
  clearPendingAudioPortRequests(port);
  if (sharedAudio) {
    sharedAudio.closed = true;
    sharedAudioPorts.delete(sharedAudio);
    clearPendingSharedAudioRequests(sharedAudio);
    sharedAudio.inputBufferPool.clear();
    sharedAudio.pooledInputBuffers = 0;
    sharedAudio.inFlightBlocks = 0;
  }
  port.close();
}

function clearPendingAudioPortRequests(port) {
  for (const [id, pending] of pendingAudioPorts) {
    if (pending.port !== port) {
      continue;
    }
    clearAudioRequestTimeout(pending.timeout);
    pendingAudioPorts.delete(id);
    rememberStaleRequestId(id);
  }
}

function clearPendingSharedAudioRequests(shared) {
  for (const [id, pending] of pendingSharedAudio) {
    if (pending.shared !== shared) {
      continue;
    }
    clearAudioRequestTimeout(pending.timeout);
    pendingSharedAudio.delete(id);
    rememberStaleRequestId(id);
  }
}

function sendAudioProcess(port, config, message) {
  const channels = Array.isArray(message.channels) ? message.channels : [];
  const frames = boundedFrames(message.frames ?? channels[0]?.length ?? 128);
  const recyclableInput = recyclableInputChannels(channels, frames);
  const blockId = Math.floor(Number(message.blockId ?? 0));
  const transport = audioBlockTransport(config, blockId, frames, message.reportedLatencySamples ?? message.transportLatencySamples);
  const binary = config.audioTransport === "binary";
  const payload = {
    instanceId: config.instanceId,
    blockId,
    sampleRate: config.sampleRate,
    ...(binary ? {} : { channels: channels.map((channel) => Array.from(channel)) }),
    transport,
    timestamp: performance.now(),
    renderTimeoutMs: config.audioRequestTimeoutMs > 0 ? config.audioRequestTimeoutMs : void 0
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
        rememberStaleRequestId(envelope.id);
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

function recyclableInputChannels(channels, frames) {
  return channels.filter(
    (channel) =>
      channel instanceof Float32Array &&
      channel.length === frames &&
      channel.byteOffset === 0 &&
      channel.buffer instanceof ArrayBuffer &&
      channel.byteLength === channel.buffer.byteLength &&
      channel.buffer.byteLength >= frames * Float32Array.BYTES_PER_ELEMENT
  );
}

function recycleAudioInput(port, channels, frames) {
  if (channels.length === 0) {
    return;
  }
  const transfer = [];
  const recycled = [];
  for (const channel of channels) {
    const buffer = channel.buffer;
    if (transfer.includes(buffer)) {
      continue;
    }
    recycled.push(channel);
    transfer.push(buffer);
  }
  try {
    port.postMessage({ type: "recycle-input", frames, channels: recycled }, transfer);
  } catch {
  }
}

function routeAudioResponse(envelope) {
  const pendingShared = envelope.id ? pendingSharedAudio.get(envelope.id) : void 0;
  if (pendingShared) {
    const { shared, config } = pendingShared;
    clearAudioRequestTimeout(pendingShared.timeout);
    pendingSharedAudio.delete(envelope.id ?? "");
    shared.inFlightBlocks = Math.max(0, shared.inFlightBlocks - 1);
    const sharedStatus = sharedAudioStatusFields(shared);
    if (envelope.ok && envelope.payload && typeof envelope.payload === "object") {
      const payload = envelope.payload;
      writeSharedOutputBlock(shared, Math.floor(Number(payload.blockId ?? 0)), Array.isArray(payload.channels) ? payload.channels : []);
      if (typeof payload.renderEngine === "string" || typeof payload.latencySamples === "number") {
        shared.port.postMessage({ type: "process-diagnostics", blockId: payload.blockId, latencySamples: payload.latencySamples, renderEngine: payload.renderEngine, renderDurationMs: payload.renderDurationMs, renderBudgetMs: payload.renderBudgetMs, renderBudgetExceeded: payload.renderBudgetExceeded, ...sharedStatus });
      }
    } else {
      shared.port.postMessage({ type: "audio-error", blockId: pendingShared.blockId, error: envelope.error, ...sharedStatus });
    }
    pumpSharedAudio(config, shared);
    return true;
  }
  const pendingPort = envelope.id ? pendingAudioPorts.get(envelope.id) : void 0;
  if (!pendingPort) {
    return false;
  }
  clearAudioRequestTimeout(pendingPort.timeout);
  pendingAudioPorts.delete(envelope.id ?? "");
  if (envelope.ok && envelope.payload && typeof envelope.payload === "object") {
    const payload = envelope.payload;
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

function transferableChannelBuffers(channels) {
  const transfer = [];
  for (const channel of channels) {
    if (
      channel instanceof Float32Array &&
      channel.byteOffset === 0 &&
      channel.buffer instanceof ArrayBuffer &&
      channel.byteLength === channel.buffer.byteLength
    ) {
      const buffer = channel.buffer;
      if (!transfer.includes(buffer)) transfer.push(buffer);
    }
  }
  return transfer;
}

function pumpSharedAudio(config, shared) {
  if (shared.closed || !isSocketOpen()) {
    return;
  }
  drainSharedAudio(config, shared);
  scheduleSharedAudioPump(config, shared);
}

function scheduleSharedAudioPump(config, shared) {
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

function resumeSharedAudioPumps() {
  for (const [shared, config] of sharedAudioPorts) {
    pumpSharedAudio(config, shared);
  }
}

function isSocketOpen() {
  return socket?.readyState === WebSocket.OPEN;
}

function drainSharedAudio(config, shared) {
  while (!shared.closed && shared.inFlightBlocks < config.maxInFlightBlocks && Atomics.load(shared.inputControl, SHARED_AVAILABLE) > 0) {
    const readIndex = Atomics.load(shared.inputControl, SHARED_READ_INDEX) % shared.slots;
    const block = readSharedInputBlock(shared, readIndex);
    Atomics.store(shared.inputControl, SHARED_READ_INDEX, (readIndex + 1) % shared.slots);
    Atomics.sub(shared.inputControl, SHARED_AVAILABLE, 1);
    sendSharedAudioProcess(config, shared, block);
  }
}

function sendSharedAudioProcess(config, shared, block) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    recycleSharedInputBlock(shared, block.channels, block.frames);
    shared.port.postMessage({ type: "audio-error", blockId: block.blockId, error: "SoundBridge worker transport is not connected.", ...sharedAudioStatusFields(shared) });
    return;
  }
  const transport = audioBlockTransport(config, block.blockId, block.frames, block.transportLatencySamples);
  const binary = config.audioTransport === "binary";
  const payload = {
    instanceId: config.instanceId,
    blockId: block.blockId,
    sampleRate: config.sampleRate,
    ...(binary ? {} : { channels: block.channels.map((channel) => Array.from(channel)) }),
    transport,
    timestamp: performance.now(),
    renderTimeoutMs: config.audioRequestTimeoutMs > 0 ? config.audioRequestTimeoutMs : void 0
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
        rememberStaleRequestId(envelope.id);
        shared.inFlightBlocks = Math.max(0, shared.inFlightBlocks - 1);
        shared.port.postMessage({ type: "audio-error", blockId: block.blockId, error: audioTimeoutMessage(config.audioRequestTimeoutMs), ...sharedAudioStatusFields(shared) });
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
    shared.port.postMessage({ type: "audio-error", blockId: block.blockId, error: String(error instanceof Error ? error.message : error), ...sharedAudioStatusFields(shared) });
  }
}

function startAudioRequestTimeout(timeoutMs, onTimeout) {
  return timeoutMs > 0 ? setTimeout(onTimeout, timeoutMs) : void 0;
}

function clearAudioRequestTimeout(timeout) {
  if (timeout !== void 0) {
    clearTimeout(timeout);
  }
}

function audioTimeoutMessage(timeoutMs) {
  return `SoundBridge audio request timed out after ${timeoutMs} ms.`;
}

function rejectPendingAudioRequests(error) {
  for (const [id, pending] of pendingAudioPorts) {
    clearAudioRequestTimeout(pending.timeout);
    pending.port.postMessage({ type: "audio-error", blockId: pending.blockId, error });
    pendingAudioPorts.delete(id);
  }
  for (const [id, pending] of pendingSharedAudio) {
    clearAudioRequestTimeout(pending.timeout);
    pending.shared.inFlightBlocks = Math.max(0, pending.shared.inFlightBlocks - 1);
    pending.shared.port.postMessage({ type: "audio-error", blockId: pending.blockId, error, ...sharedAudioStatusFields(pending.shared) });
    pendingSharedAudio.delete(id);
  }
}

function readSharedInputBlock(shared, slotIndex) {
  const metadataOffset = sharedSlotMetadataOffset(slotIndex);
  const blockId = Atomics.load(shared.inputControl, metadataOffset + SHARED_BLOCK_ID_OFFSET);
  const frames = Math.min(shared.frames, boundedFrames(Atomics.load(shared.inputControl, metadataOffset + SHARED_BLOCK_FRAMES_OFFSET)));
  const channelCount = Math.max(1, Math.min(shared.channels, Atomics.load(shared.inputControl, metadataOffset + SHARED_BLOCK_CHANNELS_OFFSET)));
  const transportLatencySamples = Atomics.load(shared.inputControl, metadataOffset + SHARED_BLOCK_TRANSPORT_LATENCY_OFFSET);
  const channels = new Array(channelCount);
  const base = sharedAudioOffset(shared, slotIndex);
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const offset = base + channelIndex * shared.frames;
    const channel = takeSharedInputBuffer(shared, frames);
    channel.set(shared.inputAudio.subarray(offset, offset + frames));
    channels[channelIndex] = channel;
  }
  return { blockId, frames, channels, transportLatencySamples };
}

function audioBlockTransport(config, blockId, frames, reportedLatencySamples) {
  return liveTransportForBlock({
    sampleRate: config.sampleRate,
    maxBlockSize: frames,
    blockId,
    reportedLatencySamples,
    compensateOutputLatency: true
  });
}

function takeSharedInputBuffer(shared, frames) {
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

function recycleSharedInputBlock(shared, channels, frames) {
  const pool = shared.inputBufferPool.get(frames) ?? [];
  const startLength = pool.length;
  for (const channel of channels) {
    if (
      shared.pooledInputBuffers >= shared.maxRecycledInputBuffers ||
      channel.length !== frames ||
      channel.byteOffset !== 0 ||
      !(channel.buffer instanceof ArrayBuffer) ||
      channel.byteLength !== channel.buffer.byteLength ||
      poolHasBuffer(pool, channel.buffer, startLength)
    ) {
      continue;
    }
    pool.push(channel);
    shared.pooledInputBuffers += 1;
  }
  if (pool.length > 0) {
    shared.inputBufferPool.set(frames, pool);
  }
}

function poolHasBuffer(pool, buffer, start) {
  for (let index = start; index < pool.length; index += 1) if (pool[index]?.buffer === buffer) return true;
  return false;
}

function writeSharedOutputBlock(shared, blockId, channels) {
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
    if (source instanceof Float32Array) {
      for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
        const sample = source[frameIndex];
        shared.outputAudio[offset + frameIndex] = Number.isFinite(sample) ? sample : 0;
      }
    } else if (source) {
      for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
        const sample = Number(source[frameIndex] ?? 0);
        shared.outputAudio[offset + frameIndex] = Number.isFinite(sample) ? sample : 0;
      }
    } else {
      shared.outputAudio.fill(0, offset, offset + shared.frames);
      continue;
    }
    if (frames < shared.frames) shared.outputAudio.fill(0, offset + frames, offset + shared.frames);
  }
  Atomics.store(shared.outputControl, SHARED_WRITE_INDEX, (writeIndex + 1) % shared.slots);
  if (outputFull) {
    Atomics.store(shared.outputControl, SHARED_READ_INDEX, (writeIndex + 1) % shared.slots);
  } else {
    Atomics.add(shared.outputControl, SHARED_AVAILABLE, 1);
  }
  Atomics.notify(shared.outputControl, SHARED_AVAILABLE, 1);
}

function sharedAudioStatusFields(shared) {
  return {
    sharedTransportInFlightBlocks: boundedSharedInteger(shared.inFlightBlocks, 0, 0, 64),
    sharedInputBufferAllocations: boundedSharedInteger(shared.inputBufferAllocations, 0, 0, Number.MAX_SAFE_INTEGER),
    sharedInputBufferReuses: boundedSharedInteger(shared.inputBufferReuses, 0, 0, Number.MAX_SAFE_INTEGER),
    sharedPooledInputBuffers: boundedSharedInteger(shared.pooledInputBuffers, 0, 0, 2048)
  };
}

function normalizeSharedAudioPort(port, value) {
  if (!value || typeof value !== "object" || typeof SharedArrayBuffer === "undefined") {
    return void 0;
  }
  const descriptor = value;
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
    return void 0;
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

function sharedAudioWakeMode() {
  return typeof Atomics.waitAsync === "function" ? "atomics" : "timer";
}

function sharedSlotMetadataOffset(slotIndex) {
  return SHARED_AUDIO_HEADER_INTS + slotIndex * SHARED_AUDIO_SLOT_INTS;
}

function sharedAudioOffset(shared, slotIndex) {
  return slotIndex * shared.channels * shared.frames;
}

function boundedSharedInteger(value, fallback, min, max) {
  const integer = Math.floor(Number(value ?? fallback));
  return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
}

function boundedFrames(value) {
  const frames = Math.floor(Number(value));
  return Number.isFinite(frames) ? Math.max(1, Math.min(8192, frames)) : 128;
}

function sendRequest(envelope, binaryAudioChannels, timeoutMs) {
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
        rememberStaleRequestId(id);
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

function requestId(envelope) {
  return envelope && typeof envelope === "object" ? String(envelope.id ?? "") : undefined;
}

function rememberStaleRequestId(id) {
  staleRequestIds.add(id);
  while (staleRequestIds.size > STALE_REQUEST_ID_LIMIT) {
    const oldest = staleRequestIds.values().next().value;
    if (oldest === undefined) {
      return;
    }
    staleRequestIds.delete(oldest);
  }
}

function routeGenericResponse(envelope) {
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

function clearPendingRequests() {
  for (const timeout of pendingRequests.values()) {
    clearAudioRequestTimeout(timeout);
  }
  pendingRequests.clear();
  staleRequestIds.clear();
}

function requestTimeoutMessage(timeoutMs) {
  return `SoundBridge worker request timed out after ${timeoutMs} ms.`;
}

function post(message) {
  self.postMessage(message);
}
