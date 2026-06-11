import crypto from "node:crypto";
import net from "node:net";

const HOST = process.env.SOUNDBRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SOUNDBRIDGE_PORT ?? 47370);
const PAIRING_TOKEN = process.env.SOUNDBRIDGE_PAIRING_TOKEN ?? "dev-token";
const ORIGIN = "http://127.0.0.1:5173";
const MAX_PLUGIN_LATENCY_SAMPLES = 1_048_576;

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
const nativeExampleRendererAvailable = hello.capabilities?.nativeExampleRenderer === true;
const exampleFormats = ["vst3", "au", "lv2"];
for (const format of exampleFormats) {
  const formatCapabilities = hello.capabilities?.pluginFormats?.[format];
  assert(formatCapabilities?.scan === true, `hello reports ${format} scanning capability`);
  if (format === "au" || format === "vst3") {
    assert(formatCapabilities?.host === true, `hello reports installed ${format.toUpperCase()} binary hosting`);
  } else {
    assert(formatCapabilities?.host === false, `hello does not overstate installed ${format} binary hosting`);
  }
  assert(
    formatCapabilities?.exampleHost === nativeExampleRendererAvailable,
    `hello reports native ${format} example-host capability accurately`
  );
  if (nativeExampleRendererAvailable) {
    assert(typeof formatCapabilities?.notes === "string" && formatCapabilities.notes.length > 0, `hello reports ${format} native host status notes`);
  }
}
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

const nativeAuEffect = plugins.find((plugin) => plugin.pluginId === "au-reg:appl:aufx:lpas");
assert(nativeAuEffect?.hostable === true, "listPlugins exposes an installed Apple AU effect as hostable");
assert(!("diagnostics" in nativeAuEffect), "hostable AU metadata does not expose scanner diagnostics");
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
const nativeAuLatency = await request(
  socket,
  "getLatency",
  { instanceId: nativeAuInstance.instanceId, transportLatencySamples: 256 },
  true,
  pair.sessionToken
);
assertLatencyReport(nativeAuLatency, 256, "installed AU reports bounded plugin and transport latency");
assert(nativeAuBlock.latencySamples === nativeAuLatency.pluginLatencySamples, "installed AU block latency matches getLatency plugin latency");
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
      { type: "noteOff", note: 64, velocity: 0, channel: 0, time: 64 }
    ]
  },
  true,
  pair.sessionToken
);
assert(
  nativeVst3Midi.accepted === true && nativeVst3Midi.eventCount === 2,
  "installed VST3 host worker accepts bounded MIDI event lists"
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
const nativeVst3Latency = await request(
  socket,
  "getLatency",
  { instanceId: nativeVst3Instance.instanceId, transportLatencySamples: 128 },
  true,
  pair.sessionToken
);
assertLatencyReport(nativeVst3Latency, 128, "installed VST3 reports bounded plugin and transport latency");
assert(nativeVst3Block.latencySamples === nativeVst3Latency.pluginLatencySamples, "installed VST3 block latency matches getLatency plugin latency");
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

function blockHasSignal(channels) {
  return channels.some((channel) => channel.some((sample) => Math.abs(sample) > 0.0001));
}
