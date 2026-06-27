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

  request(command, payload, includeSession = true, timeoutMs = this.requestTimeoutMs) {
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
      socket.send(JSON.stringify(envelope));
    });
  }

  handleMessage(data) {
    if (typeof data !== "string") {
      return;
    }

    let envelope;
    try {
      envelope = JSON.parse(data);
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

export class SoundBridgeAudioNode extends EventTarget {
  constructor(context, client, options) {
    super();
    this.client = client;
    this.instanceId = options.instanceId;
    this.sampleRate = context.sampleRate;
    this.maxInFlightBlocks = options.maxInFlightBlocks;
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
        maxInFlightBlocks: options.maxInFlightBlocks
      }
    });
    this.node.port.onmessage = (event) => this.handleWorkletMessage(event.data);
  }

  static async create(context, client, options) {
    const normalized = {
      instanceId: options.instanceId,
      inputChannels: Math.max(1, Math.min(32, Math.floor(options.inputChannels ?? 2))),
      outputChannels: Math.max(1, Math.min(32, Math.floor(options.outputChannels ?? 2))),
      maxInFlightBlocks: options.maxInFlightBlocks ?? 8,
      workletUrl: options.workletUrl ?? "/packages/web-client/dist/soundbridge-worklet.js"
    };
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
    const channels = message.channels.map((channel) => Array.from(channel));
    const requestedFrames = Math.floor(Number(message.frames ?? channels[0]?.length ?? 128));
    const frames = Number.isFinite(requestedFrames) ? Math.max(1, requestedFrames) : 128;
    const requestedSamplePosition = Math.floor(message.blockId * frames);
    const samplePosition = Number.isFinite(requestedSamplePosition)
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, requestedSamplePosition))
      : 0;
    this.client
      .processAudioBlock({
        instanceId: this.instanceId,
        blockId: message.blockId,
        sampleRate: this.sampleRate,
        channels,
        transport: {
          playing: true,
          samplePosition
        },
        timestamp: performance.now()
      })
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
      const response = await this.client.processAudioBlock({
        instanceId: this.instanceId,
        blockId: request.blockId,
        sampleRate: request.sampleRate ?? this.sampleRate,
        channels: cloneLiveEffectChannels(request.channels),
        inputBuses: request.inputBuses,
        transport: request.transport,
        timestamp: request.timestamp
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
