export type ProtocolCommand =
  | "hello"
  | "pair"
  | "scanPlugins"
  | "listPlugins"
  | "createInstance"
  | "destroyInstance"
  | "getParameters"
  | "setParameter"
  | "getState"
  | "setState"
  | "processAudioBlock"
  | "sendMidiEvents"
  | "getLatency"
  | "openEditor"
  | "closeEditor"
  | "heartbeat";

export type PluginFormat = "vst3" | "au" | "lv2" | "mock" | "unknown";

export interface PluginFormatCapability {
  scan: boolean;
  host: boolean;
  exampleHost?: boolean;
  mockExamples?: boolean;
  notes?: string;
}

export interface HelloResponse {
  name: string;
  protocolVersion: string;
  pairingRequired: boolean;
  transports: Array<{
    kind: string;
    url: string;
    audioEncoding?: string;
  }>;
  capabilities: {
    pluginFormats: Partial<Record<PluginFormat, PluginFormatCapability>>;
    mockPlugins?: boolean;
    state?: boolean;
    latency?: boolean;
    midi?: boolean;
    nativeExampleRenderer?: boolean;
    nativeEditor?: boolean;
    security?: {
      originAllowlist?: boolean;
      sessionBoundToConnection?: boolean;
      sessionBoundToOrigin?: boolean;
      instanceOwnership?: boolean;
      cleanupOnDisconnect?: boolean;
      maxInstancesPerSession?: number;
      maxTotalInstances?: number;
    };
    [key: string]: unknown;
  };
}

export interface RequestEnvelope<TPayload = unknown> {
  type: "request";
  id: string;
  command: ProtocolCommand;
  payload: TPayload;
  sessionToken?: string;
}

export interface ResponseEnvelope<TPayload = unknown> {
  type: "response";
  id: string;
  ok: boolean;
  payload?: TPayload;
  error?: ProtocolError;
}

export interface EventEnvelope<TPayload = unknown> {
  type: "event";
  event: string;
  payload: TPayload;
}

export interface ProtocolError {
  code: string;
  message: string;
  details?: unknown;
}

export interface PluginParameter {
  id: string;
  name: string;
  normalizedValue: number;
  defaultNormalizedValue: number;
  unit?: string;
  minPlain?: number;
  maxPlain?: number;
  plainValue?: number;
  automatable: boolean;
  stepCount?: number;
  readOnly?: boolean;
}

export interface PluginPreset {
  id: string;
  name: string;
  parameters: Record<string, number>;
}

export interface PluginMetadata {
  pluginId: string;
  format: PluginFormat;
  name: string;
  vendor: string;
  category: string;
  kind: "effect" | "instrument" | "midi-effect" | "unknown";
  source?: "scan" | "example-bundle" | "builtin-example" | "mock" | "unknown";
  hostable?: boolean;
  hostUnavailableReason?: string;
  inputs: number;
  outputs: number;
  parameters: PluginParameter[];
  presets?: PluginPreset[];
}

export interface PluginScanRequest {
  formats?: PluginFormat[];
  includeDiagnostics?: boolean;
}

export interface CreateInstanceRequest {
  pluginId: string;
  format?: PluginFormat;
  sampleRate: number;
  maxBlockSize: number;
  inputChannels: number;
  outputChannels: number;
}

export interface CreateInstanceResponse {
  instanceId: string;
  plugin: PluginMetadata;
  latencySamples: number;
}

export interface AudioBlockRequest {
  instanceId: string;
  blockId: number;
  sampleRate: number;
  channels: number[][];
  timestamp?: number;
}

export interface AudioBlockResponse {
  blockId: number;
  channels: number[][];
  latencySamples: number;
  renderEngine?: "bundle-worker" | "bundle-executable" | "native-example" | "js-fallback" | string;
}

export interface GetStateRequest {
  instanceId: string;
}

export interface GetStateResponse {
  state: string;
}

export interface SetStateRequest {
  instanceId: string;
  state: string;
}

export interface SetStateResponse {
  restored: boolean;
  parameters: PluginParameter[];
}

export type MidiEvent =
  | {
      type: "noteOn";
      note: number;
      velocity: number;
      time?: number;
      channel?: number;
    }
  | {
      type: "noteOff";
      note: number;
      velocity?: number;
      time?: number;
      channel?: number;
    };

export interface SendMidiEventsRequest {
  instanceId: string;
  events: MidiEvent[];
}

export interface SendMidiEventsResponse {
  accepted: boolean;
  eventCount: number;
}

export interface GetLatencyRequest {
  instanceId: string;
  transportLatencySamples?: number;
}

export interface GetLatencyResponse {
  pluginLatencySamples: number;
  transportLatencySamples: number;
  reportedLatencySamples: number;
}
