import crypto from "node:crypto";
import { createDaemonControlEvents } from "./daemon-control-events.mjs";
import { createDaemonEditors } from "./daemon-editors.mjs";
import { createDaemonFileGrants } from "./daemon-file-grants.mjs";
import { createDaemonFileGrantOperations } from "./daemon-file-grant-operations.mjs";
import { createDaemonHelloResponse } from "./daemon-hello-response.mjs";
import { createDaemonInstanceFileGrants } from "./daemon-instance-file-grants.mjs";
import { createDaemonInstrumentRendering } from "./daemon-instrument-rendering.mjs";
import { createDaemonLifecycle } from "./daemon-lifecycle.mjs";
import { createDaemonLv2BlockProfileSupport } from "./daemon-lv2-block-profiles.mjs";
import { createMockInstrumentSupport } from "./daemon-mock-instruments.mjs";
import { createDaemonNormalizers } from "./daemon-normalizers.mjs";
import { createDaemonPairing } from "./daemon-pairing.mjs";
import { createPluginCatalogSupport, loadNativeHostStatus, resolveNativeRenderer } from "./daemon-plugin-catalog.mjs";
import { createDaemonRuntimePayloads } from "./daemon-runtime-payloads.mjs";
import { createDaemonVst3ProgramData } from "./daemon-vst3-program-data.mjs";
import { createDaemonConfig } from "./daemon-config.mjs";
import { createConfiguredNativeEditorBroker } from "./native-editor-broker-process.mjs";
import {
  assertLoopbackHost,
  createDaemonValidators,
  isLoopbackHostHeader,
  protocolError,
  sendError,
  tokenEquals
} from "./daemon-security-helpers.mjs";
import { createDaemonWebSocketServer } from "./daemon-websocket-server.mjs";
import { createDaemonWorkerSecurity } from "./daemon-worker-security.mjs";
import { createConfiguredFileGrantApprovalBroker } from "./file-grant-approval-broker-process.mjs";

const {
  HOST,
  PORT,
  PAIRING_TOKEN,
  PAIRING_TOKEN_IS_EPHEMERAL,
  PROTOCOL_VERSION,
  SESSION_TTL_MS,
  MAX_SESSIONS_PER_ORIGIN,
  MAX_INSTANCES_PER_SESSION,
  MAX_TOTAL_INSTANCES,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  MAX_TOTAL_SESSIONS,
  MAX_AUDIO_CHANNELS,
  MAX_PLUGIN_BUSES,
  MAX_BLOCK_SIZE,
  MAX_MIDI_EVENTS_PER_REQUEST,
  MAX_NOTE_EXPRESSION_TEXT_BYTES,
  MAX_PARAMETER_EVENTS_PER_REQUEST,
  MAX_AUTOMATION_CURVE_POINTS,
  MAX_AUTOMATION_LANES_PER_INSTANCE,
  MAX_AUTOMATION_LANE_POINTS,
  MAX_EDITORS_PER_SESSION,
  MAX_TOTAL_EDITORS,
  EDITOR_SESSION_TTL_MS,
  MAX_FILE_GRANTS_PER_SESSION,
  MAX_FILE_GRANTS_PER_INSTANCE,
  MAX_TOTAL_FILE_GRANTS,
  FILE_GRANT_TTL_MS,
  MAX_FILE_GRANT_PATH_BYTES,
  MAX_FILE_GRANT_DISPLAY_NAME_BYTES,
  MAX_PLUGIN_PARAMETERS,
  MAX_PLUGIN_PRESETS,
  MAX_PLUGIN_PROGRAM_LISTS,
  MAX_PLUGIN_PROGRAMS,
  MAX_PLUGIN_NOTE_EXPRESSIONS,
  MAX_PLUGIN_PARAMETER_TEXT_BYTES,
  MAX_PLUGIN_METADATA_TEXT_BYTES,
  MAX_PLUGIN_STATE_BYTES,
  MAX_PLUGIN_PROGRAM_DATA_BYTES,
  MAX_PLUGIN_STATE_ENVELOPE_BYTES,
  MAX_PLUGIN_PROGRAM_DATA_ENVELOPE_BYTES,
  MAX_PLUGIN_LATENCY_SAMPLES,
  MAX_PLUGIN_TAIL_SAMPLES,
  MAX_TRANSPORT_TEMPO_BPM,
  MAX_TRANSPORT_POSITION_MUSIC,
  MAX_TRANSPORT_SAMPLE_POSITION,
  MAX_PAIR_ATTEMPTS_PER_CONNECTION,
  MIN_SAMPLE_RATE,
  MAX_SAMPLE_RATE,
  ALLOWED_ORIGINS,
  FILE_GRANT_ROOTS,
  ALLOW_BROWSER_FILE_GRANT_PATHS
} = createDaemonConfig();
const validators = createDaemonValidators({
  minSampleRate: MIN_SAMPLE_RATE,
  maxSampleRate: MAX_SAMPLE_RATE,
  makeProtocolError: protocolError
});
const { boundedFrames, requireIntInRange, requireNumberInRange, requireSampleRate } = validators;

assertLoopbackHost(HOST, "SOUNDBRIDGE_HOST", "SOUNDBRIDGE_ALLOW_NON_LOOPBACK");

const NATIVE_RENDERER = resolveNativeRenderer();
const NATIVE_HOST_STATUS = loadNativeHostStatus(NATIVE_RENDERER);
const normalizers = createDaemonNormalizers({
  maxAudioChannels: MAX_AUDIO_CHANNELS,
  maxBlockSize: MAX_BLOCK_SIZE,
  maxPluginBuses: MAX_PLUGIN_BUSES,
  maxPluginLatencySamples: MAX_PLUGIN_LATENCY_SAMPLES,
  maxPluginParameters: MAX_PLUGIN_PARAMETERS,
  maxPluginNoteExpressions: MAX_PLUGIN_NOTE_EXPRESSIONS,
  maxPluginProgramDataBytes: MAX_PLUGIN_PROGRAM_DATA_BYTES,
  maxPluginProgramLists: MAX_PLUGIN_PROGRAM_LISTS,
  maxPluginParameterTextBytes: MAX_PLUGIN_PARAMETER_TEXT_BYTES,
  maxPluginPrograms: MAX_PLUGIN_PROGRAMS,
  maxPluginStateBytes: MAX_PLUGIN_STATE_BYTES,
  maxPluginTailSamples: MAX_PLUGIN_TAIL_SAMPLES,
  minSampleRate: MIN_SAMPLE_RATE,
  maxSampleRate: MAX_SAMPLE_RATE,
  makeProtocolError: protocolError
});
const {
  clamp01,
  clampSampleRate,
  clonePluginLayout,
  finiteNumber,
  normalizeLatencySamples,
  normalizeNativeState,
  normalizePluginLayout,
  normalizeTailSamples
} = normalizers;
const {
  validateNativeHostBlockSizeProfile,
  validateParameterSampleOffsetForBlockProfile,
  validateRenderBlockSizeProfile
} = createDaemonLv2BlockProfileSupport({
  makeProtocolError: protocolError
});
const mockInstruments = createMockInstrumentSupport({
  clamp01,
  finiteNumber
});
const {
  makeNativeUpdatedParameter,
  makeUpdatedParameter,
  midiNoteToFrequency,
  normalizedValueFromDisplayValue,
  normalizedGainToDb,
  parameterValue,
  synthesizeInstrumentBlock
} = mockInstruments;
const { processInstrumentBlock } = createDaemonInstrumentRendering({
  nativeRenderer: NATIVE_RENDERER,
  parameterValue,
  synthesizeInstrumentBlock
});
const {
  clonePluginMetadata,
  createPluginFormatCapabilities,
  formatCategory,
  normalizePresetSnapshot,
  plugins
} = createPluginCatalogSupport({
  nativeRenderer: NATIVE_RENDERER,
  nativeHostStatus: NATIVE_HOST_STATUS,
  normalizers,
  mockInstruments,
  limits: {
    maxPluginMetadataTextBytes: MAX_PLUGIN_METADATA_TEXT_BYTES,
    maxPluginNoteExpressions: MAX_PLUGIN_NOTE_EXPRESSIONS,
    maxPluginParameters: MAX_PLUGIN_PARAMETERS,
    maxPluginParameterTextBytes: MAX_PLUGIN_PARAMETER_TEXT_BYTES,
    maxPluginPresets: MAX_PLUGIN_PRESETS
  }
});
const {
  assertParameterAutomatable,
  assertParameterWritable,
  collectAutomationLaneEvents,
  normalizeAutomationLanePoints,
  normalizeMidiEvents,
  normalizeParameterCurve,
  normalizeParameterEvents,
  requireParameterId,
  requireParameterDisplayValue,
  requirePresetId
} = createDaemonControlEvents({
  clamp01,
  limits: {
    maxAutomationCurvePoints: MAX_AUTOMATION_CURVE_POINTS,
    maxAutomationLanePoints: MAX_AUTOMATION_LANE_POINTS,
    maxBlockSize: MAX_BLOCK_SIZE,
    maxMidiEventsPerRequest: MAX_MIDI_EVENTS_PER_REQUEST,
    maxNoteExpressionTextBytes: MAX_NOTE_EXPRESSION_TEXT_BYTES,
    maxParameterEventsPerRequest: MAX_PARAMETER_EVENTS_PER_REQUEST,
    maxPluginParameterTextBytes: MAX_PLUGIN_PARAMETER_TEXT_BYTES,
    maxTransportSamplePosition: MAX_TRANSPORT_SAMPLE_POSITION
  },
  makeProtocolError: protocolError,
  validators
});
const {
  decodeStateEnvelope,
  encodeStateEnvelope,
  firstAudioFrameCount,
  getNativeState,
  normalizeAudioBusBlocks,
  normalizeAudioChannels,
  normalizeOutputBusBlocks,
  normalizeTransportState
} = createDaemonRuntimePayloads({
  limits: {
    maxAudioChannels: MAX_AUDIO_CHANNELS,
    maxPluginBuses: MAX_PLUGIN_BUSES,
    maxPluginStateEnvelopeBytes: MAX_PLUGIN_STATE_ENVELOPE_BYTES,
    maxTransportPositionMusic: MAX_TRANSPORT_POSITION_MUSIC,
    maxTransportSamplePosition: MAX_TRANSPORT_SAMPLE_POSITION,
    maxTransportTempoBpm: MAX_TRANSPORT_TEMPO_BPM
  },
  makeProtocolError: protocolError,
  normalizers,
  validators
});
const {
  ExampleInstrumentWorker,
  NativeHostWorker,
  formatNativeHostName,
  securityLimits: workerSecurityLimits
} = createDaemonWorkerSecurity({
  nativeRenderer: NATIVE_RENDERER,
  normalizers
});
const fileGrantApprovalBroker = createConfiguredFileGrantApprovalBroker({
  limits: workerSecurityLimits
});
const nativeEditorBroker = createConfiguredNativeEditorBroker({
  limits: workerSecurityLimits
});

const sessions = new Map();
const instances = new Map();
const editors = new Map();
const fileGrants = new Map();
const fileGrantSupport = createDaemonFileGrants({
  fileGrants,
  sessions,
  roots: FILE_GRANT_ROOTS,
  allowBrowserPaths: ALLOW_BROWSER_FILE_GRANT_PATHS,
  approvalBroker: fileGrantApprovalBroker,
  limits: {
    fileGrantTtlMs: FILE_GRANT_TTL_MS,
    maxFileGrantDisplayNameBytes: MAX_FILE_GRANT_DISPLAY_NAME_BYTES,
    maxFileGrantPathBytes: MAX_FILE_GRANT_PATH_BYTES,
    maxFileGrantsPerSession: MAX_FILE_GRANTS_PER_SESSION,
    maxTotalFileGrants: MAX_TOTAL_FILE_GRANTS
  },
  makeProtocolError: protocolError
});
const helloResponse = createDaemonHelloResponse({
  allowedOrigins: ALLOWED_ORIGINS,
  createPluginFormatCapabilities,
  fileGrantSupport,
  host: HOST,
  limits: {
    editorSessionTtlMs: EDITOR_SESSION_TTL_MS,
    fileGrantTtlMs: FILE_GRANT_TTL_MS,
    maxAudioChannels: MAX_AUDIO_CHANNELS,
    maxAutomationCurvePoints: MAX_AUTOMATION_CURVE_POINTS,
    maxAutomationLanePoints: MAX_AUTOMATION_LANE_POINTS,
    maxAutomationLanesPerInstance: MAX_AUTOMATION_LANES_PER_INSTANCE,
    maxBlockSize: MAX_BLOCK_SIZE,
    maxEditorsPerSession: MAX_EDITORS_PER_SESSION,
    maxFileGrantDisplayNameBytes: MAX_FILE_GRANT_DISPLAY_NAME_BYTES,
    maxFileGrantPathBytes: MAX_FILE_GRANT_PATH_BYTES,
    maxFileGrantsPerInstance: MAX_FILE_GRANTS_PER_INSTANCE,
    maxFileGrantsPerSession: MAX_FILE_GRANTS_PER_SESSION,
    maxNoteExpressionTextBytes: MAX_NOTE_EXPRESSION_TEXT_BYTES,
    maxParameterEventsPerRequest: MAX_PARAMETER_EVENTS_PER_REQUEST,
    maxPluginNoteExpressions: MAX_PLUGIN_NOTE_EXPRESSIONS,
    maxPluginProgramDataBytes: MAX_PLUGIN_PROGRAM_DATA_BYTES,
    maxPluginProgramDataEnvelopeBytes: MAX_PLUGIN_PROGRAM_DATA_ENVELOPE_BYTES,
    maxPluginProgramLists: MAX_PLUGIN_PROGRAM_LISTS,
    maxPluginPrograms: MAX_PLUGIN_PROGRAMS,
    maxPluginParameterTextBytes: MAX_PLUGIN_PARAMETER_TEXT_BYTES,
    maxTotalEditors: MAX_TOTAL_EDITORS,
    maxTotalFileGrants: MAX_TOTAL_FILE_GRANTS,
    maxTotalInstances: MAX_TOTAL_INSTANCES,
    maxTotalSessions: MAX_TOTAL_SESSIONS,
    maxTransportPositionMusic: MAX_TRANSPORT_POSITION_MUSIC,
    maxTransportSamplePosition: MAX_TRANSPORT_SAMPLE_POSITION,
    maxTransportTempoBpm: MAX_TRANSPORT_TEMPO_BPM
  },
  nativeEditorBroker,
  nativeRenderer: NATIVE_RENDERER,
  port: PORT,
  protocolVersion: PROTOCOL_VERSION,
  workerSecurityLimits
});
const instanceFileGrantSupport = createDaemonInstanceFileGrants({
  fileGrantSupport,
  maxFileGrantsPerInstance: MAX_FILE_GRANTS_PER_INSTANCE,
  makeProtocolError: protocolError
});
const { useFileGrant } = createDaemonFileGrantOperations({
  getInstance,
  instanceFileGrantSupport,
  makeProtocolError: protocolError
});
const {
  assertPaired,
  cleanupConnection,
  cleanupExpiredSessions,
  cleanupExpiredEditors,
  destroyEditorRecord,
  destroyInstanceRecord,
  sessionsForOrigin
} = createDaemonLifecycle({
  sessions,
  instances,
  editors,
  fileGrants,
  destroyFileGrantRecord: fileGrantSupport.destroyFileGrantRecord,
  makeProtocolError: protocolError
});
const { openEditor, closeEditor } = createDaemonEditors({
  clonePluginMetadata,
  cleanupExpiredEditors,
  destroyEditorRecord,
  editors,
  formatCategory,
  getInstance,
  limits: {
    editorSessionTtlMs: EDITOR_SESSION_TTL_MS,
    maxEditorsPerSession: MAX_EDITORS_PER_SESSION,
    maxTotalEditors: MAX_TOTAL_EDITORS
  },
  makeProtocolError: protocolError,
  nativeEditorBroker,
  resolveNativeFileGrants(instance, session) {
    return instanceFileGrantSupport.nativeFileGrantsForInstance(instance, session);
  },
  resolvePlugin: getPlugin
});
const {
  getVst3ProgramData,
  setVst3ProgramData
} = createDaemonVst3ProgramData({
  getInstance,
  limits: {
    maxPluginProgramDataEnvelopeBytes: MAX_PLUGIN_PROGRAM_DATA_ENVELOPE_BYTES,
    maxPluginPrograms: MAX_PLUGIN_PROGRAMS
  },
  normalizers,
  protocolError,
  requireIntInRange
});
const { createConnectionContext, pair } = createDaemonPairing({
  allowedOrigins: ALLOWED_ORIGINS,
  cleanupExpiredSessions,
  makeProtocolError: protocolError,
  maxPairAttemptsPerConnection: MAX_PAIR_ATTEMPTS_PER_CONNECTION,
  maxSessionsPerOrigin: MAX_SESSIONS_PER_ORIGIN,
  maxTotalSessions: MAX_TOTAL_SESSIONS,
  pairingToken: PAIRING_TOKEN,
  sessionTtlMs: SESSION_TTL_MS,
  sessions,
  sessionsForOrigin,
  tokenEquals
});

const server = createDaemonWebSocketServer({
  host: HOST,
  port: PORT,
  maxWebSocketMessageBytes: MAX_WEBSOCKET_MESSAGE_BYTES,
  isLoopbackHostHeader,
  createConnectionContext,
  handleRequest,
  cleanupConnection
});

server.listen(PORT, HOST, () => {
  console.log(`SoundBridge mock daemon listening on ws://${HOST}:${PORT}/bridge`);
  if (PAIRING_TOKEN_IS_EPHEMERAL) {
    console.log(`Ephemeral pairing token: ${PAIRING_TOKEN}`);
  } else {
    console.log("Using pairing token from SOUNDBRIDGE_PAIRING_TOKEN.");
  }
  if (ALLOWED_ORIGINS.length === 0) {
    console.warn(
      "WARNING: no origin allowlist set. Any browser origin holding the pairing token can pair. " +
        "Set SOUNDBRIDGE_ALLOWED_ORIGINS (and ship a native per-origin approval prompt) before production use."
    );
  }
});

async function handleRequest(rawMessage, context, send) {
  let envelope;
  try {
    envelope = JSON.parse(rawMessage);
  } catch {
    sendError(send, "unknown", "bad_json", "Request was not valid JSON.");
    return;
  }

  if (!envelope || envelope.type !== "request" || typeof envelope.id !== "string") {
    sendError(send, "unknown", "bad_envelope", "Request envelope is invalid.");
    return;
  }

  try {
    const payload = await dispatchCommand(envelope, context);
    send({
      type: "response",
      id: envelope.id,
      ok: true,
      payload
    });
  } catch (error) {
    sendError(
      send,
      envelope.id,
      error.code ?? "internal_error",
      error.message ?? "SoundBridge mock daemon error.",
      error.details
    );
  }
}

async function dispatchCommand(envelope, context) {
  const { command, payload = {} } = envelope;
  let session;

  if (command === "hello" && envelope.sessionToken) {
    session = assertPaired(envelope.sessionToken, command, context);
  } else if (!["hello", "pair", "heartbeat"].includes(command)) {
    session = assertPaired(envelope.sessionToken, command, context);
  }

  switch (command) {
    case "hello":
      return helloResponse(Boolean(session));

    case "pair":
      return pair(payload, context);

    case "scanPlugins":
      return {
        plugins: filterPlugins(payload, plugins).map(clonePluginMetadata),
        scannedAt: Date.now(),
        nativeSearchPaths: []
      };

    case "listPlugins":
      return {
        plugins: filterPlugins(payload, plugins).map(clonePluginMetadata)
      };

    case "createInstance":
      return createInstance(payload, session);

    case "destroyInstance":
      return destroyInstance(payload.instanceId, session);

    case "getParameters":
      return {
        parameters: getInstance(payload.instanceId, session).parameters.map((parameter) => ({ ...parameter }))
      };

    case "setParameter":
      return setParameter(payload.instanceId, payload.parameterId, payload.normalizedValue, session);

    case "setParameterDisplayValue":
      return setParameterDisplayValue(payload.instanceId, payload.parameterId, payload.displayValue, session);

    case "setPreset":
      return setPreset(payload.instanceId, payload.presetId, session);

    case "getVst3ProgramData":
      return getVst3ProgramData(payload.instanceId, payload.programListId, payload.programIndex, session);

    case "setVst3ProgramData":
      return setVst3ProgramData(payload.instanceId, payload.programData, session);

    case "setParameterEvents":
      return setParameterEvents(payload.instanceId, payload.events, session);

    case "setParameterCurve":
      return setParameterCurve(payload.instanceId, payload.parameterId, payload.points, payload.interpolation, session);

    case "setAutomationLane":
      return setAutomationLane(payload.instanceId, payload.parameterId, payload.points, session);

    case "clearAutomationLane":
      return clearAutomationLane(payload.instanceId, payload.parameterId, session);

    case "getState":
      return getState(payload.instanceId, session);

    case "setState":
      return setState(payload.instanceId, payload.state, session);

    case "processAudioBlock":
      return processAudioBlock(payload, session);

    case "sendMidiEvents":
      return sendMidiEvents(payload.instanceId, payload.events, session);

    case "getLatency":
      return getLatency(payload, session);

    case "getTailTime":
      return getTailTime(payload, session);

    case "getLayout":
      return getLayout(payload, session);

    case "openEditor":
      return openEditor(payload, session);

    case "closeEditor":
      return closeEditor(payload.editorId, session);

    case "createFileGrant":
      return fileGrantSupport.createFileGrant(payload, session);

    case "listFileGrants":
      return fileGrantSupport.listFileGrants(payload, session);

    case "revokeFileGrant":
      return fileGrantSupport.revokeFileGrant(payload.grantId, session);

    case "attachFileGrant":
      return instanceFileGrantSupport.attachFileGrant(payload, session, getInstance);

    case "listInstanceFileGrants":
      return instanceFileGrantSupport.listInstanceFileGrants(payload, session, getInstance);

    case "detachFileGrant":
      return instanceFileGrantSupport.detachFileGrant(payload, session, getInstance);

    case "useFileGrant":
      return useFileGrant(payload, session);

    case "heartbeat":
      return {
        now: Date.now(),
        echo: payload.now
      };

    default:
      throw protocolError("unknown_command", `Unknown command: ${command}`);
  }
}

function filterPlugins(payload, plugins) {
  const formats = Array.isArray(payload.formats)
    ? new Set(payload.formats.map((format) => String(format)))
    : undefined;
  if (!formats || formats.size === 0) {
    return plugins;
  }
  return plugins.filter((plugin) => formats.has(plugin.format));
}

async function createInstance(payload, session) {
  if (session.instances.size >= MAX_INSTANCES_PER_SESSION) {
    throw protocolError("quota_exceeded", "This browser session has reached its plugin instance limit.", {
      maxInstancesPerSession: MAX_INSTANCES_PER_SESSION
    });
  }
  if (instances.size >= MAX_TOTAL_INSTANCES) {
    throw protocolError("quota_exceeded", "The local SoundBridge daemon has reached its total plugin instance limit.", {
      maxTotalInstances: MAX_TOTAL_INSTANCES
    });
  }

  const plugin = getPlugin(payload.pluginId);
  if (!plugin) {
    throw protocolError("plugin_not_found", `Unknown plugin: ${payload.pluginId}`);
  }
  if (plugin.hostable === false) {
    throw protocolError("plugin_not_hostable", `${plugin.name} was discovered by the native scanner but cannot be hosted yet.`, {
      pluginId: plugin.pluginId,
      format: plugin.format,
      source: plugin.source,
      reason: plugin.hostUnavailableReason
    });
  }

  const sampleRate = requireSampleRate(payload.sampleRate ?? 48000);
  const maxBlockSize = requireIntInRange(payload.maxBlockSize ?? 128, 1, MAX_BLOCK_SIZE, "maxBlockSize");
  const inputChannels = requireIntInRange(payload.inputChannels ?? plugin.inputs ?? 2, 0, MAX_AUDIO_CHANNELS, "inputChannels");
  const outputChannels = requireIntInRange(payload.outputChannels ?? plugin.outputs ?? 2, 1, MAX_AUDIO_CHANNELS, "outputChannels");
  validateNativeHostBlockSizeProfile(plugin.nativeHost, maxBlockSize);

  const instanceId = `inst-${crypto.randomUUID()}`;
  const parameters = plugin.parameters.map((parameter) => ({ ...parameter }));
  const requestedLayout = normalizePluginLayout(undefined, {
    requestedInputChannels: inputChannels,
    requestedOutputChannels: outputChannels,
    inputChannels,
    outputChannels,
    inputBuses: inputChannels > 0 ? 1 : 0,
    outputBuses: 1,
    sampleRate,
    maxBlockSize
  });
  const instance = {
    instanceId,
    ownerSessionToken: session.sessionToken,
    ownerOrigin: session.origin,
    pluginId: plugin.pluginId,
    format: plugin.format,
    kind: plugin.kind,
    source: plugin.source ?? "unknown",
    executablePath: plugin.executablePath,
    engine: plugin.engine ?? "effect",
    sampleRate,
    maxBlockSize,
    inputChannels,
    outputChannels,
    layout: requestedLayout,
    parameters,
    vst3ProgramLists: plugin.vst3ProgramLists ?? [],
    vst3NoteExpressions: plugin.vst3NoteExpressions ?? [],
    nativeParameterIds: new Set(),
    fileGrantAttachments: new Map(),
    pluginLatencySamples: 0,
    pluginTailSamples: 0,
    pluginInfiniteTail: false,
    automationLanes: new Map(),
    voices: new Map(),
    renderEngine: undefined,
    worker: undefined
  };
  if (plugin.nativeHost) {
    instance.nativeHost = plugin.nativeHost;
    instance.worker = new NativeHostWorker(plugin.nativeHost, instance);
    instance.renderEngine = instance.worker.renderEngine;
    try {
      await instance.worker.ready;
      const nativeParameters = await instance.worker.getParameters();
      if (nativeParameters.length > 0) {
        instance.parameters = nativeParameters;
        instance.nativeParameterIds = new Set(nativeParameters.map((parameter) => parameter.id));
      }
      if (plugin.nativeHost.format === "vst3") {
        instance.vst3ProgramLists = await instance.worker.getVst3ProgramLists();
        instance.vst3NoteExpressions = await instance.worker.getVst3NoteExpressions();
      }
      const nativeLayout = await instance.worker.getLayout();
      instance.layout = nativeLayout;
      instance.inputChannels = nativeLayout.inputChannels;
      instance.outputChannels = nativeLayout.outputChannels;
      instance.pluginLatencySamples = await instance.worker.getLatency();
      const tail = await instance.worker.getTailTime();
      instance.pluginTailSamples = tail.tailSamples;
      instance.pluginInfiniteTail = tail.infiniteTail;
    } catch (error) {
      instance.worker.destroy();
      throw protocolError("plugin_host_failed", `${formatNativeHostName(plugin.nativeHost.format)} host worker failed for ${plugin.name}.`, {
        pluginId: plugin.pluginId,
        reason: error.message
      });
    }
  } else if (instance.executablePath && instance.kind === "instrument") {
    instance.worker = new ExampleInstrumentWorker(instance.executablePath);
    instance.renderEngine = instance.worker.renderEngine;
  }
  instances.set(instanceId, instance);
  session.instances.add(instanceId);

  return {
    instanceId,
    plugin: clonePluginMetadata({
      ...plugin,
      inputs: instance.inputChannels,
      outputs: instance.outputChannels,
      parameters: instance.parameters,
      vst3ProgramLists: instance.vst3ProgramLists,
      vst3NoteExpressions: instance.vst3NoteExpressions
    }),
    layout: clonePluginLayout(instance.layout),
    latencySamples: instance.pluginLatencySamples,
    tailSamples: instance.pluginTailSamples,
    infiniteTail: instance.pluginInfiniteTail
  };
}

function destroyInstance(instanceId, session) {
  const instance = getInstance(instanceId, session);
  destroyInstanceRecord(instance);
  return {
    destroyed: true
  };
}

async function setParameter(instanceId, parameterId, normalizedValue, session) {
  const instance = getInstance(instanceId, session);
  const safeParameterId = requireParameterId(parameterId, "parameterId");
  const parameterIndex = instance.parameters.findIndex((parameter) => parameter.id === safeParameterId);
  if (parameterIndex < 0) {
    throw protocolError("parameter_not_found", `Unknown parameter: ${safeParameterId}`);
  }
  assertParameterWritable(instance.parameters[parameterIndex]);

  const value = requireNumberInRange(normalizedValue, 0, 1, "normalizedValue");
  await applyParameterValue(instance, parameterIndex, value, 0);

  return {
    parameter: { ...instance.parameters[parameterIndex] }
  };
}

async function setParameterDisplayValue(instanceId, parameterId, displayValue, session) {
  const instance = getInstance(instanceId, session);
  const safeParameterId = requireParameterId(parameterId, "parameterId");
  const parameterIndex = instance.parameters.findIndex((parameter) => parameter.id === safeParameterId);
  if (parameterIndex < 0) {
    throw protocolError("parameter_not_found", `Unknown parameter: ${safeParameterId}`);
  }
  assertParameterWritable(instance.parameters[parameterIndex]);

  const safeDisplayValue = requireParameterDisplayValue(displayValue, "displayValue");
  await applyParameterDisplayValue(instance, parameterIndex, safeDisplayValue);

  return {
    parameter: { ...instance.parameters[parameterIndex] }
  };
}

async function setPreset(instanceId, presetId, session) {
  const instance = getInstance(instanceId, session);
  const safePresetId = requirePresetId(presetId, "presetId");
  const plugin = getPlugin(instance.pluginId);
  const preset = (plugin?.presets ?? [])
    .slice(0, MAX_PLUGIN_PRESETS)
    .map((candidate, index) => normalizePresetSnapshot(candidate, index))
    .filter(Boolean)
    .find((candidate) => candidate.id === safePresetId);

  if (!preset) {
    throw protocolError("preset_not_found", `Unknown preset: ${safePresetId}`);
  }

  const updatedParameterIndexes = new Set();
  for (const [parameterId, normalizedValue] of Object.entries(preset.parameters)) {
    const parameterIndex = instance.parameters.findIndex((parameter) => parameter.id === parameterId);
    if (parameterIndex < 0) {
      continue;
    }
    if (instance.parameters[parameterIndex].readOnly) {
      continue;
    }
    await applyParameterValue(instance, parameterIndex, normalizedValue, 0);
    updatedParameterIndexes.add(parameterIndex);
  }

  const parameters = [...updatedParameterIndexes].map((index) => ({ ...instance.parameters[index] }));
  return {
    applied: parameters.length > 0,
    presetId: preset.id,
    parameterCount: parameters.length,
    parameters
  };
}

async function setParameterEvents(instanceId, events, session) {
  const instance = getInstance(instanceId, session);
  const acceptedEvents = normalizeParameterEvents(events, instance.maxBlockSize);
  const updatedParameterIndexes = new Set();

  for (const event of acceptedEvents) {
    const parameterIndex = instance.parameters.findIndex((parameter) => parameter.id === event.parameterId);
    if (parameterIndex < 0) {
      throw protocolError("parameter_not_found", `Unknown parameter: ${event.parameterId}`);
    }
    assertParameterAutomatable(instance.parameters[parameterIndex]);
    await applyParameterValue(instance, parameterIndex, event.normalizedValue, event.time);
    updatedParameterIndexes.add(parameterIndex);
  }

  return {
    accepted: true,
    eventCount: acceptedEvents.length,
    parameters: [...updatedParameterIndexes].map((index) => ({ ...instance.parameters[index] }))
  };
}

async function setParameterCurve(instanceId, parameterId, points, interpolation, session) {
  const instance = getInstance(instanceId, session);
  const safeParameterId = requireParameterId(parameterId, "parameterId");
  const parameterIndex = instance.parameters.findIndex((parameter) => parameter.id === safeParameterId);
  if (parameterIndex < 0) {
    throw protocolError("parameter_not_found", `Unknown parameter: ${safeParameterId}`);
  }
  assertParameterAutomatable(instance.parameters[parameterIndex]);

  const events = normalizeParameterCurve(safeParameterId, points, interpolation, instance.maxBlockSize);
  for (const event of events) {
    await applyParameterValue(instance, parameterIndex, event.normalizedValue, event.time);
  }

  return {
    accepted: true,
    eventCount: events.length,
    parameter: { ...instance.parameters[parameterIndex] }
  };
}

function setAutomationLane(instanceId, parameterId, points, session) {
  const instance = getInstance(instanceId, session);
  const safeParameterId = requireParameterId(parameterId, "parameterId");
  const parameterIndex = instance.parameters.findIndex((parameter) => parameter.id === safeParameterId);
  if (parameterIndex < 0) {
    throw protocolError("parameter_not_found", `Unknown parameter: ${safeParameterId}`);
  }
  assertParameterAutomatable(instance.parameters[parameterIndex]);

  const normalizedPoints = normalizeAutomationLanePoints(points);
  if (!instance.automationLanes.has(safeParameterId) && instance.automationLanes.size >= MAX_AUTOMATION_LANES_PER_INSTANCE) {
    throw protocolError("quota_exceeded", "This plugin instance has reached its automation lane limit.", {
      maxAutomationLanesPerInstance: MAX_AUTOMATION_LANES_PER_INSTANCE
    });
  }
  instance.automationLanes.set(safeParameterId, normalizedPoints);

  return {
    accepted: true,
    parameterId: safeParameterId,
    pointCount: normalizedPoints.length,
    laneCount: instance.automationLanes.size,
    parameter: { ...instance.parameters[parameterIndex] }
  };
}

function clearAutomationLane(instanceId, parameterId, session) {
  const instance = getInstance(instanceId, session);
  const safeParameterId = parameterId == null ? undefined : requireParameterId(parameterId, "parameterId");
  if (safeParameterId) {
    if (!instance.parameters.some((parameter) => parameter.id === safeParameterId)) {
      throw protocolError("parameter_not_found", `Unknown parameter: ${safeParameterId}`);
    }
    instance.automationLanes.delete(safeParameterId);
  } else {
    instance.automationLanes.clear();
  }

  return {
    cleared: true,
    parameterId: safeParameterId,
    laneCount: instance.automationLanes.size
  };
}

async function applyAutomationLanesForBlock(instance, transport, frames) {
  const laneEvents = collectAutomationLaneEvents(instance, transport, frames);
  const preparedEvents = laneEvents.map((event) => {
    const parameterIndex = instance.parameters.findIndex((parameter) => parameter.id === event.parameterId);
    if (parameterIndex < 0) {
      throw protocolError("parameter_not_found", `Unknown parameter: ${event.parameterId}`);
    }
    assertParameterAutomatable(instance.parameters[parameterIndex]);
    return { ...event, parameterIndex };
  });
  for (const event of preparedEvents) {
    await applyParameterValue(instance, event.parameterIndex, event.normalizedValue, event.time);
  }
  return laneEvents.length;
}

async function applyParameterValue(instance, parameterIndex, normalizedValue, sampleOffset = 0) {
  const parameter = instance.parameters[parameterIndex];
  validateParameterSampleOffsetForBlockProfile(instance, sampleOffset);
  if (
    instance.nativeParameterIds.has(parameter.id) &&
    instance.worker &&
    typeof instance.worker.setParameter === "function"
  ) {
    const nativeParameter = await instance.worker.setParameter(parameter.id, normalizedValue, sampleOffset);
    if (nativeParameter) {
      instance.parameters[parameterIndex] = makeNativeUpdatedParameter(nativeParameter, normalizedValue);
      return;
    }
  }

  instance.parameters[parameterIndex] = makeUpdatedParameter(parameter, normalizedValue);
}

async function applyParameterDisplayValue(instance, parameterIndex, displayValue) {
  const parameter = instance.parameters[parameterIndex];
  if (
    instance.nativeParameterIds.has(parameter.id) &&
    instance.worker &&
    typeof instance.worker.setParameterDisplayValue === "function"
  ) {
    const nativeParameter = await instance.worker.setParameterDisplayValue(parameter.id, displayValue);
    if (nativeParameter) {
      instance.parameters[parameterIndex] = makeNativeUpdatedParameter(nativeParameter, nativeParameter.normalizedValue);
      return;
    }
  }

  const normalizedValue = normalizedValueFromDisplayValue(parameter, displayValue);
  if (!Number.isFinite(normalizedValue)) {
    throw protocolError("invalid_argument", "displayValue could not be parsed for this parameter.");
  }
  await applyParameterValue(instance, parameterIndex, requireNumberInRange(normalizedValue, 0, 1, "displayValue"));
}

async function getState(instanceId, session) {
  const instance = getInstance(instanceId, session);
  const nativeState = await getNativeState(instance);
  const state = encodeStateEnvelope({
    version: nativeState ? 2 : 1,
    pluginId: instance.pluginId,
    format: instance.format,
    parameters: Object.fromEntries(
      instance.parameters.map((parameter) => [parameter.id, parameter.normalizedValue])
    ),
    ...(nativeState ? { nativeState } : {})
  });

  return { state };
}

async function setState(instanceId, state, session) {
  const instance = getInstance(instanceId, session);
  const parsed = decodeStateEnvelope(state);

  if (parsed.pluginId !== instance.pluginId) {
    throw protocolError("state_plugin_mismatch", "State belongs to a different plugin.");
  }

  const nativeState = normalizeNativeState(parsed.nativeState, instance.format);
  if (nativeState && instance.worker && typeof instance.worker.setState === "function") {
    await instance.worker.setState(nativeState);
    const nativeParameters = await instance.worker.getParameters();
    if (nativeParameters.length > 0) {
      instance.parameters = nativeParameters;
      instance.nativeParameterIds = new Set(nativeParameters.map((parameter) => parameter.id));
    }
  } else {
    for (const [parameterIndex, parameter] of instance.parameters.entries()) {
      if (parsed.parameters && Object.hasOwn(parsed.parameters, parameter.id)) {
        if (parameter.readOnly) {
          continue;
        }
        const value = clamp01(Number(parsed.parameters[parameter.id]));
        await applyParameterValue(instance, parameterIndex, value);
      }
    }
  }
  return {
    restored: true,
    parameters: instance.parameters.map((parameter) => ({ ...parameter }))
  };
}

function getLatency(payload, session) {
  const instance = getInstance(payload.instanceId, session);
  const transportLatencySamples = requireIntInRange(
    payload.transportLatencySamples ?? 0,
    0,
    MAX_PLUGIN_LATENCY_SAMPLES,
    "transportLatencySamples"
  );
  const pluginLatencySamples = normalizeLatencySamples(instance.pluginLatencySamples);
  return {
    pluginLatencySamples,
    transportLatencySamples,
    reportedLatencySamples: normalizeLatencySamples(pluginLatencySamples + transportLatencySamples)
  };
}

function getTailTime(payload, session) {
  const instance = getInstance(payload.instanceId, session);
  return {
    tailSamples: normalizeTailSamples(instance.pluginTailSamples),
    infiniteTail: Boolean(instance.pluginInfiniteTail)
  };
}

function getLayout(payload, session) {
  const instance = getInstance(payload.instanceId, session);
  return clonePluginLayout(instance.layout);
}

async function processAudioBlock(payload, session) {
  const instance = getInstance(payload.instanceId, session);
  const requestedFrames = firstAudioFrameCount(payload, instance.maxBlockSize);
  const frames = boundedFrames(requestedFrames, instance.maxBlockSize);
  validateRenderBlockSizeProfile(instance, requestedFrames, frames);
  const blockSampleRate = clampSampleRate(payload.sampleRate, instance.sampleRate);
  const mainInputChannels = normalizeAudioChannels(payload.channels, MAX_AUDIO_CHANNELS, frames);
  const inputBuses = normalizeAudioBusBlocks(payload.inputBuses, mainInputChannels, instance.layout?.inputBusLayouts, frames, {
    strictRequest: true,
    label: "inputBuses"
  });
  const channels = inputBuses.find((bus) => bus.index === 0)?.channels ?? mainInputChannels;
  const transport = normalizeTransportState(payload.transport);
  await applyAutomationLanesForBlock(instance, transport, frames);

  if (instance.kind === "instrument") {
    const processed = await processInstrumentBlock(instance, frames, blockSampleRate);
    const processedChannels = normalizeAudioChannels(processed.channels, instance.outputChannels, frames);
    return {
      blockId: payload.blockId,
      ...processed,
      channels: processedChannels,
      outputBuses: normalizeOutputBusBlocks(processed.outputBuses, processedChannels, instance.layout, frames),
      ...(transport ? { transport } : {}),
      latencySamples: normalizeLatencySamples(instance.pluginLatencySamples),
      tailSamples: normalizeTailSamples(instance.pluginTailSamples),
      infiniteTail: Boolean(instance.pluginInfiniteTail)
    };
  }

  if (instance.worker) {
    const rendered = await instance.worker.render({
      frames,
      sampleRate: blockSampleRate,
      channels,
      inputBuses,
      transport
    });
    const renderedChannels = Array.isArray(rendered) ? rendered : rendered.channels;
    return {
      blockId: payload.blockId,
      channels: normalizeAudioChannels(renderedChannels, instance.outputChannels, frames),
      outputBuses: normalizeOutputBusBlocks(rendered.outputBuses, renderedChannels, instance.layout, frames),
      ...(transport ? { transport } : {}),
      latencySamples: normalizeLatencySamples(instance.pluginLatencySamples),
      tailSamples: normalizeTailSamples(instance.pluginTailSamples),
      infiniteTail: Boolean(instance.pluginInfiniteTail),
      renderEngine: instance.renderEngine ?? instance.worker.renderEngine ?? "native-host"
    };
  }

  const gainLinear = Math.pow(10, normalizedGainToDb(parameterValue(instance, "gain", 0.5)) / 20);
  const output = channels.slice(0, instance.outputChannels).map((channel) => {
    if (!Array.isArray(channel)) {
      return [];
    }
    return channel.map((sample) => {
      const value = Number(sample) * gainLinear;
      if (!Number.isFinite(value)) {
        return 0;
      }
      return Math.max(-1, Math.min(1, value));
    });
  });

  while (output.length < instance.outputChannels) {
    output.push(new Array(output[0]?.length ?? 128).fill(0));
  }

  return {
    blockId: payload.blockId,
    channels: output,
    outputBuses: normalizeOutputBusBlocks(undefined, output, instance.layout, frames),
    ...(transport ? { transport } : {}),
    latencySamples: normalizeLatencySamples(instance.pluginLatencySamples),
    tailSamples: normalizeTailSamples(instance.pluginTailSamples),
    infiniteTail: Boolean(instance.pluginInfiniteTail)
  };
}

function getInstance(instanceId, session) {
  const instance = instances.get(instanceId);
  if (!instance) {
    throw protocolError("instance_not_found", `Unknown instance: ${instanceId}`);
  }
  if (session && instance.ownerSessionToken !== session.sessionToken) {
    throw protocolError("instance_access_denied", "This plugin instance belongs to a different browser session.", {
      instanceId,
      requestOrigin: session.origin
    });
  }
  return instance;
}

function getPlugin(pluginId) {
  return plugins.find((plugin) => plugin.pluginId === pluginId);
}

async function sendMidiEvents(instanceId, events, session) {
  const instance = getInstance(instanceId, session);
  const acceptedEvents = normalizeMidiEvents(events, instance.maxBlockSize);
  const hasVst3NoteExpressionEvent = acceptedEvents.some((event) =>
    event.type === "noteExpression" || event.type === "noteExpressionText"
  );
  if (hasVst3NoteExpressionEvent && instance.nativeHost?.format !== "vst3") {
    throw protocolError("unsupported_midi_event", "VST3 note-expression events require a VST3 native worker.");
  }
  const hasNativeMidiWorker =
    typeof instance.renderEngine === "string" &&
    instance.renderEngine.startsWith("native-") &&
    instance.worker &&
    typeof instance.worker.sendMidiEvents === "function";
  if (instance.kind !== "instrument" && !hasNativeMidiWorker) {
    return {
      accepted: false,
      eventCount: 0
    };
  }

  for (const event of acceptedEvents) {
    if (instance.kind === "instrument" && event.type === "noteOn" && event.velocity > 0) {
      instance.voices.set(event.note, {
        note: event.note,
        frequency: midiNoteToFrequency(event.note),
        velocity: event.velocity,
        phase: 0,
        phase2: 0
      });
    } else if (instance.kind === "instrument" && (event.type === "noteOff" || event.type === "noteOn")) {
      instance.voices.delete(event.note);
    }
  }

  if (instance.worker) {
    await instance.worker.sendMidiEvents(acceptedEvents);
  }

  return {
    accepted: true,
    eventCount: acceptedEvents.length
  };
}
