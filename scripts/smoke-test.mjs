import { runNativeLv2WorkerSmoke } from "./native-lv2-worker-smoke.mjs";
import { connectWebSocket, createBinaryAudioRequestClient, createRequestClient } from "./smoke-protocol-client.mjs";
import { assertAudioUnitHostProfiles } from "./smoke-test-au-profiles.mjs";
import { runExampleInstrumentSmoke } from "./smoke-test-example-instruments.mjs";
import { runLv2HostingSmoke } from "./smoke-test-lv2-hosting.mjs";
import { runPluginDiscoverySmoke } from "./smoke-test-plugin-discovery.mjs";
import {
  assert,
  assertLatencyReport,
  assertLayoutReport,
  assertOutputBuses,
  assertSameLayout,
  assertTailReport,
  blockHasSignal
} from "./smoke-test-assertions.mjs";

const HOST = process.env.SOUNDBRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SOUNDBRIDGE_PORT ?? 47370);
const PAIRING_TOKEN = process.env.SOUNDBRIDGE_PAIRING_TOKEN ?? "dev-token";
const ORIGIN = "http://127.0.0.1:5173";
const NATIVE_RENDERER = process.env.SOUNDBRIDGE_NATIVE_RENDERER ?? "native/bridge-daemon/build-current/soundbridge-daemon";

const request = createRequestClient();
const requestBinaryAudio = createBinaryAudioRequestClient();
const socket = await connectWebSocket(HOST, PORT, ORIGIN);

const unpairedHello = await request(socket, "hello", {}, false);
assert(unpairedHello.protocolVersion, "unpaired hello returned protocolVersion");
assert(
  Object.keys(unpairedHello.capabilities?.pluginFormats ?? {}).length === 0,
  "unpaired hello does not disclose plugin host adapters"
);

const pair = await request(socket, "pair", { origin: ORIGIN, pairingToken: PAIRING_TOKEN }, false);
assert(pair.sessionToken, "pair returned sessionToken");

const hello = await request(socket, "hello", {}, true, pair.sessionToken);
assert(hello.protocolVersion, "hello returned protocolVersion");
assert(hello.capabilities?.tail === true, "hello advertises tail-time reporting capability after pairing");
assert(hello.capabilities?.layout === true, "hello advertises layout reporting capability after pairing");
assert(hello.capabilities?.automation === true, "hello advertises bounded parameter automation capability after pairing");
assert(
  hello.capabilities?.security?.maxAutomationLanesPerInstance >= 1 &&
    hello.capabilities?.security?.maxAutomationLanePoints >= 1,
  "hello advertises bounded automation lane limits after pairing"
);
const nativeExampleRendererAvailable = hello.capabilities?.nativeExampleRenderer === true;
const exampleFormats = ["vst3", "au", "lv2"];
for (const format of exampleFormats) {
  const formatCapabilities = hello.capabilities?.pluginFormats?.[format];
  assert(formatCapabilities?.scan === true, `hello reports ${format} scanning capability`);
  assert(formatCapabilities?.host === true, `hello reports installed ${format.toUpperCase()} binary hosting`);
  assert(
    formatCapabilities?.exampleHost === nativeExampleRendererAvailable,
    `hello reports native ${format} example-host capability accurately`
  );
  if (nativeExampleRendererAvailable) {
    assert(typeof formatCapabilities?.notes === "string" && formatCapabilities.notes.length > 0, `hello reports ${format} native host status notes`);
  }
}
await runNativeLv2WorkerSmoke({ nativeRenderer: NATIVE_RENDERER, assert, assertLayoutReport });
const expectedExampleSource = nativeExampleRendererAvailable ? "example-bundle" : "builtin-example";

const { plugins, mockPlugin } = await runPluginDiscoverySmoke({
  exampleFormats,
  expectedExampleSource,
  pair,
  request,
  socket
});

await runLv2HostingSmoke({
  assert,
  assertLatencyReport,
  pair,
  plugins,
  request,
  socket
});

const nativeAuEffect = assertAudioUnitHostProfiles({ assert, plugins });
const nativeAuInstance = await request(
  socket,
  "createInstance",
  {
    pluginId: nativeAuEffect.pluginId,
    format: nativeAuEffect.format,
    sampleRate: 48000,
    maxBlockSize: 128,
    inputChannels: 2,
    outputChannels: 2
  },
  true,
  pair.sessionToken
);
assert(
  Array.isArray(nativeAuInstance.plugin?.parameters) && nativeAuInstance.plugin.parameters.length > 0,
  "installed AU createInstance returns native parameter metadata"
);
assertLayoutReport(nativeAuInstance.layout, 2, 2, 48000, 128, "installed AU createInstance returns negotiated layout");
assert(
  nativeAuInstance.plugin.inputs === nativeAuInstance.layout.inputChannels &&
    nativeAuInstance.plugin.outputs === nativeAuInstance.layout.outputChannels,
  "installed AU instance plugin metadata reflects negotiated layout"
);
const nativeAuLayout = await request(socket, "getLayout", { instanceId: nativeAuInstance.instanceId }, true, pair.sessionToken);
assertSameLayout(nativeAuLayout, nativeAuInstance.layout, "installed AU getLayout matches createInstance layout");
const nativeAuParameters = await request(socket, "getParameters", { instanceId: nativeAuInstance.instanceId }, true, pair.sessionToken);
assert(
  Array.isArray(nativeAuParameters.parameters) && nativeAuParameters.parameters.length === nativeAuInstance.plugin.parameters.length,
  "getParameters returns installed AU native parameter metadata"
);
const nativeAuParameter = nativeAuParameters.parameters.find((parameter) => parameter.automatable);
assert(nativeAuParameter, "installed AU exposes at least one automatable parameter");
const nextAuValue = nativeAuParameter.normalizedValue > 0.5 ? 0.25 : 0.75;
const nativeAuSetParameter = await request(
  socket,
  "setParameter",
  {
    instanceId: nativeAuInstance.instanceId,
    parameterId: nativeAuParameter.id,
    normalizedValue: nextAuValue
  },
  true,
  pair.sessionToken
);
assert(
  nativeAuSetParameter.parameter?.id === nativeAuParameter.id &&
    Math.abs(nativeAuSetParameter.parameter.normalizedValue - nextAuValue) < 0.000001,
  "setParameter round-trips through the installed AU host worker"
);
const nativeAuSavedState = await request(socket, "getState", { instanceId: nativeAuInstance.instanceId }, true, pair.sessionToken);
assert(typeof nativeAuSavedState.state === "string" && nativeAuSavedState.state.length > 0, "getState returns installed AU native state");
const changedAuValue = nextAuValue > 0.5 ? 0.25 : 0.75;
await request(
  socket,
  "setParameter",
  {
    instanceId: nativeAuInstance.instanceId,
    parameterId: nativeAuParameter.id,
    normalizedValue: changedAuValue
  },
  true,
  pair.sessionToken
);
const nativeAuRestored = await request(
  socket,
  "setState",
  { instanceId: nativeAuInstance.instanceId, state: nativeAuSavedState.state },
  true,
  pair.sessionToken
);
const restoredAuParameter = nativeAuRestored.parameters?.find((parameter) => parameter.id === nativeAuParameter.id);
assert(
  nativeAuRestored.restored === true &&
    restoredAuParameter &&
    Math.abs(restoredAuParameter.normalizedValue - nextAuValue) < 0.000001,
  "setState restores installed AU native state"
);
const auInput = Array.from({ length: 128 }, (_, index) => Math.sin(index / 8));
const nativeAuBlock = await request(
  socket,
  "processAudioBlock",
  {
    instanceId: nativeAuInstance.instanceId,
    blockId: 20,
    sampleRate: 48000,
    channels: [auInput, auInput],
    transport: {
      playing: true,
      recording: false,
      loopActive: true,
      tempo: 126,
      timeSignatureNumerator: 3,
      timeSignatureDenominator: 4,
      projectTimeMusic: 24.5,
      barPositionMusic: 24,
      cycleStartMusic: 24,
      cycleEndMusic: 32,
      samplePosition: 1152000
    }
  },
  true,
  pair.sessionToken
);
assert(nativeAuBlock.renderEngine === "native-au", "installed AU effect rendered through the native AU host worker");
assert(blockHasSignal(nativeAuBlock.channels), "installed AU effect produced processed audio");
assert(nativeAuBlock.channels.length === nativeAuLayout.outputChannels, "installed AU render uses negotiated output channels");
assertOutputBuses(nativeAuBlock, nativeAuLayout, "installed AU render reports bounded output buses");
assert(
  nativeAuBlock.transport?.playing === true &&
    nativeAuBlock.transport?.loopActive === true &&
    nativeAuBlock.transport?.tempo === 126 &&
    nativeAuBlock.transport?.samplePosition === 1152000,
  "installed AU render accepts bounded host transport callbacks"
);
const nativeAuLatency = await request(
  socket,
  "getLatency",
  { instanceId: nativeAuInstance.instanceId, transportLatencySamples: 256 },
  true,
  pair.sessionToken
);
assertLatencyReport(nativeAuLatency, 256, "installed AU reports bounded plugin and transport latency");
assert(nativeAuBlock.latencySamples === nativeAuLatency.pluginLatencySamples, "installed AU block latency matches getLatency plugin latency");
const nativeAuTail = await request(socket, "getTailTime", { instanceId: nativeAuInstance.instanceId }, true, pair.sessionToken);
assertTailReport(nativeAuTail, "installed AU reports bounded tail time");
assert(nativeAuInstance.tailSamples === nativeAuTail.tailSamples, "installed AU createInstance tail matches getTailTime");
assert(nativeAuBlock.tailSamples === nativeAuTail.tailSamples, "installed AU block tail matches getTailTime");
await request(socket, "destroyInstance", { instanceId: nativeAuInstance.instanceId }, true, pair.sessionToken);

const nativeVst3Effect = plugins.find((plugin) =>
  plugin.format === "vst3" && plugin.source === "scan" && plugin.hostable === true
);
assert(nativeVst3Effect?.hostable === true, "listPlugins exposes an installed VST3 effect as hostable");
assert(!("diagnostics" in nativeVst3Effect), "hostable VST3 metadata does not expose scanner diagnostics");
assert(typeof nativeVst3Effect.kind === "string" && nativeVst3Effect.kind.length > 0, "listPlugins exposes VST3 kind metadata");
assert(typeof nativeVst3Effect.category === "string" && nativeVst3Effect.category.length > 0, "listPlugins exposes VST3 category metadata");
const nativeVst3Instance = await request(
  socket,
  "createInstance",
  {
    pluginId: nativeVst3Effect.pluginId,
    format: nativeVst3Effect.format,
    sampleRate: 48000,
    maxBlockSize: 128,
    inputChannels: 2,
    outputChannels: 2
  },
  true,
  pair.sessionToken
);
assertLayoutReport(nativeVst3Instance.layout, 2, 2, 48000, 128, "installed VST3 createInstance returns negotiated layout");
assert(
  nativeVst3Instance.plugin.inputs === nativeVst3Instance.layout.inputChannels &&
    nativeVst3Instance.plugin.outputs === nativeVst3Instance.layout.outputChannels,
  "installed VST3 instance plugin metadata reflects negotiated layout"
);
const nativeVst3Layout = await request(socket, "getLayout", { instanceId: nativeVst3Instance.instanceId }, true, pair.sessionToken);
assertSameLayout(nativeVst3Layout, nativeVst3Instance.layout, "installed VST3 getLayout matches createInstance layout");
const nativeVst3Parameters = await request(socket, "getParameters", { instanceId: nativeVst3Instance.instanceId }, true, pair.sessionToken);
assert(
  Array.isArray(nativeVst3Parameters.parameters),
  "getParameters returns a bounded installed VST3 parameter array"
);
const nativeVst3ProgramDataList = nativeVst3Instance.plugin.vst3ProgramLists?.find(
  (programList) => programList.programDataSupported === true && programList.programs?.length > 0
);
if (nativeVst3ProgramDataList) {
  const nativeVst3ProgramData = await request(
    socket,
    "getVst3ProgramData",
    {
      instanceId: nativeVst3Instance.instanceId,
      programListId: nativeVst3ProgramDataList.id,
      programIndex: nativeVst3ProgramDataList.programs[0].index
    },
    true,
    pair.sessionToken
  );
  assert(
    nativeVst3ProgramData.format === "vst3" &&
      nativeVst3ProgramData.programListId === nativeVst3ProgramDataList.id &&
      nativeVst3ProgramData.programIndex === nativeVst3ProgramDataList.programs[0].index &&
      Number.isInteger(nativeVst3ProgramData.size) &&
      nativeVst3ProgramData.size <= 384 * 1024 &&
      typeof nativeVst3ProgramData.data === "string" &&
      typeof nativeVst3ProgramData.programData === "string",
    "getVst3ProgramData returns bounded installed VST3 program data when supported"
  );
  const nativeVst3ProgramDataRestore = await request(
    socket,
    "setVst3ProgramData",
    {
      instanceId: nativeVst3Instance.instanceId,
      programData: nativeVst3ProgramData.programData
    },
    true,
    pair.sessionToken
  );
  assert(
    nativeVst3ProgramDataRestore.restored === true &&
      nativeVst3ProgramDataRestore.programListId === nativeVst3ProgramDataList.id &&
      nativeVst3ProgramDataRestore.programIndex === nativeVst3ProgramDataList.programs[0].index,
    "setVst3ProgramData restores bounded installed VST3 program data when supported"
  );
}
const nativeVst3Parameter = nativeVst3Parameters.parameters.find((parameter) => parameter.automatable);
if (nativeVst3Parameter) {
  const nextVst3Value = nativeVst3Parameter.normalizedValue > 0.5 ? 0.25 : 0.75;
  const nativeVst3SetParameter = await request(
    socket,
    "setParameter",
    {
      instanceId: nativeVst3Instance.instanceId,
      parameterId: nativeVst3Parameter.id,
      normalizedValue: nextVst3Value
    },
    true,
    pair.sessionToken
  );
  assert(
    nativeVst3SetParameter.parameter?.id === nativeVst3Parameter.id &&
      Math.abs(nativeVst3SetParameter.parameter.normalizedValue - nextVst3Value) < 0.000001,
    "setParameter round-trips through an installed VST3 host worker parameter when exposed"
  );
  const nativeVst3SavedState = await request(socket, "getState", { instanceId: nativeVst3Instance.instanceId }, true, pair.sessionToken);
  assert(typeof nativeVst3SavedState.state === "string" && nativeVst3SavedState.state.length > 0, "getState returns installed VST3 native state");
  const changedVst3Value = nextVst3Value > 0.5 ? 0.25 : 0.75;
  await request(
    socket,
    "setParameter",
    {
      instanceId: nativeVst3Instance.instanceId,
      parameterId: nativeVst3Parameter.id,
      normalizedValue: changedVst3Value
    },
    true,
    pair.sessionToken
  );
  const nativeVst3Restored = await request(
    socket,
    "setState",
    { instanceId: nativeVst3Instance.instanceId, state: nativeVst3SavedState.state },
    true,
    pair.sessionToken
  );
  const restoredVst3Parameter = nativeVst3Restored.parameters?.find((parameter) => parameter.id === nativeVst3Parameter.id);
  assert(
    nativeVst3Restored.restored === true &&
      restoredVst3Parameter &&
      Math.abs(restoredVst3Parameter.normalizedValue - nextVst3Value) < 0.000001,
    "setState restores installed VST3 native state"
  );
}
const vst3Input = Array.from({ length: 128 }, (_, index) => Math.sin(index / 8));
const nativeVst3Midi = await request(
  socket,
  "sendMidiEvents",
  {
    instanceId: nativeVst3Instance.instanceId,
    events: [
      { type: "noteOn", note: 64, velocity: 0.5, channel: 0, time: 0, noteId: 42 },
      { type: "polyPressure", note: 64, pressure: 0.35, channel: 0, time: 12, noteId: 42 },
      { type: "noteExpression", typeId: 0, value: 0.5, noteId: 42, channel: 0, time: 14 },
      { type: "noteExpressionText", typeId: 6, text: "ah", noteId: 42, channel: 0, time: 15 },
      { type: "controlChange", controller: 1, value: 0.25, channel: 0, time: 16 },
      { type: "pitchBend", value: 0.1, channel: 0, time: 24 },
      { type: "channelPressure", pressure: 0.4, channel: 0, time: 32 },
      { type: "programChange", program: 2, channel: 0, time: 48 },
      { type: "noteOff", note: 64, velocity: 0, channel: 0, time: 64, noteId: 42 }
    ]
  },
  true,
  pair.sessionToken
);
assert(
  nativeVst3Midi.accepted === true && nativeVst3Midi.eventCount === 9,
  "installed VST3 host worker accepts bounded note-expression value/text event lists"
);
const nativeVst3Block = await request(
  socket,
  "processAudioBlock",
  {
    instanceId: nativeVst3Instance.instanceId,
    blockId: 21,
    sampleRate: 48000,
    channels: [vst3Input, vst3Input],
    transport: {
      playing: true,
      tempo: 124,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      projectTimeMusic: 32,
      barPositionMusic: 32,
      samplePosition: 1536000
    }
  },
  true,
  pair.sessionToken
);
assert(nativeVst3Block.renderEngine === "native-vst3", "installed VST3 effect rendered through the native VST3 host worker");
assert(blockHasSignal(nativeVst3Block.channels), "installed VST3 effect produced processed audio");
assert(nativeVst3Block.channels.length === nativeVst3Layout.outputChannels, "installed VST3 render uses negotiated output channels");
assertOutputBuses(nativeVst3Block, nativeVst3Layout, "installed VST3 render reports bounded output buses");
assert(
  nativeVst3Block.transport?.playing === true &&
    nativeVst3Block.transport?.tempo === 124 &&
    nativeVst3Block.transport?.samplePosition === 1536000,
  "installed VST3 render accepts bounded host transport context"
);
const nativeVst3Latency = await request(
  socket,
  "getLatency",
  { instanceId: nativeVst3Instance.instanceId, transportLatencySamples: 128 },
  true,
  pair.sessionToken
);
assertLatencyReport(nativeVst3Latency, 128, "installed VST3 reports bounded plugin and transport latency");
assert(nativeVst3Block.latencySamples === nativeVst3Latency.pluginLatencySamples, "installed VST3 block latency matches getLatency plugin latency");
const nativeVst3Tail = await request(socket, "getTailTime", { instanceId: nativeVst3Instance.instanceId }, true, pair.sessionToken);
assertTailReport(nativeVst3Tail, "installed VST3 reports bounded tail time");
assert(nativeVst3Instance.tailSamples === nativeVst3Tail.tailSamples, "installed VST3 createInstance tail matches getTailTime");
assert(nativeVst3Block.tailSamples === nativeVst3Tail.tailSamples, "installed VST3 block tail matches getTailTime");
await request(socket, "destroyInstance", { instanceId: nativeVst3Instance.instanceId }, true, pair.sessionToken);

const created = await request(
  socket,
  "createInstance",
  {
    pluginId: mockPlugin.pluginId,
    sampleRate: 48000,
    maxBlockSize: 128,
    inputChannels: 2,
    outputChannels: 2
  },
  true,
  pair.sessionToken
);
assert(created.instanceId, "createInstance returned instanceId");
assertLayoutReport(created.layout, 2, 2, 48000, 128, "mock createInstance returns negotiated layout");
const mockLayout = await request(socket, "getLayout", { instanceId: created.instanceId }, true, pair.sessionToken);
assertSameLayout(mockLayout, created.layout, "mock getLayout matches createInstance layout");

const mockPreset = await request(
  socket,
  "setPreset",
  {
    instanceId: created.instanceId,
    presetId: "gain-bright"
  },
  true,
  pair.sessionToken
);
assert(
  mockPreset.applied === true &&
    mockPreset.parameterCount === 2 &&
    Math.abs(mockPreset.parameters.find((parameter) => parameter.id === "gain")?.normalizedValue - 0.75) < 0.000001 &&
    Math.abs(mockPreset.parameters.find((parameter) => parameter.id === "program")?.normalizedValue - 2 / 3) < 0.000001 &&
    mockPreset.parameters.find((parameter) => parameter.id === "gain")?.displayValue?.includes("dB") &&
    mockPreset.parameters.find((parameter) => parameter.id === "program")?.displayValue === "Bright" &&
    !mockPreset.parameters.some((parameter) => parameter.id === "output-level"),
  "mock setPreset applies writable entries with bounded display values from a listed preset snapshot"
);

const binaryBlock = await requestBinaryAudio(
  socket,
  "processAudioBlock",
  {
    instanceId: created.instanceId,
    blockId: 63,
    sampleRate: 48000,
    channels: [
      Float32Array.from([0.5, 0.25, -0.25, -0.5]),
      Float32Array.from([0.1, -0.1, 0.2, -0.2])
    ],
    transport: { playing: true, samplePosition: 8064 }
  },
  true,
  pair.sessionToken
);
assert(binaryBlock.blockId === 63, "binary processAudioBlock preserves block id");
assert(blockHasSignal(binaryBlock.channels), "binary processAudioBlock returns processed Float32 audio");
assert(binaryBlock.channels.length === created.layout.outputChannels, "binary processAudioBlock returns negotiated output channels");
assert(binaryBlock.transport?.samplePosition === 8064, "binary processAudioBlock preserves bounded host transport");
assert(!("outputBuses" in binaryBlock), "binary processAudioBlock keeps bus audio out of JSON response metadata");

const automated = await request(
  socket,
  "setParameterEvents",
  {
    instanceId: created.instanceId,
    events: [
      { parameterId: "gain", normalizedValue: 0.25, time: 0 },
      { parameterId: "gain", normalizedValue: 0.75, time: 32 }
    ]
  },
  true,
  pair.sessionToken
);
assert(
  automated.accepted === true &&
    automated.eventCount === 2 &&
    Math.abs(automated.parameters?.[0]?.normalizedValue - 0.75) < 0.000001,
  "mock setParameterEvents accepts bounded parameter automation and reports final state"
);

const lane = await request(
  socket,
  "setAutomationLane",
  {
    instanceId: created.instanceId,
    parameterId: "gain",
    points: [
      { samplePosition: 2048, normalizedValue: 0.2 },
      { samplePosition: 2056, normalizedValue: 0.6 }
    ]
  },
  true,
  pair.sessionToken
);
assert(
  lane.accepted === true && lane.pointCount === 2 && lane.laneCount === 1,
  "mock setAutomationLane stores bounded timeline automation"
);

await request(
  socket,
  "processAudioBlock",
  {
    instanceId: created.instanceId,
    frames: 16,
    channels: [
      new Array(16).fill(0.25),
      new Array(16).fill(0.25)
    ],
    transport: { samplePosition: 2048 }
  },
  true,
  pair.sessionToken
);
const laneParameters = await request(socket, "getParameters", { instanceId: created.instanceId }, true, pair.sessionToken);
assert(
  Math.abs(laneParameters.parameters?.find((parameter) => parameter.id === "gain")?.normalizedValue - 0.6) < 0.000001,
  "mock processAudioBlock applies stored automation lanes from transport sample position"
);

const laneClear = await request(
  socket,
  "clearAutomationLane",
  { instanceId: created.instanceId, parameterId: "gain" },
  true,
  pair.sessionToken
);
assert(laneClear.cleared === true && laneClear.laneCount === 0, "mock clearAutomationLane clears stored timeline automation");

const noOriginSocket = await connectWebSocket(HOST, PORT, null);
await request(noOriginSocket, "pair", { origin: ORIGIN, pairingToken: PAIRING_TOKEN }, false).then(
  () => {
    throw new Error("pairing unexpectedly worked without a WebSocket Origin header");
  },
  (error) => {
    assert(error.message.includes("origin_required"), "pairing requires a WebSocket Origin header");
  }
);
noOriginSocket.destroy();

const secondSocket = await connectWebSocket(HOST, PORT, ORIGIN);
await request(secondSocket, "listPlugins", {}, true, pair.sessionToken).then(
  () => {
    throw new Error("session token unexpectedly worked from a second WebSocket");
  },
  (error) => {
    assert(
      error.message.includes("session_connection_mismatch"),
      "session tokens are bound to the WebSocket that paired them"
    );
  }
);
const secondPair = await request(secondSocket, "pair", { origin: ORIGIN, pairingToken: PAIRING_TOKEN }, false);
await request(
  secondSocket,
  "setParameter",
  {
    instanceId: created.instanceId,
    parameterId: "gain",
    normalizedValue: 0.1
  },
  true,
  secondPair.sessionToken
).then(
  () => {
    throw new Error("second session unexpectedly controlled another session's instance");
  },
  (error) => {
    assert(
      error.message.includes("instance_access_denied"),
      "plugin instances are owned by the session that created them"
    );
  }
);
secondSocket.destroy();

await request(
  socket,
  "setParameter",
  {
    instanceId: created.instanceId,
    parameterId: "gain",
    normalizedValue: 0.75
  },
  true,
  pair.sessionToken
);

const processed = await request(
  socket,
  "processAudioBlock",
  {
    instanceId: created.instanceId,
    blockId: 1,
    sampleRate: 48000,
    channels: [
      [0, 0.25, -0.25, 0.5],
      [0, 0.25, -0.25, 0.5]
    ]
  },
  true,
  pair.sessionToken
);
assert(processed.channels[0][1] > 0.25, "processAudioBlock applied gain");
assert(processed.channels.length === mockLayout.outputChannels, "mock render uses negotiated output channels");
assertOutputBuses(processed, mockLayout, "mock render reports bounded output buses");

const busProcessed = await request(
  socket,
  "processAudioBlock",
  {
    instanceId: created.instanceId,
    blockId: 8,
    sampleRate: 48000,
    inputBuses: [
      {
        index: 0,
        channels: [
          [0.1, 0.1, 0.1, 0.1],
          [0.1, 0.1, 0.1, 0.1]
        ]
      },
      {
        index: 1,
        channels: [[0.5, 0.5, 0.5, 0.5]]
      }
    ]
  },
  true,
  pair.sessionToken
);
assert(busProcessed.channels.length === mockLayout.outputChannels, "processAudioBlock accepts explicit input bus buffers");
assertOutputBuses(busProcessed, mockLayout, "bus-aware mock render reports bounded output buses");

const state = await request(socket, "getState", { instanceId: created.instanceId }, true, pair.sessionToken);
assert(typeof state.state === "string" && state.state.length > 0, "getState returned opaque state");

const restored = await request(
  socket,
  "setState",
  { instanceId: created.instanceId, state: state.state },
  true,
  pair.sessionToken
);
assert(restored.restored === true, "setState restored state");

const latency = await request(socket, "getLatency", { instanceId: created.instanceId, transportLatencySamples: 64 }, true, pair.sessionToken);
assertLatencyReport(latency, 64, "getLatency returns bounded mock plugin and transport latency");
assert(processed.latencySamples === latency.pluginLatencySamples, "mock block latency matches getLatency plugin latency");
const tail = await request(socket, "getTailTime", { instanceId: created.instanceId }, true, pair.sessionToken);
assertTailReport(tail, "getTailTime returns bounded mock tail time");
assert(created.tailSamples === tail.tailSamples, "mock createInstance tail matches getTailTime");
assert(processed.tailSamples === tail.tailSamples, "mock block tail matches getTailTime");

await request(socket, "destroyInstance", { instanceId: created.instanceId }, true, pair.sessionToken);

await runExampleInstrumentSmoke({
  exampleFormats,
  nativeExampleRendererAvailable,
  pair,
  plugins,
  request,
  socket
});
socket.destroy();

console.log("SoundBridge mock protocol smoke test passed.");
