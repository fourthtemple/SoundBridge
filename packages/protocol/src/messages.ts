export type ProtocolCommand =
  | "hello"
  | "pair"
  | "scanPlugins"
  | "listPlugins"
  | "createInstance"
  | "destroyInstance"
  | "getParameters"
  | "setParameter"
  | "setParameterDisplayValue"
  | "setPreset"
  | "getVst3ProgramData"
  | "setVst3ProgramData"
  | "setParameterEvents"
  | "setParameterCurve"
  | "setAutomationLane"
  | "clearAutomationLane"
  | "getState"
  | "setState"
  | "processAudioBlock"
  | "sendMidiEvents"
  | "getLatency"
  | "getTailTime"
  | "getLayout"
  | "openEditor"
  | "closeEditor"
  | "createFileGrant"
  | "listFileGrants"
  | "revokeFileGrant"
  | "attachFileGrant"
  | "listInstanceFileGrants"
  | "detachFileGrant"
  | "useFileGrant"
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
    fileAccess?: boolean;
    nativeExampleRenderer?: boolean;
    nativeEditor?: boolean;
    fileGrantOperations?: boolean;
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
      fileBroker?: boolean;
      fileGrantApprovalBroker?: boolean;
      browserFileGrantPaths?: boolean;
      maxFileGrantsPerSession?: number;
      maxFileGrantsPerInstance?: number;
      maxTotalFileGrants?: number;
      maxFileGrantTtlMs?: number;
      maxFileGrantPathBytes?: number;
      maxFileGrantDisplayNameBytes?: number;
      maxParameterEventsPerRequest?: number;
      maxAutomationCurvePoints?: number;
      maxAutomationLanesPerInstance?: number;
      maxAutomationLanePoints?: number;
      maxTransportTempoBpm?: number;
      maxTransportPositionMusic?: number;
      maxTransportSamplePosition?: number;
      maxWorkerStdoutLineBytes?: number;
      maxWorkerCommandBytes?: number;
      maxWorkerPendingCommandBytes?: number;
      maxWorkerStderrLineBytes?: number;
      maxWorkerStderrBytes?: number;
      maxWorkerDiagnosticLogChars?: number;
      maxPluginNoteExpressions?: number;
      maxPluginProgramDataBytes?: number;
      maxPluginProgramDataEnvelopeBytes?: number;
      maxPluginProgramLists?: number;
      maxPluginPrograms?: number;
      maxPluginParameterTextBytes?: number;
      maxNoteExpressionTextBytes?: number;
      maxWorkerPendingCommands?: number;
      workerReadyTimeoutMs?: number;
      workerTerminationGraceMs?: number;
      exampleWorkerCommandTimeoutMs?: number;
      nativeWorkerCommandTimeoutMs?: number;
      nativeEditorBroker?: boolean;
      nativeEditorFileDialogs?: boolean;
      nativeEditorClipboard?: boolean;
      nativeEditorDragAndDrop?: boolean;
      nativeWorkerFileGrants?: boolean;
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
  displayValue?: string;
  unit?: string;
  minPlain?: number;
  maxPlain?: number;
  plainValue?: number;
  automatable: boolean;
  stepCount?: number;
  readOnly?: boolean;
  vst3Unit?: PluginVst3Unit;
  programChange?: boolean;
  programList?: PluginProgramList;
}

export interface PluginVst3Unit {
  id: number;
  parentUnitId: number;
  name: string;
  programListId?: number;
}

export interface PluginProgram {
  index: number;
  name: string;
  normalizedValue: number;
}

export interface PluginProgramList {
  id: number;
  name: string;
  unitId?: number;
  programDataSupported?: boolean;
  programs: PluginProgram[];
}

export interface PluginPreset {
  id: string;
  name: string;
  parameters: Record<string, number>;
}

export type AudioUnitHostProfile =
  | "realtime-main-bus"
  | "realtime-format-converter"
  | "realtime-multi-source-merger"
  | "realtime-multi-output-splitter"
  | "offline-render"
  | "multi-source-format-converter"
  | "multi-output-splitter";

export interface PluginClassMetadata {
  stableId?: string;
  bundleIdentifier?: string;
  version?: string;
  vst3ClassId?: string;
  vst3SdkVersion?: string;
  componentType?: string;
  componentSubType?: string;
  componentManufacturer?: string;
  audioUnitHostProfile?: AudioUnitHostProfile;
  lv2Uri?: string;
  lv2BlockSizeProfile?: string;
  lv2UiTypes?: string;
  lv2UiCount?: string;
  lv2UiBinaryCount?: string;
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
  parameterMetadataAtLimit?: boolean;
  editorKinds?: PluginEditorKind[];
  fileGrantOperations?: FileGrantOperation[];
  vst3ProgramLists?: PluginProgramList[];
  vst3NoteExpressions?: PluginVst3NoteExpression[];
  presets?: PluginPreset[];
}

export interface PluginVst3NoteExpression {
  typeId: number;
  name: string;
  shortName?: string;
  unit?: string;
  unitId?: number;
  defaultValue: number;
  minValue: number;
  maxValue: number;
  stepCount: number;
  bipolar?: boolean;
  oneShot?: boolean;
  absolute?: boolean;
  associatedParameterId?: string;
  busIndex: number;
  channel: number;
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

export interface GetParametersRequest {
  instanceId: string;
}

export interface GetParametersResponse {
  parameters: PluginParameter[];
  parameterMetadataAtLimit?: boolean;
}

export type PluginEditorKind = "generic-parameters" | "native-window";

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
  transport: "web" | "native-broker";
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

export type FileGrantPurpose = "preset" | "sample" | "cache" | "license" | "state" | "other";
export type FileGrantAccess = "read" | "write" | "readWrite";
export type FileGrantKind = "file" | "directory";

export interface CreateFileGrantRequest {
  path?: string;
  purpose?: FileGrantPurpose;
  access?: FileGrantAccess;
  kind?: FileGrantKind;
}

export interface FileGrant {
  grantId: string;
  purpose: FileGrantPurpose;
  access: FileGrantAccess;
  kind: FileGrantKind;
  displayName: string;
  createdAt: number;
  expiresAt: number;
}

export interface ListFileGrantsResponse {
  grants: FileGrant[];
}

export interface RevokeFileGrantRequest {
  grantId: string;
}

export interface RevokeFileGrantResponse {
  revoked: boolean;
  grantId: string;
}

export interface FileGrantAttachment extends FileGrant {
  attachedAt: number;
}

export interface AttachFileGrantRequest {
  instanceId: string;
  grantId: string;
  purpose?: FileGrantPurpose;
  access?: FileGrantAccess;
  kind?: FileGrantKind;
}

export interface AttachFileGrantResponse {
  attached: boolean;
  instanceId: string;
  grant: FileGrantAttachment;
}

export interface ListInstanceFileGrantsRequest {
  instanceId: string;
}

export interface ListInstanceFileGrantsResponse {
  instanceId: string;
  grants: FileGrantAttachment[];
}

export interface DetachFileGrantRequest {
  instanceId: string;
  grantId: string;
}

export interface DetachFileGrantResponse {
  detached: boolean;
  instanceId: string;
  grantId: string;
}

export type FileGrantOperation =
  | "loadPreset"
  | "loadSample"
  | "openCacheDirectory"
  | "loadLicense"
  | "restoreState"
  | "saveStateDirectory"
  | "other";

export interface UseFileGrantRequest {
  instanceId: string;
  grantId: string;
  operation: FileGrantOperation;
  purpose?: FileGrantPurpose;
  access?: FileGrantAccess;
  kind?: FileGrantKind;
}

export interface UseFileGrantResponse {
  accepted: boolean;
  applied: boolean;
  instanceId: string;
  operation: FileGrantOperation;
  grant: FileGrant;
  workerStatus?: string;
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
  parameterMetadataAtLimit?: boolean;
}

export interface SetParameterRequest {
  instanceId: string;
  parameterId: string;
  normalizedValue: number;
}

export interface SetParameterDisplayValueRequest {
  instanceId: string;
  parameterId: string;
  displayValue: string;
}

export interface SetParameterResponse {
  parameter: PluginParameter;
}

export interface SetPresetRequest {
  instanceId: string;
  presetId: string;
}

export interface SetPresetResponse {
  applied: boolean;
  presetId: string;
  parameterCount: number;
  parameters: PluginParameter[];
}

export interface GetVst3ProgramDataRequest {
  instanceId: string;
  programListId: number;
  programIndex: number;
}

export interface GetVst3ProgramDataResponse {
  instanceId: string;
  format: "vst3";
  programListId: number;
  programIndex: number;
  size: number;
  data: string;
  programData: string;
}

export interface SetVst3ProgramDataRequest {
  instanceId: string;
  programData: string;
}

export interface SetVst3ProgramDataResponse {
  restored: boolean;
  instanceId: string;
  format: "vst3";
  programListId: number;
  programIndex: number;
  parameterMetadataAtLimit?: boolean;
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

export interface AutomationLanePoint {
  samplePosition: number;
  normalizedValue: number;
}

export interface SetAutomationLaneRequest {
  instanceId: string;
  parameterId: string;
  points: AutomationLanePoint[];
}

export interface SetAutomationLaneResponse {
  accepted: boolean;
  parameterId: string;
  pointCount: number;
  laneCount: number;
  parameter: PluginParameter;
}

export interface ClearAutomationLaneRequest {
  instanceId: string;
  parameterId?: string;
}

export interface ClearAutomationLaneResponse {
  cleared: boolean;
  parameterId?: string;
  laneCount: number;
}

export type MidiEvent =
  | {
      type: "noteOn";
      note: number;
      velocity: number;
      time?: number;
      channel?: number;
      noteId?: number;
    }
  | {
      type: "noteOff";
      note: number;
      velocity?: number;
      time?: number;
      channel?: number;
      noteId?: number;
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
      noteId?: number;
    }
  | {
      type: "programChange";
      program: number;
      time?: number;
      channel?: number;
    }
  | {
      type: "noteExpression";
      typeId: number;
      noteId: number;
      value: number;
      time?: number;
      channel?: number;
    }
  | {
      type: "noteExpressionText";
      typeId: number;
      noteId: number;
      text: string;
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
