import type {
  AudioBlockRequest,
  AudioBlockResponse,
  AudioBusBlock,
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
import { createSharedAudioTransport, type SharedAudioTransportDescriptor, type SharedAudioTransportOptions } from "./shared-audio";

export type { SharedAudioTransportDescriptor } from "./shared-audio";

export interface SoundBridgeClientOptions {
  url?: string;
  origin?: string;
  pairingToken?: string;
  requestTimeoutMs?: number;
  transport?: "main" | "worker";
  transportWorkerUrl?: string | URL;
}

export interface BinaryAudioBusBlock extends Omit<AudioBusBlock, "channels"> {
  channels: ArrayLike<number>[];
}

export interface BinaryAudioBlockRequest extends Omit<AudioBlockRequest, "channels" | "inputBuses"> {
  channels: ArrayLike<number>[];
  inputBuses?: BinaryAudioBusBlock[];
}
export interface AudioWorkletTransportOptions extends SharedAudioTransportOptions {
  instanceId: string;
  sampleRate: number;
  maxInFlightBlocks?: number;
  audioRequestTimeoutMs?: number;
  audioTransport?: "binary" | "json";
}

export interface AudioWorkletTransportConnection {
  port: MessagePort;
  sharedAudio?: SharedAudioTransportDescriptor;
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

interface WorkerTransportMessage {
  type?: string;
  envelope?: ResponseEnvelope | { type: "event"; event: string; payload: unknown };
  id?: string;
  message?: string;
}

export class SoundBridgeClient extends EventTarget {
  readonly url: string;
  readonly origin: string;
  readonly requestTimeoutMs: number;
  readonly pairingToken?: string;
  readonly transport: "main" | "worker";
  readonly transportWorkerUrl: string | URL;

  private socket?: WebSocket;
  private worker?: Worker;
  private workerConnected = false;
  private requestSeq = 0;
  private sessionToken?: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly workerMessageHandler = (event: MessageEvent<WorkerTransportMessage>) => {
    this.handleWorkerMessage(event.data);
  };

  constructor(options: SoundBridgeClientOptions = {}) {
    super();
    this.url = options.url ?? "ws://127.0.0.1:47370/bridge";
    this.origin = options.origin ?? globalThis.location?.origin ?? "unknown-origin";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.pairingToken = options.pairingToken;
    this.transport = options.transport === "worker" ? "worker" : "main";
    this.transportWorkerUrl = options.transportWorkerUrl ?? new URL("./soundbridge-transport-worker.js", import.meta.url);
  }

  connect(): Promise<void> {
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

  private connectWorker(): Promise<void> {
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
      const onConnectMessage = (event: MessageEvent<WorkerTransportMessage>) => {
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

  setParameterEvents(instanceId: string, events: ParameterAutomationEvent[]): Promise<{ accepted: boolean; eventCount: number; parameters: PluginParameter[] }> {
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

  setAutomationLane(instanceId: string, parameterId: string, points: AutomationLanePoint[]): Promise<SetAutomationLaneResponse> {
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

  processAudioBlock(request: AudioBlockRequest, timeoutMs = 2000): Promise<AudioBlockResponse> {
    return this.request("processAudioBlock", request, true, timeoutMs);
  }

  processAudioBlockBinary(request: BinaryAudioBlockRequest, timeoutMs = 2000): Promise<AudioBlockResponse> {
    const { channels, ...payload } = request;
    return this.request("processAudioBlock", payload, true, timeoutMs, channels);
  }

  createAudioWorkletTransportConnection(options: AudioWorkletTransportOptions): AudioWorkletTransportConnection | undefined {
    if (this.transport !== "worker" || !this.worker || !this.workerConnected || !this.sessionToken) {
      return undefined;
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
        maxInFlightBlocks: boundedAudioWorkletInteger(options.maxInFlightBlocks, 8, 1, 64),
        audioRequestTimeoutMs: boundedAudioWorkletInteger(options.audioRequestTimeoutMs, 2000, 0, 60000),
        audioTransport: options.audioTransport === "json" ? "json" : "binary",
        sharedAudio
      },
      [channel.port2]
    );
    return { port: channel.port1, sharedAudio };
  }

  createAudioWorkletTransportPort(options: AudioWorkletTransportOptions): MessagePort | undefined {
    return this.createAudioWorkletTransportConnection(options)?.port;
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
    if (this.transport === "main") {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("SoundBridge socket is not connected."));
      }
    } else if (!this.worker || !this.workerConnected) {
      return Promise.reject(new Error("SoundBridge worker transport is not connected."));
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
      if (this.transport === "worker") {
        this.worker?.postMessage({ type: "request", envelope, binaryAudioChannels, timeoutMs });
      } else {
        this.socket?.send(
          binaryAudioChannels ? encodeBinaryAudioEnvelope(envelope, binaryAudioChannels) : JSON.stringify(envelope)
        );
      }
    });
  }

  private handleMessage(data: unknown): void {
    let envelope: ResponseEnvelope | { type: "event"; event: string; payload: unknown };
    try {
      envelope = typeof data === "string" ? JSON.parse(data) : decodeBinaryAudioEnvelope(data);
    } catch {
      return;
    }

    this.handleEnvelope(envelope);
  }

  private handleWorkerMessage(message: WorkerTransportMessage): void {
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

  private handleEnvelope(envelope: ResponseEnvelope | { type: "event"; event: string; payload: unknown }): void {
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

  private rejectPendingRequests(message: string): void {
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

function encodeBinaryAudioEnvelope(envelope: RequestEnvelope, channels: ArrayLike<number>[]): ArrayBuffer {
  const mainBlock = normalizeBinaryBlock(channels);
  const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  const inputBuses = normalizeBinaryBuses((payload as { inputBuses?: BinaryAudioBusBlock[] }).inputBuses);
  const outputBuses = normalizeBinaryBuses((payload as { outputBuses?: BinaryAudioBusBlock[] }).outputBuses);
  const header = {
    ...envelope,
    payload: {
      ...payload,
      channels: undefined,
      inputBuses: undefined,
      outputBuses: undefined
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
    binaryAudio?: { channels?: number; frames?: number; inputBuses?: unknown; outputBuses?: unknown };
  };
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
    const payload = envelope.payload as AudioBlockResponse;
    payload.channels = mainBlock.channels;
    if (inputBuses.blocks.length > 0) {
      (payload as AudioBlockResponse & { inputBuses?: AudioBusBlock[] }).inputBuses = inputBuses.blocks as unknown as AudioBusBlock[];
    }
    if (outputBuses.blocks.length > 0) {
      payload.outputBuses = outputBuses.blocks as unknown as AudioBusBlock[];
    }
  }
  delete envelope.binaryAudio;
  return envelope;
}

function normalizeBinaryBlock(channels: ArrayLike<number>[]): { channels: Float32Array[]; frames: number } {
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

function normalizeBinaryBuses(buses?: BinaryAudioBusBlock[]): Array<{ index: number; channels: Float32Array[]; frames: number }> {
  if (!Array.isArray(buses)) {
    return [];
  }
  const seen = new Set<number>();
  return buses.slice(0, MAX_BINARY_BUSES).map((bus) => {
    const index = boundedBinaryInteger(bus?.index, 0, MAX_BINARY_BUSES - 1);
    if (seen.has(index)) {
      throw new Error("binary_audio_duplicate_bus");
    }
    seen.add(index);
    return { index, ...normalizeBinaryBlock(Array.isArray(bus?.channels) ? bus.channels : []) };
  });
}

function busHeaders(buses: Array<{ index: number; channels: Float32Array[]; frames: number }>): Array<{ index: number; channels: number; frames: number }> {
  return buses.map((bus) => ({ index: bus.index, channels: bus.channels.length, frames: bus.frames }));
}

function writeBinaryBlocks(view: DataView, offset: number, blocks: Array<{ channels: Float32Array[] }>): void {
  for (const block of blocks) {
    for (const channel of block.channels) {
      for (const sample of channel) {
        view.setFloat32(offset, sample, true);
        offset += FLOAT_BYTES;
      }
    }
  }
}

function readBinaryBlock(
  view: DataView,
  offset: number,
  channelCount: number,
  frames: number
): { channels: Float32Array[]; offset: number } {
  const byteLength = channelCount * frames * FLOAT_BYTES;
  if (offset + byteLength > view.byteLength) {
    throw new Error("invalid_binary_audio_payload");
  }
  return {
    channels: readBinaryChannels(view, offset, channelCount, frames),
    offset: offset + byteLength
  };
}

function readBinaryBuses(
  view: DataView,
  offset: number,
  specs: unknown
): { blocks: Array<{ index: number; channels: Float32Array[] }>; offset: number } {
  if (specs === undefined) {
    return { blocks: [], offset };
  }
  if (!Array.isArray(specs) || specs.length > MAX_BINARY_BUSES) {
    throw new Error("binary_audio_bus_out_of_range");
  }
  const seen = new Set<number>();
  const blocks: Array<{ index: number; channels: Float32Array[] }> = [];
  for (const spec of specs) {
    const raw = spec as { index?: unknown; channels?: unknown; frames?: unknown };
    const index = boundedBinaryInteger(raw.index, 0, MAX_BINARY_BUSES - 1);
    if (seen.has(index)) {
      throw new Error("binary_audio_duplicate_bus");
    }
    seen.add(index);
    const channelCount = boundedBinaryInteger(raw.channels, 0, MAX_BINARY_CHANNELS);
    const frames = boundedBinaryInteger(raw.frames, 1, MAX_BINARY_FRAMES);
    const block = readBinaryBlock(view, offset, channelCount, frames);
    offset = block.offset;
    blocks.push({ index, channels: block.channels });
  }
  return { blocks, offset };
}

function readBinaryChannels(view: DataView, offset: number, channelCount: number, frames: number): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const normalized = new Float32Array(frames);
    for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
      normalized[frameIndex] = view.getFloat32(offset, true);
      offset += FLOAT_BYTES;
    }
    channels.push(normalized);
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

function boundedAudioWorkletInteger(value: unknown, fallback: number, min: number, max: number): number {
  const integer = Math.floor(Number(value ?? fallback));
  return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
}
export { decodeBinaryAudioEnvelope as __soundBridgeDecodeBinaryAudioEnvelope, encodeBinaryAudioEnvelope as __soundBridgeEncodeBinaryAudioEnvelope };
