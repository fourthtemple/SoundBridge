import {
  assertNoNativeLaunchData,
  nativeStateFileText,
  summarizeNativeStateProfile
} from "./installed-plugin-probe-file-grants.mjs";
import { installedProbeErrorSummary } from "./installed-plugin-probe-errors.mjs";
import { installedProbeFormats } from "./installed-plugin-probe-formats.mjs";
import { summarizeParameterProfile } from "./installed-plugin-probe-parameters.mjs";
import { exerciseInstalledProbeProgramSupport } from "./native-worker-ipc-installed-probe-program-cases.mjs";
import { exerciseInstalledProbeRoutingSupport } from "./native-worker-ipc-installed-probe-routing-cases.mjs";
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
      listedPresetParameterCount: 4,
      vst3ProgramData: "restored",
      vst3ProgramDataSize: 2048,
      vst3ProgramDataProfile: {
        category: "targeted",
        flags: ["bounded-target"],
        programListCount: 2,
        programDataListCount: 1,
        candidateProgramCount: 3,
        unsupportedProgramListCount: 1,
        invalidProgramIndexCount: 2,
        duplicateProgramListIdCount: 1,
        duplicateProgramIndexCount: 1
      },
      vst3ProgramListCount: 2,
      parameterCount: 1024,
      parameterMetadataAtLimit: true,
      parameterProfile: {
        category: "writable",
        flags: ["metadata-at-limit", "writable", "automatable", "read-only", "display-values", "units", "program-change", "vst3-units"],
        parameterCount: 1024,
        automatableCount: 700,
        writableCount: 600,
        readOnlyCount: 100,
        displayValueCount: 512,
        unitCount: 20,
        programChangeCount: 2,
        vst3UnitCount: 4,
        duplicateParameterIdCount: 1
      },
      parameterDisplayInput: "applied",
      stateProfile: {
        category: "component-controller",
        flags: ["component", "controller"],
        stateBytes: 19,
        componentBytes: 9,
        controllerBytes: 10
      },
      fileGrantStateRestore: "applied",
      fileGrantPresetLoad: "applied",
      fileGrantStateSave: "applied",
      fileGrantSavedStateRestore: "applied",
      fileGrantSampleLoad: "applied",
      fileGrantCacheDirectoryOpen: "skipped-unadvertised",
      fileGrantLicenseLoad: "skipped-unadvertised",
      fileGrantOtherPresetLoad: "applied",
      fileGrantOperations: ["loadPreset", "restoreState", "saveStateDirectory", "loadSample", "other"],
      busProfile: {
        category: "sidechain",
        flags: [
          "sidechain-input",
          "multi-input",
          "inactive-input-bus",
          "inactive-output-bus",
          "input-bus-metadata-at-limit",
          "output-bus-metadata-at-limit"
        ],
        inputChannels: 3,
        outputChannels: 2,
        inputBuses: 3,
        outputBuses: 2,
        activeInputBuses: 2,
        activeOutputBuses: 1,
        inactiveInputBuses: 1,
        inactiveOutputBuses: 1,
        activeInputBusIndexes: [0, 1],
        activeOutputBusIndexes: [0],
        inactiveInputBusIndexes: [3],
        inactiveOutputBusIndexes: [1],
        inputBusMetadataAtLimit: true,
        outputBusMetadataAtLimit: true
      },
      vst3EventProfile: {
        category: "non-main-event-bus",
        flags: [
          "note-expressions",
          "non-main-event-bus",
          "multi-event-bus",
          "non-main-channel",
          "multi-channel",
          "text-expression",
          "value-expression",
          "unit-linked-expression",
          "invalid-note-expression",
          "invalid-note-expression-route",
          "duplicate-note-expression-type-id"
        ],
        noteExpressionCount: 4,
        valueExpressionCount: 2,
        textExpressionCount: 2,
        invalidNoteExpressionCount: 1,
        invalidNoteExpressionRouteCount: 1,
        duplicateNoteExpressionTypeIdCount: 1,
        associatedParameterCount: 1,
        unitLinkedExpressionCount: 1,
        eventBuses: [0, 2],
        channels: [0, 3],
        typeIds: [0, 6, 7]
      },
      automationLanePointCount: 2,
      midiEventCount: 16,
      midiControllerEventProfile: {
        eventCount: 6,
        controllerFamilyCount: 3,
        invalidControllerNumberCount: 1,
        invalidControllerRouteCount: 1,
        flags: [
          "controller-events",
          "type:controlChange",
          "type:pitchBend",
          "type:channelPressure",
          "multi-controller-family",
          "non-main-event-bus",
          "non-main-channel",
          "invalid-controller-number",
          "invalid-controller-route"
        ],
        types: ["controlChange", "pitchBend", "channelPressure"],
        controllers: [1, 74],
        channels: [0, 2],
        eventBuses: [0, 1]
      },
      midiControllerEventCount: 6,
      vst3MidiControllerEvents: "accepted",
      midiProgramChangeEventProfile: {
        eventCount: 2,
        invalidProgramNumberCount: 1,
        invalidProgramRouteCount: 1,
        flags: [
          "program-change-events",
          "non-main-event-bus",
          "non-main-channel",
          "invalid-program-number",
          "invalid-program-route"
        ],
        programs: [2, 7],
        channels: [0, 2],
        eventBuses: [0, 1]
      },
      midiProgramChangeEventCount: 2,
      vst3MidiProgramChangeEvents: "accepted",
      hostTransport: "accepted",
      pluginLatencySamples: 32,
      transportLatencySamples: 64,
      reportedLatencySamples: 96,
      tailSamples: 128,
      infiniteTail: false,
      renderedChannels: 2,
      renderSignal: "signal",
      outputBusSignalProfile: {
        category: "main-aux-signal",
        flags: ["main-signal", "aux-signal", "multi-output-signal", "silent-output-bus"],
        outputBusCount: 3,
        signalOutputBusCount: 2,
        silentOutputBusCount: 1,
        signalOutputBusIndexes: [0, 2],
        silentOutputBusIndexes: [1]
      },
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
      stateProfile: {
        category: "single-state",
        flags: ["state-blob"],
        stateBytes: 8
      },
      fileGrantSampleLoad: "skipped-unadvertised",
      fileGrantCacheDirectoryOpen: "applied",
      fileGrantLicenseLoad: "applied",
      fileGrantOtherPresetLoad: "skipped-unadvertised",
      fileGrantOperations: ["loadPreset", "openCacheDirectory", "loadLicense"],
      busProfile: { category: "multi-output-instrument", flags: ["multi-output", "multi-output-instrument"] },
      automationLaneSkipped: "lv2-block-size-profile",
      vst3MidiControllerEvents: "skipped-format",
      vst3MidiProgramChangeEvents: "skipped-format",
      pluginLatencySamples: 0,
      transportLatencySamples: 64,
      reportedLatencySamples: 64,
      tailSamples: 0,
      infiniteTail: true,
      renderSignal: "silent"
    }
  ];
  const coverageSummary = summarizeProbeResults(coverageResults, { nativeEditorBroker: true });
  check(
    coverageSummary.coverage.listedPresets.applied === 1 &&
      coverageSummary.coverage.vst3ProgramData.restored === 1 &&
      coverageSummary.coverage.vst3ProgramDataTargets.targeted === 1 &&
      coverageSummary.coverage.vst3ProgramDataTargets["skipped-format"] === 1 &&
      coverageSummary.coverage.vst3ProgramLists.listed === 1 &&
      coverageSummary.coverage.parameterMetadata["at-limit"] === 1 &&
      coverageSummary.coverage.parameterMetadata.none === 1 &&
      coverageSummary.coverage.parameterProfiles.writable === 1 &&
      coverageSummary.coverage.parameterProfiles.none === 1 &&
      coverageSummary.coverage.stateProfiles["component-controller"] === 1 &&
      coverageSummary.coverage.stateProfiles["single-state"] === 1 &&
      coverageSummary.coverage.fileGrantOperations.loadSample === 1 &&
      coverageSummary.coverage.fileGrantOperations.openCacheDirectory === 1 &&
      coverageSummary.coverage.fileGrantOperations.loadLicense === 1 &&
      coverageSummary.coverage.fileGrantSampleLoad.applied === 1 &&
      coverageSummary.coverage.fileGrantCacheDirectoryOpen.applied === 1 &&
      coverageSummary.coverage.fileGrantLicenseLoad.applied === 1 &&
      coverageSummary.coverage.fileGrantOtherPresetLoad.applied === 1 &&
      coverageSummary.coverage.fileGrantOperations.other === 1 &&
      coverageSummary.coverage.busLayouts.sidechain === 1 &&
      coverageSummary.coverage.busLayouts["flag:inactive-input-bus"] === 1 &&
      coverageSummary.coverage.busLayouts["flag:inactive-output-bus"] === 1 &&
      coverageSummary.coverage.busLayouts["flag:input-bus-metadata-at-limit"] === 1 &&
      coverageSummary.coverage.busLayouts["flag:output-bus-metadata-at-limit"] === 1 &&
      coverageSummary.coverage.busLayouts["flag:multi-output-instrument"] === 1 &&
      coverageSummary.coverage.vst3EventProfiles["non-main-event-bus"] === 1 &&
      coverageSummary.coverage.vst3EventProfiles["flag:text-expression"] === 1 &&
      coverageSummary.coverage.vst3EventProfiles["flag:value-expression"] === 1 &&
      coverageSummary.coverage.vst3EventProfiles["flag:unit-linked-expression"] === 1 &&
      coverageSummary.coverage.vst3EventProfiles["flag:invalid-note-expression"] === 1 &&
      coverageSummary.coverage.vst3EventProfiles["flag:invalid-note-expression-route"] === 1 &&
      coverageSummary.coverage.vst3EventProfiles["flag:duplicate-note-expression-type-id"] === 1 &&
      coverageSummary.coverage.vst3MidiControllerEvents.accepted === 1 &&
      coverageSummary.coverage.vst3MidiControllerEvents["skipped-format"] === 1 &&
      coverageSummary.coverage.vst3MidiProgramChangeEvents.accepted === 1 &&
      coverageSummary.coverage.vst3MidiProgramChangeEvents["skipped-format"] === 1 &&
      coverageSummary.coverage.automationLanes.applied === 1 &&
      coverageSummary.coverage.hostTransport.accepted === 1 &&
      coverageSummary.coverage.latencyTail["latency-tail"] === 1 &&
      coverageSummary.coverage.latencyTail["infinite-tail"] === 1 &&
      coverageSummary.coverage.renderSignals.signal === 1 &&
      coverageSummary.coverage.renderSignals.silent === 1 &&
      coverageSummary.coverage.outputBusSignals["main-aux-signal"] === 1 &&
      coverageSummary.coverage.outputBusSignals.missing === 1 &&
      coverageSummary.coverage.nativeEditor.opened === 1,
    "installed plugin probe summarizes feature coverage"
  );
  check(
    coverageSummary.matrix.length === 2 &&
      coverageSummary.matrix[0].pluginId === "vst3:neutral-effect" &&
      coverageSummary.matrix[0].renderSignal === "signal" &&
      coverageSummary.matrix[0].renderedChannels === 2 &&
      coverageSummary.matrix[0].listedPreset === "applied" &&
      coverageSummary.matrix[0].listedPresetParameterCount === 4 &&
      coverageSummary.matrix[0].vst3ProgramData === "restored" &&
      coverageSummary.matrix[0].vst3ProgramDataBytes === 2048 &&
      coverageSummary.matrix[0].vst3ProgramDataTarget === "targeted" &&
      JSON.stringify(coverageSummary.matrix[0].vst3ProgramDataFlags) === JSON.stringify(["bounded-target"]) &&
      coverageSummary.matrix[0].vst3ProgramDataProgramLists === 2 &&
      coverageSummary.matrix[0].vst3ProgramDataCapableLists === 1 &&
      coverageSummary.matrix[0].vst3ProgramDataCandidatePrograms === 3 &&
      coverageSummary.matrix[0].vst3ProgramDataUnsupportedLists === 1 &&
      coverageSummary.matrix[0].vst3ProgramDataInvalidProgramIndexes === 2 &&
      coverageSummary.matrix[0].vst3ProgramDataDuplicateProgramListIds === 1 &&
      coverageSummary.matrix[0].vst3ProgramDataDuplicateProgramIndexes === 1 &&
      coverageSummary.matrix[0].vst3ProgramLists === "listed" &&
      coverageSummary.matrix[0].parameterMetadata === "at-limit" &&
      coverageSummary.matrix[0].parameterProfile === "writable" &&
      coverageSummary.matrix[0].parameterFlags.includes("metadata-at-limit") &&
      coverageSummary.matrix[0].parameterFlags.includes("vst3-units") &&
      coverageSummary.matrix[0].parameterCount === 1024 &&
      coverageSummary.matrix[0].parameterWritableCount === 600 &&
      coverageSummary.matrix[0].parameterAutomatableCount === 700 &&
      coverageSummary.matrix[0].parameterReadOnlyCount === 100 &&
      coverageSummary.matrix[0].parameterDisplayValueCount === 512 &&
      coverageSummary.matrix[0].parameterUnitCount === 20 &&
      coverageSummary.matrix[0].parameterProgramChangeCount === 2 &&
      coverageSummary.matrix[0].parameterVst3UnitCount === 4 &&
      coverageSummary.matrix[0].parameterDuplicateIdCount === 1 &&
      coverageSummary.matrix[0].stateProfile === "component-controller" &&
      coverageSummary.matrix[0].stateFlags.includes("component") &&
      coverageSummary.matrix[0].stateFlags.includes("controller") &&
      coverageSummary.matrix[0].stateBytes === 19 &&
      coverageSummary.matrix[0].stateComponentBytes === 9 &&
      coverageSummary.matrix[0].stateControllerBytes === 10 &&
      coverageSummary.matrix[0].automation === "applied" &&
      coverageSummary.matrix[0].automationLanePointCount === 2 &&
      coverageSummary.matrix[0].busInputCount === 3 &&
      coverageSummary.matrix[0].busOutputCount === 2 &&
      coverageSummary.matrix[0].busActiveInputCount === 2 &&
      coverageSummary.matrix[0].busActiveOutputCount === 1 &&
      coverageSummary.matrix[0].busInactiveInputCount === 1 &&
      coverageSummary.matrix[0].busInactiveOutputCount === 1 &&
      coverageSummary.matrix[0].busInputChannels === 3 &&
      coverageSummary.matrix[0].busOutputChannels === 2 &&
      JSON.stringify(coverageSummary.matrix[0].busActiveInputIndexes) === JSON.stringify([0, 1]) &&
      JSON.stringify(coverageSummary.matrix[0].busActiveOutputIndexes) === JSON.stringify([0]) &&
      JSON.stringify(coverageSummary.matrix[0].busInactiveInputIndexes) === JSON.stringify([3]) &&
      JSON.stringify(coverageSummary.matrix[0].busInactiveOutputIndexes) === JSON.stringify([1]) &&
      coverageSummary.matrix[0].busInputMetadataAtLimit === true &&
      coverageSummary.matrix[0].busOutputMetadataAtLimit === true &&
      coverageSummary.matrix[0].vst3NoteExpressionCount === 4 &&
      coverageSummary.matrix[0].vst3ValueNoteExpressionCount === 2 &&
      coverageSummary.matrix[0].vst3TextNoteExpressionCount === 2 &&
      coverageSummary.matrix[0].vst3InvalidNoteExpressionCount === 1 &&
      coverageSummary.matrix[0].vst3InvalidNoteExpressionRouteCount === 1 &&
      coverageSummary.matrix[0].vst3DuplicateNoteExpressionTypeIdCount === 1 &&
      coverageSummary.matrix[0].vst3AssociatedNoteExpressionCount === 1 &&
      coverageSummary.matrix[0].vst3UnitLinkedNoteExpressionCount === 1 &&
      JSON.stringify(coverageSummary.matrix[0].vst3NoteExpressionTypeIds) === JSON.stringify([0, 6, 7]) &&
      JSON.stringify(coverageSummary.matrix[0].vst3EventBuses) === JSON.stringify([0, 2]) &&
      JSON.stringify(coverageSummary.matrix[0].vst3EventChannels) === JSON.stringify([0, 3]) &&
      coverageSummary.matrix[0].midiEventCount === 16 &&
      coverageSummary.matrix[0].midiControllerEventCount === 6 &&
      coverageSummary.matrix[0].midiControllerFamilyCount === 3 &&
      coverageSummary.matrix[0].midiControllerInvalidNumberCount === 1 &&
      coverageSummary.matrix[0].midiControllerInvalidRouteCount === 1 &&
      coverageSummary.matrix[0].midiControllerFlags.includes("multi-controller-family") &&
      coverageSummary.matrix[0].midiControllerFlags.includes("non-main-event-bus") &&
      coverageSummary.matrix[0].midiControllerFlags.includes("invalid-controller-number") &&
      coverageSummary.matrix[0].midiControllerFlags.includes("invalid-controller-route") &&
      coverageSummary.matrix[0].midiControllerFlags.includes("type:controlChange") &&
      JSON.stringify(coverageSummary.matrix[0].midiControllerEventTypes) ===
        JSON.stringify(["controlChange", "pitchBend", "channelPressure"]) &&
      JSON.stringify(coverageSummary.matrix[0].midiControllerNumbers) === JSON.stringify([1, 74]) &&
      JSON.stringify(coverageSummary.matrix[0].midiControllerChannels) === JSON.stringify([0, 2]) &&
      JSON.stringify(coverageSummary.matrix[0].midiControllerEventBuses) === JSON.stringify([0, 1]) &&
      coverageSummary.matrix[0].vst3MidiControllerEvents === "accepted" &&
      coverageSummary.matrix[0].midiProgramChangeEventCount === 2 &&
      coverageSummary.matrix[0].midiProgramChangeInvalidNumberCount === 1 &&
      coverageSummary.matrix[0].midiProgramChangeInvalidRouteCount === 1 &&
      coverageSummary.matrix[0].midiProgramChangeFlags.includes("non-main-event-bus") &&
      coverageSummary.matrix[0].midiProgramChangeFlags.includes("invalid-program-number") &&
      coverageSummary.matrix[0].midiProgramChangeFlags.includes("invalid-program-route") &&
      JSON.stringify(coverageSummary.matrix[0].midiProgramChangePrograms) === JSON.stringify([2, 7]) &&
      JSON.stringify(coverageSummary.matrix[0].midiProgramChangeChannels) === JSON.stringify([0, 2]) &&
      JSON.stringify(coverageSummary.matrix[0].midiProgramChangeEventBuses) === JSON.stringify([0, 1]) &&
      coverageSummary.matrix[0].vst3MidiProgramChangeEvents === "accepted" &&
      coverageSummary.matrix[0].hostTransport === "accepted" &&
      coverageSummary.matrix[0].latencyTail === "latency-tail" &&
      coverageSummary.matrix[0].pluginLatencySamples === 32 &&
      coverageSummary.matrix[0].transportLatencySamples === 64 &&
      coverageSummary.matrix[0].reportedLatencySamples === 96 &&
      coverageSummary.matrix[0].tailSamples === 128 &&
      coverageSummary.matrix[0].infiniteTail === false &&
      coverageSummary.matrix[0].outputBusSignal === "main-aux-signal" &&
      coverageSummary.matrix[0].outputBusSignalFlags.includes("multi-output-signal") &&
      coverageSummary.matrix[0].outputBusSignalCount === 2 &&
      coverageSummary.matrix[0].outputBusSilentCount === 1 &&
      JSON.stringify(coverageSummary.matrix[0].outputBusSignalIndexes) === JSON.stringify([0, 2]) &&
      JSON.stringify(coverageSummary.matrix[0].outputBusSilentIndexes) === JSON.stringify([1]) &&
      coverageSummary.matrix[0].fileGrantSampleLoad === "applied" &&
      coverageSummary.matrix[0].fileGrantOtherPresetLoad === "applied" &&
      coverageSummary.matrix[0].nativeEditor === "opened" &&
      coverageSummary.matrix[0].nativeEditorTransport === "native-broker" &&
      coverageSummary.matrix[0].featureStatus.instantiation === "passed" &&
      coverageSummary.matrix[0].featureStatus.parameters === "passed" &&
      coverageSummary.matrix[0].featureStatus.fileGrants === "passed" &&
      coverageSummary.matrix[0].featureStatus.transport === "accepted" &&
      coverageSummary.matrix[0].featureStatus.rendering === "passed" &&
      coverageSummary.matrix[0].featureStatus.editor === "opened" &&
      coverageSummary.matrix[1].name === "[local-path]" &&
      coverageSummary.matrix[1].vst3ProgramLists === "skipped-format" &&
      coverageSummary.matrix[1].vst3ProgramDataTarget === "skipped-format" &&
      coverageSummary.matrix[1].parameterProfile === "none" &&
      coverageSummary.matrix[1].parameterCount === 0 &&
      coverageSummary.matrix[1].stateProfile === "single-state" &&
      coverageSummary.matrix[1].stateFlags.includes("state-blob") &&
      coverageSummary.matrix[1].stateBytes === 8 &&
      coverageSummary.matrix[1].vst3MidiControllerEvents === "skipped-format" &&
      coverageSummary.matrix[1].vst3MidiProgramChangeEvents === "skipped-format" &&
      coverageSummary.matrix[1].fileGrantCacheDirectoryOpen === "applied" &&
      coverageSummary.matrix[1].fileGrantLicenseLoad === "applied" &&
      coverageSummary.matrix[1].fileGrantOtherPresetLoad === "skipped-unadvertised" &&
      coverageSummary.matrix[1].latencyTail === "infinite-tail" &&
      coverageSummary.matrix[1].infiniteTail === true &&
      coverageSummary.matrix[1].nativeEditor === "missing" &&
      coverageSummary.matrix[1].featureStatus.fileGrants === "passed" &&
      coverageSummary.matrix[1].fileGrantOperations.includes("loadLicense"),
    "installed plugin probe builds path-free compatibility matrix entries"
  );
  check(
    summarizeProbeResults(coverageResults).coverage.nativeEditor["not-requested"] === 2 &&
      summarizeProbeResults(coverageResults).matrix[0].nativeEditor === "not-requested",
    "installed plugin probe marks native editor coverage as not requested by default"
  );
  check(
    summarizeProbeResults([{ ok: true, format: "vst3", vst3ProgramListCount: 0 }]).coverage.vst3ProgramLists.none === 1,
    "installed plugin probe summarizes VST3 plugins with no program lists"
  );
  const cappedProgramMatrix = summarizeProbeResults([{
    ok: true,
    format: "vst3",
    vst3ProgramDataProfile: {
      category: "targeted",
      flags: ["bounded-target", "program-list-metadata-at-limit", "program-metadata-at-limit"],
      programListCount: 256,
      programDataListCount: 1,
      candidateProgramCount: 256,
      programListMetadataAtLimit: true,
      programMetadataAtLimit: true
    }
  }]).matrix[0];
  check(
    cappedProgramMatrix.vst3ProgramDataProgramLists === 256 &&
      cappedProgramMatrix.vst3ProgramDataCandidatePrograms === 256 &&
      cappedProgramMatrix.vst3ProgramDataProgramListMetadataAtLimit === true &&
      cappedProgramMatrix.vst3ProgramDataProgramMetadataAtLimit === true &&
      cappedProgramMatrix.vst3ProgramDataFlags.includes("program-list-metadata-at-limit") &&
      cappedProgramMatrix.vst3ProgramDataFlags.includes("program-metadata-at-limit"),
    "installed plugin probe matrix reports capped VST3 program-data metadata"
  );
  const cappedEventMatrix = summarizeProbeResults([{
    ok: true,
    format: "vst3",
    vst3EventProfile: {
      category: "main-event-bus",
      flags: ["note-expressions", "metadata-at-limit"],
      noteExpressionCount: 256,
      valueExpressionCount: 255,
      textExpressionCount: 1,
      invalidNoteExpressionCount: 0,
      duplicateNoteExpressionTypeIdCount: 0,
      associatedParameterCount: 0,
      metadataAtLimit: true,
      eventBuses: [0],
      channels: [0],
      typeIds: [0, 6]
    }
  }]).matrix[0];
  check(
    cappedEventMatrix.vst3NoteExpressionMetadataAtLimit === true &&
      cappedEventMatrix.vst3EventFlags.includes("metadata-at-limit") &&
      cappedEventMatrix.vst3NoteExpressionCount === 256,
    "installed plugin probe matrix reports capped VST3 note-expression metadata"
  );
  const weirdBusMatrix = summarizeProbeResults([{
    ok: true,
    format: "vst3",
    busProfile: {
      category: "sidechain",
      flags: ["nonsequential-bus-indexes", "duplicate-bus-indexes", "active-empty-bus", "unknown-bus-type"],
      inputBusLayoutCount: 2,
      outputBusLayoutCount: 1,
      inputBusCountMismatch: true,
      outputBusCountMismatch: false,
      nonsequentialInputBuses: 2,
      nonsequentialOutputBuses: 1,
      duplicateInputBusIndexes: 1,
      duplicateOutputBusIndexes: 1,
      activeEmptyInputBuses: 1,
      activeEmptyOutputBuses: 1,
      unknownInputBusTypes: 1,
      unknownOutputBusTypes: 1
    }
  }]).matrix[0];
  check(
    weirdBusMatrix.busNonsequentialInputCount === 2 &&
      weirdBusMatrix.busInputLayoutCount === 2 &&
      weirdBusMatrix.busOutputLayoutCount === 1 &&
      weirdBusMatrix.busInputCountMismatch === true &&
      weirdBusMatrix.busOutputCountMismatch === false &&
      weirdBusMatrix.busNonsequentialOutputCount === 1 &&
      weirdBusMatrix.busDuplicateInputIndexCount === 1 &&
      weirdBusMatrix.busDuplicateOutputIndexCount === 1 &&
      weirdBusMatrix.busActiveEmptyInputCount === 1 &&
      weirdBusMatrix.busActiveEmptyOutputCount === 1 &&
      weirdBusMatrix.busUnknownInputTypeCount === 1 &&
      weirdBusMatrix.busUnknownOutputTypeCount === 1,
    "installed plugin probe matrix reports unusual bus-layout metadata"
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
      coverageLines.some((line) => line.includes("VST3 program-data targets:")) &&
      coverageLines.some((line) => line.includes("VST3 program lists:")) &&
      coverageLines.some((line) => line.includes("parameter metadata:")) &&
      coverageLines.some((line) => line.includes("parameter profiles:")) &&
      coverageLines.some((line) => line.includes("state profiles:")) &&
      coverageLines.some((line) => line.includes("file grant sample load:")) &&
      coverageLines.some((line) => line.includes("file grant cache directory open:")) &&
      coverageLines.some((line) => line.includes("file grant license load:")) &&
      coverageLines.some((line) => line.includes("file grant explicit other preset load:")) &&
      coverageLines.some((line) => line.includes("file grant operations advertised:")) &&
      coverageLines.some((line) => line.includes("VST3 event metadata:")) &&
      coverageLines.some((line) => line.includes("VST3 MIDI-controller events:")) &&
      coverageLines.some((line) => line.includes("VST3 MIDI program-change events:")) &&
      coverageLines.some((line) => line.includes("host transport:")) &&
      coverageLines.some((line) => line.includes("latency/tail:")) &&
      coverageLines.some((line) => line.includes("render signal:")) &&
      coverageLines.some((line) => line.includes("output-bus signal:")) &&
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

  exerciseInstalledProbeRoutingSupport({ check });

  const vst3ProbeState = nativeStateEnvelope({
    format: "vst3",
    component: "Y29tcG9uZW50",
    controller: "Y29udHJvbGxlcg=="
  });
  check(
    nativeStateFileText("vst3", vst3ProbeState) === "Y29tcG9uZW50 Y29udHJvbGxlcg==\n",
    "installed plugin probe exports bounded VST3 state files"
  );
  const vst3StateProfile = summarizeNativeStateProfile("vst3", vst3ProbeState);
  const vst3ComponentOnlyProfile = summarizeNativeStateProfile("vst3", nativeStateEnvelope({
    format: "vst3",
    component: "Yw=="
  }));
  const vst3ControllerOnlyProfile = summarizeNativeStateProfile("vst3", nativeStateEnvelope({
    format: "vst3",
    controller: "Yw=="
  }));
  const lv2ProbeState = nativeStateEnvelope({ format: "lv2", state: "bHYyLXN0YXRl" });
  const lv2StateProfile = summarizeNativeStateProfile("lv2", lv2ProbeState);
  const invalidPartProfile = summarizeNativeStateProfile("vst3", nativeStateEnvelope({ format: "vst3", component: "bad" }));
  check(
    nativeStateFileText("lv2", lv2ProbeState) === "bHYyLXN0YXRl\n" &&
      nativeStateFileText("au", lv2ProbeState) === "",
    "installed plugin probe exports only matching native state files"
  );
  check(
    vst3StateProfile.category === "component-controller" &&
      vst3StateProfile.stateBytes === 19 &&
      vst3StateProfile.componentBytes === 9 &&
      vst3StateProfile.controllerBytes === 10 &&
      vst3ComponentOnlyProfile.category === "component-only" &&
      vst3ControllerOnlyProfile.category === "controller-only" &&
      lv2StateProfile.category === "single-state" &&
      lv2StateProfile.stateBytes === 9 &&
      invalidPartProfile.category === "invalid" &&
      invalidPartProfile.flags.includes("invalid-component-base64") &&
      summarizeNativeStateProfile("vst3", Buffer.from("{}", "utf8").toString("base64")).category === "generic-state" &&
      summarizeNativeStateProfile("vst3", "not-state").category === "invalid",
    "installed plugin probe classifies bounded native state profiles"
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
  exerciseInstalledProbeProgramSupport({ check });
  const parameterProfile = summarizeParameterProfile([
    {
      id: "cutoff",
      automatable: true,
      displayValue: "50%",
      unit: "%",
      vst3Unit: { id: 2 }
    },
    {
      id: "cutoff",
      automatable: false,
      readOnly: true
    },
    {
      id: "program",
      automatable: true,
      readOnly: true,
      programChange: true
    }
  ], { atLimit: true, format: "vst3" });
  const readOnlyParameterProfile = summarizeParameterProfile([
    { id: "readonly", automatable: false, readOnly: true }
  ], { format: "vst3" });
  check(
    parameterProfile.category === "writable" &&
      parameterProfile.flags.includes("metadata-at-limit") &&
      parameterProfile.flags.includes("display-values") &&
      parameterProfile.flags.includes("program-change") &&
      parameterProfile.flags.includes("vst3-units") &&
      parameterProfile.flags.includes("duplicate-parameter-id") &&
      parameterProfile.parameterCount === 3 &&
      parameterProfile.writableCount === 1 &&
      parameterProfile.readOnlyCount === 2 &&
      parameterProfile.programChangeCount === 1 &&
      parameterProfile.duplicateParameterIdCount === 1 &&
      readOnlyParameterProfile.category === "read-only" &&
      readOnlyParameterProfile.flags.includes("no-writable-parameters"),
    "installed plugin probe classifies bounded parameter metadata profiles"
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
