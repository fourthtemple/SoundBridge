const REPORT_MODES = new Set(["full", "summary", "json"]);
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
    throw new Error("SOUNDBRIDGE_PROBE_REPORT must be one of: full, summary, json");
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
      if (mode === "json") {
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
      if (mode === "json") {
        return;
      }
      const status = result.ok ? "ok" : "FAIL";
      const failedPhase = firstFailedPhase(result);
      const suffix = failedPhase ? ` (${failedPhase.name}: ${failureCode(failedPhase)})` : "";
      stream.log(`${status.padEnd(4)} ${result.pluginId}${suffix}`);
    },

    printSummary(results) {
      const summary = summarizeProbeResults(results, { nativeEditorBroker });
      if (mode !== "json") {
        stream.log(`\n${summary.passed}/${summary.total} plugin(s) passed, ${summary.failed} failed.`);
        printFeatureCoverage(summary.coverage, stream);
      }
      if (mode === "summary" && summary.failed > 0) {
        printFailureSummary(summary.failures, stream);
      }
      if (mode === "full" || mode === "json") {
        stream.log(JSON.stringify({ passed: summary.passed, failed: summary.failed, coverage: summary.coverage, results }, null, 2));
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
    failures
  };
}

function summarizeFeatureCoverage(results, options) {
  return {
    listedPresets: countStatuses(results, "listedPreset"),
    vst3ProgramData: countStatuses(results, "vst3ProgramData"),
    vst3ProgramLists: countVst3ProgramLists(results),
    parameterMetadata: countParameterMetadata(results),
    parameterDisplayInput: countStatuses(results, "parameterDisplayInput"),
    fileGrantStateRestore: countStatuses(results, "fileGrantStateRestore"),
    fileGrantPresetLoad: countStatuses(results, "fileGrantPresetLoad"),
    fileGrantStateSave: countStatuses(results, "fileGrantStateSave"),
    fileGrantSavedStateRestore: countStatuses(results, "fileGrantSavedStateRestore"),
    fileGrantOperations: countFileGrantOperations(results),
    busLayouts: countBusLayouts(results),
    vst3EventProfiles: countVst3EventProfiles(results),
    automationLanes: countAutomationLanes(results),
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

function countAutomationLanes(results) {
  const counts = {};
  for (const result of results) {
    const status = Number.isInteger(result.automationLanePointCount)
      ? "applied"
      : result.automationLaneSkipped
        ? `skipped-${result.automationLaneSkipped}`
        : "missing";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function countParameterMetadata(results) {
  const counts = {};
  for (const result of results) {
    const status = result.parameterMetadataAtLimit === true
      ? "at-limit"
      : Number.isInteger(result.parameterCount)
        ? result.parameterCount > 0 ? "listed" : "none"
        : "missing";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function countVst3ProgramLists(results) {
  const counts = {};
  for (const result of results) {
    const status = String(result.format ?? "").toLowerCase() !== "vst3"
      ? "skipped-format"
      : Number.isInteger(result.vst3ProgramListCount)
        ? result.vst3ProgramListCount > 0 ? "listed" : "none"
        : "missing";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
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
    const status = result.nativeEditor?.transport ? "opened" : "missing";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function printFeatureCoverage(coverage, stream) {
  stream.log("Feature coverage:");
  for (const [label, counts] of [
    ["listed presets", coverage.listedPresets],
    ["VST3 program data", coverage.vst3ProgramData],
    ["VST3 program lists", coverage.vst3ProgramLists],
    ["parameter metadata", coverage.parameterMetadata],
    ["display-text input", coverage.parameterDisplayInput],
    ["file grant state restore", coverage.fileGrantStateRestore],
    ["file grant preset load", coverage.fileGrantPresetLoad],
    ["file grant state save", coverage.fileGrantStateSave],
    ["file grant saved-state restore", coverage.fileGrantSavedStateRestore],
    ["file grant operations advertised", coverage.fileGrantOperations],
    ["bus layouts", coverage.busLayouts],
    ["VST3 event metadata", coverage.vst3EventProfiles],
    ["automation lanes", coverage.automationLanes],
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
