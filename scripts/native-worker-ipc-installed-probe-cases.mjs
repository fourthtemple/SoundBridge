import { assertNoNativeLaunchData, nativeStateFileText } from "./installed-plugin-probe-file-grants.mjs";
import { installedProbeFormats } from "./installed-plugin-probe-formats.mjs";
import { summarizeProbeBusLayout } from "./installed-plugin-probe-layouts.mjs";
import { firstListedPreset, firstVst3ProgramDataTarget } from "./installed-plugin-probe-programs.mjs";
import {
  createInstalledProbeReporter,
  installedProbeReportMode,
  summarizeProbeResults
} from "./installed-plugin-probe-reporting.mjs";

export function exerciseInstalledProbeSupport({ check }) {
  check(
    JSON.stringify([...installedProbeFormats({})]) === JSON.stringify(["vst3", "au", "lv2"]),
    "installed plugin probe includes VST3, AU, and LV2 by default"
  );
  check(
    JSON.stringify([...installedProbeFormats({ SOUNDBRIDGE_PROBE_FORMATS: " lv2,VST3,lv2 " })]) ===
      JSON.stringify(["lv2", "vst3"]),
    "installed plugin probe normalizes explicit format filters"
  );
  let badProbeFormatCode;
  try {
    installedProbeFormats({ SOUNDBRIDGE_PROBE_FORMATS: "vst2" });
  } catch (error) {
    badProbeFormatCode = error.message;
  }
  check(badProbeFormatCode?.includes("unsupported format"), "installed plugin probe rejects unsupported format filters");
  check(
    installedProbeReportMode({ SOUNDBRIDGE_PROBE_REPORT: "summary" }) === "summary",
    "installed plugin probe accepts summary report mode"
  );

  const coverageResults = [
    {
      ok: true,
      listedPreset: "applied",
      vst3ProgramData: "restored",
      parameterDisplayInput: "applied",
      fileGrantStateRestore: "applied",
      fileGrantPresetLoad: "applied",
      fileGrantStateSave: "applied",
      fileGrantSavedStateRestore: "applied",
      busProfile: { category: "sidechain", flags: ["sidechain-input", "multi-input"] },
      automationLanePointCount: 2,
      nativeEditor: { transport: "native-broker" }
    },
    {
      ok: true,
      listedPreset: "skipped",
      vst3ProgramData: "skipped-format",
      parameterDisplayInput: "skipped",
      busProfile: { category: "multi-output-instrument", flags: ["multi-output", "multi-output-instrument"] },
      automationLaneSkipped: "lv2-block-size-profile"
    }
  ];
  const coverageSummary = summarizeProbeResults(coverageResults, { nativeEditorBroker: true });
  check(
    coverageSummary.coverage.listedPresets.applied === 1 &&
      coverageSummary.coverage.vst3ProgramData.restored === 1 &&
      coverageSummary.coverage.busLayouts.sidechain === 1 &&
      coverageSummary.coverage.busLayouts["flag:multi-output-instrument"] === 1 &&
      coverageSummary.coverage.automationLanes.applied === 1 &&
      coverageSummary.coverage.nativeEditor.opened === 1,
    "installed plugin probe summarizes feature coverage"
  );
  check(
    summarizeProbeResults(coverageResults).coverage.nativeEditor["not-requested"] === 2,
    "installed plugin probe marks native editor coverage as not requested by default"
  );

  const coverageLines = [];
  createInstalledProbeReporter({
    formats: new Set(["vst3", "au", "lv2"]),
    maxBlockSize: 64,
    mode: "summary",
    nativeEditorBroker: true,
    stream: { log: (line) => coverageLines.push(line) }
  }).printSummary(coverageResults);
  check(
    coverageLines.some((line) => line === "Feature coverage:") &&
      coverageLines.some((line) => line.includes("VST3 program data: 1 restored, 1 skipped-format")) &&
      coverageLines.some((line) => line.includes("bus layouts:")),
    "installed plugin probe summary prints feature coverage"
  );

  const sidechainProfile = summarizeProbeBusLayout(
    { kind: "effect" },
    {
      inputChannels: 2,
      outputChannels: 2,
      inputBuses: 2,
      outputBuses: 1,
      inputBusLayouts: [
        { index: 0, channels: 2, type: "main", active: true },
        { index: 1, channels: 1, type: "aux", active: true }
      ],
      outputBusLayouts: [{ index: 0, channels: 2, type: "main", active: true }]
    }
  );
  const multiOutputInstrumentProfile = summarizeProbeBusLayout(
    { kind: "instrument" },
    {
      inputChannels: 0,
      outputChannels: 2,
      inputBuses: 0,
      outputBuses: 2,
      outputBusLayouts: [
        { index: 0, channels: 2, type: "main", active: true },
        { index: 1, channels: 2, type: "aux", active: true }
      ]
    }
  );
  check(
    sidechainProfile.category === "sidechain" &&
      sidechainProfile.flags.includes("sidechain-input") &&
      multiOutputInstrumentProfile.category === "multi-output-instrument" &&
      multiOutputInstrumentProfile.flags.includes("multi-output-instrument"),
    "installed plugin probe classifies bus-layout coverage"
  );

  const vst3ProbeState = nativeStateEnvelope({
    format: "vst3",
    component: "Y29tcG9uZW50",
    controller: "Y29udHJvbGxlcg=="
  });
  check(
    nativeStateFileText("vst3", vst3ProbeState) === "Y29tcG9uZW50 Y29udHJvbGxlcg==\n",
    "installed plugin probe exports bounded VST3 state files"
  );
  const lv2ProbeState = nativeStateEnvelope({ format: "lv2", state: "bHYyLXN0YXRl" });
  check(
    nativeStateFileText("lv2", lv2ProbeState) === "bHYyLXN0YXRl\n" &&
      nativeStateFileText("au", lv2ProbeState) === "",
    "installed plugin probe exports only matching native state files"
  );

  let nativeLaunchLeakCode;
  try {
    assertNoNativeLaunchData(
      { plugin: { pluginId: "vst3:test", metadata: { path: "/private/plugin.vst3" } } },
      "installed probe response",
      probeAssert
    );
  } catch (error) {
    nativeLaunchLeakCode = error.code;
  }
  check(nativeLaunchLeakCode === "native_editor_launch_data_leak", "installed plugin probe rejects native launch data leaks");
  check(
    firstListedPreset({ presets: [{ id: "init", name: "Init" }] })?.id === "init" &&
      firstListedPreset({ presets: [{ id: "x".repeat(65) }] }) === undefined,
    "installed plugin probe selects bounded listed presets"
  );
  const programTarget = firstVst3ProgramDataTarget({
    vst3ProgramLists: [
      { id: 1, programDataSupported: false, programs: [{ index: 0 }] },
      { id: 2, programDataSupported: true, programs: [{ index: 3 }] }
    ]
  });
  check(
    programTarget?.programListId === 2 &&
      programTarget.programIndex === 3 &&
      firstVst3ProgramDataTarget({ vst3ProgramLists: [{ id: 4, programDataSupported: true, programs: [] }] }) === undefined,
    "installed plugin probe selects bounded VST3 program-data targets"
  );
}

function probeAssert(condition, code, message) {
  if (!condition) {
    throw Object.assign(new Error(message), { code });
  }
}

function nativeStateEnvelope(nativeState) {
  return Buffer.from(JSON.stringify({ nativeState }), "utf8").toString("base64");
}
