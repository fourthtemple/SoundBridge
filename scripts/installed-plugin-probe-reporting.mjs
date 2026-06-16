import { redactLocalPaths } from "./local-path-redaction.mjs";

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
      busCategory: safeMatrixText(result.busProfile?.category ?? "missing", 64),
      busFlags: safeMatrixArray(result.busProfile?.flags, 64),
      busInputCount: safeMatrixInteger(result.busProfile?.inputBuses, 0, 32),
      busOutputCount: safeMatrixInteger(result.busProfile?.outputBuses, 0, 32),
      busActiveInputCount: safeMatrixInteger(result.busProfile?.activeInputBuses, 0, 32),
      busActiveOutputCount: safeMatrixInteger(result.busProfile?.activeOutputBuses, 0, 32),
      busInputChannels: safeMatrixInteger(result.busProfile?.inputChannels, 0, 32),
      busOutputChannels: safeMatrixInteger(result.busProfile?.outputChannels, 0, 32),
      busActiveInputIndexes: safeMatrixIntegerArray(result.busProfile?.activeInputBusIndexes, 0, 31),
      busActiveOutputIndexes: safeMatrixIntegerArray(result.busProfile?.activeOutputBusIndexes, 0, 31),
      vst3EventCategory: safeMatrixText(
        result.vst3EventProfile?.category ??
          (String(result.format ?? "").toLowerCase() === "vst3" ? "missing" : "skipped-format"),
        64
      ),
      vst3EventFlags: safeMatrixArray(result.vst3EventProfile?.flags, 64),
      vst3ProgramData: safeMatrixText(result.vst3ProgramData ?? "missing", 64),
      vst3ProgramDataTarget: safeMatrixText(vst3ProgramDataProfileStatus(result), 64),
      vst3ProgramDataFlags: safeMatrixArray(result.vst3ProgramDataProfile?.flags, 64),
      vst3ProgramDataProgramLists: safeMatrixInteger(result.vst3ProgramDataProfile?.programListCount, 0, 256),
      vst3ProgramDataCapableLists: safeMatrixInteger(result.vst3ProgramDataProfile?.programDataListCount, 0, 256),
      vst3ProgramDataCandidatePrograms: safeMatrixInteger(result.vst3ProgramDataProfile?.candidateProgramCount, 0, 65536),
      vst3ProgramLists: safeMatrixText(vst3ProgramListStatus(result), 64),
      parameterMetadata: safeMatrixText(parameterMetadataStatus(result), 64),
      parameterDisplayInput: safeMatrixText(result.parameterDisplayInput ?? "missing", 64),
      automation: safeMatrixText(automationLaneStatus(result), 64),
      vst3MidiControllerEvents: safeMatrixText(vst3MidiControllerEventStatus(result), 64),
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
    parameterDisplayInput: countStatuses(results, "parameterDisplayInput"),
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
    automationLanes: countAutomationLanes(results),
    hostTransport: countStatuses(results, "hostTransport"),
    renderSignals: countStatuses(results, "renderSignal"),
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

function vst3MidiControllerEventStatus(result) {
  if (result.vst3MidiControllerEvents !== undefined) {
    return result.vst3MidiControllerEvents;
  }
  return String(result.format ?? "").toLowerCase() === "vst3" ? "missing" : "skipped-format";
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

function safeMatrixArray(value, maxBytes) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => safeMatrixText(entry, maxBytes)).filter(Boolean))];
}

function safeMatrixInteger(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function safeMatrixIntegerArray(value, min, max) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((entry) => Number.isInteger(entry) && entry >= min && entry <= max))]
    .sort((left, right) => left - right);
}

function safeMatrixText(value, maxBytes) {
  const text = redactLocalPaths(value).replace(/\u0000/g, "");
  let output = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if ((codePoint >= 0 && codePoint < 0x20) || codePoint === 0x7f) {
      continue;
    }
    if (Buffer.byteLength(output + char, "utf8") > maxBytes) {
      break;
    }
    output += char;
  }
  return output;
}

function removeEmpty(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) =>
      entry !== undefined &&
        entry !== "" &&
        (!Array.isArray(entry) || entry.length > 0)
    )
  );
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
    ["display-text input", coverage.parameterDisplayInput],
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
    ["automation lanes", coverage.automationLanes],
    ["host transport", coverage.hostTransport],
    ["render signal", coverage.renderSignals],
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
