import {
  SoundBridgeAudioNode,
  SoundBridgeClient,
  renderParameterControls
} from "/packages/web-client/dist/soundbridge-client.js";

const elements = {
  daemonUrl: document.querySelector("#daemonUrl"),
  pairingToken: document.querySelector("#pairingToken"),
  connectButton: document.querySelector("#connectButton"),
  createInstanceButton: document.querySelector("#createInstanceButton"),
  pluginSelect: document.querySelector("#pluginSelect"),
  pluginStatus: document.querySelector("#pluginStatus"),
  presetSelect: document.querySelector("#presetSelect"),
  applyPresetButton: document.querySelector("#applyPresetButton"),
  fileInput: document.querySelector("#fileInput"),
  micButton: document.querySelector("#micButton"),
  stopButton: document.querySelector("#stopButton"),
  keyboard: document.querySelector("#keyboard"),
  saveStateButton: document.querySelector("#saveStateButton"),
  restoreStateButton: document.querySelector("#restoreStateButton"),
  latencyButton: document.querySelector("#latencyButton"),
  parameterControls: document.querySelector("#parameterControls"),
  stateText: document.querySelector("#stateText"),
  connectionStatus: document.querySelector("#connectionStatus"),
  capabilityStatus: document.querySelector("#capabilityStatus"),
  engineStatus: document.querySelector("#engineStatus"),
  latencyStatus: document.querySelector("#latencyStatus"),
  sourceLabel: document.querySelector("#sourceLabel"),
  processedBlocks: document.querySelector("#processedBlocks"),
  underruns: document.querySelector("#underruns"),
  queuedBlocks: document.querySelector("#queuedBlocks"),
  renderEngine: document.querySelector("#renderEngine"),
  log: document.querySelector("#log"),
  scope: document.querySelector("#scope")
};

let client;
let audioContext;
let bridge;
let analyser;
let currentSource;
let currentStream;
let animationFrame = 0;
let selectedInstanceId;
let activePluginId;
let bridgeStartupPromise;
let controlsEnabled = false;
const pluginMetadataById = new Map();
const activeNotes = new Set();
const keyToNote = new Map();

setControlsEnabled(false);
drawIdleScope();

elements.connectButton.addEventListener("click", () => {
  void connectToDaemon();
});

elements.createInstanceButton.addEventListener("click", () => {
  log("Creating plugin instance...");
  if (!window.AudioContext && !window.webkitAudioContext) {
    logError(new Error("This browser does not expose AudioContext."));
    return;
  }
  void withTimeout(
    ensureBridgeInstance(Boolean(bridge && activePluginId !== elements.pluginSelect.value)),
    4000,
    "Audio engine startup timed out. Try Chrome, Safari, or Firefox with AudioWorklet enabled."
  ).catch(logError);
});

elements.pluginSelect.addEventListener("change", () => {
  updatePluginStatus();
  updatePresetControls();
  if (bridge) {
    void ensureBridgeInstance(true).catch(logError);
  }
});

elements.applyPresetButton.addEventListener("click", () => {
  void applySelectedPreset();
});

elements.fileInput.addEventListener("change", () => {
  const file = elements.fileInput.files?.[0];
  if (file) {
    void useAudioFile(file);
  }
});

elements.micButton.addEventListener("click", () => {
  void useMicrophone();
});

elements.stopButton.addEventListener("click", () => {
  stopSource();
});

elements.saveStateButton.addEventListener("click", () => {
  void saveState();
});

elements.restoreStateButton.addEventListener("click", () => {
  void restoreState();
});

elements.latencyButton.addEventListener("click", () => {
  void refreshLatency();
});

for (const button of elements.keyboard.querySelectorAll(".piano-key")) {
  const note = Number(button.dataset.note);
  const key = button.dataset.key;
  if (key) {
    keyToNote.set(key, note);
  }

  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture?.(event.pointerId);
    void noteOn(note, button);
  });
  button.addEventListener("pointerup", (event) => {
    event.preventDefault();
    void noteOff(note, button);
  });
  button.addEventListener("pointercancel", () => {
    void noteOff(note, button);
  });
  button.addEventListener("lostpointercapture", () => {
    void noteOff(note, button);
  });
}

window.addEventListener("keydown", (event) => {
  const note = keyToNote.get(event.key.toLowerCase());
  if (note === undefined || event.repeat) {
    return;
  }
  event.preventDefault();
  void noteOn(note, findKeyButton(note));
});

window.addEventListener("keyup", (event) => {
  const note = keyToNote.get(event.key.toLowerCase());
  if (note === undefined) {
    return;
  }
  event.preventDefault();
  void noteOff(note, findKeyButton(note));
});

async function connectToDaemon() {
  try {
    elements.connectButton.disabled = true;
    setStatus(elements.connectionStatus, "Connecting", "warn");

    client = new SoundBridgeClient({
      url: elements.daemonUrl.value.trim(),
      origin: window.location.origin
    });
    await client.connect();
    const pairingToken = elements.pairingToken.value.trim();
    if (!pairingToken) {
      throw new Error("Paste the pairing token printed by npm run bridge.");
    }
    await client.pair(pairingToken);
    const hello = await client.hello();
    setCapabilityStatus(hello?.capabilities);
    const { plugins } = await client.scanPlugins();
    renderPluginOptions(plugins);

    setControlsEnabled(true);
    setStatus(elements.connectionStatus, "Paired", "ready");
    log(`Connected to ${elements.daemonUrl.value.trim()}`);
  } catch (error) {
    setStatus(elements.connectionStatus, "Offline", "");
    logError(error);
  } finally {
    elements.connectButton.disabled = false;
  }
}

async function ensureBridgeInstance(recreate = false) {
  if (bridgeStartupPromise) {
    return bridgeStartupPromise;
  }

  bridgeStartupPromise = doEnsureBridgeInstance(recreate).finally(() => {
    bridgeStartupPromise = undefined;
  });
  return bridgeStartupPromise;
}

async function doEnsureBridgeInstance(recreate = false) {
  if (!client) {
    throw new Error("Connect to the daemon first.");
  }

  if (bridge && !recreate) {
    return bridge;
  }

  if (bridge) {
    await allNotesOff();
    await bridge.destroy();
    bridge = undefined;
    selectedInstanceId = undefined;
    activePluginId = undefined;
  }

  const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error("This browser does not expose AudioContext.");
  }

  audioContext ??= new AudioContextConstructor({ latencyHint: "interactive" });
  await audioContext.resume();

  if (!audioContext.audioWorklet) {
    throw new Error("This browser does not expose AudioWorklet.");
  }

  const pluginId = elements.pluginSelect.value;
  const option = elements.pluginSelect.selectedOptions[0];
  const pluginKind = option?.dataset.kind ?? "effect";
  const pluginFormat = option?.dataset.format ?? "unknown";
  const created = await client.createInstance({
    pluginId,
    format: pluginFormat,
    sampleRate: audioContext.sampleRate,
    maxBlockSize: 128,
    inputChannels: pluginKind === "instrument" ? 0 : 2,
    outputChannels: 2
  });
  const { instanceId } = created;
  const inputChannels = created.layout?.inputChannels ?? (pluginKind === "instrument" ? 0 : 2);
  const outputChannels = created.layout?.outputChannels ?? 2;

  selectedInstanceId = instanceId;
  activePluginId = pluginId;
  elements.renderEngine.textContent = "Waiting";
  bridge = await SoundBridgeAudioNode.create(audioContext, client, {
    instanceId,
    inputChannels,
    outputChannels,
    maxInFlightBlocks: 8,
    workletUrl: "/packages/web-client/dist/soundbridge-worklet.js?v=20260610e"
  });

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  bridge.connect(analyser);
  analyser.connect(audioContext.destination);

  bridge.addEventListener("stats", (event) => {
    const stats = event.detail;
    elements.processedBlocks.textContent = String(stats.processedBlocks ?? 0);
    elements.underruns.textContent = String(stats.underruns ?? 0);
    elements.queuedBlocks.textContent = String(stats.queuedOutputBlocks ?? 0);
  });
  bridge.addEventListener("audio-error", (event) => {
    logError(event.detail);
  });
  bridge.addEventListener("process-diagnostics", (event) => {
    elements.renderEngine.textContent = formatRenderEngine(event.detail?.renderEngine);
  });

  const { parameters } = await client.getParameters(instanceId);
  renderParameterControls({
    container: elements.parameterControls,
    client,
    instanceId,
    parameters
  });

  setStatus(elements.engineStatus, "Engine running", "ready");
  await refreshLatency();
  startScope();
  if (pluginKind === "instrument") {
    elements.sourceLabel.textContent = "Browser keyboard";
  }
  return bridge;
}

async function useAudioFile(file) {
  try {
    const activeBridge = await withTimeout(
      ensureBridgeInstance(),
      4000,
      "Audio engine startup timed out. Try Chrome, Safari, or Firefox with AudioWorklet enabled."
    );
    stopSource();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.loop = true;
    source.connect(activeBridge.node);
    source.start();
    currentSource = source;
    elements.sourceLabel.textContent = file.name;
    log(`Playing ${file.name}`);
  } catch (error) {
    logError(error);
  }
}

async function useMicrophone() {
  try {
    const activeBridge = await withTimeout(
      ensureBridgeInstance(),
      4000,
      "Audio engine startup timed out. Try Chrome, Safari, or Firefox with AudioWorklet enabled."
    );
    stopSource();
    currentStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    currentSource = audioContext.createMediaStreamSource(currentStream);
    currentSource.connect(activeBridge.node);
    elements.sourceLabel.textContent = "Microphone";
    log("Microphone routed through bridge.");
  } catch (error) {
    logError(error);
  }
}

function stopSource() {
  void allNotesOff();
  if (currentSource) {
    try {
      currentSource.stop?.();
    } catch {}
    try {
      currentSource.disconnect();
    } catch {}
  }

  if (currentStream) {
    for (const track of currentStream.getTracks()) {
      track.stop();
    }
  }

  currentSource = undefined;
  currentStream = undefined;
  elements.sourceLabel.textContent = "No source selected";
}

async function saveState() {
  if (!client || !selectedInstanceId) {
    return;
  }
  try {
    const { state } = await client.getState(selectedInstanceId);
    elements.stateText.value = state;
    log("Plugin state saved.");
  } catch (error) {
    logError(error);
  }
}

async function restoreState() {
  if (!client || !selectedInstanceId || !elements.stateText.value.trim()) {
    return;
  }
  try {
    const { parameters } = await client.setState(selectedInstanceId, elements.stateText.value.trim());
    renderParameterControls({
      container: elements.parameterControls,
      client,
      instanceId: selectedInstanceId,
      parameters
    });
    log("Plugin state restored.");
  } catch (error) {
    logError(error);
  }
}

async function refreshLatency() {
  if (!client || !selectedInstanceId) {
    return;
  }
  try {
    const latency = await client.getLatency(selectedInstanceId);
    setStatus(elements.latencyStatus, `${latency.reportedLatencySamples} samples`, "ready");
  } catch (error) {
    setStatus(elements.latencyStatus, "Latency unknown", "");
    logError(error);
  }
}

function setCapabilityStatus(capabilities) {
  const formats = capabilities?.pluginFormats ?? {};
  const vst3 = formats.vst3 ?? {};
  const au = formats.au ?? {};
  const lv2 = formats.lv2 ?? {};
  const fullNativeHost = vst3.host === true && au.host === true && lv2.host === true;
  const nativeExampleHost = vst3.exampleHost === true && au.exampleHost === true && lv2.exampleHost === true;
  const playableExamples =
    nativeExampleHost ||
    (vst3.mockExamples === true && au.mockExamples === true && lv2.mockExamples === true);
  elements.capabilityStatus.title = [vst3.notes, au.notes, lv2.notes].filter(Boolean).join(" ");

  if (fullNativeHost) {
    setStatus(elements.capabilityStatus, "AU/VST/LV2 host ready", "ready");
    return;
  }

  if (vst3.host === true && au.host === true && nativeExampleHost) {
    setStatus(elements.capabilityStatus, "AU/VST3 host + examples", "ready");
    return;
  }

  if (au.host === true && nativeExampleHost) {
    setStatus(elements.capabilityStatus, "AU host + examples", "ready");
    return;
  }

  if (nativeExampleHost) {
    setStatus(elements.capabilityStatus, "AU/VST/LV2 bundle examples", "ready");
    return;
  }

  if (playableExamples) {
    setStatus(elements.capabilityStatus, "AU/VST/LV2 examples ready", "ready");
    return;
  }

  if (vst3.scan === true || au.scan === true || lv2.scan === true) {
    setStatus(elements.capabilityStatus, "AU/VST/LV2 scan only", "warn");
    return;
  }

  setStatus(elements.capabilityStatus, "Host unavailable", "");
}

function renderPluginOptions(plugins) {
  elements.pluginSelect.replaceChildren();
  pluginMetadataById.clear();
  const summary = {
    total: plugins.length,
    hostable: 0,
    scanOnly: 0
  };

  for (const plugin of plugins) {
    pluginMetadataById.set(plugin.pluginId, plugin);
    const option = document.createElement("option");
    option.value = plugin.pluginId;
    option.dataset.format = plugin.format ?? "unknown";
    option.dataset.kind = plugin.kind ?? "unknown";
    option.dataset.source = plugin.source ?? "unknown";
    option.dataset.hostable = String(plugin.hostable !== false);
    option.dataset.hostUnavailableReason = plugin.hostUnavailableReason ?? "";
    option.disabled = plugin.hostable === false;
    if (plugin.hostUnavailableReason) {
      option.title = plugin.hostUnavailableReason;
    }
    if (plugin.hostable === false) {
      summary.scanOnly += 1;
    } else {
      summary.hostable += 1;
    }
    option.textContent = `[${formatPluginFormat(plugin.format)}] ${plugin.vendor} ${plugin.name}${formatPluginSource(plugin)}`;
    elements.pluginSelect.append(option);
  }
  elements.pluginSelect.dataset.totalCount = String(summary.total);
  elements.pluginSelect.dataset.hostableCount = String(summary.hostable);
  elements.pluginSelect.dataset.scanOnlyCount = String(summary.scanOnly);
  updatePluginStatus();
  updatePresetControls();
}

function updatePresetControls() {
  const plugin = pluginMetadataById.get(elements.pluginSelect.value);
  const presets = Array.isArray(plugin?.presets) ? plugin.presets : [];
  elements.presetSelect.replaceChildren();

  for (const preset of presets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.name;
    option.dataset.parameters = JSON.stringify(preset.parameters ?? {});
    elements.presetSelect.append(option);
  }

  const enabled = controlsEnabled && presets.length > 0 && plugin?.hostable !== false;
  elements.presetSelect.disabled = !enabled;
  elements.applyPresetButton.disabled = !enabled;
}

function updatePluginStatus() {
  const selected = elements.pluginSelect.selectedOptions[0];
  const total = Number(elements.pluginSelect.dataset.totalCount ?? 0);
  const hostable = Number(elements.pluginSelect.dataset.hostableCount ?? 0);
  const scanOnly = Number(elements.pluginSelect.dataset.scanOnlyCount ?? 0);

  if (!selected || total === 0) {
    elements.pluginStatus.textContent = "No plugins scanned";
    return;
  }

  const selectedState =
    selected.dataset.hostable === "false"
      ? "scan only"
      : formatPluginSourceLabel(selected.dataset.source);
  elements.pluginStatus.textContent = `${hostable} playable · ${scanOnly} scan only · selected ${selectedState}`;
}

function formatPluginSourceLabel(source) {
  switch (source) {
    case "example-bundle":
      return "example bundle";
    case "builtin-example":
      return "built-in example";
    case "mock":
      return "mock";
    case "scan":
      return "installed";
    default:
      return "plugin";
  }
}

async function applySelectedPreset() {
  if (!client) {
    return;
  }

  const plugin = pluginMetadataById.get(elements.pluginSelect.value);
  const preset = plugin?.presets?.find((candidate) => candidate.id === elements.presetSelect.value);
  if (!preset) {
    return;
  }

  try {
    await ensureBridgeInstance();
    const entries = Object.entries(preset.parameters ?? {});
    for (const [parameterId, normalizedValue] of entries) {
      await client.setParameter(selectedInstanceId, parameterId, normalizedValue);
    }
    const { parameters } = await client.getParameters(selectedInstanceId);
    renderParameterControls({
      container: elements.parameterControls,
      client,
      instanceId: selectedInstanceId,
      parameters
    });
    log(`Preset applied: ${preset.name}`);
  } catch (error) {
    logError(error);
  }
}

function formatPluginFormat(format) {
  switch (format) {
    case "vst3":
      return "VST3";
    case "au":
      return "AU";
    case "lv2":
      return "LV2";
    case "mock":
      return "Mock";
    default:
      return "Unknown";
  }
}

function formatPluginSource(plugin) {
  if (plugin.hostable === false) {
    return " · scan only";
  }

  switch (plugin.source) {
    case "example-bundle":
      return " · example bundle";
    case "builtin-example":
      return " · built-in example";
    case "scan":
      return " · installed";
    default:
      return "";
  }
}

function formatRenderEngine(renderEngine) {
  switch (renderEngine) {
    case "bundle-worker":
      return "Bundle worker";
    case "bundle-executable":
      return "Bundle executable";
    case "native-example":
      return "Native example";
    case "native-au":
      return "Native AU";
    case "native-vst3":
      return "Native VST3";
    case "native-lv2":
      return "Native LV2";
    case "js-fallback":
      return "JS fallback";
    default:
      return renderEngine ? String(renderEngine) : "Unknown";
  }
}

function setControlsEnabled(enabled) {
  controlsEnabled = enabled;
  for (const control of [
    elements.createInstanceButton,
    elements.pluginSelect,
    elements.fileInput,
    elements.micButton,
    elements.stopButton,
    elements.saveStateButton,
    elements.restoreStateButton,
    elements.latencyButton,
    ...elements.keyboard.querySelectorAll("button")
  ]) {
    control.disabled = !enabled;
  }
  updatePresetControls();
}

async function noteOn(note, button) {
  try {
    if (!client || activeNotes.has(note)) {
      return;
    }

    const option = elements.pluginSelect.selectedOptions[0];
    if (option?.dataset.kind !== "instrument") {
      log("Select an instrument plugin to play notes.");
      return;
    }

    await ensureBridgeInstance();
    activeNotes.add(note);
    button?.classList.add("active");
    await client.sendMidiEvents(selectedInstanceId, [
      {
        type: "noteOn",
        note,
        velocity: 0.82
      }
    ]);
  } catch (error) {
    logError(error);
  }
}

async function noteOff(note, button) {
  try {
    if (!client || !selectedInstanceId || !activeNotes.has(note)) {
      return;
    }

    activeNotes.delete(note);
    button?.classList.remove("active");
    await client.sendMidiEvents(selectedInstanceId, [
      {
        type: "noteOff",
        note,
        velocity: 0
      }
    ]);
  } catch (error) {
    logError(error);
  }
}

async function allNotesOff() {
  if (!client || !selectedInstanceId || activeNotes.size === 0) {
    activeNotes.clear();
    for (const button of elements.keyboard.querySelectorAll(".piano-key")) {
      button.classList.remove("active");
    }
    return;
  }

  const events = Array.from(activeNotes, (note) => ({
    type: "noteOff",
    note,
    velocity: 0
  }));
  activeNotes.clear();
  for (const button of elements.keyboard.querySelectorAll(".piano-key")) {
    button.classList.remove("active");
  }
  try {
    await client.sendMidiEvents(selectedInstanceId, events);
  } catch (error) {
    logError(error);
  }
}

function findKeyButton(note) {
  return elements.keyboard.querySelector(`[data-note="${note}"]`);
}

function setStatus(element, text, mode) {
  element.textContent = text;
  element.classList.toggle("ready", mode === "ready");
  element.classList.toggle("warn", mode === "warn");
}

function log(message) {
  elements.log.value = message;
}

function logError(error) {
  const message = error?.message ?? String(error);
  elements.log.value = message;
  console.error(error);
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function startScope() {
  cancelAnimationFrame(animationFrame);
  const canvas = elements.scope;
  const context = canvas.getContext("2d");
  const data = new Uint8Array(analyser.frequencyBinCount);

  const draw = () => {
    animationFrame = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(data);
    drawScope(context, canvas, data);
  };

  draw();
}

function drawIdleScope() {
  const canvas = elements.scope;
  const context = canvas.getContext("2d");
  const data = new Uint8Array(256);
  data.fill(128);
  drawScope(context, canvas, data);
}

function drawScope(context, canvas, data) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#0c1010";
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.strokeStyle = "rgba(119, 214, 180, 0.22)";
  context.lineWidth = 1;
  for (let y = 32; y < canvas.height; y += 32) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
    context.stroke();
  }

  context.strokeStyle = "#77d6b4";
  context.lineWidth = 2;
  context.beginPath();
  for (let index = 0; index < data.length; index += 1) {
    const x = (index / (data.length - 1)) * canvas.width;
    const y = (data[index] / 255) * canvas.height;
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.stroke();
}
