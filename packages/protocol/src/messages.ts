export type ProtocolCommand =
  | "hello"
  | "pair"
  | "scanPlugins"
  | "listPlugins"
  | "createInstance"
  | "destroyInstance"
  | "getParameters"
  | "setParameter"
  | "setParameterEvents"
  | "setParameterCurve"
  | "getState"
  | "setState"
  | "processAudioBlock"
  | "sendMidiEvents"
  | "getLatency"
  | "getTailTime"
  | "getLayout"
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
    tail?: boolean;
    layout?: boolean;
    midi?: boolean;
    automation?: boolean;
    transport?: boolean;
    genericEditor?: boolean;
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
      maxEditorsPerSession?: number;
      maxTotalEditors?: number;
      maxEditorSessionTtlMs?: number;
      maxParameterEventsPerRequest?: number;
      maxAutomationCurvePoints?: number;
      maxTransportTempoBpm?: number;
      maxTransportPositionMusic?: number;
      maxTransportSamplePosition?: number;
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
  programChange?: boolean;
  programList?: PluginProgramList;
}

export interface PluginProgram {
  index: number;
  name: string;
  normalizedValue: number;
}

export interface PluginProgramList {
  id: number;
  name: string;
  programs: PluginProgram[];
}

export interface PluginPreset {
  id: string;
  name: string;
  parameters: Record<string, number>;
}

export interface PluginClassMetadata {
  stableId?: string;
  bundleIdentifier?: string;
  version?: string;
  componentType?: string;
  componentSubType?: string;
  componentManufacturer?: string;
  lv2Uri?: string;
}

export interface PluginBusLayout {
  index: number;
  direction: "input" | "output";
  mediaType: "audio";
  name: string;
  type: "main" | "aux" | "unknown";
  channels: number;
  active: boolean;
}

export interface PluginLayout {
  requestedInputChannels: number;
  requestedOutputChannels: number;
  inputChannels: number;
  outputChannels: number;
  inputBuses: number;
  outputBuses: number;
  inputBusLayouts: PluginBusLayout[];
  outputBusLayouts: PluginBusLayout[];
  sampleRate: number;
  maxBlockSize: number;
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
  metadata?: PluginClassMetadata;
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
  layout: PluginLayout;
  latencySamples: number;
  tailSamples?: number;
  infiniteTail?: boolean;
}

export type PluginEditorKind = "generic-parameters";

export interface PluginEditorCapabilities {
  parameterEditing: boolean;
  nativeWindow: boolean;
  fileDialogs: boolean;
  clipboard: boolean;
  dragAndDrop: boolean;
}

export interface OpenEditorRequest {
  instanceId: string;
  mode?: "generic" | "native";
}

export interface OpenEditorResponse {
  editorId: string;
  instanceId: string;
  kind: PluginEditorKind;
  native: boolean;
  transport: "web";
  expiresAt: number;
  plugin: PluginMetadata;
  parameters: PluginParameter[];
  capabilities: PluginEditorCapabilities;
}

export interface CloseEditorRequest {
  editorId: string;
}

export interface CloseEditorResponse {
  closed: boolean;
  editorId: string;
}

export interface AudioBusBlock {
  index: number;
  channels: number[][];
}

export interface HostTransportState {
  playing?: boolean;
  recording?: boolean;
  loopActive?: boolean;
  tempo?: number;
  timeSignatureNumerator?: number;
  timeSignatureDenominator?: number;
  projectTimeMusic?: number;
  barPositionMusic?: number;
  cycleStartMusic?: number;
  cycleEndMusic?: number;
  samplePosition?: number;
}

export interface AudioBlockRequest {
  instanceId: string;
  blockId: number;
  sampleRate: number;
  channels?: number[][];
  inputBuses?: AudioBusBlock[];
  transport?: HostTransportState;
  timestamp?: number;
}

export interface AudioBlockResponse {
  blockId: number;
  channels: number[][];
  outputBuses?: AudioBusBlock[];
  transport?: HostTransportState;
  latencySamples: number;
  tailSamples?: number;
  infiniteTail?: boolean;
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

export interface ParameterAutomationEvent {
  parameterId: string;
  normalizedValue: number;
  time?: number;
}

export interface ParameterAutomationPoint {
  time: number;
  normalizedValue: number;
}

export interface SetParameterEventsRequest {
  instanceId: string;
  events: ParameterAutomationEvent[];
}

export interface SetParameterEventsResponse {
  accepted: boolean;
  eventCount: number;
  parameters: PluginParameter[];
}

export interface SetParameterCurveRequest {
  instanceId: string;
  parameterId: string;
  interpolation?: "linear" | "step";
  points: ParameterAutomationPoint[];
}

export interface SetParameterCurveResponse {
  accepted: boolean;
  eventCount: number;
  parameter: PluginParameter;
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
    }
  | {
      type: "controlChange";
      controller: number;
      value: number;
      time?: number;
      channel?: number;
    }
  | {
      type: "pitchBend";
      value: number;
      time?: number;
      channel?: number;
    }
  | {
      type: "channelPressure";
      pressure: number;
      time?: number;
      channel?: number;
    }
  | {
      type: "polyPressure";
      note: number;
      pressure: number;
      time?: number;
      channel?: number;
    }
  | {
      type: "programChange";
      program: number;
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

export interface GetTailTimeRequest {
  instanceId: string;
}

export interface GetTailTimeResponse {
  tailSamples: number;
  infiniteTail: boolean;
}

export interface GetLayoutRequest {
  instanceId: string;
}

export type GetLayoutResponse = PluginLayout;
