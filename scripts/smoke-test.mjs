import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";

const HOST = process.env.SOUNDBRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SOUNDBRIDGE_PORT ?? 47370);
const PAIRING_TOKEN = process.env.SOUNDBRIDGE_PAIRING_TOKEN ?? "dev-token";
const ORIGIN = "http://127.0.0.1:5173";
const NATIVE_RENDERER = process.env.SOUNDBRIDGE_NATIVE_RENDERER ?? "native/bridge-daemon/build-current/soundbridge-daemon";
const LV2_FIXTURE_BUNDLE = "native/example-plugins/LV2/soundbridge-example-gain.lv2";
const MAX_PLUGIN_LATENCY_SAMPLES = 1_048_576;
const MAX_PLUGIN_TAIL_SAMPLES = 1_048_576;
const MAX_AUDIO_CHANNELS = 32;
const MAX_PLUGIN_BUSES = 32;
const MAX_PLUGIN_METADATA_BYTES = 256;

const socket = await connectWebSocket(HOST, PORT);
let requestSeq = 0;

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
await runNativeLv2WorkerSmoke();
const expectedExampleSource = nativeExampleRendererAvailable ? "example-bundle" : "builtin-example";

const { plugins } = await request(socket, "listPlugins", {}, true, pair.sessionToken);
assert(Array.isArray(plugins) && plugins.length >= 3, "listPlugins returned mock and example native-format plugins");
assert(plugins.some((plugin) => plugin.format === "mock"), "listPlugins returned mock plugin format metadata");
for (const scanOnlyPlugin of plugins.filter((plugin) => plugin.source === "scan" && plugin.hostable === false)) {
  assert(scanOnlyPlugin.hostable === false, `${scanOnlyPlugin.pluginId} is marked scan-only/non-hostable`);
  assert(
    typeof scanOnlyPlugin.hostUnavailableReason === "string" && scanOnlyPlugin.hostUnavailableReason.length > 0,
    `${scanOnlyPlugin.pluginId} includes a host-unavailable reason`
  );
  assert(!("executablePath" in scanOnlyPlugin), `${scanOnlyPlugin.pluginId} does not expose an executable path`);
  assert(!("diagnostics" in scanOnlyPlugin), `${scanOnlyPlugin.pluginId} does not expose scanner diagnostics by default`);
}
for (const plugin of plugins) {
  assertPublicPluginMetadata(plugin, `${plugin.pluginId} exposes only path-free public metadata`);
}
assert(
  plugins.some((plugin) => plugin.format === "vst3" && plugin.kind === "instrument" && plugin.source === expectedExampleSource),
  "listPlugins returned VST3 example instrument metadata"
);
assert(
  plugins.some((plugin) => plugin.format === "au" && plugin.kind === "instrument" && plugin.source === expectedExampleSource),
  "listPlugins returned AU example instrument metadata"
);
assert(
  plugins.some((plugin) => plugin.format === "lv2" && plugin.kind === "instrument" && plugin.source === expectedExampleSource),
  "listPlugins returned LV2 example instrument metadata"
);
for (const format of exampleFormats) {
  const instrument = plugins.find((plugin) => plugin.format === format && plugin.kind === "instrument" && plugin.source === expectedExampleSource);
  assert(
    Array.isArray(instrument?.presets) && instrument.presets.length >= 2,
    `listPlugins returned ${format} example instrument presets`
  );
}

const vst3Scan = await request(socket, "scanPlugins", { formats: ["vst3"] }, true, pair.sessionToken);
assert(
  Array.isArray(vst3Scan.plugins) && vst3Scan.plugins.every((plugin) => plugin.format === "vst3"),
  "scanPlugins filters VST3 plugins by format"
);
assert(
  vst3Scan.plugins.some((plugin) => plugin.kind === "instrument" && plugin.source === expectedExampleSource),
  "scanPlugins includes the VST3 example instrument"
);

const lv2Scan = await request(socket, "scanPlugins", { formats: ["lv2"] }, true, pair.sessionToken);
assert(
  Array.isArray(lv2Scan.plugins) && lv2Scan.plugins.every((plugin) => plugin.format === "lv2"),
  "scanPlugins filters LV2 plugins by format"
);
assert(
  lv2Scan.plugins.some((plugin) => plugin.kind === "instrument" && plugin.source === expectedExampleSource),
  "scanPlugins includes the LV2 example instrument"
);

const firstScanOnly = plugins.find((plugin) => plugin.source === "scan" && plugin.hostable === false);
if (firstScanOnly) {
  await request(
    socket,
    "createInstance",
    {
      pluginId: firstScanOnly.pluginId,
      format: firstScanOnly.format,
      sampleRate: 48000,
      maxBlockSize: 128,
      inputChannels: 2,
      outputChannels: 2
    },
    true,
    pair.sessionToken
  ).then(
    () => {
      throw new Error("scan-only plugin unexpectedly created an instance");
    },
    (error) => {
      assert(
        error.message.includes("plugin_not_hostable"),
        "scan-only installed plugins are rejected before instance creation"
      );
    }
  );
}

const nativeLv2Effect = plugins.find((plugin) => plugin.pluginId === "lv2:soundbridge-example-gain.lv2" && plugin.hostable === true);
if (nativeLv2Effect) {
  assert(
    nativeLv2Effect.metadata?.lv2Uri === "urn:soundbridge:example:lv2-gain" &&
      nativeLv2Effect.metadata?.stableId === nativeLv2Effect.metadata.lv2Uri,
    "installed LV2 effect exposes bounded path-free LV2 class metadata"
  );
  const nativeLv2Instance = await request(
    socket,
    "createInstance",
    {
      pluginId: nativeLv2Effect.pluginId,
      format: nativeLv2Effect.format,
      sampleRate: 48000,
      maxBlockSize: 128,
      inputChannels: 2,
      outputChannels: 2
    },
    true,
    pair.sessionToken
  );
  const nativeLv2Gain = nativeLv2Instance.plugin?.parameters?.find((parameter) => parameter.id === "gain");
  assert(nativeLv2Gain?.automatable === true, "installed LV2 effect exposes control ports through the daemon");
  await request(
    socket,
    "setParameter",
    {
      instanceId: nativeLv2Instance.instanceId,
      parameterId: "gain",
      normalizedValue: 0.8
    },
    true,
    pair.sessionToken
  );
  const nativeLv2SavedState = await request(socket, "getState", { instanceId: nativeLv2Instance.instanceId }, true, pair.sessionToken);
  assert(typeof nativeLv2SavedState.state === "string" && nativeLv2SavedState.state.length > 0, "getState returns installed LV2 native control state");
  await request(
    socket,
    "setParameter",
    {
      instanceId: nativeLv2Instance.instanceId,
      parameterId: "gain",
      normalizedValue: 0.2
    },
    true,
    pair.sessionToken
  );
  const nativeLv2Restored = await request(
    socket,
    "setState",
    { instanceId: nativeLv2Instance.instanceId, state: nativeLv2SavedState.state },
    true,
    pair.sessionToken
  );
  const restoredLv2Gain = nativeLv2Restored.parameters?.find((parameter) => parameter.id === "gain");
  assert(
    nativeLv2Restored.restored === true &&
      restoredLv2Gain &&
      Math.abs(restoredLv2Gain.normalizedValue - 0.8) < 0.000001,
    "setState restores installed LV2 native control state"
  );
  await request(
    socket,
    "setParameter",
    {
      instanceId: nativeLv2Instance.instanceId,
      parameterId: "gain",
      normalizedValue: 0.5
    },
    true,
    pair.sessionToken
  );
  const nativeLv2Midi = await request(
    socket,
    "sendMidiEvents",
    {
      instanceId: nativeLv2Instance.instanceId,
      events: [{ type: "controlChange", controller: 7, value: 0.25, channel: 0, time: 0 }]
    },
    true,
    pair.sessionToken
  );
  assert(
    nativeLv2Midi.accepted === true && nativeLv2Midi.eventCount === 1,
    "installed LV2 effect accepts bounded MIDI for atom ports"
  );
  const nativeLv2MidiBlock = await request(
    socket,
    "processAudioBlock",
    {
      instanceId: nativeLv2Instance.instanceId,
      blockId: 12,
      sampleRate: 48000,
      channels: [new Array(4).fill(0.4), new Array(4).fill(0.4)]
    },
    true,
    pair.sessionToken
  );
  assert(nativeLv2MidiBlock.renderEngine === "native-lv2", "installed LV2 effect rendered through the native LV2 host worker");
  assert(
    nativeLv2MidiBlock.channels?.[0]?.[0] > 0.06 && nativeLv2MidiBlock.channels[0][0] < 0.16,
    "installed LV2 effect received atom MIDI CC"
  );
  const nativeLv2ExtensionState = await request(socket, "getState", { instanceId: nativeLv2Instance.instanceId }, true, pair.sessionToken);
  await request(
    socket,
    "sendMidiEvents",
    {
      instanceId: nativeLv2Instance.instanceId,
      events: [{ type: "controlChange", controller: 7, value: 1, channel: 0, time: 0 }]
    },
    true,
    pair.sessionToken
  );
  await request(
    socket,
    "processAudioBlock",
    {
      instanceId: nativeLv2Instance.instanceId,
      blockId: 13,
      sampleRate: 48000,
      channels: [new Array(4).fill(0.4), new Array(4).fill(0.4)]
    },
    true,
    pair.sessionToken
  );
  await request(
    socket,
    "setState",
    { instanceId: nativeLv2Instance.instanceId, state: nativeLv2ExtensionState.state },
    true,
    pair.sessionToken
  );
  const nativeLv2RestoredMidiBlock = await request(
    socket,
    "processAudioBlock",
    {
      instanceId: nativeLv2Instance.instanceId,
      blockId: 14,
      sampleRate: 48000,
      channels: [new Array(4).fill(0.4), new Array(4).fill(0.4)]
    },
    true,
    pair.sessionToken
  );
  assert(
    nativeLv2RestoredMidiBlock.channels?.[0]?.[0] > 0.06 && nativeLv2RestoredMidiBlock.channels[0][0] < 0.16,
    "setState restores installed LV2 file-backed extension state"
  );
  await request(socket, "destroyInstance", { instanceId: nativeLv2Instance.instanceId }, true, pair.sessionToken);
}

const nativeAuEffect = plugins.find((plugin) => plugin.pluginId === "au-reg:appl:aufx:lpas");
assert(nativeAuEffect?.hostable === true, "listPlugins exposes an installed Apple AU effect as hostable");
assert(!("diagnostics" in nativeAuEffect), "hostable AU metadata does not expose scanner diagnostics");
assert(
  nativeAuEffect.metadata?.componentManufacturer === "appl" &&
    nativeAuEffect.metadata?.componentType === "aufx" &&
    nativeAuEffect.metadata?.componentSubType === "lpas" &&
    nativeAuEffect.metadata?.stableId === "appl:aufx:lpas",
  "hostable AU metadata exposes bounded AudioComponent class identifiers"
);
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
    channels: [auInput, auInput]
  },
  true,
  pair.sessionToken
);
assert(nativeAuBlock.renderEngine === "native-au", "installed AU effect rendered through the native AU host worker");
assert(blockHasSignal(nativeAuBlock.channels), "installed AU effect produced processed audio");
assert(nativeAuBlock.channels.length === nativeAuLayout.outputChannels, "installed AU render uses negotiated output channels");
assertOutputBuses(nativeAuBlock, nativeAuLayout, "installed AU render reports bounded output buses");
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

const nativeVst3Effect =
  plugins.find((plugin) => plugin.pluginId === "vst3:Cymatics Deja vu.vst3") ??
  plugins.find((plugin) => plugin.format === "vst3" && plugin.source === "scan" && plugin.hostable === true);
assert(nativeVst3Effect?.hostable === true, "listPlugins exposes an installed VST3 effect as hostable");
assert(!("diagnostics" in nativeVst3Effect), "hostable VST3 metadata does not expose scanner diagnostics");
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
      { type: "noteOn", note: 64, velocity: 0.5, channel: 0, time: 0 },
      { type: "polyPressure", note: 64, pressure: 0.35, channel: 0, time: 12 },
      { type: "controlChange", controller: 1, value: 0.25, channel: 0, time: 16 },
      { type: "pitchBend", value: 0.1, channel: 0, time: 24 },
      { type: "channelPressure", pressure: 0.4, channel: 0, time: 32 },
      { type: "programChange", program: 2, channel: 0, time: 48 },
      { type: "noteOff", note: 64, velocity: 0, channel: 0, time: 64 }
    ]
  },
  true,
  pair.sessionToken
);
assert(
  nativeVst3Midi.accepted === true && nativeVst3Midi.eventCount === 7,
  "installed VST3 host worker accepts richer bounded MIDI event lists"
);
const nativeVst3Block = await request(
  socket,
  "processAudioBlock",
  {
    instanceId: nativeVst3Instance.instanceId,
    blockId: 21,
    sampleRate: 48000,
    channels: [vst3Input, vst3Input]
  },
  true,
  pair.sessionToken
);
assert(nativeVst3Block.renderEngine === "native-vst3", "installed VST3 effect rendered through the native VST3 host worker");
assert(blockHasSignal(nativeVst3Block.channels), "installed VST3 effect produced processed audio");
assert(nativeVst3Block.channels.length === nativeVst3Layout.outputChannels, "installed VST3 render uses negotiated output channels");
assertOutputBuses(nativeVst3Block, nativeVst3Layout, "installed VST3 render reports bounded output buses");
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
    pluginId: plugins.find((plugin) => plugin.pluginId === "mock.gain").pluginId,
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

let instrumentBlockId = 2;
for (const format of exampleFormats) {
  const instrument = plugins.find((plugin) => plugin.format === format && plugin.kind === "instrument");
  assert(instrument, `${format} instrument metadata exists`);
  const instrumentInstance = await request(
    socket,
    "createInstance",
    {
      pluginId: instrument.pluginId,
      format: instrument.format,
      sampleRate: 48000,
      maxBlockSize: 128,
      inputChannels: 0,
      outputChannels: 2
    },
    true,
    pair.sessionToken
  );
  await request(
    socket,
    "sendMidiEvents",
    {
      instanceId: instrumentInstance.instanceId,
      events: [{ type: "noteOn", note: 60, velocity: 0.8 }]
    },
    true,
    pair.sessionToken
  );
  const synthBlock = await request(
    socket,
    "processAudioBlock",
    {
      instanceId: instrumentInstance.instanceId,
      blockId: instrumentBlockId++,
      sampleRate: 48000,
      channels: [new Array(128).fill(0), new Array(128).fill(0)]
    },
    true,
    pair.sessionToken
  );
  assert(blockHasSignal(synthBlock.channels), `${format} instrument produced audio after noteOn`);
  assertOutputBuses(synthBlock, instrumentInstance.layout, `${format} instrument reports bounded output buses`);
  if (nativeExampleRendererAvailable) {
    const expectedRenderEngine = instrument.source === "example-bundle" ? "bundle-worker" : "native-example";
    assert(synthBlock.renderEngine === expectedRenderEngine, `${format} instrument used ${expectedRenderEngine}`);
  }
  const continuedBlock = await request(
    socket,
    "processAudioBlock",
    {
      instanceId: instrumentInstance.instanceId,
      blockId: instrumentBlockId++,
      sampleRate: 48000,
      channels: [new Array(128).fill(0), new Array(128).fill(0)]
    },
    true,
    pair.sessionToken
  );
  assert(blockHasSignal(continuedBlock.channels), `${format} instrument kept producing audio without resending note state`);
  if (synthBlock.renderEngine === "bundle-worker") {
    assert(
      Math.abs(continuedBlock.channels?.[0]?.[0] ?? 0) > 0.0001,
      `${format} bundle worker preserved oscillator phase across render calls`
    );
  }
  await request(
    socket,
    "sendMidiEvents",
    {
      instanceId: instrumentInstance.instanceId,
      events: [{ type: "noteOff", note: 60, velocity: 0 }]
    },
    true,
    pair.sessionToken
  );
  const releasedBlock = await request(
    socket,
    "processAudioBlock",
    {
      instanceId: instrumentInstance.instanceId,
      blockId: instrumentBlockId++,
      sampleRate: 48000,
      channels: [new Array(128).fill(0), new Array(128).fill(0)]
    },
    true,
    pair.sessionToken
  );
  assert(!blockHasSignal(releasedBlock.channels), `${format} instrument stopped producing audio after noteOff`);
  await request(socket, "destroyInstance", { instanceId: instrumentInstance.instanceId }, true, pair.sessionToken);
}
socket.destroy();

console.log("SoundBridge mock protocol smoke test passed.");

async function runNativeLv2WorkerSmoke() {
  const worker = spawn(
    NATIVE_RENDERER,
    ["--host-lv2-worker", LV2_FIXTURE_BUNDLE, "48000", "128", "2", "2", "effect"],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message) {
      console.warn(`LV2 worker stderr: ${message}`);
    }
  });

  const lines = [];
  let buffer = "";
  let waiter;
  worker.stdout.setEncoding("utf8");
  worker.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        lines.push(line);
      }
      if (waiter) {
        const current = waiter;
        waiter = undefined;
        current();
      }
    }
  });

  const readJsonLine = async () => {
    const started = Date.now();
    while (lines.length === 0) {
      if (Date.now() - started > 5000) {
        throw new Error("LV2 worker timed out");
      }
      await new Promise((resolve) => {
        waiter = resolve;
        setTimeout(resolve, 25);
      });
    }
    return JSON.parse(lines.shift());
  };

  const requestWorker = async (command) => {
    worker.stdin.write(`${command}\n`, "utf8");
    const response = await readJsonLine();
    if (response.error) {
      throw new Error(response.error);
    }
    return response;
  };

  try {
    const ready = await readJsonLine();
    assert(ready.ok === true && ready.ready === true, "native LV2 worker reports ready");

    const parameters = await requestWorker("parameters");
    const gain = parameters.parameters?.find((parameter) => parameter.id === "gain");
    assert(gain?.automatable === true, "native LV2 worker exposes control ports as bounded parameters");

    const layout = await requestWorker("layout");
    assertLayoutReport(layout, 2, 2, 48000, 128, "native LV2 worker reports layout");

    const set = await requestWorker("setParameter gain 0.75 0");
    assert(
      set.parameter?.id === "gain" && Math.abs(set.parameter.normalizedValue - 0.75) < 0.000001,
      "native LV2 worker updates a control port"
    );

    const savedState = await requestWorker("getState");
    assert(typeof savedState.state === "string" && savedState.state.length > 0, "native LV2 worker returns bounded control state");
    await requestWorker("setParameter gain 0.1 0");
    await requestWorker(`setState ${savedState.state}`);
    const restoredParameters = await requestWorker("parameters");
    const restoredGain = restoredParameters.parameters?.find((parameter) => parameter.id === "gain");
    assert(
      restoredGain && Math.abs(restoredGain.normalizedValue - 0.75) < 0.000001,
      "native LV2 worker restores bounded control state"
    );

    const rendered = await requestWorker("render 4 48000 0.1,0.2,0.3,0.4|0.1,0.1,0.1,0.1");
    assert(rendered.channels?.length === 2, "native LV2 worker rendered stereo output");
    assert(Math.abs(rendered.channels[0][0] - 0.15) < 0.00001, "native LV2 worker processed audio through the plugin");

    const offsetSet = await requestWorker("setParameter gain 0.25 2");
    assert(
      offsetSet.parameter?.id === "gain" && Math.abs(offsetSet.parameter.normalizedValue - 0.25) < 0.000001,
      "native LV2 worker accepts parameter events with sample offsets"
    );
    const automated = await requestWorker("render 4 48000 0.2,0.2,0.2,0.2|0.2,0.2,0.2,0.2");
    assert(
      Math.abs(automated.channels[0][0] - 0.3) < 0.00001 &&
        Math.abs(automated.channels[0][1] - 0.3) < 0.00001 &&
        Math.abs(automated.channels[0][2] - 0.1) < 0.00001 &&
        Math.abs(automated.channels[0][3] - 0.1) < 0.00001,
      "native LV2 worker applies queued parameter changes at the requested offset"
    );

    const latency = await requestWorker("latency");
    assert(latency.latencySamples === 0, "native LV2 worker reports conservative latency");
    const tail = await requestWorker("tail");
    assert(tail.tailSamples === 0 && tail.infiniteTail === false, "native LV2 worker reports conservative tail time");

    const midi = await requestWorker("midi on:60:0.8:0:0;cc:1:0.5:0:1;bend:0.1:0:2;pressure:0.4:0:3;poly:60:0.2:0:3;program:2:0:3");
    assert(midi.eventCount === 6, "native LV2 worker queues richer bounded MIDI batches");

    await requestWorker("setParameter gain 0.5 0");
    const midiVolume = await requestWorker("midi cc:7:0.25:0:0");
    assert(midiVolume.eventCount === 1, "native LV2 worker queues MIDI for atom ports");
    const midiRendered = await requestWorker("render 4 48000 0.4,0.4,0.4,0.4|0.4,0.4,0.4,0.4");
    assert(
      Math.abs(midiRendered.channels[0][0] - 0.4 * (32 / 127)) < 0.02,
      "native LV2 worker delivers MIDI CC to atom MIDI ports"
    );
    const extensionState = await requestWorker("getState");
    await requestWorker("midi cc:7:1:0:0");
    await requestWorker("render 4 48000 0.4,0.4,0.4,0.4|0.4,0.4,0.4,0.4");
    await requestWorker(`setState ${extensionState.state}`);
    const restoredExtensionState = await requestWorker("render 4 48000 0.4,0.4,0.4,0.4|0.4,0.4,0.4,0.4");
    assert(
      Math.abs(restoredExtensionState.channels[0][0] - 0.4 * (32 / 127)) < 0.02,
      "native LV2 worker restores bounded extension state"
    );

    worker.stdin.write("midi cc:200:0.5:0:0\n", "utf8");
    const invalidMidi = await readJsonLine();
    assert(invalidMidi.error === "invalid_midi_events", "native LV2 worker rejects malformed MIDI batches");
  } finally {
    worker.stdin.write("quit\n");
    worker.stdin.end();
    setTimeout(() => {
      if (!worker.killed) {
        worker.kill();
      }
    }, 250).unref?.();
  }
}

function request(socket, command, payload, includeSession, sessionToken) {
  const id = `smoke-${++requestSeq}`;
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
        reject(new Error(`${message.error?.code}: ${message.error?.message}`));
      }
    };
    const cleanup = () => {
      socket.off("soundbridge-message", onMessage);
      clearTimeout(timeout);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${command}`));
    }, 3000);
    socket.on("soundbridge-message", onMessage);
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertLatencyReport(latency, transportLatencySamples, message) {
  assert(
    Number.isInteger(latency.pluginLatencySamples) &&
      latency.pluginLatencySamples >= 0 &&
      latency.pluginLatencySamples <= MAX_PLUGIN_LATENCY_SAMPLES,
    `${message}: plugin latency is bounded`
  );
  assert(latency.transportLatencySamples === transportLatencySamples, `${message}: transport latency round-trips`);
  assert(
    latency.reportedLatencySamples ===
      Math.min(latency.pluginLatencySamples + transportLatencySamples, MAX_PLUGIN_LATENCY_SAMPLES),
    `${message}: reported latency is the clamped total`
  );
}

function assertTailReport(tail, message) {
  assert(
    Number.isInteger(tail.tailSamples) &&
      tail.tailSamples >= 0 &&
      tail.tailSamples <= MAX_PLUGIN_TAIL_SAMPLES,
    `${message}: tail samples are bounded`
  );
  assert(typeof tail.infiniteTail === "boolean", `${message}: infinite tail is explicit`);
}

function assertLayoutReport(layout, requestedInputChannels, requestedOutputChannels, sampleRate, maxBlockSize, message) {
  assert(layout && typeof layout === "object", `${message}: layout object exists`);
  assert(layout.requestedInputChannels === requestedInputChannels, `${message}: requested input channels round-trip`);
  assert(layout.requestedOutputChannels === requestedOutputChannels, `${message}: requested output channels round-trip`);
  assert(
    Number.isInteger(layout.inputChannels) &&
      layout.inputChannels >= 0 &&
      layout.inputChannels <= MAX_AUDIO_CHANNELS,
    `${message}: input channels are bounded`
  );
  assert(
    Number.isInteger(layout.outputChannels) &&
      layout.outputChannels >= 1 &&
      layout.outputChannels <= MAX_AUDIO_CHANNELS,
    `${message}: output channels are bounded`
  );
  assert(
    Number.isInteger(layout.inputBuses) &&
      layout.inputBuses >= 0 &&
      layout.inputBuses <= MAX_PLUGIN_BUSES,
    `${message}: input bus count is bounded`
  );
  assert(
    Number.isInteger(layout.outputBuses) &&
      layout.outputBuses >= 1 &&
      layout.outputBuses <= MAX_PLUGIN_BUSES,
    `${message}: output bus count is bounded`
  );
  assertBusLayouts(layout.inputBusLayouts, "input", layout.inputBuses, `${message}: input bus layouts`);
  assertBusLayouts(layout.outputBusLayouts, "output", layout.outputBuses, `${message}: output bus layouts`);
  assert(Math.abs(layout.sampleRate - sampleRate) < 0.01, `${message}: sample rate round-trips`);
  assert(layout.maxBlockSize === maxBlockSize, `${message}: max block size round-trips`);
}

function assertBusLayouts(buses, direction, expectedCount, message) {
  assert(Array.isArray(buses), `${message}: bus layout array exists`);
  assert(buses.length === expectedCount, `${message}: bus layout count matches aggregate count`);
  for (const [index, bus] of buses.entries()) {
    assert(bus && typeof bus === "object", `${message}: bus ${index} is an object`);
    assert(Number.isInteger(bus.index) && bus.index >= 0 && bus.index < MAX_PLUGIN_BUSES, `${message}: bus ${index} index is bounded`);
    assert(bus.direction === direction, `${message}: bus ${index} direction matches`);
    assert(bus.mediaType === "audio", `${message}: bus ${index} media type is audio`);
    assert(typeof bus.name === "string" && Buffer.byteLength(bus.name, "utf8") <= 160, `${message}: bus ${index} name is bounded`);
    assert(["main", "aux", "unknown"].includes(bus.type), `${message}: bus ${index} type is bounded`);
    assert(
      Number.isInteger(bus.channels) && bus.channels >= 0 && bus.channels <= MAX_AUDIO_CHANNELS,
      `${message}: bus ${index} channels are bounded`
    );
    assert(typeof bus.active === "boolean", `${message}: bus ${index} active flag is explicit`);
  }
}

function assertOutputBuses(block, layout, message) {
  assert(Array.isArray(block.outputBuses), `${message}: output bus array exists`);
  assert(block.outputBuses.length === layout.outputBuses, `${message}: output bus count matches layout`);
  const mainBus = block.outputBuses.find((bus) => bus.index === 0);
  assert(mainBus, `${message}: main output bus exists`);
  assert(
    JSON.stringify(mainBus.channels) === JSON.stringify(block.channels),
    `${message}: main output bus mirrors legacy channels`
  );
  for (const bus of block.outputBuses) {
    assert(Number.isInteger(bus.index) && bus.index >= 0 && bus.index < MAX_PLUGIN_BUSES, `${message}: output bus index is bounded`);
    assert(Array.isArray(bus.channels), `${message}: output bus channels are arrays`);
    assert(bus.channels.length <= MAX_AUDIO_CHANNELS, `${message}: output bus channel count is bounded`);
    for (const channel of bus.channels) {
      assert(Array.isArray(channel) && channel.length <= 8192, `${message}: output bus frame count is bounded`);
    }
  }
}

function assertPublicPluginMetadata(plugin, message) {
  const metadata = plugin.metadata;
  if (metadata == null) {
    return;
  }
  assert(typeof metadata === "object" && !Array.isArray(metadata), `${message}: metadata object is bounded`);
  for (const forbidden of ["bundlePath", "executablePath", "path", "diagnostics"]) {
    assert(!(forbidden in metadata), `${message}: ${forbidden} is not public metadata`);
  }
  for (const [key, value] of Object.entries(metadata)) {
    assert(
      typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_PLUGIN_METADATA_BYTES,
      `${message}: ${key} is a bounded string`
    );
  }
}

function assertSameLayout(actual, expected, message) {
  for (const key of [
    "requestedInputChannels",
    "requestedOutputChannels",
    "inputChannels",
    "outputChannels",
    "inputBuses",
    "outputBuses",
    "sampleRate",
    "maxBlockSize"
  ]) {
    assert(actual[key] === expected[key], `${message}: ${key} matches`);
  }
  assert(
    JSON.stringify(actual.inputBusLayouts) === JSON.stringify(expected.inputBusLayouts),
    `${message}: inputBusLayouts match`
  );
  assert(
    JSON.stringify(actual.outputBusLayouts) === JSON.stringify(expected.outputBusLayouts),
    `${message}: outputBusLayouts match`
  );
}

function blockHasSignal(channels) {
  return channels.some((channel) => channel.some((sample) => Math.abs(sample) > 0.0001));
}
