import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = process.env.SOUNDBRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SOUNDBRIDGE_PORT ?? 47370);
const PAIRING_TOKEN = process.env.SOUNDBRIDGE_PAIRING_TOKEN ?? "dev-token";
const PROTOCOL_VERSION = "0.1.0";
const SESSION_TTL_MS = envInteger("SOUNDBRIDGE_SESSION_TTL_MS", 30 * 60 * 1000);
const MAX_SESSIONS_PER_ORIGIN = envInteger("SOUNDBRIDGE_MAX_SESSIONS_PER_ORIGIN", 8);
const MAX_INSTANCES_PER_SESSION = envInteger("SOUNDBRIDGE_MAX_INSTANCES_PER_SESSION", 8);
const MAX_TOTAL_INSTANCES = envInteger("SOUNDBRIDGE_MAX_TOTAL_INSTANCES", 32);
const ALLOWED_ORIGINS = envList("SOUNDBRIDGE_ALLOWED_ORIGINS");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_RENDERER = resolveNativeRenderer();
const NATIVE_HOST_STATUS = loadNativeHostStatus();

const sessions = new Map();
const instances = new Map();
let instanceSeq = 0;

const plugins = createPluginCatalog();

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);

  if (url.pathname === "/health") {
    writeJson(response, 200, {
      ok: true,
      name: "soundbridge-mock-daemon",
      protocolVersion: PROTOCOL_VERSION
    });
    return;
  }

  writeJson(response, 404, {
    ok: false,
    error: "not_found"
  });
});

server.on("upgrade", (request, socket) => {
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
  console.log(`Development pairing token: ${PAIRING_TOKEN}`);
});

function attachWebSocket(socket, requestOrigin) {
  let buffer = Buffer.alloc(0);
  const context = {
    connectionId: crypto.randomUUID(),
    requestOrigin: String(requestOrigin),
    sessionTokens: new Set()
  };

  const send = (message) => {
    socket.write(encodeWebSocketFrame(Buffer.from(JSON.stringify(message), "utf8"), 0x1));
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length > 0) {
      const parsed = decodeWebSocketFrame(buffer);
      if (!parsed) {
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

  if (!["hello", "pair", "heartbeat"].includes(command)) {
    session = assertPaired(envelope.sessionToken, command, context);
  }

  switch (command) {
    case "hello":
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
          pluginFormats: createPluginFormatCapabilities(),
          vst3: true,
          au: true,
          lv2: true,
          mockPlugins: true,
          state: true,
          latency: true,
          midi: true,
          nativeExampleRenderer: Boolean(NATIVE_RENDERER),
          nativeEditor: false,
          security: {
            originAllowlist: ALLOWED_ORIGINS.length > 0,
            sessionBoundToConnection: true,
            sessionBoundToOrigin: true,
            instanceOwnership: true,
            cleanupOnDisconnect: true,
            maxInstancesPerSession: MAX_INSTANCES_PER_SESSION,
            maxTotalInstances: MAX_TOTAL_INSTANCES
          }
        }
      };

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

    case "getState":
      return getState(payload.instanceId, session);

    case "setState":
      return setState(payload.instanceId, payload.state, session);

    case "processAudioBlock":
      return processAudioBlock(payload, session);

    case "sendMidiEvents":
      return sendMidiEvents(payload.instanceId, payload.events, session);

    case "getLatency":
      getInstance(payload.instanceId, session);
      return {
        pluginLatencySamples: 0,
        transportLatencySamples: Number(payload.transportLatencySamples ?? 0),
        reportedLatencySamples: Number(payload.transportLatencySamples ?? 0)
      };

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

function pair(payload, context) {
  cleanupExpiredSessions();
  const requestedOrigin = String(payload.origin ?? context.requestOrigin);
  if (payload.pairingToken !== PAIRING_TOKEN) {
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

  const instanceId = `inst-${++instanceSeq}`;
  const parameters = plugin.parameters.map((parameter) => ({ ...parameter }));
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
    sampleRate: Number(payload.sampleRate ?? 48000),
    maxBlockSize: Number(payload.maxBlockSize ?? 128),
    inputChannels: Number(payload.inputChannels ?? plugin.inputs ?? 2),
    outputChannels: Number(payload.outputChannels ?? plugin.outputs ?? 2),
    parameters,
    voices: new Map(),
    renderEngine: undefined,
    worker: undefined
  };
  if (plugin.nativeHost) {
    instance.worker = new NativeHostWorker(plugin.nativeHost, instance);
    instance.renderEngine = instance.worker.renderEngine;
    try {
      await instance.worker.ready;
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
    plugin: clonePluginMetadata({ ...plugin, parameters: instance.parameters }),
    latencySamples: 0
  };
}

function destroyInstance(instanceId, session) {
  const instance = getInstance(instanceId, session);
  destroyInstanceRecord(instance);
  return {
    destroyed: true
  };
}

function setParameter(instanceId, parameterId, normalizedValue, session) {
  const instance = getInstance(instanceId, session);
  const parameterIndex = instance.parameters.findIndex((parameter) => parameter.id === parameterId);
  if (parameterIndex < 0) {
    throw protocolError("parameter_not_found", `Unknown parameter: ${parameterId}`);
  }

  const value = clamp01(Number(normalizedValue));
  instance.parameters[parameterIndex] = makeUpdatedParameter(instance.parameters[parameterIndex], value);
  return {
    parameter: { ...instance.parameters[parameterIndex] }
  };
}

function getState(instanceId, session) {
  const instance = getInstance(instanceId, session);
  const state = Buffer.from(
    JSON.stringify({
      version: 1,
      pluginId: instance.pluginId,
      format: instance.format,
      parameters: Object.fromEntries(
        instance.parameters.map((parameter) => [parameter.id, parameter.normalizedValue])
      )
    }),
    "utf8"
  ).toString("base64");

  return { state };
}

function setState(instanceId, state, session) {
  const instance = getInstance(instanceId, session);
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(state), "base64").toString("utf8"));
  } catch {
    throw protocolError("bad_state", "State was not valid SoundBridge mock state.");
  }

  if (parsed.pluginId !== instance.pluginId) {
    throw protocolError("state_plugin_mismatch", "State belongs to a different plugin.");
  }

  for (const parameter of instance.parameters) {
    if (parsed.parameters && Object.hasOwn(parsed.parameters, parameter.id)) {
      const value = clamp01(Number(parsed.parameters[parameter.id]));
      Object.assign(parameter, makeUpdatedParameter(parameter, value));
    }
  }
  return {
    restored: true,
    parameters: instance.parameters.map((parameter) => ({ ...parameter }))
  };
}

async function processAudioBlock(payload, session) {
  const instance = getInstance(payload.instanceId, session);
  const channels = Array.isArray(payload.channels) ? payload.channels : [];
  const frames = Math.max(1, channels[0]?.length ?? Number(payload.frames ?? instance.maxBlockSize ?? 128));

  if (instance.kind === "instrument") {
    return {
      blockId: payload.blockId,
      ...(await processInstrumentBlock(instance, frames, Number(payload.sampleRate ?? instance.sampleRate))),
      latencySamples: 0
    };
  }

  if (instance.worker) {
    return {
      blockId: payload.blockId,
      channels: await instance.worker.render({
        frames,
        sampleRate: Number(payload.sampleRate ?? instance.sampleRate),
        channels
      }),
      latencySamples: 0,
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
    latencySamples: 0
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
  if (instance.kind !== "instrument") {
    return {
      accepted: false,
      eventCount: 0
    };
  }

  const acceptedEvents = Array.isArray(events) ? events : [];
  for (const event of acceptedEvents) {
    if (!event || typeof event !== "object") {
      continue;
    }

    const note = Math.max(0, Math.min(127, Math.round(Number(event.note))));
    if (!Number.isFinite(note)) {
      continue;
    }

    if (event.type === "noteOn" && Number(event.velocity ?? 0) > 0) {
      instance.voices.set(note, {
        note,
        frequency: midiNoteToFrequency(note),
        velocity: clamp01(Number(event.velocity ?? 0.8)),
        phase: 0,
        phase2: 0
      });
    } else if (event.type === "noteOff" || event.type === "noteOn") {
      instance.voices.delete(note);
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
      if (!event || typeof event !== "object") {
        continue;
      }

      const note = Math.max(0, Math.min(127, Math.round(Number(event.note))));
      if (!Number.isFinite(note)) {
        continue;
      }

      if (event.type === "noteOn" && Number(event.velocity ?? 0) > 0) {
        await this.request(`noteOn ${note} ${clamp01(Number(event.velocity ?? 0.8))}`);
      } else if (event.type === "noteOff" || event.type === "noteOn") {
        await this.request(`noteOff ${note}`);
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
      encodeAudioChannels(request.channels, request.frames)
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
      if (!event || typeof event !== "object") {
        continue;
      }

      const note = Math.max(0, Math.min(127, Math.round(Number(event.note))));
      if (!Number.isFinite(note)) {
        continue;
      }

      if (event.type === "noteOn" && Number(event.velocity ?? 0) > 0) {
        await this.request(`noteOn ${note} ${clamp01(Number(event.velocity ?? 0.8))}`);
      } else if (event.type === "noteOff" || event.type === "noteOn") {
        await this.request(`noteOff ${note}`);
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

  throw new Error(`Unsupported native host format: ${nativeHost.format}`);
}

function formatNativeHostName(format) {
  switch (format) {
    case "au":
      return "Audio Unit";
    case "vst3":
      return "VST3";
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
      : "Installed plugin scanning is available; binary hosting adapter is not linked yet.",
    inputs: defaultInputChannels(plugin),
    outputs: defaultOutputChannels(plugin),
    parameters: [],
    presets: [],
    nativeHost
  };
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
    parameters: plugin.parameters.map((parameter) => ({ ...parameter })),
    presets: (plugin.presets ?? []).map((preset) => ({
      ...preset,
      parameters: { ...preset.parameters }
    }))
  };
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
