import crypto from "node:crypto";
import { createDaemonControlEvents } from "./daemon-control-events.mjs";
import { createDaemonEditors } from "./daemon-editors.mjs";
import { createDaemonFileGrants } from "./daemon-file-grants.mjs";
import { createDaemonInstrumentRendering } from "./daemon-instrument-rendering.mjs";
import { createDaemonLifecycle } from "./daemon-lifecycle.mjs";
import { createMockInstrumentSupport } from "./daemon-mock-instruments.mjs";
import { createDaemonNormalizers } from "./daemon-normalizers.mjs";
import { createPluginCatalogSupport, loadNativeHostStatus, resolveNativeRenderer } from "./daemon-plugin-catalog.mjs";
import { createDaemonRuntimePayloads } from "./daemon-runtime-payloads.mjs";
import { createDaemonVst3ProgramData } from "./daemon-vst3-program-data.mjs";
import { createConfiguredNativeEditorBroker } from "./native-editor-broker-process.mjs";
import {
  assertLoopbackHost,
  createDaemonValidators,
  envInteger,
  envList,
  isLoopbackHostHeader,
  protocolError,
  sendError,
  tokenEquals
} from "./daemon-security-helpers.mjs";
import { createDaemonWebSocketServer } from "./daemon-websocket-server.mjs";
import { createDaemonWorkerSecurity } from "./daemon-worker-security.mjs";
import { createConfiguredFileGrantApprovalBroker } from "./file-grant-approval-broker-process.mjs";

const HOST = process.env.SOUNDBRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SOUNDBRIDGE_PORT ?? 47370);
const CONFIGURED_PAIRING_TOKEN = process.env.SOUNDBRIDGE_PAIRING_TOKEN?.trim();
const PAIRING_TOKEN = CONFIGURED_PAIRING_TOKEN || crypto.randomBytes(18).toString("base64url");
const PAIRING_TOKEN_IS_EPHEMERAL = !CONFIGURED_PAIRING_TOKEN;
const PROTOCOL_VERSION = "0.1.0";
const SESSION_TTL_MS = envInteger("SOUNDBRIDGE_SESSION_TTL_MS", 30 * 60 * 1000);
const MAX_SESSIONS_PER_ORIGIN = envInteger("SOUNDBRIDGE_MAX_SESSIONS_PER_ORIGIN", 8);
const MAX_INSTANCES_PER_SESSION = envInteger("SOUNDBRIDGE_MAX_INSTANCES_PER_SESSION", 8);
const MAX_TOTAL_INSTANCES = envInteger("SOUNDBRIDGE_MAX_TOTAL_INSTANCES", 32);
const MAX_WEBSOCKET_MESSAGE_BYTES = envInteger("SOUNDBRIDGE_MAX_WEBSOCKET_MESSAGE_BYTES", 1024 * 1024);
const MAX_TOTAL_SESSIONS = envInteger("SOUNDBRIDGE_MAX_TOTAL_SESSIONS", 64);
const MAX_AUDIO_CHANNELS = envInteger("SOUNDBRIDGE_MAX_AUDIO_CHANNELS", 32);
const MAX_PLUGIN_BUSES = envInteger("SOUNDBRIDGE_MAX_PLUGIN_BUSES", 32);
const MAX_BLOCK_SIZE = envInteger("SOUNDBRIDGE_MAX_BLOCK_SIZE", 8192);
const MAX_MIDI_EVENTS_PER_REQUEST = envInteger("SOUNDBRIDGE_MAX_MIDI_EVENTS_PER_REQUEST", 4096);
const MAX_NOTE_EXPRESSION_TEXT_BYTES = Math.min(envInteger("SOUNDBRIDGE_MAX_NOTE_EXPRESSION_TEXT_BYTES", 256), 1024);
const MAX_PARAMETER_EVENTS_PER_REQUEST = envInteger("SOUNDBRIDGE_MAX_PARAMETER_EVENTS_PER_REQUEST", 4096);
const MAX_AUTOMATION_CURVE_POINTS = Math.min(
  envInteger("SOUNDBRIDGE_MAX_AUTOMATION_CURVE_POINTS", 256),
  256,
  MAX_PARAMETER_EVENTS_PER_REQUEST
);
const MAX_AUTOMATION_LANES_PER_INSTANCE = Math.min(
  envInteger("SOUNDBRIDGE_MAX_AUTOMATION_LANES_PER_INSTANCE", 128),
  1024
);
const MAX_AUTOMATION_LANE_POINTS = Math.min(
  envInteger("SOUNDBRIDGE_MAX_AUTOMATION_LANE_POINTS", 4096),
  4096
);
const MAX_EDITORS_PER_SESSION = envInteger("SOUNDBRIDGE_MAX_EDITORS_PER_SESSION", 8);
const MAX_TOTAL_EDITORS = envInteger("SOUNDBRIDGE_MAX_TOTAL_EDITORS", 32);
const EDITOR_SESSION_TTL_MS = envInteger("SOUNDBRIDGE_EDITOR_SESSION_TTL_MS", 10 * 60 * 1000);
const MAX_FILE_GRANTS_PER_SESSION = envInteger("SOUNDBRIDGE_MAX_FILE_GRANTS_PER_SESSION", 8);
const MAX_TOTAL_FILE_GRANTS = envInteger("SOUNDBRIDGE_MAX_TOTAL_FILE_GRANTS", 64);
const FILE_GRANT_TTL_MS = envInteger("SOUNDBRIDGE_FILE_GRANT_TTL_MS", 10 * 60 * 1000);
const MAX_FILE_GRANT_PATH_BYTES = Math.min(envInteger("SOUNDBRIDGE_MAX_FILE_GRANT_PATH_BYTES", 4096), 4096);
const MAX_FILE_GRANT_DISPLAY_NAME_BYTES = Math.min(
  envInteger("SOUNDBRIDGE_MAX_FILE_GRANT_DISPLAY_NAME_BYTES", 160),
  256
);
const MAX_PLUGIN_PARAMETERS = envInteger("SOUNDBRIDGE_MAX_PLUGIN_PARAMETERS", 1024);
const MAX_PLUGIN_PRESETS = Math.min(envInteger("SOUNDBRIDGE_MAX_PLUGIN_PRESETS", 256), 256);
const MAX_PLUGIN_PROGRAM_LISTS = Math.min(envInteger("SOUNDBRIDGE_MAX_PLUGIN_PROGRAM_LISTS", 256), 256);
const MAX_PLUGIN_PROGRAMS = Math.min(envInteger("SOUNDBRIDGE_MAX_PLUGIN_PROGRAMS", 256), 256);
const MAX_PLUGIN_NOTE_EXPRESSIONS = Math.min(envInteger("SOUNDBRIDGE_MAX_PLUGIN_NOTE_EXPRESSIONS", 256), 256);
const MAX_PLUGIN_PARAMETER_TEXT_BYTES = envInteger("SOUNDBRIDGE_MAX_PLUGIN_PARAMETER_TEXT_BYTES", 160);
const MAX_PLUGIN_METADATA_TEXT_BYTES = envInteger("SOUNDBRIDGE_MAX_PLUGIN_METADATA_TEXT_BYTES", 256);
const MAX_PLUGIN_STATE_BYTES = envInteger("SOUNDBRIDGE_MAX_PLUGIN_STATE_BYTES", 384 * 1024);
const MAX_PLUGIN_PROGRAM_DATA_BYTES = Math.min(
  envInteger("SOUNDBRIDGE_MAX_PLUGIN_PROGRAM_DATA_BYTES", 384 * 1024),
  MAX_PLUGIN_STATE_BYTES
);
const MAX_PLUGIN_STATE_ENVELOPE_BYTES = envInteger("SOUNDBRIDGE_MAX_PLUGIN_STATE_ENVELOPE_BYTES", 1024 * 1024);
const MAX_PLUGIN_PROGRAM_DATA_ENVELOPE_BYTES = MAX_PLUGIN_STATE_ENVELOPE_BYTES;
const MAX_PLUGIN_LATENCY_SAMPLES = envInteger("SOUNDBRIDGE_MAX_PLUGIN_LATENCY_SAMPLES", 1_048_576);
const MAX_PLUGIN_TAIL_SAMPLES = envInteger("SOUNDBRIDGE_MAX_PLUGIN_TAIL_SAMPLES", 1_048_576);
const MAX_TRANSPORT_TEMPO_BPM = envInteger("SOUNDBRIDGE_MAX_TRANSPORT_TEMPO_BPM", 960);
const MAX_TRANSPORT_POSITION_MUSIC = envInteger("SOUNDBRIDGE_MAX_TRANSPORT_POSITION_MUSIC", 1_000_000_000);
const MAX_TRANSPORT_SAMPLE_POSITION = Number.MAX_SAFE_INTEGER;
const MAX_PAIR_ATTEMPTS_PER_CONNECTION = envInteger("SOUNDBRIDGE_MAX_PAIR_ATTEMPTS", 5);
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 384000;
const ALLOWED_ORIGINS = envList("SOUNDBRIDGE_ALLOWED_ORIGINS");
const FILE_GRANT_ROOTS = envList("SOUNDBRIDGE_FILE_GRANT_ROOTS");
const ALLOW_BROWSER_FILE_GRANT_PATHS = process.env.SOUNDBRIDGE_FILE_GRANT_ALLOW_BROWSER_PATHS === "1";
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
const mockInstruments = createMockInstrumentSupport({
  clamp01,
  finiteNumber
});
const {
  makeNativeUpdatedParameter,
  makeUpdatedParameter,
  midiNoteToFrequency,
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
const {
  assertPaired,
  cleanupConnection,
  cleanupExpiredEditors,
  cleanupExpiredSessions,
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

const server = createDaemonWebSocketServer({
  host: HOST,
  port: PORT,
  maxWebSocketMessageBytes: MAX_WEBSOCKET_MESSAGE_BYTES,
  isLoopbackHostHeader,
  createConnectionContext({ requestOrigin, terminate }) {
    return {
      connectionId: crypto.randomUUID(),
      requestOrigin,
      sessionTokens: new Set(),
      pairFailures: 0,
      terminate
    };
  },
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

    case "heartbeat":
      return {
        now: Date.now(),
        echo: payload.now
      };

    default:
      throw protocolError("unknown_command", `Unknown command: ${command}`);
  }
}

function helloResponse(paired) {
  return {
    name: "soundbridge-mock-daemon",
    protocolVersion: PROTOCOL_VERSION,
    pairingRequired: true,
    transports: [
      {
        kind: "websocket",
        url: `ws://${HOST}:${PORT}/bridge`,
        audioEncoding: "json-float32-arrays"
      }
    ],
    capabilities: {
      pluginFormats: paired ? createPluginFormatCapabilities() : {},
      ...(paired
        ? {
            vst3: true,
            au: true,
            lv2: true,
            mockPlugins: true,
            state: true,
            latency: true,
            tail: true,
            layout: true,
            midi: true,
            automation: true,
            transport: true,
            genericEditor: true,
            fileAccess: fileGrantSupport.browserPathGrantsAvailable() || fileGrantSupport.nativeApprovalAvailable(),
            nativeExampleRenderer: Boolean(NATIVE_RENDERER),
            nativeEditor: Boolean(nativeEditorBroker?.available)
          }
        : {}),
      security: {
        originAllowlist: ALLOWED_ORIGINS.length > 0,
        sessionBoundToConnection: true,
        sessionBoundToOrigin: true,
        instanceOwnership: true,
        cleanupOnDisconnect: true,
        hostHeaderValidation: true,
        fileBroker: fileGrantSupport.available(),
        fileGrantApprovalBroker: fileGrantSupport.nativeApprovalAvailable(),
        browserFileGrantPaths: fileGrantSupport.browserPathGrantsAvailable(),
        nativeEditorBroker: Boolean(nativeEditorBroker?.available),
        maxInstancesPerSession: MAX_INSTANCES_PER_SESSION,
        maxTotalInstances: MAX_TOTAL_INSTANCES,
        maxEditorsPerSession: MAX_EDITORS_PER_SESSION,
        maxTotalEditors: MAX_TOTAL_EDITORS,
        maxEditorSessionTtlMs: EDITOR_SESSION_TTL_MS,
        maxFileGrantsPerSession: MAX_FILE_GRANTS_PER_SESSION,
        maxTotalFileGrants: MAX_TOTAL_FILE_GRANTS,
        maxFileGrantTtlMs: FILE_GRANT_TTL_MS,
        maxFileGrantPathBytes: MAX_FILE_GRANT_PATH_BYTES,
        maxFileGrantDisplayNameBytes: MAX_FILE_GRANT_DISPLAY_NAME_BYTES,
        maxTotalSessions: MAX_TOTAL_SESSIONS,
        maxAudioChannels: MAX_AUDIO_CHANNELS,
        maxBlockSize: MAX_BLOCK_SIZE,
        maxPluginNoteExpressions: MAX_PLUGIN_NOTE_EXPRESSIONS,
        maxPluginProgramDataBytes: MAX_PLUGIN_PROGRAM_DATA_BYTES,
        maxPluginProgramDataEnvelopeBytes: MAX_PLUGIN_PROGRAM_DATA_ENVELOPE_BYTES,
        maxPluginProgramLists: MAX_PLUGIN_PROGRAM_LISTS,
        maxPluginPrograms: MAX_PLUGIN_PROGRAMS,
        maxNoteExpressionTextBytes: MAX_NOTE_EXPRESSION_TEXT_BYTES,
        maxParameterEventsPerRequest: MAX_PARAMETER_EVENTS_PER_REQUEST,
        maxAutomationCurvePoints: MAX_AUTOMATION_CURVE_POINTS,
        maxAutomationLanesPerInstance: MAX_AUTOMATION_LANES_PER_INSTANCE,
        maxAutomationLanePoints: MAX_AUTOMATION_LANE_POINTS,
        maxTransportTempoBpm: MAX_TRANSPORT_TEMPO_BPM,
        maxTransportPositionMusic: MAX_TRANSPORT_POSITION_MUSIC,
        maxTransportSamplePosition: MAX_TRANSPORT_SAMPLE_POSITION,
        ...workerSecurityLimits
      }
    }
  };
}

function pair(payload, context) {
  cleanupExpiredSessions();
  if (context.pairFailures >= MAX_PAIR_ATTEMPTS_PER_CONNECTION) {
    throw protocolError("pairing_locked", "Too many failed pairing attempts on this connection.");
  }
  const requestedOrigin = String(payload.origin ?? context.requestOrigin);
  if (context.requestOrigin === "unknown-origin") {
    throw protocolError("origin_required", "Pairing requires a WebSocket Origin header.");
  }
  if (!tokenEquals(payload.pairingToken, PAIRING_TOKEN)) {
    context.pairFailures += 1;
    if (context.pairFailures >= MAX_PAIR_ATTEMPTS_PER_CONNECTION) {
      context.terminate?.();
    }
    throw protocolError("pairing_denied", "Invalid pairing token.");
  }

  if (context.requestOrigin !== "unknown-origin" && requestedOrigin !== context.requestOrigin) {
    throw protocolError("origin_mismatch", "Pairing origin does not match the WebSocket Origin header.");
  }

  if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(requestedOrigin)) {
    throw protocolError("origin_not_allowed", "This browser origin is not allowed to pair with SoundBridge.", {
      origin: requestedOrigin
    });
  }

  if (sessionsForOrigin(requestedOrigin).length >= MAX_SESSIONS_PER_ORIGIN) {
    throw protocolError("quota_exceeded", "Too many active SoundBridge sessions for this origin.", {
      origin: requestedOrigin,
      maxSessionsPerOrigin: MAX_SESSIONS_PER_ORIGIN
    });
  }

  if (sessions.size >= MAX_TOTAL_SESSIONS) {
    throw protocolError("quota_exceeded", "The local SoundBridge daemon has reached its total session limit.", {
      maxTotalSessions: MAX_TOTAL_SESSIONS
    });
  }

  const sessionToken = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(sessionToken, {
    sessionToken,
    origin: requestedOrigin,
    connectionId: context.connectionId,
    expiresAt,
    instances: new Set(),
    editors: new Set(),
    fileGrants: new Set(),
    createdAt: Date.now(),
    lastSeenAt: Date.now()
  });
  context.sessionTokens.add(sessionToken);

  return {
    sessionToken,
    expiresAt
  };
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
  const frames = boundedFrames(firstAudioFrameCount(payload, instance.maxBlockSize), instance.maxBlockSize);
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
