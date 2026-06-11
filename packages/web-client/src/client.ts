import type {
  AudioBlockRequest,
  AudioBlockResponse,
  CreateInstanceRequest,
  CreateInstanceResponse,
  HelloResponse,
  MidiEvent,
  ParameterAutomationEvent,
  ParameterAutomationPoint,
  PluginMetadata,
  PluginParameter,
  PluginScanRequest,
  ProtocolCommand,
  RequestEnvelope,
  ResponseEnvelope
} from "../../protocol/src/messages";

export interface SoundBridgeClientOptions {
  url?: string;
  origin?: string;
  pairingToken?: string;
  requestTimeoutMs?: number;
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

  getState(instanceId: string): Promise<{ state: string }> {
    return this.request("getState", { instanceId });
  }

  setState(instanceId: string, state: string): Promise<{ restored: boolean; parameters: PluginParameter[] }> {
    return this.request("setState", { instanceId, state });
  }

  processAudioBlock(request: AudioBlockRequest): Promise<AudioBlockResponse> {
    return this.request("processAudioBlock", request, true, 2000);
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

  heartbeat(): Promise<{ now: number }> {
    return this.request("heartbeat", { now: Date.now() });
  }

  private request<TPayload>(
    command: ProtocolCommand,
    payload: unknown,
    includeSession = true,
    timeoutMs = this.requestTimeoutMs
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
      socket.send(JSON.stringify(envelope));
    });
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }

    let envelope: ResponseEnvelope | { type: "event"; event: string; payload: unknown };
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
