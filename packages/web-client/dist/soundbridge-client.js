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
    this.requestSeq = 0;
    this.sessionToken = undefined;
    this.pending = new Map();
  }

  connect() {
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

  processAudioBlock(request) {
    return this.request("processAudioBlock", request, true, 2000);
  }

  processAudioBlockBinary(request) {
    const { channels, ...payload } = request;
    return this.request("processAudioBlock", payload, true, 2000, channels);
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
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("SoundBridge socket is not connected."));
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
      socket.send(
        binaryAudioChannels ? encodeBinaryAudioEnvelope(envelope, binaryAudioChannels) : JSON.stringify(envelope)
      );
    });
  }

  handleMessage(data) {
    let envelope;
    try {
      envelope = typeof data === "string" ? JSON.parse(data) : decodeBinaryAudioEnvelope(data);
    } catch {
      return;
    }

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
}

const BINARY_AUDIO_MAGIC = 0x53424131;
const BINARY_AUDIO_HEADER_BYTES = 8;
const FLOAT_BYTES = 4;

function encodeBinaryAudioEnvelope(envelope, channels) {
  const normalized = normalizeBinaryChannels(channels);
  const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  const header = {
    ...envelope,
    payload: {
      ...payload,
      channels: void 0,
      outputBuses: void 0
    },
    binaryAudio: {
      channels: normalized.length,
      frames: normalized[0]?.length ?? 0
    }
  };
  delete header.payload.channels;
  delete header.payload.outputBuses;
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const sampleBytes = normalized.length * (normalized[0]?.length ?? 0) * FLOAT_BYTES;
  const buffer = new ArrayBuffer(BINARY_AUDIO_HEADER_BYTES + headerBytes.length + sampleBytes);
  const view = new DataView(buffer);
  view.setUint32(0, BINARY_AUDIO_MAGIC, false);
  view.setUint32(4, headerBytes.length, false);
  new Uint8Array(buffer, BINARY_AUDIO_HEADER_BYTES, headerBytes.length).set(headerBytes);
  writeBinaryChannels(view, BINARY_AUDIO_HEADER_BYTES + headerBytes.length, normalized);
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
  const channelCount = boundedBinaryInteger(envelope.binaryAudio?.channels, 0, 32);
  const frames = boundedBinaryInteger(envelope.binaryAudio?.frames, 1, 8192);
  if (bytes.byteLength !== headerEnd + channelCount * frames * FLOAT_BYTES) {
    throw new Error("invalid_binary_audio_payload");
  }

  if (envelope.ok && envelope.payload && typeof envelope.payload === "object") {
    envelope.payload.channels = readBinaryChannels(view, headerEnd, channelCount, frames);
  }
  delete envelope.binaryAudio;
  return envelope;
}

function normalizeBinaryChannels(channels) {
  const limited = channels.slice(0, 32);
  const frames = Math.min(8192, Math.max(0, ...limited.map((channel) => Math.max(0, Math.floor(Number(channel.length ?? 0)) || 0))));
  return limited.map((channel) => {
    const normalized = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) {
      const value = Number(channel[index] ?? 0);
      normalized[index] = Number.isFinite(value) ? value : 0;
    }
    return normalized;
  });
}

function writeBinaryChannels(view, offset, channels) {
  for (const channel of channels) {
    for (const sample of channel) {
      view.setFloat32(offset, sample, true);
      offset += FLOAT_BYTES;
    }
  }
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

export class SoundBridgeAudioNode extends EventTarget {
  constructor(context, client, options) {
    super();
    this.client = client;
    this.instanceId = options.instanceId;
    this.sampleRate = context.sampleRate;
    this.maxInFlightBlocks = options.maxInFlightBlocks;
    this.audioTransport = options.audioTransport;
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
        outputLatencyBlocks: options.outputLatencyBlocks
      }
    });
    this.node.port.onmessage = (event) => this.handleWorkletMessage(event.data);
  }

  static async create(context, client, options) {
    const normalized = {
      instanceId: options.instanceId,
      inputChannels: Math.max(1, Math.min(32, Math.floor(options.inputChannels ?? 2))),
      outputChannels: Math.max(1, Math.min(32, Math.floor(options.outputChannels ?? 2))),
      maxInFlightBlocks: boundedAudioNodeInteger(options.maxInFlightBlocks, 8, 1, 64),
      maxQueuedOutputBlocks: boundedAudioNodeInteger(options.maxQueuedOutputBlocks, 16, 1, 64),
      outputLatencyBlocks: 1,
      audioTransport: options.audioTransport === "json" ? "json" : "binary",
      workletUrl: options.workletUrl ?? "/packages/web-client/dist/soundbridge-worklet.js"
    };
    normalized.outputLatencyBlocks = boundedAudioNodeInteger(
      options.outputLatencyBlocks,
      Math.min(2, normalized.maxQueuedOutputBlocks),
      1,
      normalized.maxQueuedOutputBlocks
    );
    await context.audioWorklet.addModule(normalized.workletUrl);
    return new SoundBridgeAudioNode(context, client, normalized);
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
      timestamp: performance.now()
    };
    const processed =
      this.audioTransport === "binary"
        ? this.client.processAudioBlockBinary(request)
        : this.client.processAudioBlock({ ...request, channels: binaryChannels.map((channel) => Array.from(channel)) });

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

function boundedAudioNodeInteger(value, fallback, min, max) {
  const integer = Math.floor(Number(value ?? fallback));
  return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
}

export class SoundBridgeLiveEffectRack extends EventTarget {
  constructor(options) {
    super();
    this.created = void 0;
    this.bypassed = false;
    this.healthy = true;
    this.lastError = void 0;
    this.client = options.client;
    this.plugin = options.plugin;
    this.sampleRate = options.sampleRate;
    this.maxBlockSize = options.maxBlockSize;
    this.inputChannels = boundedLiveEffectChannelCount(options.inputChannels ?? options.plugin.inputs ?? 2);
    this.outputChannels = boundedLiveEffectChannelCount(options.outputChannels ?? options.plugin.outputs ?? this.inputChannels);
    this.audioTransport = options.audioTransport === "json" ? "json" : "binary";
  }

  static async create(options) {
    const rack = new SoundBridgeLiveEffectRack(options);
    await rack.createInstance();
    return rack;
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
      latencySamples: this.created?.latencySamples ?? 0
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
      return this.dryResponse(request, void 0);
    }

    try {
      const processRequest = {
        instanceId: this.instanceId,
        blockId: request.blockId,
        sampleRate: request.sampleRate ?? this.sampleRate,
        channels: request.channels,
        transport: request.transport,
        timestamp: request.timestamp
      };
      const response =
        this.audioTransport === "binary" && !request.inputBuses
          ? await this.client.processAudioBlockBinary(processRequest)
          : await this.client.processAudioBlock({
              ...processRequest,
              channels: cloneLiveEffectChannels(request.channels),
              inputBuses: request.inputBuses
            });
      return { ...response, bypassed: false, healthy: true };
    } catch (error) {
      this.healthy = false;
      this.lastError = error;
      this.dispatchEvent(new CustomEvent("effect-error", { detail: { error, health: this.health } }));
      this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
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
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  async destroyInstance() {
    const instanceId = this.instanceId;
    this.created = void 0;
    if (instanceId) {
      await this.client.destroyInstance(instanceId);
    }
  }

  dryResponse(request, error) {
    return {
      blockId: request.blockId,
      channels: dryLiveEffectChannels(request.channels, this.outputChannels),
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine: "dry-bypass",
      bypassed: true,
      healthy: this.healthy,
      error
    };
  }
}

function boundedLiveEffectChannelCount(value) {
  const channels = Math.floor(Number(value));
  return Number.isFinite(channels) ? Math.max(1, Math.min(32, channels)) : 2;
}

function cloneLiveEffectChannels(channels) {
  return channels.map((channel) => Array.from(channel));
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
