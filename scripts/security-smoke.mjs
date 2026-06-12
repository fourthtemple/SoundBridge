// Focused security regression test for the hardened mock daemon.
// Exercises only the mock.gain path so it runs without a native build.
import { spawn } from "node:child_process";
import {
  connect,
  createRequestClient,
  rawHandshake,
  rawHttpRequest
} from "./security-smoke-client.mjs";
import { createSecurityDaemonCases, waitForListen } from "./security-smoke-daemon-cases.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SOUNDBRIDGE_PORT ?? 47991);
const TOKEN = "dev-token";
const ORIGIN = "http://127.0.0.1:5173";
const DISALLOWED_ORIGIN = "https://evil.example";

let passed = 0;
const failures = [];
const request = createRequestClient();
function check(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ok  - ${message}`);
  } else {
    failures.push(message);
    console.log(`  FAIL- ${message}`);
  }
}

const daemonCases = createSecurityDaemonCases({
  check,
  disallowedOrigin: DISALLOWED_ORIGIN,
  host: HOST,
  origin: ORIGIN,
  port: PORT,
  request,
  token: TOKEN
});

const daemon = spawn("node", ["scripts/mock-daemon.mjs"], {
  env: {
    ...process.env,
    SOUNDBRIDGE_HOST: HOST,
    SOUNDBRIDGE_PORT: String(PORT),
    SOUNDBRIDGE_PAIRING_TOKEN: TOKEN,
    SOUNDBRIDGE_MAX_PAIR_ATTEMPTS: "3"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
daemon.stderr.on("data", () => {});

try {
  await waitForListen(daemon);
  await run();
} finally {
  daemon.kill("SIGKILL");
}

console.log(`\n${passed} checks passed, ${failures.length} failed.`);
if (failures.length > 0) {
  process.exit(1);
}

async function run() {
  // A. DNS-rebinding: a non-loopback Host header must be rejected at upgrade.
  const rebindHttp = await rawHttpRequest(HOST, PORT, "evil.example", "/health");
  check(rebindHttp.statusCode === 403, "HTTP request with non-loopback Host header is rejected (DNS-rebinding defense)");
  const rebind = await rawHandshake(HOST, PORT, "evil.example", ORIGIN);
  check(rebind.status !== "101", "WS upgrade with non-loopback Host header is rejected (DNS-rebinding defense)");
  rebind.socket?.destroy();

  // A2. Origin allowlists must deny unapproved origins while preserving approved origins.
  await daemonCases.checkOriginAllowlist();

  // A3. Oversized frames must be rejected before pairing or command dispatch.
  await daemonCases.checkPrePairingMessageSizeCap();

  // A4. Disconnecting a browser session must destroy session-owned instances.
  await daemonCases.checkDisconnectCleansUpInstances();

  // B. Loopback Host header upgrades normally.
  const main = await connect(HOST, PORT, `${HOST}:${PORT}`, ORIGIN);
  check(Boolean(main.socket), "WS upgrade with loopback Host header succeeds");

  // C. Unpaired hello stays minimal.
  const helloUnpaired = await request(main, "hello", {}, false);
  check(helloUnpaired.pairingRequired === true, "unpaired hello reports pairingRequired");
  check(
    Object.keys(helloUnpaired.capabilities?.pluginFormats ?? {}).length === 0,
    "unpaired hello does not disclose plugin host adapters"
  );
  check(helloUnpaired.capabilities?.security?.hostHeaderValidation === true, "hello advertises hostHeaderValidation");
  for (const command of [
    "scanPlugins",
    "listPlugins",
    "createInstance",
    "destroyInstance",
    "getParameters",
    "setParameter",
    "setPreset",
    "setParameterEvents",
    "setParameterCurve",
    "setAutomationLane",
    "clearAutomationLane",
    "getState",
    "setState",
    "processAudioBlock",
    "sendMidiEvents",
    "getLatency",
    "getTailTime",
    "getLayout",
    "openEditor",
    "closeEditor"
  ]) {
    const blocked = await request(main, command, {}, false).then(
      () => ({ ok: true }),
      (error) => ({ code: error.code })
    );
    check(blocked.code === "not_paired", `unpaired ${command} is rejected`);
  }

  // D. Wrong pairing token is rejected, and the connection locks out after the limit.
  const noOriginSocket = await connect(HOST, PORT, `${HOST}:${PORT}`);
  const noOriginPair = await request(noOriginSocket, "pair", { pairingToken: TOKEN }, false).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(noOriginPair.code === "origin_required", "pairing without a WebSocket Origin header is rejected");
  noOriginSocket.socket?.destroy();

  const lockSocket = await connect(HOST, PORT, `${HOST}:${PORT}`, ORIGIN);
  const r1 = await pairAttempt(lockSocket, "wrong-1");
  const r2 = await pairAttempt(lockSocket, "wrong-2");
  const r3 = await pairAttempt(lockSocket, "wrong-3");
  check(r1.code === "pairing_denied", "1st wrong token -> pairing_denied");
  check(r2.code === "pairing_denied", "2nd wrong token -> pairing_denied");
  check(r3.code === "pairing_denied" || r3.closed === true, "3rd wrong token -> denied then connection closed");
  // After the limit the connection is closed; a follow-up attempt cannot pair.
  const r4 = await pairAttempt(lockSocket, TOKEN);
  check(r4.closed === true || r4.code === "pairing_locked", "after lockout the correct token cannot pair on that connection");
  lockSocket.socket?.destroy();

  const mismatchSocket = await connect(HOST, PORT, `${HOST}:${PORT}`, ORIGIN);
  const originMismatch = await request(
    mismatchSocket,
    "pair",
    { origin: DISALLOWED_ORIGIN, pairingToken: TOKEN },
    false
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(originMismatch.code === "origin_mismatch", "pair rejects origins that do not match the WebSocket Origin header");
  mismatchSocket.socket?.destroy();

  // E. Correct token pairs.
  const paired = await request(main, "pair", { origin: ORIGIN, pairingToken: TOKEN }, false);
  check(typeof paired.sessionToken === "string" && paired.sessionToken.length > 0, "correct token pairs and returns a session token");
  const session = paired.sessionToken;
  const pairedHello = await request(main, "hello", {}, true, session);
  check(pairedHello.capabilities?.automation === true, "paired hello advertises bounded parameter automation");
  check(
    pairedHello.capabilities?.security?.maxAutomationLanesPerInstance >= 1 &&
      pairedHello.capabilities?.security?.maxAutomationLanePoints >= 1,
    "paired hello advertises bounded automation lane limits"
  );
  check(
    pairedHello.capabilities?.transport === true &&
      pairedHello.capabilities?.security?.maxTransportTempoBpm >= 960 &&
      pairedHello.capabilities?.security?.maxTransportSamplePosition > 0,
    "paired hello advertises bounded host transport context"
  );
  check(
    pairedHello.capabilities?.security?.maxWorkerStdoutLineBytes > 0,
    "paired hello advertises bounded native worker stdout lines"
  );
  check(
    pairedHello.capabilities?.genericEditor === true &&
      pairedHello.capabilities?.nativeEditor === false &&
      pairedHello.capabilities?.security?.maxEditorsPerSession > 0,
    "paired hello advertises bounded generic editor brokering"
  );
  const listed = await request(main, "listPlugins", {}, true, session);
  check(publicPluginsArePathFree(listed.plugins), "listPlugins returns path-free public plugin metadata");
  const scanned = await request(main, "scanPlugins", {}, true, session);
  check(
    Array.isArray(scanned.nativeSearchPaths) &&
      scanned.nativeSearchPaths.length === 0 &&
      publicPluginsArePathFree(scanned.plugins),
    "scanPlugins returns path-free public plugin metadata"
  );
  const replay = await connect(HOST, PORT, `${HOST}:${PORT}`, ORIGIN);
  const replayedSession = await request(replay, "hello", {}, true, session).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(replayedSession.code === "session_connection_mismatch", "session tokens cannot be replayed on a different WebSocket");
  replay.socket?.destroy();

  // F. createInstance rejects out-of-range sizing instead of allocating.
  const huge = await request(main, "createInstance", { pluginId: "mock.gain", outputChannels: 1e9 }, true, session).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(huge.code === "invalid_argument", "createInstance outputChannels=1e9 -> invalid_argument (no OOM)");
  for (const [field, payload] of [
    ["maxBlockSize", { pluginId: "mock.gain", maxBlockSize: 5e8 }],
    ["sampleRate", { pluginId: "mock.gain", sampleRate: -1 }],
    ["inputChannels", { pluginId: "mock.gain", inputChannels: 1e7 }]
  ]) {
    const res = await request(main, "createInstance", payload, true, session).then(
      () => ({ ok: true }),
      (error) => ({ code: error.code })
    );
    check(res.code === "invalid_argument", `createInstance rejects out-of-range ${field}`);
  }

  // G. Valid createInstance + an oversized processAudioBlock returns quickly and bounded.
  const created = await request(
    main,
    "createInstance",
    { pluginId: "mock.gain", sampleRate: 48000, maxBlockSize: 128, inputChannels: 2, outputChannels: 2 },
    true,
    session
  );
  check(typeof created.instanceId === "string", "valid createInstance returns an instanceId");
  check(publicPluginIsPathFree(created.plugin), "createInstance returns a path-free public plugin snapshot");
  check(/^inst-[0-9a-f-]{36}$/.test(created.instanceId), "instanceId is a random UUID (not a guessable counter)");
  check(
    created.layout?.inputChannels === 2 &&
      created.layout?.outputChannels === 2 &&
      created.layout?.inputBuses <= 32 &&
      created.layout?.outputBuses <= 32 &&
      Array.isArray(created.layout?.inputBusLayouts) &&
      Array.isArray(created.layout?.outputBusLayouts) &&
      created.layout.inputBusLayouts.length === created.layout.inputBuses &&
      created.layout.outputBusLayouts.length === created.layout.outputBuses,
    "createInstance reports bounded negotiated layout"
  );
  const mockProgram = created.plugin?.parameters?.find((parameter) => parameter.id === "program");
  check(
    mockProgram?.programChange === true &&
      mockProgram.programList?.programs?.length === 4 &&
      mockProgram.programList.programs.every((program) => typeof program.name === "string" && program.name.length <= 160),
    "createInstance exposes bounded program-list parameter metadata"
  );
  const selectedProgram = await request(
    main,
    "setParameter",
    { instanceId: created.instanceId, parameterId: "program", normalizedValue: 2 / 3 },
    true,
    session
  );
  check(
    selectedProgram.parameter?.programChange === true &&
      Math.abs(selectedProgram.parameter.normalizedValue - 2 / 3) < 0.000001,
    "setParameter selects a bounded program-list value"
  );
  const readOnlyParameter = created.plugin?.parameters?.find((parameter) => parameter.id === "output-level");
  check(
    readOnlyParameter?.readOnly === true && readOnlyParameter.automatable === false,
    "createInstance exposes bounded read-only parameter metadata"
  );
  const readOnlyWrite = await request(
    main,
    "setParameter",
    { instanceId: created.instanceId, parameterId: "output-level", normalizedValue: 1 },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(readOnlyWrite.code === "parameter_read_only", "setParameter rejects read-only parameters before worker dispatch");
  check(
    Array.isArray(created.plugin?.presets) &&
      created.plugin.presets.length >= 2 &&
      created.plugin.presets.every((preset) => typeof preset.id === "string" && preset.id.length <= 64),
    "createInstance exposes bounded preset snapshot metadata"
  );
  const presetApplied = await request(
    main,
    "setPreset",
    { instanceId: created.instanceId, presetId: "gain-bright" },
    true,
    session
  );
  check(
    presetApplied.applied === true &&
      presetApplied.parameterCount === 2 &&
      presetApplied.parameters?.some((parameter) => parameter.id === "gain" && Math.abs(parameter.normalizedValue - 0.75) < 0.000001) &&
      presetApplied.parameters?.some((parameter) => parameter.id === "program" && Math.abs(parameter.normalizedValue - 2 / 3) < 0.000001) &&
      !presetApplied.parameters?.some((parameter) => parameter.id === "output-level"),
    "setPreset applies only writable entries from a daemon-listed bounded preset snapshot"
  );
  const savedState = await request(main, "getState", { instanceId: created.instanceId }, true, session);
  const tamperedState = JSON.parse(Buffer.from(savedState.state, "base64").toString("utf8"));
  tamperedState.parameters["output-level"] = 1;
  const restoredTamperedState = await request(
    main,
    "setState",
    { instanceId: created.instanceId, state: Buffer.from(JSON.stringify(tamperedState), "utf8").toString("base64") },
    true,
    session
  );
  check(
    restoredTamperedState.parameters?.some((parameter) => parameter.id === "output-level" && parameter.normalizedValue === 0),
    "setState ignores read-only parameter values in opaque state envelopes"
  );
  const missingPreset = await request(
    main,
    "setPreset",
    { instanceId: created.instanceId, presetId: "does-not-exist" },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(missingPreset.code === "preset_not_found", "setPreset rejects unknown preset ids");
  const oversizedPresetId = await request(
    main,
    "setPreset",
    { instanceId: created.instanceId, presetId: "x".repeat(65) },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(oversizedPresetId.code === "invalid_argument", "setPreset rejects oversized preset ids");

  const layout = await request(main, "getLayout", { instanceId: created.instanceId }, true, session);
  check(
    layout.inputChannels === created.layout.inputChannels &&
      layout.outputChannels === created.layout.outputChannels &&
      layout.maxBlockSize === 128,
    "getLayout returns session-owned negotiated layout"
  );

  const editor = await request(main, "openEditor", { instanceId: created.instanceId }, true, session);
  check(
    /^editor-[0-9a-f-]{36}$/.test(editor.editorId) &&
      editor.kind === "generic-parameters" &&
      editor.native === false &&
      editor.capabilities?.parameterEditing === true &&
      editor.capabilities?.nativeWindow === false &&
      Array.isArray(editor.parameters) &&
      !("diagnostics" in (editor.plugin ?? {})),
    "openEditor returns a bounded generic parameter editor session"
  );
  const nativeEditor = await request(
    main,
    "openEditor",
    { instanceId: created.instanceId, mode: "native" },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(nativeEditor.code === "unsupported_command", "openEditor refuses native editors until a UI worker is available");

  const latency = await request(
    main,
    "getLatency",
    { instanceId: created.instanceId, transportLatencySamples: 32 },
    true,
    session
  );
  check(
    latency.pluginLatencySamples === 0 &&
      latency.transportLatencySamples === 32 &&
      latency.reportedLatencySamples === 32,
    "getLatency reports bounded plugin plus transport latency"
  );

  const latencyTooLarge = await request(
    main,
    "getLatency",
    { instanceId: created.instanceId, transportLatencySamples: 1e9 },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(latencyTooLarge.code === "invalid_argument", "getLatency rejects out-of-range transport latency");

  const tail = await request(main, "getTailTime", { instanceId: created.instanceId }, true, session);
  check(
    tail.tailSamples === 0 && tail.infiniteTail === false,
    "getTailTime reports bounded plugin tail metadata"
  );

  const started = Date.now();
  const oversized = await request(
    main,
    "processAudioBlock",
    { instanceId: created.instanceId, blockId: 1, frames: 1e9, channels: [] },
    true,
    session
  );
  const elapsed = Date.now() - started;
  check(elapsed < 1500, `oversized processAudioBlock returns promptly (${elapsed}ms, no runaway allocation)`);
  check(Array.isArray(oversized.channels) && oversized.channels.length <= 2, "output channel count stays bounded");
  check((oversized.channels[0]?.length ?? 0) <= 128, "output frame count is clamped to maxBlockSize");

  // H. Happy-path gain still works.
  await request(main, "setParameter", { instanceId: created.instanceId, parameterId: "gain", normalizedValue: 0.75 }, true, session);
  const processed = await request(
    main,
    "processAudioBlock",
    {
      instanceId: created.instanceId,
      blockId: 2,
      sampleRate: 48000,
      channels: [new Array(128).fill(0.1), new Array(128).fill(0.1)],
      transport: {
        playing: true,
        loopActive: true,
        tempo: 128,
        timeSignatureNumerator: 7,
        timeSignatureDenominator: 8,
        projectTimeMusic: 16,
        barPositionMusic: 14,
        cycleStartMusic: 12,
        cycleEndMusic: 20,
        samplePosition: 768000
      }
    },
    true,
    session
  );
  check(Math.abs(processed.channels[0][0]) > 0.1, "gain at 0.75 boosts the signal (happy path intact)");
  check(
    processed.transport?.playing === true &&
      processed.transport?.loopActive === true &&
      processed.transport?.tempo === 128 &&
      processed.transport?.timeSignatureDenominator === 8 &&
      processed.transport?.samplePosition === 768000,
    "processAudioBlock accepts and echoes bounded host transport context"
  );

  const badTransportTempo = await request(
    main,
    "processAudioBlock",
    { instanceId: created.instanceId, blockId: 3, sampleRate: 48000, channels: [], transport: { tempo: 5000 } },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(badTransportTempo.code === "invalid_argument", "processAudioBlock rejects out-of-range transport tempo");

  const badTransportSignature = await request(
    main,
    "processAudioBlock",
    {
      instanceId: created.instanceId,
      blockId: 4,
      sampleRate: 48000,
      channels: [],
      transport: { timeSignatureNumerator: 4, timeSignatureDenominator: 3 }
    },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(badTransportSignature.code === "invalid_argument", "processAudioBlock rejects invalid transport time signatures");

  const badTransportCycle = await request(
    main,
    "processAudioBlock",
    {
      instanceId: created.instanceId,
      blockId: 5,
      sampleRate: 48000,
      channels: [],
      transport: { cycleStartMusic: 20, cycleEndMusic: 12 }
    },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(badTransportCycle.code === "invalid_argument", "processAudioBlock rejects invalid transport cycle ranges");

  const badTransportInteger = await request(
    main,
    "processAudioBlock",
    {
      instanceId: created.instanceId,
      blockId: 6,
      sampleRate: 48000,
      channels: [],
      transport: { samplePosition: 1.5 }
    },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(badTransportInteger.code === "invalid_argument", "processAudioBlock rejects non-integer transport sample positions");

  const badInputBusesType = await request(
    main,
    "processAudioBlock",
    { instanceId: created.instanceId, blockId: 7, sampleRate: 48000, inputBuses: {} },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(badInputBusesType.code === "invalid_argument", "processAudioBlock rejects non-array input bus blocks");

  const badInputBusIndex = await request(
    main,
    "processAudioBlock",
    { instanceId: created.instanceId, blockId: 8, sampleRate: 48000, inputBuses: [{ index: 1.5, channels: [[]] }] },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(badInputBusIndex.code === "invalid_argument", "processAudioBlock rejects non-integer input bus indexes");

  const duplicateInputBusIndex = await request(
    main,
    "processAudioBlock",
    {
      instanceId: created.instanceId,
      blockId: 9,
      sampleRate: 48000,
      inputBuses: [
        { index: 0, channels: [[0.1]] },
        { index: 0, channels: [[0.2]] }
      ]
    },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(duplicateInputBusIndex.code === "invalid_argument", "processAudioBlock rejects duplicate input bus indexes");

  const tooManyInputBuses = await request(
    main,
    "processAudioBlock",
    {
      instanceId: created.instanceId,
      blockId: 10,
      sampleRate: 48000,
      inputBuses: Array.from({ length: 33 }, (_, index) => ({ index: index % 32, channels: [[]] }))
    },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(tooManyInputBuses.code === "invalid_argument", "processAudioBlock rejects oversized input bus lists");

  // I. MIDI input is bounded even when the target plugin is not MIDI-capable.
  const tooManyMidiEvents = Array.from({ length: 4097 }, () => ({ type: "noteOn", note: 60, velocity: 0.8 }));
  const midiTooLarge = await request(
    main,
    "sendMidiEvents",
    { instanceId: created.instanceId, events: tooManyMidiEvents },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(midiTooLarge.code === "invalid_argument", "sendMidiEvents rejects oversized MIDI batches");

  const midiBadChannel = await request(
    main,
    "sendMidiEvents",
    { instanceId: created.instanceId, events: [{ type: "noteOn", note: 60, velocity: 0.8, channel: 99 }] },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(midiBadChannel.code === "invalid_argument", "sendMidiEvents rejects out-of-range MIDI fields");

  const midiBadController = await request(
    main,
    "sendMidiEvents",
    { instanceId: created.instanceId, events: [{ type: "controlChange", controller: 999, value: 0.5 }] },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(midiBadController.code === "invalid_argument", "sendMidiEvents rejects out-of-range MIDI CC fields");

  const midiBadBend = await request(
    main,
    "sendMidiEvents",
    { instanceId: created.instanceId, events: [{ type: "pitchBend", value: 2 }] },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(midiBadBend.code === "invalid_argument", "sendMidiEvents rejects out-of-range pitch bend fields");

  // J. Parameter automation input is bounded before it reaches workers.
  const automation = await request(
    main,
    "setParameterEvents",
    {
      instanceId: created.instanceId,
      events: [
        { parameterId: "gain", normalizedValue: 0.25, time: 0 },
        { parameterId: "gain", normalizedValue: 0.5, time: 8 }
      ]
    },
    true,
    session
  );
  check(
    automation.accepted === true &&
      automation.eventCount === 2 &&
      Math.abs(automation.parameters?.[0]?.normalizedValue - 0.5) < 0.000001,
    "setParameterEvents accepts bounded automation and reports final state"
  );

  const curve = await request(
    main,
    "setParameterCurve",
    {
      instanceId: created.instanceId,
      parameterId: "gain",
      interpolation: "linear",
      points: [
        { time: 0, normalizedValue: 0.1 },
        { time: 8, normalizedValue: 0.9 },
        { time: 16, normalizedValue: 0.25 }
      ]
    },
    true,
    session
  );
  check(
    curve.accepted === true &&
      curve.eventCount > 3 &&
      curve.eventCount <= 4096 &&
      Math.abs(curve.parameter?.normalizedValue - 0.25) < 0.000001,
    "setParameterCurve expands bounded linear automation and reports final state"
  );

  const lane = await request(
    main,
    "setAutomationLane",
    {
      instanceId: created.instanceId,
      parameterId: "gain",
      points: [
        { samplePosition: 1024, normalizedValue: 0.2 },
        { samplePosition: 1032, normalizedValue: 0.65 }
      ]
    },
    true,
    session
  );
  check(
    lane.accepted === true &&
      lane.pointCount === 2 &&
      lane.laneCount === 1 &&
      lane.parameterId === "gain",
    "setAutomationLane accepts bounded absolute-sample automation lanes"
  );

  await request(
    main,
    "processAudioBlock",
    {
      instanceId: created.instanceId,
      frames: 16,
      channels: [
        new Array(16).fill(0.1),
        new Array(16).fill(0.1)
      ],
      transport: {
        samplePosition: 1024,
        tempo: 120
      }
    },
    true,
    session
  );
  const laneParameters = await request(main, "getParameters", { instanceId: created.instanceId }, true, session);
  check(
    Math.abs(laneParameters.parameters?.find((parameter) => parameter.id === "gain")?.normalizedValue - 0.65) < 0.000001,
    "processAudioBlock applies stored automation lane points inside the bounded transport block"
  );

  const laneCleared = await request(
    main,
    "clearAutomationLane",
    { instanceId: created.instanceId, parameterId: "gain" },
    true,
    session
  );
  check(laneCleared.cleared === true && laneCleared.laneCount === 0, "clearAutomationLane removes a stored parameter lane");

  const laneReadOnly = await request(
    main,
    "setAutomationLane",
    {
      instanceId: created.instanceId,
      parameterId: "output-level",
      points: [{ samplePosition: 0, normalizedValue: 0.5 }]
    },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(laneReadOnly.code === "parameter_read_only", "setAutomationLane rejects read-only parameters before worker dispatch");

  const tooManyLanePoints = Array.from(
    { length: 4097 },
    (_, index) => ({ samplePosition: index, normalizedValue: 0.5 })
  );
  const laneTooLarge = await request(
    main,
    "setAutomationLane",
    { instanceId: created.instanceId, parameterId: "gain", points: tooManyLanePoints },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(laneTooLarge.code === "invalid_argument", "setAutomationLane rejects oversized timeline point lists");

  const laneDuplicatePosition = await request(
    main,
    "setAutomationLane",
    {
      instanceId: created.instanceId,
      parameterId: "gain",
      points: [
        { samplePosition: 10, normalizedValue: 0.2 },
        { samplePosition: 10, normalizedValue: 0.3 }
      ]
    },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(laneDuplicatePosition.code === "invalid_argument", "setAutomationLane rejects duplicate or unsorted sample positions");

  const automationReadOnly = await request(
    main,
    "setParameterEvents",
    { instanceId: created.instanceId, events: [{ parameterId: "output-level", normalizedValue: 0.5, time: 0 }] },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(automationReadOnly.code === "parameter_read_only", "setParameterEvents rejects read-only parameters before worker dispatch");

  const curveReadOnly = await request(
    main,
    "setParameterCurve",
    {
      instanceId: created.instanceId,
      parameterId: "output-level",
      points: [
        { time: 0, normalizedValue: 0.1 },
        { time: 8, normalizedValue: 0.9 }
      ]
    },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(curveReadOnly.code === "parameter_read_only", "setParameterCurve rejects read-only parameters before worker dispatch");

  const tooManyParameterEvents = Array.from(
    { length: 4097 },
    () => ({ parameterId: "gain", normalizedValue: 0.5, time: 0 })
  );
  const automationTooLarge = await request(
    main,
    "setParameterEvents",
    { instanceId: created.instanceId, events: tooManyParameterEvents },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(automationTooLarge.code === "invalid_argument", "setParameterEvents rejects oversized automation batches");

  const automationBadTime = await request(
    main,
    "setParameterEvents",
    { instanceId: created.instanceId, events: [{ parameterId: "gain", normalizedValue: 0.5, time: 999999 }] },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(automationBadTime.code === "invalid_argument", "setParameterEvents rejects out-of-range event timing");

  const tooManyCurvePoints = Array.from(
    { length: 257 },
    (_, index) => ({ time: index, normalizedValue: 0.5 })
  );
  const curveTooLarge = await request(
    main,
    "setParameterCurve",
    { instanceId: created.instanceId, parameterId: "gain", points: tooManyCurvePoints },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(curveTooLarge.code === "invalid_argument", "setParameterCurve rejects oversized point lists");

  const curveDuplicateTime = await request(
    main,
    "setParameterCurve",
    {
      instanceId: created.instanceId,
      parameterId: "gain",
      points: [
        { time: 4, normalizedValue: 0.2 },
        { time: 4, normalizedValue: 0.8 }
      ]
    },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(curveDuplicateTime.code === "invalid_argument", "setParameterCurve rejects ambiguous duplicate point times");

  const curveUnordered = await request(
    main,
    "setParameterCurve",
    {
      instanceId: created.instanceId,
      parameterId: "gain",
      points: [
        { time: 12, normalizedValue: 0.2 },
        { time: 4, normalizedValue: 0.8 }
      ]
    },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(curveUnordered.code === "invalid_argument", "setParameterCurve rejects out-of-order point times");

  // K. Cross-session instance access is still denied.
  const other = await connect(HOST, PORT, `${HOST}:${PORT}`, ORIGIN);
  const otherPair = await request(other, "pair", { origin: ORIGIN, pairingToken: TOKEN }, false);
  const denied = await request(
    other,
    "setParameter",
    { instanceId: created.instanceId, parameterId: "gain", normalizedValue: 0.2 },
    true,
    otherPair.sessionToken
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(denied.code === "instance_access_denied", "another session cannot control this instance");
  const presetDenied = await request(
    other,
    "setPreset",
    { instanceId: created.instanceId, presetId: "gain-unity" },
    true,
    otherPair.sessionToken
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(presetDenied.code === "instance_access_denied", "another session cannot apply presets to this instance");
  const tailDenied = await request(
    other,
    "getTailTime",
    { instanceId: created.instanceId },
    true,
    otherPair.sessionToken
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(tailDenied.code === "instance_access_denied", "another session cannot read this instance's tail metadata");
  const layoutDenied = await request(
    other,
    "getLayout",
    { instanceId: created.instanceId },
    true,
    otherPair.sessionToken
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(layoutDenied.code === "instance_access_denied", "another session cannot read this instance's layout metadata");
  const automationDenied = await request(
    other,
    "setParameterEvents",
    {
      instanceId: created.instanceId,
      events: [{ parameterId: "gain", normalizedValue: 0.2, time: 0 }]
    },
    true,
    otherPair.sessionToken
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(automationDenied.code === "instance_access_denied", "another session cannot automate this instance's parameters");
  const curveDenied = await request(
    other,
    "setParameterCurve",
    {
      instanceId: created.instanceId,
      parameterId: "gain",
      points: [
        { time: 0, normalizedValue: 0.1 },
        { time: 8, normalizedValue: 0.9 }
      ]
    },
    true,
    otherPair.sessionToken
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(curveDenied.code === "instance_access_denied", "another session cannot curve-automate this instance's parameters");
  const laneDenied = await request(
    other,
    "setAutomationLane",
    {
      instanceId: created.instanceId,
      parameterId: "gain",
      points: [{ samplePosition: 0, normalizedValue: 0.2 }]
    },
    true,
    otherPair.sessionToken
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(laneDenied.code === "instance_access_denied", "another session cannot set this instance's automation lanes");
  const laneClearDenied = await request(
    other,
    "clearAutomationLane",
    { instanceId: created.instanceId, parameterId: "gain" },
    true,
    otherPair.sessionToken
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(laneClearDenied.code === "instance_access_denied", "another session cannot clear this instance's automation lanes");
  const editorOpenDenied = await request(
    other,
    "openEditor",
    { instanceId: created.instanceId },
    true,
    otherPair.sessionToken
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(editorOpenDenied.code === "instance_access_denied", "another session cannot open an editor for this instance");
  const editorCloseDenied = await request(
    other,
    "closeEditor",
    { editorId: editor.editorId },
    true,
    otherPair.sessionToken
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(editorCloseDenied.code === "editor_access_denied", "another session cannot close this editor session");
  const editorClosed = await request(main, "closeEditor", { editorId: editor.editorId }, true, session);
  check(editorClosed.closed === true, "owner session can close its generic editor session");
  other.socket?.destroy();
  main.socket?.destroy();
}

async function pairAttempt(ctx, token) {
  if (ctx.closed) return { closed: true };
  try {
    await request(ctx, "pair", { origin: ORIGIN, pairingToken: token }, false);
    return { ok: true };
  } catch (error) {
    if (error.code === "closed" || error.code === "timeout") return { closed: true };
    return { code: error.code };
  }
}

function publicPluginsArePathFree(plugins) {
  return Array.isArray(plugins) && plugins.length > 0 && plugins.every(publicPluginIsPathFree);
}

function publicPluginIsPathFree(plugin) {
  return plugin && typeof plugin === "object" && !hasPrivatePathFields(plugin);
}

function hasPrivatePathFields(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (["bundlePath", "diagnostics", "executablePath", "nativeHost", "path"].includes(key)) {
      return true;
    }
    if (key === "parameters" && !Array.isArray(child)) {
      continue;
    }
    if (hasPrivatePathFields(child)) {
      return true;
    }
  }
  return false;
}
