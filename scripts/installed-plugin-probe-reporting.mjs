import {
  removeEmpty,
  safeMatrixArray,
  safeMatrixInteger,
  safeMatrixIntegerArray,
  safeMatrixText
} from "./installed-plugin-probe-reporting-safety.mjs";
import { vst3EventMatrixFields } from "./installed-plugin-probe-vst3-events-matrix.mjs";

const REPORT_MODES = new Set(["full", "summary", "json", "matrix"]);
const KNOWN_FILE_GRANT_OPERATIONS = new Set([
  "loadPreset",
  "loadSample",
  "openCacheDirectory",
  "loadLicense",
  "restoreState",
  "saveStateDirectory",
  "other"
]);
const MAX_PLUGIN_STATE_BYTES = 384 * 1024;
const MAX_PLUGIN_PROGRAM_DATA_BYTES = 384 * 1024;

export function installedProbeReportMode(env = process.env) {
  const raw = String(env.SOUNDBRIDGE_PROBE_REPORT ?? "full").trim().toLowerCase();
  if (!REPORT_MODES.has(raw)) {
    throw new Error("SOUNDBRIDGE_PROBE_REPORT must be one of: full, summary, json, matrix");
  }
  return raw;
}

export function createInstalledProbeReporter({
  formats,
  maxBlockSize,
  mode = "full",
  nameFilter = "",
  nativeEditorBroker = false,
  stream = console
}) {
  return {
    printIntro(selectedCount) {
      if (mode === "json" || mode === "matrix") {
        return;
      }
      stream.log(
        `Probing ${selectedCount} installed plugin(s) (${[...formats].join(",")})` +
          (nameFilter ? ` matching "${nameFilter}"` : "") +
          ` with ${maxBlockSize} frame blocks` +
          (nativeEditorBroker ? " and native editor broker checks" : "") +
          "."
      );
    },

    printResult(result) {
      if (mode === "json" || mode === "matrix") {
        return;
      }
      const status = result.ok ? "ok" : "FAIL";
      const failedPhase = firstFailedPhase(result);
      const suffix = failedPhase ? ` (${failedPhase.name}: ${failureCode(failedPhase)})` : "";
      stream.log(`${status.padEnd(4)} ${result.pluginId}${suffix}`);
    },

    printSummary(results) {
      const summary = summarizeProbeResults(results, { nativeEditorBroker });
      if (mode !== "json" && mode !== "matrix") {
        stream.log(`\n${summary.passed}/${summary.total} plugin(s) passed, ${summary.failed} failed.`);
        printFeatureCoverage(summary.coverage, stream);
      }
      if (mode === "summary" && summary.failed > 0) {
        printFailureSummary(summary.failures, stream);
      }
      if (mode === "full" || mode === "json") {
        stream.log(JSON.stringify({ passed: summary.passed, failed: summary.failed, coverage: summary.coverage, matrix: summary.matrix, results }, null, 2));
      }
      if (mode === "matrix") {
        stream.log(JSON.stringify({ passed: summary.passed, failed: summary.failed, total: summary.total, coverage: summary.coverage, matrix: summary.matrix }, null, 2));
      }
      return summary;
    }
  };
}

export function summarizeProbeResults(results, options = {}) {
  const passed = results.filter((result) => result.ok).length;
  const failures = results.filter((result) => !result.ok).map((result) => ({
    pluginId: result.pluginId,
    phase: firstFailedPhase(result)?.name ?? "probe",
    error: firstFailedPhase(result)?.error ?? result.error
  }));
  return {
    passed,
    failed: results.length - passed,
    total: results.length,
    coverage: summarizeFeatureCoverage(results, options),
    failures,
    matrix: summarizeCompatibilityMatrix(results, options)
  };
}

function summarizeCompatibilityMatrix(results, options) {
  return results.map((result) => {
    const failedPhase = firstFailedPhase(result);
    const failureError = failedPhase?.error ?? result.error;
    return removeEmpty({
      pluginId: safeMatrixText(result.pluginId, 128),
      name: safeMatrixText(result.name, 160),
      vendor: safeMatrixText(result.vendor, 160),
      format: safeMatrixText(result.format, 16),
      kind: safeMatrixText(result.kind, 32),
      ok: result.ok === true,
      failedPhase: result.ok === true ? undefined : safeMatrixText(failedPhase?.name ?? "probe", 64),
      failureCode: result.ok === true
        ? undefined
        : safeMatrixText(failureError?.code ?? failureError?.message ?? "unknown_error", 96),
      renderSignal: safeMatrixText(result.renderSignal ?? "missing", 32),
      renderedChannels: safeMatrixInteger(result.renderedChannels, 0, 32),
      outputBusSignal: safeMatrixText(outputBusSignalStatus(result), 64),
      outputBusSignalFlags: safeMatrixArray(result.outputBusSignalProfile?.flags, 64),
      outputBusSignalCount: safeMatrixInteger(result.outputBusSignalProfile?.signalOutputBusCount, 0, 32),
      outputBusSilentCount: safeMatrixInteger(result.outputBusSignalProfile?.silentOutputBusCount, 0, 32),
      outputBusSignalIndexes: safeMatrixIntegerArray(result.outputBusSignalProfile?.signalOutputBusIndexes, 0, 31),
      outputBusSilentIndexes: safeMatrixIntegerArray(result.outputBusSignalProfile?.silentOutputBusIndexes, 0, 31),
      busCategory: safeMatrixText(result.busProfile?.category ?? "missing", 64),
      busFlags: safeMatrixArray(result.busProfile?.flags, 64),
      busInputCount: safeMatrixInteger(result.busProfile?.inputBuses, 0, 32),
      busOutputCount: safeMatrixInteger(result.busProfile?.outputBuses, 0, 32),
      busInputLayoutCount: safeMatrixInteger(result.busProfile?.inputBusLayoutCount, 0, 32),
      busOutputLayoutCount: safeMatrixInteger(result.busProfile?.outputBusLayoutCount, 0, 32),
      busActiveInputCount: safeMatrixInteger(result.busProfile?.activeInputBuses, 0, 32),
      busActiveOutputCount: safeMatrixInteger(result.busProfile?.activeOutputBuses, 0, 32),
      busInputChannels: safeMatrixInteger(result.busProfile?.inputChannels, 0, 32),
      busOutputChannels: safeMatrixInteger(result.busProfile?.outputChannels, 0, 32),
      busActiveInputIndexes: safeMatrixIntegerArray(result.busProfile?.activeInputBusIndexes, 0, 31),
      busActiveOutputIndexes: safeMatrixIntegerArray(result.busProfile?.activeOutputBusIndexes, 0, 31),
      busInactiveInputCount: safeMatrixInteger(result.busProfile?.inactiveInputBuses, 0, 32),
      busInactiveOutputCount: safeMatrixInteger(result.busProfile?.inactiveOutputBuses, 0, 32),
      busInactiveInputIndexes: safeMatrixIntegerArray(result.busProfile?.inactiveInputBusIndexes, 0, 31),
      busInactiveOutputIndexes: safeMatrixIntegerArray(result.busProfile?.inactiveOutputBusIndexes, 0, 31),
      busNonsequentialInputCount: safeMatrixInteger(result.busProfile?.nonsequentialInputBuses, 0, 32),
      busNonsequentialOutputCount: safeMatrixInteger(result.busProfile?.nonsequentialOutputBuses, 0, 32),
      busDuplicateInputIndexCount: safeMatrixInteger(result.busProfile?.duplicateInputBusIndexes, 0, 32),
      busDuplicateOutputIndexCount: safeMatrixInteger(result.busProfile?.duplicateOutputBusIndexes, 0, 32),
      busActiveEmptyInputCount: safeMatrixInteger(result.busProfile?.activeEmptyInputBuses, 0, 32),
      busActiveEmptyOutputCount: safeMatrixInteger(result.busProfile?.activeEmptyOutputBuses, 0, 32),
      busUnknownInputTypeCount: safeMatrixInteger(result.busProfile?.unknownInputBusTypes, 0, 32),
      busUnknownOutputTypeCount: safeMatrixInteger(result.busProfile?.unknownOutputBusTypes, 0, 32),
      busInputMetadataAtLimit: typeof result.busProfile?.inputBusMetadataAtLimit === "boolean"
        ? result.busProfile.inputBusMetadataAtLimit
        : undefined,
      busOutputMetadataAtLimit: typeof result.busProfile?.outputBusMetadataAtLimit === "boolean"
        ? result.busProfile.outputBusMetadataAtLimit
        : undefined,
      busInputCountMismatch: typeof result.busProfile?.inputBusCountMismatch === "boolean"
        ? result.busProfile.inputBusCountMismatch
        : undefined,
      busOutputCountMismatch: typeof result.busProfile?.outputBusCountMismatch === "boolean"
        ? result.busProfile.outputBusCountMismatch
        : undefined,
      ...vst3EventMatrixFields(result),
      latencyTail: safeMatrixText(latencyTailStatus(result), 64),
      pluginLatencySamples: safeMatrixInteger(result.pluginLatencySamples, 0, 1_048_576),
      transportLatencySamples: safeMatrixInteger(result.transportLatencySamples, 0, 1_048_576),
      reportedLatencySamples: safeMatrixInteger(result.reportedLatencySamples, 0, 1_048_576),
      tailSamples: safeMatrixInteger(result.tailSamples, 0, 1_048_576),
      infiniteTail: typeof result.infiniteTail === "boolean" ? result.infiniteTail : undefined,
      listedPreset: safeMatrixText(result.listedPreset ?? "missing", 64),
      listedPresetParameterCount: safeMatrixInteger(result.listedPresetParameterCount, 0, 1024),
      vst3ProgramData: safeMatrixText(result.vst3ProgramData ?? "missing", 64),
      vst3ProgramDataBytes: safeMatrixInteger(result.vst3ProgramDataSize, 0, MAX_PLUGIN_PROGRAM_DATA_BYTES),
      vst3ProgramDataTarget: safeMatrixText(vst3ProgramDataProfileStatus(result), 64),
      vst3ProgramDataFlags: safeMatrixArray(result.vst3ProgramDataProfile?.flags, 64),
      vst3ProgramDataProgramLists: safeMatrixInteger(result.vst3ProgramDataProfile?.programListCount, 0, 256),
      vst3ProgramDataCapableLists: safeMatrixInteger(result.vst3ProgramDataProfile?.programDataListCount, 0, 256),
      vst3ProgramDataCandidatePrograms: safeMatrixInteger(result.vst3ProgramDataProfile?.candidateProgramCount, 0, 65536),
      vst3ProgramDataUnsupportedLists: safeMatrixInteger(result.vst3ProgramDataProfile?.unsupportedProgramListCount, 0, 256),
      vst3ProgramDataUndisclosedLists: safeMatrixInteger(result.vst3ProgramDataProfile?.undisclosedProgramListCount, 0, 256),
      vst3ProgramDataMissingProgramLists: safeMatrixInteger(result.vst3ProgramDataProfile?.missingProgramArrayCount, 0, 256),
      vst3ProgramDataEmptyProgramLists: safeMatrixInteger(result.vst3ProgramDataProfile?.emptyProgramListCount, 0, 256),
      vst3ProgramDataInvalidLists: safeMatrixInteger(result.vst3ProgramDataProfile?.invalidProgramListCount, 0, 256),
      vst3ProgramDataInvalidProgramIndexes: safeMatrixInteger(result.vst3ProgramDataProfile?.invalidProgramIndexCount, 0, 65536),
      vst3ProgramDataDuplicateProgramListIds: safeMatrixInteger(result.vst3ProgramDataProfile?.duplicateProgramListIdCount, 0, 256),
      vst3ProgramDataDuplicateProgramIndexes: safeMatrixInteger(result.vst3ProgramDataProfile?.duplicateProgramIndexCount, 0, 65536),
      vst3ProgramDataNoProgramListSentinels: safeMatrixInteger(result.vst3ProgramDataProfile?.noProgramListSentinelCount, 0, 256),
      vst3ProgramDataProgramListMetadataAtLimit:
        typeof result.vst3ProgramDataProfile?.programListMetadataAtLimit === "boolean"
          ? result.vst3ProgramDataProfile.programListMetadataAtLimit
          : undefined,
      vst3ProgramDataProgramMetadataAtLimit:
        typeof result.vst3ProgramDataProfile?.programMetadataAtLimit === "boolean"
          ? result.vst3ProgramDataProfile.programMetadataAtLimit
          : undefined,
      vst3ProgramLists: safeMatrixText(vst3ProgramListStatus(result), 64),
      parameterMetadata: safeMatrixText(parameterMetadataStatus(result), 64),
      parameterProfile: safeMatrixText(parameterProfileStatus(result), 64),
      parameterFlags: safeMatrixArray(result.parameterProfile?.flags, 64),
      parameterCount: safeMatrixInteger(result.parameterProfile?.parameterCount ?? result.parameterCount, 0, 1024),
      parameterWritableCount: safeMatrixInteger(result.parameterProfile?.writableCount, 0, 1024),
      parameterAutomatableCount: safeMatrixInteger(result.parameterProfile?.automatableCount, 0, 1024),
      parameterReadOnlyCount: safeMatrixInteger(result.parameterProfile?.readOnlyCount, 0, 1024),
      parameterDisplayValueCount: safeMatrixInteger(result.parameterProfile?.displayValueCount ?? result.displayValueCount, 0, 1024),
      parameterUnitCount: safeMatrixInteger(result.parameterProfile?.unitCount, 0, 1024),
      parameterProgramChangeCount: safeMatrixInteger(result.parameterProfile?.programChangeCount, 0, 1024),
      parameterProgramChangeWithoutListCount: safeMatrixInteger(result.parameterProfile?.programChangeWithoutListCount, 0, 1024),
      parameterVst3UnitCount: safeMatrixInteger(result.parameterProfile?.vst3UnitCount, 0, 1024),
      parameterDuplicateIdCount: safeMatrixInteger(result.parameterProfile?.duplicateParameterIdCount, 0, 1024),
      parameterDisplayInput: safeMatrixText(result.parameterDisplayInput ?? "missing", 64),
      stateProfile: safeMatrixText(stateProfileStatus(result), 64),
      stateFlags: safeMatrixArray(result.stateProfile?.flags, 64),
      stateBytes: safeMatrixInteger(result.stateProfile?.stateBytes, 0, MAX_PLUGIN_STATE_BYTES),
      stateComponentBytes: safeMatrixInteger(result.stateProfile?.componentBytes, 0, MAX_PLUGIN_STATE_BYTES),
      stateControllerBytes: safeMatrixInteger(result.stateProfile?.controllerBytes, 0, MAX_PLUGIN_STATE_BYTES),
      automation: safeMatrixText(automationLaneStatus(result), 64),
      automationLanePointCount: safeMatrixInteger(result.automationLanePointCount, 0, 4096),
      midiEventCount: safeMatrixInteger(result.midiEventCount, 0, 4096),
      midiTiming: safeMatrixText(midiTimingStatus(result), 64),
      midiTimingFlags: safeMatrixArray(result.midiTimingProfile?.flags, 64),
      midiTimingUniqueOffsetCount: safeMatrixInteger(result.midiTimingProfile?.uniqueTimeCount, 0, 4096),
      midiTimingMinOffset: safeMatrixInteger(result.midiTimingProfile?.minTime, 0, 8191),
      midiTimingMaxOffset: safeMatrixInteger(result.midiTimingProfile?.maxTime, 0, 8191),
      midiTimingBlockSize: safeMatrixInteger(result.midiTimingProfile?.blockSize, 1, 8192),
      midiTimingInvalidOffsetCount: safeMatrixInteger(result.midiTimingProfile?.invalidTimeCount, 0, 4096),
      midiControllerEventCount: safeMatrixInteger(
        result.midiControllerEventProfile?.eventCount ?? result.midiControllerEventCount,
        0,
        4096
      ),
      midiControllerFamilyCount: safeMatrixInteger(result.midiControllerEventProfile?.controllerFamilyCount, 0, 16),
      midiControllerInvalidNumberCount: safeMatrixInteger(result.midiControllerEventProfile?.invalidControllerNumberCount, 0, 4096),
      midiControllerInvalidRouteCount: safeMatrixInteger(result.midiControllerEventProfile?.invalidControllerRouteCount, 0, 4096),
      midiControllerInvalidValueCount: safeMatrixInteger(result.midiControllerEventProfile?.invalidControllerValueCount, 0, 4096),
      midiControllerFlags: safeMatrixArray(result.midiControllerEventProfile?.flags, 64),
      midiControllerEventTypes: safeMatrixArray(result.midiControllerEventProfile?.types, 64),
      midiControllerNumbers: safeMatrixIntegerArray(result.midiControllerEventProfile?.controllers, 0, 127),
      midiControllerChannels: safeMatrixIntegerArray(result.midiControllerEventProfile?.channels, 0, 15),
      midiControllerEventBuses: safeMatrixIntegerArray(result.midiControllerEventProfile?.eventBuses, 0, 31),
      vst3MidiControllerEvents: safeMatrixText(vst3MidiControllerEventStatus(result), 64),
      midiProgramChangeEventCount: safeMatrixInteger(
        result.midiProgramChangeEventProfile?.eventCount ?? result.midiProgramChangeEventCount,
        0,
        4096
      ),
      midiProgramChangeInvalidNumberCount: safeMatrixInteger(result.midiProgramChangeEventProfile?.invalidProgramNumberCount, 0, 4096),
      midiProgramChangeInvalidRouteCount: safeMatrixInteger(result.midiProgramChangeEventProfile?.invalidProgramRouteCount, 0, 4096),
      midiProgramChangeFlags: safeMatrixArray(result.midiProgramChangeEventProfile?.flags, 64),
      midiProgramChangePrograms: safeMatrixIntegerArray(result.midiProgramChangeEventProfile?.programs, 0, 127),
      midiProgramChangeChannels: safeMatrixIntegerArray(result.midiProgramChangeEventProfile?.channels, 0, 15),
      midiProgramChangeEventBuses: safeMatrixIntegerArray(result.midiProgramChangeEventProfile?.eventBuses, 0, 31),
      vst3MidiProgramChangeEvents: safeMatrixText(vst3MidiProgramChangeEventStatus(result), 64),
      hostTransport: safeMatrixText(result.hostTransport ?? "missing", 64),
      fileGrantSampleLoad: safeMatrixText(result.fileGrantSampleLoad ?? "missing", 64),
      fileGrantCacheDirectoryOpen: safeMatrixText(result.fileGrantCacheDirectoryOpen ?? "missing", 64),
      fileGrantLicenseLoad: safeMatrixText(result.fileGrantLicenseLoad ?? "missing", 64),
      fileGrantOtherPresetLoad: safeMatrixText(result.fileGrantOtherPresetLoad ?? "missing", 64),
      nativeEditor: safeMatrixText(nativeEditorStatus(result, options), 64),
      nativeEditorTransport: safeMatrixText(result.nativeEditor?.transport, 64),
      featureStatus: summarizeFeatureStatus(result, options),
      fileGrantOperations: safeMatrixArray(result.fileGrantOperations, 64)
    });
  });
}

function summarizeFeatureStatus(result, options) {
  return {
    instantiation: phaseGroupStatus(result, ["createInstance"]),
    parameters: parameterFeatureStatus(result),
    presetSnapshots: safeMatrixText(result.listedPreset ?? "missing", 64),
    vst3ProgramData: safeMatrixText(result.vst3ProgramData ?? "missing", 64),
    state: phaseGroupStatus(result, ["getState", "setState"]),
    fileGrants: fileGrantFeatureStatus(result),
    midiEvents: phaseGroupStatus(result, ["sendMidiEvents", "sendMidiNoteOff"]),
    automation: safeMatrixText(automationLaneStatus(result), 64),
    transport: hostTransportFeatureStatus(result),
    rendering: renderingFeatureStatus(result),
    busLayouts: busLayoutFeatureStatus(result),
    latencyTail: phaseGroupStatus(result, ["getLatency", "getTailTime"]),
    editor: nativeEditorStatus(result, options)
  };
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
  if (workflowStatuses.length > 0 && workflowStatuses.every((status) => status === "skipped")) {
    return "skipped";
  }
  if (Array.isArray(result.fileGrantOperations) && result.fileGrantOperations.length > 0) {
    return "advertised";
  }
  return "missing";
}

function renderingFeatureStatus(result) {
  if (hasFailedPhase(result, ["processAudioBlock"])) {
    return "failed";
  }
  return result.renderSignal === "signal" || result.renderSignal === "silent" || hasOkPhase(result, "processAudioBlock")
    ? "passed"
    : "missing";
}

function hostTransportFeatureStatus(result) {
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

function nativeEditorStatus(result, options) {
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

function phaseGroupStatus(result, names) {
  if (hasFailedPhase(result, names)) {
    return "failed";
  }
  if (names.every((name) => hasOkPhase(result, name))) {
    return "passed";
  }
  return names.some((name) => hasOkPhase(result, name)) ? "partial" : "missing";
}

function hasFailedPhase(result, names) {
  const phaseNames = new Set(names);
  return (result.phases ?? []).some((phaseResult) => phaseNames.has(phaseResult.name) && phaseResult.ok === false);
}

function hasOkPhase(result, name) {
  return (result.phases ?? []).some((phaseResult) => phaseResult.name === name && phaseResult.ok === true);
}

function summarizeFeatureCoverage(results, options) {
  return {
    listedPresets: countStatuses(results, "listedPreset"),
    vst3ProgramData: countStatuses(results, "vst3ProgramData"),
    vst3ProgramDataTargets: countBy(results, vst3ProgramDataProfileStatus),
    vst3ProgramLists: countVst3ProgramLists(results),
    parameterMetadata: countParameterMetadata(results),
    parameterProfiles: countBy(results, parameterProfileStatus),
    parameterDisplayInput: countStatuses(results, "parameterDisplayInput"),
    stateProfiles: countBy(results, stateProfileStatus),
    fileGrantStateRestore: countStatuses(results, "fileGrantStateRestore"),
    fileGrantPresetLoad: countStatuses(results, "fileGrantPresetLoad"),
    fileGrantStateSave: countStatuses(results, "fileGrantStateSave"),
    fileGrantSavedStateRestore: countStatuses(results, "fileGrantSavedStateRestore"),
    fileGrantSampleLoad: countStatuses(results, "fileGrantSampleLoad"),
    fileGrantCacheDirectoryOpen: countStatuses(results, "fileGrantCacheDirectoryOpen"),
    fileGrantLicenseLoad: countStatuses(results, "fileGrantLicenseLoad"),
    fileGrantOtherPresetLoad: countStatuses(results, "fileGrantOtherPresetLoad"),
    fileGrantOperations: countFileGrantOperations(results),
    busLayouts: countBusLayouts(results),
    vst3EventProfiles: countVst3EventProfiles(results),
    vst3MidiControllerEvents: countBy(results, vst3MidiControllerEventStatus),
    vst3MidiProgramChangeEvents: countBy(results, vst3MidiProgramChangeEventStatus),
    midiTiming: countBy(results, midiTimingStatus),
    automationLanes: countAutomationLanes(results),
    hostTransport: countStatuses(results, "hostTransport"),
    latencyTail: countBy(results, latencyTailStatus),
    renderSignals: countStatuses(results, "renderSignal"),
    outputBusSignals: countBy(results, outputBusSignalStatus),
    nativeEditor: countNativeEditor(results, options)
  };
}

function countStatuses(results, field) {
  const counts = {};
  for (const result of results) {
    const status = result[field] === undefined ? "missing" : String(result[field]);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function countBy(results, statusForResult) {
  const counts = {};
  for (const result of results) {
    const status = String(statusForResult(result));
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function countAutomationLanes(results) {
  const counts = {};
  for (const result of results) {
    const status = automationLaneStatus(result);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function countParameterMetadata(results) {
  const counts = {};
  for (const result of results) {
    const status = parameterMetadataStatus(result);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function countVst3ProgramLists(results) {
  const counts = {};
  for (const result of results) {
    const status = vst3ProgramListStatus(result);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function automationLaneStatus(result) {
  return Number.isInteger(result.automationLanePointCount)
    ? "applied"
    : result.automationLaneSkipped
      ? `skipped-${result.automationLaneSkipped}`
      : "missing";
}

function parameterMetadataStatus(result) {
  return result.parameterMetadataAtLimit === true
    ? "at-limit"
    : Number.isInteger(result.parameterCount)
      ? result.parameterCount > 0 ? "listed" : "none"
      : "missing";
}

function parameterProfileStatus(result) {
  if (result.parameterProfile?.category) {
    return result.parameterProfile.category;
  }
  return Number.isInteger(result.parameterCount)
    ? result.parameterCount > 0 ? "listed" : "none"
    : "missing";
}

function stateProfileStatus(result) {
  if (result.stateProfile?.category) {
    return result.stateProfile.category;
  }
  if (hasFailedPhase(result, ["getState"])) {
    return "failed";
  }
  return hasOkPhase(result, "getState") ? "unprofiled" : "missing";
}

function vst3MidiControllerEventStatus(result) {
  if (result.vst3MidiControllerEvents !== undefined) {
    return result.vst3MidiControllerEvents;
  }
  return String(result.format ?? "").toLowerCase() === "vst3" ? "missing" : "skipped-format";
}

function vst3MidiProgramChangeEventStatus(result) {
  if (result.vst3MidiProgramChangeEvents !== undefined) {
    return result.vst3MidiProgramChangeEvents;
  }
  return String(result.format ?? "").toLowerCase() === "vst3" ? "missing" : "skipped-format";
}

function midiTimingStatus(result) {
  if (result.midiTimingProfile?.category) {
    return result.midiTimingProfile.category;
  }
  return Number.isInteger(result.midiEventCount) ? "unprofiled" : "missing";
}

function vst3ProgramDataProfileStatus(result) {
  if (result.vst3ProgramDataProfile?.category) {
    return result.vst3ProgramDataProfile.category;
  }
  return String(result.format ?? "").toLowerCase() === "vst3" ? "missing" : "skipped-format";
}

function vst3ProgramListStatus(result) {
  return String(result.format ?? "").toLowerCase() !== "vst3"
    ? "skipped-format"
    : Number.isInteger(result.vst3ProgramListCount)
      ? result.vst3ProgramListCount > 0 ? "listed" : "none"
      : "missing";
}

function latencyTailStatus(result) {
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

function outputBusSignalStatus(result) {
  if (hasFailedPhase(result, ["processAudioBlock"])) {
    return "failed";
  }
  return result.outputBusSignalProfile?.category ?? (hasOkPhase(result, "processAudioBlock") ? "unprofiled" : "missing");
}

function countBusLayouts(results) {
  const counts = {};
  for (const result of results) {
    const category = result.busProfile?.category ? String(result.busProfile.category) : "missing";
    counts[category] = (counts[category] ?? 0) + 1;
    for (const flag of result.busProfile?.flags ?? []) {
      if (flag === "main-bus") {
        continue;
      }
      const key = `flag:${flag}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

function countFileGrantOperations(results) {
  const counts = {};
  for (const result of results) {
    if (!Array.isArray(result.fileGrantOperations)) {
      counts.missing = (counts.missing ?? 0) + 1;
      continue;
    }

    const knownOperations = uniqueKnownFileGrantOperations(result.fileGrantOperations);
    if (knownOperations.length === 0) {
      counts.none = (counts.none ?? 0) + 1;
    }
    for (const operation of knownOperations) {
      counts[operation] = (counts[operation] ?? 0) + 1;
    }
    if (result.fileGrantOperations.some((operation) => !KNOWN_FILE_GRANT_OPERATIONS.has(String(operation)))) {
      counts.unknown = (counts.unknown ?? 0) + 1;
    }
  }
  return counts;
}

function uniqueKnownFileGrantOperations(operations) {
  return [...new Set(operations.map((operation) => String(operation)).filter((operation) =>
    KNOWN_FILE_GRANT_OPERATIONS.has(operation)
  ))];
}

function countVst3EventProfiles(results) {
  const counts = {};
  for (const result of results) {
    const category = result.vst3EventProfile?.category
      ? String(result.vst3EventProfile.category)
      : String(result.format ?? "").toLowerCase() === "vst3"
        ? "missing"
        : "skipped-format";
    counts[category] = (counts[category] ?? 0) + 1;
    for (const flag of result.vst3EventProfile?.flags ?? []) {
      if (flag === "no-note-expressions") {
        continue;
      }
      const key = `flag:${flag}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

function countNativeEditor(results, options) {
  if (!options.nativeEditorBroker) {
    return results.length > 0 ? { "not-requested": results.length } : {};
  }
  const counts = {};
  for (const result of results) {
    const status = nativeEditorStatus(result, options);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function printFeatureCoverage(coverage, stream) {
  stream.log("Feature coverage:");
  for (const [label, counts] of [
    ["listed presets", coverage.listedPresets],
    ["VST3 program data", coverage.vst3ProgramData],
    ["VST3 program-data targets", coverage.vst3ProgramDataTargets],
    ["VST3 program lists", coverage.vst3ProgramLists],
    ["parameter metadata", coverage.parameterMetadata],
    ["parameter profiles", coverage.parameterProfiles],
    ["display-text input", coverage.parameterDisplayInput],
    ["state profiles", coverage.stateProfiles],
    ["file grant state restore", coverage.fileGrantStateRestore],
    ["file grant preset load", coverage.fileGrantPresetLoad],
    ["file grant state save", coverage.fileGrantStateSave],
    ["file grant saved-state restore", coverage.fileGrantSavedStateRestore],
    ["file grant sample load", coverage.fileGrantSampleLoad],
    ["file grant cache directory open", coverage.fileGrantCacheDirectoryOpen],
    ["file grant license load", coverage.fileGrantLicenseLoad],
    ["file grant explicit other preset load", coverage.fileGrantOtherPresetLoad],
    ["file grant operations advertised", coverage.fileGrantOperations],
    ["bus layouts", coverage.busLayouts],
    ["VST3 event metadata", coverage.vst3EventProfiles],
    ["VST3 MIDI-controller events", coverage.vst3MidiControllerEvents],
    ["VST3 MIDI program-change events", coverage.vst3MidiProgramChangeEvents],
    ["MIDI timing", coverage.midiTiming],
    ["automation lanes", coverage.automationLanes],
    ["host transport", coverage.hostTransport],
    ["latency/tail", coverage.latencyTail],
    ["render signal", coverage.renderSignals],
    ["output-bus signal", coverage.outputBusSignals],
    ["native editor broker", coverage.nativeEditor]
  ]) {
    stream.log(`- ${label}: ${formatCounts(counts)}`);
  }
}

function formatCounts(counts) {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    return "0 observed";
  }
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
}

function printFailureSummary(failures, stream) {
  stream.log("Failures:");
  for (const failure of failures) {
    const code = failure.error?.code ?? failure.error?.message ?? "unknown_error";
    stream.log(`- ${failure.pluginId}: ${failure.phase}: ${code}`);
  }
}

function firstFailedPhase(result) {
  return result.phases?.find((phaseResult) => !phaseResult.ok);
}

function failureCode(phaseResult) {
  return phaseResult.error?.code ?? phaseResult.error?.message ?? "unknown_error";
}
