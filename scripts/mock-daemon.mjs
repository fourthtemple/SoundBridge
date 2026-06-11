import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const MAX_PARAMETER_EVENTS_PER_REQUEST = envInteger("SOUNDBRIDGE_MAX_PARAMETER_EVENTS_PER_REQUEST", 4096);
const MAX_PLUGIN_PARAMETERS = envInteger("SOUNDBRIDGE_MAX_PLUGIN_PARAMETERS", 1024);
const MAX_PLUGIN_PARAMETER_TEXT_BYTES = envInteger("SOUNDBRIDGE_MAX_PLUGIN_PARAMETER_TEXT_BYTES", 160);
const MAX_PLUGIN_METADATA_TEXT_BYTES = envInteger("SOUNDBRIDGE_MAX_PLUGIN_METADATA_TEXT_BYTES", 256);
const MAX_PLUGIN_STATE_BYTES = envInteger("SOUNDBRIDGE_MAX_PLUGIN_STATE_BYTES", 384 * 1024);
const MAX_PLUGIN_STATE_ENVELOPE_BYTES = envInteger("SOUNDBRIDGE_MAX_PLUGIN_STATE_ENVELOPE_BYTES", 1024 * 1024);
const MAX_PLUGIN_LATENCY_SAMPLES = envInteger("SOUNDBRIDGE_MAX_PLUGIN_LATENCY_SAMPLES", 1_048_576);
const MAX_PLUGIN_TAIL_SAMPLES = envInteger("SOUNDBRIDGE_MAX_PLUGIN_TAIL_SAMPLES", 1_048_576);
const MAX_PAIR_ATTEMPTS_PER_CONNECTION = envInteger("SOUNDBRIDGE_MAX_PAIR_ATTEMPTS", 5);
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 384000;
const ALLOWED_ORIGINS = envList("SOUNDBRIDGE_ALLOWED_ORIGINS");

assertLoopbackHost(HOST, "SOUNDBRIDGE_HOST", "SOUNDBRIDGE_ALLOW_NON_LOOPBACK");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_RENDERER = resolveNativeRenderer();
const NATIVE_HOST_STATUS = loadNativeHostStatus();

const sessions = new Map();
const instances = new Map();

const plugins = createPluginCatalog();

const server = http.createServer((request, response) => {
  if (!isLoopbackHostHeader(request.headers.host)) {
    writeJson(response, 403, {
      ok: false,
      error: "forbidden_host"
    });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);

  if (url.pathname === "/health") {
    writeJson(response, 200, {
      ok: true
    });
    return;
  }

  writeJson(response, 404, {
    ok: false,
    error: "not_found"
  });
});

server.on("upgrade", (request, socket) => {
  if (!isLoopbackHostHeader(request.headers.host)) {
    socket.destroy();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
  if (url.pathname !== "/bridge") {
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n"
    ].join("\r\n")
  );

  attachWebSocket(socket, request.headers.origin ?? "unknown-origin");
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

function attachWebSocket(socket, requestOrigin) {
  let buffer = Buffer.alloc(0);
  const context = {
    connectionId: crypto.randomUUID(),
    requestOrigin: String(requestOrigin),
    sessionTokens: new Set(),
    pairFailures: 0,
    terminate: () => socket.destroy()
  };

  const send = (message) => {
    socket.write(encodeWebSocketFrame(Buffer.from(JSON.stringify(message), "utf8"), 0x1));
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_WEBSOCKET_MESSAGE_BYTES + 14) {
      socket.destroy();
      return;
    }

    while (buffer.length > 0) {
      const parsed = decodeWebSocketFrame(buffer);
      if (!parsed) {
        return;
      }
      if (parsed.tooLarge) {
        socket.destroy();
        return;
      }

      buffer = buffer.subarray(parsed.frameLength);

      if (parsed.opcode === 0x8) {
        socket.end();
        return;
      }

      if (parsed.opcode === 0x9) {
        socket.write(encodeWebSocketFrame(parsed.payload, 0xA));
        continue;
      }

      if (parsed.opcode !== 0x1) {
        continue;
      }

      void handleRequest(parsed.payload.toString("utf8"), context, send);
    }
  });

  socket.on("error", () => {});
  socket.on("close", () => cleanupConnection(context));
}

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

    case "setParameterEvents":
      return setParameterEvents(payload.instanceId, payload.events, session);

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
    case "closeEditor":
      throw protocolError("unsupported_command", `${command} is reserved for a later phase.`);

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
            nativeExampleRenderer: Boolean(NATIVE_RENDERER),
            nativeEditor: false
          }
        : {}),
      security: {
        originAllowlist: ALLOWED_ORIGINS.length > 0,
        sessionBoundToConnection: true,
        sessionBoundToOrigin: true,
        instanceOwnership: true,
        cleanupOnDisconnect: true,
        hostHeaderValidation: true,
        maxInstancesPerSession: MAX_INSTANCES_PER_SESSION,
        maxTotalInstances: MAX_TOTAL_INSTANCES,
        maxTotalSessions: MAX_TOTAL_SESSIONS,
        maxAudioChannels: MAX_AUDIO_CHANNELS,
        maxBlockSize: MAX_BLOCK_SIZE,
        maxParameterEventsPerRequest: MAX_PARAMETER_EVENTS_PER_REQUEST
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
    nativeParameterIds: new Set(),
    pluginLatencySamples: 0,
    pluginTailSamples: 0,
    pluginInfiniteTail: false,
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
      parameters: instance.parameters
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

  const value = requireNumberInRange(normalizedValue, 0, 1, "normalizedValue");
  await applyParameterValue(instance, parameterIndex, value, 0);

  return {
    parameter: { ...instance.parameters[parameterIndex] }
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
    await applyParameterValue(instance, parameterIndex, event.normalizedValue, event.time);
    updatedParameterIndexes.add(parameterIndex);
  }

  return {
    accepted: true,
    eventCount: acceptedEvents.length,
    parameters: [...updatedParameterIndexes].map((index) => ({ ...instance.parameters[index] }))
  };
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

async function getNativeState(instance) {
  if (!instance.worker || typeof instance.worker.getState !== "function") {
    return undefined;
  }
  return instance.worker.getState();
}

function encodeStateEnvelope(envelope) {
  const json = JSON.stringify(envelope);
  const encoded = Buffer.from(json, "utf8").toString("base64");
  if (Buffer.byteLength(encoded, "utf8") > MAX_PLUGIN_STATE_ENVELOPE_BYTES) {
    throw protocolError("state_too_large", "Plugin state exceeded the configured state envelope limit.", {
      maxStateEnvelopeBytes: MAX_PLUGIN_STATE_ENVELOPE_BYTES
    });
  }
  return encoded;
}

function decodeStateEnvelope(state) {
  const text = String(state ?? "");
  if (
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > MAX_PLUGIN_STATE_ENVELOPE_BYTES ||
    !isBase64Text(text)
  ) {
    throw protocolError("bad_state", "State was not valid SoundBridge state.");
  }

  try {
    const decoded = Buffer.from(text, "base64");
    return JSON.parse(decoded.toString("utf8"));
  } catch (error) {
    if (error?.code) {
      throw error;
    }
    throw protocolError("bad_state", "State was not valid SoundBridge state.");
  }
}

function normalizeNativeState(nativeState, format) {
  if (nativeState == null) {
    return undefined;
  }
  if (!nativeState || typeof nativeState !== "object" || nativeState.format !== format) {
    throw protocolError("bad_state", "State belongs to a different native plugin format.");
  }

  if (format === "au" || format === "lv2") {
    return {
      format,
      state: normalizeStatePart(nativeState.state, "nativeState.state")
    };
  }

  if (format === "vst3") {
    const component = normalizeStatePart(nativeState.component, "nativeState.component");
    const controller = normalizeStatePart(nativeState.controller, "nativeState.controller");
    const totalBytes = decodedBase64Length(component) + decodedBase64Length(controller);
    if (totalBytes > MAX_PLUGIN_STATE_BYTES) {
      throw protocolError("state_too_large", "Native plugin state exceeded the configured state limit.", {
        maxStateBytes: MAX_PLUGIN_STATE_BYTES
      });
    }
    return {
      format,
      component,
      controller
    };
  }

  return undefined;
}

async function processAudioBlock(payload, session) {
  const instance = getInstance(payload.instanceId, session);
  const frames = boundedFrames(firstAudioFrameCount(payload, instance.maxBlockSize), instance.maxBlockSize);
  const blockSampleRate = clampSampleRate(payload.sampleRate, instance.sampleRate);
  const mainInputChannels = normalizeAudioChannels(payload.channels, MAX_AUDIO_CHANNELS, frames);
  const inputBuses = normalizeAudioBusBlocks(payload.inputBuses, mainInputChannels, instance.layout?.inputBusLayouts, frames);
  const channels = inputBuses.find((bus) => bus.index === 0)?.channels ?? mainInputChannels;

  if (instance.kind === "instrument") {
    const processed = await processInstrumentBlock(instance, frames, blockSampleRate);
    return {
      blockId: payload.blockId,
      ...processed,
      outputBuses: normalizeOutputBusBlocks(processed.outputBuses, processed.channels, instance.layout, frames),
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
      inputBuses
    });
    const renderedChannels = Array.isArray(rendered) ? rendered : rendered.channels;
    return {
      blockId: payload.blockId,
      channels: normalizeAudioChannels(renderedChannels, instance.outputChannels, frames),
      outputBuses: normalizeOutputBusBlocks(rendered.outputBuses, renderedChannels, instance.layout, frames),
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
    latencySamples: normalizeLatencySamples(instance.pluginLatencySamples),
    tailSamples: normalizeTailSamples(instance.pluginTailSamples),
    infiniteTail: Boolean(instance.pluginInfiniteTail)
  };
}

function firstAudioFrameCount(payload, fallback) {
  if (payload.frames != null) {
    return payload.frames;
  }
  if (Array.isArray(payload.channels) && Array.isArray(payload.channels[0])) {
    return payload.channels[0].length;
  }
  if (Array.isArray(payload.inputBuses)) {
    for (const bus of payload.inputBuses) {
      if (Array.isArray(bus?.channels) && Array.isArray(bus.channels[0])) {
        return bus.channels[0].length;
      }
    }
  }
  return fallback;
}

function normalizeAudioChannels(channels, maxChannels, frames) {
  if (!Array.isArray(channels) || maxChannels <= 0) {
    return [];
  }
  return channels.slice(0, Math.min(MAX_AUDIO_CHANNELS, maxChannels)).map((channel) =>
    Array.from({ length: frames }, (_, frame) => {
      const value = Number(Array.isArray(channel) ? channel[frame] : 0);
      return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    })
  );
}

function normalizeAudioBusBlocks(value, mainChannels, busLayouts = [], frames) {
  const byIndex = new Map();
  if (Array.isArray(mainChannels) && mainChannels.length > 0) {
    byIndex.set(0, { index: 0, channels: mainChannels });
  }
  if (Array.isArray(value)) {
    for (const bus of value.slice(0, MAX_PLUGIN_BUSES)) {
      const index = normalizeInt(bus?.index, 0, MAX_PLUGIN_BUSES - 1, 0);
      const layoutChannels = busLayouts.find((layout) => layout.index === index)?.channels ?? MAX_AUDIO_CHANNELS;
      byIndex.set(index, {
        index,
        channels: normalizeAudioChannels(bus?.channels, layoutChannels, frames)
      });
    }
  }
  return Array.from(byIndex.values()).sort((left, right) => left.index - right.index);
}

function normalizeOutputBusBlocks(value, mainChannels, layout, frames) {
  const outputLayouts = layout?.outputBusLayouts ?? [];
  const buses = normalizeAudioBusBlocks(value, normalizeAudioChannels(mainChannels, layout?.outputChannels ?? MAX_AUDIO_CHANNELS, frames), outputLayouts, frames);
  if (buses.length > 0) {
    return buses;
  }
  return [{
    index: 0,
    channels: normalizeAudioChannels(mainChannels, layout?.outputChannels ?? MAX_AUDIO_CHANNELS, frames)
  }];
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

async function processInstrumentBlock(instance, frames, sampleRate) {
  if (instance.worker) {
    try {
      return {
        channels: await instance.worker.render({
          frames,
          sampleRate,
          channels: [],
          gain: parameterValue(instance, "gain", 0.5),
          tone: parameterValue(instance, "tone", 0.5),
          detune: parameterValue(instance, "detune", 0.5)
        }),
        renderEngine: instance.renderEngine ?? instance.worker.renderEngine ?? "bundle-worker"
      };
    } catch (error) {
      if (typeof instance.renderEngine === "string" && instance.renderEngine.startsWith("native-")) {
        throw error;
      }
      console.warn(`Bundle worker failed, falling back to executable launch: ${error.message}`);
      instance.worker?.destroy();
      instance.worker = undefined;
    }
  }

  const rendererExecutable = instance.executablePath ?? NATIVE_RENDERER;
  if (
    rendererExecutable &&
    ["builtin-example", "example-bundle"].includes(instance.source) &&
    ["vst3", "au", "lv2"].includes(instance.format)
  ) {
    try {
      return {
        channels: renderNativeExampleBlock(rendererExecutable, instance, frames, sampleRate),
        renderEngine: instance.executablePath ? "bundle-executable" : "native-example"
      };
    } catch (error) {
      console.warn(`Native example renderer failed, falling back to JS: ${error.message}`);
    }
  }

  return {
    channels: synthesizeInstrumentBlock(instance, frames, sampleRate),
    renderEngine: "js-fallback"
  };
}

function renderNativeExampleBlock(rendererExecutable, instance, frames, sampleRate) {
  const args = instance.executablePath
    ? [
        "--render-example-block",
        String(frames),
        String(sampleRate),
        String(parameterValue(instance, "gain", 0.5)),
        String(parameterValue(instance, "tone", 0.5)),
        String(parameterValue(instance, "detune", 0.5)),
        voicesToNativeArgument(instance.voices)
      ]
    : [
        "--render-example-block",
        instance.pluginId,
        String(frames),
        String(sampleRate),
        String(parameterValue(instance, "gain", 0.5)),
        String(parameterValue(instance, "tone", 0.5)),
        String(parameterValue(instance, "detune", 0.5)),
        voicesToNativeArgument(instance.voices)
      ];
  const output = execFileSync(
    rendererExecutable,
    args,
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    }
  );
  const parsed = JSON.parse(output);
  if (!parsed || !Array.isArray(parsed.channels)) {
    throw new Error("native renderer returned invalid channels");
  }
  return parsed.channels;
}

function voicesToNativeArgument(voices) {
  return Array.from(voices.values(), (voice) => `${voice.note}:${voice.velocity}`).join(",");
}

class ExampleInstrumentWorker {
  constructor(executablePath) {
    this.executablePath = executablePath;
    this.renderEngine = "bundle-worker";
    this.pending = [];
    this.stdoutBuffer = "";
    this.process = spawn(executablePath, ["--worker"], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.process.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        console.warn(`Example instrument worker stderr: ${message}`);
      }
    });
    this.process.on("error", (error) => this.rejectAll(error));
    this.process.on("exit", (code, signal) => {
      if (this.pending.length > 0) {
        this.rejectAll(new Error(`worker exited code=${code ?? "none"} signal=${signal ?? "none"}`));
      }
    });
  }

  render(request) {
    if (!this.process || this.process.killed || !this.process.stdin.writable) {
      return Promise.reject(new Error("worker is not writable"));
    }

    const command = [
      "render",
      request.frames,
      request.sampleRate,
      request.gain,
      request.tone,
      request.detune
    ].join(" ");

    return this.request(command).then((parsed) => {
      if (!Array.isArray(parsed.channels)) {
        throw new Error("worker returned invalid channels");
      }
      return parsed.channels;
    });
  }

  async sendMidiEvents(events) {
    for (const event of events) {
      if (event.type === "noteOn" && event.velocity > 0) {
        await this.request(`noteOn ${event.note} ${event.velocity} ${event.channel} ${event.time}`);
      } else if (event.type === "noteOff" || event.type === "noteOn") {
        await this.request(`noteOff ${event.note} ${event.velocity} ${event.channel} ${event.time}`);
      }
    }
  }

  request(command) {
    if (!this.process || this.process.killed || !this.process.stdin.writable) {
      return Promise.reject(new Error("worker is not writable"));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = this.pending.filter((pending) => pending.resolve !== resolve);
        reject(new Error("worker command timed out"));
      }, 1500);
      this.pending.push({ resolve, reject, timeout });
      this.process.stdin.write(`${command}\n`, "utf8", (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending = this.pending.filter((pending) => pending.resolve !== resolve);
          reject(error);
        }
      });
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        return;
      }

      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      const pending = this.pending.shift();
      if (!pending) {
        continue;
      }

      clearTimeout(pending.timeout);
      try {
        const parsed = JSON.parse(line);
        if (parsed.error) {
          pending.reject(new Error(parsed.error));
        } else {
          pending.resolve(parsed);
        }
      } catch (error) {
        pending.reject(error);
      }
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  destroy() {
    if (!this.process || this.process.killed) {
      return;
    }
    try {
      this.process.stdin.write("quit\n");
      this.process.stdin.end();
    } catch {}
    setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.process.kill();
      }
    }, 250).unref?.();
  }
}

class NativeHostWorker {
  constructor(nativeHost, instance) {
    this.nativeHost = nativeHost;
    this.fallbackLayout = clonePluginLayout(instance.layout);
    this.renderEngine = nativeHost.renderEngine;
    this.pending = [];
    this.stdoutBuffer = "";
    this.readySettled = false;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.process = spawn(NATIVE_RENDERER, nativeHostWorkerArgs(nativeHost, instance), {
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.process.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        console.warn(`Native host worker stderr: ${message}`);
      }
    });
    this.process.on("error", (error) => this.rejectAll(error));
    this.process.on("exit", (code, signal) => {
      const error = new Error(`worker exited code=${code ?? "none"} signal=${signal ?? "none"}`);
      if (!this.readySettled) {
        this.setReadyError(error);
      }
      if (this.pending.length > 0) {
        this.rejectAll(error);
      }
    });
  }

  render(request) {
    if (!this.process || this.process.killed || !this.process.stdin.writable) {
      return Promise.reject(new Error("worker is not writable"));
    }

    const command = [
      "render",
      request.frames,
      request.sampleRate,
      encodeAudioChannels(request.channels, request.frames),
      encodeAudioBuses(request.inputBuses, request.frames)
    ].join(" ");

    return this.request(command).then((parsed) => {
      if (!Array.isArray(parsed.channels)) {
        throw new Error("worker returned invalid channels");
      }
      return {
        channels: parsed.channels,
        outputBuses: Array.isArray(parsed.outputBuses) ? parsed.outputBuses : undefined
      };
    });
  }

  async sendMidiEvents(events) {
    if (["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
      await this.request(`midi ${encodeMidiEvents(events)}`);
      return;
    }

    for (const event of events) {
      if (event.type === "noteOn" && event.velocity > 0) {
        await this.request(`noteOn ${event.note} ${event.velocity} ${event.channel} ${event.time}`);
      } else if (event.type === "noteOff" || event.type === "noteOn") {
        await this.request(`noteOff ${event.note} ${event.velocity} ${event.channel} ${event.time}`);
      }
    }
  }

  async getParameters() {
    if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
      return [];
    }
    const parsed = await this.request("parameters");
    return normalizeWorkerParameters(parsed.parameters);
  }

  async setParameter(parameterId, normalizedValue, sampleOffset = 0) {
    if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
      return undefined;
    }
    const parsed = await this.request(`setParameter ${parameterId} ${normalizedValue} ${sampleOffset}`);
    if (!parsed.parameter) {
      return undefined;
    }
    return normalizeWorkerParameter(parsed.parameter);
  }

  async getState() {
    if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
      return undefined;
    }
    const parsed = await this.request("getState");
    return normalizeWorkerState(this.nativeHost.format, parsed.state);
  }

  async setState(nativeState) {
    if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
      return undefined;
    }
    const state = normalizeNativeState(nativeState, this.nativeHost.format);
    if (!state) {
      return undefined;
    }
    if (this.nativeHost.format === "au" || this.nativeHost.format === "lv2") {
      return this.request(`setState ${state.state || "-"}`);
    }
    return this.request(`setState ${state.component || "-"} ${state.controller || "-"}`);
  }

  async getLatency() {
    if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
      return 0;
    }
    const parsed = await this.request("latency");
    return normalizeLatencySamples(parsed.latencySamples);
  }

  async getTailTime() {
    if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
      return { tailSamples: 0, infiniteTail: false };
    }
    const parsed = await this.request("tail");
    return normalizeTailReport(parsed);
  }

  async getLayout() {
    if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
      return clonePluginLayout(this.fallbackLayout);
    }
    const parsed = await this.request("layout");
    return normalizePluginLayout(parsed, this.fallbackLayout);
  }

  request(command) {
    if (!this.process || this.process.killed || !this.process.stdin.writable) {
      return Promise.reject(new Error("worker is not writable"));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = this.pending.filter((pending) => pending.resolve !== resolve);
        reject(new Error("worker command timed out"));
      }, 5000);
      this.pending.push({ resolve, reject, timeout });
      this.process.stdin.write(`${command}\n`, "utf8", (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending = this.pending.filter((pending) => pending.resolve !== resolve);
          reject(error);
        }
      });
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        return;
      }

      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        if (!this.readySettled) {
          this.setReadyError(error);
          continue;
        }
        const pending = this.pending.shift();
        pending?.reject(error);
        continue;
      }

      if (!this.readySettled) {
        if (parsed.ok === true && parsed.ready === true) {
          this.readySettled = true;
          this.resolveReady(parsed);
        } else {
          this.setReadyError(new Error(parsed.error ?? "worker did not report ready"));
        }
        continue;
      }

      const pending = this.pending.shift();
      if (!pending) {
        continue;
      }

      clearTimeout(pending.timeout);
      if (parsed.error) {
        pending.reject(new Error(parsed.error));
      } else {
        pending.resolve(parsed);
      }
    }
  }

  setReadyError(error) {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.rejectReady(error);
  }

  rejectAll(error) {
    this.setReadyError(error);
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  destroy() {
    if (!this.process || this.process.killed) {
      return;
    }
    try {
      this.process.stdin.write("quit\n");
      this.process.stdin.end();
    } catch {}
    setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.process.kill();
      }
    }, 250).unref?.();
  }
}

function nativeHostWorkerArgs(nativeHost, instance) {
  const common = [
    String(instance.sampleRate),
    String(instance.maxBlockSize),
    String(instance.inputChannels),
    String(instance.outputChannels),
    String(instance.kind ?? "unknown")
  ];

  if (nativeHost.format === "au") {
    return [
      "--host-au-worker",
      nativeHost.componentType,
      nativeHost.componentSubType,
      nativeHost.componentManufacturer,
      ...common
    ];
  }

  if (nativeHost.format === "vst3") {
    return [
      "--host-vst3-worker",
      nativeHost.bundlePath,
      ...common
    ];
  }

  if (nativeHost.format === "lv2") {
    return [
      "--host-lv2-worker",
      nativeHost.bundlePath,
      ...common
    ];
  }

  throw new Error(`Unsupported native host format: ${nativeHost.format}`);
}

function formatNativeHostName(format) {
  switch (format) {
    case "au":
      return "Audio Unit";
    case "vst3":
      return "VST3";
    case "lv2":
      return "LV2";
    default:
      return String(format ?? "native");
  }
}

function createPluginCatalog() {
  return [
    {
      pluginId: "mock.gain",
      format: "mock",
      name: "Mock Gain",
      vendor: "SoundBridge",
      category: "Fx|Gain",
      kind: "effect",
      source: "mock",
      hostable: true,
      inputs: 2,
      outputs: 2,
      parameters: [makeGainParameter(0.5)]
    },
    ...loadNativeExamplePlugins(),
    ...loadNativeInstalledPlugins()
  ];
}

function loadNativeExamplePlugins() {
  if (!NATIVE_RENDERER) {
    return fallbackExamplePlugins();
  }

  try {
    const output = execFileSync(NATIVE_RENDERER, ["--scan-examples"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    const parsed = JSON.parse(output);
    if (!parsed || !Array.isArray(parsed.plugins) || parsed.plugins.length === 0) {
      return fallbackExamplePlugins();
    }
    return parsed.plugins.map((plugin) => decorateExamplePlugin(plugin));
  } catch (error) {
    console.warn(`Native example scan failed, using fallback examples: ${error.message}`);
    return fallbackExamplePlugins();
  }
}

function loadNativeInstalledPlugins() {
  if (!NATIVE_RENDERER) {
    return [];
  }

  try {
    const output = execFileSync(NATIVE_RENDERER, ["--scan-installed"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });
    const parsed = JSON.parse(output);
    if (!parsed || !Array.isArray(parsed.plugins)) {
      return [];
    }
    return parsed.plugins.map((plugin) => decorateInstalledPlugin(plugin));
  } catch (error) {
    console.warn(`Native installed plugin scan failed: ${error.message}`);
    return [];
  }
}

function loadNativeHostStatus() {
  if (!NATIVE_RENDERER) {
    return new Map();
  }

  try {
    const output = execFileSync(NATIVE_RENDERER, ["--host-status"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    const parsed = JSON.parse(output);
    if (!parsed || !Array.isArray(parsed.formats)) {
      return new Map();
    }
    return new Map(
      parsed.formats.map((formatStatus) => [
        String(formatStatus.format),
        {
          scan: Boolean(formatStatus.scanAvailable),
          host: Boolean(formatStatus.hostAvailable),
          exampleHost: Boolean(formatStatus.exampleHostAvailable),
          notes: typeof formatStatus.notes === "string" ? formatStatus.notes : undefined
        }
      ])
    );
  } catch (error) {
    console.warn(`Native host status failed: ${error.message}`);
    return new Map();
  }
}

function createPluginFormatCapabilities() {
  return {
    vst3: formatCapability("vst3", {
      scan: true,
      host: false,
      exampleHost: Boolean(NATIVE_RENDERER),
      mockExamples: true
    }),
    au: formatCapability("au", {
      scan: true,
      host: false,
      exampleHost: Boolean(NATIVE_RENDERER),
      mockExamples: true
    }),
    lv2: formatCapability("lv2", {
      scan: Boolean(NATIVE_RENDERER),
      host: false,
      exampleHost: Boolean(NATIVE_RENDERER),
      mockExamples: true
    }),
    mock: {
      scan: true,
      host: true
    }
  };
}

function formatCapability(format, fallback) {
  const nativeStatus = NATIVE_HOST_STATUS.get(format);
  return {
    scan: nativeStatus?.scan ?? fallback.scan,
    host: nativeStatus?.host ?? fallback.host,
    ...(nativeStatus?.exampleHost ?? fallback.exampleHost
      ? { exampleHost: nativeStatus?.exampleHost ?? fallback.exampleHost }
      : {}),
    ...(fallback.mockExamples ? { mockExamples: fallback.mockExamples } : {}),
    ...(nativeStatus?.notes ? { notes: nativeStatus.notes } : {})
  };
}

function decorateExamplePlugin(plugin) {
  const manifest = readExampleManifest(plugin);
  const defaults = normalizeExampleDefaults(plugin.pluginId, manifest);
  const presets = normalizeExamplePresets(plugin.pluginId, manifest, defaults);
  return {
    pluginId: plugin.pluginId,
    format: plugin.format,
    name: plugin.name,
    vendor: plugin.vendor,
    category: plugin.category,
    kind: plugin.kind,
    source: plugin.source ?? "example-bundle",
    hostable: true,
    inputs: plugin.inputs ?? 0,
    outputs: plugin.outputs ?? 2,
    metadata: normalizePluginClassMetadata(plugin.metadata, plugin.format),
    executablePath: plugin.diagnostics?.executablePath,
    engine: defaults.engine,
    parameters: makeInstrumentParameters(defaults),
    presets
  };
}

function decorateInstalledPlugin(plugin) {
  const nativeHost = nativeHostForInstalledPlugin(plugin);
  const hostable = Boolean(nativeHost);
  return {
    pluginId: plugin.pluginId,
    format: plugin.format,
    name: plugin.name,
    vendor: plugin.vendor ?? "Unknown",
    category: plugin.category ?? formatCategory(plugin.format),
    kind: plugin.kind ?? "unknown",
    source: "scan",
    hostable,
    hostUnavailableReason: hostable
      ? undefined
      : hostUnavailableReasonForInstalledPlugin(plugin),
    inputs: defaultInputChannels(plugin),
    outputs: defaultOutputChannels(plugin),
    metadata: normalizePluginClassMetadata(plugin.metadata, plugin.format),
    parameters: [],
    presets: [],
    nativeHost
  };
}

function hostUnavailableReasonForInstalledPlugin(plugin) {
  if (plugin.format === "lv2" && NATIVE_HOST_STATUS.get("lv2")?.host === true) {
    return "Installed LV2 scanning is available; this plugin does not match the basic audio/control LV2 host profile yet.";
  }
  return "Installed plugin scanning is available; binary hosting adapter is not linked yet.";
}

function nativeHostForInstalledPlugin(plugin) {
  const diagnostics = plugin.diagnostics ?? {};

  if (plugin.format === "au" && NATIVE_HOST_STATUS.get("au")?.host === true) {
    if (
      typeof diagnostics.componentType !== "string" ||
      typeof diagnostics.componentSubType !== "string" ||
      typeof diagnostics.componentManufacturer !== "string"
    ) {
      return undefined;
    }

    return {
      format: "au",
      renderEngine: "native-au",
      componentType: diagnostics.componentType,
      componentSubType: diagnostics.componentSubType,
      componentManufacturer: diagnostics.componentManufacturer
    };
  }

  if (plugin.format === "vst3" && NATIVE_HOST_STATUS.get("vst3")?.host === true) {
    if (typeof diagnostics.bundlePath !== "string" || diagnostics.bundlePath.length === 0) {
      return undefined;
    }

    return {
      format: "vst3",
      renderEngine: "native-vst3",
      bundlePath: diagnostics.bundlePath
    };
  }

  if (plugin.format === "lv2" && NATIVE_HOST_STATUS.get("lv2")?.host === true) {
    if (
      typeof diagnostics.bundlePath !== "string" ||
      diagnostics.bundlePath.length === 0 ||
      diagnostics.hasExecutable !== true ||
      Number(plugin.outputs) <= 0 ||
      plugin.kind === "instrument"
    ) {
      return undefined;
    }

    return {
      format: "lv2",
      renderEngine: "native-lv2",
      bundlePath: diagnostics.bundlePath
    };
  }

  return undefined;
}

function defaultInputChannels(plugin) {
  if (Number(plugin.inputs) > 0) {
    return Number(plugin.inputs);
  }
  return plugin.kind === "instrument" ? 0 : 2;
}

function defaultOutputChannels(plugin) {
  if (Number(plugin.outputs) > 0) {
    return Number(plugin.outputs);
  }
  return 2;
}

function readExampleManifest(plugin) {
  const bundlePath = plugin.diagnostics?.bundlePath;
  if (!bundlePath) {
    return undefined;
  }

  const manifestCandidates = [
    path.join(bundlePath, "Contents", "Resources", "SoundBridgePlugin.json"),
    path.join(bundlePath, "SoundBridgePlugin.json")
  ];

  for (const manifestPath of manifestCandidates) {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
    }
  }

  return undefined;
}

function normalizeExampleDefaults(pluginId, manifest) {
  const fallback = exampleDefaultsFor(pluginId);
  const defaults = manifest?.defaults && typeof manifest.defaults === "object" ? manifest.defaults : {};
  return {
    engine: typeof manifest?.engine === "string" ? manifest.engine : fallback.engine,
    gain: clamp01(Number(defaults.gain ?? fallback.gain)),
    tone: clamp01(Number(defaults.tone ?? fallback.tone)),
    detune: clamp01(Number(defaults.detune ?? fallback.detune))
  };
}

function normalizeExamplePresets(pluginId, manifest, defaults) {
  const rawPresets = Array.isArray(manifest?.presets) ? manifest.presets : examplePresetsFor(pluginId, defaults);
  const presets = rawPresets
    .map((preset, index) => {
      if (!preset || typeof preset !== "object") {
        return undefined;
      }
      const parameters = preset.parameters && typeof preset.parameters === "object" ? preset.parameters : {};
      return {
        id: String(preset.id ?? `preset-${index + 1}`),
        name: String(preset.name ?? `Preset ${index + 1}`),
        parameters: {
          gain: clamp01(Number(parameters.gain ?? defaults.gain)),
          tone: clamp01(Number(parameters.tone ?? defaults.tone)),
          detune: clamp01(Number(parameters.detune ?? defaults.detune))
        }
      };
    })
    .filter(Boolean);

  return presets.length > 0 ? presets : examplePresetsFor(pluginId, defaults);
}

function fallbackExamplePlugins() {
  return [
    decorateExamplePlugin({
      pluginId: "vst3:soundbridge-example-polysynth.vst3",
      format: "vst3",
      name: "Example PolySynth",
      vendor: "SoundBridge",
      category: "Instrument|Synth",
      kind: "instrument",
      source: "builtin-example",
      inputs: 0,
      outputs: 2
    }),
    decorateExamplePlugin({
      pluginId: "au:soundbridge-example-tonewheel.component",
      format: "au",
      name: "Example Tonewheel",
      vendor: "SoundBridge",
      category: "Instrument|Keys",
      kind: "instrument",
      source: "builtin-example",
      inputs: 0,
      outputs: 2
    }),
    decorateExamplePlugin({
      pluginId: "lv2:soundbridge-example-wavefold.lv2",
      format: "lv2",
      name: "Example Wavefold",
      vendor: "SoundBridge",
      category: "Instrument|Synth",
      kind: "instrument",
      source: "builtin-example",
      inputs: 0,
      outputs: 2
    })
  ];
}

function exampleDefaultsFor(pluginId) {
  if (pluginId === "au:soundbridge-example-tonewheel.component") {
    return {
      engine: "tonewheel",
      gain: 0.48,
      tone: 0.36,
      detune: 0.5
    };
  }
  if (pluginId === "lv2:soundbridge-example-wavefold.lv2") {
    return {
      engine: "wavefold",
      gain: 0.4,
      tone: 0.58,
      detune: 0.5
    };
  }
  return {
    engine: "poly-sine",
    gain: 0.42,
    tone: 0.68,
    detune: 0.5
  };
}

function examplePresetsFor(pluginId, defaults) {
  if (pluginId === "au:soundbridge-example-tonewheel.component") {
    return [
      {
        id: "tonewheel-default",
        name: "Clean Drawbars",
        parameters: {
          gain: defaults.gain,
          tone: defaults.tone,
          detune: defaults.detune
        }
      },
      {
        id: "tonewheel-bright",
        name: "Bright Percussive",
        parameters: {
          gain: 0.58,
          tone: 0.74,
          detune: 0.5
        }
      }
    ];
  }

  if (pluginId === "lv2:soundbridge-example-wavefold.lv2") {
    return [
      {
        id: "wavefold-default",
        name: "Glass Fold",
        parameters: {
          gain: defaults.gain,
          tone: defaults.tone,
          detune: defaults.detune
        }
      },
      {
        id: "wavefold-edge",
        name: "Edge Stack",
        parameters: {
          gain: 0.52,
          tone: 0.82,
          detune: 0.61
        }
      }
    ];
  }

  return [
    {
      id: "poly-default",
      name: "Open Poly",
      parameters: {
        gain: defaults.gain,
        tone: defaults.tone,
        detune: defaults.detune
      }
    },
    {
      id: "poly-bright-stack",
      name: "Bright Stack",
      parameters: {
        gain: 0.56,
        tone: 0.86,
        detune: 0.62
      }
    }
  ];
}

function assertPaired(sessionToken, command, context) {
  const session = sessions.get(sessionToken);
  if (!session) {
    throw protocolError("not_paired", `Pair before calling ${command}.`);
  }
  if (session.expiresAt <= Date.now()) {
    destroySession(sessionToken);
    throw protocolError("session_expired", "Pairing session expired.");
  }
  if (session.connectionId !== context.connectionId) {
    throw protocolError("session_connection_mismatch", "This session token is bound to a different browser connection.");
  }
  if (session.origin !== context.requestOrigin) {
    throw protocolError("origin_mismatch", "This session token is bound to a different browser origin.");
  }
  session.lastSeenAt = Date.now();
  return session;
}

function cleanupConnection(context) {
  for (const sessionToken of context.sessionTokens) {
    destroySession(sessionToken);
  }
  context.sessionTokens.clear();
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sessionToken, session] of sessions) {
    if (session.expiresAt <= now) {
      destroySession(sessionToken);
    }
  }
}

function destroySession(sessionToken) {
  const session = sessions.get(sessionToken);
  if (!session) {
    return;
  }
  for (const instanceId of Array.from(session.instances)) {
    const instance = instances.get(instanceId);
    if (instance) {
      destroyInstanceRecord(instance);
    }
  }
  sessions.delete(sessionToken);
}

function destroyInstanceRecord(instance) {
  instance.worker?.destroy();
  instances.delete(instance.instanceId);
  const owner = sessions.get(instance.ownerSessionToken);
  owner?.instances.delete(instance.instanceId);
}

function sessionsForOrigin(origin) {
  cleanupExpiredSessions();
  return Array.from(sessions.values()).filter((session) => session.origin === origin);
}

function envInteger(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function envList(name) {
  return String(process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function assertLoopbackHost(host, hostEnvName, allowEnvName) {
  if (isLoopbackHost(host) || process.env[allowEnvName] === "1") {
    return;
  }

  console.error(
    `${hostEnvName}=${host} would expose SoundBridge off this machine. ` +
      `Use 127.0.0.1, localhost, or ::1, or set ${allowEnvName}=1 if you are intentionally testing a non-loopback bind.`
  );
  process.exit(1);
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function makeInstrumentParameters(values) {
  return [
    makeGainParameter(values.gain),
    {
      id: "tone",
      name: "Tone",
      normalizedValue: clamp01(values.tone),
      defaultNormalizedValue: 0.5,
      unit: "%",
      minPlain: 0,
      maxPlain: 100,
      plainValue: clamp01(values.tone) * 100,
      automatable: true
    },
    {
      id: "detune",
      name: "Detune",
      normalizedValue: clamp01(values.detune),
      defaultNormalizedValue: 0.5,
      unit: "ct",
      minPlain: -12,
      maxPlain: 12,
      plainValue: normalizedDetuneToCents(values.detune),
      automatable: true
    }
  ];
}

function makeUpdatedParameter(parameter, normalizedValue) {
  if (parameter.id === "gain") {
    return makeGainParameter(normalizedValue);
  }
  if (parameter.id === "tone") {
    const value = clamp01(normalizedValue);
    return {
      ...parameter,
      normalizedValue: value,
      plainValue: value * 100
    };
  }
  if (parameter.id === "detune") {
    const value = clamp01(normalizedValue);
    return {
      ...parameter,
      normalizedValue: value,
      plainValue: normalizedDetuneToCents(value)
    };
  }
  return {
    ...parameter,
    normalizedValue: clamp01(normalizedValue)
  };
}

function makeNativeUpdatedParameter(parameter, normalizedValue) {
  const value = clamp01(normalizedValue);
  const minPlain = finiteNumber(parameter.minPlain, 0);
  const maxPlain = finiteNumber(parameter.maxPlain, 1);
  return {
    ...parameter,
    normalizedValue: value,
    plainValue: minPlain + (maxPlain - minPlain) * value
  };
}

function makeGainParameter(normalizedValue) {
  const clamped = clamp01(normalizedValue);
  return {
    id: "gain",
    name: "Gain",
    normalizedValue: clamped,
    defaultNormalizedValue: 0.5,
    unit: "dB",
    minPlain: -24,
    maxPlain: 24,
    plainValue: normalizedGainToDb(clamped),
    automatable: true
  };
}

function normalizedGainToDb(normalizedValue) {
  return -24 + clamp01(normalizedValue) * 48;
}

function normalizedDetuneToCents(normalizedValue) {
  return -12 + clamp01(normalizedValue) * 24;
}

function parameterValue(instance, parameterId, fallback) {
  return instance.parameters.find((parameter) => parameter.id === parameterId)?.normalizedValue ?? fallback;
}

function synthesizeInstrumentBlock(instance, frames, sampleRate) {
  const output = Array.from({ length: instance.outputChannels }, () => new Array(frames).fill(0));
  if (instance.voices.size === 0) {
    return output;
  }

  const gainLinear = Math.pow(10, normalizedGainToDb(parameterValue(instance, "gain", 0.5)) / 20);
  const tone = parameterValue(instance, "tone", 0.5);
  const detuneRatio = 2 ** (normalizedDetuneToCents(parameterValue(instance, "detune", 0.5)) / 1200);
  const voices = Array.from(instance.voices.values());
  const voiceScale = Math.max(0.16, 1 / Math.sqrt(voices.length));

  for (let frame = 0; frame < frames; frame += 1) {
    let sample = 0;
    for (const voice of voices) {
      const frequency = voice.frequency * detuneRatio;
      const phaseIncrement = (2 * Math.PI * frequency) / sampleRate;
      voice.phase = (voice.phase + phaseIncrement) % (2 * Math.PI);
      voice.phase2 = (voice.phase2 + phaseIncrement * 2.01) % (2 * Math.PI);

      if (instance.engine === "tonewheel") {
        const fundamental = Math.sin(voice.phase);
        const harmonic = Math.sin(voice.phase2) * tone * 0.55;
        sample += (fundamental + harmonic) * voice.velocity;
      } else if (instance.engine === "wavefold") {
        const carrier = Math.sin(voice.phase);
        const folded = Math.sin(carrier * (1 + tone * 7));
        const edge = Math.sin(voice.phase2) * tone * 0.25;
        sample += (folded * 0.86 + edge) * voice.velocity;
      } else {
        const sine = Math.sin(voice.phase);
        const shaped = Math.tanh(Math.sin(voice.phase) * (1.5 + tone * 5));
        sample += (sine * (1 - tone * 0.45) + shaped * tone * 0.45) * voice.velocity;
      }
    }

    sample = Math.max(-1, Math.min(1, sample * gainLinear * voiceScale));
    for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
      output[channelIndex][frame] = sample;
    }
  }

  return output;
}

function midiNoteToFrequency(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

function resolveNativeRenderer() {
  const candidates = [
    process.env.SOUNDBRIDGE_NATIVE_RENDERER,
    path.resolve(__dirname, "../native/bridge-daemon/build-current/soundbridge-daemon"),
    path.resolve(__dirname, "../native/bridge-daemon/build/soundbridge-daemon")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }

  return undefined;
}

function encodeAudioChannels(channels, frames) {
  if (!Array.isArray(channels) || channels.length === 0) {
    return "-";
  }

  return channels
    .map((channel) => {
      const samples = Array.from({ length: frames }, (_, frame) => {
        const value = Number(Array.isArray(channel) ? channel[frame] : 0);
        return Number.isFinite(value) ? String(Math.max(-1, Math.min(1, value))) : "0";
      });
      return samples.join(",");
    })
    .join("|");
}

function encodeAudioBuses(buses, frames) {
  if (!Array.isArray(buses) || buses.length === 0) {
    return "-";
  }
  const encoded = buses
    .slice(0, MAX_PLUGIN_BUSES)
    .map((bus) => `${normalizeInt(bus?.index, 0, MAX_PLUGIN_BUSES - 1, 0)}=${encodeAudioChannels(bus?.channels, frames)}`)
    .join(";");
  return encoded || "-";
}

function encodeMidiEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return "-";
  }

  return events
    .map((event) => {
      if (event.type === "noteOn") {
        return ["on", event.note, event.velocity, event.channel, event.time].join(":");
      }
      if (event.type === "noteOff") {
        return ["off", event.note, event.velocity, event.channel, event.time].join(":");
      }
      if (event.type === "controlChange") {
        return ["cc", event.controller, event.value, event.channel, event.time].join(":");
      }
      if (event.type === "pitchBend") {
        return ["bend", event.value, event.channel, event.time].join(":");
      }
      if (event.type === "channelPressure") {
        return ["pressure", event.pressure, event.channel, event.time].join(":");
      }
      if (event.type === "polyPressure") {
        return ["poly", event.note, event.pressure, event.channel, event.time].join(":");
      }
      if (event.type === "programChange") {
        return ["program", event.program, event.channel, event.time].join(":");
      }
      throw protocolError("invalid_argument", `Unsupported MIDI event type: ${event.type}`);
    })
    .join(";");
}

function normalizeWorkerParameters(parameters) {
  if (!Array.isArray(parameters)) {
    return [];
  }
  return parameters
    .slice(0, MAX_PLUGIN_PARAMETERS)
    .map((parameter) => normalizeWorkerParameter(parameter))
    .filter(Boolean);
}

function normalizeWorkerParameter(parameter) {
  if (!parameter || typeof parameter !== "object") {
    return undefined;
  }
  const id = truncateText(parameter.id, 64);
  if (!id) {
    return undefined;
  }
  const normalizedValue = clamp01(Number(parameter.normalizedValue));
  const defaultNormalizedValue = clamp01(Number(parameter.defaultNormalizedValue ?? normalizedValue));
  const minPlain = finiteNumber(parameter.minPlain, 0);
  const maxPlain = finiteNumber(parameter.maxPlain, 1);
  const plainValue = finiteNumber(parameter.plainValue, minPlain + (maxPlain - minPlain) * normalizedValue);

  return {
    id,
    name: truncateText(parameter.name, MAX_PLUGIN_PARAMETER_TEXT_BYTES) || id,
    normalizedValue,
    defaultNormalizedValue,
    unit: truncateText(parameter.unit, 64) || undefined,
    minPlain,
    maxPlain,
    plainValue,
    automatable: parameter.automatable !== false,
    stepCount: Math.max(0, Math.min(1_000_000, Math.floor(Number(parameter.stepCount ?? 0)))),
    readOnly: Boolean(parameter.readOnly)
  };
}

function normalizeWorkerState(format, state) {
  if (format === "au" || format === "lv2") {
    return {
      format,
      state: normalizeStatePart(state, "worker.state")
    };
  }

  if (format === "vst3") {
    if (!state || typeof state !== "object") {
      return {
        format,
        component: "",
        controller: ""
      };
    }
    const component = normalizeStatePart(state.component, "worker.state.component");
    const controller = normalizeStatePart(state.controller, "worker.state.controller");
    const totalBytes = decodedBase64Length(component) + decodedBase64Length(controller);
    if (totalBytes > MAX_PLUGIN_STATE_BYTES) {
      throw protocolError("state_too_large", "Native plugin state exceeded the configured state limit.", {
        maxStateBytes: MAX_PLUGIN_STATE_BYTES
      });
    }
    return {
      format,
      component,
      controller
    };
  }

  return undefined;
}

function normalizeStatePart(value, label) {
  const text = String(value ?? "");
  if (text.length === 0) {
    return "";
  }
  if (!isBase64Text(text)) {
    throw protocolError("bad_state", `${label} was not valid base64.`);
  }
  const decodedLength = decodedBase64Length(text);
  if (decodedLength > MAX_PLUGIN_STATE_BYTES) {
    throw protocolError("state_too_large", `${label} exceeded the configured state limit.`, {
      maxStateBytes: MAX_PLUGIN_STATE_BYTES
    });
  }
  return text;
}

function isBase64Text(text) {
  return typeof text === "string" && text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(text);
}

function decodedBase64Length(text) {
  if (!text) {
    return 0;
  }
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((text.length / 4) * 3) - padding);
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeLatencySamples(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 0) {
    return 0;
  }
  return Math.min(number, MAX_PLUGIN_LATENCY_SAMPLES);
}

function normalizeTailSamples(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 0) {
    return 0;
  }
  return Math.min(number, MAX_PLUGIN_TAIL_SAMPLES);
}

function normalizeTailReport(value) {
  return {
    tailSamples: normalizeTailSamples(value?.tailSamples),
    infiniteTail: Boolean(value?.infiniteTail)
  };
}

function normalizePluginLayout(value, fallback = {}) {
  const requestedInputChannels = normalizeInt(
    value?.requestedInputChannels,
    0,
    MAX_AUDIO_CHANNELS,
    fallback.requestedInputChannels ?? fallback.inputChannels ?? 0
  );
  const requestedOutputChannels = normalizeInt(
    value?.requestedOutputChannels,
    1,
    MAX_AUDIO_CHANNELS,
    fallback.requestedOutputChannels ?? fallback.outputChannels ?? 2
  );
  const inputChannels = normalizeInt(
    value?.inputChannels,
    0,
    MAX_AUDIO_CHANNELS,
    fallback.inputChannels ?? requestedInputChannels
  );
  const outputChannels = normalizeInt(
    value?.outputChannels,
    1,
    MAX_AUDIO_CHANNELS,
    fallback.outputChannels ?? requestedOutputChannels
  );
  const inputBuses = normalizeInt(value?.inputBuses, 0, MAX_PLUGIN_BUSES, fallback.inputBuses ?? (inputChannels > 0 ? 1 : 0));
  const outputBuses = normalizeInt(value?.outputBuses, 1, MAX_PLUGIN_BUSES, fallback.outputBuses ?? 1);
  const inputBusLayouts = normalizeBusLayouts(
    value?.inputBusLayouts,
    fallback.inputBusLayouts,
    "input",
    inputBuses,
    inputChannels
  );
  const outputBusLayouts = normalizeBusLayouts(
    value?.outputBusLayouts,
    fallback.outputBusLayouts,
    "output",
    outputBuses,
    outputChannels
  );
  return {
    requestedInputChannels,
    requestedOutputChannels,
    inputChannels,
    outputChannels,
    inputBuses: inputBusLayouts.length,
    outputBuses: Math.max(1, outputBusLayouts.length),
    inputBusLayouts,
    outputBusLayouts,
    sampleRate: clampSampleRate(value?.sampleRate, fallback.sampleRate ?? 48000),
    maxBlockSize: normalizeInt(value?.maxBlockSize, 1, MAX_BLOCK_SIZE, fallback.maxBlockSize ?? 128)
  };
}

function normalizeBusLayouts(value, fallback, direction, busCount, totalChannels) {
  const source = Array.isArray(value) ? value : Array.isArray(fallback) ? fallback : undefined;
  const normalized = [];
  if (source) {
    for (const bus of source.slice(0, MAX_PLUGIN_BUSES)) {
      normalized.push(normalizeBusLayout(bus, direction, normalized.length));
    }
  }
  if (normalized.length > 0) {
    return normalized;
  }
  return defaultBusLayouts(direction, busCount, totalChannels);
}

function defaultBusLayouts(direction, busCount, totalChannels) {
  const count = normalizeInt(busCount, direction === "input" ? 0 : 1, MAX_PLUGIN_BUSES, direction === "input" ? 0 : 1);
  return Array.from({ length: count }, (_, index) => ({
    index,
    direction,
    mediaType: "audio",
    name: index === 0 ? (direction === "input" ? "Main Input" : "Main Output") : `${direction === "input" ? "Aux Input" : "Aux Output"} ${index}`,
    type: index === 0 ? "main" : "aux",
    channels: index === 0 ? normalizeInt(totalChannels, 0, MAX_AUDIO_CHANNELS, direction === "input" ? 0 : 2) : 0,
    active: index === 0
  }));
}

function normalizeBusLayout(bus, direction, fallbackIndex) {
  const type = bus?.type === "main" || bus?.type === "aux" ? bus.type : "unknown";
  return {
    index: normalizeInt(bus?.index, 0, MAX_PLUGIN_BUSES - 1, fallbackIndex),
    direction,
    mediaType: "audio",
    name: truncateText(bus?.name ?? `${direction === "input" ? "Input" : "Output"} ${fallbackIndex + 1}`, MAX_PLUGIN_PARAMETER_TEXT_BYTES),
    type,
    channels: normalizeInt(bus?.channels, 0, MAX_AUDIO_CHANNELS, 0),
    active: Boolean(bus?.active)
  };
}

function clonePluginLayout(layout) {
  return { ...normalizePluginLayout(layout) };
}

function normalizeInt(value, min, max, fallback) {
  const fallbackNumber = Math.floor(Number(fallback));
  const number = Math.floor(Number(value));
  const candidate = Number.isFinite(number) ? number : fallbackNumber;
  if (!Number.isFinite(candidate)) {
    return min;
  }
  return Math.max(min, Math.min(max, candidate));
}

function truncateText(value, maxBytes) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
}

function normalizeMidiEvents(events, maxBlockSize) {
  if (events == null) {
    return [];
  }
  if (!Array.isArray(events)) {
    throw protocolError("invalid_argument", "events must be an array.");
  }
  if (events.length > MAX_MIDI_EVENTS_PER_REQUEST) {
    throw protocolError("invalid_argument", `events must contain at most ${MAX_MIDI_EVENTS_PER_REQUEST} MIDI events.`, {
      maxMidiEventsPerRequest: MAX_MIDI_EVENTS_PER_REQUEST
    });
  }

  const maxOffset = Math.max(0, Math.min(MAX_BLOCK_SIZE, Number(maxBlockSize) || MAX_BLOCK_SIZE) - 1);
  return events.map((event, index) => {
    if (!event || typeof event !== "object") {
      throw protocolError("invalid_argument", `events[${index}] must be an object.`);
    }

    const type = String(event.type ?? "");
    const channel = requireIntInRange(event.channel ?? 0, 0, 15, `events[${index}].channel`);
    const time = requireIntInRange(event.time ?? 0, 0, maxOffset, `events[${index}].time`);
    if (type === "noteOn" || type === "noteOff") {
      const note = requireIntInRange(event.note, 0, 127, `events[${index}].note`);
      const velocity = requireNumberInRange(
        event.velocity ?? (type === "noteOn" ? 0.8 : 0),
        0,
        1,
        `events[${index}].velocity`
      );
      return { type, note, velocity, channel, time };
    }
    if (type === "controlChange") {
      return {
        type,
        controller: requireIntInRange(event.controller, 0, 127, `events[${index}].controller`),
        value: requireNumberInRange(event.value, 0, 1, `events[${index}].value`),
        channel,
        time
      };
    }
    if (type === "pitchBend") {
      return {
        type,
        value: requireNumberInRange(event.value, -1, 1, `events[${index}].value`),
        channel,
        time
      };
    }
    if (type === "channelPressure") {
      return {
        type,
        pressure: requireNumberInRange(event.pressure, 0, 1, `events[${index}].pressure`),
        channel,
        time
      };
    }
    if (type === "polyPressure") {
      return {
        type,
        note: requireIntInRange(event.note, 0, 127, `events[${index}].note`),
        pressure: requireNumberInRange(event.pressure, 0, 1, `events[${index}].pressure`),
        channel,
        time
      };
    }
    if (type === "programChange") {
      return {
        type,
        program: requireIntInRange(event.program, 0, 127, `events[${index}].program`),
        channel,
        time
      };
    }
    throw protocolError(
      "invalid_argument",
      `events[${index}].type must be noteOn, noteOff, controlChange, pitchBend, channelPressure, polyPressure, or programChange.`
    );
  });
}

function normalizeParameterEvents(events, maxBlockSize) {
  if (events == null) {
    return [];
  }
  if (!Array.isArray(events)) {
    throw protocolError("invalid_argument", "events must be an array.");
  }
  if (events.length > MAX_PARAMETER_EVENTS_PER_REQUEST) {
    throw protocolError("invalid_argument", `events must contain at most ${MAX_PARAMETER_EVENTS_PER_REQUEST} parameter events.`, {
      maxParameterEventsPerRequest: MAX_PARAMETER_EVENTS_PER_REQUEST
    });
  }

  const maxOffset = Math.max(0, Math.min(MAX_BLOCK_SIZE, Number(maxBlockSize) || MAX_BLOCK_SIZE) - 1);
  return events
    .map((event, index) => {
      if (!event || typeof event !== "object") {
        throw protocolError("invalid_argument", `events[${index}] must be an object.`);
      }
      return {
        parameterId: requireParameterId(event.parameterId, `events[${index}].parameterId`),
        normalizedValue: requireNumberInRange(event.normalizedValue, 0, 1, `events[${index}].normalizedValue`),
        time: requireIntInRange(event.time ?? 0, 0, maxOffset, `events[${index}].time`),
        order: index
      };
    })
    .sort((left, right) => left.time - right.time || left.order - right.order);
}

function requireParameterId(value, label) {
  const text = String(value ?? "");
  if (!text || Buffer.byteLength(text, "utf8") > 64) {
    throw protocolError("invalid_argument", `${label} must be a non-empty string up to 64 bytes.`);
  }
  return text;
}

function clonePluginMetadata(plugin) {
  return {
    pluginId: plugin.pluginId,
    format: plugin.format,
    name: plugin.name,
    vendor: plugin.vendor,
    category: plugin.category,
    kind: plugin.kind,
    source: plugin.source,
    hostable: plugin.hostable !== false,
    hostUnavailableReason: plugin.hostUnavailableReason,
    inputs: plugin.inputs,
    outputs: plugin.outputs,
    metadata: clonePluginClassMetadata(plugin.metadata),
    parameters: plugin.parameters.map((parameter) => ({ ...parameter })),
    presets: (plugin.presets ?? []).map((preset) => ({
      ...preset,
      parameters: { ...preset.parameters }
    }))
  };
}

function clonePluginClassMetadata(metadata) {
  const normalized = normalizePluginClassMetadata(metadata);
  return normalized ? { ...normalized } : undefined;
}

function normalizePluginClassMetadata(value, format = "unknown") {
  const source = value && typeof value === "object" ? value : {};
  const metadata = {};
  const add = (key, maxBytes = MAX_PLUGIN_METADATA_TEXT_BYTES) => {
    const text = truncateText(source[key], maxBytes);
    if (text) {
      metadata[key] = text;
    }
  };

  add("stableId");
  add("bundleIdentifier");
  add("version", 80);
  add("componentType", 16);
  add("componentSubType", 16);
  add("componentManufacturer", 16);
  add("lv2Uri");

  if (!metadata.stableId) {
    if (metadata.componentManufacturer && metadata.componentType && metadata.componentSubType) {
      metadata.stableId = `${metadata.componentManufacturer}:${metadata.componentType}:${metadata.componentSubType}`;
    } else if (metadata.lv2Uri) {
      metadata.stableId = metadata.lv2Uri;
    } else if (metadata.bundleIdentifier) {
      metadata.stableId = metadata.bundleIdentifier;
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function formatCategory(format) {
  switch (format) {
    case "vst3":
      return "VST3";
    case "au":
      return "AudioUnit";
    case "lv2":
      return "LV2";
    default:
      return "Unknown";
  }
}

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function requireIntInRange(value, min, max, label) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < min || number > max) {
    throw protocolError("invalid_argument", `${label} must be an integer in ${min}..${max}.`, {
      value
    });
  }
  return number;
}

function requireSampleRate(value, label = "sampleRate") {
  const number = Number(value);
  if (!Number.isFinite(number) || number < MIN_SAMPLE_RATE || number > MAX_SAMPLE_RATE) {
    throw protocolError("invalid_argument", `${label} must be a number in ${MIN_SAMPLE_RATE}..${MAX_SAMPLE_RATE} Hz.`, {
      value
    });
  }
  return number;
}

function requireNumberInRange(value, min, max, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw protocolError("invalid_argument", `${label} must be a number in ${min}..${max}.`, {
      value
    });
  }
  return number;
}

function clampSampleRate(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(MIN_SAMPLE_RATE, Math.min(MAX_SAMPLE_RATE, number));
}

function boundedFrames(requested, maxBlockSize) {
  const number = Math.floor(Number(requested));
  if (!Number.isFinite(number) || number < 1) {
    return 1;
  }
  return Math.min(number, maxBlockSize);
}

function tokenEquals(provided, expected) {
  const a = Buffer.from(String(provided ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function isLoopbackHostHeader(hostHeader) {
  if (typeof hostHeader !== "string" || hostHeader.length === 0) {
    return false;
  }
  let host = hostHeader.trim();
  const bracketed = host.match(/^\[(.+)\]/);
  if (bracketed) {
    host = bracketed[1];
  } else {
    const lastColon = host.lastIndexOf(":");
    if (lastColon !== -1 && host.indexOf(":") === lastColon) {
      host = host.slice(0, lastColon);
    }
  }
  return isLoopbackHost(host);
}

function protocolError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function sendError(send, id, code, message, details) {
  send({
    type: "response",
    id,
    ok: false,
    error: {
      code,
      message,
      details
    }
  });
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function decodeWebSocketFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let payloadLength = second & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    payloadLength = high * 2 ** 32 + low;
    offset += 8;
  }

  const maskLength = masked ? 4 : 0;
  if (payloadLength > MAX_WEBSOCKET_MESSAGE_BYTES) {
    return {
      tooLarge: true
    };
  }

  const frameLength = offset + maskLength + payloadLength;
  if (buffer.length < frameLength) {
    return null;
  }

  let payload = buffer.subarray(offset + maskLength, frameLength);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    opcode,
    payload,
    frameLength
  };
}

function encodeWebSocketFrame(payload, opcode) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
    header.writeUInt32BE(length >>> 0, 6);
  }

  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}
