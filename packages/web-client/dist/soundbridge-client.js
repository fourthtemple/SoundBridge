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

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`Unable to connect to ${this.url}`)), { once: true });
      socket.addEventListener("message", (event) => this.handleMessage(event.data));
      socket.addEventListener("close", () => {
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timeout);
          pending.reject(new Error(`SoundBridge socket closed before response ${id}.`));
        }
        this.pending.clear();
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

  createAudioWorkletTransportPort(options) {
    return this.createAudioWorkletTransportConnection(options)?.port;
  }

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

  heartbeat() {
    return this.request("heartbeat", { now: Date.now() });
  }

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
      const timeout = globalThis.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SoundBridge request timed out: ${command}`));
      }, timeoutMs);
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
const MAX_BINARY_CHANNELS = 32;
const MAX_BINARY_FRAMES = 8192;
const MAX_BINARY_BUSES = 32;
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
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const blocks = [mainBlock, ...inputBuses, ...outputBuses];
  const sampleBytes = blocks.reduce((total, block) => total + block.channels.length * block.frames * FLOAT_BYTES, 0);
  const buffer = new ArrayBuffer(BINARY_AUDIO_HEADER_BYTES + headerBytes.length + sampleBytes);
  const view = new DataView(buffer);
  view.setUint32(0, BINARY_AUDIO_MAGIC, false);
  view.setUint32(4, headerBytes.length, false);
  new Uint8Array(buffer, BINARY_AUDIO_HEADER_BYTES, headerBytes.length).set(headerBytes);
  writeBinaryBlocks(view, BINARY_AUDIO_HEADER_BYTES + headerBytes.length, blocks);
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
  const envelope = JSON.parse(new TextDecoder().decode(headerBytes));
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
  const limited = channels.slice(0, MAX_BINARY_CHANNELS);
  const frames = Math.max(1, Math.min(MAX_BINARY_FRAMES, Math.max(0, ...limited.map((channel) => Math.max(0, Math.floor(Number(channel.length ?? 0)) || 0)))));
  return {
    channels: limited.map((channel) => {
      const normalized = new Float32Array(frames);
      for (let index = 0; index < frames; index += 1) {
        const value = Number(channel[index] ?? 0);
        normalized[index] = Number.isFinite(value) ? value : 0;
      }
      return normalized;
    }),
    frames
  };
}

function normalizeBinaryBuses(buses) {
  if (!Array.isArray(buses)) {
    return [];
  }
  const seen = /* @__PURE__ */ new Set();
  return buses.slice(0, MAX_BINARY_BUSES).map((bus) => {
    const index = boundedBinaryInteger(bus?.index, 0, MAX_BINARY_BUSES - 1);
    if (seen.has(index)) {
      throw new Error("binary_audio_duplicate_bus");
    }
    seen.add(index);
    return { index, ...normalizeBinaryBlock(Array.isArray(bus?.channels) ? bus.channels : []) };
  });
}

function busHeaders(buses) {
  return buses.map((bus) => ({ index: bus.index, channels: bus.channels.length, frames: bus.frames }));
}

function writeBinaryBlocks(view, offset, blocks) {
  for (const block of blocks) {
    for (const channel of block.channels) {
      for (const sample of channel) {
        view.setFloat32(offset, sample, true);
        offset += FLOAT_BYTES;
      }
    }
  }
}

function readBinaryBlock(view, offset, channelCount, frames) {
  const byteLength = channelCount * frames * FLOAT_BYTES;
  if (offset + byteLength > view.byteLength) {
    throw new Error("invalid_binary_audio_payload");
  }
  return {
    channels: readBinaryChannels(view, offset, channelCount, frames),
    offset: offset + byteLength
  };
}

function readBinaryBuses(view, offset, specs) {
  if (specs === void 0) {
    return { blocks: [], offset };
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
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channel = new Float32Array(frames);
    for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
      channel[frameIndex] = view.getFloat32(offset, true);
      offset += FLOAT_BYTES;
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
const LIVE_AUDIO_NODE_SHARED_BUFFER_BLOCKS = 4;
const LIVE_AUDIO_NODE_AUDIO_REQUEST_TIMEOUT_MS = 250;

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

  return {
    ...options,
    maxInFlightBlocks: boundedAudioNodeInteger(options.maxInFlightBlocks, LIVE_AUDIO_NODE_MAX_IN_FLIGHT_BLOCKS, 1, 64),
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
    audioTransport: options.audioTransport === "json" ? "json" : "binary",
    audioRequestTimeoutMs: boundedAudioNodeInteger(options.audioRequestTimeoutMs, LIVE_AUDIO_NODE_AUDIO_REQUEST_TIMEOUT_MS, 0, 60000),
    audioTransferMode: options.audioTransferMode ?? "auto",
    sharedBufferBlocks: boundedAudioNodeInteger(options.sharedBufferBlocks, LIVE_AUDIO_NODE_SHARED_BUFFER_BLOCKS, 2, 64),
    maxBlockFrames: boundedAudioNodeInteger(options.maxBlockFrames, 128, 1, 8192)
  };
}

export class SoundBridgeAudioNode extends EventTarget {
  constructor(context, client, options) {
    super();
    this.client = client;
    this.instanceId = options.instanceId;
    this.sampleRate = context.sampleRate;
    this.maxInFlightBlocks = options.maxInFlightBlocks;
    this.audioTransport = options.audioTransport;
    this.audioRequestTimeoutMs = options.audioRequestTimeoutMs;
    this.inFlightBlocks = 0;
    this.destroyed = false;
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
        latencyMissThresholdBlocks: options.latencyMissThresholdBlocks,
        latencyRecoveryBlocks: options.latencyRecoveryBlocks,
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
      inputChannels: Math.max(1, Math.min(32, Math.floor(options.inputChannels ?? 2))),
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
      audioTransport: options.audioTransport === "json" ? "json" : "binary",
      audioRequestTimeoutMs: boundedAudioNodeInteger(options.audioRequestTimeoutMs, 2000, 0, 60000),
      audioTransferMode: options.audioTransferMode ?? "auto",
      sharedBufferBlocks: boundedAudioNodeInteger(options.sharedBufferBlocks, 8, 2, 64),
      maxBlockFrames: boundedAudioNodeInteger(options.maxBlockFrames, 128, 1, 8192),
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

  disconnect() {
    this.node.disconnect();
  }

  async destroy() {
    this.destroyed = true;
    this.node.port.postMessage({ type: "destroy" });
    await this.client.destroyInstance(this.instanceId);
  }

  handleWorkletMessage(message) {
    if (this.destroyed || !message || typeof message !== "object") {
      return;
    }

    if (message.type === "stats") {
      this.dispatchEvent(new CustomEvent("stats", { detail: message }));
      return;
    }

    if (message.type === "process-diagnostics") {
      this.dispatchEvent(new CustomEvent("process-diagnostics", { detail: message }));
      return;
    }

    if (message.type === "audio-error") {
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
    const requestedSamplePosition = Math.floor(message.blockId * frames);
    const samplePosition = Number.isFinite(requestedSamplePosition)
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, requestedSamplePosition))
      : 0;
    const request = {
      instanceId: this.instanceId,
      blockId: message.blockId,
      sampleRate: this.sampleRate,
      channels: binaryChannels,
      transport: {
        playing: true,
        samplePosition
      },
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
        if (typeof response.renderEngine === "string") {
          this.dispatchEvent(
            new CustomEvent("process-diagnostics", {
              detail: {
                blockId: response.blockId,
                renderEngine: response.renderEngine,
                renderDurationMs: response.renderDurationMs,
                renderBudgetMs: response.renderBudgetMs,
                renderBudgetExceeded: response.renderBudgetExceeded
              }
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
        this.dispatchEvent(new CustomEvent("audio-error", { detail: error }));
        this.node.port.postMessage({ type: "audio-error", blockId: message.blockId, error: String(error instanceof Error ? error.message : error) });
      })
      .finally(() => {
        this.inFlightBlocks -= 1;
      });
  }
}

function boundedAudioNodeInteger(value, fallback, min, max) {
  const integer = Math.floor(Number(value ?? fallback));
  return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
}

const LIVE_PERFORMANCE_INPUT_AGE_BLOCKS = 4;
const LIVE_PERFORMANCE_PROCESS_TIMEOUT_BLOCKS = 4;
const LIVE_PERFORMANCE_TRANSITION_FADE_BLOCKS = 0.5;
const LIVE_PERFORMANCE_RECOVERY_BLOCKS = 16;

export function createLivePerformanceRackOptions(options) {
  const {
    maxInputAgeBlocks,
    processTimeoutBlocks,
    transitionFadeBlocks,
    ...rackOptions
  } = options;
  const blockMs = liveEffectBlockDurationMs(options.sampleRate, options.maxBlockSize);
  const blockFrames = liveEffectBlockFrames(options.maxBlockSize);
  const inputAgeBlocks = boundedLiveEffectNumber(maxInputAgeBlocks, LIVE_PERFORMANCE_INPUT_AGE_BLOCKS, 0, 128);
  const timeoutBlocks = boundedLiveEffectNumber(processTimeoutBlocks, LIVE_PERFORMANCE_PROCESS_TIMEOUT_BLOCKS, 0, 128);
  const fadeBlocks = boundedLiveEffectNumber(transitionFadeBlocks, LIVE_PERFORMANCE_TRANSITION_FADE_BLOCKS, 0, 8);

  return {
    ...rackOptions,
    audioTransport: options.audioTransport ?? "binary",
    maxInputAgeMs: boundedLiveEffectNumber(options.maxInputAgeMs, blockMs * inputAgeBlocks, 0, 60000),
    maxInFlightBlocks: boundedLiveEffectInteger(options.maxInFlightBlocks, 1, 1, 32),
    processTimeoutMs: boundedLiveEffectNumber(options.processTimeoutMs, blockMs * timeoutBlocks, 0, 60000),
    transitionFadeSamples: boundedLiveEffectInteger(options.transitionFadeSamples, Math.ceil(blockFrames * fadeBlocks), 0, 4096),
    maxConsecutiveRenderBudgetMisses: boundedLiveEffectInteger(options.maxConsecutiveRenderBudgetMisses, 2, 0, 1024),
    renderBudgetRecoveryBlocks: boundedLiveEffectInteger(options.renderBudgetRecoveryBlocks, LIVE_PERFORMANCE_RECOVERY_BLOCKS, 0, 4096)
  };
}

export class SoundBridgeLiveEffectRack extends EventTarget {
  constructor(options) {
    super();
    this.created = void 0;
    this.bypassed = false;
    this.healthy = true;
    this.lastError = void 0;
    this.unhealthyReason = void 0;
    this.recoveryDryBlocks = 0;
    this.inFlightEpoch = 0;
    this.inFlightBlocks = 0;
    this.droppedInputBlocks = 0;
    this.staleInputBlocks = 0;
    this.renderBudgetMisses = 0;
    this.lastRenderDurationMs = void 0;
    this.lastRenderBudgetMs = void 0;
    this.lastRenderBudgetExceeded = false;
    this.lastOutputPath = void 0;
    this.lastOutputTail = void 0;
    this.client = options.client;
    this.plugin = options.plugin;
    this.sampleRate = options.sampleRate;
    this.maxBlockSize = options.maxBlockSize;
    this.inputChannels = boundedLiveEffectChannelCount(options.inputChannels ?? options.plugin.inputs ?? 2);
    this.outputChannels = boundedLiveEffectChannelCount(options.outputChannels ?? options.plugin.outputs ?? this.inputChannels);
    this.audioTransport = options.audioTransport === "json" ? "json" : "binary";
    this.maxInputAgeMs = boundedLiveEffectNumber(options.maxInputAgeMs, 0, 0, 60000);
    this.maxInFlightBlocks = boundedLiveEffectInteger(options.maxInFlightBlocks, 1, 1, 32);
    this.processTimeoutMs = boundedLiveEffectNumber(options.processTimeoutMs, 0, 0, 60000);
    this.transitionFadeSamples = boundedLiveEffectInteger(options.transitionFadeSamples, 0, 0, 4096);
    this.maxConsecutiveRenderBudgetMisses = boundedLiveEffectInteger(options.maxConsecutiveRenderBudgetMisses, 3, 0, 1024);
    this.renderBudgetRecoveryBlocks = boundedLiveEffectInteger(options.renderBudgetRecoveryBlocks, 0, 0, 4096);
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

  get health() {
    return {
      bypassed: this.bypassed,
      healthy: this.healthy,
      instanceId: this.instanceId,
      lastError: this.lastError,
      latencySamples: this.created?.latencySamples ?? 0,
      renderBudgetMisses: this.renderBudgetMisses,
      lastRenderDurationMs: this.lastRenderDurationMs,
      lastRenderBudgetMs: this.lastRenderBudgetMs,
      renderBudgetExceeded: this.lastRenderBudgetExceeded,
      unhealthyReason: this.unhealthyReason,
      recoveryDryBlocks: this.recoveryDryBlocks,
      renderBudgetRecoveryBlocks: this.renderBudgetRecoveryBlocks,
      processTimeoutMs: this.processTimeoutMs,
      maxInputAgeMs: this.maxInputAgeMs,
      inFlightBlocks: this.inFlightBlocks,
      maxInFlightBlocks: this.maxInFlightBlocks,
      droppedInputBlocks: this.droppedInputBlocks,
      staleInputBlocks: this.staleInputBlocks,
      transitionFadeSamples: this.transitionFadeSamples
    };
  }

  setBypassed(bypassed) {
    this.bypassed = bypassed;
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  async recreate() {
    await this.destroyInstance().catch(() => void 0);
    await this.createInstance();
  }

  async destroy() {
    await this.destroyInstance();
    this.healthy = false;
    this.unhealthyReason = "destroyed";
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  async refreshLatency(transportLatencySamples = 0) {
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

  async processBlock(request) {
    if (this.bypassed || !this.instanceId || !this.healthy) {
      const response = this.dryResponse(request, void 0);
      this.maybeRecoverFromRenderPressure();
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

    try {
      const processRequest = {
        instanceId: this.instanceId,
        blockId: request.blockId,
        sampleRate: request.sampleRate ?? this.sampleRate,
        channels: request.channels,
        inputBuses: request.inputBuses,
        transport: request.transport,
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
                channels: cloneLiveEffectChannels(request.channels),
                inputBuses: cloneLiveEffectBusBlocks(request.inputBuses)
              },
              requestTimeoutMs
            );
      this.inFlightBlocks += 1;
      const inFlightEpoch = this.inFlightEpoch;
      processed.then(() => this.releaseInFlightBlock(inFlightEpoch), () => this.releaseInFlightBlock(inFlightEpoch));
      const response = await withLiveEffectTimeout(processed, this.processTimeoutMs);
      if (this.recordRenderBudget(response)) {
        const error = new Error("render_budget_exceeded");
        this.failClosed(error, "render-budget-exceeded");
        return this.dryResponse(request, error);
      }
      return this.finishResponse({ ...response, bypassed: false, healthy: true });
    } catch (error) {
      this.failClosed(error, liveEffectFailureReason(error));
      return this.dryResponse(request, error);
    }
  }

  async createInstance() {
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
    this.inFlightEpoch += 1;
    this.inFlightBlocks = 0;
    this.droppedInputBlocks = 0;
    this.staleInputBlocks = 0;
    this.renderBudgetMisses = 0;
    this.lastRenderDurationMs = void 0;
    this.lastRenderBudgetMs = void 0;
    this.lastRenderBudgetExceeded = false;
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

  dryResponse(request, error, renderEngine = "dry-bypass") {
    return this.finishResponse({
      blockId: request.blockId,
      channels: dryLiveEffectChannels(request.channels, this.outputChannels),
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine,
      bypassed: true,
      healthy: this.healthy,
      error
    });
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

  failClosed(error, reason) {
    this.healthy = false;
    this.lastError = error;
    this.unhealthyReason = reason;
    this.recoveryDryBlocks = 0;
    this.dispatchEvent(new CustomEvent("effect-error", { detail: { error, health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
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

  finishResponse(response) {
    const outputPath = response.bypassed ? "dry" : "wet";
    const channels = transitionLiveEffectOutputChannels(response.channels, this.lastOutputTail, this.lastOutputPath, outputPath, this.transitionFadeSamples);
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
  return error instanceof Error && error.name === "SoundBridgeLiveEffectTimeout" ? "process-timeout" : "processing-error";
}

function liveEffectNowMs() {
  return typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();
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

function liveEffectOutputTail(channels, outputChannels) {
  return Array.from({ length: outputChannels }, (_, index) => {
    const channel = channels.length > 0 ? channels[index % channels.length] : void 0;
    const sample = Number(channel?.[Math.max(0, channel.length - 1)] ?? 0);
    return Number.isFinite(sample) ? sample : 0;
  });
}

function cloneLiveEffectChannels(channels) {
  return channels.map((channel) => Array.from(channel));
}

function cloneLiveEffectBusBlocks(buses) {
  return buses?.map((bus) => ({ index: bus.index, channels: cloneLiveEffectChannels(bus.channels) }));
}

function dryLiveEffectChannels(channels, outputChannels) {
  const frames = channels[0]?.length ?? 0;
  return Array.from({ length: outputChannels }, (_, index) => {
    const source = channels.length > 0 ? channels[index % channels.length] : void 0;
    return source ? Array.from(source) : Array.from({ length: frames }, () => 0);
  });
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
