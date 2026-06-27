import {
  SoundBridgeAudioNode,
  SoundBridgeClient,
  renderParameterControls
} from "/packages/web-client/dist/soundbridge-client.js";
import { setCapabilityStatus } from "./capability-status.js";
import { createFileGrantActions } from "./file-grant-actions.js";
import { createPluginBrowser } from "./plugin-browser.js";
import { createRealtimeStats } from "./realtime-stats.js";
import { createVst3ProgramDataControls } from "./vst3-program-data-controls.js";

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
  grantRestoreStateButton: document.querySelector("#grantRestoreStateButton"),
  grantLoadPresetButton: document.querySelector("#grantLoadPresetButton"),
  grantSaveStateButton: document.querySelector("#grantSaveStateButton"),
  programDataSelect: document.querySelector("#programDataSelect"),
  exportProgramDataButton: document.querySelector("#exportProgramDataButton"),
  restoreProgramDataButton: document.querySelector("#restoreProgramDataButton"),
  programDataText: document.querySelector("#programDataText"),
  latencyButton: document.querySelector("#latencyButton"),
  parameterControls: document.querySelector("#parameterControls"),
  stateText: document.querySelector("#stateText"),
  connectionStatus: document.querySelector("#connectionStatus"),
  capabilityStatus: document.querySelector("#capabilityStatus"),
  engineStatus: document.querySelector("#engineStatus"),
  latencyStatus: document.querySelector("#latencyStatus"),
  sourceLabel: document.querySelector("#sourceLabel"),
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
let activeInstancePlugin;
let bridgeStartupPromise;
let controlsEnabled = false;
let latestTransportLatencySamples = 0;
const activeNotes = new Set();
const keyToNote = new Map();
const realtimeStats = createRealtimeStats({
  onTransportLatencySamples: (samples) => {
    latestTransportLatencySamples = samples || latestTransportLatencySamples;
  }
});
const fileGrantActions = createFileGrantActions({
  client: () => {
    if (!client) {
      throw new Error("Connect to the daemon first.");
    }
    return client;
  },
  ensureInstance: () => ensureBridgeInstance(),
  getInstanceId: () => selectedInstanceId,
  refreshParameters,
  log,
  logError
});
const pluginBrowser = createPluginBrowser({
  elements: {
    pluginSelect: elements.pluginSelect,
    pluginStatus: elements.pluginStatus,
    presetSelect: elements.presetSelect,
    applyPresetButton: elements.applyPresetButton,
    grantRestoreStateButton: elements.grantRestoreStateButton,
    grantLoadPresetButton: elements.grantLoadPresetButton,
    grantSaveStateButton: elements.grantSaveStateButton
  },
  client: () => client,
  controlsEnabled: () => controlsEnabled,
  ensureInstance: () => ensureBridgeInstance(),
  getInstanceId: () => selectedInstanceId,
  refreshParameters: async (parameters) => {
    if (Array.isArray(parameters)) {
      renderCurrentParameterControls(parameters);
      return;
    }
    await refreshParameters();
  },
  log,
  logError
});
const vst3ProgramDataControls = createVst3ProgramDataControls({
  elements: {
    select: elements.programDataSelect,
    exportButton: elements.exportProgramDataButton,
    restoreButton: elements.restoreProgramDataButton,
    text: elements.programDataText
  },
  client: () => {
    if (!client) {
      throw new Error("Connect to the daemon first.");
    }
    return client;
  },
  getInstanceId: () => selectedInstanceId,
  getPlugin: () => activeInstancePlugin,
  controlsEnabled: () => controlsEnabled,
  refreshParameters: async (parameters) => {
    if (Array.isArray(parameters)) {
      renderCurrentParameterControls(parameters);
      return;
    }
    await refreshParameters();
  },
  log,
  logError
});

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
  activeInstancePlugin = undefined;
  vst3ProgramDataControls.clearEnvelope();
  pluginBrowser.updateAll();
  vst3ProgramDataControls.update();
  if (bridge) {
    setStatus(elements.engineStatus, "Starting", "warn");
    void ensureBridgeInstance(true).catch(logError);
  }
});

elements.applyPresetButton.addEventListener("click", () => {
  void pluginBrowser.applySelectedPreset();
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

elements.grantRestoreStateButton.addEventListener("click", () => {
  if (pluginBrowser.hasFileGrantOperation("restoreState")) {
    void fileGrantActions.restoreState();
  }
});

elements.grantLoadPresetButton.addEventListener("click", () => {
  if (pluginBrowser.hasFileGrantOperation("loadPreset")) {
    void fileGrantActions.loadPreset();
  }
});

elements.grantSaveStateButton.addEventListener("click", () => {
  if (pluginBrowser.hasFileGrantOperation("saveStateDirectory")) {
    void fileGrantActions.saveStateDirectory();
  }
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
      origin: window.location.origin,
      transport: "worker"
    });
    await client.connect();
    const pairingToken = elements.pairingToken.value.trim();
    if (!pairingToken) {
      throw new Error("Paste the pairing token printed by npm run bridge.");
    }
    await client.pair(pairingToken);
    const hello = await client.hello();
    setCapabilityStatus(elements.capabilityStatus, hello?.capabilities);
    const { plugins } = await client.scanPlugins();
    pluginBrowser.renderOptions(plugins);
    vst3ProgramDataControls.update();

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

  setStatus(elements.engineStatus, "Starting", "warn");
  realtimeStats.update();
  if (bridge) {
    await allNotesOff();
    await bridge.destroy();
    bridge = undefined;
    selectedInstanceId = undefined;
    activePluginId = undefined;
    activeInstancePlugin = undefined;
    vst3ProgramDataControls.clearEnvelope();
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
  activeInstancePlugin = created.plugin ?? pluginBrowser.selectedPlugin();
  latestTransportLatencySamples = 0;
  elements.renderEngine.textContent = "Waiting";
  bridge = await SoundBridgeAudioNode.createLivePerformance(audioContext, client, {
    instanceId,
    inputChannels,
    outputChannels,
    maxBlockFrames: 128,
    workletUrl: "/packages/web-client/dist/soundbridge-worklet.js?v=20260627c"
  });

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  bridge.connect(analyser);
  analyser.connect(audioContext.destination);

  bridge.addEventListener("stats", (event) => {
    realtimeStats.update(event.detail);
  });
  bridge.addEventListener("latencychange", (event) => {
    realtimeStats.updateLatencyHealth(event.detail?.health ?? event.detail);
  });
  bridge.addEventListener("healthchange", (event) => {
    realtimeStats.updateLatencyHealth(event.detail);
  });
  bridge.addEventListener("transport-pressure", (event) => {
    realtimeStats.updateTransportPressure(event.detail);
  });
  bridge.addEventListener("audio-error", (event) => {
    logError(event.detail);
  });
  bridge.addEventListener("process-diagnostics", (event) => {
    realtimeStats.updateRenderDiagnostics(event.detail);
    elements.renderEngine.textContent = formatRenderEngine(event.detail?.renderEngine);
  });

  const { parameters } = await client.getParameters(instanceId);
  renderCurrentParameterControls(parameters);

  setStatus(elements.engineStatus, "Engine running", "ready");
  pluginBrowser.updateFileGrantControls();
  vst3ProgramDataControls.update();
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
    renderCurrentParameterControls(parameters);
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
    const latency = bridge
      ? await bridge.refreshLatency(latestTransportLatencySamples)
      : await client.getLatency(selectedInstanceId, latestTransportLatencySamples);
    const reportedLatencyMs = latency.reportedLatencyMs ?? latencySamplesToMilliseconds(latency.reportedLatencySamples);
    realtimeStats.updateLatencyHealth({ reportedLatencyMs });
    setStatus(elements.latencyStatus, `${latency.reportedLatencySamples} samples / ${formatMilliseconds(reportedLatencyMs)} ms`, "ready");
  } catch (error) {
    setStatus(elements.latencyStatus, "Latency unknown", "");
    logError(error);
  }
}

async function refreshParameters() {
  if (!client || !selectedInstanceId) {
    return;
  }

  const { parameters } = await client.getParameters(selectedInstanceId);
  renderCurrentParameterControls(parameters);
}

function renderCurrentParameterControls(parameters) {
  renderParameterControls({
    container: elements.parameterControls,
    client,
    instanceId: selectedInstanceId,
    parameters
  });
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

function formatMilliseconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(60000, number)).toFixed(3) : "0";
}

function latencySamplesToMilliseconds(samples) {
  const sampleRate = Number(audioContext?.sampleRate);
  const sampleCount = Math.max(0, Math.min(1048576, Math.floor(Number(samples ?? 0))));
  return Number.isFinite(sampleRate) && sampleRate > 0 ? (sampleCount / sampleRate) * 1000 : 0;
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
    elements.grantRestoreStateButton,
    elements.grantLoadPresetButton,
    elements.grantSaveStateButton,
    elements.programDataSelect,
    elements.exportProgramDataButton,
    elements.restoreProgramDataButton,
    elements.programDataText,
    elements.latencyButton,
    ...elements.keyboard.querySelectorAll("button")
  ]) {
    control.disabled = !enabled;
  }
  pluginBrowser.updatePresetControls();
  pluginBrowser.updateFileGrantControls();
  vst3ProgramDataControls.update();
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

    const resumeBeforeStartup = audioContext?.state !== "running" ? audioContext?.resume() : undefined;
    await ensureBridgeInstance();
    await resumeBeforeStartup;
    if (audioContext?.state !== "running") {
      await audioContext.resume();
    }
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
  context.fillStyle = "#071c24";
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.strokeStyle = "rgba(93, 205, 244, 0.2)";
  context.lineWidth = 1;
  for (let y = 32; y < canvas.height; y += 32) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
    context.stroke();
  }

  context.strokeStyle = "#5dcdf4";
  context.shadowColor = "rgba(93, 205, 244, 0.46)";
  context.shadowBlur = 9;
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
  context.shadowBlur = 0;
}
