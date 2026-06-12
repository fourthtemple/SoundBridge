import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isKnownFileGrantOperation } from "./daemon-file-grant-operations.mjs";
import {
  assertNoNativeLaunchData,
  probeFileGrantPresetLoad,
  probeFileGrantStateRestore,
  probeFileGrantStateSave
} from "./installed-plugin-probe-file-grants.mjs";
import { installedProbeFormats } from "./installed-plugin-probe-formats.mjs";
import { createInstalledProbeReporter, installedProbeReportMode } from "./installed-plugin-probe-reporting.mjs";

const HOST = process.env.SOUNDBRIDGE_HOST ?? "127.0.0.1";
const ORIGIN = process.env.SOUNDBRIDGE_PROBE_ORIGIN ?? "http://127.0.0.1:5173";
const PAIRING_TOKEN = process.env.SOUNDBRIDGE_PAIRING_TOKEN ?? crypto.randomBytes(24).toString("base64url");
const REQUEST_TIMEOUT_MS = intFromEnv("SOUNDBRIDGE_PROBE_TIMEOUT_MS", 15000, 1000, 120000);
const MAX_BLOCK_SIZE = intFromEnv("SOUNDBRIDGE_PROBE_MAX_BLOCK_SIZE", 64, 1, 8192);
const SAMPLE_RATE = intFromEnv("SOUNDBRIDGE_PROBE_SAMPLE_RATE", 48000, 8000, 384000);
const LIMIT = intFromEnv("SOUNDBRIDGE_PROBE_LIMIT", 0, 0, 10000);
const NAME_FILTER = process.env.SOUNDBRIDGE_PROBE_FILTER ?? "";
const REPORT_MODE = installedProbeReportMode();
const PROBE_NATIVE_EDITOR_BROKER = flagFromEnv("SOUNDBRIDGE_PROBE_NATIVE_EDITOR_BROKER");
const NATIVE_EDITOR_BROKER_FIXTURE = fileURLToPath(new URL("./native-editor-broker-fixture.mjs", import.meta.url));
const FORMATS = installedProbeFormats();

let requestSeq = 0;
const FILE_GRANT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "soundbridge-probe-grants-"));

const port = await reservePort();
const daemon = spawn("node", ["scripts/mock-daemon.mjs"], {
  env: daemonEnvironment(port),
  stdio: ["ignore", "pipe", "pipe"]
});

daemon.stderr.on("data", (chunk) => {
  const text = chunk.toString("utf8").trim();
  if (text) {
    console.warn(text);
  }
});

try {
  await waitForListen(daemon);
  const socket = await connectWebSocket(HOST, port);
  try {
    await runProbe(socket);
  } finally {
    socket.destroy();
  }
} finally {
  daemon.kill("SIGKILL");
  fs.rmSync(FILE_GRANT_ROOT, { force: true, recursive: true });
}

async function runProbe(socket) {
  const pair = await request(socket, "pair", { origin: ORIGIN, pairingToken: PAIRING_TOKEN }, false);
  const session = pair.sessionToken;
  const { plugins } = await request(socket, "listPlugins", {}, true, session);
  const targets = plugins.filter(shouldProbePlugin);
  const selected = LIMIT > 0 ? targets.slice(0, LIMIT) : targets;
  const reporter = createInstalledProbeReporter({
    formats: FORMATS,
    maxBlockSize: MAX_BLOCK_SIZE,
    mode: REPORT_MODE,
    nameFilter: NAME_FILTER,
    nativeEditorBroker: PROBE_NATIVE_EDITOR_BROKER
  });
  reporter.printIntro(selected.length);

  const results = [];
  for (const plugin of selected) {
    const result = await probePlugin(socket, session, plugin);
    results.push(result);
    reporter.printResult(result);
  }

  const summary = reporter.printSummary(results);
  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

function shouldProbePlugin(plugin) {
  if (!plugin || plugin.hostable === false || plugin.source === "example-bundle" || plugin.source === "builtin-example") {
    return false;
  }
  if (!FORMATS.has(String(plugin.format ?? "").toLowerCase())) {
    return false;
  }
  if (!NAME_FILTER) {
    return true;
  }
  const haystack = `${plugin.pluginId ?? ""} ${plugin.name ?? ""} ${plugin.vendor ?? ""}`.toLowerCase();
  return haystack.includes(NAME_FILTER.toLowerCase());
}

async function probePlugin(socket, session, plugin) {
  const result = {
    pluginId: plugin.pluginId,
    format: plugin.format,
    name: plugin.name,
    vendor: plugin.vendor,
    kind: plugin.kind,
    audioUnitHostProfile: plugin.metadata?.audioUnitHostProfile,
    editorKinds: plugin.editorKinds,
    fileGrantOperations: plugin.fileGrantOperations,
    ok: false,
    phases: []
  };
  let instanceId = "";

  try {
    assertPluginEditorMetadata(plugin);
    assertFileGrantOperationMetadata(plugin);
    const createPayload = createInstancePayload(plugin);
    const created = await phase(result, "createInstance", () =>
      request(socket, "createInstance", createPayload, true, session)
    );
    instanceId = created.instanceId;
    result.renderEngine = created.renderEngine;
    result.layout = boundedLayoutSummary(created.layout);
    result.parameterCount = Array.isArray(created.plugin?.parameters) ? created.plugin.parameters.length : 0;
    result.parameterMetadataAtLimit = created.plugin?.parameterMetadataAtLimit === true || undefined;

    if (PROBE_NATIVE_EDITOR_BROKER && isNativePluginFormat(plugin.format)) {
      await probeNativeEditorBroker(socket, session, plugin, instanceId, result);
    }

    const parameters = await phase(result, "getParameters", () =>
      request(socket, "getParameters", { instanceId }, true, session)
    );
    result.parameterCount = Array.isArray(parameters.parameters) ? parameters.parameters.length : result.parameterCount;
    result.parameterMetadataAtLimit = parameters.parameterMetadataAtLimit === true || result.parameterMetadataAtLimit || undefined;
    result.displayValueCount = assertParameterDisplayMetadata(plugin, parameters.parameters);

    const writableParameter = parameters.parameters?.find((parameter) => parameter.automatable && !parameter.readOnly);
    const restrictedLv2BlockProfile = isRestrictedLv2BlockProfile(plugin);
    if (writableParameter) {
      await phase(result, "setParameter", () =>
        request(
          socket,
          "setParameter",
          { instanceId, parameterId: writableParameter.id, normalizedValue: 0.5 },
          true,
          session
        )
      );
      await probeParameterDisplayInput(socket, session, instanceId, writableParameter, result);
    }

    const state = await phase(result, "getState", () => request(socket, "getState", { instanceId }, true, session));
    if (typeof state.state === "string" && state.state.length > 0) {
      await phase(result, "setState", () => request(socket, "setState", { instanceId, state: state.state }, true, session));
      await probeFileGrantStateRestore({
        assertProbe,
        fileGrantRoot: FILE_GRANT_ROOT,
        instanceId,
        phase,
        plugin,
        request,
        result,
        session,
        socket,
        state
      });
      await probeFileGrantPresetLoad({
        assertProbe,
        fileGrantRoot: FILE_GRANT_ROOT,
        instanceId,
        phase,
        plugin,
        request,
        result,
        session,
        socket,
        state
      });
      await probeFileGrantStateSave({
        assertProbe,
        fileGrantRoot: FILE_GRANT_ROOT,
        instanceId,
        phase,
        plugin,
        request,
        result,
        session,
        socket
      });
    }

    await phase(result, "getLatency", () =>
      request(socket, "getLatency", { instanceId, transportLatencySamples: 0 }, true, session)
    );
    await phase(result, "getTailTime", () => request(socket, "getTailTime", { instanceId }, true, session));

    let automationLaneApplied = false;
    if (writableParameter && !restrictedLv2BlockProfile) {
      const laneStartSample = 4096;
      const blockSize = layoutBlockSize(result.layout);
      const lanePoints = [{ samplePosition: laneStartSample, normalizedValue: 0.25 }];
      if (blockSize > 1) {
        lanePoints.push({
          samplePosition: laneStartSample + Math.min(8, blockSize - 1),
          normalizedValue: 0.5
        });
      }
      const lane = await phase(result, "setAutomationLane", () =>
        request(
          socket,
          "setAutomationLane",
          { instanceId, parameterId: writableParameter.id, points: lanePoints },
          true,
          session
        )
      );
      result.automationLanePointCount = lane.pointCount;
      automationLaneApplied = true;
    } else if (writableParameter && restrictedLv2BlockProfile) {
      result.automationLaneSkipped = "lv2-block-size-profile";
    }

    const midiEvents = midiEventsForBlock(plugin.format, layoutBlockSize(result.layout));
    const midiAccepted = await phase(result, "sendMidiEvents", () =>
      request(socket, "sendMidiEvents", { instanceId, events: midiEvents }, true, session)
    );
    if (midiAccepted.accepted !== true || midiAccepted.eventCount !== midiEvents.length) {
      const error = new Error(`MIDI batch accepted=${midiAccepted.accepted} eventCount=${midiAccepted.eventCount}`);
      error.code = "bad_midi_result";
      throw error;
    }
    result.midiEventCount = midiAccepted.eventCount;

    const renderPayload = renderPayloadForLayout(instanceId, result.layout);
    if (automationLaneApplied) {
      renderPayload.transport = { samplePosition: 4096, tempo: SAMPLE_RATE / 400 };
    }
    const rendered = await phase(result, "processAudioBlock", async () => {
      const response = await request(socket, "processAudioBlock", renderPayload, true, session);
      assertRenderMatchesLayout(response, result.layout);
      return response;
    });
    result.renderedChannels = Array.isArray(rendered.channels) ? rendered.channels.length : 0;

    if (automationLaneApplied) {
      await phase(result, "clearAutomationLane", () =>
        request(
          socket,
          "clearAutomationLane",
          { instanceId, parameterId: writableParameter.id },
          true,
          session
        )
      );
    }

    await phase(result, "sendMidiNoteOff", () =>
      request(
        socket,
        "sendMidiEvents",
        {
          instanceId,
          events: [
            { type: "noteOff", note: 60, velocity: 0, channel: 0, time: 0, ...(plugin.format === "vst3" ? { noteId: 77 } : {}) }
          ]
        },
        true,
        session
      )
    );
    result.ok = true;
  } catch (error) {
    result.error = errorSummary(error);
  } finally {
    if (instanceId) {
      await phase(result, "destroyInstance", () => request(socket, "destroyInstance", { instanceId }, true, session)).catch(
        (error) => {
          result.destroyError = errorSummary(error);
        }
      );
    }
  }

  return result;
}

function assertFileGrantOperationMetadata(plugin) {
  if (!isNativePluginFormat(plugin.format)) {
    return;
  }
  const operations = plugin.fileGrantOperations;
  const expectedOperations = ["loadPreset", "restoreState", "saveStateDirectory"];
  const ok = Array.isArray(operations) &&
    expectedOperations.every((operation) => operations.includes(operation)) &&
    operations.every((operation) => isKnownFileGrantOperation(operation));
  assertProbe(ok, "missing_file_grant_operations", `${plugin.pluginId} did not advertise bounded native file-grant operations`);
}

function assertPluginEditorMetadata(plugin) {
  if (!isNativePluginFormat(plugin.format)) {
    return;
  }
  const kinds = plugin.editorKinds;
  const expectedKinds = ["generic-parameters", "native-window"];
  const ok = Array.isArray(kinds) &&
    expectedKinds.every((kind) => kinds.includes(kind)) &&
    kinds.every((kind) => kind === "generic-parameters" || kind === "native-window");
  assertProbe(ok, "missing_editor_kinds", `${plugin.pluginId} did not advertise bounded native editor kinds`);
}

function assertParameterDisplayMetadata(plugin, parameters) {
  if (!Array.isArray(parameters)) {
    return 0;
  }
  let count = 0;
  for (const [index, parameter] of parameters.entries()) {
    if (parameter?.displayValue == null) {
      continue;
    }
    ++count;
    const ok = typeof parameter.displayValue === "string" &&
      Buffer.byteLength(parameter.displayValue, "utf8") <= 160 &&
      !parameter.displayValue.includes("\u0000");
    assertProbe(ok, "bad_parameter_display_value", `${plugin.pluginId} parameter ${index} returned an unbounded displayValue`);
  }
  return count;
}

async function probeParameterDisplayInput(socket, session, instanceId, parameter, result) {
  if (typeof parameter.displayValue !== "string" || parameter.displayValue.length === 0) {
    result.parameterDisplayInput = "skipped";
    return;
  }
  const response = await phase(result, "setParameterDisplayValue", () =>
    request(
      socket,
      "setParameterDisplayValue",
      { instanceId, parameterId: parameter.id, displayValue: parameter.displayValue },
      true,
      session
    )
  );
  assertProbe(response.parameter?.id === parameter.id, "bad_parameter_display_input", "display text updated the wrong parameter");
  result.parameterDisplayInput = "applied";
}

async function probeNativeEditorBroker(socket, session, plugin, instanceId, result) {
  const opened = await phase(result, "openNativeEditor", async () => {
    const response = await request(socket, "openEditor", { instanceId, mode: "native" }, true, session);
    assertNativeEditorResponse(response, plugin, instanceId);
    return response;
  });
  result.nativeEditor = {
    kind: opened.kind,
    transport: opened.transport,
    nativeWindow: opened.capabilities?.nativeWindow === true
  };
  await phase(result, "closeNativeEditor", () =>
    request(socket, "closeEditor", { editorId: opened.editorId }, true, session)
  );
}

async function phase(result, name, operation) {
  const started = Date.now();
  try {
    const value = await operation();
    result.phases.push({ name, ok: true, elapsedMs: Date.now() - started });
    return value;
  } catch (error) {
    result.phases.push({ name, ok: false, elapsedMs: Date.now() - started, error: errorSummary(error) });
    throw error;
  }
}

function createInstancePayload(plugin) {
  const inferredInputs = plugin.kind === "instrument" ? 0 : 2;
  const inputChannels = clampInt(plugin.inputs, 0, 32, inferredInputs);
  const outputChannels = clampInt(plugin.outputs, 1, 32, 2);
  return {
    pluginId: plugin.pluginId,
    format: plugin.format,
    sampleRate: SAMPLE_RATE,
    maxBlockSize: maxBlockSizeForPlugin(plugin),
    inputChannels,
    outputChannels
  };
}

function assertNativeEditorResponse(response, plugin, instanceId) {
  assertProbe(response && typeof response === "object", "bad_native_editor_response", "native editor response was not an object");
  assertProbe(response.instanceId === instanceId, "bad_native_editor_response", "native editor instance id mismatch");
  assertProbe(response.kind === "native-window", "bad_native_editor_response", "native editor kind was not native-window");
  assertProbe(response.native === true, "bad_native_editor_response", "native editor response was not marked native");
  assertProbe(response.transport === "native-broker", "bad_native_editor_response", "native editor transport was not native-broker");
  assertProbe(response.capabilities?.nativeWindow === true, "bad_native_editor_response", "native editor did not expose nativeWindow capability");
  assertProbe(response.plugin?.pluginId === plugin.pluginId, "bad_native_editor_response", "native editor plugin id mismatch");
  assertProbe(response.plugin?.format === plugin.format, "bad_native_editor_response", "native editor plugin format mismatch");
  assertNoNativeLaunchData(response, "native editor response", assertProbe);
}

function renderPayloadForLayout(instanceId, layout) {
  const inputChannels = clampInt(layout?.inputChannels, 0, 32, 0);
  const frames = layoutBlockSize(layout);
  const bus0Channels = Array.from({ length: inputChannels }, () => Array(frames).fill(0.05));
  const inputBuses = inputChannels > 0 ? [{ index: 0, channels: bus0Channels }] : [];
  const inputBusLayouts = Array.isArray(layout?.inputBusLayouts) ? layout.inputBusLayouts : [];
  for (const bus of inputBusLayouts) {
    const index = clampInt(bus?.index, 0, 31, 0);
    const channels = clampInt(bus?.channels, 0, 32, 0);
    if (index === 0 || bus?.active !== true || channels <= 0 || inputBuses.some((candidate) => candidate.index === index)) {
      continue;
    }
    inputBuses.push({
      index,
      channels: Array.from({ length: channels }, () => Array(frames).fill(0.025))
    });
  }
  return {
    instanceId,
    frames,
    sampleRate: SAMPLE_RATE,
    channels: Array.from({ length: inputChannels }, () => Array(frames).fill(0)),
    inputBuses
  };
}

function midiEventsForBlock(format, frames = MAX_BLOCK_SIZE) {
  const boundedFrames = clampInt(frames, 1, MAX_BLOCK_SIZE, MAX_BLOCK_SIZE);
  const offset = (fraction) => Math.min(boundedFrames - 1, Math.max(0, Math.floor(boundedFrames * fraction)));
  const noteId = 77;
  const events = [
    { type: "noteOn", note: 60, velocity: 0.7, channel: 0, time: 0, ...(format === "vst3" ? { noteId } : {}) },
    { type: "polyPressure", note: 60, pressure: 0.35, channel: 0, time: offset(0.125), ...(format === "vst3" ? { noteId } : {}) },
    { type: "controlChange", controller: 1, value: 0.4, channel: 0, time: offset(0.25) },
    { type: "pitchBend", value: 0.1, channel: 0, time: offset(0.375) },
    { type: "channelPressure", pressure: 0.3, channel: 0, time: offset(0.5) }
  ];
  if (format === "vst3") {
    events.splice(2, 0, { type: "noteExpression", typeId: 0, value: 0.5, noteId, channel: 0, time: offset(0.1875) });
  }
  return events;
}

function isNativePluginFormat(format) {
  const normalized = String(format ?? "").toLowerCase();
  return normalized === "vst3" || normalized === "au" || normalized === "lv2";
}

function isRestrictedLv2BlockProfile(plugin) {
  return plugin?.format === "lv2" && Boolean(lv2BlockSizeProfile(plugin));
}

function maxBlockSizeForPlugin(plugin) {
  const profile = lv2BlockSizeProfile(plugin);
  if (profile && profile.includes("power") && !isPowerOfTwoBlock(MAX_BLOCK_SIZE)) {
    return nearestPowerOfTwoAtMost(MAX_BLOCK_SIZE);
  }
  return MAX_BLOCK_SIZE;
}

function lv2BlockSizeProfile(plugin) {
  const profile = plugin?.metadata?.lv2BlockSizeProfile;
  return profile === "fixed" || profile === "power-of-two" || profile === "fixed-power-of-two"
    ? profile
    : "";
}

function layoutBlockSize(layout) {
  return clampInt(layout?.maxBlockSize, 1, MAX_BLOCK_SIZE, MAX_BLOCK_SIZE);
}

function nearestPowerOfTwoAtMost(value) {
  let power = 1;
  while (power * 2 <= value) {
    power *= 2;
  }
  return power;
}

function isPowerOfTwoBlock(value) {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function assertRenderMatchesLayout(rendered, layout) {
  const expectedOutputChannels = clampInt(layout?.outputChannels, 1, 32, 1);
  if (!Array.isArray(rendered.channels) || rendered.channels.length !== expectedOutputChannels) {
    const error = new Error(`rendered ${rendered.channels?.length ?? 0} channel(s), expected ${expectedOutputChannels}`);
    error.code = "bad_render_layout";
    throw error;
  }
  if (!Array.isArray(rendered.outputBuses)) {
    const error = new Error("render response did not include outputBuses");
    error.code = "bad_render_layout";
    throw error;
  }
  const mainBus = rendered.outputBuses.find((bus) => bus?.index === 0);
  if (!mainBus || !Array.isArray(mainBus.channels) || mainBus.channels.length !== expectedOutputChannels) {
    const error = new Error("render response main output bus did not match the negotiated layout");
    error.code = "bad_render_layout";
    throw error;
  }
}

function boundedLayoutSummary(layout) {
  if (!layout || typeof layout !== "object") {
    return {};
  }
  const summarizeBusLayouts = (value) => Array.isArray(value)
    ? value.map((bus) => ({
        index: clampInt(bus?.index, 0, 31, 0),
        channels: clampInt(bus?.channels, 0, 32, 0),
        active: bus?.active === true
      }))
    : [];
  return {
    inputChannels: layout.inputChannels,
    outputChannels: layout.outputChannels,
    inputBuses: layout.inputBuses,
    outputBuses: layout.outputBuses,
    inputBusLayouts: summarizeBusLayouts(layout.inputBusLayouts),
    outputBusLayouts: summarizeBusLayouts(layout.outputBusLayouts),
    maxBlockSize: layout.maxBlockSize,
    sampleRate: layout.sampleRate
  };
}

function assertProbe(condition, code, message) {
  if (!condition) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
}

function daemonEnvironment(port) {
  const env = {
    ...process.env,
    SOUNDBRIDGE_HOST: HOST,
    SOUNDBRIDGE_PORT: String(port),
    SOUNDBRIDGE_PAIRING_TOKEN: PAIRING_TOKEN,
    SOUNDBRIDGE_ALLOWED_ORIGINS: ORIGIN,
    SOUNDBRIDGE_FILE_GRANT_ROOTS: FILE_GRANT_ROOT,
    SOUNDBRIDGE_FILE_GRANT_ALLOW_BROWSER_PATHS: "1"
  };
  if (PROBE_NATIVE_EDITOR_BROKER) {
    const configuredPath = String(process.env.SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH ?? "").trim();
    env.SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH = configuredPath || process.execPath;
    if (process.env.SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS === undefined && !configuredPath) {
      env.SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS = JSON.stringify([NATIVE_EDITOR_BROKER_FIXTURE]);
    }
  }
  return env;
}

function errorSummary(error) {
  const message = error?.message ?? String(error);
  const code = error?.code ?? message.split(":")[0];
  return { code, message };
}

function flagFromEnv(name) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function intFromEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

function clampInt(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    return fallback;
  }
  return numeric;
}

function request(socket, command, payload, includeSession, sessionToken) {
  const id = `probe-${++requestSeq}`;
  const envelope = {
    type: "request",
    id,
    command,
    payload
  };
  if (includeSession) {
    envelope.sessionToken = sessionToken;
  }
  socket.write(encodeWebSocketFrame(Buffer.from(JSON.stringify(envelope), "utf8")));

  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message.id !== id) {
        return;
      }
      cleanup();
      if (message.ok) {
        resolve(message.payload);
      } else {
        const error = new Error(`${message.error?.code}: ${message.error?.message}`);
        error.code = message.error?.code;
        reject(error);
      }
    };
    const cleanup = () => {
      socket.off("soundbridge-message", onMessage);
      clearTimeout(timeout);
    };
    const timeout = setTimeout(() => {
      cleanup();
      const error = new Error(`timeout: timed out waiting for ${command}`);
      error.code = "timeout";
      reject(error);
    }, REQUEST_TIMEOUT_MS);
    socket.on("soundbridge-message", onMessage);
  });
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, HOST, () => {
      const address = server.address();
      const selectedPort = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(selectedPort));
    });
    server.on("error", reject);
  });
}

function waitForListen(process) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for daemon to listen")), 10000);
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      if (text.includes("SoundBridge mock daemon listening")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`daemon exited before listening (${code})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      process.stdout.off("data", onData);
      process.off("exit", onExit);
    };
    process.stdout.on("data", onData);
    process.on("exit", onExit);
  });
}

function connectWebSocket(host, port, origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.createConnection({ host, port }, () => {
      const headers = [
        "GET /bridge HTTP/1.1",
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13"
      ];
      if (origin !== null) {
        headers.push(`Origin: ${origin}`);
      }
      headers.push("\r\n");
      socket.write(headers.join("\r\n"));
    });

    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let upgraded = false;

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!upgraded) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          return;
        }

        const header = buffer.subarray(0, headerEnd).toString("utf8");
        if (!header.startsWith("HTTP/1.1 101")) {
          reject(new Error(`WebSocket upgrade failed: ${header.split("\r\n")[0]}`));
          socket.destroy();
          return;
        }

        upgraded = true;
        buffer = buffer.subarray(headerEnd + 4);
        resolve(socket);
      }

      while (buffer.length > 0) {
        const parsed = decodeWebSocketFrame(buffer);
        if (!parsed) {
          return;
        }

        buffer = buffer.subarray(parsed.frameLength);
        if (parsed.opcode === 0x1) {
          socket.emit("soundbridge-message", JSON.parse(parsed.payload.toString("utf8")));
        }
      }
    });

    socket.on("error", reject);
  });
}

function encodeWebSocketFrame(payload) {
  const mask = crypto.randomBytes(4);
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
    header.writeUInt32BE(length >>> 0, 6);
  }

  header[0] = 0x81;
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeWebSocketFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const opcode = buffer[0] & 0x0f;
  let payloadLength = buffer[1] & 0x7f;
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
    payloadLength = buffer.readUInt32BE(offset) * 2 ** 32 + buffer.readUInt32BE(offset + 4);
    offset += 8;
  }

  const frameLength = offset + payloadLength;
  if (buffer.length < frameLength) {
    return null;
  }

  return {
    opcode,
    payload: buffer.subarray(offset, frameLength),
    frameLength
  };
}
