import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOST = process.env.SOUNDBRIDGE_HOST ?? "127.0.0.1";
const ORIGIN = process.env.SOUNDBRIDGE_PROBE_ORIGIN ?? "http://127.0.0.1:5173";
const PAIRING_TOKEN = process.env.SOUNDBRIDGE_PAIRING_TOKEN ?? crypto.randomBytes(24).toString("base64url");
const REQUEST_TIMEOUT_MS = intFromEnv("SOUNDBRIDGE_PROBE_TIMEOUT_MS", 15000, 1000, 120000);
const MAX_BLOCK_SIZE = intFromEnv("SOUNDBRIDGE_PROBE_MAX_BLOCK_SIZE", 64, 1, 8192);
const MAX_NATIVE_STATE_FILE_BYTES = 2 * Math.ceil((384 * 1024) / 3) * 4 + 32;
const SAMPLE_RATE = intFromEnv("SOUNDBRIDGE_PROBE_SAMPLE_RATE", 48000, 8000, 384000);
const LIMIT = intFromEnv("SOUNDBRIDGE_PROBE_LIMIT", 0, 0, 10000);
const NAME_FILTER = process.env.SOUNDBRIDGE_PROBE_FILTER ?? "";
const PROBE_NATIVE_EDITOR_BROKER = flagFromEnv("SOUNDBRIDGE_PROBE_NATIVE_EDITOR_BROKER");
const NATIVE_EDITOR_BROKER_FIXTURE = fileURLToPath(new URL("./native-editor-broker-fixture.mjs", import.meta.url));
const FORMATS = new Set(
  (process.env.SOUNDBRIDGE_PROBE_FORMATS ?? "vst3,au")
    .split(",")
    .map((format) => format.trim().toLowerCase())
    .filter(Boolean)
);

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

  console.log(
    `Probing ${selected.length} installed plugin(s) (${[...FORMATS].join(",")})` +
      (NAME_FILTER ? ` matching "${NAME_FILTER}"` : "") +
      ` with ${MAX_BLOCK_SIZE} frame blocks` +
      (PROBE_NATIVE_EDITOR_BROKER ? " and native editor broker checks" : "") +
      "."
  );

  const results = [];
  for (const plugin of selected) {
    const result = await probePlugin(socket, session, plugin);
    results.push(result);
    printResult(result);
  }

  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} plugin(s) passed, ${failed} failed.`);
  console.log(JSON.stringify({ passed, failed, results }, null, 2));
  if (failed > 0) {
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
    ok: false,
    phases: []
  };
  let instanceId = "";

  try {
    const createPayload = createInstancePayload(plugin);
    const created = await phase(result, "createInstance", () =>
      request(socket, "createInstance", createPayload, true, session)
    );
    instanceId = created.instanceId;
    result.renderEngine = created.renderEngine;
    result.layout = boundedLayoutSummary(created.layout);
    result.parameterCount = Array.isArray(created.plugin?.parameters) ? created.plugin.parameters.length : 0;

    if (PROBE_NATIVE_EDITOR_BROKER && isNativePluginFormat(plugin.format)) {
      await probeNativeEditorBroker(socket, session, plugin, instanceId, result);
    }

    const parameters = await phase(result, "getParameters", () =>
      request(socket, "getParameters", { instanceId }, true, session)
    );
    result.parameterCount = Array.isArray(parameters.parameters) ? parameters.parameters.length : result.parameterCount;

    const writableParameter = parameters.parameters?.find((parameter) => parameter.automatable && !parameter.readOnly);
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
    }

    const state = await phase(result, "getState", () => request(socket, "getState", { instanceId }, true, session));
    if (typeof state.state === "string" && state.state.length > 0) {
      await phase(result, "setState", () => request(socket, "setState", { instanceId, state: state.state }, true, session));
      await probeFileGrantStateRestore(socket, session, plugin, instanceId, state, result);
      await probeFileGrantStateSave(socket, session, instanceId, plugin, result);
    }

    await phase(result, "getLatency", () =>
      request(socket, "getLatency", { instanceId, transportLatencySamples: 0 }, true, session)
    );
    await phase(result, "getTailTime", () => request(socket, "getTailTime", { instanceId }, true, session));

    if (writableParameter) {
      const laneStartSample = 4096;
      const lanePoints = [{ samplePosition: laneStartSample, normalizedValue: 0.25 }];
      if (MAX_BLOCK_SIZE > 1) {
        lanePoints.push({
          samplePosition: laneStartSample + Math.min(8, MAX_BLOCK_SIZE - 1),
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
    }

    const midiEvents = midiEventsForBlock(plugin.format);
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
    if (writableParameter) {
      renderPayload.transport = { samplePosition: 4096, tempo: SAMPLE_RATE / 400 };
    }
    const rendered = await phase(result, "processAudioBlock", async () => {
      const response = await request(socket, "processAudioBlock", renderPayload, true, session);
      assertRenderMatchesLayout(response, result.layout);
      return response;
    });
    result.renderedChannels = Array.isArray(rendered.channels) ? rendered.channels.length : 0;

    if (writableParameter) {
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

async function probeFileGrantStateRestore(socket, session, plugin, instanceId, state, result) {
  const stateText = nativeStateFileText(plugin.format, state.state);
  if (!stateText) {
    result.fileGrantStateRestore = "skipped";
    return;
  }
  const statePath = path.join(FILE_GRANT_ROOT, `${safeFilename(plugin.pluginId)}.state`);
  fs.writeFileSync(statePath, stateText, "utf8");
  let grantId = "";
  try {
    const grant = await phase(result, "createStateFileGrant", () =>
      request(socket, "createFileGrant", { path: statePath, purpose: "state", access: "read", kind: "file" }, true, session)
    );
    grantId = grant.grantId;
    await phase(result, "attachStateFileGrant", () =>
      request(socket, "attachFileGrant", { instanceId, grantId, purpose: "state", access: "read", kind: "file" }, true, session)
    );
    const restored = await phase(result, "useFileGrantRestoreState", () =>
      request(socket, "useFileGrant", { instanceId, grantId, operation: "restoreState" }, true, session)
    );
    assertProbe(restored.applied === true, "bad_file_grant_restore", "file grant state restore was not applied");
    assertNoNativeLaunchData(restored, "file grant restore response");
    result.fileGrantStateRestore = "applied";
  } finally {
    if (grantId) {
      await request(socket, "detachFileGrant", { instanceId, grantId }, true, session).catch(() => undefined);
      await request(socket, "revokeFileGrant", { grantId }, true, session).catch(() => undefined);
    }
    fs.rmSync(statePath, { force: true });
  }
}

async function probeFileGrantStateSave(socket, session, instanceId, plugin, result) {
  const stateDir = fs.mkdtempSync(path.join(FILE_GRANT_ROOT, `${safeFilename(plugin.pluginId)}-save-`));
  let directoryGrantId = "";
  let fileGrantId = "";
  try {
    const directoryGrant = await phase(result, "createStateDirectoryGrant", () =>
      request(socket, "createFileGrant", { path: stateDir, purpose: "state", access: "readWrite", kind: "directory" }, true, session)
    );
    directoryGrantId = directoryGrant.grantId;
    await phase(result, "attachStateDirectoryGrant", () =>
      request(socket, "attachFileGrant", { instanceId, grantId: directoryGrantId, purpose: "state", access: "readWrite", kind: "directory" }, true, session)
    );
    const saved = await phase(result, "useFileGrantSaveStateDirectory", () =>
      request(socket, "useFileGrant", { instanceId, grantId: directoryGrantId, operation: "saveStateDirectory" }, true, session)
    );
    assertProbe(saved.applied === true, "bad_file_grant_save", "file grant state save was not applied");
    assertNoNativeLaunchData(saved, "file grant save response");
    result.fileGrantStateSave = "applied";

    const savedFiles = fs.readdirSync(stateDir, { withFileTypes: true }).filter((entry) => entry.isFile());
    assertProbe(savedFiles.length === 1, "bad_file_grant_save_file", "file grant state save did not create exactly one state file");
    const savedPath = path.join(stateDir, savedFiles[0].name);
    const savedStats = fs.lstatSync(savedPath);
    assertProbe(savedStats.isFile(), "bad_file_grant_save_file", "saved state path is not a regular file");
    assertProbe(
      savedStats.size > 0 && savedStats.size <= MAX_NATIVE_STATE_FILE_BYTES,
      "bad_file_grant_save_file",
      "saved state file size is invalid"
    );

    const fileGrant = await phase(result, "createSavedStateFileGrant", () =>
      request(socket, "createFileGrant", { path: savedPath, purpose: "state", access: "read", kind: "file" }, true, session)
    );
    fileGrantId = fileGrant.grantId;
    await phase(result, "attachSavedStateFileGrant", () =>
      request(socket, "attachFileGrant", { instanceId, grantId: fileGrantId, purpose: "state", access: "read", kind: "file" }, true, session)
    );
    const restored = await phase(result, "useFileGrantRestoreSavedState", () =>
      request(socket, "useFileGrant", { instanceId, grantId: fileGrantId, operation: "restoreState" }, true, session)
    );
    assertProbe(restored.applied === true, "bad_file_grant_saved_restore", "saved file grant state restore was not applied");
    assertNoNativeLaunchData(restored, "saved file grant restore response");
    result.fileGrantSavedStateRestore = "applied";
  } finally {
    if (fileGrantId) {
      await request(socket, "detachFileGrant", { instanceId, grantId: fileGrantId }, true, session).catch(() => undefined);
      await request(socket, "revokeFileGrant", { grantId: fileGrantId }, true, session).catch(() => undefined);
    }
    if (directoryGrantId) {
      await request(socket, "detachFileGrant", { instanceId, grantId: directoryGrantId }, true, session).catch(() => undefined);
      await request(socket, "revokeFileGrant", { grantId: directoryGrantId }, true, session).catch(() => undefined);
    }
    fs.rmSync(stateDir, { force: true, recursive: true });
  }
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

function nativeStateFileText(format, stateEnvelope) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(stateEnvelope), "base64").toString("utf8"));
  } catch {
    return "";
  }
  const nativeState = parsed?.nativeState;
  if (!nativeState || nativeState.format !== format) {
    return "";
  }
  if (format === "vst3") {
    const component = String(nativeState.component ?? "");
    const controller = String(nativeState.controller ?? "");
    if (!component && !controller) {
      return "";
    }
    return `${component || "-"} ${controller || "-"}\n`;
  }
  if (format === "au" || format === "lv2") {
    const state = String(nativeState.state ?? "");
    return state ? `${state}\n` : "";
  }
  return "";
}

function safeFilename(value) {
  return String(value ?? "plugin")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 120) || "plugin";
}

function createInstancePayload(plugin) {
  const inferredInputs = plugin.kind === "instrument" ? 0 : 2;
  const inputChannels = clampInt(plugin.inputs, 0, 32, inferredInputs);
  const outputChannels = clampInt(plugin.outputs, 1, 32, 2);
  return {
    pluginId: plugin.pluginId,
    format: plugin.format,
    sampleRate: SAMPLE_RATE,
    maxBlockSize: MAX_BLOCK_SIZE,
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
  assertNoNativeLaunchData(response, "native editor response");
}

function assertNoNativeLaunchData(value, context) {
  const forbiddenKeys = new Set([
    "absolutePath",
    "brokerSessionId",
    "bundlePath",
    "componentPath",
    "diagnostics",
    "executablePath",
    "nativeHost",
    "path",
    "rootId"
  ]);
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      assertProbe(!forbiddenKeys.has(key), "native_editor_launch_data_leak", `${context} exposed ${key}`);
      if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }
}

function renderPayloadForLayout(instanceId, layout) {
  const inputChannels = clampInt(layout?.inputChannels, 0, 32, 0);
  const bus0Channels = Array.from({ length: inputChannels }, () => Array(MAX_BLOCK_SIZE).fill(0.05));
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
      channels: Array.from({ length: channels }, () => Array(MAX_BLOCK_SIZE).fill(0.025))
    });
  }
  return {
    instanceId,
    frames: MAX_BLOCK_SIZE,
    sampleRate: SAMPLE_RATE,
    channels: Array.from({ length: inputChannels }, () => Array(MAX_BLOCK_SIZE).fill(0)),
    inputBuses
  };
}

function midiEventsForBlock(format) {
  const offset = (fraction) => Math.min(MAX_BLOCK_SIZE - 1, Math.max(0, Math.floor(MAX_BLOCK_SIZE * fraction)));
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

function printResult(result) {
  const status = result.ok ? "ok" : "FAIL";
  const failedPhase = result.phases.find((phaseResult) => !phaseResult.ok);
  const suffix = failedPhase ? ` (${failedPhase.name}: ${failedPhase.error?.code ?? failedPhase.error?.message})` : "";
  console.log(`${status.padEnd(4)} ${result.pluginId}${suffix}`);
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
