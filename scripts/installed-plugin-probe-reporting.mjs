const REPORT_MODES = new Set(["full", "summary", "json"]);

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
    parameterDisplayInput: countStatuses(results, "parameterDisplayInput"),
    fileGrantStateRestore: countStatuses(results, "fileGrantStateRestore"),
    fileGrantPresetLoad: countStatuses(results, "fileGrantPresetLoad"),
    fileGrantStateSave: countStatuses(results, "fileGrantStateSave"),
    fileGrantSavedStateRestore: countStatuses(results, "fileGrantSavedStateRestore"),
    busLayouts: countBusLayouts(results),
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
    ["display-text input", coverage.parameterDisplayInput],
    ["file grant state restore", coverage.fileGrantStateRestore],
    ["file grant preset load", coverage.fileGrantPresetLoad],
    ["file grant state save", coverage.fileGrantStateSave],
    ["file grant saved-state restore", coverage.fileGrantSavedStateRestore],
    ["bus layouts", coverage.busLayouts],
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
