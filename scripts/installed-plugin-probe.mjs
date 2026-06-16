import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isKnownFileGrantOperation } from "./daemon-file-grant-operations.mjs";
import {
  assertNoNativeLaunchData,
  probeFileGrantCacheDirectoryOpen,
  probeFileGrantLicenseLoad,
  probeFileGrantOtherPresetLoad,
  probeFileGrantPresetLoad,
  probeFileGrantSampleLoad,
  probeFileGrantStateRestore,
  probeFileGrantStateSave,
  summarizeNativeStateProfile
} from "./installed-plugin-probe-file-grants.mjs";
import { summarizeProbeVst3Events } from "./installed-plugin-probe-events.mjs";
import { installedProbeFormats } from "./installed-plugin-probe-formats.mjs";
import { summarizeProbeBusLayout } from "./installed-plugin-probe-layouts.mjs";
import {
  midiEventsForBlock,
  summarizeProbeMidiControllerEvents,
  summarizeProbeMidiProgramChangeEvents
} from "./installed-plugin-probe-midi.mjs";
import {
  assertParameterDisplayMetadata,
  probeParameterDisplayInput,
  summarizeParameterProfile
} from "./installed-plugin-probe-parameters.mjs";
import { probeListedPreset, probeVst3ProgramData } from "./installed-plugin-probe-programs.mjs";
import {
  assertProbeRenderMatchesLayout,
  summarizeProbeOutputBusSignal,
  summarizeProbeRenderSignal
} from "./installed-plugin-probe-rendering.mjs";
import { renderPayloadForLayout } from "./installed-plugin-probe-render-payload.mjs";
import { installedProbeErrorSummary } from "./installed-plugin-probe-errors.mjs";
import { createInstalledProbeReporter, installedProbeReportMode } from "./installed-plugin-probe-reporting.mjs";
import {
  connectWebSocket,
  createProbeRequester,
  reservePort,
  waitForListen
} from "./installed-plugin-probe-transport.mjs";

const HOST = process.env.SOUNDBRIDGE_HOST ?? "127.0.0.1";
const ORIGIN = process.env.SOUNDBRIDGE_PROBE_ORIGIN ?? "http://127.0.0.1:5173";
const PAIRING_TOKEN = process.env.SOUNDBRIDGE_PAIRING_TOKEN ?? crypto.randomBytes(24).toString("base64url");
const REQUEST_TIMEOUT_MS = intFromEnv("SOUNDBRIDGE_PROBE_TIMEOUT_MS", 15000, 1000, 120000);
const MAX_BLOCK_SIZE = intFromEnv("SOUNDBRIDGE_PROBE_MAX_BLOCK_SIZE", 64, 1, 8192);
const SAMPLE_RATE = intFromEnv("SOUNDBRIDGE_PROBE_SAMPLE_RATE", 48000, 8000, 384000);
const LIMIT = intFromEnv("SOUNDBRIDGE_PROBE_LIMIT", 0, 0, 10000);
const MAX_PLUGIN_LATENCY_SAMPLES = 1_048_576;
const MAX_PLUGIN_TAIL_SAMPLES = 1_048_576;
const NAME_FILTER = process.env.SOUNDBRIDGE_PROBE_FILTER ?? "";
const REPORT_MODE = installedProbeReportMode();
const PROBE_NATIVE_EDITOR_BROKER = flagFromEnv("SOUNDBRIDGE_PROBE_NATIVE_EDITOR_BROKER");
const NATIVE_EDITOR_BROKER_FIXTURE = fileURLToPath(new URL("./native-editor-broker-fixture.mjs", import.meta.url));
const FORMATS = installedProbeFormats();

const request = createProbeRequester({ requestTimeoutMs: REQUEST_TIMEOUT_MS });
const FILE_GRANT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "soundbridge-probe-grants-"));

const port = await reservePort(HOST);
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
  const socket = await connectWebSocket(HOST, port, ORIGIN);
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
    result.busProfile = summarizeProbeBusLayout(plugin, result.layout);
    result.vst3EventProfile = summarizeProbeVst3Events(created.plugin);
    result.parameterCount = Array.isArray(created.plugin?.parameters) ? created.plugin.parameters.length : 0;
    result.parameterMetadataAtLimit = created.plugin?.parameterMetadataAtLimit === true || undefined;
    await probeListedPreset({
      assertProbe,
      createdPlugin: created.plugin,
      instanceId,
      phase,
      plugin,
      request,
      result,
      session,
      socket
    });
    await probeVst3ProgramData({
      assertProbe,
      createdPlugin: created.plugin,
      instanceId,
      phase,
      plugin,
      request,
      result,
      session,
      socket
    });

    if (PROBE_NATIVE_EDITOR_BROKER && isNativePluginFormat(plugin.format)) {
      await probeNativeEditorBroker(socket, session, plugin, instanceId, result);
    }

    const parameters = await phase(result, "getParameters", () =>
      request(socket, "getParameters", { instanceId }, true, session)
    );
    const parameterList = Array.isArray(parameters.parameters) ? parameters.parameters : [];
    result.parameterCount = Array.isArray(parameters.parameters) ? parameterList.length : result.parameterCount;
    result.parameterMetadataAtLimit = parameters.parameterMetadataAtLimit === true || result.parameterMetadataAtLimit || undefined;
    result.displayValueCount = assertParameterDisplayMetadata({ assertProbe, parameters: parameterList, plugin });
    result.parameterProfile = summarizeParameterProfile(parameterList, {
      atLimit: result.parameterMetadataAtLimit === true,
      format: plugin.format
    });

    const writableParameter = parameterList.find((parameter) => parameter.automatable && !parameter.readOnly);
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
      await probeParameterDisplayInput({
        assertProbe,
        instanceId,
        parameter: writableParameter,
        phase,
        request,
        result,
        session,
        socket
      });
    } else {
      result.parameterDisplayInput = "skipped-no-writable-parameter";
    }

    const state = await phase(result, "getState", () => request(socket, "getState", { instanceId }, true, session));
    result.stateProfile = summarizeNativeStateProfile(plugin.format, state.state);
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
    await probeFileGrantSampleLoad({
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
    await probeFileGrantCacheDirectoryOpen({
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
    await probeFileGrantLicenseLoad({
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
    await probeFileGrantOtherPresetLoad({
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

    const transportLatencySamples = layoutBlockSize(result.layout);
    const latency = await phase(result, "getLatency", () =>
      request(socket, "getLatency", { instanceId, transportLatencySamples }, true, session)
    );
    assertProbeLatency(latency, transportLatencySamples);
    result.pluginLatencySamples = latency.pluginLatencySamples;
    result.transportLatencySamples = latency.transportLatencySamples;
    result.reportedLatencySamples = latency.reportedLatencySamples;
    const tail = await phase(result, "getTailTime", () => request(socket, "getTailTime", { instanceId }, true, session));
    assertProbeTail(tail);
    result.tailSamples = tail.tailSamples;
    result.infiniteTail = tail.infiniteTail;

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
    } else {
      result.automationLaneSkipped = "no-writable-parameter";
    }

    const midiEvents = midiEventsForBlock(plugin.format, layoutBlockSize(result.layout), MAX_BLOCK_SIZE);
    const midiAccepted = await phase(result, "sendMidiEvents", () =>
      request(socket, "sendMidiEvents", { instanceId, events: midiEvents }, true, session)
    );
    if (midiAccepted.accepted !== true || midiAccepted.eventCount !== midiEvents.length) {
      const error = new Error(`MIDI batch accepted=${midiAccepted.accepted} eventCount=${midiAccepted.eventCount}`);
      error.code = "bad_midi_result";
      throw error;
    }
    result.midiEventCount = midiAccepted.eventCount;
    result.midiControllerEventProfile = summarizeProbeMidiControllerEvents(midiEvents);
    result.midiControllerEventCount = result.midiControllerEventProfile.eventCount;
    result.midiProgramChangeEventProfile = summarizeProbeMidiProgramChangeEvents(midiEvents);
    result.midiProgramChangeEventCount = result.midiProgramChangeEventProfile.eventCount;
    result.vst3MidiControllerEvents = String(plugin.format ?? "").toLowerCase() === "vst3"
      ? result.midiControllerEventCount > 0 ? "accepted" : "missing"
      : "skipped-format";
    result.vst3MidiProgramChangeEvents = String(plugin.format ?? "").toLowerCase() === "vst3"
      ? result.midiProgramChangeEventCount > 0 ? "accepted" : "missing"
      : "skipped-format";

    const renderPayload = renderPayloadForLayout(instanceId, result.layout, {
      maxBlockSize: MAX_BLOCK_SIZE,
      sampleRate: SAMPLE_RATE
    });
    renderPayload.transport = renderTransportContext();
    const rendered = await phase(result, "processAudioBlock", async () => {
      const response = await request(socket, "processAudioBlock", renderPayload, true, session);
      assertProbeRenderMatchesLayout(response, result.layout, renderPayload.frames);
      assertRenderTransport(response, renderPayload.transport);
      return response;
    });
    result.renderedChannels = Array.isArray(rendered.channels) ? rendered.channels.length : 0;
    result.renderSignal = summarizeProbeRenderSignal(rendered);
    result.outputBusSignalProfile = summarizeProbeOutputBusSignal(rendered, result.layout);
    result.hostTransport = "accepted";

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

function renderTransportContext() {
  return {
    playing: true,
    samplePosition: 4096,
    tempo: SAMPLE_RATE / 400,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4
  };
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

function assertRenderTransport(rendered, expected) {
  const actual = rendered.transport;
  assertProbe(actual && typeof actual === "object", "bad_render_transport", "render response did not echo bounded host transport");
  assertProbe(actual.playing === true, "bad_render_transport", "render response lost host playing state");
  assertProbe(actual.samplePosition === expected.samplePosition, "bad_render_transport", "render response lost host sample position");
  assertProbe(Math.abs(Number(actual.tempo) - expected.tempo) < 0.000001, "bad_render_transport", "render response lost host tempo");
  assertProbe(actual.timeSignatureNumerator === 4, "bad_render_transport", "render response lost host time signature numerator");
  assertProbe(actual.timeSignatureDenominator === 4, "bad_render_transport", "render response lost host time signature denominator");
}

function assertProbeLatency(latency, transportLatencySamples) {
  assertProbe(
    Number.isInteger(latency?.pluginLatencySamples) &&
      latency.pluginLatencySamples >= 0 &&
      latency.pluginLatencySamples <= MAX_PLUGIN_LATENCY_SAMPLES,
    "bad_latency_report",
    "latency report did not include bounded plugin latency"
  );
  assertProbe(
    latency.transportLatencySamples === transportLatencySamples,
    "bad_latency_report",
    "latency report did not echo bounded transport latency"
  );
  assertProbe(
    latency.reportedLatencySamples === Math.min(latency.pluginLatencySamples + transportLatencySamples, MAX_PLUGIN_LATENCY_SAMPLES),
    "bad_latency_report",
    "latency report did not include the bounded total latency"
  );
}

function assertProbeTail(tail) {
  assertProbe(
    Number.isInteger(tail?.tailSamples) &&
      tail.tailSamples >= 0 &&
      tail.tailSamples <= MAX_PLUGIN_TAIL_SAMPLES,
    "bad_tail_report",
    "tail report did not include bounded tail samples"
  );
  assertProbe(typeof tail.infiniteTail === "boolean", "bad_tail_report", "tail report did not include an explicit infinite-tail flag");
}

function boundedLayoutSummary(layout) {
  if (!layout || typeof layout !== "object") {
    return {};
  }
  const summarizeBusLayouts = (value) => Array.isArray(value)
    ? value.map((bus) => ({
        index: clampInt(bus?.index, 0, 31, 0),
        channels: clampInt(bus?.channels, 0, 32, 0),
        type: bus?.type === "main" || bus?.type === "aux" || bus?.type === "unknown" ? bus.type : "unknown",
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
  return installedProbeErrorSummary(error);
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
