// Focused security regression test for the hardened mock daemon.
// Exercises only the mock.gain path so it runs without a native build.
import { spawn } from "node:child_process";
import {
  connect,
  createRequestClient,
  rawHandshake,
  rawHttpRequest
} from "./security-smoke-client.mjs";
import { reservePort } from "./installed-plugin-probe-transport.mjs";
import { createSecurityDaemonCases, waitForListen } from "./security-smoke-daemon-cases.mjs";
import { createSecurityEditorCases } from "./security-smoke-editor-cases.mjs";
import { createSecurityFileGrantCases } from "./security-smoke-file-grant-cases.mjs";
import { createSecurityInstanceCases } from "./security-smoke-instance-cases.mjs";
import { createSecurityMidiCases } from "./security-smoke-midi-cases.mjs";
import { createSecurityPairingCases } from "./security-smoke-pairing-cases.mjs";
import { createSecuritySessionCases } from "./security-smoke-session-cases.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SOUNDBRIDGE_PORT ?? await reservePort(HOST));
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
const editorCases = createSecurityEditorCases({ check, request });
const fileGrantCases = createSecurityFileGrantCases({
  check,
  host: HOST,
  origin: ORIGIN,
  request,
  token: TOKEN
});
const instanceCases = createSecurityInstanceCases({ check, request });
const midiCases = createSecurityMidiCases({ check, request });
const pairingCases = createSecurityPairingCases({
  check,
  connect,
  disallowedOrigin: DISALLOWED_ORIGIN,
  host: HOST,
  origin: ORIGIN,
  port: PORT,
  request,
  token: TOKEN
});
const sessionCases = createSecuritySessionCases({
  check,
  connect,
  host: HOST,
  origin: ORIGIN,
  port: PORT,
  request
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

  // A3. Malformed envelopes and oversized frames must fail before command dispatch.
  await daemonCases.checkRequestEnvelopeValidation();
  await daemonCases.checkPrePairingMessageSizeCap();

  // A4. Disconnecting a browser session must destroy session-owned instances.
  await daemonCases.checkDisconnectCleansUpInstances();

  // B. Loopback Host header upgrades normally.
  const main = await connect(HOST, PORT, `${HOST}:${PORT}`, ORIGIN);
  check(Boolean(main.socket), "WS upgrade with loopback Host header succeeds");

  // C. Unpaired hello stays minimal.
  await sessionCases.checkUnpairedSurface(main);

  // D. Wrong pairing token is rejected, and the connection locks out after the limit.
  await pairingCases.checkPairingBoundaries();

  // E. Correct token pairs.
  const paired = await request(main, "pair", { origin: ORIGIN, pairingToken: TOKEN }, false);
  check(typeof paired.sessionToken === "string" && paired.sessionToken.length > 0, "correct token pairs and returns a session token");
  const session = paired.sessionToken;
  const pairedHello = await request(main, "hello", {}, true, session);
  sessionCases.checkPairedHelloCapabilities(pairedHello);
  await fileGrantCases.checkDefaultFileBrokerClosed(main, session);
  await fileGrantCases.checkConfiguredFileBroker();
  await sessionCases.checkPublicPluginMetadata(main, session);
  await sessionCases.checkSessionReplay(session);

  // F. Instance setup, metadata, parameters, presets, and state stay bounded.
  const created = await instanceCases.checkInstanceSetupAndState({ main, session });

  const layout = await request(main, "getLayout", { instanceId: created.instanceId }, true, session);
  check(
    layout.inputChannels === created.layout.inputChannels &&
      layout.outputChannels === created.layout.outputChannels &&
      layout.maxBlockSize === 128,
    "getLayout returns session-owned negotiated layout"
  );

  const editor = await editorCases.checkOpenEditor({ main, session, created });

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
  await midiCases.checkMidiValidation(main, session, created.instanceId);

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
  await editorCases.checkEditorOwnership({
    main,
    other,
    session,
    otherSessionToken: otherPair.sessionToken,
    created,
    editor
  });
  other.socket?.destroy();
  main.socket?.destroy();
}
