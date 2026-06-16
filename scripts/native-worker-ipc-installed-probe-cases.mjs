import { assertNoNativeLaunchData, nativeStateFileText } from "./installed-plugin-probe-file-grants.mjs";
import { summarizeProbeVst3Events } from "./installed-plugin-probe-events.mjs";
import { installedProbeErrorSummary } from "./installed-plugin-probe-errors.mjs";
import { installedProbeFormats } from "./installed-plugin-probe-formats.mjs";
import { summarizeProbeBusLayout } from "./installed-plugin-probe-layouts.mjs";
import { midiEventsForBlock } from "./installed-plugin-probe-midi.mjs";
import { firstListedPreset, firstVst3ProgramDataTarget } from "./installed-plugin-probe-programs.mjs";
import { summarizeProbeRenderSignal } from "./installed-plugin-probe-rendering.mjs";
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
  check(
    installedProbeReportMode({ SOUNDBRIDGE_PROBE_REPORT: "matrix" }) === "matrix",
    "installed plugin probe accepts matrix report mode"
  );

  const passedFeaturePhases = [
    "createInstance",
    "getParameters",
    "setParameter",
    "setParameterDisplayValue",
    "setPreset",
    "getVst3ProgramData",
    "setVst3ProgramData",
    "getState",
    "setState",
    "useFileGrantLoadPreset",
    "useFileGrantRestoreState",
    "useFileGrantSaveStateDirectory",
    "useFileGrantRestoreSavedState",
    "useFileGrantLoadSample",
    "useFileGrantOpenCacheDirectory",
    "useFileGrantLoadLicense",
    "useFileGrantOtherPreset",
    "getLatency",
    "getTailTime",
    "setAutomationLane",
    "sendMidiEvents",
    "processAudioBlock",
    "clearAutomationLane",
    "sendMidiNoteOff",
    "openNativeEditor",
    "closeNativeEditor"
  ].map((name) => ({ name, ok: true }));
  const coverageResults = [
    {
      ok: true,
      format: "vst3",
      pluginId: "vst3:neutral-effect",
      name: "Neutral Effect",
      vendor: "Example Vendor",
      listedPreset: "applied",
      vst3ProgramData: "restored",
      vst3ProgramListCount: 2,
      parameterCount: 1024,
      parameterMetadataAtLimit: true,
      parameterDisplayInput: "applied",
      fileGrantStateRestore: "applied",
      fileGrantPresetLoad: "applied",
      fileGrantStateSave: "applied",
      fileGrantSavedStateRestore: "applied",
      fileGrantSampleLoad: "applied",
      fileGrantCacheDirectoryOpen: "skipped-unadvertised",
      fileGrantLicenseLoad: "skipped-unadvertised",
      fileGrantOtherPresetLoad: "applied",
      fileGrantOperations: ["loadPreset", "restoreState", "saveStateDirectory", "loadSample", "other"],
      busProfile: { category: "sidechain", flags: ["sidechain-input", "multi-input"] },
      vst3EventProfile: {
        category: "non-main-event-bus",
        flags: ["note-expressions", "non-main-event-bus", "multi-event-bus", "non-main-channel", "multi-channel", "text-expression"],
        noteExpressionCount: 2,
        eventBuses: [0, 2],
        channels: [0, 3]
      },
      automationLanePointCount: 2,
      hostTransport: "accepted",
      renderSignal: "signal",
      nativeEditor: { transport: "native-broker" },
      phases: passedFeaturePhases
    },
    {
      ok: true,
      format: "au",
      pluginId: "au:neutral-instrument",
      name: "/Users/test/Neutral.component",
      vendor: "Neutral Vendor",
      listedPreset: "skipped",
      vst3ProgramData: "skipped-format",
      parameterCount: 0,
      parameterDisplayInput: "skipped",
      fileGrantSampleLoad: "skipped-unadvertised",
      fileGrantCacheDirectoryOpen: "applied",
      fileGrantLicenseLoad: "applied",
      fileGrantOtherPresetLoad: "skipped-unadvertised",
      fileGrantOperations: ["loadPreset", "openCacheDirectory", "loadLicense"],
      busProfile: { category: "multi-output-instrument", flags: ["multi-output", "multi-output-instrument"] },
      automationLaneSkipped: "lv2-block-size-profile",
      renderSignal: "silent"
    }
  ];
  const coverageSummary = summarizeProbeResults(coverageResults, { nativeEditorBroker: true });
  check(
    coverageSummary.coverage.listedPresets.applied === 1 &&
      coverageSummary.coverage.vst3ProgramData.restored === 1 &&
      coverageSummary.coverage.vst3ProgramLists.listed === 1 &&
      coverageSummary.coverage.parameterMetadata["at-limit"] === 1 &&
      coverageSummary.coverage.parameterMetadata.none === 1 &&
      coverageSummary.coverage.fileGrantOperations.loadSample === 1 &&
      coverageSummary.coverage.fileGrantOperations.openCacheDirectory === 1 &&
      coverageSummary.coverage.fileGrantOperations.loadLicense === 1 &&
      coverageSummary.coverage.fileGrantSampleLoad.applied === 1 &&
      coverageSummary.coverage.fileGrantCacheDirectoryOpen.applied === 1 &&
      coverageSummary.coverage.fileGrantLicenseLoad.applied === 1 &&
      coverageSummary.coverage.fileGrantOtherPresetLoad.applied === 1 &&
      coverageSummary.coverage.fileGrantOperations.other === 1 &&
      coverageSummary.coverage.busLayouts.sidechain === 1 &&
      coverageSummary.coverage.busLayouts["flag:multi-output-instrument"] === 1 &&
      coverageSummary.coverage.vst3EventProfiles["non-main-event-bus"] === 1 &&
      coverageSummary.coverage.vst3EventProfiles["flag:text-expression"] === 1 &&
      coverageSummary.coverage.automationLanes.applied === 1 &&
      coverageSummary.coverage.hostTransport.accepted === 1 &&
      coverageSummary.coverage.renderSignals.signal === 1 &&
      coverageSummary.coverage.renderSignals.silent === 1 &&
      coverageSummary.coverage.nativeEditor.opened === 1,
    "installed plugin probe summarizes feature coverage"
  );
  check(
    coverageSummary.matrix.length === 2 &&
      coverageSummary.matrix[0].pluginId === "vst3:neutral-effect" &&
      coverageSummary.matrix[0].renderSignal === "signal" &&
      coverageSummary.matrix[0].vst3ProgramLists === "listed" &&
      coverageSummary.matrix[0].parameterMetadata === "at-limit" &&
      coverageSummary.matrix[0].automation === "applied" &&
      coverageSummary.matrix[0].hostTransport === "accepted" &&
      coverageSummary.matrix[0].fileGrantSampleLoad === "applied" &&
      coverageSummary.matrix[0].fileGrantOtherPresetLoad === "applied" &&
      coverageSummary.matrix[0].featureStatus.instantiation === "passed" &&
      coverageSummary.matrix[0].featureStatus.parameters === "passed" &&
      coverageSummary.matrix[0].featureStatus.fileGrants === "passed" &&
      coverageSummary.matrix[0].featureStatus.transport === "accepted" &&
      coverageSummary.matrix[0].featureStatus.rendering === "passed" &&
      coverageSummary.matrix[0].featureStatus.editor === "passed" &&
      coverageSummary.matrix[1].name === "[local-path]" &&
      coverageSummary.matrix[1].vst3ProgramLists === "skipped-format" &&
      coverageSummary.matrix[1].fileGrantCacheDirectoryOpen === "applied" &&
      coverageSummary.matrix[1].fileGrantLicenseLoad === "applied" &&
      coverageSummary.matrix[1].fileGrantOtherPresetLoad === "skipped-unadvertised" &&
      coverageSummary.matrix[1].featureStatus.fileGrants === "passed" &&
      coverageSummary.matrix[1].fileGrantOperations.includes("loadLicense"),
    "installed plugin probe builds path-free compatibility matrix entries"
  );
  check(
    summarizeProbeResults(coverageResults).coverage.nativeEditor["not-requested"] === 2,
    "installed plugin probe marks native editor coverage as not requested by default"
  );
  check(
    summarizeProbeResults([{ ok: true, format: "vst3", vst3ProgramListCount: 0 }]).coverage.vst3ProgramLists.none === 1,
    "installed plugin probe summarizes VST3 plugins with no program lists"
  );
  const pathError = Object.assign(
    new Error(
      "failed to load /Library/Audio/Plug-Ins/VST3/Private Plugin.vst3 and file:///Users/test/Secrets/license.key from C:\\Users\\test\\Private Plugin.vst3"
    ),
    { code: "native_worker_failed" }
  );
  const pathErrorSummary = installedProbeErrorSummary(pathError);
  check(
    pathErrorSummary.code === "native_worker_failed" &&
      pathErrorSummary.message.includes("[local-path]") &&
      !pathErrorSummary.message.includes("/Library/Audio") &&
      !pathErrorSummary.message.includes("file:///") &&
      !pathErrorSummary.message.includes("C:\\Users"),
    "installed plugin probe redacts local paths from error messages"
  );
  const pathCodeSummary = installedProbeErrorSummary(new Error("/Users/test/Private Plugin.vst3: failed"));
  check(
    pathCodeSummary.code === "unknown_error" &&
      pathCodeSummary.message.startsWith("[local-path]: failed"),
    "installed plugin probe redacts local paths from derived error codes"
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
      coverageLines.some((line) => line.includes("VST3 program lists:")) &&
      coverageLines.some((line) => line.includes("parameter metadata:")) &&
      coverageLines.some((line) => line.includes("file grant sample load:")) &&
      coverageLines.some((line) => line.includes("file grant cache directory open:")) &&
      coverageLines.some((line) => line.includes("file grant license load:")) &&
      coverageLines.some((line) => line.includes("file grant explicit other preset load:")) &&
      coverageLines.some((line) => line.includes("file grant operations advertised:")) &&
      coverageLines.some((line) => line.includes("VST3 event metadata:")) &&
      coverageLines.some((line) => line.includes("host transport:")) &&
      coverageLines.some((line) => line.includes("render signal:")) &&
      coverageLines.some((line) => line.includes("bus layouts:")),
    "installed plugin probe summary prints feature coverage"
  );
  const matrixLines = [];
  createInstalledProbeReporter({
    formats: new Set(["vst3"]),
    maxBlockSize: 64,
    mode: "matrix",
    stream: { log: (line) => matrixLines.push(line) }
  }).printSummary([
    ...coverageResults,
    {
      ok: false,
      pluginId: "/Users/test/Failed.vst3",
      format: "vst3",
      phases: [{ name: "createInstance", ok: false, error: { code: "/Users/test/failed.vst3: bad" } }]
    }
  ]);
  const matrixReport = JSON.parse(matrixLines.join("\n"));
  check(
    matrixReport.matrix.length === 3 &&
      matrixReport.matrix[2].pluginId === "[local-path]" &&
      matrixReport.matrix[2].failedPhase === "createInstance" &&
      matrixReport.matrix[2].failureCode === "[local-path]: bad" &&
      matrixReport.matrix[2].featureStatus.instantiation === "failed",
    "installed plugin probe prints compact compatibility matrix JSON"
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

  const vst3EventProfile = summarizeProbeVst3Events({
    format: "vst3",
    vst3NoteExpressions: [
      { typeId: 0, busIndex: 0, channel: 0 },
      { typeId: 6, busIndex: 2, channel: 3, associatedParameterId: "param-1" }
    ]
  });
  check(
    vst3EventProfile.category === "non-main-event-bus" &&
      vst3EventProfile.noteExpressionCount === 2 &&
      JSON.stringify(vst3EventProfile.eventBuses) === JSON.stringify([0, 2]) &&
      vst3EventProfile.flags.includes("text-expression") &&
      vst3EventProfile.flags.includes("associated-parameter"),
    "installed plugin probe classifies VST3 event metadata coverage"
  );
  check(
    summarizeProbeRenderSignal({ channels: [[0, 0]], outputBuses: [{ index: 1, channels: [[0, 0.25]] }] }) === "signal" &&
      summarizeProbeRenderSignal({ channels: [[0, 0]], outputBuses: [{ index: 0, channels: [[0, 0]] }] }) === "silent" &&
      summarizeProbeRenderSignal({ channels: [], outputBuses: [] }) === "missing",
    "installed plugin probe classifies render signal coverage"
  );
  const vst3MidiEvents = midiEventsForBlock("vst3", 64, 64);
  check(
    vst3MidiEvents.some((event) => event.type === "noteExpression" && event.noteId === 77) &&
      vst3MidiEvents.some((event) => event.type === "noteExpressionText" && event.text === "probe" && event.noteId === 77) &&
      midiEventsForBlock("au", 64, 64).every((event) => !event.type.startsWith("noteExpression")),
    "installed plugin probe sends VST3 note-expression value and text coverage"
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
      firstVst3ProgramDataTarget({ vst3ProgramLists: [{ id: 4, programDataSupported: true, programs: [] }] }) === undefined &&
      firstVst3ProgramDataTarget({
        vst3ProgramLists: [{ id: "bad", programDataSupported: true, programs: [{ index: 0 }] }]
      }) === undefined &&
      firstVst3ProgramDataTarget({
        vst3ProgramLists: [{ id: 5, programDataSupported: true, programs: [{ index: -1 }, { index: 256 }] }]
      }) === undefined,
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
