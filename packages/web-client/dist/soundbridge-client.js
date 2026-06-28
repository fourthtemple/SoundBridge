export class SoundBridgeProtocolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "SoundBridgeProtocolError";
    this.code = code;
    this.details = details;
  }
}

export class SoundBridgeClient extends EventTarget {
  constructor(options = {}) {
    super();
    this.url = options.url ?? "ws://127.0.0.1:47370/bridge";
    this.origin = options.origin ?? globalThis.location?.origin ?? "unknown-origin";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.pairingToken = options.pairingToken;
    this.transport = options.transport === "worker" ? "worker" : "main";
    this.transportWorkerUrl = options.transportWorkerUrl ?? new URL("./soundbridge-transport-worker.js", import.meta.url);
    this.requestSeq = 0;
    this.sessionToken = undefined;
    this.pending = new Map();
    this.workerConnected = false;
    this.workerMessageHandler = (event) => {
      this.handleWorkerMessage(event.data);
    };
  }

  connect() {
    if (this.transport === "worker") {
      return this.connectWorker();
    }

    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    const previousSocket = this.socket;
    if (previousSocket) {
      this.socket = undefined;
      this.rejectPendingRequests("SoundBridge socket closed before reconnect");
      previousSocket.close();
    }
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      socket.addEventListener("open", () => this.socket === socket && resolve(), { once: true });
      socket.addEventListener("error", () => this.socket === socket && reject(new Error(`Unable to connect to ${this.url}`)), { once: true });
      socket.addEventListener("message", (event) => this.socket === socket && this.handleMessage(event.data));
      socket.addEventListener("close", () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.rejectPendingRequests("SoundBridge socket closed before response");
        this.dispatchEvent(new CustomEvent("disconnect"));
      });
    });
  }

  connectWorker() {
    if (this.worker && this.workerConnected) {
      return Promise.resolve();
    }
    if (typeof Worker === "undefined") {
      return Promise.reject(new Error("SoundBridge worker transport is not available in this environment."));
    }

    return new Promise((resolve, reject) => {
      if (!this.worker) {
        this.worker = new Worker(this.transportWorkerUrl, { type: "module" });
        this.worker.addEventListener("message", this.workerMessageHandler);
      }
      const worker = this.worker;
      const cleanup = () => {
        worker.removeEventListener("message", onConnectMessage);
        worker.removeEventListener("error", onConnectError);
      };
      const onConnectMessage = (event) => {
        const message = event.data;
        if (message?.type === "connected") {
          cleanup();
          this.workerConnected = true;
          resolve();
          return;
        }
        if (message?.type === "connect-error") {
          cleanup();
          reject(new Error(message.message ?? `Unable to connect to ${this.url}`));
        }
      };
      const onConnectError = () => {
        cleanup();
        reject(new Error(`Unable to start SoundBridge transport worker.`));
      };
      worker.addEventListener("message", onConnectMessage);
      worker.addEventListener("error", onConnectError);
      worker.postMessage({ type: "connect", url: this.url });
    });
  }

  hello() {
    return this.request("hello", {});
  }

  async pair(pairingToken) {
    const response = await this.request("pair", { origin: this.origin, pairingToken }, false);
    this.sessionToken = response.sessionToken;
    return response;
  }

  scanPlugins(request = {}) {
    return this.request("scanPlugins", request);
  }

  listPlugins(request = {}) {
    return this.request("listPlugins", request);
  }

  createInstance(request) {
    return this.request("createInstance", request);
  }

  destroyInstance(instanceId) {
    return this.request("destroyInstance", { instanceId });
  }

  getParameters(instanceId) {
    return this.request("getParameters", { instanceId });
  }

  setParameter(instanceId, parameterId, normalizedValue) {
    return this.request("setParameter", { instanceId, parameterId, normalizedValue });
  }

  setParameterDisplayValue(instanceId, parameterId, displayValue) {
    return this.request("setParameterDisplayValue", { instanceId, parameterId, displayValue });
  }

  setPreset(instanceId, presetId) {
    return this.request("setPreset", { instanceId, presetId });
  }

  getVst3ProgramData(instanceId, programListId, programIndex) {
    return this.request("getVst3ProgramData", { instanceId, programListId, programIndex });
  }

  setVst3ProgramData(instanceId, programData) {
    return this.request("setVst3ProgramData", { instanceId, programData });
  }

  setParameterEvents(instanceId, events) {
    return this.request("setParameterEvents", { instanceId, events });
  }

  setParameterCurve(instanceId, parameterId, points, interpolation = "linear") {
    return this.request("setParameterCurve", { instanceId, parameterId, points, interpolation });
  }

  setAutomationLane(instanceId, parameterId, points) {
    return this.request("setAutomationLane", { instanceId, parameterId, points });
  }

  clearAutomationLane(instanceId, parameterId) {
    return this.request("clearAutomationLane", { instanceId, parameterId });
  }

  getState(instanceId) {
    return this.request("getState", { instanceId });
  }

  setState(instanceId, state) {
    return this.request("setState", { instanceId, state });
  }

  processAudioBlock(request, timeoutMs = 2000) {
    return this.request("processAudioBlock", request, true, timeoutMs);
  }

  processAudioBlockBinary(request, timeoutMs = 2000) {
    const { channels, ...payload } = request;
    return this.request("processAudioBlock", payload, true, timeoutMs, channels);
  }

  createAudioWorkletTransportConnection(options) {
    if (this.transport !== "worker" || !this.worker || !this.workerConnected || !this.sessionToken) {
      return void 0;
    }
    const channel = new MessageChannel();
    const sharedAudio = createSharedAudioTransport(options);
    this.worker.postMessage(
      {
        type: "audio-port",
        port: channel.port2,
        instanceId: options.instanceId,
        sampleRate: options.sampleRate,
        sessionToken: this.sessionToken,
        maxInFlightBlocks: boundedAudioNodeInteger(options.maxInFlightBlocks, 8, 1, 64),
        audioRequestTimeoutMs: boundedAudioNodeInteger(options.audioRequestTimeoutMs, 2000, 0, 60000),
        audioTransport: options.audioTransport === "json" ? "json" : "binary",
        sharedAudio
      },
      [channel.port2]
    );
    return { port: channel.port1, sharedAudio };
  }

  createAudioWorkletTransportPort(options) { return this.createAudioWorkletTransportConnection(options)?.port; }

  sendMidiEvents(instanceId, events) {
    return this.request("sendMidiEvents", { instanceId, events });
  }

  getLatency(instanceId, transportLatencySamples = 0) {
    return this.request("getLatency", { instanceId, transportLatencySamples });
  }

  getTailTime(instanceId) {
    return this.request("getTailTime", { instanceId });
  }

  getLayout(instanceId) {
    return this.request("getLayout", { instanceId });
  }

  openEditor(instanceId, mode = "generic") {
    return this.request("openEditor", { instanceId, mode });
  }

  closeEditor(editorId) {
    return this.request("closeEditor", { editorId });
  }

  createFileGrant(request) {
    return this.request("createFileGrant", request);
  }

  listFileGrants() {
    return this.request("listFileGrants", {});
  }

  revokeFileGrant(grantId) {
    return this.request("revokeFileGrant", { grantId });
  }

  attachFileGrant(instanceId, grantId, constraints = {}) {
    return this.request("attachFileGrant", { instanceId, grantId, ...constraints });
  }

  listInstanceFileGrants(instanceId) {
    return this.request("listInstanceFileGrants", { instanceId });
  }

  detachFileGrant(instanceId, grantId) {
    return this.request("detachFileGrant", { instanceId, grantId });
  }

  useFileGrant(instanceId, grantId, options = {}) {
    return this.request("useFileGrant", { instanceId, grantId, ...options });
  }

  heartbeat() { return this.request("heartbeat", { now: Date.now() }); }

  request(command, payload, includeSession = true, timeoutMs = this.requestTimeoutMs, binaryAudioChannels) {
    if (this.transport === "main") {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("SoundBridge socket is not connected."));
      }
    } else if (!this.worker || !this.workerConnected) {
      return Promise.reject(new Error("SoundBridge worker transport is not connected."));
    }

    const id = `req-${++this.requestSeq}`;
    const envelope = {
      type: "request",
      id,
      command,
      payload: payload ?? {}
    };

    if (includeSession && this.sessionToken) {
      envelope.sessionToken = this.sessionToken;
    }

    return new Promise((resolve, reject) => {
      const timeout = timeoutMs > 0 ? globalThis.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SoundBridge request timed out: ${command}`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timeout });
      if (this.transport === "worker") {
        this.worker?.postMessage({ type: "request", envelope, binaryAudioChannels, timeoutMs });
      } else {
        this.socket?.send(
          binaryAudioChannels ? encodeBinaryAudioEnvelope(envelope, binaryAudioChannels) : JSON.stringify(envelope)
        );
      }
    });
  }

  handleMessage(data) {
    let envelope;
    try {
      envelope = typeof data === "string" ? JSON.parse(data) : decodeBinaryAudioEnvelope(data);
    } catch {
      return;
    }

    this.handleEnvelope(envelope);
  }

  handleWorkerMessage(message) {
    if (message?.type === "message" && message.envelope) {
      this.handleEnvelope(message.envelope);
      return;
    }
    if (message?.type === "send-error" && message.id) {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        pending.reject(new Error(message.message ?? "SoundBridge worker transport send failed."));
      }
      return;
    }
    if (message?.type === "closed") {
      this.workerConnected = false;
      this.rejectPendingRequests("SoundBridge worker transport closed before response");
      this.dispatchEvent(new CustomEvent("disconnect"));
    }
  }

  handleEnvelope(envelope) {
    if (envelope.type === "event") {
      this.dispatchEvent(new CustomEvent(envelope.event, { detail: envelope.payload }));
      return;
    }

    if (envelope.type !== "response") {
      return;
    }

    const pending = this.pending.get(envelope.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(envelope.id);

    if (envelope.ok) {
      pending.resolve(envelope.payload);
      return;
    }

    const error = envelope.error ?? { code: "unknown_error", message: "Unknown SoundBridge protocol error." };
    pending.reject(new SoundBridgeProtocolError(error.code, error.message, error.details));
  }

  rejectPendingRequests(message) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`${message} ${id}.`));
    }
    this.pending.clear();
  }
}

const BINARY_AUDIO_MAGIC = 0x53424131;
const BINARY_AUDIO_HEADER_BYTES = 8;
const FLOAT_BYTES = 4;
const LITTLE_ENDIAN_FLOATS = new Uint8Array(new Float32Array([1]).buffer)[0] === 0;
const BINARY_TEXT_ENCODER = new TextEncoder();
const BINARY_TEXT_DECODER = new TextDecoder();
const MAX_BINARY_CHANNELS = 32;
const MAX_BINARY_FRAMES = 8192;
const MAX_BINARY_BUSES = 32;
const EMPTY_BINARY_BUSES = [];
const EMPTY_READ_BINARY_BLOCKS = [];
const SHARED_AUDIO_VERSION = 1;
const SHARED_AUDIO_HEADER_INTS = 8;
const SHARED_AUDIO_SLOT_INTS = 4;

function encodeBinaryAudioEnvelope(envelope, channels) {
  const mainBlock = normalizeBinaryBlock(channels);
  const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  const inputBuses = normalizeBinaryBuses(payload.inputBuses);
  const outputBuses = normalizeBinaryBuses(payload.outputBuses);
  const header = {
    ...envelope,
    payload: {
      ...payload,
      channels: void 0,
      inputBuses: void 0,
      outputBuses: void 0
    },
    binaryAudio: {
      channels: mainBlock.channels.length,
      frames: mainBlock.frames,
      ...(inputBuses.length > 0 ? { inputBuses: busHeaders(inputBuses) } : {}),
      ...(outputBuses.length > 0 ? { outputBuses: busHeaders(outputBuses) } : {})
    }
  };
  delete header.payload.channels;
  delete header.payload.inputBuses;
  delete header.payload.outputBuses;
  const headerBytes = BINARY_TEXT_ENCODER.encode(JSON.stringify(header));
  let sampleBytes = binaryBlockBytes(mainBlock);
  if (inputBuses.length > 0) sampleBytes += binaryBlocksBytes(inputBuses);
  if (outputBuses.length > 0) sampleBytes += binaryBlocksBytes(outputBuses);
  const buffer = new ArrayBuffer(BINARY_AUDIO_HEADER_BYTES + headerBytes.length + sampleBytes);
  const view = new DataView(buffer);
  view.setUint32(0, BINARY_AUDIO_MAGIC, false);
  view.setUint32(4, headerBytes.length, false);
  new Uint8Array(buffer, BINARY_AUDIO_HEADER_BYTES, headerBytes.length).set(headerBytes);
  const target = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let offset = BINARY_AUDIO_HEADER_BYTES + headerBytes.length;
  offset = writeBinaryBlockSamples(view, target, offset, mainBlock);
  if (inputBuses.length > 0) offset = writeBinaryBlocks(view, target, offset, inputBuses);
  if (outputBuses.length > 0) writeBinaryBlocks(view, target, offset, outputBuses);
  return buffer;
}

function decodeBinaryAudioEnvelope(data) {
  const bytes = binaryBytes(data);
  if (!bytes || bytes.byteLength < BINARY_AUDIO_HEADER_BYTES) {
    throw new Error("invalid_binary_audio_frame");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== BINARY_AUDIO_MAGIC) {
    throw new Error("invalid_binary_audio_magic");
  }
  const headerLength = view.getUint32(4, false);
  const headerEnd = BINARY_AUDIO_HEADER_BYTES + headerLength;
  if (headerLength < 2 || headerEnd > bytes.byteLength) {
    throw new Error("invalid_binary_audio_header");
  }

  const headerBytes = bytes.subarray(BINARY_AUDIO_HEADER_BYTES, headerEnd);
  const envelope = JSON.parse(BINARY_TEXT_DECODER.decode(headerBytes));
  const channelCount = boundedBinaryInteger(envelope.binaryAudio?.channels, 0, MAX_BINARY_CHANNELS);
  const frames = boundedBinaryInteger(envelope.binaryAudio?.frames, 1, MAX_BINARY_FRAMES);
  let offset = headerEnd;
  const mainBlock = readBinaryBlock(view, offset, channelCount, frames);
  offset = mainBlock.offset;
  const inputBuses = readBinaryBuses(view, offset, envelope.binaryAudio?.inputBuses);
  offset = inputBuses.offset;
  const outputBuses = readBinaryBuses(view, offset, envelope.binaryAudio?.outputBuses);
  offset = outputBuses.offset;
  if (bytes.byteLength !== offset) {
    throw new Error("invalid_binary_audio_payload");
  }

  if (envelope.ok && envelope.payload && typeof envelope.payload === "object") {
    envelope.payload.channels = mainBlock.channels;
    if (inputBuses.blocks.length > 0) {
      envelope.payload.inputBuses = inputBuses.blocks;
    }
    if (outputBuses.blocks.length > 0) {
      envelope.payload.outputBuses = outputBuses.blocks;
    }
  }
  delete envelope.binaryAudio;
  return envelope;
}

function normalizeBinaryBlock(channels) {
  const channelCount = Math.min(channels.length, MAX_BINARY_CHANNELS);
  let frames = 1;
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const length = Math.max(0, Math.floor(Number(channels[channelIndex]?.length ?? 0)) || 0);
    frames = Math.max(frames, Math.min(MAX_BINARY_FRAMES, length));
  }
  const normalizedChannels = new Array(channelCount);
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channel = channels[channelIndex];
    let reusable = channel instanceof Float32Array && channel.length === frames;
    for (let index = 0; reusable && index < frames; index += 1) reusable = Number.isFinite(channel[index]);
    if (reusable) {
      normalizedChannels[channelIndex] = channel;
      continue;
    }
    const normalized = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) {
      const value = Number(channel[index] ?? 0);
      normalized[index] = Number.isFinite(value) ? value : 0;
    }
    normalizedChannels[channelIndex] = normalized;
  }
  return { channels: normalizedChannels, frames };
}

function normalizeBinaryBuses(buses) {
  if (!Array.isArray(buses) || buses.length === 0) {
    return EMPTY_BINARY_BUSES;
  }
  const seen = /* @__PURE__ */ new Set();
  const blocks = [];
  const busCount = Math.min(buses.length, MAX_BINARY_BUSES);
  for (let busPosition = 0; busPosition < busCount; busPosition += 1) {
    const bus = buses[busPosition];
    const index = boundedBinaryInteger(bus?.index, 0, MAX_BINARY_BUSES - 1);
    if (seen.has(index)) {
      throw new Error("binary_audio_duplicate_bus");
    }
    seen.add(index);
    blocks.push({ index, ...normalizeBinaryBlock(Array.isArray(bus?.channels) ? bus.channels : []) });
  }
  return blocks;
}

function busHeaders(buses) {
  return buses.map((bus) => ({ index: bus.index, channels: bus.channels.length, frames: bus.frames }));
}

function binaryBlockBytes(block) {
  return block.channels.length * block.frames * FLOAT_BYTES;
}

function binaryBlocksBytes(blocks) {
  let bytes = 0;
  for (const block of blocks) bytes += binaryBlockBytes(block);
  return bytes;
}

function writeBinaryBlocks(view, target, offset, blocks) {
  for (const block of blocks) offset = writeBinaryBlockSamples(view, target, offset, block);
  return offset;
}

function writeBinaryBlockSamples(view, target, offset, block) {
  for (const channel of block.channels) {
    if (LITTLE_ENDIAN_FLOATS) {
      target.set(new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength), offset);
      offset += channel.byteLength;
      continue;
    }
    for (const sample of channel) {
      view.setFloat32(offset, sample, true);
      offset += FLOAT_BYTES;
    }
  }
  return offset;
}

function readBinaryBlock(view, offset, channelCount, frames) {
  const byteLength = channelCount * frames * FLOAT_BYTES;
  if (offset + byteLength > view.byteLength) {
    throw new Error("invalid_binary_audio_payload");
  }
  return { channels: readBinaryChannels(view, offset, channelCount, frames), offset: offset + byteLength };
}

function readBinaryBuses(view, offset, specs) {
  if (specs === void 0) {
    return { blocks: EMPTY_READ_BINARY_BLOCKS, offset };
  }
  if (!Array.isArray(specs) || specs.length > MAX_BINARY_BUSES) {
    throw new Error("binary_audio_bus_out_of_range");
  }
  const seen = /* @__PURE__ */ new Set();
  const blocks = [];
  for (const spec of specs) {
    const index = boundedBinaryInteger(spec?.index, 0, MAX_BINARY_BUSES - 1);
    if (seen.has(index)) {
      throw new Error("binary_audio_duplicate_bus");
    }
    seen.add(index);
    const channelCount = boundedBinaryInteger(spec?.channels, 0, MAX_BINARY_CHANNELS);
    const frames = boundedBinaryInteger(spec?.frames, 1, MAX_BINARY_FRAMES);
    const block = readBinaryBlock(view, offset, channelCount, frames);
    offset = block.offset;
    blocks.push({ index, channels: block.channels });
  }
  return { blocks, offset };
}

function readBinaryChannels(view, offset, channelCount, frames) {
  const channels = [];
  const byteLength = frames * FLOAT_BYTES;
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channel = new Float32Array(frames);
    if (LITTLE_ENDIAN_FLOATS) {
      new Uint8Array(channel.buffer).set(new Uint8Array(view.buffer, view.byteOffset + offset, byteLength));
      offset += byteLength;
    } else {
      for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
        channel[frameIndex] = view.getFloat32(offset, true);
        offset += FLOAT_BYTES;
      }
    }
    channels.push(channel);
  }
  return channels;
}

function binaryBytes(data) {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return undefined;
}

function boundedBinaryInteger(value, min, max) {
  const integer = Math.floor(Number(value));
  if (!Number.isFinite(integer) || integer < min || integer > max) {
    throw new Error("binary_audio_integer_out_of_range");
  }
  return integer;
}

function createSharedAudioTransport(options) {
  const mode = options.audioTransferMode ?? "auto";
  if (mode === "message" || typeof SharedArrayBuffer === "undefined" || globalThis.crossOriginIsolated !== true) {
    return void 0;
  }
  const slots = boundedSharedInteger(options.sharedBufferBlocks, 8, 2, 64);
  const channels = boundedSharedInteger(options.channels, 2, 1, MAX_BINARY_CHANNELS);
  const frames = boundedSharedInteger(options.maxBlockFrames, 128, 1, MAX_BINARY_FRAMES);
  const controlBytes = Int32Array.BYTES_PER_ELEMENT * (SHARED_AUDIO_HEADER_INTS + slots * SHARED_AUDIO_SLOT_INTS);
  const audioBytes = Float32Array.BYTES_PER_ELEMENT * slots * channels * frames;
  return {
    version: SHARED_AUDIO_VERSION,
    slots,
    channels,
    frames,
    inputControl: initializedSharedControl(slots, channels, frames, controlBytes),
    inputAudio: new SharedArrayBuffer(audioBytes),
    outputControl: initializedSharedControl(slots, channels, frames, controlBytes),
    outputAudio: new SharedArrayBuffer(audioBytes)
  };
}

function initializedSharedControl(slots, channels, frames, bytes) {
  const buffer = new SharedArrayBuffer(bytes);
  const control = new Int32Array(buffer);
  control[4] = slots;
  control[5] = channels;
  control[6] = frames;
  control[7] = SHARED_AUDIO_VERSION;
  return buffer;
}

function boundedSharedInteger(value, fallback, min, max) {
  const integer = Math.floor(Number(value ?? fallback));
  return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
}

export {
  decodeBinaryAudioEnvelope as __soundBridgeDecodeBinaryAudioEnvelope,
  encodeBinaryAudioEnvelope as __soundBridgeEncodeBinaryAudioEnvelope
};

const LIVE_AUDIO_NODE_MAX_IN_FLIGHT_BLOCKS = 4;
const LIVE_AUDIO_NODE_MAX_QUEUED_OUTPUT_BLOCKS = 8;
const LIVE_AUDIO_NODE_OUTPUT_LATENCY_BLOCKS = 2;
const LIVE_AUDIO_NODE_MAX_OUTPUT_LATENCY_BLOCKS = 4;
const LIVE_AUDIO_NODE_LATENCY_RECOVERY_BLOCKS = 128;
const LIVE_AUDIO_NODE_LATENCY_PRESSURE_THRESHOLD_BLOCKS = 2;
const LIVE_AUDIO_NODE_RESPONSE_JITTER_THRESHOLD_BLOCKS = 2;
const LIVE_AUDIO_NODE_STATS_INTERVAL_BLOCKS = 32;
const LIVE_AUDIO_NODE_SHARED_BUFFER_BLOCKS = 4;
const LIVE_AUDIO_NODE_AUDIO_REQUEST_TIMEOUT_MS = 250;
const LIVE_AUDIO_NODE_CALIBRATION_SAMPLES = 256;
const LIVE_AUDIO_NODE_TRANSPORT_PRESSURE_AUTO_BYPASS_REASONS = ["deadline-miss", "dropped-input", "latency-safety", "shared-input-drop", "shared-output-drop", "stale-output", "underrun"];

export function createLivePerformanceAudioNodeOptions(options) {
  const maxQueuedOutputBlocks = boundedAudioNodeInteger(
    options.maxQueuedOutputBlocks,
    LIVE_AUDIO_NODE_MAX_QUEUED_OUTPUT_BLOCKS,
    1,
    64
  );
  const outputLatencyBlocks = boundedAudioNodeInteger(
    options.outputLatencyBlocks,
    Math.min(LIVE_AUDIO_NODE_OUTPUT_LATENCY_BLOCKS, maxQueuedOutputBlocks),
    1,
    maxQueuedOutputBlocks
  );
  const maxOutputLatencyBlocks = boundedAudioNodeInteger(
    options.maxOutputLatencyBlocks,
    Math.min(maxQueuedOutputBlocks, Math.max(outputLatencyBlocks + 2, LIVE_AUDIO_NODE_MAX_OUTPUT_LATENCY_BLOCKS)),
    outputLatencyBlocks,
    maxQueuedOutputBlocks
  );
  const maxInFlightBlocks = boundedAudioNodeInteger(options.maxInFlightBlocks, LIVE_AUDIO_NODE_MAX_IN_FLIGHT_BLOCKS, 1, 64);
  const sharedBufferFloor = Math.max(LIVE_AUDIO_NODE_SHARED_BUFFER_BLOCKS, maxQueuedOutputBlocks, maxInFlightBlocks + maxOutputLatencyBlocks);
  const sharedBufferBlocks = boundedAudioNodeInteger(
    options.sharedBufferBlocks,
    sharedBufferFloor,
    2,
    64
  );

  return {
    ...options,
    maxInFlightBlocks,
    maxQueuedOutputBlocks,
    outputLatencyBlocks,
    minOutputLatencyBlocks: boundedAudioNodeInteger(options.minOutputLatencyBlocks, 1, 1, outputLatencyBlocks),
    maxOutputLatencyBlocks,
    adaptiveOutputLatency: options.adaptiveOutputLatency !== false,
    latencyMissThresholdBlocks: boundedAudioNodeInteger(options.latencyMissThresholdBlocks, 2, 1, 32),
    latencyRecoveryBlocks: boundedAudioNodeInteger(options.latencyRecoveryBlocks, LIVE_AUDIO_NODE_LATENCY_RECOVERY_BLOCKS, 32, 8192),
    targetResponseDeadlineLeadBlocks: boundedAudioNodeInteger(options.targetResponseDeadlineLeadBlocks, 1, 0, 16),
    latencyPressureThresholdBlocks: boundedAudioNodeInteger(
      options.latencyPressureThresholdBlocks,
      LIVE_AUDIO_NODE_LATENCY_PRESSURE_THRESHOLD_BLOCKS,
      1,
      64
    ),
    responseJitterThresholdBlocks: boundedAudioNodeInteger(options.responseJitterThresholdBlocks, LIVE_AUDIO_NODE_RESPONSE_JITTER_THRESHOLD_BLOCKS, 0, 64),
    statsIntervalBlocks: boundedAudioNodeInteger(options.statsIntervalBlocks, LIVE_AUDIO_NODE_STATS_INTERVAL_BLOCKS, 8, 1024),
    audioTransport: options.audioTransport === "json" ? "json" : "binary",
    audioRequestTimeoutMs: boundedAudioNodeInteger(options.audioRequestTimeoutMs, LIVE_AUDIO_NODE_AUDIO_REQUEST_TIMEOUT_MS, 0, 60000),
    audioTransferMode: options.audioTransferMode ?? "auto",
    sharedBufferBlocks,
    maxBlockFrames: boundedAudioNodeInteger(options.maxBlockFrames, 128, 1, 8192),
    maxConsecutiveRenderBudgetMisses: boundedAudioNodeInteger(options.maxConsecutiveRenderBudgetMisses, 2, 0, 1024),
    maxConsecutiveAudioErrors: boundedAudioNodeInteger(options.maxConsecutiveAudioErrors, 1, 0, 1024),
    maxConsecutiveTransportPressureEvents: boundedAudioNodeInteger(options.maxConsecutiveTransportPressureEvents, 3, 0, 1024),
    transportPressureAutoBypassReasons: boundedAudioNodeTransportPressureReasons(options.transportPressureAutoBypassReasons ?? LIVE_AUDIO_NODE_TRANSPORT_PRESSURE_AUTO_BYPASS_REASONS),
    bypassed: options.bypassed === true
  };
}

export function createLivePerformanceAudioNodePolicy(options) {
  const normalized = createLivePerformanceAudioNodeOptions(options);
  const sampleRate = boundedAudioNodeInteger(options.sampleRate, 48000, 1, 384000);
  const maxBlockFrames = boundedAudioNodeInteger(normalized.maxBlockFrames, 128, 1, 8192);
  const blockDurationMs = audioNodeBlockDurationMs(sampleRate, maxBlockFrames);
  const pluginLatencySamples = boundedAudioNodeInteger(options.pluginLatencySamples, 0, 0, 1048576);
  const transportLatencySamples = boundedAudioNodeInteger(options.transportLatencySamples, normalized.outputLatencyBlocks * maxBlockFrames, 0, 1048576);
  const reportedLatencySamples = combinedAudioNodeLatencySamples(pluginLatencySamples, transportLatencySamples);
  return {
    options: normalized,
    sampleRate,
    maxBlockFrames,
    blockDurationMs: roundedAudioNodeNumber(blockDurationMs),
    outputLatencyBlocks: normalized.outputLatencyBlocks,
    outputLatencySamples: normalized.outputLatencyBlocks * maxBlockFrames,
    outputLatencyMs: audioNodeLatencyMilliseconds(normalized.outputLatencyBlocks * maxBlockFrames, sampleRate),
    minOutputLatencyBlocks: normalized.minOutputLatencyBlocks,
    maxOutputLatencyBlocks: normalized.maxOutputLatencyBlocks,
    maxOutputLatencySamples: normalized.maxOutputLatencyBlocks * maxBlockFrames,
    maxOutputLatencyMs: audioNodeLatencyMilliseconds(normalized.maxOutputLatencyBlocks * maxBlockFrames, sampleRate),
    maxInFlightBlocks: normalized.maxInFlightBlocks,
    maxQueuedOutputBlocks: normalized.maxQueuedOutputBlocks,
    sharedBufferBlocks: normalized.sharedBufferBlocks,
    audioRequestTimeoutMs: normalized.audioRequestTimeoutMs,
    audioRequestTimeoutBlocks: audioNodeBlockUnits(normalized.audioRequestTimeoutMs, blockDurationMs),
    latencyPressureThresholdBlocks: normalized.latencyPressureThresholdBlocks,
    responseJitterThresholdBlocks: normalized.responseJitterThresholdBlocks,
    latencyRecoveryBlocks: normalized.latencyRecoveryBlocks,
    statsIntervalBlocks: normalized.statsIntervalBlocks,
    pluginLatencySamples,
    transportLatencySamples,
    reportedLatencySamples,
    reportedLatencyMs: audioNodeLatencyMilliseconds(reportedLatencySamples, sampleRate)
  };
}

export function calibrateLivePerformanceAudioNodePolicy(options) {
  const policy = createLivePerformanceAudioNodePolicy(options);
  const safetyBlocks = boundedAudioNodeOptionalNumber(options.safetyMarginBlocks, 0, 8) ?? 1;
  const observedRenderP95Ms = audioNodePercentileSample(options.renderDurationsMs, 0, 60000);
  const observedResponseJitterP95Blocks = audioNodePercentileSample(options.responseJitterBlocks, 0, 64);
  const observedDeadlineLeadMinBlocks = audioNodeMinimumSample(options.deadlineLeadBlocks, -64, 64);
  const observedSharedQueueMaxBlocks = audioNodeSharedQueueMaxBlocks(options);
  const observedSharedTransportInFlightMaxBlocks = boundedAudioNodeInteger(options.sharedTransportInFlightBlocks, 0, 0, 64);
  const observedSharedInputBufferAllocations = boundedAudioNodeInteger(options.sharedInputBufferAllocations, 0, 0, Number.MAX_SAFE_INTEGER);
  const currentLatencyBlocks = audioNodeLatencyBlocks(policy.transportLatencySamples, policy.maxBlockFrames);
  const hasDropPressure = audioNodeDropPressure(options);
  const hasResponseDeadlineMisses = boundedAudioNodeInteger(options.responseDeadlineMisses, 0, 0, Number.MAX_SAFE_INTEGER) > 0;
  const pressureBlocks =
    Math.ceil((observedResponseJitterP95Blocks ?? 0) + Math.max(0, -(observedDeadlineLeadMinBlocks ?? 0)) + safetyBlocks) +
    (hasDropPressure ? 1 : 0) +
    (hasResponseDeadlineMisses ? 1 : 0);
  const recommendedOutputLatencyBlocks = boundedAudioNodeInteger(
    Math.max(currentLatencyBlocks, pressureBlocks),
    currentLatencyBlocks,
    policy.minOutputLatencyBlocks,
    policy.maxQueuedOutputBlocks
  );
  const maxOutputLatencyHeadroom = recommendedOutputLatencyBlocks > policy.maxOutputLatencyBlocks ? 2 : 0;
  const recommendedMaxOutputLatencyBlocks = boundedAudioNodeInteger(
    Math.max(policy.maxOutputLatencyBlocks, recommendedOutputLatencyBlocks + maxOutputLatencyHeadroom),
    policy.maxOutputLatencyBlocks,
    recommendedOutputLatencyBlocks,
    policy.maxQueuedOutputBlocks
  );
  const recommendedSharedBufferBlocks = boundedAudioNodeInteger(
    Math.max(
      policy.sharedBufferBlocks + (observedSharedInputBufferAllocations > 0 ? Math.max(1, safetyBlocks) : 0),
      policy.maxInFlightBlocks + recommendedMaxOutputLatencyBlocks,
      (observedSharedQueueMaxBlocks ?? 0) + safetyBlocks + 1
    ),
    policy.sharedBufferBlocks,
    2,
    64
  );
  const recommendedAudioRequestTimeoutMs = roundedAudioNodeNumber(
    boundedAudioNodeOptionalNumber(Math.max(policy.audioRequestTimeoutMs, (observedRenderP95Ms ?? 0) + policy.blockDurationMs * safetyBlocks), 0, 60000) ??
      policy.audioRequestTimeoutMs
  );
  const recommendedTransportLatencySamples = boundedAudioNodeInteger(
    recommendedOutputLatencyBlocks * policy.maxBlockFrames,
    policy.transportLatencySamples,
    0,
    1048576
  );
  const recommendedReportedLatencySamples = combinedAudioNodeLatencySamples(policy.pluginLatencySamples, recommendedTransportLatencySamples);
  const warnings = audioNodeCalibrationWarnings({
    policy,
    observedRenderP95Ms,
    observedResponseJitterP95Blocks,
    observedDeadlineLeadMinBlocks,
    observedSharedQueueMaxBlocks,
    observedSharedTransportInFlightMaxBlocks,
    observedSharedInputBufferAllocations,
    recommendedOutputLatencyBlocks,
    recommendedMaxOutputLatencyBlocks,
    recommendedSharedBufferBlocks,
    recommendedAudioRequestTimeoutMs,
    currentLatencyBlocks,
    hasDropPressure,
    hasResponseDeadlineMisses
  });
  return {
    policy,
    observedRenderP95Ms,
    observedResponseJitterP95Blocks,
    observedDeadlineLeadMinBlocks,
    observedSharedQueueMaxBlocks,
    observedSharedTransportInFlightMaxBlocks,
    observedSharedInputBufferAllocations,
    recommendedOutputLatencyBlocks,
    recommendedTransportLatencySamples,
    recommendedMaxOutputLatencyBlocks,
    recommendedSharedBufferBlocks,
    recommendedAudioRequestTimeoutMs,
    recommendedReportedLatencySamples,
    recommendedReportedLatencyMs: audioNodeLatencyMilliseconds(recommendedReportedLatencySamples, policy.sampleRate),
    realtimeReady: warnings.length === 0,
    warnings
  };
}

export class SoundBridgeAudioNode extends EventTarget {
  constructor(context, client, options) {
    super();
    this.client = client;
    this.instanceId = options.instanceId;
    this.sampleRate = context.sampleRate;
    this.maxInFlightBlocks = options.maxInFlightBlocks;
    this.minOutputLatencyBlocks = options.minOutputLatencyBlocks;
    this.maxOutputLatencyBlocks = options.maxOutputLatencyBlocks;
    this.sharedBufferBlocks = options.sharedBufferBlocks;
    this.maxBlockFrames = options.maxBlockFrames;
    this.audioTransport = options.audioTransport; this.audioRequestTimeoutMs = options.audioRequestTimeoutMs;
    this.inFlightBlocks = 0;
    this.destroyed = false;
    this.bypassed = options.bypassed;
    this.bypassEvents = 0;
    this.workletInFlightBlocks = undefined;
    this.queuedOutputBlocks = 0;
    this.outputLatencyBlocks = 0;
    this.transportLatencySamples = 0;
    this.pluginLatencySamples = 0;
    this.reportedLatencySamples = 0;
    this.latencyIncreases = 0;
    this.latencyDecreases = 0;
    this.latencyChangeEvents = 0;
    this.latencyRefreshes = 0;
    this.lastLatencyChangeDirection = undefined;
    this.responseDeadlineLeadSamples = 0;
    this.responseJitterBlocks = 0;
    this.responseJitterSamples = 0;
    this.responseDeadlineMisses = 0;
    this.responseDeadlineMissesSinceLastStats = 0;
    this.fallbackOutputBlocks = 0;
    this.lastFallbackReason = undefined;
    this.staleOutputBlocks = 0;
    this.droppedInputBlocks = 0;
    this.underruns = 0;
    this.sharedAudioEnabled = false;
    this.sharedInputQueuedBlocks = 0;
    this.sharedOutputQueuedBlocks = 0;
    this.sharedInputQueuedMaxBlocks = 0;
    this.sharedOutputQueuedMaxBlocks = 0;
    this.sharedInputDroppedBlocks = 0;
    this.sharedOutputDroppedBlocks = 0;
    this.sharedTransportStats = { inFlightBlocks: 0, inputBufferAllocations: 0, inputBufferReuses: 0, pooledInputBuffers: 0 };
    this.transportPressureEvents = 0;
    this.consecutiveTransportPressureEvents = 0;
    this.maxConsecutiveTransportPressureEvents = options.maxConsecutiveTransportPressureEvents;
    this.transportPressureAutoBypassed = false;
    this.transportPressureAutoBypassReasons = options.transportPressureAutoBypassReasons;
    this.lastTransportPressureReasons = [];
    this.lastRenderEngine = undefined;
    this.lastRenderDurationMs = undefined;
    this.lastRenderBudgetMs = undefined;
    this.renderBudgetExceeded = false;
    this.renderBudgetMisses = 0;
    this.maxConsecutiveRenderBudgetMisses = options.maxConsecutiveRenderBudgetMisses;
    this.renderBudgetAutoBypassed = false;
    this.audioErrors = 0;
    this.consecutiveAudioErrors = 0;
    this.maxConsecutiveAudioErrors = options.maxConsecutiveAudioErrors;
    this.audioErrorAutoBypassed = false;
    this.lastAudioError = undefined;
    this.unhealthyReason = undefined;
    this.responseJitterThresholdBlocks = options.responseJitterThresholdBlocks;
    this.node = new AudioWorkletNode(context, "soundbridge-audio-processor", {
      numberOfInputs: options.inputChannels > 0 ? 1 : 0,
      numberOfOutputs: 1,
      channelCount: Math.max(1, options.inputChannels),
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
        latencyMissThresholdBlocks: options.latencyMissThresholdBlocks,
        latencyRecoveryBlocks: options.latencyRecoveryBlocks,
        targetResponseDeadlineLeadBlocks: options.targetResponseDeadlineLeadBlocks,
        latencyPressureThresholdBlocks: options.latencyPressureThresholdBlocks,
        responseJitterThresholdBlocks: options.responseJitterThresholdBlocks,
        statsIntervalBlocks: options.statsIntervalBlocks,
        bypassed: options.bypassed
      }
    });
    this.node.port.onmessage = (event) => this.handleWorkletMessage(event.data);
    const transportConnection = client.createAudioWorkletTransportConnection({
      instanceId: options.instanceId,
      sampleRate: context.sampleRate,
      maxInFlightBlocks: options.maxInFlightBlocks,
      audioTransport: options.audioTransport,
      audioRequestTimeoutMs: options.audioRequestTimeoutMs,
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

  static async create(context, client, options) {
    const normalized = {
      instanceId: options.instanceId,
      inputChannels: Math.max(0, Math.min(32, Math.floor(options.inputChannels ?? 2))),
      outputChannels: Math.max(1, Math.min(32, Math.floor(options.outputChannels ?? 2))),
      maxInFlightBlocks: boundedAudioNodeInteger(options.maxInFlightBlocks, 8, 1, 64),
      maxQueuedOutputBlocks: boundedAudioNodeInteger(options.maxQueuedOutputBlocks, 16, 1, 64),
      outputLatencyBlocks: 1,
      minOutputLatencyBlocks: 1,
      maxOutputLatencyBlocks: 4,
      adaptiveOutputLatency: options.adaptiveOutputLatency !== false,
      latencyMissThresholdBlocks: boundedAudioNodeInteger(options.latencyMissThresholdBlocks, 2, 1, 32),
      latencyRecoveryBlocks: boundedAudioNodeInteger(options.latencyRecoveryBlocks, 512, 32, 8192),
      targetResponseDeadlineLeadBlocks: boundedAudioNodeInteger(options.targetResponseDeadlineLeadBlocks, 1, 0, 16),
      latencyPressureThresholdBlocks: boundedAudioNodeInteger(options.latencyPressureThresholdBlocks, 4, 1, 64),
      responseJitterThresholdBlocks: boundedAudioNodeInteger(options.responseJitterThresholdBlocks, 4, 0, 64),
      statsIntervalBlocks: boundedAudioNodeInteger(options.statsIntervalBlocks, 128, 8, 1024),
      audioTransport: options.audioTransport === "json" ? "json" : "binary",
      audioRequestTimeoutMs: boundedAudioNodeInteger(options.audioRequestTimeoutMs, 2000, 0, 60000),
      audioTransferMode: options.audioTransferMode ?? "auto",
      sharedBufferBlocks: boundedAudioNodeInteger(options.sharedBufferBlocks, 8, 2, 64),
      maxBlockFrames: boundedAudioNodeInteger(options.maxBlockFrames, 128, 1, 8192),
      maxConsecutiveRenderBudgetMisses: boundedAudioNodeInteger(options.maxConsecutiveRenderBudgetMisses, 0, 0, 1024),
      maxConsecutiveAudioErrors: boundedAudioNodeInteger(options.maxConsecutiveAudioErrors, 0, 0, 1024),
      maxConsecutiveTransportPressureEvents: boundedAudioNodeInteger(options.maxConsecutiveTransportPressureEvents, 0, 0, 1024),
      transportPressureAutoBypassReasons: boundedAudioNodeTransportPressureReasons(options.transportPressureAutoBypassReasons),
      bypassed: options.bypassed === true,
      workletUrl: options.workletUrl ?? "/packages/web-client/dist/soundbridge-worklet.js"
    };
    normalized.outputLatencyBlocks = boundedAudioNodeInteger(
      options.outputLatencyBlocks,
      Math.min(2, normalized.maxQueuedOutputBlocks),
      1,
      normalized.maxQueuedOutputBlocks
    );
    normalized.minOutputLatencyBlocks = boundedAudioNodeInteger(
      options.minOutputLatencyBlocks,
      1,
      1,
      normalized.outputLatencyBlocks
    );
    normalized.maxOutputLatencyBlocks = boundedAudioNodeInteger(
      options.maxOutputLatencyBlocks,
      Math.min(normalized.maxQueuedOutputBlocks, Math.max(normalized.outputLatencyBlocks + 2, 4)),
      normalized.outputLatencyBlocks,
      normalized.maxQueuedOutputBlocks
    );
    await context.audioWorklet.addModule(normalized.workletUrl);
    return new SoundBridgeAudioNode(context, client, normalized);
  }

  static createLivePerformance(context, client, options) {
    return SoundBridgeAudioNode.create(context, client, createLivePerformanceAudioNodeOptions(options));
  }

  connect(destination, output, input) {
    return this.node.connect(destination, output, input);
  }

  setBypassed(bypassed) {
    if (this.destroyed) {
      return;
    }
    if (!bypassed && this.unhealthyReason === "process-timeout") return;
    if (!bypassed) this.clearAutoBypassState();
    if (this.bypassed === bypassed) return;
    this.bypassed = bypassed;
    this.bypassEvents = Math.min(1024, this.bypassEvents + 1);
    this.node.port.postMessage({ type: "set-bypassed", bypassed });
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  retry() {
    if (this.destroyed || !this.clearAutoBypassState()) return false;
    if (this.bypassed) {
      this.bypassed = false;
      this.bypassEvents = Math.min(1024, this.bypassEvents + 1);
      this.node.port.postMessage({ type: "set-bypassed", bypassed: false });
    }
    this.dispatchEvent(new CustomEvent("retry", { detail: { health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return true;
  }

  async refreshLatency(transportLatencySamples = this.transportLatencySamples) {
    if (this.destroyed) return this.health;
    const previous = { pluginLatencySamples: this.pluginLatencySamples, transportLatencySamples: this.transportLatencySamples, reportedLatencySamples: this.reportedLatencySamples };
    const requestedTransportLatencySamples = boundedAudioNodeInteger(transportLatencySamples, this.transportLatencySamples, 0, 1048576);
    if (requestedTransportLatencySamples > 0) {
      const blockFrames = this.outputLatencyBlocks > 0 && this.transportLatencySamples > 0 ? Math.max(1, Math.round(this.transportLatencySamples / this.outputLatencyBlocks)) : this.maxBlockFrames;
      const outputLatencyBlocks = boundedAudioNodeInteger(Math.ceil(requestedTransportLatencySamples / blockFrames), this.outputLatencyBlocks || this.minOutputLatencyBlocks, this.minOutputLatencyBlocks, this.maxOutputLatencyBlocks);
      if (outputLatencyBlocks !== this.outputLatencyBlocks) { this.outputLatencyBlocks = outputLatencyBlocks; this.node.port.postMessage({ type: "set-output-latency", outputLatencyBlocks }); }
    }
    const latency = await this.client.getLatency(this.instanceId, requestedTransportLatencySamples);
    this.pluginLatencySamples = boundedAudioNodeInteger(latency.pluginLatencySamples, this.pluginLatencySamples, 0, 1048576);
    this.transportLatencySamples = boundedAudioNodeInteger(latency.transportLatencySamples, requestedTransportLatencySamples, 0, 1048576);
    this.reportedLatencySamples = boundedAudioNodeInteger(
      latency.reportedLatencySamples,
      combinedAudioNodeLatencySamples(this.pluginLatencySamples, this.transportLatencySamples),
      0,
      1048576
    );
    this.node.port.postMessage({ type: "set-plugin-latency", pluginLatencySamples: this.pluginLatencySamples });
    this.latencyRefreshes = Math.min(1024, this.latencyRefreshes + 1);
    if (
      this.pluginLatencySamples !== previous.pluginLatencySamples ||
      this.transportLatencySamples !== previous.transportLatencySamples ||
      this.reportedLatencySamples !== previous.reportedLatencySamples
    ) {
      this.latencyChangeEvents = Math.min(1024, this.latencyChangeEvents + 1);
      this.lastLatencyChangeDirection = "changed";
      this.dispatchEvent(new CustomEvent("latencychange", { detail: { direction: "changed", previous, latency, health: this.health } }));
    }
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return this.health;
  }

  disconnect() {
    this.node.disconnect();
  }

  get health() {
    return {
      healthy: !this.destroyed && this.unhealthyReason === undefined,
      instanceId: this.instanceId,
      bypassed: this.bypassed,
      bypassEvents: this.bypassEvents,
      audioTransport: this.audioTransport,
      audioRequestTimeoutMs: this.audioRequestTimeoutMs,
      inFlightBlocks: this.workletInFlightBlocks ?? this.inFlightBlocks,
      maxInFlightBlocks: this.maxInFlightBlocks,
      queuedOutputBlocks: this.queuedOutputBlocks,
      outputLatencyBlocks: this.outputLatencyBlocks,
      maxOutputLatencyBlocks: this.maxOutputLatencyBlocks,
      transportLatencySamples: this.transportLatencySamples,
      pluginLatencySamples: this.pluginLatencySamples,
      reportedLatencySamples: this.reportedLatencySamples,
      transportLatencyMs: audioNodeLatencyMilliseconds(this.transportLatencySamples, this.sampleRate),
      pluginLatencyMs: audioNodeLatencyMilliseconds(this.pluginLatencySamples, this.sampleRate),
      reportedLatencyMs: audioNodeLatencyMilliseconds(this.reportedLatencySamples, this.sampleRate),
      latencyIncreases: this.latencyIncreases,
      latencyDecreases: this.latencyDecreases,
      latencyChangeEvents: this.latencyChangeEvents,
      latencyRefreshes: this.latencyRefreshes,
      lastLatencyChangeDirection: this.lastLatencyChangeDirection,
      responseDeadlineLeadSamples: this.responseDeadlineLeadSamples,
      responseJitterBlocks: this.responseJitterBlocks,
      responseJitterSamples: this.responseJitterSamples,
      responseJitterThresholdBlocks: this.responseJitterThresholdBlocks,
      responseDeadlineMisses: this.responseDeadlineMisses,
      responseDeadlineMissesSinceLastStats: this.responseDeadlineMissesSinceLastStats,
      fallbackOutputBlocks: this.fallbackOutputBlocks,
      lastFallbackReason: this.lastFallbackReason,
      staleOutputBlocks: this.staleOutputBlocks,
      droppedInputBlocks: this.droppedInputBlocks,
      underruns: this.underruns,
      sharedAudioEnabled: this.sharedAudioEnabled,
      sharedBufferBlocks: this.sharedBufferBlocks,
      sharedInputQueuedBlocks: this.sharedInputQueuedBlocks,
      sharedInputQueuedMaxBlocks: this.sharedInputQueuedMaxBlocks,
      sharedOutputQueuedBlocks: this.sharedOutputQueuedBlocks,
      sharedOutputQueuedMaxBlocks: this.sharedOutputQueuedMaxBlocks,
      sharedInputDroppedBlocks: this.sharedInputDroppedBlocks,
      sharedOutputDroppedBlocks: this.sharedOutputDroppedBlocks,
      sharedTransportInFlightBlocks: this.sharedTransportStats.inFlightBlocks,
      sharedInputBufferAllocations: this.sharedTransportStats.inputBufferAllocations,
      sharedInputBufferReuses: this.sharedTransportStats.inputBufferReuses,
      sharedPooledInputBuffers: this.sharedTransportStats.pooledInputBuffers,
      transportPressureEvents: this.transportPressureEvents,
      consecutiveTransportPressureEvents: this.consecutiveTransportPressureEvents,
      maxConsecutiveTransportPressureEvents: this.maxConsecutiveTransportPressureEvents,
      transportPressureAutoBypassed: this.transportPressureAutoBypassed,
      transportPressureAutoBypassReasons: this.transportPressureAutoBypassReasons === undefined ? undefined : [...this.transportPressureAutoBypassReasons],
      lastTransportPressureReasons: [...this.lastTransportPressureReasons],
      lastRenderEngine: this.lastRenderEngine,
      lastRenderDurationMs: this.lastRenderDurationMs,
      lastRenderBudgetMs: this.lastRenderBudgetMs,
      renderBudgetExceeded: this.renderBudgetExceeded,
      renderBudgetMisses: this.renderBudgetMisses,
      maxConsecutiveRenderBudgetMisses: this.maxConsecutiveRenderBudgetMisses,
      renderBudgetAutoBypassed: this.renderBudgetAutoBypassed,
      audioErrors: this.audioErrors,
      consecutiveAudioErrors: this.consecutiveAudioErrors,
      maxConsecutiveAudioErrors: this.maxConsecutiveAudioErrors,
      audioErrorAutoBypassed: this.audioErrorAutoBypassed,
      lastAudioError: this.lastAudioError,
      unhealthyReason: this.unhealthyReason
    };
  }

  async destroy() {
    this.destroyed = true;
    this.unhealthyReason = "destroyed";
    this.node.port.postMessage({ type: "destroy" });
    await this.client.destroyInstance(this.instanceId);
  }

  handleWorkletMessage(message) {
    if (this.destroyed || !message || typeof message !== "object") {
      return;
    }

    if (message.type === "stats") {
      this.recordStats(message);
      this.dispatchEvent(new CustomEvent("stats", { detail: { ...message, sharedBufferBlocks: this.sharedBufferBlocks } }));
      return;
    }

    if (message.type === "process-diagnostics") {
      this.recordProcessDiagnostics(message);
      this.dispatchEvent(new CustomEvent("process-diagnostics", { detail: message }));
      return;
    }

    if (message.type === "audio-error") {
      if (message.sharedTransportInFlightBlocks !== void 0) this.recordStats(message);
      this.recordAudioError(message.error ?? message);
      this.dispatchEvent(new CustomEvent("audio-error", { detail: message.error ?? message }));
      return;
    }

    if (message.type !== "process" || typeof message.blockId !== "number" || !Array.isArray(message.channels)) {
      return;
    }

    if (this.inFlightBlocks >= this.maxInFlightBlocks) {
      this.node.port.postMessage({ type: "dropped", blockId: message.blockId });
      return;
    }

    this.inFlightBlocks += 1;
    const binaryChannels = message.channels;
    const requestedFrames = Math.floor(Number(message.frames ?? binaryChannels[0]?.length ?? 128));
    const frames = Number.isFinite(requestedFrames) ? Math.max(1, requestedFrames) : 128;
    const request = {
      instanceId: this.instanceId,
      blockId: message.blockId,
      sampleRate: this.sampleRate,
      channels: binaryChannels,
      transport: liveTransportForBlock({
        sampleRate: this.sampleRate,
        maxBlockSize: frames,
        blockId: message.blockId,
        reportedLatencySamples: message.reportedLatencySamples ?? combinedAudioNodeLatencySamples(this.pluginLatencySamples, boundedAudioNodeInteger(message.transportLatencySamples, this.transportLatencySamples, 0, 1048576)),
        compensateOutputLatency: true
      }),
      timestamp: performance.now(),
      renderTimeoutMs: this.audioRequestTimeoutMs > 0 ? this.audioRequestTimeoutMs : void 0
    };
    const processed =
      this.audioTransport === "binary"
        ? this.client.processAudioBlockBinary(request, this.audioRequestTimeoutMs)
        : this.client.processAudioBlock(
            { ...request, channels: binaryChannels.map((channel) => Array.from(channel)) },
            this.audioRequestTimeoutMs
          );

    processed
      .then((response) => {
        if (this.destroyed) {
          return;
        }
        this.clearAudioError();
        if (typeof response.renderEngine === "string" || typeof response.latencySamples === "number") {
          const diagnostics = {
            blockId: response.blockId,
            latencySamples: response.latencySamples,
            renderEngine: response.renderEngine,
            renderDurationMs: response.renderDurationMs,
            renderBudgetMs: response.renderBudgetMs,
            renderBudgetExceeded: response.renderBudgetExceeded
          };
          this.recordProcessDiagnostics(diagnostics);
          this.dispatchEvent(
            new CustomEvent("process-diagnostics", {
              detail: diagnostics
            })
          );
        }
        this.node.port.postMessage({
          type: "processed",
          blockId: response.blockId,
          channels: response.channels,
          latencySamples: response.latencySamples,
          renderDurationMs: response.renderDurationMs,
          renderBudgetMs: response.renderBudgetMs,
          renderBudgetExceeded: response.renderBudgetExceeded
        });
      })
      .catch((error) => {
        if (this.destroyed) {
          return;
        }
        this.recordAudioError(error);
        this.dispatchEvent(new CustomEvent("audio-error", { detail: error }));
        this.node.port.postMessage({ type: "audio-error", blockId: message.blockId, error: String(error instanceof Error ? error.message : error) });
      })
      .finally(() => {
        this.inFlightBlocks -= 1;
      });
  }

  recordStats(stats) {
    const previous = {
      outputLatencyBlocks: this.outputLatencyBlocks,
      transportLatencySamples: this.transportLatencySamples,
      latencyIncreases: this.latencyIncreases,
      latencyDecreases: this.latencyDecreases,
      responseDeadlineMisses: this.responseDeadlineMisses,
      fallbackOutputBlocks: this.fallbackOutputBlocks,
      staleOutputBlocks: this.staleOutputBlocks,
      droppedInputBlocks: this.droppedInputBlocks,
      underruns: this.underruns,
      sharedInputDroppedBlocks: this.sharedInputDroppedBlocks,
      sharedOutputDroppedBlocks: this.sharedOutputDroppedBlocks
    };

    this.workletInFlightBlocks = boundedAudioNodeInteger(stats.inFlightBlocks, this.workletInFlightBlocks ?? 0, 0, 64);
    this.queuedOutputBlocks = boundedAudioNodeInteger(stats.queuedOutputBlocks, this.queuedOutputBlocks, 0, 64);
    this.outputLatencyBlocks = boundedAudioNodeInteger(stats.outputLatencyBlocks, this.outputLatencyBlocks, 0, 64);
    this.transportLatencySamples = boundedAudioNodeInteger(stats.transportLatencySamples, this.transportLatencySamples, 0, 1048576);
    this.reportedLatencySamples = combinedAudioNodeLatencySamples(this.pluginLatencySamples, this.transportLatencySamples);
    this.latencyIncreases = boundedAudioNodeInteger(stats.latencyIncreases, this.latencyIncreases, 0, Number.MAX_SAFE_INTEGER);
    this.latencyDecreases = boundedAudioNodeInteger(stats.latencyDecreases, this.latencyDecreases, 0, Number.MAX_SAFE_INTEGER);
    this.responseDeadlineLeadSamples =
      boundedAudioNodeOptionalNumber(stats.responseDeadlineLeadSamples, -1048576, 1048576) ?? this.responseDeadlineLeadSamples;
    this.responseJitterBlocks = boundedAudioNodeInteger(stats.responseJitterBlocks, this.responseJitterBlocks, 0, 64);
    this.responseJitterSamples = boundedAudioNodeInteger(stats.responseJitterSamples, this.responseJitterSamples, 0, 1048576);
    this.responseDeadlineMisses = boundedAudioNodeInteger(
      stats.responseDeadlineMisses,
      this.responseDeadlineMisses,
      0,
      Number.MAX_SAFE_INTEGER
    );
    this.responseDeadlineMissesSinceLastStats = boundedAudioNodeInteger(
      stats.responseDeadlineMissesSinceLastStats,
      this.responseDeadlineMissesSinceLastStats,
      0,
      Number.MAX_SAFE_INTEGER
    );
    this.fallbackOutputBlocks = boundedAudioNodeInteger(stats.fallbackOutputBlocks, this.fallbackOutputBlocks, 0, Number.MAX_SAFE_INTEGER);
    this.lastFallbackReason = audioNodeFallbackReason(stats.lastFallbackReason);
    this.staleOutputBlocks = boundedAudioNodeInteger(stats.staleOutputBlocks, this.staleOutputBlocks, 0, Number.MAX_SAFE_INTEGER);
    this.droppedInputBlocks = boundedAudioNodeInteger(stats.droppedInputBlocks, this.droppedInputBlocks, 0, Number.MAX_SAFE_INTEGER);
    this.underruns = boundedAudioNodeInteger(stats.underruns, this.underruns, 0, Number.MAX_SAFE_INTEGER);
    this.sharedInputQueuedBlocks = boundedAudioNodeInteger(stats.sharedInputQueuedBlocks, this.sharedInputQueuedBlocks, 0, 64);
    this.sharedInputQueuedMaxBlocks = boundedAudioNodeInteger(stats.sharedInputQueuedMaxBlocks, this.sharedInputQueuedMaxBlocks, 0, 64);
    this.sharedOutputQueuedBlocks = boundedAudioNodeInteger(stats.sharedOutputQueuedBlocks, this.sharedOutputQueuedBlocks, 0, 64);
    this.sharedOutputQueuedMaxBlocks = boundedAudioNodeInteger(stats.sharedOutputQueuedMaxBlocks, this.sharedOutputQueuedMaxBlocks, 0, 64);
    this.sharedInputDroppedBlocks = boundedAudioNodeInteger(
      stats.sharedInputDroppedBlocks,
      this.sharedInputDroppedBlocks,
      0,
      Number.MAX_SAFE_INTEGER
    );
    this.sharedOutputDroppedBlocks = boundedAudioNodeInteger(
      stats.sharedOutputDroppedBlocks,
      this.sharedOutputDroppedBlocks,
      0,
      Number.MAX_SAFE_INTEGER
    );
    this.sharedTransportStats = {
      inFlightBlocks: boundedAudioNodeInteger(stats.sharedTransportInFlightBlocks, this.sharedTransportStats.inFlightBlocks, 0, 64),
      inputBufferAllocations: boundedAudioNodeInteger(stats.sharedInputBufferAllocations, this.sharedTransportStats.inputBufferAllocations, 0, Number.MAX_SAFE_INTEGER),
      inputBufferReuses: boundedAudioNodeInteger(stats.sharedInputBufferReuses, this.sharedTransportStats.inputBufferReuses, 0, Number.MAX_SAFE_INTEGER),
      pooledInputBuffers: boundedAudioNodeInteger(stats.sharedPooledInputBuffers, this.sharedTransportStats.pooledInputBuffers, 0, 2048)
    };
    if (typeof stats.sharedAudioEnabled === "boolean") {
      this.sharedAudioEnabled = stats.sharedAudioEnabled;
    }
    this.reportFallbackOutput(previous, stats);
    this.reportLatencyChange(previous, stats);
    this.reportTransportPressure(previous, stats);
  }

  reportFallbackOutput(previous, stats) {
    const deltaBlocks = Math.max(0, this.fallbackOutputBlocks - previous.fallbackOutputBlocks);
    if (deltaBlocks <= 0) return;
    this.dispatchEvent(new CustomEvent("fallback-output", { detail: { deltaBlocks, reason: this.lastFallbackReason, stats, health: this.health } }));
  }

  reportLatencyChange(previous, stats) {
    const changed =
      this.outputLatencyBlocks !== previous.outputLatencyBlocks ||
      this.transportLatencySamples !== previous.transportLatencySamples ||
      this.latencyIncreases > previous.latencyIncreases ||
      this.latencyDecreases > previous.latencyDecreases;
    if (!changed) {
      return;
    }
    const direction =
      this.latencyIncreases > previous.latencyIncreases
        ? "increased"
        : this.latencyDecreases > previous.latencyDecreases
          ? "decreased"
          : "changed";
    this.latencyChangeEvents = Math.min(1024, this.latencyChangeEvents + 1);
    this.lastLatencyChangeDirection = direction;
    this.dispatchEvent(new CustomEvent("latencychange", { detail: { direction, previous, stats, health: this.health } }));
  }

  reportTransportPressure(previous, stats) {
    const reasons = [];
    const deadlineMisses = Math.max(0, this.responseDeadlineMisses - previous.responseDeadlineMisses);
    if (this.responseDeadlineMisses > previous.responseDeadlineMisses) reasons.push("deadline-miss");
    if (this.latencyIncreases > previous.latencyIncreases && this.responseJitterThresholdBlocks > 0 && boundedAudioNodeOptionalNumber(stats.responseJitterBlocks, 0, 64) !== undefined && this.responseJitterBlocks >= this.responseJitterThresholdBlocks) reasons.push("response-jitter");
    if (this.fallbackOutputBlocks > previous.fallbackOutputBlocks && this.lastFallbackReason === "latency-safety") reasons.push("latency-safety");
    if (this.staleOutputBlocks > previous.staleOutputBlocks) reasons.push("stale-output");
    if (this.droppedInputBlocks > previous.droppedInputBlocks) reasons.push("dropped-input");
    if (this.underruns > previous.underruns) reasons.push("underrun");
    if (this.sharedInputDroppedBlocks > previous.sharedInputDroppedBlocks) reasons.push("shared-input-drop");
    if (this.sharedOutputDroppedBlocks > previous.sharedOutputDroppedBlocks) reasons.push("shared-output-drop");
    if (boundedAudioNodeOptionalNumber(stats.sharedTransportInFlightBlocks, 0, 64) !== void 0 && this.sharedTransportStats.inFlightBlocks >= this.maxInFlightBlocks) reasons.push("shared-transport-saturation");
    if (reasons.length === 0) {
      if (!this.transportPressureAutoBypassed) this.consecutiveTransportPressureEvents = 0;
      return;
    }
    const autoBypassPressure = shouldAutoBypassAudioNodeTransportPressure(reasons, this.transportPressureAutoBypassReasons);
    this.transportPressureEvents = Math.min(1024, this.transportPressureEvents + 1);
    if (autoBypassPressure) this.consecutiveTransportPressureEvents = Math.min(1024, this.consecutiveTransportPressureEvents + 1);
    else if (!this.transportPressureAutoBypassed) this.consecutiveTransportPressureEvents = 0;
    this.lastTransportPressureReasons = reasons;
    if (deadlineMisses > 0) this.dispatchEvent(new CustomEvent("response-deadline-missed", { detail: { deltaMisses: deadlineMisses, stats, health: this.health } }));
    this.dispatchEvent(new CustomEvent("transport-pressure", { detail: { reasons, stats, health: this.health } }));
    if (autoBypassPressure && this.maxConsecutiveTransportPressureEvents > 0 && this.consecutiveTransportPressureEvents >= this.maxConsecutiveTransportPressureEvents && !this.bypassed && !this.transportPressureAutoBypassed) {
      this.transportPressureAutoBypassed = true;
      this.unhealthyReason = "transport-pressure";
      this.setBypassed(true);
      this.dispatchEvent(new CustomEvent("transport-pressure-auto-bypassed", { detail: { reasons, stats, health: this.health } }));
    }
  }

  recordProcessDiagnostics(diagnostics) {
    const exceeded = diagnostics.renderBudgetExceeded === true;
    if (this.audioErrorAutoBypassed || (this.renderBudgetAutoBypassed && !exceeded)) return;
    this.clearAudioError();
    this.recordRenderLatency(diagnostics.latencySamples, diagnostics);
    if (typeof diagnostics.renderEngine === "string") {
      this.lastRenderEngine = diagnostics.renderEngine;
    }
    this.lastRenderDurationMs = boundedAudioNodeOptionalNumber(diagnostics.renderDurationMs, 0, 60000);
    this.lastRenderBudgetMs = boundedAudioNodeOptionalNumber(diagnostics.renderBudgetMs, 0, 60000);
    this.renderBudgetExceeded = exceeded;
    this.renderBudgetMisses = this.renderBudgetExceeded ? Math.min(1024, this.renderBudgetMisses + 1) : 0;
    if (this.renderBudgetExceeded) {
      this.dispatchEvent(new CustomEvent("render-budget-exceeded", { detail: { diagnostics, health: this.health } }));
      if (this.maxConsecutiveRenderBudgetMisses > 0 && this.renderBudgetMisses >= this.maxConsecutiveRenderBudgetMisses && !this.bypassed && !this.renderBudgetAutoBypassed) {
        this.renderBudgetAutoBypassed = true;
        this.unhealthyReason = "render-budget-exceeded";
        this.setBypassed(true);
        this.dispatchEvent(new CustomEvent("render-budget-tripped", { detail: { diagnostics, health: this.health } }));
        this.dispatchEvent(new CustomEvent("render-budget-auto-bypassed", { detail: { diagnostics, health: this.health } }));
      }
    }
  }

  recordAudioError(error) {
    const processTimedOut = isRenderDeadlineProtocolError(error);
    this.audioErrors = Math.min(1024, this.audioErrors + 1);
    this.consecutiveAudioErrors = Math.min(1024, this.consecutiveAudioErrors + 1);
    this.lastAudioError = error;
    this.unhealthyReason = processTimedOut ? "process-timeout" : "audio-error";
    let autoBypassed = false;
    if (this.maxConsecutiveAudioErrors > 0 && this.consecutiveAudioErrors >= this.maxConsecutiveAudioErrors && !this.bypassed && !this.audioErrorAutoBypassed) {
      this.audioErrorAutoBypassed = true;
      autoBypassed = true;
      this.setBypassed(true);
      this.dispatchEvent(new CustomEvent("audio-error-auto-bypassed", { detail: { error, health: this.health } }));
    }
    if (processTimedOut) {
      const detail = { error, autoBypassed, health: this.health };
      this.dispatchEvent(new CustomEvent("process-timeout", { detail }));
      this.dispatchEvent(new CustomEvent("process-timeout-tripped", { detail }));
      if (autoBypassed) this.dispatchEvent(new CustomEvent("process-timeout-auto-bypassed", { detail }));
    }
  }

  clearAudioError() {
    if (this.unhealthyReason === "audio-error" || this.unhealthyReason === "process-timeout") {
      this.lastAudioError = undefined;
      this.consecutiveAudioErrors = 0;
      this.unhealthyReason = undefined;
    }
  }

  clearAutoBypassState() {
    if (!(this.renderBudgetAutoBypassed || this.audioErrorAutoBypassed || this.transportPressureAutoBypassed)) return false;
    if (this.unhealthyReason === "process-timeout") return false;
    this.renderBudgetAutoBypassed = this.audioErrorAutoBypassed = this.transportPressureAutoBypassed = false;
    this.renderBudgetExceeded = false;
    this.renderBudgetMisses = 0;
    this.consecutiveAudioErrors = 0;
    this.consecutiveTransportPressureEvents = 0;
    this.lastAudioError = undefined;
    if (this.unhealthyReason === "render-budget-exceeded" || this.unhealthyReason === "audio-error" || this.unhealthyReason === "process-timeout" || this.unhealthyReason === "transport-pressure") this.unhealthyReason = undefined;
    return true;
  }

  recordRenderLatency(latencySamples, diagnostics) {
    const pluginLatencySamples = boundedAudioNodeOptionalNumber(latencySamples, 0, 1048576);
    if (pluginLatencySamples === undefined || pluginLatencySamples === this.pluginLatencySamples) return;
    const previous = { pluginLatencySamples: this.pluginLatencySamples, transportLatencySamples: this.transportLatencySamples, reportedLatencySamples: this.reportedLatencySamples };
    this.pluginLatencySamples = pluginLatencySamples;
    this.reportedLatencySamples = combinedAudioNodeLatencySamples(this.pluginLatencySamples, this.transportLatencySamples);
    this.node.port.postMessage({ type: "set-plugin-latency", pluginLatencySamples: this.pluginLatencySamples });
    this.latencyChangeEvents = Math.min(1024, this.latencyChangeEvents + 1);
    this.lastLatencyChangeDirection = "changed";
    this.dispatchEvent(new CustomEvent("latencychange", { detail: { direction: "changed", previous, diagnostics, health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }
}

function boundedAudioNodeInteger(value, fallback, min, max) {
  const integer = Math.floor(Number(value ?? fallback));
  return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
}

function boundedAudioNodeOptionalNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : undefined;
}

export function boundedAudioNodeTransportPressureReasons(reasons) {
  if (reasons === undefined || reasons === null) return undefined;
  const values = [];
  const length = boundedAudioNodeInteger(reasons.length, 0, 0, 16);
  for (let index = 0; index < length; index += 1) {
    const reason = audioNodeTransportPressureReason(reasons[index]);
    if (reason !== undefined && !values.includes(reason)) values.push(reason);
  }
  return values;
}

export function shouldAutoBypassAudioNodeTransportPressure(reasons, autoBypassReasons) {
  if (autoBypassReasons === undefined || autoBypassReasons === null) return true;
  const allowed = boundedAudioNodeTransportPressureReasons(autoBypassReasons) ?? [];
  const length = boundedAudioNodeInteger(reasons.length, 0, 0, 16);
  for (let index = 0; index < length; index += 1) {
    const reason = audioNodeTransportPressureReason(reasons[index]);
    if (reason !== undefined && allowed.includes(reason)) return true;
  }
  return false;
}

function combinedAudioNodeLatencySamples(pluginLatencySamples, transportLatencySamples) {
  return Math.min(1048576, pluginLatencySamples + transportLatencySamples);
}

function audioNodeLatencyMilliseconds(samples, sampleRate) {
  const boundedSamples = boundedAudioNodeInteger(samples, 0, 0, 1048576);
  const boundedSampleRate = boundedAudioNodeInteger(sampleRate, 48000, 1, 384000);
  return Number(((boundedSamples / boundedSampleRate) * 1000).toFixed(3));
}

function audioNodeBlockDurationMs(sampleRate, frames) {
  return (boundedAudioNodeInteger(frames, 128, 1, 8192) / boundedAudioNodeInteger(sampleRate, 48000, 1, 384000)) * 1000;
}

function audioNodeBlockUnits(value, blockValue) {
  return blockValue > 0 ? roundedAudioNodeNumber(value / blockValue) : 0;
}

function audioNodeLatencyBlocks(samples, frames) {
  const boundedFrames = boundedAudioNodeInteger(frames, 128, 1, 8192);
  return boundedAudioNodeInteger(Math.ceil(boundedAudioNodeInteger(samples, 0, 0, 1048576) / boundedFrames), 0, 0, 8192);
}

function audioNodePercentileSample(samples, min, max) {
  const values = boundedLiveAudioNodeSamples(samples, min, max);
  if (values.length === 0) return undefined;
  values.sort((left, right) => left - right);
  return roundedAudioNodeNumber(values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] ?? 0);
}

function audioNodeMinimumSample(samples, min, max) {
  const values = boundedLiveAudioNodeSamples(samples, min, max);
  return values.length > 0 ? roundedAudioNodeNumber(Math.min(...values)) : undefined;
}

function boundedLiveAudioNodeSamples(samples, min, max) {
  const length = boundedAudioNodeInteger(samples?.length, 0, 0, LIVE_AUDIO_NODE_CALIBRATION_SAMPLES);
  const values = [];
  for (let index = 0; index < length; index += 1) {
    const sample = Number(samples?.[index]);
    if (Number.isFinite(sample)) values.push(Math.max(min, Math.min(max, sample)));
  }
  return values;
}

function audioNodeDropPressure(options) {
  return [options.underruns, options.fallbackOutputBlocks, options.droppedInputBlocks, options.staleOutputBlocks, options.sharedInputDroppedBlocks, options.sharedOutputDroppedBlocks]
    .some((value) => boundedAudioNodeInteger(value, 0, 0, Number.MAX_SAFE_INTEGER) > 0);
}

function audioNodeSharedQueueMaxBlocks(options) {
  const inputQueued = boundedAudioNodeOptionalNumber(options.sharedInputQueuedMaxBlocks ?? options.sharedInputQueuedBlocks, 0, 64);
  const outputQueued = boundedAudioNodeOptionalNumber(options.sharedOutputQueuedMaxBlocks ?? options.sharedOutputQueuedBlocks, 0, 64);
  if (inputQueued === void 0 && outputQueued === void 0) return void 0;
  return Math.max(boundedAudioNodeInteger(inputQueued, 0, 0, 64), boundedAudioNodeInteger(outputQueued, 0, 0, 64));
}

function audioNodeTransportPressureReason(reason) {
  return reason === "deadline-miss" ||
    reason === "dropped-input" ||
    reason === "latency-safety" ||
    reason === "response-jitter" ||
    reason === "shared-input-drop" ||
    reason === "shared-output-drop" ||
    reason === "shared-transport-saturation" ||
    reason === "stale-output" ||
    reason === "underrun"
    ? reason
    : undefined;
}

function audioNodeFallbackReason(reason) {
  return reason === "bypass" || reason === "latency-safety" || reason === "underrun" ? reason : undefined;
}

function audioNodeCalibrationWarnings(calibration) {
  const warnings = [];
  if (calibration.hasDropPressure) warnings.push("audio-drop-pressure");
  if ((calibration.observedDeadlineLeadMinBlocks ?? 0) < 0 || calibration.hasResponseDeadlineMisses) warnings.push("deadline-miss");
  if ((calibration.observedResponseJitterP95Blocks ?? 0) > calibration.policy.responseJitterThresholdBlocks) warnings.push("response-jitter");
  if ((calibration.observedSharedQueueMaxBlocks ?? 0) >= Math.max(1, calibration.policy.sharedBufferBlocks - 1)) warnings.push("shared-ring-pressure");
  if ((calibration.observedSharedTransportInFlightMaxBlocks ?? 0) >= calibration.policy.maxInFlightBlocks) warnings.push("shared-transport-saturation");
  if ((calibration.observedSharedInputBufferAllocations ?? 0) > 0) warnings.push("shared-buffer-allocation");
  if (exceedsAudioNodePolicy(calibration.observedRenderP95Ms ?? 0, calibration.policy.blockDurationMs)) warnings.push("render-over-block-budget");
  if (calibration.recommendedOutputLatencyBlocks > calibration.currentLatencyBlocks) warnings.push("increase-output-latency");
  if (calibration.recommendedMaxOutputLatencyBlocks > calibration.policy.maxOutputLatencyBlocks) warnings.push("increase-max-output-latency");
  if (calibration.recommendedSharedBufferBlocks > calibration.policy.sharedBufferBlocks) warnings.push("increase-shared-buffer");
  if (exceedsAudioNodePolicy(calibration.recommendedAudioRequestTimeoutMs, calibration.policy.audioRequestTimeoutMs)) warnings.push("increase-audio-timeout");
  return Array.from(new Set(warnings));
}

function exceedsAudioNodePolicy(value, policyValue) {
  return value - policyValue > 0.001;
}

function roundedAudioNodeNumber(value) {
  return Number(value.toFixed(3));
}

export class LivePerformanceAudioNodeCalibrationWindow {
  constructor(options) {
    this.renderDurationsMs = [];
    this.responseJitterBlocks = [];
    this.deadlineLeadBlocks = [];
    this.underruns = 0;
    this.fallbackOutputBlocks = 0;
    this.droppedInputBlocks = 0;
    this.staleOutputBlocks = 0;
    this.sharedInputDroppedBlocks = 0;
    this.sharedOutputDroppedBlocks = 0;
    this.sharedInputBufferAllocations = 0;
    this.responseDeadlineMisses = 0;
    this.sharedInputQueuedBlocks = 0;
    this.sharedOutputQueuedBlocks = 0;
    this.sharedTransportInFlightBlocks = 0;
    this.pressureBaseline = void 0;
    this.droppedSamples = 0;
    this.options = { ...options };
    this.maxSamples = boundedAudioNodeInteger(options.maxSamples, LIVE_AUDIO_NODE_CALIBRATION_SAMPLES, 1, LIVE_AUDIO_NODE_CALIBRATION_SAMPLES);
  }

  record(health) {
    let accepted = false;
    let dropped = false;
    const renderDuration = boundedAudioNodeOptionalNumber(health.lastRenderDurationMs, 0, 60000);
    const responseJitter = boundedAudioNodeOptionalNumber(health.responseJitterBlocks, 0, 64);
    const deadlineLead = audioNodeDeadlineLeadBlocks(health.responseDeadlineLeadSamples, this.options.maxBlockFrames);
    if (renderDuration !== undefined) { dropped = this.append(this.renderDurationsMs, renderDuration) || dropped; accepted = true; }
    if (responseJitter !== undefined) { dropped = this.append(this.responseJitterBlocks, responseJitter) || dropped; accepted = true; }
    if (deadlineLead !== undefined) { dropped = this.append(this.deadlineLeadBlocks, deadlineLead) || dropped; accepted = true; }
    this.recordPressure(health);
    if (accepted && dropped) this.droppedSamples += 1;
    return this.snapshot();
  }

  reset() {
    this.renderDurationsMs = [];
    this.responseJitterBlocks = [];
    this.deadlineLeadBlocks = [];
    this.underruns = 0;
    this.fallbackOutputBlocks = 0;
    this.droppedInputBlocks = 0;
    this.staleOutputBlocks = 0;
    this.sharedInputDroppedBlocks = 0;
    this.sharedOutputDroppedBlocks = 0;
    this.sharedInputBufferAllocations = 0;
    this.responseDeadlineMisses = 0;
    this.sharedInputQueuedBlocks = this.sharedOutputQueuedBlocks = this.sharedTransportInFlightBlocks = 0;
    this.pressureBaseline = void 0;
    this.droppedSamples = 0;
  }

  snapshot() {
    const calibration = this.calibrate();
    return {
      samples: this.samples,
      droppedSamples: this.droppedSamples,
      calibration,
      recommendedOptions: livePerformanceAudioNodeOptionsFromCalibration(calibration)
    };
  }

  calibrate() {
    return calibrateLivePerformanceAudioNodePolicy({
      ...this.options,
      renderDurationsMs: this.renderDurationsMs,
      responseJitterBlocks: this.responseJitterBlocks,
      deadlineLeadBlocks: this.deadlineLeadBlocks,
      underruns: this.underruns,
      fallbackOutputBlocks: this.fallbackOutputBlocks,
      droppedInputBlocks: this.droppedInputBlocks,
      staleOutputBlocks: this.staleOutputBlocks,
      sharedInputDroppedBlocks: this.sharedInputDroppedBlocks,
      sharedOutputDroppedBlocks: this.sharedOutputDroppedBlocks,
      sharedInputBufferAllocations: this.sharedInputBufferAllocations,
      responseDeadlineMisses: this.responseDeadlineMisses,
      sharedInputQueuedBlocks: this.sharedInputQueuedBlocks,
      sharedOutputQueuedBlocks: this.sharedOutputQueuedBlocks,
      sharedTransportInFlightBlocks: this.sharedTransportInFlightBlocks
    });
  }

  recommendedOptions(overrides = {}) {
    return livePerformanceAudioNodeOptionsFromCalibration(this.calibrate(), overrides);
  }

  get samples() {
    return Math.max(this.renderDurationsMs.length, this.responseJitterBlocks.length, this.deadlineLeadBlocks.length);
  }

  append(samples, value) {
    samples.push(value);
    if (samples.length <= this.maxSamples) return false;
    samples.splice(0, samples.length - this.maxSamples);
    return true;
  }

  recordPressure(health) {
    this.sharedInputQueuedBlocks = Math.max(this.sharedInputQueuedBlocks, boundedAudioNodeInteger(health.sharedInputQueuedMaxBlocks ?? health.sharedInputQueuedBlocks, 0, 0, 64));
    this.sharedOutputQueuedBlocks = Math.max(this.sharedOutputQueuedBlocks, boundedAudioNodeInteger(health.sharedOutputQueuedMaxBlocks ?? health.sharedOutputQueuedBlocks, 0, 0, 64));
    this.sharedTransportInFlightBlocks = Math.max(this.sharedTransportInFlightBlocks, boundedAudioNodeInteger(health.sharedTransportInFlightBlocks, 0, 0, 64));
    const counters = this.pressureCounters(health);
    if (this.pressureBaseline === void 0) {
      this.pressureBaseline = counters;
      return;
    }
    this.underruns = Math.max(this.underruns, audioNodePressureCounterDelta(counters.underruns, this.pressureBaseline.underruns));
    this.fallbackOutputBlocks = Math.max(this.fallbackOutputBlocks, audioNodePressureCounterDelta(counters.fallbackOutputBlocks, this.pressureBaseline.fallbackOutputBlocks));
    this.droppedInputBlocks = Math.max(this.droppedInputBlocks, audioNodePressureCounterDelta(counters.droppedInputBlocks, this.pressureBaseline.droppedInputBlocks));
    this.staleOutputBlocks = Math.max(this.staleOutputBlocks, audioNodePressureCounterDelta(counters.staleOutputBlocks, this.pressureBaseline.staleOutputBlocks));
    this.sharedInputDroppedBlocks = Math.max(this.sharedInputDroppedBlocks, audioNodePressureCounterDelta(counters.sharedInputDroppedBlocks, this.pressureBaseline.sharedInputDroppedBlocks));
    this.sharedOutputDroppedBlocks = Math.max(this.sharedOutputDroppedBlocks, audioNodePressureCounterDelta(counters.sharedOutputDroppedBlocks, this.pressureBaseline.sharedOutputDroppedBlocks));
    this.sharedInputBufferAllocations = Math.max(this.sharedInputBufferAllocations, audioNodePressureCounterDelta(counters.sharedInputBufferAllocations, this.pressureBaseline.sharedInputBufferAllocations));
    this.responseDeadlineMisses = Math.max(this.responseDeadlineMisses, audioNodePressureCounterDelta(counters.responseDeadlineMisses, this.pressureBaseline.responseDeadlineMisses));
  }

  pressureCounters(health) {
    return {
      underruns: boundedAudioNodeInteger(health.underruns, 0, 0, Number.MAX_SAFE_INTEGER),
      fallbackOutputBlocks: boundedAudioNodeInteger(health.fallbackOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      droppedInputBlocks: boundedAudioNodeInteger(health.droppedInputBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      staleOutputBlocks: boundedAudioNodeInteger(health.staleOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      sharedInputDroppedBlocks: boundedAudioNodeInteger(health.sharedInputDroppedBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      sharedOutputDroppedBlocks: boundedAudioNodeInteger(health.sharedOutputDroppedBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      sharedInputBufferAllocations: boundedAudioNodeInteger(health.sharedInputBufferAllocations, 0, 0, Number.MAX_SAFE_INTEGER),
      responseDeadlineMisses: boundedAudioNodeInteger(health.responseDeadlineMisses, 0, 0, Number.MAX_SAFE_INTEGER)
    };
  }
}

export function createLivePerformanceAudioNodeCalibrationWindow(options) {
  return new LivePerformanceAudioNodeCalibrationWindow(options);
}

export function livePerformanceAudioNodeOptionsFromCalibration(calibration, overrides = {}) {
  const recommended = {
    ...calibration.policy.options,
    outputLatencyBlocks: calibration.recommendedOutputLatencyBlocks,
    maxOutputLatencyBlocks: calibration.recommendedMaxOutputLatencyBlocks,
    sharedBufferBlocks: calibration.recommendedSharedBufferBlocks,
    audioRequestTimeoutMs: calibration.recommendedAudioRequestTimeoutMs
  };
  return {
    ...recommended,
    ...overrides,
    outputLatencyBlocks: recommended.outputLatencyBlocks,
    maxOutputLatencyBlocks: recommended.maxOutputLatencyBlocks,
    sharedBufferBlocks: recommended.sharedBufferBlocks,
    audioRequestTimeoutMs: recommended.audioRequestTimeoutMs
  };
}

export function refreshLivePerformanceAudioNodeLatencyFromCalibration(node, calibration) {
  return node.refreshLatency(calibration.recommendedTransportLatencySamples);
}

const LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_MIN_SAMPLES = 8;
const LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_COOLDOWN_BLOCKS = 64;
const LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_MAX_STEP_BLOCKS = 4;
const LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_RECOVERY_BLOCKS = 128;
const LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_MAX_RECOVERY_STEP_BLOCKS = 1;

export class LivePerformanceAudioNodeAdaptiveLatencyController {
  constructor(options) {
    const {
      node,
      minSamples,
      cooldownBlocks,
      maxLatencyIncreaseBlocks,
      latencyRecoveryBlocks,
      maxLatencyDecreaseBlocks,
      minTransportLatencySamples,
      minTransportLatencyBlocks,
      ...windowOptions
    } = options;
    const maxBlockFrames = boundedAudioNodeInteger(windowOptions.maxBlockFrames, 128, 1, 8192);
    const minimumFromBlocks = minTransportLatencyBlocks === undefined ? undefined : boundedAudioNodeInteger(minTransportLatencyBlocks, 0, 0, 128) * maxBlockFrames;
    this.node = node;
    this.window = new LivePerformanceAudioNodeCalibrationWindow(windowOptions);
    this.minSamples = boundedAudioNodeInteger(minSamples, LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_MIN_SAMPLES, 1, 256);
    this.cooldownBlocks = boundedAudioNodeInteger(cooldownBlocks, LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_COOLDOWN_BLOCKS, 0, 4096);
    this.maxLatencyIncreaseBlocks = boundedAudioNodeInteger(maxLatencyIncreaseBlocks, LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_MAX_STEP_BLOCKS, 1, 128);
    this.latencyRecoveryBlocks = boundedAudioNodeInteger(latencyRecoveryBlocks, LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_RECOVERY_BLOCKS, 0, 4096);
    this.maxLatencyDecreaseBlocks = boundedAudioNodeInteger(maxLatencyDecreaseBlocks, LIVE_AUDIO_NODE_ADAPTIVE_LATENCY_MAX_RECOVERY_STEP_BLOCKS, 1, 128);
    this.minTransportLatencySamples = boundedAudioNodeInteger(minTransportLatencySamples ?? minimumFromBlocks ?? windowOptions.transportLatencySamples, 0, 0, 1048576);
    this.cooldownBlocksRemaining = 0;
    this.stableBlocks = 0;
  }

  async record(health = this.node.health) {
    if (this.cooldownBlocksRemaining > 0) this.cooldownBlocksRemaining -= 1;
    const snapshot = this.window.record(health);
    const recreateRecommendations = this.recreateRecommendations(snapshot);
    const currentTransportLatencySamples = boundedAudioNodeInteger(
      this.node.health.transportLatencySamples,
      snapshot.calibration.policy.transportLatencySamples,
      0,
      1048576
    );
    const maxBlockFrames = snapshot.calibration.policy.maxBlockFrames;
    let targetTransportLatencySamples = Math.min(
      snapshot.calibration.recommendedTransportLatencySamples,
      currentTransportLatencySamples + this.maxLatencyIncreaseBlocks * maxBlockFrames
    );
    let refreshResult;
    let applied = false;
    let appliedDirection = "none";
    if (this.shouldApply(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
      refreshResult = await this.node.refreshLatency(targetTransportLatencySamples);
      applied = true;
      appliedDirection = "increase";
      this.cooldownBlocksRemaining = this.cooldownBlocks;
      this.stableBlocks = 0;
      this.window.reset();
    } else {
      this.recordStableBlock(snapshot);
      targetTransportLatencySamples = this.recoveryTarget(currentTransportLatencySamples, maxBlockFrames);
      if (this.shouldRecover(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
        refreshResult = await this.node.refreshLatency(targetTransportLatencySamples);
        applied = true;
        appliedDirection = "decrease";
        this.cooldownBlocksRemaining = this.cooldownBlocks;
        this.stableBlocks = 0;
        this.window.reset();
      }
    }
    return {
      ...snapshot,
      applied,
      appliedDirection,
      recreateRecommended: recreateRecommendations.length > 0,
      recreateReasons: recreateRecommendations.map((recommendation) => recommendation.reason),
      recreateRecommendations,
      currentTransportLatencySamples,
      targetTransportLatencySamples,
      cooldownBlocksRemaining: this.cooldownBlocksRemaining,
      stableBlocks: this.stableBlocks,
      recoveryBlocksRemaining: Math.max(0, this.latencyRecoveryBlocks - this.stableBlocks),
      refreshResult
    };
  }

  reset() {
    this.window.reset();
    this.cooldownBlocksRemaining = 0;
    this.stableBlocks = 0;
  }

  shouldApply(snapshot, targetTransportLatencySamples, currentTransportLatencySamples) {
    return (
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      targetTransportLatencySamples > currentTransportLatencySamples &&
      snapshot.calibration.warnings.includes("increase-output-latency")
    );
  }

  recreateRecommendations(snapshot) {
    if (snapshot.samples < this.minSamples) return [];
    const { calibration } = snapshot;
    const warnings = calibration.warnings;
    const recommendations = [];
    if (warnings.includes("increase-max-output-latency")) recommendations.push({ reason: "increase-max-output-latency", current: calibration.policy.maxOutputLatencyBlocks, recommended: calibration.recommendedMaxOutputLatencyBlocks });
    if (warnings.includes("increase-shared-buffer")) recommendations.push({ reason: "increase-shared-buffer", current: calibration.policy.sharedBufferBlocks, recommended: calibration.recommendedSharedBufferBlocks });
    if (warnings.includes("increase-audio-timeout")) recommendations.push({ reason: "increase-audio-timeout", current: calibration.policy.audioRequestTimeoutMs, recommended: calibration.recommendedAudioRequestTimeoutMs });
    return recommendations;
  }

  shouldRecover(snapshot, targetTransportLatencySamples, currentTransportLatencySamples) {
    return (
      this.latencyRecoveryBlocks > 0 &&
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      this.stableBlocks >= this.latencyRecoveryBlocks &&
      targetTransportLatencySamples < currentTransportLatencySamples &&
      snapshot.calibration.warnings.length === 0
    );
  }

  recordStableBlock(snapshot) {
    if (snapshot.samples >= this.minSamples && snapshot.calibration.warnings.length === 0) {
      this.stableBlocks = Math.min(4096, this.stableBlocks + 1);
      return;
    }
    if (snapshot.calibration.warnings.length > 0) this.stableBlocks = 0;
  }

  recoveryTarget(currentTransportLatencySamples, maxBlockFrames) {
    return Math.max(
      this.minTransportLatencySamples,
      currentTransportLatencySamples - this.maxLatencyDecreaseBlocks * maxBlockFrames
    );
  }
}

export function createLivePerformanceAudioNodeAdaptiveLatencyController(options) {
  return new LivePerformanceAudioNodeAdaptiveLatencyController(options);
}

const LIVE_AUDIO_NODE_RECOVERY_BLOCKS = 16;
const LIVE_AUDIO_NODE_RECOVERY_ATTEMPTS = 1;

export class LivePerformanceAudioNodeRecoveryController {
  constructor(options) {
    this.node = options.node;
    this.recoveryBlocks = boundedAudioNodeInteger(options.recoveryBlocks, LIVE_AUDIO_NODE_RECOVERY_BLOCKS, 0, 4096);
    this.maxRetryAttempts = boundedAudioNodeInteger(options.maxRetryAttempts, LIVE_AUDIO_NODE_RECOVERY_ATTEMPTS, 0, 1024);
    this.recoverTransportPressure = options.recoverTransportPressure !== false;
    this.recoverRenderBudget = options.recoverRenderBudget !== false;
    this.recoverAudioErrors = options.recoverAudioErrors === true;
    this.retryAttempts = 0;
    this.dryBlocks = 0;
    this.lastFallbackOutputBlocks = void 0;
    this.activeReason = void 0;
  }

  record(health = this.node.health) {
    const reason = this.recoveryReason(health);
    if (reason === void 0) {
      this.resetWindow(health);
      return this.snapshot(false, false, false, void 0, health);
    }
    if (reason !== this.activeReason) {
      this.activeReason = reason;
      this.dryBlocks = 0;
      this.lastFallbackOutputBlocks = boundedAudioNodeInteger(health.fallbackOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER);
    } else {
      this.recordDryBlocks(health);
    }
    const exhausted = this.retryAttempts >= this.maxRetryAttempts;
    if (!exhausted && this.dryBlocks >= this.recoveryBlocks) {
      const applied = this.node.retry();
      if (applied) {
        this.retryAttempts = Math.min(1024, this.retryAttempts + 1);
        const snapshot = this.snapshot(true, true, this.retryAttempts >= this.maxRetryAttempts, reason, this.node.health);
        this.resetWindow(this.node.health);
        return snapshot;
      }
    }
    return this.snapshot(false, true, exhausted, reason, health);
  }

  reset() {
    this.retryAttempts = 0;
    this.dryBlocks = 0;
    this.lastFallbackOutputBlocks = void 0;
    this.activeReason = void 0;
  }

  recoveryReason(health) {
    if (!health.bypassed) return void 0;
    if (health.unhealthyReason === "process-timeout") return void 0;
    if (this.recoverTransportPressure && health.transportPressureAutoBypassed) return "transport-pressure";
    if (this.recoverRenderBudget && health.renderBudgetAutoBypassed) return "render-budget";
    if (this.recoverAudioErrors && health.audioErrorAutoBypassed) return "audio-error";
    return void 0;
  }

  recordDryBlocks(health) {
    const fallbackBlocks = boundedAudioNodeInteger(health.fallbackOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER);
    if (this.lastFallbackOutputBlocks === void 0) {
      this.lastFallbackOutputBlocks = fallbackBlocks;
      return;
    }
    this.dryBlocks = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.dryBlocks + Math.max(0, fallbackBlocks - this.lastFallbackOutputBlocks)
    );
    this.lastFallbackOutputBlocks = fallbackBlocks;
  }

  resetWindow(health) {
    this.dryBlocks = 0;
    this.lastFallbackOutputBlocks = boundedAudioNodeInteger(health.fallbackOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER);
    this.activeReason = void 0;
  }

  snapshot(applied, active, exhausted, reason, health) {
    return {
      applied,
      active,
      exhausted,
      reason,
      dryBlocks: this.dryBlocks,
      recoveryBlocks: this.recoveryBlocks,
      recoveryBlocksRemaining: Math.max(0, this.recoveryBlocks - this.dryBlocks),
      retryAttempts: this.retryAttempts,
      maxRetryAttempts: this.maxRetryAttempts,
      health
    };
  }
}

export function createLivePerformanceAudioNodeRecoveryController(options) {
  return new LivePerformanceAudioNodeRecoveryController(options);
}

const LIVE_AUDIO_NODE_RECREATE_BLOCKS = 16;
const LIVE_AUDIO_NODE_RECREATE_ATTEMPTS = 1;
export class LivePerformanceAudioNodeRecreateController {
  constructor(options) {
    this.recreateAttempts = 0;
    this.dryBlocks = 0;
    this.lastFallbackOutputBlocks = void 0;
    this.activeReason = void 0;
    this.node = options.node;
    this.recreateTarget = options.recreate;
    this.recreateBlocks = boundedAudioNodeInteger(options.recreateBlocks, LIVE_AUDIO_NODE_RECREATE_BLOCKS, 0, 4096);
    this.maxRecreateAttempts = boundedAudioNodeInteger(options.maxRecreateAttempts, LIVE_AUDIO_NODE_RECREATE_ATTEMPTS, 0, 1024);
  }

  async record(health = this.node.health) {
    const reason = this.recreateReason(health);
    if (reason === void 0) {
      this.resetWindow(health);
      return this.snapshot(false, false, false, void 0, health);
    }
    if (reason !== this.activeReason) {
      this.activeReason = reason;
      this.dryBlocks = 0;
      this.lastFallbackOutputBlocks = boundedAudioNodeInteger(health.fallbackOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER);
    } else {
      this.recordDryBlocks(health);
    }
    const exhausted = this.recreateAttempts >= this.maxRecreateAttempts;
    if (!exhausted && this.dryBlocks >= this.recreateBlocks) {
      this.recreateAttempts = Math.min(1024, this.recreateAttempts + 1);
      try {
        const result = await this.recreateTarget(health);
        const snapshot = this.snapshot(true, true, this.recreateAttempts >= this.maxRecreateAttempts, reason, this.node.health, result);
        this.resetWindow(this.node.health);
        return snapshot;
      } catch (error) {
        return this.snapshot(false, true, this.recreateAttempts >= this.maxRecreateAttempts, reason, health, void 0, error);
      }
    }
    return this.snapshot(false, true, exhausted, reason, health);
  }

  reset() {
    this.recreateAttempts = 0;
    this.dryBlocks = 0;
    this.lastFallbackOutputBlocks = void 0;
    this.activeReason = void 0;
  }

  recreateReason(health) {
    return health.bypassed && health.unhealthyReason === "process-timeout" ? "process-timeout" : void 0;
  }

  recordDryBlocks(health) {
    const fallbackBlocks = boundedAudioNodeInteger(health.fallbackOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER);
    if (this.lastFallbackOutputBlocks === void 0) {
      this.lastFallbackOutputBlocks = fallbackBlocks;
      return;
    }
    this.dryBlocks = Math.min(Number.MAX_SAFE_INTEGER, this.dryBlocks + Math.max(0, fallbackBlocks - this.lastFallbackOutputBlocks));
    this.lastFallbackOutputBlocks = fallbackBlocks;
  }

  resetWindow(health) {
    this.dryBlocks = 0;
    this.lastFallbackOutputBlocks = boundedAudioNodeInteger(health.fallbackOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER);
    this.activeReason = void 0;
  }

  snapshot(applied, active, exhausted, reason, health, result, error) {
    return {
      applied,
      active,
      exhausted,
      reason,
      dryBlocks: this.dryBlocks,
      recreateBlocks: this.recreateBlocks,
      recreateBlocksRemaining: Math.max(0, this.recreateBlocks - this.dryBlocks),
      recreateAttempts: this.recreateAttempts,
      maxRecreateAttempts: this.maxRecreateAttempts,
      health,
      result,
      error
    };
  }
}

export function createLivePerformanceAudioNodeRecreateController(options) {
  return new LivePerformanceAudioNodeRecreateController(options);
}

function audioNodeDeadlineLeadBlocks(responseDeadlineLeadSamples, maxBlockFrames) {
  const leadSamples = boundedAudioNodeOptionalNumber(responseDeadlineLeadSamples, -1048576, 1048576);
  if (leadSamples === undefined) return undefined;
  return roundedAudioNodeNumber(leadSamples / boundedAudioNodeInteger(Number(maxBlockFrames), 128, 1, 8192));
}

function audioNodePressureCounterDelta(current, baseline) {
  return current >= baseline ? current - baseline : current;
}

const LIVE_PERFORMANCE_INPUT_AGE_BLOCKS = 4;
const LIVE_PERFORMANCE_PROCESS_BUDGET_BLOCKS = 1;
const LIVE_PERFORMANCE_PROCESS_BUDGET_MISSES = 3;
const LIVE_PERFORMANCE_PROCESS_TIMEOUT_BLOCKS = 4;
const LIVE_PERFORMANCE_TRANSITION_FADE_BLOCKS = 0.5;
const LIVE_PERFORMANCE_RECOVERY_BLOCKS = 16;
const LIVE_PERFORMANCE_PROCESS_TIMEOUT_RECOVERIES = 1;
const LIVE_EFFECT_CALIBRATION_SAMPLES = 256;
const LIVE_EFFECT_MAX_LATENCY_SAMPLES = 1048576;
const LIVE_TRANSPORT_MAX_SAMPLE_POSITION = 9007199254740991;
const LIVE_TRANSPORT_MAX_MUSIC = 1000000000;
const LIVE_TRANSPORT_DENOMINATORS = [1, 2, 4, 8, 16, 32, 64];

export function createLiveEffectRackPolicy(options) {
  const sampleRate = boundedLiveEffectInteger(options.sampleRate, 48000, 1, 384000);
  const maxBlockSize = liveEffectBlockFrames(options.maxBlockSize);
  const blockDurationMs = liveEffectBlockDurationMs(sampleRate, maxBlockSize);
  const maxInputAgeBlocks = boundedLiveEffectNumber(options.maxInputAgeBlocks, LIVE_PERFORMANCE_INPUT_AGE_BLOCKS, 0, 128);
  const processBudgetBlocks = boundedLiveEffectNumber(options.processBudgetBlocks, LIVE_PERFORMANCE_PROCESS_BUDGET_BLOCKS, 0, 128);
  const processTimeoutBlocks = boundedLiveEffectNumber(options.processTimeoutBlocks, LIVE_PERFORMANCE_PROCESS_TIMEOUT_BLOCKS, 0, 128);
  const transitionFadeBlocks = boundedLiveEffectNumber(options.transitionFadeBlocks, LIVE_PERFORMANCE_TRANSITION_FADE_BLOCKS, 0, 8);
  const maxInputAgeMs = boundedLiveEffectNumber(options.maxInputAgeMs, blockDurationMs * maxInputAgeBlocks, 0, 60000);
  const processBudgetMs = boundedLiveEffectNumber(options.processBudgetMs, blockDurationMs * processBudgetBlocks, 0, 60000);
  const processTimeoutMs = boundedLiveEffectNumber(options.processTimeoutMs, blockDurationMs * processTimeoutBlocks, 0, 60000);
  const transitionFadeSamples = boundedLiveEffectInteger(options.transitionFadeSamples, Math.ceil(maxBlockSize * transitionFadeBlocks), 0, 4096);
  const pluginLatencySamples = boundedLiveEffectLatencySamples(options.pluginLatencySamples, 0);
  const transportLatencySamples = boundedLiveEffectLatencySamples(options.transportLatencySamples, 0);
  const reportedLatencySamples = combinedLiveEffectLatencySamples(pluginLatencySamples, transportLatencySamples);
  return {
    sampleRate,
    maxBlockSize,
    blockDurationMs: Number(blockDurationMs.toFixed(3)),
    maxInputAgeMs,
    maxInputAgeBlocks: liveEffectPolicyBlockUnits(maxInputAgeMs, blockDurationMs),
    maxInFlightBlocks: boundedLiveEffectInteger(options.maxInFlightBlocks, 1, 1, 32),
    processBudgetMs,
    processBudgetBlocks: liveEffectPolicyBlockUnits(processBudgetMs, blockDurationMs),
    processTimeoutMs,
    processTimeoutBlocks: liveEffectPolicyBlockUnits(processTimeoutMs, blockDurationMs),
    transitionFadeSamples,
    transitionFadeBlocks: liveEffectPolicyBlockUnits(transitionFadeSamples, maxBlockSize),
    maxConsecutiveProcessBudgetMisses: boundedLiveEffectInteger(options.maxConsecutiveProcessBudgetMisses, LIVE_PERFORMANCE_PROCESS_BUDGET_MISSES, 0, 1024),
    maxConsecutiveRenderBudgetMisses: boundedLiveEffectInteger(options.maxConsecutiveRenderBudgetMisses, 2, 0, 1024),
    processBudgetRecoveryBlocks: boundedLiveEffectInteger(options.processBudgetRecoveryBlocks, LIVE_PERFORMANCE_RECOVERY_BLOCKS, 0, 4096),
    renderBudgetRecoveryBlocks: boundedLiveEffectInteger(options.renderBudgetRecoveryBlocks, LIVE_PERFORMANCE_RECOVERY_BLOCKS, 0, 4096),
    processTimeoutRecoveryBlocks: boundedLiveEffectInteger(options.processTimeoutRecoveryBlocks, LIVE_PERFORMANCE_RECOVERY_BLOCKS, 0, 4096),
    maxProcessTimeoutRecoveries: boundedLiveEffectInteger(options.maxProcessTimeoutRecoveries, LIVE_PERFORMANCE_PROCESS_TIMEOUT_RECOVERIES, 0, 32),
    pluginLatencySamples,
    transportLatencySamples,
    reportedLatencySamples,
    reportedLatencyMs: liveEffectLatencyMilliseconds(reportedLatencySamples, sampleRate)
  };
}

function liveEffectPolicyBlockUnits(value, blockValue) {
  return blockValue > 0 ? Number((value / blockValue).toFixed(3)) : 0;
}

export function calibrateLiveEffectRackPolicy(options) {
  const policy = createLiveEffectRackPolicy(options);
  const safetyBlocks = boundedLiveEffectNumber(options.safetyMarginBlocks, 1, 0, 8);
  const safetyMs = policy.blockDurationMs * safetyBlocks;
  const observedProcessP95Ms = liveEffectPercentileSample(options.processDurationsMs, 0, 60000);
  const observedRenderP95Ms = liveEffectPercentileSample(options.renderDurationsMs, 0, 60000);
  const observedResponseJitterP95Blocks = liveEffectPercentileSample(options.responseJitterBlocks, 0, 64);
  const observedDeadlineLeadMinBlocks = liveEffectMinimumSample(options.deadlineLeadBlocks, -64, 64);
  const hasDryOutputPressure = liveEffectDropPressure(options);
  const hasResponseDeadlineMisses = boundedLiveEffectCalibrationCounter(options.responseDeadlineMisses) > 0;
  const hasRenderTimeouts = boundedLiveEffectCalibrationCounter(options.renderTimeouts) > 0;
  const currentLatencyBlocks = liveEffectPolicyBlockUnits(policy.transportLatencySamples, policy.maxBlockSize);
  const dryPressureLatencyBlocks = hasDryOutputPressure ? 1 : 0;
  const jitterLatencyBlocks = Math.ceil(
    (observedResponseJitterP95Blocks ?? 0) +
      Math.max(0, -(observedDeadlineLeadMinBlocks ?? 0)) +
      safetyBlocks
  ) + dryPressureLatencyBlocks;
  const recommendedTransportLatencyBlocks = boundedLiveEffectInteger(
    Math.max(currentLatencyBlocks, jitterLatencyBlocks),
    currentLatencyBlocks,
    0,
    128
  );
  const recommendedTransportLatencySamples = boundedLiveEffectLatencySamples(
    recommendedTransportLatencyBlocks * policy.maxBlockSize,
    policy.transportLatencySamples
  );
  const observedBudgetWithSafetyMs = Math.max(observedProcessP95Ms ?? 0, observedRenderP95Ms ?? 0) + safetyMs;
  const timeoutPressureSafetyMs = hasRenderTimeouts ? policy.blockDurationMs * Math.max(1, safetyBlocks) : 0;
  const recommendedProcessBudgetMs = roundedLiveEffectPolicyNumber(
    boundedLiveEffectNumber(
      Math.max(policy.processBudgetMs, observedBudgetWithSafetyMs),
      policy.processBudgetMs,
      0,
      60000
    )
  );
  const recommendedProcessTimeoutMs = roundedLiveEffectPolicyNumber(
    boundedLiveEffectNumber(
      Math.max(policy.processTimeoutMs + timeoutPressureSafetyMs, recommendedProcessBudgetMs + safetyMs),
      policy.processTimeoutMs,
      0,
      60000
    )
  );
  const recommendedReportedLatencySamples = combinedLiveEffectLatencySamples(policy.pluginLatencySamples, recommendedTransportLatencySamples);
  const warnings = liveEffectCalibrationWarnings({
    policy,
    observedProcessP95Ms,
    observedRenderP95Ms,
    observedResponseJitterP95Blocks,
    observedDeadlineLeadMinBlocks,
    recommendedProcessBudgetMs,
    recommendedProcessTimeoutMs,
    recommendedTransportLatencyBlocks,
    currentLatencyBlocks,
    hasDryOutputPressure,
    hasResponseDeadlineMisses,
    hasRenderTimeouts
  });
  return {
    policy,
    observedProcessP95Ms,
    observedRenderP95Ms,
    observedResponseJitterP95Blocks,
    observedDeadlineLeadMinBlocks,
    recommendedProcessBudgetMs,
    recommendedProcessTimeoutMs,
    recommendedTransportLatencyBlocks,
    recommendedTransportLatencySamples,
    recommendedReportedLatencySamples,
    recommendedReportedLatencyMs: liveEffectLatencyMilliseconds(recommendedReportedLatencySamples, policy.sampleRate),
    realtimeReady: warnings.length === 0,
    warnings
  };
}

function liveEffectPercentileSample(samples, min, max) {
  const values = boundedLiveEffectSamples(samples, min, max);
  if (values.length === 0) return void 0;
  values.sort((left, right) => left - right);
  return roundedLiveEffectPolicyNumber(values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] ?? 0);
}

function liveEffectMinimumSample(samples, min, max) {
  const values = boundedLiveEffectSamples(samples, min, max);
  return values.length > 0 ? roundedLiveEffectPolicyNumber(Math.min(...values)) : void 0;
}

function boundedLiveEffectSamples(samples, min, max) {
  const length = boundedLiveEffectInteger(samples?.length, 0, 0, LIVE_EFFECT_CALIBRATION_SAMPLES);
  const values = [];
  for (let index = 0; index < length; index += 1) {
    const sample = Number(samples?.[index]);
    if (Number.isFinite(sample)) values.push(Math.max(min, Math.min(max, sample)));
  }
  return values;
}

function liveEffectCalibrationWarnings(calibration) {
  const warnings = [];
  if (calibration.hasDryOutputPressure) warnings.push("dry-output-pressure");
  if (exceedsLiveEffectPolicy(calibration.observedProcessP95Ms ?? 0, calibration.policy.processBudgetMs)) warnings.push("process-over-budget");
  if (exceedsLiveEffectPolicy(calibration.observedRenderP95Ms ?? 0, calibration.policy.blockDurationMs)) warnings.push("render-over-block-budget");
  if ((calibration.observedDeadlineLeadMinBlocks ?? 0) < 0 || calibration.hasResponseDeadlineMisses) warnings.push("deadline-miss");
  if (calibration.hasRenderTimeouts) warnings.push("process-timeout");
  if ((calibration.observedResponseJitterP95Blocks ?? 0) > calibration.currentLatencyBlocks) warnings.push("response-jitter");
  if (exceedsLiveEffectPolicy(calibration.recommendedProcessBudgetMs, calibration.policy.processBudgetMs)) warnings.push("increase-process-budget");
  if (exceedsLiveEffectPolicy(calibration.recommendedProcessTimeoutMs, calibration.policy.processTimeoutMs)) warnings.push("increase-process-timeout");
  if (calibration.recommendedTransportLatencyBlocks > calibration.currentLatencyBlocks) warnings.push("increase-transport-latency");
  return Array.from(new Set(warnings));
}

function roundedLiveEffectPolicyNumber(value) {
  return Number(value.toFixed(3));
}

function exceedsLiveEffectPolicy(value, policyValue) {
  return value - policyValue > 0.001;
}

function liveEffectDropPressure(options) {
  return [options.droppedInputBlocks, options.staleInputBlocks, options.staleOutputBlocks, options.dryOutputBlocks]
    .some((value) => boundedLiveEffectCalibrationCounter(value) > 0);
}

function boundedLiveEffectCalibrationCounter(value) {
  return boundedLiveEffectInteger(value, 0, 0, Number.MAX_SAFE_INTEGER);
}

export class LiveEffectRackCalibrationWindow {
  constructor(options) {
    this.processDurationsMs = [];
    this.renderDurationsMs = [];
    this.responseJitterBlocks = [];
    this.deadlineLeadBlocks = [];
    this.droppedInputBlocks = 0;
    this.staleInputBlocks = 0;
    this.staleOutputBlocks = 0;
    this.dryOutputBlocks = 0;
    this.responseDeadlineMisses = 0;
    this.renderTimeouts = 0;
    this.pressureBaseline = void 0;
    this.pluginLatencySamples = void 0;
    this.droppedSamples = 0;
    this.options = { ...options };
    this.maxSamples = boundedLiveEffectInteger(options.maxSamples, LIVE_EFFECT_CALIBRATION_SAMPLES, 1, LIVE_EFFECT_CALIBRATION_SAMPLES);
  }

  record(health) {
    let accepted = false;
    let dropped = false;
    const processDuration = boundedLiveEffectOptionalNumber(health.lastProcessDurationMs, 0, 60000);
    const renderDuration = boundedLiveEffectOptionalNumber(health.lastRenderDurationMs, 0, 60000);
    const responseJitter = boundedLiveEffectOptionalNumber(health.responseJitterBlocks, 0, 64);
    const deadlineLead = boundedLiveEffectOptionalNumber(health.lastResponseDeadlineLeadBlocks, -64, 64);
    this.recordLatency(health);
    if (processDuration !== void 0) { dropped = this.append(this.processDurationsMs, processDuration) || dropped; accepted = true; }
    if (renderDuration !== void 0) { dropped = this.append(this.renderDurationsMs, renderDuration) || dropped; accepted = true; }
    if (responseJitter !== void 0) { dropped = this.append(this.responseJitterBlocks, responseJitter) || dropped; accepted = true; }
    if (deadlineLead !== void 0) { dropped = this.append(this.deadlineLeadBlocks, deadlineLead) || dropped; accepted = true; }
    this.recordPressure(health);
    if (accepted && dropped) this.droppedSamples += 1;
    return this.snapshot();
  }

  reset() {
    this.processDurationsMs = [];
    this.renderDurationsMs = [];
    this.responseJitterBlocks = [];
    this.deadlineLeadBlocks = [];
    this.droppedInputBlocks = 0;
    this.staleInputBlocks = 0;
    this.staleOutputBlocks = 0;
    this.dryOutputBlocks = 0;
    this.responseDeadlineMisses = 0;
    this.renderTimeouts = 0;
    this.pressureBaseline = void 0;
    this.pluginLatencySamples = void 0;
    this.droppedSamples = 0;
  }

  snapshot() {
    const calibration = this.calibrate();
    return {
      samples: this.samples,
      droppedSamples: this.droppedSamples,
      calibration,
      recommendedPolicyOptions: liveEffectRackPolicyOptionsFromCalibration(calibration)
    };
  }

  calibrate() {
    return calibrateLiveEffectRackPolicy({
      ...this.options,
      pluginLatencySamples: this.pluginLatencySamples ?? this.options.pluginLatencySamples,
      processDurationsMs: this.processDurationsMs,
      renderDurationsMs: this.renderDurationsMs,
      responseJitterBlocks: this.responseJitterBlocks,
      deadlineLeadBlocks: this.deadlineLeadBlocks,
      droppedInputBlocks: this.droppedInputBlocks,
      staleInputBlocks: this.staleInputBlocks,
      staleOutputBlocks: this.staleOutputBlocks,
      dryOutputBlocks: this.dryOutputBlocks,
      responseDeadlineMisses: this.responseDeadlineMisses,
      renderTimeouts: this.renderTimeouts
    });
  }

  recommendedPolicyOptions(overrides = {}) {
    return liveEffectRackPolicyOptionsFromCalibration(this.calibrate(), overrides);
  }

  get samples() {
    return Math.max(this.processDurationsMs.length, this.renderDurationsMs.length, this.responseJitterBlocks.length, this.deadlineLeadBlocks.length);
  }

  append(samples, value) {
    samples.push(value);
    if (samples.length <= this.maxSamples) return false;
    samples.splice(0, samples.length - this.maxSamples);
    return true;
  }

  recordPressure(health) {
    const counters = this.pressureCounters(health);
    if (this.pressureBaseline === void 0) {
      this.pressureBaseline = counters;
      return;
    }
    this.droppedInputBlocks = Math.max(this.droppedInputBlocks, liveEffectPressureCounterDelta(counters.droppedInputBlocks, this.pressureBaseline.droppedInputBlocks));
    this.staleInputBlocks = Math.max(this.staleInputBlocks, liveEffectPressureCounterDelta(counters.staleInputBlocks, this.pressureBaseline.staleInputBlocks));
    this.staleOutputBlocks = Math.max(this.staleOutputBlocks, liveEffectPressureCounterDelta(counters.staleOutputBlocks, this.pressureBaseline.staleOutputBlocks));
    this.dryOutputBlocks = Math.max(this.dryOutputBlocks, liveEffectPressureCounterDelta(counters.dryOutputBlocks, this.pressureBaseline.dryOutputBlocks));
    this.responseDeadlineMisses = Math.max(this.responseDeadlineMisses, liveEffectPressureCounterDelta(counters.responseDeadlineMisses, this.pressureBaseline.responseDeadlineMisses));
    this.renderTimeouts = Math.max(this.renderTimeouts, liveEffectPressureCounterDelta(counters.renderTimeouts, this.pressureBaseline.renderTimeouts));
  }

  recordLatency(health) {
    const pluginLatencySamples = boundedLiveEffectOptionalNumber(health.pluginLatencySamples ?? health.latencySamples, 0, Number.MAX_SAFE_INTEGER);
    if (pluginLatencySamples !== void 0) {
      this.pluginLatencySamples = Math.floor(pluginLatencySamples);
    }
  }

  pressureCounters(health) {
    return {
      droppedInputBlocks: boundedLiveEffectInteger(health.droppedInputBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      staleInputBlocks: boundedLiveEffectInteger(health.staleInputBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      staleOutputBlocks: boundedLiveEffectInteger(health.staleOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      dryOutputBlocks: boundedLiveEffectInteger(health.dryOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER),
      responseDeadlineMisses: boundedLiveEffectInteger(health.responseDeadlineMisses, 0, 0, Number.MAX_SAFE_INTEGER),
      renderTimeouts: boundedLiveEffectInteger(health.renderTimeouts, 0, 0, Number.MAX_SAFE_INTEGER)
    };
  }
}

export class LiveEffectRackChainCalibrationWindow {
  constructor(options) {
    this.dryOutputBlocks = 0;
    this.bypassDryOutputBlocks = 0;
    this.processTimeouts = 0;
    this.processTimeoutActive = false;
    this.window = new LiveEffectRackCalibrationWindow(options);
  }

  get maxSamples() {
    return this.window.maxSamples;
  }

  record(health) {
    this.recordProcessTimeout(health);
    if (health.dryOutputBlocks !== void 0) {
      this.dryOutputBlocks = boundedLiveEffectInteger(health.dryOutputBlocks, this.dryOutputBlocks, 0, Number.MAX_SAFE_INTEGER);
      this.bypassDryOutputBlocks = boundedLiveEffectInteger(health.bypassDryOutputBlocks, 0, 0, Number.MAX_SAFE_INTEGER);
    } else if (health.lastDryReason !== void 0) {
      this.dryOutputBlocks = Math.min(Number.MAX_SAFE_INTEGER, this.dryOutputBlocks + 1);
      if (isLiveEffectChainBypassDryReason(health.lastDryReason)) this.bypassDryOutputBlocks = Math.min(Number.MAX_SAFE_INTEGER, this.bypassDryOutputBlocks + 1);
    }
    const pressureDryOutputBlocks = Math.max(0, this.dryOutputBlocks - Math.min(this.bypassDryOutputBlocks, this.dryOutputBlocks));
    return this.window.record({
      lastProcessDurationMs: health.lastProcessDurationMs,
      responseJitterBlocks: health.responseJitterBlocks,
      lastResponseDeadlineLeadBlocks: health.lastResponseDeadlineLeadBlocks,
      latencySamples: health.latencySamples,
      dryOutputBlocks: pressureDryOutputBlocks,
      responseDeadlineMisses: health.responseDeadlineMisses,
      renderTimeouts: this.processTimeouts
    });
  }

  reset() {
    this.dryOutputBlocks = 0;
    this.bypassDryOutputBlocks = 0;
    this.processTimeouts = 0;
    this.processTimeoutActive = false;
    this.window.reset();
  }

  snapshot() {
    return this.window.snapshot();
  }

  calibrate() {
    return this.window.calibrate();
  }

  recommendedPolicyOptions(overrides = {}) {
    return this.window.recommendedPolicyOptions(overrides);
  }

  recordProcessTimeout(health) {
    const timeoutActive = health.processTimedOut === true || health.processTimeoutTripped === true;
    if (timeoutActive && !this.processTimeoutActive) {
      this.processTimeouts = Math.min(Number.MAX_SAFE_INTEGER, this.processTimeouts + 1);
    }
    this.processTimeoutActive = timeoutActive;
  }
}

function isLiveEffectChainBypassDryReason(reason) {
  return reason === "chain-bypass" || reason === "chain-stage-bypass";
}

export class LiveEffectRackFrameBatchCalibrationWindow {
  constructor(options) {
    this.dryOutputBlocks = 0;
    this.processTimeouts = 0;
    this.processTimeoutActive = false;
    this.window = new LiveEffectRackCalibrationWindow(options);
    this.seedPressureBaseline();
  }

  get maxSamples() {
    return this.window.maxSamples;
  }

  record(health) {
    this.recordProcessTimeout(health);
    if (this.hasDryPressure(health)) {
      this.dryOutputBlocks = Math.min(Number.MAX_SAFE_INTEGER, this.dryOutputBlocks + 1);
    }
    return this.window.record({
      lastProcessDurationMs: health.totalDurationMs,
      lastRenderDurationMs: health.maxDurationMs,
      responseJitterBlocks: health.responseJitterBlocks,
      lastResponseDeadlineLeadBlocks: health.lastResponseDeadlineLeadBlocks,
      latencySamples: liveEffectFrameBatchCalibrationLatencySamples(health),
      dryOutputBlocks: this.dryOutputBlocks,
      responseDeadlineMisses: health.responseDeadlineMisses,
      renderTimeouts: this.processTimeouts
    });
  }

  reset() {
    this.dryOutputBlocks = 0;
    this.processTimeouts = 0;
    this.processTimeoutActive = false;
    this.window.reset();
    this.seedPressureBaseline();
  }

  snapshot() {
    return this.window.snapshot();
  }

  calibrate() {
    return this.window.calibrate();
  }

  recommendedPolicyOptions(overrides = {}) {
    return this.window.recommendedPolicyOptions(overrides);
  }

  hasDryPressure(health) {
    const dryTargets = boundedLiveEffectInteger(health.dryTargets, 0, 0, Number.MAX_SAFE_INTEGER);
    const bypassedTargets = boundedLiveEffectInteger(health.bypassedTargets, 0, 0, Number.MAX_SAFE_INTEGER);
    return (
      health.processBudgetTripped === true ||
      health.processTimedOut === true ||
      health.processTimeoutTripped === true ||
      dryTargets > bypassedTargets ||
      boundedLiveEffectInteger(health.skippedTargets, 0, 0, Number.MAX_SAFE_INTEGER) > 0 ||
      boundedLiveEffectInteger(health.failedTargets, 0, 0, Number.MAX_SAFE_INTEGER) > 0
    );
  }

  recordProcessTimeout(health) {
    const timeoutActive = health.processTimedOut === true || health.processTimeoutTripped === true;
    if (timeoutActive && !this.processTimeoutActive) {
      this.processTimeouts = Math.min(Number.MAX_SAFE_INTEGER, this.processTimeouts + 1);
    }
    this.processTimeoutActive = timeoutActive;
  }

  seedPressureBaseline() {
    this.window.record({ dryOutputBlocks: 0 });
  }
}

export function createLiveEffectRackCalibrationWindow(options) {
  return new LiveEffectRackCalibrationWindow(options);
}

export function createLiveEffectRackChainCalibrationWindow(options) {
  return new LiveEffectRackChainCalibrationWindow(options);
}

export function createLiveEffectRackFrameBatchCalibrationWindow(options) {
  return new LiveEffectRackFrameBatchCalibrationWindow(options);
}

export function liveEffectRackPolicyOptionsFromCalibration(calibration, overrides = {}) {
  const policy = calibration.policy;
  const recommended = {
    sampleRate: policy.sampleRate,
    maxBlockSize: policy.maxBlockSize,
    maxInputAgeMs: policy.maxInputAgeMs,
    maxInFlightBlocks: policy.maxInFlightBlocks,
    transitionFadeSamples: policy.transitionFadeSamples,
    maxConsecutiveProcessBudgetMisses: policy.maxConsecutiveProcessBudgetMisses,
    maxConsecutiveRenderBudgetMisses: policy.maxConsecutiveRenderBudgetMisses,
    processBudgetRecoveryBlocks: policy.processBudgetRecoveryBlocks,
    renderBudgetRecoveryBlocks: policy.renderBudgetRecoveryBlocks,
    processTimeoutRecoveryBlocks: policy.processTimeoutRecoveryBlocks,
    maxProcessTimeoutRecoveries: policy.maxProcessTimeoutRecoveries,
    processBudgetMs: calibration.recommendedProcessBudgetMs,
    processTimeoutMs: calibration.recommendedProcessTimeoutMs,
    pluginLatencySamples: policy.pluginLatencySamples,
    transportLatencySamples: calibration.recommendedTransportLatencySamples
  };
  return {
    ...recommended,
    ...overrides,
    sampleRate: recommended.sampleRate,
    maxBlockSize: recommended.maxBlockSize,
    processBudgetMs: recommended.processBudgetMs,
    processTimeoutMs: recommended.processTimeoutMs,
    pluginLatencySamples: recommended.pluginLatencySamples,
    transportLatencySamples: recommended.transportLatencySamples
  };
}

export function refreshLiveEffectRackLatencyFromCalibration(rack, calibration) {
  return rack.refreshLatency(calibration.recommendedTransportLatencySamples);
}

function liveEffectPressureCounterDelta(current, baseline) {
  return current >= baseline ? current - baseline : current;
}

const LIVE_EFFECT_ADAPTIVE_LATENCY_MIN_SAMPLES = 8;
const LIVE_EFFECT_ADAPTIVE_LATENCY_COOLDOWN_BLOCKS = 64;
const LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_STEP_BLOCKS = 4;
const LIVE_EFFECT_ADAPTIVE_LATENCY_RECOVERY_BLOCKS = 128;
const LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_RECOVERY_STEP_BLOCKS = 1;

export class LiveEffectRackAdaptiveLatencyController {
  constructor(options) {
    const {
      rack,
      minSamples,
      cooldownBlocks,
      maxLatencyIncreaseBlocks,
      latencyRecoveryBlocks,
      maxLatencyDecreaseBlocks,
      minTransportLatencySamples,
      minTransportLatencyBlocks,
      ...windowOptions
    } = options;
    this.cooldownBlocksRemaining = 0;
    this.stableBlocks = 0;
    this.rack = rack;
    this.window = new LiveEffectRackCalibrationWindow(windowOptions);
    this.minSamples = boundedLiveEffectInteger(minSamples, LIVE_EFFECT_ADAPTIVE_LATENCY_MIN_SAMPLES, 1, 256);
    this.cooldownBlocks = boundedLiveEffectInteger(cooldownBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_COOLDOWN_BLOCKS, 0, 4096);
    this.maxLatencyIncreaseBlocks = boundedLiveEffectInteger(maxLatencyIncreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_STEP_BLOCKS, 1, 128);
    this.latencyRecoveryBlocks = boundedLiveEffectInteger(latencyRecoveryBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_RECOVERY_BLOCKS, 0, 4096);
    this.maxLatencyDecreaseBlocks = boundedLiveEffectInteger(maxLatencyDecreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_RECOVERY_STEP_BLOCKS, 1, 128);
    const maxBlockSize = boundedLiveEffectInteger(windowOptions.maxBlockSize, 128, 1, 8192);
    const minimumFromBlocks = minTransportLatencyBlocks === void 0
      ? void 0
      : boundedLiveEffectInteger(minTransportLatencyBlocks, 0, 0, 128) * maxBlockSize;
    this.minTransportLatencySamples = boundedLiveEffectLatencySamples(
      minTransportLatencySamples ?? minimumFromBlocks ?? windowOptions.transportLatencySamples,
      0
    );
  }

  async record(health = this.rack.health) {
    if (this.cooldownBlocksRemaining > 0) {
      this.cooldownBlocksRemaining -= 1;
    }
    const snapshot = this.window.record(health);
    const currentTransportLatencySamples = boundedLiveEffectLatencySamples(
      this.rack.health.transportLatencySamples,
      snapshot.calibration.policy.transportLatencySamples
    );
    const maxIncreaseStepSamples = this.maxLatencyIncreaseBlocks * snapshot.calibration.policy.maxBlockSize;
    const recommendedTransportLatencySamples = snapshot.calibration.recommendedTransportLatencySamples;
    let targetTransportLatencySamples = Math.min(
      recommendedTransportLatencySamples,
      currentTransportLatencySamples + maxIncreaseStepSamples
    );
    let refreshResult;
    let applied = false;
    let appliedDirection = "none";
    if (this.shouldApply(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
      refreshResult = await this.rack.refreshLatency(targetTransportLatencySamples);
      applied = true;
      appliedDirection = "increase";
      this.cooldownBlocksRemaining = this.cooldownBlocks;
      this.stableBlocks = 0;
      this.window.reset();
    } else {
      this.recordStableBlock(snapshot);
      targetTransportLatencySamples = this.recoveryTarget(currentTransportLatencySamples, snapshot.calibration.policy.maxBlockSize);
      if (this.shouldRecover(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
        refreshResult = await this.rack.refreshLatency(targetTransportLatencySamples);
        applied = true;
        appliedDirection = "decrease";
        this.cooldownBlocksRemaining = this.cooldownBlocks;
        this.stableBlocks = 0;
        this.window.reset();
      }
    }
    return {
      ...snapshot,
      applied,
      appliedDirection,
      currentTransportLatencySamples,
      targetTransportLatencySamples,
      cooldownBlocksRemaining: this.cooldownBlocksRemaining,
      stableBlocks: this.stableBlocks,
      recoveryBlocksRemaining: Math.max(0, this.latencyRecoveryBlocks - this.stableBlocks),
      refreshResult
    };
  }

  reset() {
    this.window.reset();
    this.cooldownBlocksRemaining = 0;
    this.stableBlocks = 0;
  }

  shouldApply(snapshot, targetTransportLatencySamples, currentTransportLatencySamples) {
    return (
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      targetTransportLatencySamples > currentTransportLatencySamples &&
      snapshot.calibration.warnings.includes("increase-transport-latency")
    );
  }

  shouldRecover(snapshot, targetTransportLatencySamples, currentTransportLatencySamples) {
    return (
      this.latencyRecoveryBlocks > 0 &&
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      this.stableBlocks >= this.latencyRecoveryBlocks &&
      targetTransportLatencySamples < currentTransportLatencySamples &&
      snapshot.calibration.warnings.length === 0
    );
  }

  recordStableBlock(snapshot) {
    if (snapshot.samples >= this.minSamples && snapshot.calibration.warnings.length === 0) {
      this.stableBlocks = Math.min(4096, this.stableBlocks + 1);
      return;
    }
    if (snapshot.calibration.warnings.length > 0) {
      this.stableBlocks = 0;
    }
  }

  recoveryTarget(currentTransportLatencySamples, maxBlockSize) {
    const maxDecreaseStepSamples = this.maxLatencyDecreaseBlocks * maxBlockSize;
    return Math.max(
      this.minTransportLatencySamples,
      currentTransportLatencySamples - maxDecreaseStepSamples
    );
  }
}

export class LiveEffectRackSchedulerAdaptiveLatencyController {
  constructor(options) {
    const {
      scheduler,
      minSamples,
      cooldownBlocks,
      maxLatencyIncreaseBlocks,
      latencyRecoveryBlocks,
      maxLatencyDecreaseBlocks,
      minTransportLatencySamples,
      minTransportLatencyBlocks,
      ...windowOptions
    } = options;
    this.cooldownBlocksRemaining = 0;
    this.stableBlocks = 0;
    this.scheduler = scheduler;
    this.window = new LiveEffectRackCalibrationWindow(windowOptions);
    this.minSamples = boundedLiveEffectInteger(minSamples, LIVE_EFFECT_ADAPTIVE_LATENCY_MIN_SAMPLES, 1, 256);
    this.cooldownBlocks = boundedLiveEffectInteger(cooldownBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_COOLDOWN_BLOCKS, 0, 4096);
    this.maxLatencyIncreaseBlocks = boundedLiveEffectInteger(maxLatencyIncreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_STEP_BLOCKS, 1, 128);
    this.latencyRecoveryBlocks = boundedLiveEffectInteger(latencyRecoveryBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_RECOVERY_BLOCKS, 0, 4096);
    this.maxLatencyDecreaseBlocks = boundedLiveEffectInteger(maxLatencyDecreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_RECOVERY_STEP_BLOCKS, 1, 128);
    const maxBlockSize = boundedLiveEffectInteger(windowOptions.maxBlockSize, 128, 1, 8192);
    const minimumFromBlocks = minTransportLatencyBlocks === void 0
      ? void 0
      : boundedLiveEffectInteger(minTransportLatencyBlocks, 0, 0, 128) * maxBlockSize;
    this.minTransportLatencySamples = boundedLiveEffectLatencySamples(
      minTransportLatencySamples ?? minimumFromBlocks ?? windowOptions.transportLatencySamples,
      0
    );
  }

  record(health) {
    if (this.cooldownBlocksRemaining > 0) {
      this.cooldownBlocksRemaining -= 1;
    }
    const snapshot = this.window.record(health);
    const currentTransportLatencySamples = boundedLiveEffectLatencySamples(
      this.scheduler.snapshot().transportLatencySamples,
      snapshot.calibration.policy.transportLatencySamples
    );
    const maxBlockSize = snapshot.calibration.policy.maxBlockSize;
    let targetTransportLatencySamples = Math.min(
      snapshot.calibration.recommendedTransportLatencySamples,
      currentTransportLatencySamples + this.maxLatencyIncreaseBlocks * maxBlockSize
    );
    let applied = false;
    let appliedDirection = "none";
    if (this.shouldApply(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
      this.scheduler.updateLatency(targetTransportLatencySamples);
      this.scheduler.updateDeadlinePressureFromHealth(health, snapshot.calibration);
      applied = true;
      appliedDirection = "increase";
      this.cooldownBlocksRemaining = this.cooldownBlocks;
      this.stableBlocks = 0;
      this.window.reset();
    } else {
      this.scheduler.updateDeadlinePressureFromHealth(health, snapshot.calibration);
      this.recordStableBlock(snapshot);
      targetTransportLatencySamples = this.recoveryTarget(currentTransportLatencySamples, maxBlockSize);
      if (this.shouldRecover(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
        this.scheduler.updateLatency(targetTransportLatencySamples);
        this.scheduler.updateDeadlinePressureFromHealth(health, snapshot.calibration);
        applied = true;
        appliedDirection = "decrease";
        this.cooldownBlocksRemaining = this.cooldownBlocks;
        this.stableBlocks = 0;
        this.window.reset();
      }
    }
    const deadlinePressure = this.scheduler.snapshot().deadlinePressure;
    return {
      ...snapshot,
      applied,
      appliedDirection,
      currentTransportLatencySamples,
      targetTransportLatencySamples,
      cooldownBlocksRemaining: this.cooldownBlocksRemaining,
      stableBlocks: this.stableBlocks,
      recoveryBlocksRemaining: Math.max(0, this.latencyRecoveryBlocks - this.stableBlocks),
      deadlinePressure
    };
  }

  reset() {
    this.window.reset();
    this.cooldownBlocksRemaining = 0;
    this.stableBlocks = 0;
  }

  shouldApply(snapshot, targetTransportLatencySamples, currentTransportLatencySamples) {
    return (
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      targetTransportLatencySamples > currentTransportLatencySamples &&
      snapshot.calibration.warnings.includes("increase-transport-latency")
    );
  }

  shouldRecover(snapshot, targetTransportLatencySamples, currentTransportLatencySamples) {
    return (
      this.latencyRecoveryBlocks > 0 &&
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      this.stableBlocks >= this.latencyRecoveryBlocks &&
      targetTransportLatencySamples < currentTransportLatencySamples &&
      snapshot.calibration.warnings.length === 0
    );
  }

  recordStableBlock(snapshot) {
    if (snapshot.samples >= this.minSamples && snapshot.calibration.warnings.length === 0) {
      this.stableBlocks = Math.min(4096, this.stableBlocks + 1);
      return;
    }
    if (snapshot.calibration.warnings.length > 0) {
      this.stableBlocks = 0;
    }
  }

  recoveryTarget(currentTransportLatencySamples, maxBlockSize) {
    const maxDecreaseStepSamples = this.maxLatencyDecreaseBlocks * maxBlockSize;
    return Math.max(
      this.minTransportLatencySamples,
      currentTransportLatencySamples - maxDecreaseStepSamples
    );
  }
}

export class LiveEffectRackChainSchedulerAdaptiveLatencyController {
  constructor(options) {
    const {
      scheduler,
      minSamples,
      cooldownBlocks,
      maxLatencyIncreaseBlocks,
      latencyRecoveryBlocks,
      maxLatencyDecreaseBlocks,
      minTransportLatencySamples,
      minTransportLatencyBlocks,
      ...windowOptions
    } = options;
    this.cooldownBlocksRemaining = 0;
    this.stableBlocks = 0;
    this.scheduler = scheduler;
    this.window = new LiveEffectRackChainCalibrationWindow(windowOptions);
    this.minSamples = boundedLiveEffectInteger(minSamples, LIVE_EFFECT_ADAPTIVE_LATENCY_MIN_SAMPLES, 1, 256);
    this.cooldownBlocks = boundedLiveEffectInteger(cooldownBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_COOLDOWN_BLOCKS, 0, 4096);
    this.maxLatencyIncreaseBlocks = boundedLiveEffectInteger(maxLatencyIncreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_STEP_BLOCKS, 1, 128);
    this.latencyRecoveryBlocks = boundedLiveEffectInteger(latencyRecoveryBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_RECOVERY_BLOCKS, 0, 4096);
    this.maxLatencyDecreaseBlocks = boundedLiveEffectInteger(maxLatencyDecreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_RECOVERY_STEP_BLOCKS, 1, 128);
    const maxBlockSize = boundedLiveEffectInteger(windowOptions.maxBlockSize, 128, 1, 8192);
    const minimumFromBlocks = minTransportLatencyBlocks === void 0
      ? void 0
      : boundedLiveEffectInteger(minTransportLatencyBlocks, 0, 0, 128) * maxBlockSize;
    this.minAdditionalTransportLatencySamples = boundedLiveEffectLatencySamples(
      minTransportLatencySamples ?? minimumFromBlocks ?? windowOptions.transportLatencySamples,
      0
    );
  }

  record(health) {
    if (this.cooldownBlocksRemaining > 0) {
      this.cooldownBlocksRemaining -= 1;
    }
    const snapshot = this.window.record(health);
    const currentTransportLatencySamples = boundedLiveEffectLatencySamples(
      this.scheduler.snapshot().transportLatencySamples,
      snapshot.calibration.policy.transportLatencySamples
    );
    const chainLatencySamples = boundedLiveEffectLatencySamples(health.latencySamples, 0);
    const maxBlockSize = snapshot.calibration.policy.maxBlockSize;
    const recommendedTotalLatencySamples = combinedLiveEffectLatencySamples(
      chainLatencySamples,
      snapshot.calibration.recommendedTransportLatencySamples
    );
    let targetTransportLatencySamples = Math.min(
      recommendedTotalLatencySamples,
      currentTransportLatencySamples + this.maxLatencyIncreaseBlocks * maxBlockSize
    );
    let applied = false;
    let appliedDirection = "none";
    if (this.shouldApply(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
      this.scheduler.updateLatency(targetTransportLatencySamples);
      this.scheduler.updateDeadlinePressureFromHealth(health, snapshot.calibration);
      applied = true;
      appliedDirection = "increase";
      this.cooldownBlocksRemaining = this.cooldownBlocks;
      this.stableBlocks = 0;
      this.window.reset();
    } else {
      this.scheduler.updateDeadlinePressureFromHealth(health, snapshot.calibration);
      this.recordStableBlock(snapshot);
      targetTransportLatencySamples = this.recoveryTarget(currentTransportLatencySamples, chainLatencySamples, maxBlockSize);
      if (this.shouldRecover(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
        this.scheduler.updateLatency(targetTransportLatencySamples);
        this.scheduler.updateDeadlinePressureFromHealth(health, snapshot.calibration);
        applied = true;
        appliedDirection = "decrease";
        this.cooldownBlocksRemaining = this.cooldownBlocks;
        this.stableBlocks = 0;
        this.window.reset();
      }
    }
    const deadlinePressure = this.scheduler.snapshot().deadlinePressure;
    return {
      ...snapshot,
      applied,
      appliedDirection,
      chainLatencySamples,
      currentTransportLatencySamples,
      targetTransportLatencySamples,
      cooldownBlocksRemaining: this.cooldownBlocksRemaining,
      stableBlocks: this.stableBlocks,
      recoveryBlocksRemaining: Math.max(0, this.latencyRecoveryBlocks - this.stableBlocks),
      deadlinePressure
    };
  }

  reset() {
    this.window.reset();
    this.cooldownBlocksRemaining = 0;
    this.stableBlocks = 0;
  }

  shouldApply(snapshot, targetTransportLatencySamples, currentTransportLatencySamples) {
    return (
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      targetTransportLatencySamples > currentTransportLatencySamples &&
      snapshot.calibration.warnings.includes("increase-transport-latency")
    );
  }

  shouldRecover(snapshot, targetTransportLatencySamples, currentTransportLatencySamples) {
    return (
      this.latencyRecoveryBlocks > 0 &&
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      this.stableBlocks >= this.latencyRecoveryBlocks &&
      targetTransportLatencySamples < currentTransportLatencySamples &&
      snapshot.calibration.warnings.length === 0
    );
  }

  recordStableBlock(snapshot) {
    if (snapshot.samples >= this.minSamples && snapshot.calibration.warnings.length === 0) {
      this.stableBlocks = Math.min(4096, this.stableBlocks + 1);
      return;
    }
    if (snapshot.calibration.warnings.length > 0) {
      this.stableBlocks = 0;
    }
  }

  recoveryTarget(currentTransportLatencySamples, chainLatencySamples, maxBlockSize) {
    const maxDecreaseStepSamples = this.maxLatencyDecreaseBlocks * maxBlockSize;
    return Math.max(
      combinedLiveEffectLatencySamples(chainLatencySamples, this.minAdditionalTransportLatencySamples),
      currentTransportLatencySamples - maxDecreaseStepSamples
    );
  }
}

export class LiveEffectRackFrameBatchSchedulerAdaptiveLatencyController {
  constructor(options) {
    const {
      scheduler,
      minSamples,
      cooldownBlocks,
      maxLatencyIncreaseBlocks,
      latencyRecoveryBlocks,
      maxLatencyDecreaseBlocks,
      minTransportLatencySamples,
      minTransportLatencyBlocks,
      ...windowOptions
    } = options;
    this.cooldownBlocksRemaining = 0;
    this.stableBlocks = 0;
    this.scheduler = scheduler;
    this.window = new LiveEffectRackFrameBatchCalibrationWindow(windowOptions);
    this.minSamples = boundedLiveEffectInteger(minSamples, LIVE_EFFECT_ADAPTIVE_LATENCY_MIN_SAMPLES, 1, 256);
    this.cooldownBlocks = boundedLiveEffectInteger(cooldownBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_COOLDOWN_BLOCKS, 0, 4096);
    this.maxLatencyIncreaseBlocks = boundedLiveEffectInteger(maxLatencyIncreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_STEP_BLOCKS, 1, 128);
    this.latencyRecoveryBlocks = boundedLiveEffectInteger(latencyRecoveryBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_RECOVERY_BLOCKS, 0, 4096);
    this.maxLatencyDecreaseBlocks = boundedLiveEffectInteger(maxLatencyDecreaseBlocks, LIVE_EFFECT_ADAPTIVE_LATENCY_MAX_RECOVERY_STEP_BLOCKS, 1, 128);
    const maxBlockSize = boundedLiveEffectInteger(windowOptions.maxBlockSize, 128, 1, 8192);
    const minimumFromBlocks = minTransportLatencyBlocks === void 0
      ? void 0
      : boundedLiveEffectInteger(minTransportLatencyBlocks, 0, 0, 128) * maxBlockSize;
    this.minAdditionalTransportLatencySamples = boundedLiveEffectLatencySamples(
      minTransportLatencySamples ?? minimumFromBlocks ?? windowOptions.transportLatencySamples,
      0
    );
  }

  record(health) {
    if (this.cooldownBlocksRemaining > 0) {
      this.cooldownBlocksRemaining -= 1;
    }
    const snapshot = this.window.record(health);
    const currentTransportLatencySamples = boundedLiveEffectLatencySamples(
      this.scheduler.snapshot().transportLatencySamples,
      snapshot.calibration.policy.transportLatencySamples
    );
    const batchLatencySamples = liveEffectFrameBatchLatencySamples(health);
    const maxBlockSize = snapshot.calibration.policy.maxBlockSize;
    const recommendedTotalLatencySamples = combinedLiveEffectLatencySamples(
      batchLatencySamples,
      snapshot.calibration.recommendedTransportLatencySamples
    );
    let targetTransportLatencySamples = Math.min(
      recommendedTotalLatencySamples,
      currentTransportLatencySamples + this.maxLatencyIncreaseBlocks * maxBlockSize
    );
    let applied = false;
    let appliedDirection = "none";
    if (this.shouldApply(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
      this.scheduler.updateLatency(targetTransportLatencySamples);
      this.scheduler.updateDeadlinePressureFromHealth(health, snapshot.calibration);
      applied = true;
      appliedDirection = "increase";
      this.cooldownBlocksRemaining = this.cooldownBlocks;
      this.stableBlocks = 0;
      this.window.reset();
    } else {
      this.scheduler.updateDeadlinePressureFromHealth(health, snapshot.calibration);
      this.recordStableBlock(snapshot);
      targetTransportLatencySamples = this.recoveryTarget(currentTransportLatencySamples, batchLatencySamples, maxBlockSize);
      if (this.shouldRecover(snapshot, targetTransportLatencySamples, currentTransportLatencySamples)) {
        this.scheduler.updateLatency(targetTransportLatencySamples);
        this.scheduler.updateDeadlinePressureFromHealth(health, snapshot.calibration);
        applied = true;
        appliedDirection = "decrease";
        this.cooldownBlocksRemaining = this.cooldownBlocks;
        this.stableBlocks = 0;
        this.window.reset();
      }
    }
    const deadlinePressure = this.scheduler.snapshot().deadlinePressure;
    return {
      ...snapshot,
      applied,
      appliedDirection,
      batchLatencySamples,
      currentTransportLatencySamples,
      targetTransportLatencySamples,
      cooldownBlocksRemaining: this.cooldownBlocksRemaining,
      stableBlocks: this.stableBlocks,
      recoveryBlocksRemaining: Math.max(0, this.latencyRecoveryBlocks - this.stableBlocks),
      deadlinePressure
    };
  }

  reset() {
    this.window.reset();
    this.cooldownBlocksRemaining = 0;
    this.stableBlocks = 0;
  }

  shouldApply(snapshot, targetTransportLatencySamples, currentTransportLatencySamples) {
    return (
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      targetTransportLatencySamples > currentTransportLatencySamples &&
      snapshot.calibration.warnings.includes("increase-transport-latency")
    );
  }

  shouldRecover(snapshot, targetTransportLatencySamples, currentTransportLatencySamples) {
    return (
      this.latencyRecoveryBlocks > 0 &&
      snapshot.samples >= this.minSamples &&
      this.cooldownBlocksRemaining === 0 &&
      this.stableBlocks >= this.latencyRecoveryBlocks &&
      targetTransportLatencySamples < currentTransportLatencySamples &&
      snapshot.calibration.warnings.length === 0
    );
  }

  recordStableBlock(snapshot) {
    if (snapshot.samples >= this.minSamples && snapshot.calibration.warnings.length === 0) {
      this.stableBlocks = Math.min(4096, this.stableBlocks + 1);
      return;
    }
    if (snapshot.calibration.warnings.length > 0) {
      this.stableBlocks = 0;
    }
  }

  recoveryTarget(currentTransportLatencySamples, batchLatencySamples, maxBlockSize) {
    const maxDecreaseStepSamples = this.maxLatencyDecreaseBlocks * maxBlockSize;
    return Math.max(
      combinedLiveEffectLatencySamples(batchLatencySamples, this.minAdditionalTransportLatencySamples),
      currentTransportLatencySamples - maxDecreaseStepSamples
    );
  }
}

export function createLiveEffectRackAdaptiveLatencyController(options) {
  return new LiveEffectRackAdaptiveLatencyController(options);
}

export function createLiveEffectRackSchedulerAdaptiveLatencyController(options) {
  return new LiveEffectRackSchedulerAdaptiveLatencyController(options);
}

export function createLiveEffectRackChainSchedulerAdaptiveLatencyController(options) {
  return new LiveEffectRackChainSchedulerAdaptiveLatencyController(options);
}

export function createLiveEffectRackFrameBatchSchedulerAdaptiveLatencyController(options) {
  return new LiveEffectRackFrameBatchSchedulerAdaptiveLatencyController(options);
}

const LIVE_EFFECT_CHAIN_MAX_STAGES = 16;

export class LiveEffectRackChain extends EventTarget {
  constructor(options) {
    super();
    const maxStages = boundedLiveEffectInteger(options.maxStages, LIVE_EFFECT_CHAIN_MAX_STAGES, 0, LIVE_EFFECT_CHAIN_MAX_STAGES);
    const stages = Array.from(
      { length: boundedLiveEffectInteger(options.stages?.length, 0, 0, maxStages) },
      (_unused, index) => options.stages[index]
    ).filter((stage) => typeof stage?.processBlock === "function");
    this.stages = stages.slice(0, maxStages);
    this.maxBlockSize = boundedLiveEffectInteger(options.maxBlockSize, 128, 1, 8192);
    this.processBudgetMs = boundedLiveEffectNumber(options.processBudgetMs, 0, 0, 60000);
    this.processTimeoutMs = boundedLiveEffectNumber(options.processTimeoutMs, 0, 0, 60000);
    this.maxConsecutiveProcessBudgetMisses = boundedLiveEffectInteger(options.maxConsecutiveProcessBudgetMisses, 0, 0, 1024);
    this.processBudgetRecoveryBlocks = boundedLiveEffectInteger(options.processBudgetRecoveryBlocks, 0, 0, 4096);
    this.processTimeoutRecoveryBlocks = boundedLiveEffectInteger(options.processTimeoutRecoveryBlocks, 0, 0, 4096);
    this.maxProcessTimeoutRecoveries = boundedLiveEffectInteger(options.maxProcessTimeoutRecoveries, 32, 0, 32);
    this.transitionFadeSamples = boundedLiveEffectInteger(options.transitionFadeSamples, 0, 0, 4096);
    this.outputChannels = options.outputChannels === void 0
      ? void 0
      : boundedLiveEffectInteger(options.outputChannels, 2, 1, 32);
    this.nowMs = typeof options.nowMs === "function" ? options.nowMs : liveEffectNowMs;
    this.bypassed = options.bypassed === true;
    this.wetMix = boundedLiveEffectWetMix(options.wetMix, 1);
    this.sampleRate = boundedLiveEffectInteger(options.sampleRate, 48000, 1, 384000);
    this.latencySamples = 0;
    this.tailSamples = 0;
    this.infiniteTail = false;
    this.stageHealthy = true;
    this.lastProcessedStages = 0;
    this.lastFailedStageIndex = void 0;
    this.lastStageResults = [];
    this.lastStageError = void 0;
    this.lastDryReason = void 0;
    this.dryOutputBlocks = 0;
    this.bypassDryOutputBlocks = 0;
    this.processBudgetMisses = 0;
    this.recoveryDryBlocks = 0;
    this.timeoutRecoveryDryBlocks = 0;
    this.processTimeoutRecoveryAttempts = 0;
    this.processTimeoutRecoveryExhaustedEmitted = false;
    this.lastError = void 0;
    this.unhealthyReason = void 0;
    this.lastProcessDurationMs = void 0;
    this.lastProcessBudgetMs = void 0;
    this.lastProcessBudgetExceeded = false;
    this.lastProcessTimedOut = false;
    this.lastResponseDeadlineLeadMs = void 0;
    this.lastResponseDeadlineLeadBlocks = void 0;
    this.responseDeadlineLeadMinBlocks = void 0;
    this.responseDeadlineLeadMaxBlocks = void 0;
    this.responseJitterBlocks = 0;
    this.responseDeadlineMisses = 0;
    this.lastOutputPath = void 0;
    this.lastOutputTail = void 0;
  }

  get health() {
    return {
      bypassed: this.bypassed,
      wetMix: this.wetMix,
      sampleRate: this.sampleRate,
      latencySamples: this.latencySamples,
      latencyMs: liveEffectLatencyMilliseconds(this.latencySamples, this.sampleRate),
      tailSamples: this.tailSamples,
      tailMs: liveEffectLatencyMilliseconds(this.tailSamples, this.sampleRate),
      infiniteTail: this.infiniteTail,
      healthy: this.chainHealthy(),
      stageHealthy: this.stageHealthy,
      stageCount: this.stages.length,
      processedStages: this.lastProcessedStages,
      failedStageIndex: this.lastFailedStageIndex,
      stageResults: this.lastStageResults.slice(),
      lastStageError: this.lastStageError,
      lastDryReason: this.lastDryReason,
      dryOutputBlocks: this.dryOutputBlocks,
      bypassDryOutputBlocks: this.bypassDryOutputBlocks,
      processBudgetMs: this.processBudgetMs,
      processTimeoutMs: this.processTimeoutMs,
      maxConsecutiveProcessBudgetMisses: this.maxConsecutiveProcessBudgetMisses,
      processBudgetRecoveryBlocks: this.processBudgetRecoveryBlocks,
      processTimeoutRecoveryBlocks: this.processTimeoutRecoveryBlocks,
      maxProcessTimeoutRecoveries: this.maxProcessTimeoutRecoveries,
      transitionFadeSamples: this.transitionFadeSamples,
      processBudgetMisses: this.processBudgetMisses,
      lastProcessDurationMs: this.lastProcessDurationMs,
      lastProcessBudgetMs: this.lastProcessBudgetMs,
      processBudgetExceeded: this.lastProcessBudgetExceeded,
      processTimedOut: this.lastProcessTimedOut,
      lastResponseDeadlineLeadMs: this.lastResponseDeadlineLeadMs,
      lastResponseDeadlineLeadBlocks: this.lastResponseDeadlineLeadBlocks,
      responseJitterBlocks: this.responseJitterBlocks,
      responseDeadlineMisses: this.responseDeadlineMisses,
      processBudgetTripped: this.unhealthyReason === "process-budget-exceeded",
      processTimeoutTripped: this.unhealthyReason === "process-timeout",
      recoveryDryBlocks: this.recoveryDryBlocks,
      timeoutRecoveryDryBlocks: this.timeoutRecoveryDryBlocks,
      recoveryDryBlocksRemaining: this.recoveryDryBlocksRemaining(),
      processTimeoutRecoveryAttempts: this.processTimeoutRecoveryAttempts,
      processTimeoutRecoveryExhausted: this.processTimeoutRecoveryExhausted(),
      unhealthyReason: this.unhealthyReason,
      lastError: this.lastError
    };
  }

  recoveryDryBlocksRemaining() {
    const timeout = this.unhealthyReason === "process-timeout" && !this.processTimeoutRecoveryExhausted();
    const target = this.unhealthyReason === "process-budget-exceeded"
      ? this.processBudgetRecoveryBlocks
      : timeout
        ? this.processTimeoutRecoveryBlocks
        : 0;
    const elapsed = timeout ? this.timeoutRecoveryDryBlocks : this.recoveryDryBlocks;
    return Math.max(0, target - elapsed);
  }

  get timing() {
    return liveEffectRackTiming(this.sampleRate, this.maxBlockSize, this.latencySamples, 0, this.latencySamples, this.processBudgetMs, this.processTimeoutMs, 0, this.transitionFadeSamples);
  }

  async processBlock(request, options = {}) {
    const processStartedAt = this.nowMs();
    const outputChannels = this.chainOutputChannels(request.channels);
    if (this.bypassed) {
      const response = this.chainDryResponse(request, "chain-bypass", outputChannels);
      this.maybeRecoverFromProcessBudget();
      this.maybeRecoverFromProcessTimeout();
      return response;
    }
    if (this.unhealthyReason !== void 0) {
      const reason = this.unhealthyReason === "process-timeout" ? "chain-process-timeout" : "chain-process-budget-exceeded";
      const response = this.chainDryResponse(request, reason, outputChannels, this.lastError, false);
      this.maybeRecoverFromProcessBudget();
      this.maybeRecoverFromProcessTimeout();
      return response;
    }
    if (this.stages.length === 0) {
      return this.chainDryResponse(request, "chain-empty", outputChannels);
    }
    const chainWetMix = boundedLiveEffectWetMix(options.wetMix, this.wetMix);
    let channels = boundedLiveEffectChannels(request.channels, outputChannels, this.maxBlockSize);
    let latencySamples = 0;
    let tailSamples = 0;
    let infiniteTail = false;
    const stageResults = [];
    for (let index = 0; index < this.stages.length; index += 1) {
      const stage = this.stages[index];
      const stageStartedAt = this.nowMs();
      try {
        const timeoutMs = this.remainingProcessTimeoutMs(processStartedAt);
        if (timeoutMs === 0) {
          const error = new Error("chain_process_timeout");
          return this.chainProcessTimeoutResponse(
            request,
            outputChannels,
            processStartedAt,
            error,
            stageResults.concat(liveEffectChainStageErrorResult(index, stage, error, this.nowMs() - stageStartedAt)),
            index
          );
        }
        const response = await withLiveEffectTimeout(stage.processBlock({
          ...request,
          channels,
          wetMix: liveEffectChainStageWetMix(options.stageWetMixes, index, request.wetMix)
        }), timeoutMs ?? 0);
        const stageDurationMs = this.nowMs() - stageStartedAt;
        if (this.processTimedOut(processStartedAt)) {
          const error = new Error("chain_process_timeout");
          return this.chainProcessTimeoutResponse(
            request,
            outputChannels,
            processStartedAt,
            error,
            stageResults.concat(liveEffectChainStageErrorResult(index, stage, error, stageDurationMs)),
            index
          );
        }
        channels = boundedLiveEffectChannels(response.channels, outputChannels, this.maxBlockSize);
        latencySamples = boundedLiveEffectLatencySamples(
          latencySamples + boundedLiveEffectLatencySamples(response.latencySamples, 0),
          latencySamples
        );
        tailSamples = boundedLiveEffectLatencySamples(
          tailSamples + boundedLiveEffectLatencySamples(response.tailSamples, 0),
          tailSamples
        );
        infiniteTail = infiniteTail || response.infiniteTail === true;
        stageResults.push(liveEffectChainStageResult(index, stage, response, stageDurationMs));
      } catch (error) {
        if (liveEffectChainTimeoutError(error)) {
          return this.chainProcessTimeoutResponse(
            request,
            outputChannels,
            processStartedAt,
            error,
            stageResults.concat(liveEffectChainStageErrorResult(index, stage, error, this.nowMs() - stageStartedAt)),
            index
          );
        }
        stageResults.push(liveEffectChainStageErrorResult(index, stage, error, this.nowMs() - stageStartedAt));
        return this.finishChainResponse({
          blockId: request.blockId,
          channels,
          latencySamples,
          tailSamples,
          infiniteTail,
          renderEngine: "chain-stage-error",
          bypassed: stageResults.every((stage) => stage.bypassed),
          healthy: false,
          error,
          stageCount: this.stages.length,
          processedStages: stageResults.length,
          failedStageIndex: index,
          stageResults
        }, processStartedAt, request, outputChannels, chainWetMix);
      }
    }
    return this.finishChainResponse({
      blockId: request.blockId,
      channels,
      latencySamples,
      tailSamples,
      infiniteTail,
      renderEngine: "live-effect-rack-chain",
      bypassed: stageResults.length === 0 || stageResults.every((stage) => stage.bypassed),
      healthy: stageResults.every((stage) => stage.healthy),
      stageCount: this.stages.length,
      processedStages: stageResults.length,
      stageResults
    }, processStartedAt, request, outputChannels, chainWetMix);
  }

  processScheduledBlock(scheduled, options = {}) {
    if (scheduled.stale) {
      return Promise.resolve(this.chainDryResponse(
        scheduled.request,
        "chain-stale-input",
        this.chainOutputChannels(scheduled.request.channels)
      ));
    }
    if (shouldSkipLiveEffectDeadlinePressure(scheduled.deadlinePressure, options)) {
      return Promise.resolve(this.chainDryResponse(
        scheduled.request,
        "chain-deadline-pressure",
        this.chainOutputChannels(scheduled.request.channels),
        void 0,
        true,
        scheduled.deadlinePressure
      ));
    }
    return this.processBlock(scheduled.request, options);
  }

  setBypassed(bypassed) {
    if (this.bypassed === bypassed) {
      return;
    }
    this.bypassed = bypassed;
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  setWetMix(wetMix) {
    const bounded = boundedLiveEffectWetMix(wetMix, this.wetMix);
    if (bounded === this.wetMix) {
      return;
    }
    this.wetMix = bounded;
    this.dispatchEvent(new CustomEvent("wetmixchange", { detail: this.health }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  setTimingPolicy(options) {
    const previous = { processBudgetMs: this.processBudgetMs, processTimeoutMs: this.processTimeoutMs, transitionFadeSamples: this.transitionFadeSamples };
    this.processBudgetMs = boundedLiveEffectNumber(options.processBudgetMs, this.processBudgetMs, 0, 60000);
    this.processTimeoutMs = boundedLiveEffectNumber(options.processTimeoutMs, this.processTimeoutMs, 0, 60000);
    this.transitionFadeSamples = boundedLiveEffectInteger(options.transitionFadeSamples, this.transitionFadeSamples, 0, 4096);
    const changed = this.processBudgetMs !== previous.processBudgetMs || this.processTimeoutMs !== previous.processTimeoutMs || this.transitionFadeSamples !== previous.transitionFadeSamples;
    if (changed) {
      const health = this.health;
      this.dispatchEvent(new CustomEvent("timingpolicychange", { detail: { previous, health } }));
      this.dispatchEvent(new CustomEvent("healthchange", { detail: health }));
    }
    return this.health;
  }

  retry() {
    if (this.unhealthyReason === void 0) {
      return false;
    }
    this.lastError = void 0;
    this.unhealthyReason = void 0;
    this.processBudgetMisses = 0;
    this.recoveryDryBlocks = 0;
    this.timeoutRecoveryDryBlocks = 0;
    this.processTimeoutRecoveryAttempts = 0;
    this.processTimeoutRecoveryExhaustedEmitted = false;
    this.lastProcessBudgetExceeded = false;
    this.lastProcessTimedOut = false;
    this.clearStageFailure();
    this.dispatchEvent(new CustomEvent("retry", { detail: { health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return true;
  }

  chainDryResponse(request, renderEngine, outputChannels, error, healthy = this.chainHealthy(), deadlinePressure) {
    const chainProcessBudgetTripped = this.unhealthyReason === "process-budget-exceeded";
    const response = this.finishOutputResponse({
      blockId: request.blockId,
      channels: dryLiveEffectChannels(request.channels, outputChannels, this.maxBlockSize),
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine,
      bypassed: true,
      healthy,
      error,
      stageCount: this.stages.length,
      processedStages: 0,
      stageResults: [],
      chainProcessDurationMs: this.unhealthyReason === "process-timeout" ? this.lastProcessDurationMs : 0,
      chainProcessBudgetMs: this.processBudgetMs > 0 ? this.processBudgetMs : void 0,
      chainProcessTimeoutMs: this.processTimeoutMs > 0 ? this.processTimeoutMs : void 0,
      chainProcessBudgetExceeded: chainProcessBudgetTripped,
      chainProcessTimedOut: this.unhealthyReason === "process-timeout",
      chainProcessBudgetMisses: this.processBudgetMisses,
      chainProcessBudgetTripped,
      chainUnhealthyReason: this.unhealthyReason,
      deadlinePressure
    }, outputChannels);
    return this.recordChainLatency(response, request);
  }

  chainOutputChannels(channels) {
    return this.outputChannels ?? boundedLiveEffectInteger(channels.length, 2, 1, 32);
  }

  finishChainResponse(response, processStartedAt, request, outputChannels, wetMix) {
    const previousMisses = this.processBudgetMisses;
    const previousUnhealthyReason = this.unhealthyReason;
    const durationMs = boundedLiveEffectOptionalNumber(this.nowMs() - processStartedAt, 0, 60000);
    const chainProcessBudgetExceeded = this.processBudgetMs > 0 && (durationMs ?? 0) > this.processBudgetMs;
    this.lastProcessDurationMs = durationMs;
    this.lastProcessBudgetMs = this.processBudgetMs > 0 ? this.processBudgetMs : void 0;
    this.recordResponseDeadlineLead(request.sampleRate);
    this.lastProcessBudgetExceeded = chainProcessBudgetExceeded;
    this.lastProcessTimedOut = false;
    this.processBudgetMisses = chainProcessBudgetExceeded ? Math.min(1024, this.processBudgetMisses + 1) : 0;
    const chainProcessBudgetTripped = response.healthy !== false && this.maxConsecutiveProcessBudgetMisses > 0 && this.processBudgetMisses >= this.maxConsecutiveProcessBudgetMisses;
    const error = chainProcessBudgetTripped ? response.error ?? new Error("chain_process_budget_exceeded") : response.error;
    if (chainProcessBudgetTripped) {
      this.lastError = error;
      this.unhealthyReason = "process-budget-exceeded";
      this.recoveryDryBlocks = 0;
      const finalResponse = this.recordChainLatency(this.finishOutputResponse({
        ...response,
        channels: dryLiveEffectChannels(request.channels, outputChannels, this.maxBlockSize),
        latencySamples: 0,
        tailSamples: 0,
        infiniteTail: false,
        renderEngine: "chain-process-budget-exceeded",
        bypassed: true,
        healthy: false,
        error,
        chainProcessDurationMs: durationMs,
        chainProcessBudgetMs: this.processBudgetMs > 0 ? this.processBudgetMs : void 0,
        chainProcessTimeoutMs: this.processTimeoutMs > 0 ? this.processTimeoutMs : void 0,
        chainProcessBudgetExceeded,
        chainProcessTimedOut: false,
        chainProcessBudgetMisses: this.processBudgetMisses,
        chainProcessBudgetTripped,
        chainUnhealthyReason: this.unhealthyReason
      }, outputChannels), request);
      this.recordStageHealth(finalResponse);
      this.dispatchChainPressureEvents(finalResponse, previousMisses, previousUnhealthyReason);
      return finalResponse;
    }
    const finalResponse = this.recordChainLatency(this.finishOutputResponse({
      ...response,
      channels: wetMixedLiveEffectChannels(response.channels, request.channels, outputChannels, wetMix, this.maxBlockSize),
      healthy: response.healthy !== false,
      error,
      chainProcessDurationMs: durationMs,
      chainProcessBudgetMs: this.processBudgetMs > 0 ? this.processBudgetMs : void 0,
      chainProcessTimeoutMs: this.processTimeoutMs > 0 ? this.processTimeoutMs : void 0,
      chainProcessBudgetExceeded,
      chainProcessTimedOut: false,
      chainProcessBudgetMisses: this.processBudgetMisses,
      chainProcessBudgetTripped,
      chainUnhealthyReason: this.unhealthyReason
    }, outputChannels), request);
    this.recordStageHealth(finalResponse);
    this.dispatchChainPressureEvents(finalResponse, previousMisses, previousUnhealthyReason);
    return finalResponse;
  }

  chainProcessTimeoutResponse(request, outputChannels, processStartedAt, error, stageResults = [], failedStageIndex) {
    this.lastProcessDurationMs = Math.max(this.processTimeoutMs, boundedLiveEffectOptionalNumber(this.nowMs() - processStartedAt, 0, 60000) ?? 0);
    this.lastProcessBudgetMs = this.processBudgetMs > 0 ? this.processBudgetMs : void 0;
    this.lastProcessBudgetExceeded = false;
    this.lastProcessTimedOut = true;
    this.lastError = error;
    this.unhealthyReason = "process-timeout";
    this.timeoutRecoveryDryBlocks = 0;
    this.processTimeoutRecoveryExhaustedEmitted = false;
    this.recordResponseDeadlineLead(request.sampleRate);
    const rawResponse = {
      blockId: request.blockId,
      channels: dryLiveEffectChannels(request.channels, outputChannels, this.maxBlockSize),
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine: "chain-process-timeout",
      bypassed: true,
      healthy: false,
      error,
      stageCount: this.stages.length,
      processedStages: stageResults.length,
      failedStageIndex,
      stageResults,
      chainProcessDurationMs: this.lastProcessDurationMs,
      chainProcessBudgetMs: this.processBudgetMs > 0 ? this.processBudgetMs : void 0,
      chainProcessTimeoutMs: this.processTimeoutMs > 0 ? this.processTimeoutMs : void 0,
      chainProcessBudgetExceeded: false,
      chainProcessTimedOut: true,
      chainProcessBudgetMisses: this.processBudgetMisses,
      chainProcessBudgetTripped: false,
      chainUnhealthyReason: this.unhealthyReason
    };
    this.recordStageHealth(rawResponse);
    const response = this.recordChainLatency(this.finishOutputResponse(rawResponse, outputChannels), request);
    this.recordStageHealth(response);
    this.dispatchEvent(new CustomEvent("chain-process-timeout", { detail: { response, health: this.health } }));
    this.dispatchEvent(new CustomEvent("chain-process-timeout-tripped", { detail: { response, health: this.health } }));
    this.dispatchProcessTimeoutRecoveryExhaustedIfNeeded(response);
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return response;
  }

  finishOutputResponse(response, outputChannels) {
    const outputPath = response.bypassed ? "dry" : "wet";
    const lastDryReason = liveEffectChainDryReason(response);
    if (lastDryReason !== void 0) {
      this.dryOutputBlocks = Math.min(Number.MAX_SAFE_INTEGER, this.dryOutputBlocks + 1);
      if (isIntentionalLiveEffectChainBypassResponse(response)) this.bypassDryOutputBlocks = Math.min(Number.MAX_SAFE_INTEGER, this.bypassDryOutputBlocks + 1);
    }
    this.recordDryReason(lastDryReason);
    const normalized = boundedLiveEffectChannels(response.channels, outputChannels, this.maxBlockSize);
    const channels = transitionLiveEffectOutputChannels(normalized, this.lastOutputTail, this.lastOutputPath, outputPath, this.transitionFadeSamples);
    this.lastOutputTail = liveEffectOutputTail(channels, outputChannels);
    this.lastOutputPath = outputPath;
    const finalResponse = channels === response.channels ? response : { ...response, channels };
    if (lastDryReason !== void 0) {
      this.dispatchEvent(new CustomEvent("dry-output", { detail: { response: finalResponse, health: this.health, reason: lastDryReason, deadlinePressure: finalResponse.deadlinePressure } }));
    }
    return finalResponse;
  }

  recordDryReason(lastDryReason) {
    if (lastDryReason === this.lastDryReason) {
      return;
    }
    this.lastDryReason = lastDryReason;
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  recordChainLatency(response, request) {
    const sampleRate = boundedLiveEffectInteger(request.sampleRate, this.sampleRate, 1, 384000);
    const latencySamples = boundedLiveEffectLatencySamples(response.latencySamples, this.latencySamples);
    const tailSamples = boundedLiveEffectLatencySamples(response.tailSamples, this.tailSamples);
    const infiniteTail = response.infiniteTail === true;
    if (sampleRate === this.sampleRate && latencySamples === this.latencySamples && tailSamples === this.tailSamples && infiniteTail === this.infiniteTail) {
      return response;
    }
    this.sampleRate = sampleRate;
    this.latencySamples = latencySamples;
    this.tailSamples = tailSamples;
    this.infiniteTail = infiniteTail;
    this.dispatchEvent(new CustomEvent("latencychange", { detail: this.health }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return response;
  }

  recordStageHealth(response) {
    if (response.stageResults.length === 0 && response.failedStageIndex === void 0 && this.stages.length > 0) {
      return;
    }
    const stageHealthy = response.stageResults.every((stage) => stage.healthy !== false);
    const processedStages = boundedLiveEffectInteger(response.processedStages, 0, 0, this.stages.length);
    const failedStageIndex = liveEffectChainFailedStageIndex(response.failedStageIndex, this.stages.length);
    const lastStageError = stageHealthy ? void 0 : response.error ?? response.stageResults.find((stage) => stage.healthy === false)?.error;
    const changed = stageHealthy !== this.stageHealthy || failedStageIndex !== this.lastFailedStageIndex || lastStageError !== this.lastStageError;
    this.stageHealthy = stageHealthy;
    this.lastProcessedStages = processedStages;
    this.lastFailedStageIndex = failedStageIndex;
    this.lastStageResults = response.stageResults.slice();
    this.lastStageError = lastStageError;
    if (changed) {
      this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    }
  }

  chainHealthy() {
    return this.unhealthyReason === void 0 && this.stageHealthy;
  }

  recordResponseDeadlineLead(sampleRate) {
    if (!this.lastProcessBudgetMs || this.lastProcessDurationMs === void 0) {
      return;
    }
    const boundedSampleRate = boundedLiveEffectInteger(sampleRate, this.sampleRate, 1, 384000);
    const blockDurationMs = this.maxBlockSize / boundedSampleRate * 1000;
    this.lastResponseDeadlineLeadMs = boundedLiveEffectOptionalNumber(this.lastProcessBudgetMs - this.lastProcessDurationMs, -60000, 60000);
    this.lastResponseDeadlineLeadBlocks = this.lastResponseDeadlineLeadMs === void 0 || blockDurationMs <= 0
      ? void 0
      : Number((this.lastResponseDeadlineLeadMs / blockDurationMs).toFixed(3));
    this.responseDeadlineLeadMinBlocks = Math.min(
      this.responseDeadlineLeadMinBlocks ?? this.lastResponseDeadlineLeadBlocks ?? 0,
      this.lastResponseDeadlineLeadBlocks ?? 0
    );
    this.responseDeadlineLeadMaxBlocks = Math.max(
      this.responseDeadlineLeadMaxBlocks ?? this.lastResponseDeadlineLeadBlocks ?? 0,
      this.lastResponseDeadlineLeadBlocks ?? 0
    );
    this.responseJitterBlocks = Number(((this.responseDeadlineLeadMaxBlocks ?? 0) - (this.responseDeadlineLeadMinBlocks ?? 0)).toFixed(3));
    if ((this.lastResponseDeadlineLeadMs ?? 0) < 0) {
      this.responseDeadlineMisses = Math.min(1024, this.responseDeadlineMisses + 1);
      this.dispatchEvent(new CustomEvent("chain-response-deadline-missed", { detail: { durationMs: this.lastProcessDurationMs, budgetMs: this.lastProcessBudgetMs, leadMs: this.lastResponseDeadlineLeadMs, leadBlocks: this.lastResponseDeadlineLeadBlocks, health: this.health } }));
    }
  }

  remainingProcessTimeoutMs(processStartedAt) {
    if (this.processTimeoutMs <= 0) return void 0;
    const remaining = this.processTimeoutMs - (this.nowMs() - processStartedAt);
    return remaining <= 0 ? 0 : remaining;
  }

  processTimedOut(processStartedAt) {
    return this.processTimeoutMs > 0 && this.nowMs() - processStartedAt > this.processTimeoutMs;
  }

  dispatchChainPressureEvents(response, previousMisses, previousUnhealthyReason) {
    const health = this.health;
    if (response.chainProcessBudgetExceeded) {
      this.dispatchEvent(new CustomEvent("chain-process-budget-exceeded", { detail: { response, health } }));
    }
    if (response.chainProcessBudgetTripped) {
      this.dispatchEvent(new CustomEvent("chain-process-budget-tripped", { detail: { response, health } }));
    }
    if (previousMisses !== this.processBudgetMisses || previousUnhealthyReason !== this.unhealthyReason || response.chainProcessBudgetExceeded) {
      this.dispatchEvent(new CustomEvent("healthchange", { detail: health }));
    }
  }

  maybeRecoverFromProcessBudget() {
    if (this.unhealthyReason !== "process-budget-exceeded" || this.processBudgetRecoveryBlocks <= 0) {
      return;
    }
    this.recoveryDryBlocks = Math.min(4096, this.recoveryDryBlocks + 1);
    if (this.recoveryDryBlocks < this.processBudgetRecoveryBlocks) {
      return;
    }
    this.lastError = void 0;
    this.unhealthyReason = void 0;
    this.recoveryDryBlocks = 0;
    this.processBudgetMisses = 0;
    this.lastProcessBudgetExceeded = false;
    this.dispatchEvent(new CustomEvent("chain-process-budget-recovered", { detail: { health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  maybeRecoverFromProcessTimeout() {
    if (this.unhealthyReason !== "process-timeout") {
      return;
    }
    if (this.processTimeoutRecoveryExhausted()) {
      this.dispatchProcessTimeoutRecoveryExhaustedIfNeeded();
      return;
    }
    this.timeoutRecoveryDryBlocks = Math.min(4096, this.timeoutRecoveryDryBlocks + 1);
    if (this.timeoutRecoveryDryBlocks < this.processTimeoutRecoveryBlocks) {
      return;
    }
    this.processTimeoutRecoveryAttempts = Math.min(32, this.processTimeoutRecoveryAttempts + 1);
    this.lastError = void 0;
    this.unhealthyReason = void 0;
    this.timeoutRecoveryDryBlocks = 0;
    this.lastProcessTimedOut = false;
    this.clearStageFailure();
    this.dispatchEvent(new CustomEvent("chain-process-timeout-recovered", { detail: { health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  clearStageFailure() {
    this.stageHealthy = true;
    this.lastProcessedStages = 0;
    this.lastFailedStageIndex = void 0;
    this.lastStageResults = [];
    this.lastStageError = void 0;
  }

  processTimeoutRecoveryExhausted() {
    return this.unhealthyReason === "process-timeout" && (this.processTimeoutRecoveryBlocks <= 0 || this.maxProcessTimeoutRecoveries <= 0 || this.processTimeoutRecoveryAttempts >= this.maxProcessTimeoutRecoveries);
  }

  dispatchProcessTimeoutRecoveryExhaustedIfNeeded(response) {
    if (!this.processTimeoutRecoveryExhausted() || this.processTimeoutRecoveryExhaustedEmitted) {
      return;
    }
    this.processTimeoutRecoveryExhaustedEmitted = true;
    this.dispatchEvent(new CustomEvent("chain-process-timeout-recovery-exhausted", { detail: { response, health: this.health } }));
  }
}

export function createLiveEffectRackChain(options) {
  return new LiveEffectRackChain(options);
}

export function createLivePerformanceRackChainOptions(options) {
  const { processBudgetBlocks, processTimeoutBlocks, transitionFadeBlocks, ...chainOptions } = options;
  const sampleRate = boundedLiveEffectInteger(options.sampleRate, 48000, 1, 384000);
  const maxBlockSize = boundedLiveEffectInteger(options.maxBlockSize, 128, 1, 8192);
  const policy = createLiveEffectRackPolicy({
    ...options,
    sampleRate,
    maxBlockSize,
    processBudgetBlocks,
    processTimeoutBlocks,
    transitionFadeBlocks
  });
  return {
    ...chainOptions,
    sampleRate: policy.sampleRate,
    maxBlockSize: policy.maxBlockSize,
    processBudgetMs: policy.processBudgetMs,
    processTimeoutMs: policy.processTimeoutMs,
    maxConsecutiveProcessBudgetMisses: policy.maxConsecutiveProcessBudgetMisses,
    processBudgetRecoveryBlocks: policy.processBudgetRecoveryBlocks,
    processTimeoutRecoveryBlocks: policy.processTimeoutRecoveryBlocks,
    maxProcessTimeoutRecoveries: policy.maxProcessTimeoutRecoveries,
    transitionFadeSamples: policy.transitionFadeSamples
  };
}

export function createLivePerformanceRackChain(options) {
  return createLiveEffectRackChain(createLivePerformanceRackChainOptions(options));
}

function liveEffectChainStageWetMix(stageWetMixes, index, fallback) {
  return stageWetMixes && index < stageWetMixes.length ? Number(stageWetMixes[index]) : fallback;
}

function liveEffectChainFailedStageIndex(value, stageCount) {
  const bounded = boundedLiveEffectOptionalNumber(value, 0, Math.max(0, stageCount - 1));
  return bounded === void 0 ? void 0 : Math.floor(bounded);
}

function liveEffectChainDryReason(response) {
  if (response.renderEngine === "chain-bypass" || response.renderEngine === "chain-deadline-pressure" || response.renderEngine === "chain-empty" || response.renderEngine === "chain-process-budget-exceeded" || response.renderEngine === "chain-process-timeout" || response.renderEngine === "chain-stage-error" || response.renderEngine === "chain-stale-input") {
    return response.renderEngine;
  }
  if (response.stageResults.length > 0 && response.stageResults.every((stage) => stage.bypassed)) {
    return "chain-stage-bypass";
  }
  return response.bypassed ? "chain-bypass" : void 0;
}

function isIntentionalLiveEffectChainBypassResponse(response) {
  return response.renderEngine === "chain-bypass" || response.stageResults.length > 0 && response.stageResults.every((stage) => stage.bypassed && stage.healthy !== false && stage.error === void 0 && (stage.renderEngine === "dry-bypass" || stage.lastDryReason === "bypass"));
}

function liveEffectChainStageResult(index, stage, response, durationMs) {
  return {
    index,
    bypassed: response.bypassed === true,
    healthy: response.healthy !== false,
    instanceId: stage.health?.instanceId,
    renderEngine: typeof response.renderEngine === "string" ? response.renderEngine : void 0,
    lastDryReason: typeof stage.health?.lastDryReason === "string" ? stage.health.lastDryReason : void 0,
    durationMs: boundedLiveEffectOptionalNumber(durationMs, 0, 60000),
    error: response.error
  };
}

function liveEffectChainStageErrorResult(index, stage, error, durationMs) {
  return {
    index,
    bypassed: true,
    healthy: false,
    instanceId: stage.health?.instanceId,
    lastDryReason: typeof stage.health?.lastDryReason === "string" ? stage.health.lastDryReason : void 0,
    durationMs: boundedLiveEffectOptionalNumber(durationMs, 0, 60000),
    error
  };
}

function liveEffectChainTimeoutError(error) {
  return error instanceof Error && error.name === "SoundBridgeLiveEffectTimeout";
}

const LIVE_EFFECT_SCHEDULER_MAX_BLOCK_ID = 9_007_199_254_740_991;
const LIVE_EFFECT_SCHEDULER_MAX_SAMPLE_POSITION = 9_007_199_254_740_991;
const LIVE_EFFECT_SCHEDULER_DEADLINE_LEAD_TARGET_BLOCKS = 1;

export function liveEffectRackDeadlinePressureReason(reason) {
  return reason === "deadline-miss" ||
    reason === "dry-output-pressure" ||
    reason === "increase-transport-latency" ||
    reason === "increase-process-budget" ||
    reason === "increase-process-timeout" ||
    reason === "low-deadline-lead" ||
    reason === "process-over-budget" ||
    reason === "process-timeout" ||
    reason === "response-jitter"
    ? reason
    : void 0;
}

export function normalizeLiveEffectRackDeadlinePressureReasons(reasons) {
  if (reasons === void 0 || reasons === null) return void 0;
  const normalized = [];
  const length = boundedLiveEffectInteger(reasons.length, 0, 0, 16);
  for (let index = 0; index < length; index += 1) {
    const reason = liveEffectRackDeadlinePressureReason(reasons[index]);
    if (reason !== void 0 && !normalized.includes(reason)) normalized.push(reason);
  }
  return normalized;
}

export class LiveEffectRackBlockScheduler {
  constructor(options) {
    this.sampleRate = boundedLiveEffectInteger(options.sampleRate, 48000, 1, 384000);
    this.maxBlockSize = boundedLiveEffectInteger(options.maxBlockSize, 128, 1, 8192);
    this.nextBlockId = boundedLiveEffectInteger(options.startBlockId, 0, 0, LIVE_EFFECT_SCHEDULER_MAX_BLOCK_ID);
    this.nextSamplePosition = optionalLiveEffectSchedulerInteger(options.startSamplePosition, 0, LIVE_EFFECT_SCHEDULER_MAX_SAMPLE_POSITION);
    this.transportLatencySamples = boundedLiveEffectLatencySamples(options.transportLatencySamples, 0);
    this.maxInputAgeMs = boundedLiveEffectNumber(options.maxInputAgeMs, 0, 0, 60000);
    this.compensateOutputLatency = options.compensateOutputLatency !== false;
    this.deadlineLeadTargetBlocks = boundedLiveEffectNumber(
      options.deadlineLeadTargetBlocks,
      LIVE_EFFECT_SCHEDULER_DEADLINE_LEAD_TARGET_BLOCKS,
      0,
      64
    );
    this.responseJitterThresholdBlocks = boundedLiveEffectNumber(options.responseJitterThresholdBlocks, 0, 0, 64);
    this.nowMs = typeof options.nowMs === "function" ? options.nowMs : liveEffectNowMs;
    this.baseTransport = { ...options.transport };
    this.responseJitterBlocks = 0;
    this.responseDeadlineMisses = 0;
    this.responseDeadlineMissesSinceLastUpdate = 0;
    this.deadlinePressureWarnings = [];
  }

  schedule(channels, options = {}) {
    return this.scheduleFromFrame(this.captureFrame(options), channels, options);
  }

  captureFrame(options = {}) {
    const now = this.nowMs();
    const blockId = boundedLiveEffectInteger(options.blockId, this.nextBlockId, 0, LIVE_EFFECT_SCHEDULER_MAX_BLOCK_ID);
    const samplePosition = optionalLiveEffectSchedulerInteger(
      options.samplePosition ?? this.nextSamplePosition,
      0,
      LIVE_EFFECT_SCHEDULER_MAX_SAMPLE_POSITION
    );
    const timestamp = finiteLiveEffectSchedulerNumber(options.timestamp, now);
    const transportLatencySamples = boundedLiveEffectLatencySamples(options.transportLatencySamples, this.transportLatencySamples);
    const transport = options.transport ?? liveTransportForBlock({
      ...this.baseTransport,
      ...options.transportOptions,
      sampleRate: options.sampleRate ?? this.sampleRate,
      maxBlockSize: this.maxBlockSize,
      blockId,
      samplePosition,
      reportedLatencySamples: transportLatencySamples,
      compensateOutputLatency: this.compensateOutputLatency
    });
    this.advance(blockId, samplePosition);
    const captureAgeMs = Math.max(0, now - timestamp);
    return {
      blockId,
      samplePosition,
      timestamp,
      captureAgeMs,
      stale: this.maxInputAgeMs > 0 && captureAgeMs > this.maxInputAgeMs,
      deadlinePressure: this.deadlinePressureSnapshot(transportLatencySamples),
      transport
    };
  }

  scheduleFromFrame(frame, channels, options = {}) {
    const timestamp = finiteLiveEffectSchedulerNumber(options.timestamp, frame.timestamp);
    const captureAgeMs = options.timestamp === void 0 ? frame.captureAgeMs : Math.max(0, this.nowMs() - timestamp);
    const request = {
      blockId: frame.blockId,
      channels,
      inputBuses: options.inputBuses,
      sampleRate: options.sampleRate ?? this.sampleRate,
      transport: options.transport ?? frame.transport,
      timestamp,
      wetMix: options.wetMix
    };
    return {
      request,
      blockId: frame.blockId,
      samplePosition: frame.samplePosition,
      timestamp,
      captureAgeMs,
      stale: options.timestamp === void 0 ? frame.stale : this.maxInputAgeMs > 0 && captureAgeMs > this.maxInputAgeMs,
      deadlinePressure: frame.deadlinePressure,
      transport: request.transport
    };
  }

  updateLatency(transportLatencySamples) {
    this.transportLatencySamples = boundedLiveEffectLatencySamples(transportLatencySamples, this.transportLatencySamples);
    return this.transportLatencySamples;
  }

  updateFromRackHealth(health) {
    this.updateLatency(rackLatencySamples(health));
    this.updateDeadlinePressure(health);
    return this.transportLatencySamples;
  }

  updateFromRackCalibration(health, calibration) {
    this.updateLatency(calibration.recommendedTransportLatencySamples);
    this.updateDeadlinePressure(health, calibration);
    return this.transportLatencySamples;
  }

  updateFromChainHealth(health) {
    this.updateLatency(health.latencySamples);
    this.updateDeadlinePressure(health);
    return this.transportLatencySamples;
  }

  updateFromChainCalibration(health, calibration) {
    this.updateLatency(combinedLiveEffectLatencySamples(
      boundedLiveEffectLatencySamples(health.latencySamples, 0),
      boundedLiveEffectLatencySamples(calibration.recommendedTransportLatencySamples, 0)
    ));
    this.updateDeadlinePressure(health, calibration);
    return this.transportLatencySamples;
  }

  updateFromFrameBatchHealth(health) {
    this.updateLatency(liveEffectFrameBatchLatencySamples(health));
    this.updateDeadlinePressure(health);
    return this.transportLatencySamples;
  }

  updateFromFrameBatchCalibration(health, calibration) {
    this.updateLatency(combinedLiveEffectLatencySamples(
      liveEffectFrameBatchLatencySamples(health),
      boundedLiveEffectLatencySamples(calibration.recommendedTransportLatencySamples, 0)
    ));
    this.updateDeadlinePressure(health, calibration);
    return this.transportLatencySamples;
  }

  updateDeadlinePressureFromHealth(health, calibration) {
    return this.updateDeadlinePressure(health, calibration);
  }

  reset(options = {}) {
    this.nextBlockId = boundedLiveEffectInteger(options.nextBlockId, 0, 0, LIVE_EFFECT_SCHEDULER_MAX_BLOCK_ID);
    this.nextSamplePosition = optionalLiveEffectSchedulerInteger(options.nextSamplePosition, 0, LIVE_EFFECT_SCHEDULER_MAX_SAMPLE_POSITION);
  }

  setTimingPolicy(options) {
    this.maxInputAgeMs = boundedLiveEffectNumber(options.maxInputAgeMs, this.maxInputAgeMs, 0, 60000);
    this.deadlineLeadTargetBlocks = boundedLiveEffectNumber(
      options.deadlineLeadTargetBlocks,
      this.deadlineLeadTargetBlocks,
      0,
      64
    );
    this.responseJitterThresholdBlocks = boundedLiveEffectNumber(
      options.responseJitterThresholdBlocks,
      this.responseJitterThresholdBlocks,
      0,
      64
    );
    return this.snapshot();
  }

  snapshot() {
    return {
      nextBlockId: this.nextBlockId,
      nextSamplePosition: this.nextSamplePosition,
      transportLatencySamples: this.transportLatencySamples,
      transportLatencyBlocks: this.transportLatencyBlocks(),
      maxInputAgeMs: this.maxInputAgeMs,
      deadlineLeadTargetBlocks: this.deadlineLeadTargetBlocks,
      responseJitterThresholdBlocks: this.responseJitterThresholdBlocks,
      deadlinePressure: this.deadlinePressureSnapshot()
    };
  }

  advance(blockId, samplePosition) {
    this.nextBlockId = Math.min(LIVE_EFFECT_SCHEDULER_MAX_BLOCK_ID, blockId + 1);
    if (samplePosition !== void 0) {
      this.nextSamplePosition = Math.min(LIVE_EFFECT_SCHEDULER_MAX_SAMPLE_POSITION, samplePosition + this.maxBlockSize);
    }
  }

  updateDeadlinePressure(health, calibration) {
    const lead = boundedLiveEffectOptionalNumber(health.lastResponseDeadlineLeadBlocks, -64, 64);
    const jitter = boundedLiveEffectOptionalNumber(health.responseJitterBlocks, 0, 64);
    if (lead !== void 0) this.lastResponseDeadlineLeadBlocks = lead;
    if (jitter !== void 0) this.responseJitterBlocks = jitter;
    if (health.responseDeadlineMisses !== void 0) {
      const nextMisses = boundedLiveEffectInteger(health.responseDeadlineMisses, this.responseDeadlineMisses, 0, Number.MAX_SAFE_INTEGER);
      this.responseDeadlineMissesSinceLastUpdate = liveEffectSchedulerPressureCounterDelta(nextMisses, this.responseDeadlineMisses);
      this.responseDeadlineMisses = nextMisses;
    }
    this.deadlinePressureWarnings = calibration?.warnings?.slice() ?? [];
    return this.deadlinePressureSnapshot();
  }

  deadlinePressureReasonsForLatency(transportLatencySamples) {
    const reasons = [];
    const warnings = this.deadlinePressureWarnings;
    if (this.responseDeadlineMissesSinceLastUpdate > 0 || warnings.includes("deadline-miss")) reasons.push("deadline-miss");
    if (this.lastResponseDeadlineLeadBlocks !== void 0 && this.lastResponseDeadlineLeadBlocks < this.deadlineLeadTargetBlocks) {
      reasons.push("low-deadline-lead");
    }
    if (this.responseJitterBlocks > this.transportLatencyBlocks(transportLatencySamples) + this.responseJitterThresholdBlocks || warnings.includes("response-jitter")) {
      reasons.push("response-jitter");
    }
    if (warnings.includes("dry-output-pressure")) reasons.push("dry-output-pressure");
    if (warnings.includes("process-over-budget")) reasons.push("process-over-budget");
    if (warnings.includes("process-timeout")) reasons.push("process-timeout");
    if (warnings.includes("increase-process-budget")) reasons.push("increase-process-budget");
    if (warnings.includes("increase-process-timeout")) reasons.push("increase-process-timeout");
    if (warnings.includes("increase-transport-latency")) reasons.push("increase-transport-latency");
    return Array.from(new Set(reasons));
  }

  deadlinePressureSnapshot(transportLatencySamples = this.transportLatencySamples) {
    const reasons = this.deadlinePressureReasonsForLatency(transportLatencySamples);
    return {
      pressure: reasons.length > 0,
      reasons,
      lastResponseDeadlineLeadBlocks: this.lastResponseDeadlineLeadBlocks,
      responseJitterBlocks: this.responseJitterBlocks,
      responseDeadlineMisses: this.responseDeadlineMisses,
      responseDeadlineMissesSinceLastUpdate: this.responseDeadlineMissesSinceLastUpdate,
      transportLatencySamples,
      transportLatencyBlocks: this.transportLatencyBlocks(transportLatencySamples)
    };
  }

  transportLatencyBlocks(transportLatencySamples = this.transportLatencySamples) {
    return this.maxBlockSize > 0 ? Number((transportLatencySamples / this.maxBlockSize).toFixed(3)) : 0;
  }
}

export function createLiveEffectRackBlockScheduler(options) {
  return new LiveEffectRackBlockScheduler(options);
}

const LIVE_EFFECT_FRAME_BATCH_TARGETS = 16;

export class LiveEffectRackFrameBatchProcessor extends EventTarget {
  constructor(options) {
    super();
    this.scheduler = options.scheduler;
    this.sampleRate = boundedLiveEffectInteger(options.sampleRate, 48000, 1, 384000);
    this.maxBlockSize = boundedLiveEffectInteger(options.maxBlockSize, 128, 1, 8192);
    this.maxTargets = boundedLiveEffectInteger(options.maxTargets, LIVE_EFFECT_FRAME_BATCH_TARGETS, 1, 32);
    this.processBudgetMs = boundedLiveEffectNumber(options.processBudgetMs, 0, 0, 60000);
    this.processTimeoutMs = boundedLiveEffectNumber(options.processTimeoutMs, 0, 0, 60000);
    this.maxConsecutiveProcessBudgetMisses = boundedLiveEffectInteger(
      options.maxConsecutiveProcessBudgetMisses,
      0,
      0,
      1024
    );
    this.processBudgetRecoveryBlocks = boundedLiveEffectInteger(options.processBudgetRecoveryBlocks, 0, 0, 4096);
    this.processTimeoutRecoveryBlocks = boundedLiveEffectInteger(options.processTimeoutRecoveryBlocks, 0, 0, 4096);
    this.maxProcessTimeoutRecoveries = boundedLiveEffectInteger(options.maxProcessTimeoutRecoveries, 32, 0, 32);
    this.nowMs = typeof options.nowMs === "function" ? options.nowMs : liveEffectNowMs;
    this.processBudgetMisses = 0;
    this.processBudgetTripped = false;
    this.processTimeouts = 0;
    this.processTimeoutTripped = false;
    this.recoveryDryBlocks = 0;
    this.timeoutRecoveryDryBlocks = 0;
    this.processTimeoutRecoveryAttempts = 0;
    this.processTimeoutRecoveryExhaustedEmitted = false;
    this.lastError = void 0;
    this.lastResult = void 0;
    this.lastHealthKey = "";
    this.lastResponseDeadlineLeadMs = void 0;
    this.lastResponseDeadlineLeadBlocks = void 0;
    this.responseDeadlineLeadMinBlocks = void 0;
    this.responseDeadlineLeadMaxBlocks = void 0;
    this.responseJitterBlocks = 0;
    this.responseDeadlineMisses = 0;
  }

  get health() {
    return this.healthFromResult(this.lastResult);
  }

  get timing() {
    const health = this.health;
    return liveEffectRackTiming(this.sampleRate, this.maxBlockSize, health.latencySamples, 0, health.reportedLatencySamples, this.processBudgetMs, this.processTimeoutMs, 0, 0);
  }

  async process(targets, options = {}) {
    const frame = options.frame ?? this.scheduler.captureFrame(options.frameOptions);
    const targetCount = boundedLiveEffectInteger(targets?.length, 0, 0, this.maxTargets);
    if (this.processBudgetTripped || this.processTimeoutTripped) {
      return this.processPressureDryResult(frame, targets, targetCount);
    }
    if (frame.stale) {
      return this.schedulerDryResult(frame, targets, targetCount, "frame-batch-stale-input");
    }
    if (shouldSkipLiveEffectDeadlinePressure(frame.deadlinePressure, options)) {
      return this.schedulerDryResult(frame, targets, targetCount, "frame-batch-deadline-pressure");
    }
    const startedAt = this.nowMs();
    const targetResults = Array.from({ length: targetCount });
    const targetPromises = Array.from({ length: targetCount }, (_unused, index) =>
      this.processTarget(frame, targets[index], index).then((result) => {
        targetResults[index] = result;
        return result;
      })
    );
    const processing = Promise.all(targetPromises);
    try {
      const results = await withLiveEffectTimeout(processing, this.processTimeoutMs);
      return this.recordProcessBudget(frame, results, this.nowMs() - startedAt);
    } catch (error) {
      processing.catch(() => void 0);
      return this.recordProcessTimeout(frame, targets, targetCount, this.nowMs() - startedAt, error, targetResults.slice());
    }
  }

  retry() {
    if (!this.processBudgetTripped && !this.processTimeoutTripped) {
      return false;
    }
    this.processBudgetTripped = false;
    this.processTimeoutTripped = false;
    this.processBudgetMisses = 0;
    this.processTimeouts = 0;
    this.recoveryDryBlocks = 0;
    this.timeoutRecoveryDryBlocks = 0;
    this.processTimeoutRecoveryAttempts = 0;
    this.processTimeoutRecoveryExhaustedEmitted = false;
    this.lastError = void 0;
    this.lastResult = void 0;
    this.dispatchEvent(new CustomEvent("retry", { detail: { health: this.health } }));
    this.dispatchHealthChangeIfNeeded();
    return true;
  }

  setTimingPolicy(options) {
    const previous = { processBudgetMs: this.processBudgetMs, processTimeoutMs: this.processTimeoutMs };
    this.processBudgetMs = boundedLiveEffectNumber(options.processBudgetMs, this.processBudgetMs, 0, 60000);
    this.processTimeoutMs = boundedLiveEffectNumber(options.processTimeoutMs, this.processTimeoutMs, 0, 60000);
    const changed = this.processBudgetMs !== previous.processBudgetMs || this.processTimeoutMs !== previous.processTimeoutMs;
    if (changed) {
      const health = this.health;
      this.dispatchEvent(new CustomEvent("timingpolicychange", { detail: { previous, health } }));
      this.dispatchEvent(new CustomEvent("healthchange", { detail: health }));
    }
    return this.health;
  }

  async processTarget(frame, targetRequest, index) {
    const startedAt = this.nowMs();
    const scheduled = this.scheduler.scheduleFromFrame(
      frame,
      targetRequest?.channels ?? [],
      targetRequest?.scheduleOptions
    );
    if (typeof targetRequest?.target?.processScheduledBlock !== "function") {
      return this.targetResult(targetRequest, index, scheduled, void 0, new Error("invalid_frame_batch_target"), this.nowMs() - startedAt);
    }
    try {
      const response = await targetRequest.target.processScheduledBlock(scheduled, targetRequest.processOptions);
      return this.targetResult(targetRequest, index, scheduled, response, void 0, this.nowMs() - startedAt);
    } catch (error) {
      return this.targetResult(targetRequest, index, scheduled, void 0, error, this.nowMs() - startedAt);
    }
  }

  targetResult(targetRequest, index, scheduled, response, error, durationMs) {
    const responseLatencySamples = boundedLiveEffectLatencySamples(response?.latencySamples, 0);
    const health = targetRequest?.target.health;
    const reportedLatencySamples = boundedLiveEffectLatencySamples(
      health?.reportedLatencySamples,
      boundedLiveEffectLatencySamples(health?.latencySamples, responseLatencySamples)
    );
    const bypassed = response?.bypassed === true;
    return {
      id: targetRequest?.id,
      index,
      scheduled,
      response,
      error,
      bypassed,
      dry: bypassed,
      skipped: false,
      healthy: error === void 0 && response?.healthy !== false && health?.healthy !== false,
      latencySamples: responseLatencySamples,
      reportedLatencySamples,
      durationMs: boundedLiveEffectOptionalNumber(durationMs, 0, 60000) ?? 0
    };
  }

  dryTargetResult(frame, targetRequest, index, error, renderEngine = "frame-batch-process-budget-exceeded") {
    const scheduled = this.scheduler.scheduleFromFrame(
      frame,
      targetRequest?.channels ?? [],
      targetRequest?.scheduleOptions
    );
    const response = {
      blockId: scheduled.blockId,
      channels: scheduled.request.channels,
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine,
      bypassed: true,
      healthy: false,
      error
    };
    return {
      id: targetRequest?.id,
      index,
      scheduled,
      response,
      error,
      bypassed: true,
      dry: true,
      skipped: true,
      healthy: false,
      latencySamples: 0,
      reportedLatencySamples: 0,
      durationMs: 0
    };
  }

  schedulerDryTargetResult(frame, targetRequest, index, renderEngine) {
    const scheduled = this.scheduler.scheduleFromFrame(frame, targetRequest?.channels ?? [], targetRequest?.scheduleOptions);
    const health = targetRequest?.target.health;
    const reportedLatencySamples = boundedLiveEffectLatencySamples(health?.reportedLatencySamples, boundedLiveEffectLatencySamples(health?.latencySamples, 0));
    return {
      id: targetRequest?.id,
      index,
      scheduled,
      response: {
        blockId: scheduled.blockId,
        channels: scheduled.request.channels,
        latencySamples: 0,
        tailSamples: 0,
        infiniteTail: false,
        renderEngine,
        bypassed: true,
        healthy: health?.healthy !== false,
        deadlinePressure: frame.deadlinePressure
      },
      bypassed: true,
      dry: true,
      skipped: true,
      healthy: health?.healthy !== false,
      latencySamples: 0,
      reportedLatencySamples,
      durationMs: 0
    };
  }

  recordProcessBudget(frame, results, totalDurationMs) {
    const boundedDurationMs = boundedLiveEffectOptionalNumber(totalDurationMs, 0, 60000) ?? 0;
    const processBudgetExceeded = this.processBudgetMs > 0 && boundedDurationMs > this.processBudgetMs;
    this.recordResponseDeadlineLead(results, boundedDurationMs);
    this.processBudgetMisses = processBudgetExceeded ? Math.min(1024, this.processBudgetMisses + 1) : 0;
    if (
      processBudgetExceeded &&
      this.maxConsecutiveProcessBudgetMisses > 0 &&
      this.processBudgetMisses >= this.maxConsecutiveProcessBudgetMisses
    ) {
      this.processBudgetTripped = true;
      this.recoveryDryBlocks = 0;
      this.lastError = new Error("frame_batch_process_budget_exceeded");
      const result = this.result(
        frame,
        results.map((result) => this.dryTargetFromScheduledResult(result, this.lastError)),
        boundedDurationMs,
        true,
        false,
        this.lastError
      );
      this.dispatchEvent(new CustomEvent("frame-batch-process-budget-exceeded", { detail: { result, health: this.health } }));
      this.dispatchEvent(new CustomEvent("frame-batch-process-budget-tripped", { detail: { result, health: this.health } }));
      return result;
    }
    const result = this.result(frame, results, boundedDurationMs, processBudgetExceeded, false, void 0);
    if (processBudgetExceeded) {
      this.dispatchEvent(new CustomEvent("frame-batch-process-budget-exceeded", { detail: { result, health: this.health } }));
    }
    return result;
  }

  recordProcessTimeout(frame, targets, targetCount, totalDurationMs, error, completedResults = []) {
    this.processTimeouts = Math.min(1024, this.processTimeouts + 1);
    this.processTimeoutTripped = true;
    this.timeoutRecoveryDryBlocks = 0;
    this.processTimeoutRecoveryExhaustedEmitted = false;
    this.lastError = error;
    const boundedDurationMs = Math.max(
      this.processTimeoutMs,
      boundedLiveEffectOptionalNumber(totalDurationMs, 0, 60000) ?? 0
    );
    const results = Array.from({ length: targetCount }, (_unused, index) =>
      completedResults[index] ?? this.dryTargetResult(frame, targets[index], index, error, "frame-batch-process-timeout")
    );
    this.recordResponseDeadlineLead(results, boundedDurationMs);
    const result = this.result(frame, results, boundedDurationMs, false, true, error);
    this.dispatchEvent(new CustomEvent("frame-batch-process-timeout", { detail: { result, health: this.health } }));
    this.dispatchEvent(new CustomEvent("frame-batch-process-timeout-tripped", { detail: { result, health: this.health } }));
    this.dispatchProcessTimeoutRecoveryExhaustedIfNeeded(result);
    return result;
  }

  dryTargetFromScheduledResult(result, error) {
    const response = {
      blockId: result.scheduled.blockId,
      channels: result.scheduled.request.channels,
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine: "frame-batch-process-budget-exceeded",
      bypassed: true,
      healthy: false,
      error
    };
    return {
      ...result,
      response,
      error,
      bypassed: true,
      dry: true,
      skipped: true,
      healthy: false,
      latencySamples: 0,
      reportedLatencySamples: 0
    };
  }

  processPressureDryResult(frame, targets, targetCount) {
    const timeoutActive = this.processTimeoutTripped;
    const error = this.lastError ?? new Error(timeoutActive ? "frame_batch_process_timeout" : "frame_batch_process_budget_exceeded");
    const renderEngine = timeoutActive ? "frame-batch-process-timeout" : "frame-batch-process-budget-exceeded";
    const results = Array.from({ length: targetCount }, (_unused, index) =>
      this.dryTargetResult(frame, targets[index], index, error, renderEngine)
    );
    const result = this.result(frame, results, 0, false, false, error);
    this.maybeRecoverFromProcessBudget();
    this.maybeRecoverFromProcessTimeout();
    return result;
  }

  schedulerDryResult(frame, targets, targetCount, renderEngine) {
    const results = Array.from({ length: targetCount }, (_unused, index) =>
      this.schedulerDryTargetResult(frame, targets[index], index, renderEngine)
    );
    const result = this.result(frame, results, 0, false, false, void 0);
    this.dispatchEvent(new CustomEvent(renderEngine, { detail: { result, health: this.health, deadlinePressure: frame.deadlinePressure } }));
    return result;
  }

  maybeRecoverFromProcessBudget() {
    if (!this.processBudgetTripped || this.processBudgetRecoveryBlocks <= 0) {
      return;
    }
    this.recoveryDryBlocks = Math.min(4096, this.recoveryDryBlocks + 1);
    if (this.recoveryDryBlocks < this.processBudgetRecoveryBlocks) {
      return;
    }
    this.processBudgetTripped = false;
    this.processBudgetMisses = 0;
    this.recoveryDryBlocks = 0;
    this.lastError = void 0;
    this.lastResult = void 0;
    this.dispatchEvent(new CustomEvent("frame-batch-process-budget-recovered", { detail: { health: this.health } }));
    this.dispatchHealthChangeIfNeeded();
  }

  maybeRecoverFromProcessTimeout() {
    if (!this.processTimeoutTripped) {
      return;
    }
    if (this.processTimeoutRecoveryExhausted()) {
      this.dispatchProcessTimeoutRecoveryExhaustedIfNeeded();
      return;
    }
    this.timeoutRecoveryDryBlocks = Math.min(4096, this.timeoutRecoveryDryBlocks + 1);
    if (this.timeoutRecoveryDryBlocks < this.processTimeoutRecoveryBlocks) {
      return;
    }
    this.processTimeoutRecoveryAttempts = Math.min(32, this.processTimeoutRecoveryAttempts + 1);
    this.processTimeoutTripped = false;
    this.processTimeouts = 0;
    this.timeoutRecoveryDryBlocks = 0;
    this.lastError = void 0;
    this.lastResult = void 0;
    this.dispatchEvent(new CustomEvent("frame-batch-process-timeout-recovered", { detail: { health: this.health } }));
    this.dispatchHealthChangeIfNeeded();
  }

  result(frame, results, totalDurationMs, processBudgetExceeded, processTimedOut, error) {
    const failedTargets = results.filter((result) => result.error !== void 0 || result.healthy === false).length;
    const dryTargets = results.filter((result) => result.dry).length;
    const bypassedTargets = results.filter(isIntentionalFrameBatchBypassResult).length;
    const skippedTargets = results.filter((result) => result.skipped).length;
    const result = {
      frame,
      deadlinePressure: frame.deadlinePressure,
      results,
      targetCount: results.length,
      processedTargets: results.filter((result) => result.response !== void 0 && !result.skipped).length,
      skippedTargets,
      failedTargets,
      dryTargets,
      bypassedTargets,
      healthy: failedTargets === 0 && !this.processBudgetTripped && !this.processTimeoutTripped,
      latencySamples: maxLiveEffectFrameBatchLatency(results, "latencySamples"),
      reportedLatencySamples: maxLiveEffectFrameBatchLatency(results, "reportedLatencySamples"),
      maxDurationMs: results.reduce((max, result) => Math.max(max, result.durationMs), 0),
      totalDurationMs: boundedLiveEffectOptionalNumber(totalDurationMs, 0, 60000) ?? 0,
      lastResponseDeadlineLeadMs: this.lastResponseDeadlineLeadMs,
      lastResponseDeadlineLeadBlocks: this.lastResponseDeadlineLeadBlocks,
      responseJitterBlocks: this.responseJitterBlocks,
      responseDeadlineMisses: this.responseDeadlineMisses,
      processBudgetMs: this.processBudgetMs > 0 ? this.processBudgetMs : void 0,
      processTimeoutMs: this.processTimeoutMs > 0 ? this.processTimeoutMs : void 0,
      processBudgetExceeded,
      processTimedOut,
      processBudgetMisses: this.processBudgetMisses,
      processBudgetTripped: this.processBudgetTripped,
      processTimeouts: this.processTimeouts,
      processTimeoutTripped: this.processTimeoutTripped,
      recoveryDryBlocks: this.recoveryDryBlocks,
      timeoutRecoveryDryBlocks: this.timeoutRecoveryDryBlocks,
      recoveryDryBlocksRemaining: this.recoveryDryBlocksRemaining(),
      processTimeoutRecoveryAttempts: this.processTimeoutRecoveryAttempts,
      processTimeoutRecoveryExhausted: this.processTimeoutRecoveryExhausted(),
      maxProcessTimeoutRecoveries: this.maxProcessTimeoutRecoveries,
      error
    };
    this.lastResult = result;
    if (dryTargets > 0) this.dispatchEvent(new CustomEvent("frame-batch-dry-output", { detail: { result, health: this.health, reason: result.processTimeoutTripped ? "frame-batch-process-timeout" : result.processBudgetTripped ? "frame-batch-process-budget-exceeded" : result.skippedTargets > 0 ? frame.stale ? "frame-batch-stale-input" : frame.deadlinePressure.pressure ? "frame-batch-deadline-pressure" : "frame-batch-skipped" : result.bypassedTargets >= dryTargets ? "frame-batch-bypass" : "frame-batch-target-dry", deadlinePressure: frame.deadlinePressure } }));
    this.dispatchHealthChangeIfNeeded();
    return result;
  }

  healthFromResult(result) {
    const failedTargets = result?.failedTargets ?? 0;
    return {
      healthy: !this.processBudgetTripped && !this.processTimeoutTripped && failedTargets === 0,
      targetCount: result?.targetCount ?? 0,
      processedTargets: result?.processedTargets ?? 0,
      skippedTargets: result?.skippedTargets ?? 0,
      failedTargets,
      dryTargets: result?.dryTargets ?? 0,
      bypassedTargets: result?.bypassedTargets ?? 0,
      latencySamples: boundedLiveEffectLatencySamples(result?.latencySamples, 0),
      reportedLatencySamples: boundedLiveEffectLatencySamples(result?.reportedLatencySamples, 0),
      maxDurationMs: boundedLiveEffectOptionalNumber(result?.maxDurationMs, 0, 60000) ?? 0,
      totalDurationMs: boundedLiveEffectOptionalNumber(result?.totalDurationMs, 0, 60000) ?? 0,
      lastResponseDeadlineLeadMs: this.lastResponseDeadlineLeadMs,
      lastResponseDeadlineLeadBlocks: this.lastResponseDeadlineLeadBlocks,
      responseJitterBlocks: this.responseJitterBlocks,
      responseDeadlineMisses: this.responseDeadlineMisses,
      processBudgetMs: this.processBudgetMs > 0 ? this.processBudgetMs : void 0,
      processTimeoutMs: this.processTimeoutMs > 0 ? this.processTimeoutMs : void 0,
      processBudgetExceeded: result?.processBudgetExceeded === true,
      processTimedOut: result?.processTimedOut === true,
      processBudgetMisses: this.processBudgetMisses,
      processBudgetTripped: this.processBudgetTripped,
      processTimeouts: this.processTimeouts,
      processTimeoutTripped: this.processTimeoutTripped,
      recoveryDryBlocks: this.recoveryDryBlocks,
      timeoutRecoveryDryBlocks: this.timeoutRecoveryDryBlocks,
      recoveryDryBlocksRemaining: this.recoveryDryBlocksRemaining(),
      processTimeoutRecoveryAttempts: this.processTimeoutRecoveryAttempts,
      processTimeoutRecoveryExhausted: this.processTimeoutRecoveryExhausted(),
      maxProcessTimeoutRecoveries: this.maxProcessTimeoutRecoveries,
      lastError: this.lastError ?? result?.error
    };
  }

  recoveryDryBlocksRemaining() {
    const timeout = this.processTimeoutTripped && !this.processTimeoutRecoveryExhausted();
    const target = timeout ? this.processTimeoutRecoveryBlocks : this.processBudgetTripped ? this.processBudgetRecoveryBlocks : 0;
    return Math.max(0, target - (timeout ? this.timeoutRecoveryDryBlocks : this.recoveryDryBlocks));
  }

  processTimeoutRecoveryExhausted() {
    return this.processTimeoutTripped && (this.processTimeoutRecoveryBlocks <= 0 || this.maxProcessTimeoutRecoveries <= 0 || this.processTimeoutRecoveryAttempts >= this.maxProcessTimeoutRecoveries);
  }

  dispatchProcessTimeoutRecoveryExhaustedIfNeeded(result) {
    if (!this.processTimeoutRecoveryExhausted() || this.processTimeoutRecoveryExhaustedEmitted) {
      return;
    }
    this.processTimeoutRecoveryExhaustedEmitted = true;
    this.dispatchEvent(new CustomEvent("frame-batch-process-timeout-recovery-exhausted", { detail: { result, health: this.health } }));
  }

  dispatchHealthChangeIfNeeded() {
    const health = this.health;
    const key = [
      health.healthy,
      health.processBudgetMisses,
      health.processBudgetTripped,
      health.processTimeouts,
      health.processTimeoutTripped,
      health.processTimeoutRecoveryAttempts,
      health.processTimeoutRecoveryExhausted,
      health.recoveryDryBlocks,
      health.timeoutRecoveryDryBlocks,
      health.recoveryDryBlocksRemaining,
      health.failedTargets,
      health.dryTargets,
      health.bypassedTargets,
      health.skippedTargets,
      health.latencySamples,
      health.reportedLatencySamples,
      health.lastResponseDeadlineLeadBlocks,
      health.responseJitterBlocks,
      health.responseDeadlineMisses
    ].join(":");
    if (key === this.lastHealthKey) {
      return;
    }
    this.lastHealthKey = key;
    this.dispatchEvent(new CustomEvent("healthchange", { detail: health }));
  }

  recordResponseDeadlineLead(results, totalDurationMs) {
    if (this.processBudgetMs <= 0) return;
    const blockDurationMs = liveEffectFrameBatchBlockDurationMs(results);
    this.lastResponseDeadlineLeadMs = boundedLiveEffectOptionalNumber(this.processBudgetMs - totalDurationMs, -60000, 60000);
    this.lastResponseDeadlineLeadBlocks = this.lastResponseDeadlineLeadMs === void 0 || blockDurationMs <= 0
      ? void 0
      : Number((this.lastResponseDeadlineLeadMs / blockDurationMs).toFixed(3));
    this.responseDeadlineLeadMinBlocks = Math.min(
      this.responseDeadlineLeadMinBlocks ?? this.lastResponseDeadlineLeadBlocks ?? 0,
      this.lastResponseDeadlineLeadBlocks ?? 0
    );
    this.responseDeadlineLeadMaxBlocks = Math.max(
      this.responseDeadlineLeadMaxBlocks ?? this.lastResponseDeadlineLeadBlocks ?? 0,
      this.lastResponseDeadlineLeadBlocks ?? 0
    );
    this.responseJitterBlocks = Number(((this.responseDeadlineLeadMaxBlocks ?? 0) - (this.responseDeadlineLeadMinBlocks ?? 0)).toFixed(3));
    if ((this.lastResponseDeadlineLeadMs ?? 0) < 0) { this.responseDeadlineMisses = Math.min(1024, this.responseDeadlineMisses + 1); this.dispatchEvent(new CustomEvent("frame-batch-response-deadline-missed", { detail: { durationMs: totalDurationMs, budgetMs: this.processBudgetMs, leadMs: this.lastResponseDeadlineLeadMs, leadBlocks: this.lastResponseDeadlineLeadBlocks, health: this.health } })); }
  }
}

export function createLiveEffectRackFrameBatchProcessor(options) {
  return new LiveEffectRackFrameBatchProcessor(options);
}

export function createLivePerformanceFrameBatchProcessorOptions(options) {
  const {
    sampleRate,
    maxBlockSize,
    processBudgetBlocks,
    processTimeoutBlocks,
    ...processorOptions
  } = options;
  const policy = createLiveEffectRackPolicy({
    ...options,
    sampleRate,
    maxBlockSize,
    processBudgetBlocks,
    processTimeoutBlocks
  });
  return {
    ...processorOptions,
    sampleRate,
    maxBlockSize,
    processBudgetMs: policy.processBudgetMs,
    processTimeoutMs: policy.processTimeoutMs,
    maxConsecutiveProcessBudgetMisses: policy.maxConsecutiveProcessBudgetMisses,
    processBudgetRecoveryBlocks: policy.processBudgetRecoveryBlocks,
    processTimeoutRecoveryBlocks: policy.processTimeoutRecoveryBlocks,
    maxProcessTimeoutRecoveries: policy.maxProcessTimeoutRecoveries
  };
}

export function createLivePerformanceFrameBatchProcessor(options) {
  return createLiveEffectRackFrameBatchProcessor(createLivePerformanceFrameBatchProcessorOptions(options));
}

function maxLiveEffectFrameBatchLatency(results, key) {
  return results.reduce((max, result) => Math.max(max, result[key]), 0);
}

function isIntentionalFrameBatchBypassResult(result) {
  return (
    result.bypassed &&
    result.skipped === false &&
    result.healthy !== false &&
    result.error === void 0 &&
    result.response?.renderEngine === "dry-bypass"
  );
}

function liveEffectFrameBatchBlockDurationMs(results) {
  const firstRate = results.find((result) => result.scheduled.request.sampleRate !== void 0)?.scheduled.request.sampleRate;
  const sampleRate = boundedLiveEffectInteger(firstRate, 48000, 1, 384000);
  const frames = boundedLiveEffectInteger(
    results.reduce((max, result) => Math.max(max, ...result.scheduled.request.channels.map((channel) => channel.length)), 0),
    128,
    1,
    8192
  );
  return liveEffectBlockDurationMs(sampleRate, frames);
}

function liveEffectFrameBatchLatencySamples(health) {
  return Math.max(
    boundedLiveEffectLatencySamples(health.latencySamples, 0),
    boundedLiveEffectLatencySamples(health.reportedLatencySamples, 0)
  );
}

function rackLatencySamples(health) {
  return Math.max(
    boundedLiveEffectLatencySamples(health.transportLatencySamples, 0),
    boundedLiveEffectLatencySamples(health.reportedLatencySamples, 0)
  );
}

function liveEffectFrameBatchCalibrationLatencySamples(health) {
  return Math.max(
    boundedLiveEffectOptionalNumber(health.latencySamples, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    boundedLiveEffectOptionalNumber(health.reportedLatencySamples, 0, Number.MAX_SAFE_INTEGER) ?? 0
  );
}

export function shouldSkipLiveEffectDeadlinePressure(pressure, options = {}) {
  if (options.skipOnDeadlinePressure !== true || pressure === void 0 || pressure.pressure !== true) return false;
  const reasons = normalizeLiveEffectRackDeadlinePressureReasons(options.skipOnDeadlinePressureReasons);
  return reasons === void 0 ? true : reasons.some((reason) => pressure.reasons.includes(reason));
}

function optionalLiveEffectSchedulerInteger(value, min, max) {
  if (value === void 0 || value === null) return void 0;
  return boundedLiveEffectInteger(value, 0, min, max);
}

function finiteLiveEffectSchedulerNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function liveEffectSchedulerPressureCounterDelta(current, baseline) {
  return current >= baseline ? current - baseline : current;
}

export function liveTransportForBlock(options) {
  const sampleRate = boundedLiveEffectInteger(options.sampleRate, 48000, 1, 384000);
  const maxBlockSize = boundedLiveEffectInteger(options.maxBlockSize, 128, 1, 8192);
  const maxBlockId = Math.floor(LIVE_TRANSPORT_MAX_SAMPLE_POSITION / maxBlockSize);
  const blockId = boundedLiveEffectInteger(options.blockId, 0, 0, maxBlockId);
  const baseSamplePosition = options.samplePosition === void 0 ? blockId * maxBlockSize : boundedLiveEffectInteger(options.samplePosition, 0, 0, LIVE_TRANSPORT_MAX_SAMPLE_POSITION);
  const latencySamples = options.compensateOutputLatency === true ? boundedLiveEffectInteger(options.reportedLatencySamples, 0, 0, LIVE_TRANSPORT_MAX_SAMPLE_POSITION) : 0;
  const samplePosition = Math.min(LIVE_TRANSPORT_MAX_SAMPLE_POSITION, baseSamplePosition + latencySamples);
  const transport = { playing: options.playing !== false, samplePosition };
  if (typeof options.recording === "boolean") transport.recording = options.recording;

  const tempo = optionalLiveTransportNumber(options.tempo, 1, 960);
  if (tempo !== void 0) transport.tempo = tempo;

  const hasMeter = tempo !== void 0 || options.timeSignatureNumerator !== void 0 || options.timeSignatureDenominator !== void 0;
  const numerator = boundedLiveEffectInteger(options.timeSignatureNumerator, 4, 1, 64);
  const denominator = boundedLiveTransportDenominator(options.timeSignatureDenominator, 4);
  if (hasMeter) {
    transport.timeSignatureNumerator = numerator;
    transport.timeSignatureDenominator = denominator;
  }

  const projectTimeMusic = liveTransportPositionMusic(options.projectTimeMusic, samplePosition, sampleRate, tempo, options.projectTimeMusicAtSampleZero);
  if (projectTimeMusic !== void 0) {
    transport.projectTimeMusic = projectTimeMusic;
    transport.barPositionMusic = optionalLiveTransportNumber(options.barPositionMusic, 0, LIVE_TRANSPORT_MAX_MUSIC) ?? liveTransportBarPositionMusic(projectTimeMusic, numerator, denominator);
  } else if (options.barPositionMusic !== void 0) {
    transport.barPositionMusic = optionalLiveTransportNumber(options.barPositionMusic, 0, LIVE_TRANSPORT_MAX_MUSIC);
  }

  const hasCycle = options.cycleStartMusic !== void 0 || options.cycleEndMusic !== void 0;
  if (hasCycle) {
    const start = optionalLiveTransportNumber(options.cycleStartMusic ?? options.cycleEndMusic, 0, LIVE_TRANSPORT_MAX_MUSIC) ?? 0;
    const end = optionalLiveTransportNumber(options.cycleEndMusic ?? options.cycleStartMusic, 0, LIVE_TRANSPORT_MAX_MUSIC) ?? start;
    transport.cycleStartMusic = start;
    transport.cycleEndMusic = Math.max(start, end);
  }
  if (typeof options.loopActive === "boolean" || hasCycle) transport.loopActive = options.loopActive ?? hasCycle;
  return transport;
}

export function createLivePerformanceRackOptions(options) {
  const {
    maxInputAgeBlocks,
    processBudgetBlocks,
    processTimeoutBlocks,
    transitionFadeBlocks,
    ...rackOptions
  } = options;
  const policy = createLiveEffectRackPolicy({
    ...options,
    maxInputAgeBlocks,
    processBudgetBlocks,
    processTimeoutBlocks,
    transitionFadeBlocks
  });

  return {
    ...rackOptions,
    audioTransport: options.audioTransport ?? "binary",
    maxInputAgeMs: policy.maxInputAgeMs,
    maxInFlightBlocks: policy.maxInFlightBlocks,
    processBudgetMs: policy.processBudgetMs,
    processTimeoutMs: policy.processTimeoutMs,
    transitionFadeSamples: policy.transitionFadeSamples,
    maxConsecutiveProcessBudgetMisses: policy.maxConsecutiveProcessBudgetMisses,
    maxConsecutiveRenderBudgetMisses: policy.maxConsecutiveRenderBudgetMisses,
    processBudgetRecoveryBlocks: policy.processBudgetRecoveryBlocks,
    renderBudgetRecoveryBlocks: policy.renderBudgetRecoveryBlocks,
    processTimeoutRecoveryBlocks: policy.processTimeoutRecoveryBlocks,
    maxProcessTimeoutRecoveries: policy.maxProcessTimeoutRecoveries
  };
}

export class SoundBridgeLiveEffectRack extends EventTarget {
  constructor(options) {
    super();
    this.created = void 0;
    this.destroyed = false;
    this.bypassed = false;
    this.healthy = true;
    this.lastError = void 0;
    this.unhealthyReason = void 0;
    this.recoveryDryBlocks = 0;
    this.recoveryInProgress = false;
    this.processTimeoutRecoveryAttempts = 0;
    this.processTimeoutRecoveryExhaustedEmitted = false;
    this.outputStateVersion = 0;
    this.inFlightEpoch = 0;
    this.inFlightBlocks = 0;
    this.droppedInputBlocks = 0;
    this.staleInputBlocks = 0;
    this.staleOutputBlocks = 0;
    this.dryOutputBlocks = 0;
    this.processBudgetMisses = 0;
    this.lastProcessDurationMs = void 0;
    this.lastProcessBudgetMs = void 0;
    this.lastProcessBudgetExceeded = false;
    this.lastResponseDeadlineLeadMs = void 0;
    this.lastResponseDeadlineLeadBlocks = void 0;
    this.responseDeadlineLeadMinBlocks = void 0;
    this.responseDeadlineLeadMaxBlocks = void 0;
    this.responseJitterBlocks = 0;
    this.responseDeadlineMisses = 0;
    this.renderBudgetMisses = 0;
    this.lastRenderDurationMs = void 0;
    this.lastRenderBudgetMs = void 0;
    this.lastRenderBudgetExceeded = false;
    this.lastRenderTimeoutMs = void 0;
    this.lastRenderTimeoutBudgetMs = void 0;
    this.lastRenderTimeoutBudgetDeltaMs = void 0;
    this.renderTimeouts = 0;
    this.consecutiveRenderTimeouts = 0;
    this.renderQuarantined = false;
    this.lastDryReason = void 0;
    this.lastOutputPath = void 0;
    this.lastOutputTail = void 0;
    this.transportLatencySamples = 0;
    this.reportedLatencySamples = 0;
    this.wetMix = 1;
    this.client = options.client;
    this.plugin = options.plugin;
    this.sampleRate = options.sampleRate;
    this.maxBlockSize = options.maxBlockSize;
    this.inputChannels = boundedLiveEffectChannelCount(options.inputChannels ?? options.plugin.inputs ?? 2);
    this.outputChannels = boundedLiveEffectChannelCount(options.outputChannels ?? options.plugin.outputs ?? this.inputChannels);
    this.audioTransport = options.audioTransport === "json" ? "json" : "binary";
    this.maxInputAgeMs = boundedLiveEffectNumber(options.maxInputAgeMs, 0, 0, 60000);
    this.maxInFlightBlocks = boundedLiveEffectInteger(options.maxInFlightBlocks, 1, 1, 32);
    this.processBudgetMs = boundedLiveEffectNumber(options.processBudgetMs, 0, 0, 60000);
    this.processTimeoutMs = boundedLiveEffectNumber(options.processTimeoutMs, 0, 0, 60000);
    this.transitionFadeSamples = boundedLiveEffectInteger(options.transitionFadeSamples, 0, 0, 4096);
    this.maxConsecutiveProcessBudgetMisses = boundedLiveEffectInteger(options.maxConsecutiveProcessBudgetMisses, 0, 0, 1024);
    this.maxConsecutiveRenderBudgetMisses = boundedLiveEffectInteger(options.maxConsecutiveRenderBudgetMisses, 3, 0, 1024);
    this.processBudgetRecoveryBlocks = boundedLiveEffectInteger(options.processBudgetRecoveryBlocks, 0, 0, 4096);
    this.renderBudgetRecoveryBlocks = boundedLiveEffectInteger(options.renderBudgetRecoveryBlocks, 0, 0, 4096);
    this.processTimeoutRecoveryBlocks = boundedLiveEffectInteger(options.processTimeoutRecoveryBlocks, 0, 0, 4096);
    this.maxProcessTimeoutRecoveries = boundedLiveEffectInteger(options.maxProcessTimeoutRecoveries, 0, 0, 32);
    this.wetMix = boundedLiveEffectWetMix(options.wetMix, 1);
  }

  static async create(options) {
    const rack = new SoundBridgeLiveEffectRack(options);
    await rack.createInstance();
    return rack;
  }

  static createLivePerformance(options) {
    return SoundBridgeLiveEffectRack.create(createLivePerformanceRackOptions(options));
  }

  get instanceId() {
    return this.created?.instanceId;
  }

  get timing() { return liveEffectRackTiming(this.sampleRate, this.maxBlockSize, this.created?.latencySamples ?? 0, this.transportLatencySamples, this.reportedLatencySamples, this.processBudgetMs, this.processTimeoutMs, this.maxInputAgeMs, this.transitionFadeSamples); }

  get health() {
    return {
      bypassed: this.bypassed,
      healthy: this.healthy,
      instanceId: this.instanceId,
      lastError: this.lastError,
      latencySamples: this.created?.latencySamples ?? 0,
      pluginLatencySamples: this.created?.latencySamples ?? 0,
      transportLatencySamples: this.transportLatencySamples,
      reportedLatencySamples: this.reportedLatencySamples,
      latencyMs: liveEffectLatencyMilliseconds(this.created?.latencySamples ?? 0, this.sampleRate),
      pluginLatencyMs: liveEffectLatencyMilliseconds(this.created?.latencySamples ?? 0, this.sampleRate),
      transportLatencyMs: liveEffectLatencyMilliseconds(this.transportLatencySamples, this.sampleRate),
      reportedLatencyMs: liveEffectLatencyMilliseconds(this.reportedLatencySamples, this.sampleRate),
      processBudgetMisses: this.processBudgetMisses,
      lastProcessDurationMs: this.lastProcessDurationMs,
      lastProcessBudgetMs: this.lastProcessBudgetMs,
      processBudgetExceeded: this.lastProcessBudgetExceeded,
      lastResponseDeadlineLeadMs: this.lastResponseDeadlineLeadMs,
      lastResponseDeadlineLeadBlocks: this.lastResponseDeadlineLeadBlocks,
      responseJitterBlocks: this.responseJitterBlocks,
      responseDeadlineMisses: this.responseDeadlineMisses,
      renderBudgetMisses: this.renderBudgetMisses,
      lastRenderDurationMs: this.lastRenderDurationMs,
      lastRenderBudgetMs: this.lastRenderBudgetMs,
      renderBudgetExceeded: this.lastRenderBudgetExceeded,
      lastRenderTimeoutMs: this.lastRenderTimeoutMs,
      lastRenderTimeoutBudgetMs: this.lastRenderTimeoutBudgetMs,
      lastRenderTimeoutBudgetDeltaMs: this.lastRenderTimeoutBudgetDeltaMs,
      renderTimeouts: this.renderTimeouts,
      consecutiveRenderTimeouts: this.consecutiveRenderTimeouts,
      renderQuarantined: this.renderQuarantined,
      lastDryReason: this.lastDryReason,
      unhealthyReason: this.unhealthyReason,
      recoveryDryBlocks: this.recoveryDryBlocks,
      recoveryDryBlocksRemaining: this.recoveryDryBlocksRemaining(),
      recoveryInProgress: this.recoveryInProgress,
      processBudgetRecoveryBlocks: this.processBudgetRecoveryBlocks,
      renderBudgetRecoveryBlocks: this.renderBudgetRecoveryBlocks,
      processTimeoutRecoveryBlocks: this.processTimeoutRecoveryBlocks,
      processTimeoutRecoveryAttempts: this.processTimeoutRecoveryAttempts,
      processTimeoutRecoveryExhausted: this.processTimeoutRecoveryExhausted(),
      maxProcessTimeoutRecoveries: this.maxProcessTimeoutRecoveries,
      processBudgetMs: this.processBudgetMs,
      processTimeoutMs: this.processTimeoutMs,
      maxInputAgeMs: this.maxInputAgeMs,
      inFlightBlocks: this.inFlightBlocks,
      maxInFlightBlocks: this.maxInFlightBlocks,
      droppedInputBlocks: this.droppedInputBlocks,
      staleInputBlocks: this.staleInputBlocks,
      staleOutputBlocks: this.staleOutputBlocks,
      dryOutputBlocks: this.dryOutputBlocks,
      transitionFadeSamples: this.transitionFadeSamples,
      wetMix: this.wetMix
    };
  }

  setBypassed(bypassed) {
    if (this.bypassed !== bypassed) {
      this.outputStateVersion += 1;
    }
    this.bypassed = bypassed;
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  setWetMix(wetMix) {
    const bounded = boundedLiveEffectWetMix(wetMix, this.wetMix);
    if (bounded === this.wetMix) {
      return;
    }
    this.wetMix = bounded;
    this.dispatchEvent(new CustomEvent("wetmixchange", { detail: this.health }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  setTimingPolicy(options) {
    const previous = { maxInputAgeMs: this.maxInputAgeMs, processBudgetMs: this.processBudgetMs, processTimeoutMs: this.processTimeoutMs, transitionFadeSamples: this.transitionFadeSamples };
    this.maxInputAgeMs = boundedLiveEffectNumber(options.maxInputAgeMs, this.maxInputAgeMs, 0, 60000);
    this.processBudgetMs = boundedLiveEffectNumber(options.processBudgetMs, this.processBudgetMs, 0, 60000);
    this.processTimeoutMs = boundedLiveEffectNumber(options.processTimeoutMs, this.processTimeoutMs, 0, 60000);
    this.transitionFadeSamples = boundedLiveEffectInteger(options.transitionFadeSamples, this.transitionFadeSamples, 0, 4096);
    const changed = this.maxInputAgeMs !== previous.maxInputAgeMs || this.processBudgetMs !== previous.processBudgetMs || this.processTimeoutMs !== previous.processTimeoutMs || this.transitionFadeSamples !== previous.transitionFadeSamples;
    if (changed) {
      const health = this.health;
      this.dispatchEvent(new CustomEvent("timingpolicychange", { detail: { previous, health } }));
      this.dispatchEvent(new CustomEvent("healthchange", { detail: health }));
    }
    return this.health;
  }

  retry() {
    if (this.destroyed || !this.instanceId || !isRecoverableLiveEffectPressureReason(this.unhealthyReason)) {
      return false;
    }
    this.healthy = true;
    this.lastError = void 0;
    this.unhealthyReason = void 0;
    this.recoveryDryBlocks = 0;
    this.recoveryInProgress = false;
    this.processTimeoutRecoveryExhaustedEmitted = false;
    this.processBudgetMisses = 0;
    this.lastProcessBudgetExceeded = false;
    this.renderBudgetMisses = 0;
    this.lastRenderBudgetExceeded = false;
    this.dispatchEvent(new CustomEvent("retry", { detail: { health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return true;
  }

  getParameters() { return this.client.getParameters(this.requireControllableInstance()); }

  setPreset(presetId) { return this.client.setPreset(this.requireControllableInstance(), presetId); }

  setParameter(parameterId, normalizedValue) { return this.client.setParameter(this.requireControllableInstance(), parameterId, normalizedValue); }

  setParameterEvents(events) { return this.client.setParameterEvents(this.requireControllableInstance(), events); }

  setParameterCurve(parameterId, points, interpolation = "linear") {
    return this.client.setParameterCurve(this.requireControllableInstance(), parameterId, points, interpolation);
  }

  setAutomationLane(parameterId, points) { return this.client.setAutomationLane(this.requireControllableInstance(), parameterId, points); }

  clearAutomationLane(parameterId) { return this.client.clearAutomationLane(this.requireControllableInstance(), parameterId); }

  sendMidiEvents(events) { return this.client.sendMidiEvents(this.requireControllableInstance(), events); }

  async recreate() {
    const previousInstanceId = this.instanceId;
    const previousHealth = this.health;
    this.destroyed = false;
    this.recoveryInProgress = false;
    this.processTimeoutRecoveryAttempts = 0;
    this.dispatchEvent(new CustomEvent("recreate-started", { detail: { previousInstanceId, health: previousHealth } }));
    await this.destroyInstance().catch(() => void 0);
    try {
      await this.createInstance();
      const health = this.health;
      this.dispatchEvent(new CustomEvent("recreated", { detail: { previousInstanceId, health } }));
      return health;
    } catch (error) {
      this.failClosed(error, liveEffectFailureReason(error));
      this.dispatchEvent(new CustomEvent("recreate-failed", { detail: { error, previousInstanceId, health: this.health } }));
      throw error;
    }
  }

  async destroy() {
    this.destroyed = true;
    this.recoveryInProgress = false;
    await this.destroyInstance();
    this.healthy = false;
    this.unhealthyReason = "destroyed";
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  async refreshLatency(transportLatencySamples = 0) {
    if (!this.instanceId || !this.healthy) {
      return this.health;
    }
    const requestedTransportLatencySamples = boundedLiveEffectLatencySamples(transportLatencySamples, 0);
    const previousPluginLatencySamples = this.created?.latencySamples ?? 0;
    const previousTransportLatencySamples = this.transportLatencySamples;
    const previousReportedLatencySamples = this.reportedLatencySamples;
    const latency = await this.client.getLatency(this.instanceId, requestedTransportLatencySamples);
    const pluginLatencySamples = boundedLiveEffectLatencySamples(latency.pluginLatencySamples, previousPluginLatencySamples);
    const boundedTransportLatencySamples = boundedLiveEffectLatencySamples(
      latency.transportLatencySamples,
      previousTransportLatencySamples
    );
    if (this.created) {
      this.created.latencySamples = pluginLatencySamples;
    }
    this.transportLatencySamples = boundedTransportLatencySamples;
    this.reportedLatencySamples = combinedLiveEffectLatencySamples(pluginLatencySamples, boundedTransportLatencySamples);
    if (
      pluginLatencySamples !== previousPluginLatencySamples ||
      boundedTransportLatencySamples !== previousTransportLatencySamples ||
      this.reportedLatencySamples !== previousReportedLatencySamples
    ) {
      this.dispatchEvent(new CustomEvent("latencychange", { detail: this.health }));
    }
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return this.health;
  }

  async processBlock(request) {
    if (this.bypassed || !this.instanceId || !this.healthy) {
      const response = this.dryResponse(request, void 0);
      this.maybeRecoverFromFailure();
      return response;
    }
    if (this.isStaleInput(request.timestamp)) {
      this.staleInputBlocks = Math.min(1024, this.staleInputBlocks + 1);
      const response = this.dryResponse(request, void 0, "dry-stale-input");
      this.dispatchEvent(new CustomEvent("stale-input", { detail: { response, health: this.health } }));
      return response;
    }
    if (this.inFlightBlocks >= this.maxInFlightBlocks) {
      this.droppedInputBlocks = Math.min(1024, this.droppedInputBlocks + 1);
      const response = this.dryResponse(request, void 0, "dry-backpressure");
      this.dispatchEvent(new CustomEvent("input-backpressure", { detail: { response, health: this.health } }));
      return response;
    }

    let inFlightEpoch = this.inFlightEpoch;
    let outputStateVersion = this.outputStateVersion;
    const processStartedAt = liveEffectNowMs();
    try {
      const processRequest = {
        instanceId: this.instanceId,
        blockId: request.blockId,
        sampleRate: request.sampleRate ?? this.sampleRate,
        channels: boundedLiveEffectChannels(request.channels, this.inputChannels, this.maxBlockSize),
        inputBuses: boundedLiveEffectBusBlocks(request.inputBuses, this.maxBlockSize),
        transport: request.transport ?? liveTransportForBlock({ sampleRate: request.sampleRate ?? this.sampleRate, maxBlockSize: this.maxBlockSize, blockId: request.blockId, reportedLatencySamples: this.reportedLatencySamples, compensateOutputLatency: true }),
        timestamp: request.timestamp,
        renderTimeoutMs: this.processTimeoutMs > 0 ? this.processTimeoutMs : void 0
      };
      const requestTimeoutMs = this.processTimeoutMs > 0 ? this.processTimeoutMs : void 0;
      const processed =
        this.audioTransport === "binary"
          ? this.client.processAudioBlockBinary(processRequest, requestTimeoutMs)
          : this.client.processAudioBlock(
              {
                ...processRequest,
                channels: cloneLiveEffectChannels(processRequest.channels, this.maxBlockSize),
                inputBuses: cloneLiveEffectBusBlocks(processRequest.inputBuses, this.maxBlockSize)
              },
              requestTimeoutMs
            );
      this.inFlightBlocks += 1;
      inFlightEpoch = this.inFlightEpoch;
      outputStateVersion = this.outputStateVersion;
      processed.then(() => this.releaseInFlightBlock(inFlightEpoch), () => this.releaseInFlightBlock(inFlightEpoch));
      const response = await withLiveEffectTimeout(processed, this.processTimeoutMs);
      if (this.outputStateChanged(inFlightEpoch, outputStateVersion)) {
        return this.dryResponse(request, void 0, this.bypassed ? "dry-bypass" : "dry-state-changed");
      }
      if (this.recordProcessBudget(liveEffectNowMs() - processStartedAt)) {
        const error = new Error("process_budget_exceeded");
        this.failClosed(error, "process-budget-exceeded");
        return this.dryResponse(request, error);
      }
      if (this.isStaleInput(request.timestamp)) {
        this.staleOutputBlocks = Math.min(1024, this.staleOutputBlocks + 1);
        const dry = this.dryResponse(request, void 0, "dry-stale-output");
        this.dispatchEvent(new CustomEvent("stale-output", { detail: { response: dry, health: this.health } }));
        return dry;
      }
      this.recordResponseLatency(response);
      if (this.recordRenderBudget(response)) {
        const error = new Error("render_budget_exceeded");
        this.failClosed(error, "render-budget-exceeded");
        return this.dryResponse(request, error);
      }
      return this.finishResponse({ ...response, bypassed: false, healthy: true }, processRequest.channels, request.wetMix);
    } catch (error) {
      if (this.outputStateChanged(inFlightEpoch, outputStateVersion)) {
        return this.dryResponse(request, void 0, this.bypassed ? "dry-bypass" : "dry-state-changed");
      }
      this.recordProcessBudget(liveEffectNowMs() - processStartedAt);
      this.failClosed(error, liveEffectFailureReason(error));
      return this.dryResponse(request, error);
    }
  }

  async processScheduledBlock(scheduled, options = {}) {
    if (scheduled.stale) {
      this.staleInputBlocks = Math.min(1024, this.staleInputBlocks + 1);
      const response = this.dryResponse(scheduled.request, void 0, "dry-stale-input");
      this.dispatchEvent(new CustomEvent("stale-input", { detail: { response, health: this.health } }));
      return response;
    }
    if (shouldSkipLiveEffectDeadlinePressure(scheduled.deadlinePressure, options)) {
      const response = this.dryResponse(scheduled.request, void 0, "dry-deadline-pressure", scheduled.deadlinePressure);
      this.dispatchEvent(new CustomEvent("deadline-pressure", { detail: { response, health: this.health } }));
      return response;
    }
    return this.processBlock(scheduled.request);
  }

  async createInstance() {
    this.destroyed = false;
    this.created = await this.client.createInstance({
      pluginId: this.plugin.pluginId,
      format: this.plugin.format,
      sampleRate: this.sampleRate,
      maxBlockSize: this.maxBlockSize,
      inputChannels: this.inputChannels,
      outputChannels: this.outputChannels
    });
    this.healthy = true;
    this.lastError = void 0;
    this.unhealthyReason = void 0;
    this.recoveryDryBlocks = 0;
    this.recoveryInProgress = false;
    this.inFlightEpoch += 1;
    this.inFlightBlocks = 0;
    this.droppedInputBlocks = 0;
    this.staleInputBlocks = 0;
    this.staleOutputBlocks = 0;
    this.dryOutputBlocks = 0;
    this.processBudgetMisses = 0;
    this.lastProcessDurationMs = void 0;
    this.lastProcessBudgetMs = void 0;
    this.lastProcessBudgetExceeded = false;
    this.lastResponseDeadlineLeadMs = this.lastResponseDeadlineLeadBlocks = this.responseDeadlineLeadMinBlocks = this.responseDeadlineLeadMaxBlocks = void 0;
    this.responseJitterBlocks = this.responseDeadlineMisses = 0;
    this.transportLatencySamples = 0;
    this.reportedLatencySamples = this.created.latencySamples;
    this.renderBudgetMisses = 0;
    this.lastRenderDurationMs = void 0;
    this.lastRenderBudgetMs = void 0;
    this.lastRenderBudgetExceeded = false;
    this.lastRenderTimeoutMs = void 0;
    this.lastRenderTimeoutBudgetMs = void 0;
    this.lastRenderTimeoutBudgetDeltaMs = void 0;
    this.renderTimeouts = 0;
    this.consecutiveRenderTimeouts = 0;
    this.renderQuarantined = false;
    this.lastDryReason = void 0;
    this.lastOutputPath = void 0;
    this.lastOutputTail = void 0;
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  async destroyInstance() {
    const instanceId = this.instanceId;
    this.created = void 0;
    this.inFlightEpoch += 1;
    this.inFlightBlocks = 0;
    if (instanceId) {
      await this.client.destroyInstance(instanceId);
    }
  }

  dryResponse(request, error, renderEngine = "dry-bypass", deadlinePressure) {
    this.dryOutputBlocks = Math.min(Number.MAX_SAFE_INTEGER, this.dryOutputBlocks + 1);
    const response = this.finishResponse({
      blockId: request.blockId,
      channels: dryLiveEffectChannels(request.channels, this.outputChannels, this.maxBlockSize),
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine,
      bypassed: true,
      healthy: this.healthy,
      error,
      deadlinePressure
    });
    this.dispatchEvent(new CustomEvent("dry-output", { detail: { response, health: this.health, reason: this.lastDryReason, deadlinePressure } }));
    return response;
  }

  recordRenderBudget(response) {
    this.lastRenderDurationMs = boundedLiveEffectOptionalNumber(response.renderDurationMs, 0, 60000);
    this.lastRenderBudgetMs = boundedLiveEffectOptionalNumber(response.renderBudgetMs, 0, 60000);
    this.lastRenderBudgetExceeded = response.renderBudgetExceeded === true;
    this.renderBudgetMisses = this.lastRenderBudgetExceeded ? Math.min(1024, this.renderBudgetMisses + 1) : 0;
    if (this.lastRenderBudgetExceeded) {
      this.dispatchEvent(new CustomEvent("render-budget-exceeded", { detail: { response, health: this.health } }));
    }
    return this.maxConsecutiveRenderBudgetMisses > 0 && this.renderBudgetMisses >= this.maxConsecutiveRenderBudgetMisses;
  }

  recordProcessBudget(durationMs) {
    this.lastProcessDurationMs = boundedLiveEffectOptionalNumber(durationMs, 0, 60000);
    this.lastProcessBudgetMs = this.processBudgetMs > 0 ? this.processBudgetMs : void 0;
    this.recordResponseDeadlineLead();
    this.lastProcessBudgetExceeded = this.processBudgetMs > 0 && (this.lastProcessDurationMs ?? 0) > this.processBudgetMs;
    this.processBudgetMisses = this.lastProcessBudgetExceeded ? Math.min(1024, this.processBudgetMisses + 1) : 0;
    if (this.lastProcessBudgetExceeded) {
      this.dispatchEvent(new CustomEvent("process-budget-exceeded", { detail: { durationMs: this.lastProcessDurationMs, health: this.health } }));
    }
    return this.maxConsecutiveProcessBudgetMisses > 0 && this.processBudgetMisses >= this.maxConsecutiveProcessBudgetMisses;
  }

  recordResponseDeadlineLead() {
    if (!this.lastProcessBudgetMs || this.lastProcessDurationMs === void 0) return;
    this.lastResponseDeadlineLeadMs = boundedLiveEffectOptionalNumber(this.lastProcessBudgetMs - this.lastProcessDurationMs, -60000, 60000);
    this.lastResponseDeadlineLeadBlocks = this.lastResponseDeadlineLeadMs === void 0 ? void 0 : Number((this.lastResponseDeadlineLeadMs / (this.maxBlockSize / this.sampleRate * 1000)).toFixed(3));
    this.responseDeadlineLeadMinBlocks = Math.min(this.responseDeadlineLeadMinBlocks ?? this.lastResponseDeadlineLeadBlocks ?? 0, this.lastResponseDeadlineLeadBlocks ?? 0);
    this.responseDeadlineLeadMaxBlocks = Math.max(this.responseDeadlineLeadMaxBlocks ?? this.lastResponseDeadlineLeadBlocks ?? 0, this.lastResponseDeadlineLeadBlocks ?? 0);
    this.responseJitterBlocks = Number(((this.responseDeadlineLeadMaxBlocks ?? 0) - (this.responseDeadlineLeadMinBlocks ?? 0)).toFixed(3));
    if ((this.lastResponseDeadlineLeadMs ?? 0) < 0) {
      this.responseDeadlineMisses = Math.min(1024, this.responseDeadlineMisses + 1);
      this.dispatchEvent(new CustomEvent("response-deadline-missed", { detail: { durationMs: this.lastProcessDurationMs, budgetMs: this.lastProcessBudgetMs, leadMs: this.lastResponseDeadlineLeadMs, leadBlocks: this.lastResponseDeadlineLeadBlocks, health: this.health } }));
    }
  }

  recordResponseLatency(response) {
    if (!this.created) {
      return;
    }
    const latencySamples = boundedLiveEffectLatencySamples(response.latencySamples, this.created.latencySamples);
    if (latencySamples === this.created.latencySamples) {
      return;
    }
    this.created.latencySamples = latencySamples;
    this.reportedLatencySamples = combinedLiveEffectLatencySamples(latencySamples, this.transportLatencySamples);
    this.dispatchEvent(new CustomEvent("latencychange", { detail: this.health }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  maybeRecoverFromFailure() {
    if (this.unhealthyReason === "render-budget-exceeded") {
      this.maybeRecoverFromRenderPressure();
    } else if (this.unhealthyReason === "process-budget-exceeded") {
      this.maybeRecoverFromProcessBudget();
    } else if (this.unhealthyReason === "process-timeout") {
      this.maybeRecoverFromProcessTimeout();
    }
  }

  maybeRecoverFromRenderPressure() {
    if (this.healthy || this.unhealthyReason !== "render-budget-exceeded" || this.renderBudgetRecoveryBlocks <= 0) {
      return;
    }
    this.recoveryDryBlocks = Math.min(4096, this.recoveryDryBlocks + 1);
    if (this.recoveryDryBlocks < this.renderBudgetRecoveryBlocks) {
      return;
    }
    this.healthy = true;
    this.lastError = void 0;
    this.unhealthyReason = void 0;
    this.recoveryDryBlocks = 0;
    this.renderBudgetMisses = 0;
    this.lastRenderBudgetExceeded = false;
    this.dispatchEvent(new CustomEvent("render-budget-recovered", { detail: { health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  maybeRecoverFromProcessBudget() {
    if (this.healthy || this.unhealthyReason !== "process-budget-exceeded" || this.processBudgetRecoveryBlocks <= 0) {
      return;
    }
    this.recoveryDryBlocks = Math.min(4096, this.recoveryDryBlocks + 1);
    if (this.recoveryDryBlocks < this.processBudgetRecoveryBlocks) {
      return;
    }
    this.healthy = true;
    this.lastError = void 0;
    this.unhealthyReason = void 0;
    this.recoveryDryBlocks = 0;
    this.processBudgetMisses = 0;
    this.lastProcessBudgetExceeded = false;
    this.dispatchEvent(new CustomEvent("process-budget-recovered", { detail: { health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  maybeRecoverFromProcessTimeout() {
    if (this.healthy || this.destroyed || this.unhealthyReason !== "process-timeout" || this.recoveryInProgress) {
      return;
    }
    if (this.maxProcessTimeoutRecoveries <= 0 || this.processTimeoutRecoveryAttempts >= this.maxProcessTimeoutRecoveries) { this.dispatchProcessTimeoutRecoveryExhaustedIfNeeded(); return; }
    this.recoveryDryBlocks = Math.min(4096, this.recoveryDryBlocks + 1);
    if (this.recoveryDryBlocks < this.processTimeoutRecoveryBlocks) {
      return;
    }
    this.recoveryInProgress = true;
    this.processTimeoutRecoveryAttempts = Math.min(32, this.processTimeoutRecoveryAttempts + 1);
    this.dispatchEvent(new CustomEvent("process-timeout-recovery-started", { detail: { health: this.health } }));
    this.recoverFromProcessTimeout();
  }

  async recoverFromProcessTimeout() {
    try {
      await this.destroyInstance().catch(() => void 0);
      if (this.destroyed) {
        return;
      }
      await this.createInstance();
      this.dispatchEvent(new CustomEvent("process-timeout-recovered", { detail: { health: this.health } }));
    } catch (error) {
      if (this.destroyed) {
        return;
      }
      this.recoveryInProgress = false;
      this.failClosed(error, "processing-error");
    }
  }

  failClosed(error, reason) {
    this.healthy = false;
    this.lastError = error;
    this.unhealthyReason = reason;
    this.recordRenderDeadlineDiagnostics(error);
    this.recoveryDryBlocks = 0;
    this.recoveryInProgress = false;
    this.dispatchEvent(new CustomEvent("effect-error", { detail: { error, health: this.health } }));
    if (reason === "process-budget-exceeded") {
      this.dispatchEvent(new CustomEvent("process-budget-tripped", { detail: { error, health: this.health } }));
    } else if (reason === "render-budget-exceeded") {
      this.dispatchEvent(new CustomEvent("render-budget-tripped", { detail: { error, health: this.health } }));
    } else if (reason === "process-timeout") {
      this.dispatchEvent(new CustomEvent("process-timeout", { detail: { error, health: this.health } }));
      this.dispatchEvent(new CustomEvent("process-timeout-tripped", { detail: { error, health: this.health } }));
      this.dispatchProcessTimeoutRecoveryExhaustedIfNeeded();
    }
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  processTimeoutRecoveryExhausted() { return this.unhealthyReason === "process-timeout" && !this.recoveryInProgress && (this.maxProcessTimeoutRecoveries <= 0 || this.processTimeoutRecoveryAttempts >= this.maxProcessTimeoutRecoveries); }

  recoveryDryBlocksRemaining() { const target = this.unhealthyReason === "render-budget-exceeded" ? this.renderBudgetRecoveryBlocks : this.unhealthyReason === "process-budget-exceeded" ? this.processBudgetRecoveryBlocks : this.unhealthyReason === "process-timeout" && !this.processTimeoutRecoveryExhausted() && !this.recoveryInProgress ? this.processTimeoutRecoveryBlocks : 0; return Math.max(0, target - this.recoveryDryBlocks); }

  dispatchProcessTimeoutRecoveryExhaustedIfNeeded() { if (!this.processTimeoutRecoveryExhausted() || this.processTimeoutRecoveryExhaustedEmitted) return; this.processTimeoutRecoveryExhaustedEmitted = true; this.dispatchEvent(new CustomEvent("process-timeout-recovery-exhausted", { detail: { health: this.health } })); }

  recordRenderDeadlineDiagnostics(error) {
    if (!isRenderDeadlineProtocolError(error)) {
      return;
    }
    const details = renderDeadlineDetails(error);
    this.lastRenderTimeoutMs = boundedLiveEffectOptionalNumber(details.renderTimeoutMs, 0, 60000);
    this.lastRenderTimeoutBudgetMs = boundedLiveEffectOptionalNumber(details.renderBudgetMs, 0, 60000);
    this.lastRenderTimeoutBudgetDeltaMs = boundedLiveEffectOptionalNumber(details.renderTimeoutBudgetDeltaMs, -60000, 60000);
    this.renderTimeouts = boundedLiveEffectInteger(details.renderTimeouts, Math.max(1, this.renderTimeouts), 0, 1e6);
    this.consecutiveRenderTimeouts = boundedLiveEffectInteger(
      details.consecutiveRenderTimeouts,
      Math.max(1, this.consecutiveRenderTimeouts),
      0,
      1e6
    );
    this.renderQuarantined = details.renderQuarantined === true || error.code === "render_quarantined" || error.code === "render_timeout";
  }

  isStaleInput(timestamp) {
    const capturedAt = Number(timestamp);
    return this.maxInputAgeMs > 0 && Number.isFinite(capturedAt) && liveEffectNowMs() - capturedAt > this.maxInputAgeMs;
  }

  releaseInFlightBlock(epoch) {
    if (epoch !== this.inFlightEpoch) {
      return;
    }
    this.inFlightBlocks = Math.max(0, this.inFlightBlocks - 1);
  }

  outputStateChanged(epoch, stateVersion) {
    return (
      epoch !== this.inFlightEpoch ||
      stateVersion !== this.outputStateVersion ||
      this.destroyed ||
      this.bypassed ||
      !this.instanceId ||
      !this.healthy
    );
  }

  requireControllableInstance() {
    if (this.destroyed || !this.instanceId || !this.healthy) {
      throw new Error("SoundBridgeLiveEffectRack is not controllable while destroyed, missing an instance, or unhealthy.");
    }
    return this.instanceId;
  }

  finishResponse(response, dryInput, wetMixOverride) {
    const outputPath = response.bypassed ? "dry" : "wet";
    const dryReason = response.bypassed ? liveEffectDryReason(response.renderEngine, this.unhealthyReason) : void 0;
    if (this.lastDryReason !== dryReason) {
      this.lastDryReason = dryReason;
      this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    }
    const mixed = response.bypassed ? boundedLiveEffectChannels(response.channels, this.outputChannels, this.maxBlockSize) : wetMixedLiveEffectChannels(response.channels, dryInput, this.outputChannels, boundedLiveEffectWetMix(wetMixOverride, this.wetMix), this.maxBlockSize);
    const channels = transitionLiveEffectOutputChannels(mixed, this.lastOutputTail, this.lastOutputPath, outputPath, this.transitionFadeSamples);
    this.lastOutputTail = liveEffectOutputTail(channels, this.outputChannels);
    this.lastOutputPath = outputPath;
    return channels === response.channels ? response : { ...response, channels };
  }
}

function boundedLiveEffectChannelCount(value) {
  const channels = Math.floor(Number(value));
  return Number.isFinite(channels) ? Math.max(1, Math.min(32, channels)) : 2;
}

function boundedLiveEffectInteger(value, fallback, min, max) {
  const integer = Math.floor(Number(value ?? fallback));
  return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
}

function boundedLiveEffectNumber(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function liveEffectBlockDurationMs(sampleRate, maxBlockSize) {
  const rate = Number(sampleRate);
  const frames = Number(maxBlockSize);
  return Number.isFinite(rate) && rate > 0 && Number.isFinite(frames) && frames > 0 ? (frames / rate) * 1000 : 0;
}

function liveEffectBlockFrames(maxBlockSize) {
  const frames = Math.floor(Number(maxBlockSize));
  return Number.isFinite(frames) && frames > 0 ? Math.min(frames, 8192) : 0;
}

function boundedLiveEffectOptionalNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : void 0;
}

function boundedLiveEffectLatencySamples(value, fallback) {
  const bounded = boundedLiveEffectOptionalNumber(value, 0, LIVE_EFFECT_MAX_LATENCY_SAMPLES);
  if (bounded !== void 0) {
    return Math.floor(bounded);
  }
  return Math.floor(boundedLiveEffectOptionalNumber(fallback, 0, LIVE_EFFECT_MAX_LATENCY_SAMPLES) ?? 0);
}

function combinedLiveEffectLatencySamples(pluginLatencySamples, transportLatencySamples) {
  return Math.min(LIVE_EFFECT_MAX_LATENCY_SAMPLES, pluginLatencySamples + transportLatencySamples);
}

function boundedLiveEffectWetMix(value, fallback) {
  return boundedLiveEffectNumber(value, fallback, 0, 1);
}

function isRecoverableLiveEffectPressureReason(reason) {
  return reason === "process-budget-exceeded" || reason === "render-budget-exceeded";
}

function liveEffectLatencyMilliseconds(samples, sampleRate) {
  const boundedSamples = boundedLiveEffectLatencySamples(samples, 0);
  const boundedSampleRate = boundedLiveEffectInteger(sampleRate, 48000, 1, 384000);
  return Number(((boundedSamples / boundedSampleRate) * 1000).toFixed(3));
}

function liveEffectRackTiming(sampleRate, maxBlockSize, pluginLatencySamples, transportLatencySamples, reportedLatencySamples, processBudgetMs, processTimeoutMs, maxInputAgeMs, transitionFadeSamples) {
  const rate = boundedLiveEffectInteger(sampleRate, 48000, 1, 384000);
  const frames = liveEffectBlockFrames(maxBlockSize);
  const blockDurationMs = Number(liveEffectBlockDurationMs(rate, frames).toFixed(3));
  const pluginSamples = boundedLiveEffectLatencySamples(pluginLatencySamples, 0);
  const transportSamples = boundedLiveEffectLatencySamples(transportLatencySamples, 0);
  const reportedSamples = boundedLiveEffectLatencySamples(reportedLatencySamples, combinedLiveEffectLatencySamples(pluginSamples, transportSamples));
  const budgetMs = boundedLiveEffectNumber(processBudgetMs, 0, 0, 60000);
  const timeoutMs = boundedLiveEffectNumber(processTimeoutMs, 0, 0, 60000);
  const inputAgeMs = boundedLiveEffectNumber(maxInputAgeMs, 0, 0, 60000);
  const fadeSamples = boundedLiveEffectInteger(transitionFadeSamples, 0, 0, 4096);
  return {
    sampleRate: rate,
    maxBlockSize: frames,
    blockDurationMs,
    pluginLatencySamples: pluginSamples,
    transportLatencySamples: transportSamples,
    reportedLatencySamples: reportedSamples,
    pluginLatencyBlocks: liveEffectBlockUnits(pluginSamples, frames),
    transportLatencyBlocks: liveEffectBlockUnits(transportSamples, frames),
    reportedLatencyBlocks: liveEffectBlockUnits(reportedSamples, frames),
    pluginLatencyMs: liveEffectLatencyMilliseconds(pluginSamples, rate),
    transportLatencyMs: liveEffectLatencyMilliseconds(transportSamples, rate),
    reportedLatencyMs: liveEffectLatencyMilliseconds(reportedSamples, rate),
    processBudgetMs: budgetMs,
    processBudgetBlocks: liveEffectBlockUnits(budgetMs, blockDurationMs),
    processTimeoutMs: timeoutMs,
    processTimeoutBlocks: liveEffectBlockUnits(timeoutMs, blockDurationMs),
    maxInputAgeMs: inputAgeMs,
    maxInputAgeBlocks: liveEffectBlockUnits(inputAgeMs, blockDurationMs),
    transitionFadeSamples: fadeSamples,
    transitionFadeBlocks: liveEffectBlockUnits(fadeSamples, frames)
  };
}

async function withLiveEffectTimeout(promise, timeoutMs) {
  if (timeoutMs <= 0) {
    return promise;
  }
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(liveEffectTimeoutError()), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function liveEffectTimeoutError() {
  const error = new Error("process_block_timeout");
  error.name = "SoundBridgeLiveEffectTimeout";
  return error;
}

function liveEffectFailureReason(error) {
  return error instanceof Error && error.name === "SoundBridgeLiveEffectTimeout" || isRenderDeadlineProtocolError(error)
    ? "process-timeout"
    : "processing-error";
}

function liveEffectDryReason(renderEngine, fallback) {
  if (fallback === "processing-error" || fallback === "process-timeout" || fallback === "process-budget-exceeded" || fallback === "render-budget-exceeded" || fallback === "destroyed") return fallback;
  if (renderEngine === "dry-backpressure") return "backpressure";
  if (renderEngine === "dry-deadline-pressure") return "deadline-pressure";
  if (renderEngine === "dry-stale-input") return "stale-input";
  if (renderEngine === "dry-stale-output") return "stale-output";
  return renderEngine === "dry-state-changed" ? "state-changed" : "bypass";
}

function isRenderDeadlineProtocolError(error) {
  const code = error instanceof SoundBridgeProtocolError ? error.code : typeof error === "object" && error !== null ? error.code : void 0;
  return code === "render_timeout" || code === "render_quarantined";
}

function renderDeadlineDetails(error) {
  return typeof error.details === "object" && error.details !== null ? error.details : {};
}

function liveEffectNowMs() {
  return typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();
}

function liveEffectBlockUnits(value, blockValue) {
  return blockValue > 0 ? Number((value / blockValue).toFixed(3)) : 0;
}

function optionalLiveTransportNumber(value, min, max) {
  if (value === void 0 || value === null) return void 0;
  return roundedLiveTransportMusic(boundedLiveEffectNumber(value, min, min, max));
}

function boundedLiveTransportDenominator(value, fallback) {
  const requested = boundedLiveEffectInteger(value, fallback, 1, 64);
  return LIVE_TRANSPORT_DENOMINATORS.find((denominator) => denominator >= requested) ?? 64;
}

function liveTransportPositionMusic(projectTimeMusic, samplePosition, sampleRate, tempo, offset) {
  const explicit = optionalLiveTransportNumber(projectTimeMusic, 0, LIVE_TRANSPORT_MAX_MUSIC);
  if (explicit !== void 0) return explicit;
  if (tempo === void 0) return void 0;
  const base = optionalLiveTransportNumber(offset, 0, LIVE_TRANSPORT_MAX_MUSIC) ?? 0;
  return optionalLiveTransportNumber(base + (samplePosition / sampleRate) * (tempo / 60), 0, LIVE_TRANSPORT_MAX_MUSIC);
}

function liveTransportBarPositionMusic(projectTimeMusic, numerator, denominator) {
  const barLength = numerator * (4 / denominator);
  return barLength > 0 ? roundedLiveTransportMusic(Math.floor(projectTimeMusic / barLength) * barLength) : 0;
}

function roundedLiveTransportMusic(value) {
  return Number(value.toFixed(6));
}

function transitionLiveEffectOutputChannels(channels, previousTail, previousPath, outputPath, fadeSamples) {
  if (fadeSamples <= 0 || !previousTail || previousPath === void 0 || previousPath === outputPath) {
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

function wetMixedLiveEffectChannels(wetChannels, dryInput, outputChannels, wetMix, maxFrames = Number.MAX_SAFE_INTEGER) {
  const wetOutput = boundedLiveEffectChannels(wetChannels, outputChannels, maxFrames);
  if (wetMix >= 1) {
    return wetOutput;
  }
  const dry = dryLiveEffectChannels(dryInput ?? [], outputChannels, maxFrames);
  if (wetMix <= 0) {
    return dry;
  }
  return Array.from({ length: outputChannels }, (_, channelIndex) => {
    const wet = wetOutput.length > 0 ? wetOutput[channelIndex % wetOutput.length] : [];
    const dryChannel = dry[channelIndex];
    const frames = Math.max(wet.length, dryChannel.length);
    return Array.from({ length: frames }, (_unused, frame) => Number(dryChannel[frame] ?? 0) * (1 - wetMix) + Number(wet[frame] ?? 0) * wetMix);
  });
}

function boundedLiveEffectChannels(channels, channelCount, maxFrames) {
  const count = boundedLiveEffectAudioCount(channelCount);
  const frames = boundedLiveEffectAudioFrames(channels, count, maxFrames);
  let changed = channels.length !== count;
  const bounded = Array.from({ length: count }, (_, index) => {
    const source = channels.length > 0 ? channels[index % channels.length] : void 0;
    if (liveEffectChannelLength(source) <= 0) {
      changed = true;
      return Array.from({ length: frames }, () => 0);
    }
    const normalized = normalizedLiveEffectChannel(source, frames);
    if (normalized) {
      changed = true;
      return normalized;
    }
    return source;
  });
  return changed ? bounded : channels;
}

function boundedLiveEffectBusBlocks(buses, maxFrames) {
  const bounded = [];
  const seen = new Set();
  for (const bus of buses ?? []) {
    const index = Math.floor(Number(bus.index));
    if (!Number.isFinite(index) || index < 0 || index > 31 || seen.has(index)) continue;
    seen.add(index);
    bounded.push({ index, channels: boundedLiveEffectChannels(bus.channels ?? [], bus.channels?.length ?? 1, maxFrames) });
    if (bounded.length >= 32) break;
  }
  return bounded.length > 0 ? bounded : void 0;
}

function liveEffectOutputTail(channels, outputChannels) {
  return Array.from({ length: outputChannels }, (_, index) => {
    const channel = channels.length > 0 ? channels[index % channels.length] : void 0;
    const sample = Number(channel?.[Math.max(0, channel.length - 1)] ?? 0);
    return Number.isFinite(sample) ? sample : 0;
  });
}

function cloneLiveEffectChannels(channels, maxFrames = Number.MAX_SAFE_INTEGER) {
  return boundedLiveEffectChannels(channels, channels.length, maxFrames).map((channel) => Array.from(channel));
}

function cloneLiveEffectBusBlocks(buses, maxFrames = Number.MAX_SAFE_INTEGER) {
  return boundedLiveEffectBusBlocks(buses, maxFrames)?.map((bus) => ({ index: bus.index, channels: cloneLiveEffectChannels(bus.channels, maxFrames) }));
}

function dryLiveEffectChannels(channels, outputChannels, maxFrames = Number.MAX_SAFE_INTEGER) {
  const bounded = boundedLiveEffectChannels(channels, outputChannels, maxFrames);
  const frames = bounded[0]?.length ?? 0;
  return Array.from({ length: outputChannels }, (_, index) => {
    const source = bounded.length > 0 ? bounded[index % bounded.length] : void 0;
    return source ? Array.from(source) : Array.from({ length: frames }, () => 0);
  });
}

function boundedLiveEffectAudioCount(value) {
  const count = Math.floor(Number(value));
  return Number.isFinite(count) ? Math.max(1, Math.min(32, count)) : 1;
}

function boundedLiveEffectAudioFrames(channels, channelCount, maxFrames) {
  let frames = 0;
  const count = Math.min(channelCount, channels.length);
  for (let index = 0; index < count; index += 1) frames = Math.max(frames, liveEffectChannelLength(channels[index]));
  const max = Math.floor(Number(maxFrames));
  if (!Number.isFinite(frames) || frames <= 0) return 0;
  return Number.isFinite(max) && max > 0 ? Math.min(frames, Math.min(max, 8192)) : Math.min(frames, 8192);
}

function normalizedLiveEffectChannel(channel, frames) {
  if (liveEffectChannelLength(channel) !== frames) return Array.from({ length: frames }, (_unused, index) => finiteLiveEffectSample(channel[index]));
  for (let index = 0; index < frames; index += 1) {
    if (!Number.isFinite(Number(channel[index] ?? 0))) return Array.from({ length: frames }, (_unused, frame) => finiteLiveEffectSample(channel[frame]));
  }
  return void 0;
}

function liveEffectChannelLength(channel) {
  const length = Math.floor(Number(channel?.length ?? 0));
  return Number.isFinite(length) && length > 0 ? length : 0;
}

function finiteLiveEffectSample(value) {
  const sample = Number(value ?? 0);
  return Number.isFinite(sample) ? sample : 0;
}

const PARAMETER_CATEGORY_PATTERNS = [
  ["wave", /\b(wave\s*shaper|waveshaper|wave\s*fold|wavefold|fold|shape|shaper)\b/u],
  ["drive", /\b(drive|distortion|saturat|clip|crush|fuzz|overdrive)\b/u],
  ["gain", /\b(gain|volume|level|trim|input|output|makeup)\b/u],
  ["filter", /\b(cutoff|freq|frequency|filter|tone|brightness|color)\b/u],
  ["resonance", /\b(resonance|reso|res|q|emphasis|bandwidth)\b/u],
  ["envelope", /\b(attack|decay|sustain|release|adsr|envelope|env|hold)\b/u],
  ["mix", /\b(mix|blend|wet|dry)\b/u],
  ["pan", /\b(pan|balance|width|spread|stereo)\b/u],
  ["pitch", /\b(pitch|tune|detune|octave|semitone|transpose|cent)\b/u],
  ["modulation", /\b(lfo|mod|modulation|rate|depth|vibrato|tremolo)\b/u],
  ["space", /\b(reverb|delay|echo|room|size|feedback|damping)\b/u],
  ["midi", /\b(midi|cc|controller|note|velocity|aftertouch|expression)\b/u],
  ["timing", /\b(sync|tempo|time|bpm|swing)\b/u],
  ["program", /\b(program|preset|patch|bank)\b/u]
];
export function renderParameterControls(options) {
  const { container, client, instanceId, parameters } = options;
  container.replaceChildren();

  for (const parameter of parameters) {
    const row = document.createElement("label");
    row.className = "parameter-row";
    row.dataset.parameterCategory = parameterCategory(parameter);
    row.dataset.parameterId = parameter.id;

    const name = document.createElement("span");
    name.className = "parameter-name";
    name.textContent = parameter.name;

    const value = document.createElement("output");
    value.className = "parameter-value";
    value.value = formatParameterValue(parameter);

    const programs = parameter.programList?.programs ?? [];
    const control = programs.length > 0 ? document.createElement("select") : document.createElement("input");
    const disabled = parameter.readOnly === true || !parameter.automatable;
    if (control instanceof HTMLSelectElement) {
      for (const program of programs) {
        const option = document.createElement("option");
        option.value = String(program.normalizedValue);
        option.textContent = program.name;
        option.selected = Math.abs(program.normalizedValue - parameter.normalizedValue) < 0.000001;
        control.append(option);
      }
      control.disabled = disabled;
      control.addEventListener("change", () => {
        const normalizedValue = Number(control.value);
        const selectedProgram = programs.find((program) => Math.abs(program.normalizedValue - normalizedValue) < 0.000001);
        value.value = selectedProgram?.name ?? formatParameterValue({ ...parameter, normalizedValue, displayValue: void 0 });
        void client.setParameter(instanceId, parameter.id, normalizedValue).then(({ parameter: updated }) => {
          value.value = formatParameterValue(updated);
        });
      });
    } else {
      control.type = "range";
      control.min = "0";
      control.max = "1";
      control.step = "0.001";
      control.value = String(parameter.normalizedValue);
      control.disabled = disabled;
      control.addEventListener("input", () => {
        const normalizedValue = Number(control.value);
        value.value = formatParameterValue({ ...parameter, normalizedValue, displayValue: void 0 });
        void client.setParameter(instanceId, parameter.id, normalizedValue).then(({ parameter: updated }) => {
          value.value = formatParameterValue(updated);
        });
      });
    }

    row.append(name, control, value);
    container.append(row);
  }
}

function parameterCategory(parameter) {
  if (parameter.programChange || parameter.programList) {
    return "program";
  }
  const label = `${parameter.id} ${parameter.name} ${parameter.unit ?? ""}`.toLowerCase();
  for (const [category, pattern] of PARAMETER_CATEGORY_PATTERNS) {
    if (pattern.test(label)) {
      return category;
    }
  }
  return parameter.readOnly ? "status" : "utility";
}

function formatParameterValue(parameter) {
  if (parameter.displayValue) {
    return parameter.displayValue;
  }
  const programs = parameter.programList?.programs ?? [];
  const selectedProgram = programs.find((program) => Math.abs(program.normalizedValue - parameter.normalizedValue) < 0.000001);
  if (selectedProgram) {
    return selectedProgram.name;
  }
  const min = parameter.minPlain ?? 0;
  const max = parameter.maxPlain ?? 1;
  const plain = parameter.plainValue ?? min + (max - min) * parameter.normalizedValue;
  const suffix = parameter.unit ? ` ${parameter.unit}` : "";
  return `${plain.toFixed(2)}${suffix}`;
}
