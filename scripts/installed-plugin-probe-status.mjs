import { FILE_GRANT_OPERATION_NAMES } from "./daemon-file-grant-operations.mjs";
import { safeMatrixText } from "./installed-plugin-probe-reporting-safety.mjs";

const KNOWN_FILE_GRANT_OPERATIONS = new Set(FILE_GRANT_OPERATION_NAMES);

export function summarizeFeatureStatus(result, options) {
  return {
    instantiation: phaseGroupStatus(result, ["createInstance"]),
    parameters: parameterFeatureStatus(result),
    presetSnapshots: safeMatrixText(listedPresetStatus(result), 64),
    vst3ProgramData: safeMatrixText(vst3ProgramDataStatus(result), 64),
    state: phaseGroupStatus(result, ["getState", "setState"]),
    fileGrants: fileGrantFeatureStatus(result),
    midiEvents: phaseGroupStatus(result, ["sendMidiEvents", "sendMidiNoteOff"]),
    automation: safeMatrixText(automationLaneStatus(result), 64),
    transport: hostTransportStatus(result),
    rendering: renderingFeatureStatus(result),
    busLayouts: busLayoutFeatureStatus(result),
    latencyTail: phaseGroupStatus(result, ["getLatency", "getTailTime"]),
    editor: nativeEditorStatus(result, options)
  };
}

export function hasFailedPhase(result, names) {
  const phaseNames = new Set(names);
  return (result.phases ?? []).some((phaseResult) => phaseNames.has(phaseResult.name) && phaseResult.ok === false);
}

export function hasOkPhase(result, name) {
  return (result.phases ?? []).some((phaseResult) => phaseResult.name === name && phaseResult.ok === true);
}

export function automationLaneStatus(result) {
  if (hasFailedPhase(result, ["setAutomationLane"])) {
    return "failed";
  }
  return Number.isInteger(result.automationLanePointCount)
    ? "applied"
    : result.automationLaneSkipped
      ? `skipped-${result.automationLaneSkipped}`
      : "missing";
}

export function listedPresetStatus(result) {
  if (result.listedPreset !== undefined) {
    return String(result.listedPreset);
  }
  if (hasFailedPhase(result, ["setPreset"])) {
    return "failed";
  }
  return "missing";
}

export function parameterMetadataStatus(result) {
  if (hasFailedPhase(result, ["createInstance", "getParameters"])) {
    return "failed";
  }
  return result.parameterMetadataAtLimit === true
    ? "at-limit"
    : Number.isInteger(result.parameterCount)
      ? result.parameterCount > 0 ? "listed" : "none"
      : "missing";
}

export function parameterProfileStatus(result) {
  if (result.parameterProfile?.category) {
    return result.parameterProfile.category;
  }
  if (hasFailedPhase(result, ["createInstance", "getParameters"])) {
    return "failed";
  }
  return Number.isInteger(result.parameterCount)
    ? result.parameterCount > 0 ? "listed" : "none"
    : "missing";
}

export function stateProfileStatus(result) {
  if (result.stateProfile?.category) {
    return result.stateProfile.category;
  }
  if (hasFailedPhase(result, ["createInstance", "getState"])) {
    return "failed";
  }
  return hasOkPhase(result, "getState") ? "unprofiled" : "missing";
}

export function vst3MidiControllerEventStatus(result) {
  if (result.vst3MidiControllerEvents !== undefined) {
    return result.vst3MidiControllerEvents;
  }
  if (String(result.format ?? "").toLowerCase() === "vst3" && hasFailedPhase(result, ["sendMidiEvents"])) {
    return "failed";
  }
  return String(result.format ?? "").toLowerCase() === "vst3" ? "missing" : "skipped-format";
}

export function vst3MidiProgramChangeEventStatus(result) {
  if (result.vst3MidiProgramChangeEvents !== undefined) {
    return result.vst3MidiProgramChangeEvents;
  }
  if (String(result.format ?? "").toLowerCase() === "vst3" && hasFailedPhase(result, ["sendMidiEvents"])) {
    return "failed";
  }
  return String(result.format ?? "").toLowerCase() === "vst3" ? "missing" : "skipped-format";
}

export function midiTimingStatus(result) {
  if (result.midiTimingProfile?.category) {
    return result.midiTimingProfile.category;
  }
  if (hasFailedPhase(result, ["createInstance", "sendMidiEvents", "sendMidiNoteOff"])) {
    return "failed";
  }
  return Number.isInteger(result.midiEventCount) ? "unprofiled" : "missing";
}

export function vst3EventProfileStatus(result) {
  if (result.vst3EventProfile?.category) {
    return String(result.vst3EventProfile.category);
  }
  if (String(result.format ?? "").toLowerCase() !== "vst3") {
    return "skipped-format";
  }
  return hasFailedPhase(result, ["createInstance"]) ? "failed" : "missing";
}

export function vst3ProgramDataProfileStatus(result) {
  if (result.vst3ProgramDataProfile?.category) {
    return result.vst3ProgramDataProfile.category;
  }
  if (String(result.format ?? "").toLowerCase() !== "vst3") {
    return "skipped-format";
  }
  return hasFailedPhase(result, ["createInstance"]) ? "failed" : "missing";
}

export function vst3ProgramDataStatus(result) {
  if (result.vst3ProgramData !== undefined) {
    return String(result.vst3ProgramData);
  }
  if (hasFailedPhase(result, ["setVst3ProgramData"])) {
    return "restore-failed";
  }
  if (hasFailedPhase(result, ["getVst3ProgramData"])) {
    return "export-failed";
  }
  if (String(result.format ?? "").toLowerCase() === "vst3" && hasFailedPhase(result, ["createInstance"])) {
    return "failed";
  }
  return "missing";
}

export function vst3ProgramListStatus(result) {
  if (String(result.format ?? "").toLowerCase() !== "vst3") {
    return "skipped-format";
  }
  if (Number.isInteger(result.vst3ProgramListCount)) {
    return result.vst3ProgramListCount > 0 ? "listed" : "none";
  }
  return hasFailedPhase(result, ["createInstance"]) ? "failed" : "missing";
}

export function latencyTailStatus(result) {
  if (hasFailedPhase(result, ["getLatency", "getTailTime"])) {
    return "failed";
  }
  const hasLatency = Number.isInteger(result.pluginLatencySamples) &&
    Number.isInteger(result.transportLatencySamples) &&
    Number.isInteger(result.reportedLatencySamples);
  const hasTail = Number.isInteger(result.tailSamples) && typeof result.infiniteTail === "boolean";
  if (hasLatency && hasTail) {
    if (result.infiniteTail) {
      return "infinite-tail";
    }
    if (result.pluginLatencySamples > 0 && result.tailSamples > 0) {
      return "latency-tail";
    }
    if (result.pluginLatencySamples > 0) {
      return "latency";
    }
    if (result.tailSamples > 0) {
      return "tail";
    }
    return "zero";
  }
  if (hasLatency || hasTail || hasOkPhase(result, "getLatency") || hasOkPhase(result, "getTailTime")) {
    return "partial";
  }
  return "missing";
}

export function outputBusSignalStatus(result) {
  if (hasFailedPhase(result, ["processAudioBlock"])) {
    return "failed";
  }
  return result.outputBusSignalProfile?.category ?? (hasOkPhase(result, "processAudioBlock") ? "unprofiled" : "missing");
}

export function renderSignalStatus(result) {
  if (result.renderSignal !== undefined) {
    return String(result.renderSignal);
  }
  return hasFailedPhase(result, ["processAudioBlock"]) ? "failed" : "missing";
}

export function nativeEditorStatus(result, options) {
  if (!options.nativeEditorBroker) {
    return "not-requested";
  }
  if (hasFailedPhase(result, ["openNativeEditor", "closeNativeEditor"])) {
    return "failed";
  }
  return result.nativeEditor?.transport || (hasOkPhase(result, "openNativeEditor") && hasOkPhase(result, "closeNativeEditor"))
    ? "opened"
    : "missing";
}

function parameterFeatureStatus(result) {
  if (hasFailedPhase(result, ["getParameters", "setParameter", "setParameterDisplayValue"])) {
    return "failed";
  }
  return hasOkPhase(result, "getParameters") || Number.isInteger(result.parameterCount) ? "passed" : "missing";
}

function fileGrantFeatureStatus(result) {
  if (hasFailedPhase(result, [
    "createPresetFileGrant",
    "attachPresetFileGrant",
    "useFileGrantLoadPreset",
    "createStateFileGrant",
    "attachStateFileGrant",
    "useFileGrantRestoreState",
    "createStateDirectoryGrant",
    "attachStateDirectoryGrant",
    "useFileGrantSaveStateDirectory",
    "createSavedStateFileGrant",
    "attachSavedStateFileGrant",
    "useFileGrantRestoreSavedState",
    "createSampleFileGrant",
    "attachSampleFileGrant",
    "useFileGrantLoadSample",
    "createCacheDirectoryGrant",
    "attachCacheDirectoryGrant",
    "useFileGrantOpenCacheDirectory",
    "createLicenseFileGrant",
    "attachLicenseFileGrant",
    "useFileGrantLoadLicense",
    "createOtherPresetFileGrant",
    "attachOtherPresetFileGrant",
    "useFileGrantOtherPreset"
  ])) {
    return "failed";
  }

  const workflowStatuses = [
    result.fileGrantStateRestore,
    result.fileGrantPresetLoad,
    result.fileGrantStateSave,
    result.fileGrantSavedStateRestore,
    result.fileGrantSampleLoad,
    result.fileGrantCacheDirectoryOpen,
    result.fileGrantLicenseLoad,
    result.fileGrantOtherPresetLoad
  ].filter(Boolean).map(String);
  if (workflowStatuses.some((status) => status === "applied")) {
    return "passed";
  }
  const knownOperationCount = knownFileGrantOperations(result.fileGrantOperations).length;
  if (workflowStatuses.length > 0) {
    if (workflowStatuses.every((status) => status === "skipped")) {
      return "skipped";
    }
    if (workflowStatuses.every(isSkippedFileGrantWorkflow)) {
      return knownOperationCount > 0 ? "advertised" : "unadvertised";
    }
  }
  if (knownOperationCount > 0) {
    return "advertised";
  }
  if (Array.isArray(result.fileGrantOperations)) {
    return result.fileGrantOperations.length > 0 ? "unknown" : "unadvertised";
  }
  return "missing";
}

function isSkippedFileGrantWorkflow(status) {
  return status === "skipped" || status === "skipped-unadvertised";
}

function knownFileGrantOperations(operations) {
  if (!Array.isArray(operations)) {
    return [];
  }
  return operations.filter((operation) => KNOWN_FILE_GRANT_OPERATIONS.has(String(operation)));
}

function renderingFeatureStatus(result) {
  if (hasFailedPhase(result, ["processAudioBlock"])) {
    return "failed";
  }
  return result.renderSignal === "signal" || result.renderSignal === "silent" || hasOkPhase(result, "processAudioBlock")
    ? "passed"
    : "missing";
}

export function hostTransportStatus(result) {
  if (hasFailedPhase(result, ["processAudioBlock"])) {
    return "failed";
  }
  return safeMatrixText(result.hostTransport ?? "missing", 64);
}

function busLayoutFeatureStatus(result) {
  if (hasFailedPhase(result, ["createInstance", "processAudioBlock"])) {
    return "failed";
  }
  return result.busProfile?.category ? "passed" : "missing";
}

function phaseGroupStatus(result, names) {
  if (hasFailedPhase(result, names)) {
    return "failed";
  }
  if (names.every((name) => hasOkPhase(result, name))) {
    return "passed";
  }
  return names.some((name) => hasOkPhase(result, name)) ? "partial" : "missing";
}
