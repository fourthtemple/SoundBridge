import { summarizeParameterProfile } from "./installed-plugin-probe-parameters.mjs";
import { summarizeProbeResults } from "./installed-plugin-probe-reporting.mjs";
import { parameterDisplayInputStatus } from "./installed-plugin-probe-status.mjs";

export function exerciseInstalledProbeParameterSupport({ check }) {
  const parameterProfile = summarizeParameterProfile([
    {
      id: "program-with-list",
      programChange: true,
      programList: {
        id: 1,
        programs: [{ index: 0, name: "Program 1" }]
      },
      vst3Unit: { id: 2, nameFallback: true, programListId: 1 },
      vst3MidiMappings: [
        { busIndex: 0, channel: 0, controller: 1 },
        { busIndex: 1, channel: 2, controller: 74 },
        { busIndex: 1, channel: 2, controller: 74 },
        { busIndex: 99, channel: 0, controller: 1 }
      ]
    },
    {
      id: "program-without-list",
      programChange: true,
      nameFallback: true,
      vst3Unit: { id: 3, programListId: -1 },
      vst3MidiMappings: [
        { busIndex: 0, channel: 0, controller: 128 },
        { busIndex: 0, channel: 0, controller: 129 }
      ]
    },
    {
      id: "read-only",
      automatable: false,
      readOnly: true
    },
    {
      id: "invalid-mapping-only",
      automatable: false,
      readOnly: true,
      vst3MidiMappings: [
        { busIndex: 1, channel: 99, controller: 74 }
      ]
    }
  ], { format: "vst3" });
  const matrix = summarizeProbeResults([
    {
      ok: true,
      format: "vst3",
      parameterProfile
    }
  ]).matrix[0];
  const failedParameterSummary = summarizeProbeResults([
    {
      ok: false,
      format: "vst3",
      pluginId: "vst3:parameter-create-failed",
      phases: [{ name: "createInstance", ok: false, error: { code: "native_worker_failed" } }]
    },
    {
      ok: false,
      format: "vst3",
      pluginId: "vst3:parameter-query-failed",
      phases: [
        { name: "createInstance", ok: true },
        { name: "getParameters", ok: false, error: { code: "bad_parameter_snapshot" } }
      ]
    }
  ]);
  const failedAutomationSummary = summarizeProbeResults([{
    ok: false,
    format: "vst3",
    pluginId: "vst3:automation-failed",
    phases: [
      { name: "createInstance", ok: true },
      { name: "getParameters", ok: true },
      { name: "setAutomationLane", ok: false, error: { code: "bad_automation_lane" } }
    ]
  }]);
  const failedDisplayInputResult = {
    ok: false,
    format: "vst3",
    pluginId: "vst3:display-input-failed",
    phases: [
      { name: "createInstance", ok: true },
      { name: "getParameters", ok: true },
      { name: "setParameterDisplayValue", ok: false, error: { code: "bad_parameter_display_input" } }
    ]
  };
  const failedDisplayInputSummary = summarizeProbeResults([failedDisplayInputResult]);

  check(
    parameterProfile.category === "writable" &&
      parameterProfile.programChangeCount === 2 &&
      parameterProfile.programChangeWithoutListCount === 1 &&
      parameterProfile.vst3UnitCount === 2 &&
      parameterProfile.nameFallbackCount === 1 &&
      parameterProfile.vst3UnitNameFallbackCount === 1 &&
      parameterProfile.vst3UnitProgramListLinkCount === 1 &&
      parameterProfile.invalidVst3UnitProgramListLinkCount === 1 &&
      parameterProfile.vst3MidiMappedParameterCount === 2 &&
      parameterProfile.vst3MidiMappingCount === 5 &&
      parameterProfile.vst3MidiMappingControllerCount === 4 &&
      parameterProfile.vst3MidiMappingBusCount === 2 &&
      parameterProfile.vst3MidiMappingChannelCount === 2 &&
      parameterProfile.vst3MidiDuplicateMappingCount === 1 &&
      parameterProfile.invalidVst3MidiMappingCount === 2 &&
      parameterProfile.vst3MidiCcMappingCount === 3 &&
      parameterProfile.vst3MidiAftertouchMappingCount === 1 &&
      parameterProfile.vst3MidiPitchBendMappingCount === 1 &&
      parameterProfile.flags.includes("program-change") &&
      parameterProfile.flags.includes("parameter-name-fallback") &&
      parameterProfile.flags.includes("program-change-without-list") &&
      parameterProfile.flags.includes("vst3-unit-name-fallback") &&
      parameterProfile.flags.includes("vst3-unit-program-list-link") &&
      parameterProfile.flags.includes("invalid-vst3-unit-program-list-link") &&
      parameterProfile.flags.includes("vst3-midi-mapping") &&
      parameterProfile.flags.includes("vst3-midi-mapping-multi-controller") &&
      parameterProfile.flags.includes("vst3-midi-mapping-non-main-event-bus") &&
      parameterProfile.flags.includes("vst3-midi-mapping-non-main-channel") &&
      parameterProfile.flags.includes("vst3-midi-mapping-duplicate") &&
      parameterProfile.flags.includes("invalid-vst3-midi-mapping") &&
      parameterProfile.flags.includes("vst3-midi-mapping-cc") &&
      parameterProfile.flags.includes("vst3-midi-mapping-aftertouch") &&
      parameterProfile.flags.includes("vst3-midi-mapping-pitch-bend") &&
      matrix.parameterProgramChangeCount === 2 &&
      matrix.parameterNameFallbackCount === 1 &&
      matrix.parameterVst3UnitNameFallbackCount === 1 &&
      matrix.parameterProgramChangeWithoutListCount === 1 &&
      matrix.parameterVst3UnitProgramListLinkCount === 1 &&
      matrix.parameterInvalidVst3UnitProgramListLinkCount === 1 &&
      matrix.parameterVst3MidiMappedParameterCount === 2 &&
      matrix.parameterVst3MidiMappingCount === 5 &&
      matrix.parameterVst3MidiDuplicateMappingCount === 1 &&
      matrix.parameterInvalidVst3MidiMappingCount === 2 &&
      matrix.parameterVst3MidiCcMappingCount === 3 &&
      matrix.parameterVst3MidiAftertouchMappingCount === 1 &&
      matrix.parameterVst3MidiPitchBendMappingCount === 1 &&
      JSON.stringify(matrix.parameterVst3MidiMappingControllers) === JSON.stringify([1, 74, 128, 129]) &&
      JSON.stringify(matrix.parameterVst3MidiMappingBuses) === JSON.stringify([0, 1]) &&
      JSON.stringify(matrix.parameterVst3MidiMappingChannels) === JSON.stringify([0, 2]) &&
      matrix.parameterFlags.includes("program-change-without-list") &&
      failedParameterSummary.coverage.parameterMetadata.failed === 2 &&
      failedParameterSummary.coverage.parameterProfiles.failed === 2 &&
      failedParameterSummary.matrix[0].parameterMetadata === "failed" &&
      failedParameterSummary.matrix[0].parameterProfile === "failed" &&
      failedParameterSummary.matrix[0].featureStatus.instantiation === "failed" &&
      failedParameterSummary.matrix[0].featureStatus.parameters === "missing" &&
      failedParameterSummary.matrix[1].parameterMetadata === "failed" &&
      failedParameterSummary.matrix[1].parameterProfile === "failed" &&
      failedParameterSummary.matrix[1].featureStatus.parameters === "failed" &&
      failedAutomationSummary.coverage.automationLanes.failed === 1 &&
      failedAutomationSummary.matrix[0].automation === "failed" &&
      failedAutomationSummary.matrix[0].featureStatus.automation === "failed" &&
      parameterDisplayInputStatus(failedDisplayInputResult) === "failed" &&
      failedDisplayInputSummary.coverage.parameterDisplayInput.failed === 1 &&
      failedDisplayInputSummary.matrix[0].parameterDisplayInput === "failed" &&
      failedDisplayInputSummary.matrix[0].featureStatus.parameters === "failed",
    "installed plugin probe reports VST3 parameter metadata, mappings, display input, automation, and failures"
  );
}
