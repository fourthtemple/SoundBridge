import type {
  AudioBlockRequest,
  AudioBlockResponse,
  AutomationLanePoint,
  ClearAutomationLaneResponse,
  CreateFileGrantRequest,
  FileGrant,
  FileGrantOperation,
  CreateInstanceRequest,
  CreateInstanceResponse,
  CloseEditorResponse,
  GetVst3ProgramDataResponse,
  HelloResponse,
  MidiEvent,
  OpenEditorResponse,
  ParameterAutomationEvent,
  ParameterAutomationPoint,
  PluginMetadata,
  PluginParameter,
  PluginScanRequest,
  ProtocolCommand,
  RequestEnvelope,
  ResponseEnvelope,
  SetAutomationLaneResponse,
  SetVst3ProgramDataResponse
} from "../../protocol/src/messages";

export interface SoundBridgeClientOptions {
  url?: string;
  origin?: string;
  pairingToken?: string;
  requestTimeoutMs?: number;
}

export interface BinaryAudioBlockRequest extends Omit<AudioBlockRequest, "channels"> {
  channels: ArrayLike<number>[];
}

export class SoundBridgeProtocolError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "SoundBridgeProtocolError";
    this.code = code;
    this.details = details;
  }
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timeout: number;
}

export class SoundBridgeClient extends EventTarget {
  readonly url: string;
  readonly origin: string;
  readonly requestTimeoutMs: number;
  readonly pairingToken?: string;

  private socket?: WebSocket;
  private requestSeq = 0;
  private sessionToken?: string;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: SoundBridgeClientOptions = {}) {
    super();
    this.url = options.url ?? "ws://127.0.0.1:47370/bridge";
    this.origin = options.origin ?? globalThis.location?.origin ?? "unknown-origin";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.pairingToken = options.pairingToken;
  }

  connect(): Promise<void> {
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

  async hello(): Promise<HelloResponse> {
    return this.request("hello", {});
  }

  async pair(pairingToken: string): Promise<{ sessionToken: string; expiresAt: number }> {
    const response = await this.request<{ sessionToken: string; expiresAt: number }>(
      "pair",
      { origin: this.origin, pairingToken },
      false
    );
    this.sessionToken = response.sessionToken;
    return response;
  }

  scanPlugins(request: PluginScanRequest = {}): Promise<{ plugins: PluginMetadata[]; scannedAt: number }> {
    return this.request("scanPlugins", request);
  }

  listPlugins(request: PluginScanRequest = {}): Promise<{ plugins: PluginMetadata[] }> {
    return this.request("listPlugins", request);
  }

  createInstance(request: CreateInstanceRequest): Promise<CreateInstanceResponse> {
    return this.request("createInstance", request);
  }

  destroyInstance(instanceId: string): Promise<{ destroyed: boolean }> {
    return this.request("destroyInstance", { instanceId });
  }

  getParameters(instanceId: string): Promise<{ parameters: PluginParameter[] }> {
    return this.request("getParameters", { instanceId });
  }

  setParameter(instanceId: string, parameterId: string, normalizedValue: number): Promise<{ parameter: PluginParameter }> {
    return this.request("setParameter", { instanceId, parameterId, normalizedValue });
  }

  setParameterDisplayValue(instanceId: string, parameterId: string, displayValue: string): Promise<{ parameter: PluginParameter }> {
    return this.request("setParameterDisplayValue", { instanceId, parameterId, displayValue });
  }

  setPreset(instanceId: string, presetId: string): Promise<{
    applied: boolean;
    presetId: string;
    parameterCount: number;
    parameters: PluginParameter[];
  }> {
    return this.request("setPreset", { instanceId, presetId });
  }

  getVst3ProgramData(
    instanceId: string,
    programListId: number,
    programIndex: number
  ): Promise<GetVst3ProgramDataResponse> {
    return this.request("getVst3ProgramData", { instanceId, programListId, programIndex });
  }

  setVst3ProgramData(instanceId: string, programData: string): Promise<SetVst3ProgramDataResponse> {
    return this.request("setVst3ProgramData", { instanceId, programData });
  }

  setParameterEvents(
    instanceId: string,
    events: ParameterAutomationEvent[]
  ): Promise<{ accepted: boolean; eventCount: number; parameters: PluginParameter[] }> {
    return this.request("setParameterEvents", { instanceId, events });
  }

  setParameterCurve(
    instanceId: string,
    parameterId: string,
    points: ParameterAutomationPoint[],
    interpolation: "linear" | "step" = "linear"
  ): Promise<{ accepted: boolean; eventCount: number; parameter: PluginParameter }> {
    return this.request("setParameterCurve", { instanceId, parameterId, points, interpolation });
  }

  setAutomationLane(
    instanceId: string,
    parameterId: string,
    points: AutomationLanePoint[]
  ): Promise<SetAutomationLaneResponse> {
    return this.request("setAutomationLane", { instanceId, parameterId, points });
  }

  clearAutomationLane(instanceId: string, parameterId?: string): Promise<ClearAutomationLaneResponse> {
    return this.request("clearAutomationLane", { instanceId, parameterId });
  }

  getState(instanceId: string): Promise<{ state: string }> {
    return this.request("getState", { instanceId });
  }

  setState(instanceId: string, state: string): Promise<{ restored: boolean; parameters: PluginParameter[] }> {
    return this.request("setState", { instanceId, state });
  }

  processAudioBlock(request: AudioBlockRequest): Promise<AudioBlockResponse> {
    return this.request("processAudioBlock", request, true, 2000);
  }

  processAudioBlockBinary(request: BinaryAudioBlockRequest): Promise<AudioBlockResponse> {
    const { channels, ...payload } = request;
    return this.request("processAudioBlock", payload, true, 2000, channels);
  }

  sendMidiEvents(instanceId: string, events: MidiEvent[]): Promise<{ accepted: boolean; eventCount: number }> {
    return this.request("sendMidiEvents", { instanceId, events });
  }

  getLatency(instanceId: string, transportLatencySamples = 0): Promise<{
    pluginLatencySamples: number;
    transportLatencySamples: number;
    reportedLatencySamples: number;
  }> {
    return this.request("getLatency", { instanceId, transportLatencySamples });
  }

  getTailTime(instanceId: string): Promise<{
    tailSamples: number;
    infiniteTail: boolean;
  }> {
    return this.request("getTailTime", { instanceId });
  }

  getLayout(instanceId: string): Promise<{
    requestedInputChannels: number;
    requestedOutputChannels: number;
    inputChannels: number;
    outputChannels: number;
    inputBuses: number;
    outputBuses: number;
    inputBusLayouts: Array<{
      index: number;
      direction: "input" | "output";
      mediaType: "audio";
      name: string;
      type: "main" | "aux" | "unknown";
      channels: number;
      active: boolean;
    }>;
    outputBusLayouts: Array<{
      index: number;
      direction: "input" | "output";
      mediaType: "audio";
      name: string;
      type: "main" | "aux" | "unknown";
      channels: number;
      active: boolean;
    }>;
    sampleRate: number;
    maxBlockSize: number;
  }> {
    return this.request("getLayout", { instanceId });
  }

  openEditor(instanceId: string, mode: "generic" | "native" = "generic"): Promise<OpenEditorResponse> {
    return this.request("openEditor", { instanceId, mode });
  }

  closeEditor(editorId: string): Promise<CloseEditorResponse> {
    return this.request("closeEditor", { editorId });
  }

  createFileGrant(request: CreateFileGrantRequest): Promise<FileGrant> {
    return this.request("createFileGrant", request);
  }

  listFileGrants(): Promise<{ grants: FileGrant[] }> {
    return this.request("listFileGrants", {});
  }

  revokeFileGrant(grantId: string): Promise<{ revoked: boolean; grantId: string }> {
    return this.request("revokeFileGrant", { grantId });
  }

  attachFileGrant(
    instanceId: string,
    grantId: string,
    constraints: Pick<CreateFileGrantRequest, "purpose" | "access" | "kind"> = {}
  ): Promise<{ attached: boolean; instanceId: string; grant: FileGrant & { attachedAt: number } }> {
    return this.request("attachFileGrant", { instanceId, grantId, ...constraints });
  }

  listInstanceFileGrants(instanceId: string): Promise<{ instanceId: string; grants: Array<FileGrant & { attachedAt: number }> }> {
    return this.request("listInstanceFileGrants", { instanceId });
  }

  detachFileGrant(instanceId: string, grantId: string): Promise<{ detached: boolean; instanceId: string; grantId: string }> {
    return this.request("detachFileGrant", { instanceId, grantId });
  }

  useFileGrant(
    instanceId: string,
    grantId: string,
    options: {
      operation?: FileGrantOperation;
      purpose?: CreateFileGrantRequest["purpose"];
      access?: CreateFileGrantRequest["access"];
      kind?: CreateFileGrantRequest["kind"];
    } = {}
  ): Promise<{
    accepted: boolean;
    applied: boolean;
    instanceId: string;
    operation: FileGrantOperation;
    grant: FileGrant;
    workerStatus?: string;
  }> {
    return this.request("useFileGrant", { instanceId, grantId, ...options });
  }

  heartbeat(): Promise<{ now: number }> {
    return this.request("heartbeat", { now: Date.now() });
  }

  private request<TPayload>(
    command: ProtocolCommand,
    payload: unknown,
    includeSession = true,
    timeoutMs = this.requestTimeoutMs,
    binaryAudioChannels?: ArrayLike<number>[]
  ): Promise<TPayload> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("SoundBridge socket is not connected."));
    }

    const id = `req-${++this.requestSeq}`;
    const envelope: RequestEnvelope = {
      type: "request",
      id,
      command,
      payload: (payload ?? {}) as object
    };

    if (includeSession && this.sessionToken) {
      envelope.sessionToken = this.sessionToken;
    }

    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SoundBridge request timed out: ${command}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (payload: unknown) => void, reject, timeout });
      socket.send(
        binaryAudioChannels ? encodeBinaryAudioEnvelope(envelope, binaryAudioChannels) : JSON.stringify(envelope)
      );
    });
  }

  private handleMessage(data: unknown): void {
    let envelope: ResponseEnvelope | { type: "event"; event: string; payload: unknown };
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

function encodeBinaryAudioEnvelope(envelope: RequestEnvelope, channels: ArrayLike<number>[]): ArrayBuffer {
  const normalized = normalizeBinaryChannels(channels);
  const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  const header = {
    ...envelope,
    payload: {
      ...payload,
      channels: undefined,
      outputBuses: undefined
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

function decodeBinaryAudioEnvelope(data: unknown): ResponseEnvelope {
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
  const envelope = JSON.parse(new TextDecoder().decode(headerBytes)) as ResponseEnvelope & {
    binaryAudio?: { channels?: number; frames?: number };
  };
  const channelCount = boundedBinaryInteger(envelope.binaryAudio?.channels, 0, 32);
  const frames = boundedBinaryInteger(envelope.binaryAudio?.frames, 1, 8192);
  if (bytes.byteLength !== headerEnd + channelCount * frames * FLOAT_BYTES) {
    throw new Error("invalid_binary_audio_payload");
  }

  if (envelope.ok && envelope.payload && typeof envelope.payload === "object") {
    (envelope.payload as AudioBlockResponse).channels = readBinaryChannels(view, headerEnd, channelCount, frames);
  }
  delete envelope.binaryAudio;
  return envelope;
}

function normalizeBinaryChannels(channels: ArrayLike<number>[]): Float32Array[] {
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

function writeBinaryChannels(view: DataView, offset: number, channels: Float32Array[]): void {
  for (const channel of channels) {
    for (const sample of channel) {
      view.setFloat32(offset, sample, true);
      offset += FLOAT_BYTES;
    }
  }
}

function readBinaryChannels(view: DataView, offset: number, channelCount: number, frames: number): Float32Array[] {
  const channels: Float32Array[] = [];
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

function binaryBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return undefined;
}

function boundedBinaryInteger(value: unknown, min: number, max: number): number {
  const integer = Math.floor(Number(value));
  if (!Number.isFinite(integer) || integer < min || integer > max) {
    throw new Error("binary_audio_integer_out_of_range");
  }
  return integer;
}
