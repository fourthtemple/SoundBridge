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
      vst3Unit: { id: 2, name: "", programListId: "1" },
      vst3MidiMappings: [
        { busIndex: 0, channel: 0, controller: 1 },
        { busIndex: 1, channel: 2, controller: 74 },
        { busIndex: 1, channel: 2, controller: 74 },
        { busIndex: "2", channel: "3", controller: "74" },
        { busIndex: 99, channel: 0, controller: 1 }
      ]
    },
    {
      id: "program-without-list",
      programChange: true,
      name: "",
      vst3Unit: { id: 3, programListId: false },
      vst3MidiMappings: [
        { busIndex: 0, channel: 0, controller: 128 },
        { busIndex: 0, channel: 0, controller: 129 }
      ]
    },
    {
      id: "boundary-mapping",
      vst3MidiMappings: [
        { busIndex: 31, channel: 15, controller: 0 },
        { busIndex: 31, channel: 15, controller: 127 }
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
        { busIndex: 1, channel: 99, controller: 74 },
        { busIndex: false, channel: 0, controller: 1 },
        { busIndex: 0, channel: 0, controller: 130 },
        { busIndex: 99, channel: 99, controller: 130 }
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
  const cappedMappingProfile = summarizeParameterProfile([
    {
      id: "mapped-at-limit",
      vst3MidiMappings: Array.from({ length: 257 }, (_, index) => ({
        busIndex: 0,
        channel: 0,
        controller: index % 128
      }))
    }
  ], { format: "vst3" });
  const cappedMappingMatrix = summarizeProbeResults([
    {
      ok: true,
      format: "vst3",
      parameterProfile: cappedMappingProfile
    }
  ]).matrix[0];
  const saturatedMappingProfile = summarizeParameterProfile([
    {
      id: "valid-mappings-at-limit",
      vst3MidiMappings: Array.from({ length: 256 }, (_, index) => ({
        busIndex: 0,
        channel: 0,
        controller: index % 128
      }))
    },
    {
      id: "invalid-mappings-after-limit",
      vst3MidiMappings: [
        { busIndex: 99, channel: 0, controller: 1 },
        { busIndex: 0, channel: 0, controller: 130 },
        { busIndex: 99, channel: 99, controller: 130 }
      ]
    }
  ], { format: "vst3" });
  const saturatedMappingMatrix = summarizeProbeResults([
    {
      ok: true,
      format: "vst3",
      parameterProfile: saturatedMappingProfile
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
  const statusOnlyParameterSummary = summarizeProbeResults([
    {
      ok: true,
      format: "vst3",
      parameterProfile: summarizeParameterProfile([
        { id: "status-only-read-only", automatable: false, readOnly: true }
      ], { format: "vst3" })
    },
    {
      ok: true,
      format: "vst3",
      parameterProfile: summarizeParameterProfile([], { format: "vst3" })
    },
    {
      ok: false,
      format: "vst3",
      pluginId: "vst3:status-only-parameter-failed",
      parameterProfile: { category: "failed" }
    }
  ]);

  check(
    parameterProfile.category === "writable" &&
      parameterProfile.programChangeCount === 2 &&
      parameterProfile.programChangeWithoutListCount === 1 &&
      parameterProfile.vst3UnitCount === 2 &&
      parameterProfile.nameFallbackCount === 1 &&
      parameterProfile.vst3UnitNameFallbackCount === 1 &&
      parameterProfile.vst3UnitProgramListLinkCount === 1 &&
      parameterProfile.invalidVst3UnitProgramListLinkCount === 1 &&
      parameterProfile.vst3MidiMappedParameterCount === 3 &&
      parameterProfile.vst3MidiMappingCount === 8 &&
      parameterProfile.vst3MidiMappingControllerCount === 6 &&
      parameterProfile.vst3MidiMappingBusCount === 4 &&
      parameterProfile.vst3MidiMappingChannelCount === 4 &&
      parameterProfile.vst3MidiDuplicateMappingCount === 1 &&
      parameterProfile.invalidVst3MidiMappingCount === 5 &&
      parameterProfile.invalidVst3MidiMappingRouteCount === 4 &&
      parameterProfile.invalidVst3MidiMappingControllerCount === 2 &&
      parameterProfile.vst3MidiCcMappingCount === 6 &&
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
      parameterProfile.flags.includes("invalid-vst3-midi-mapping-route") &&
      parameterProfile.flags.includes("invalid-vst3-midi-mapping-controller") &&
      parameterProfile.flags.includes("vst3-midi-mapping-cc") &&
      parameterProfile.flags.includes("vst3-midi-mapping-aftertouch") &&
      parameterProfile.flags.includes("vst3-midi-mapping-pitch-bend") &&
      matrix.parameterProgramChangeCount === 2 &&
      matrix.parameterNameFallbackCount === 1 &&
      matrix.parameterVst3UnitNameFallbackCount === 1 &&
      matrix.parameterProgramChangeWithoutListCount === 1 &&
      matrix.parameterVst3UnitProgramListLinkCount === 1 &&
      matrix.parameterInvalidVst3UnitProgramListLinkCount === 1 &&
      matrix.parameterVst3MidiMappedParameterCount === 3 &&
      matrix.parameterVst3MidiMappingCount === 8 &&
      matrix.parameterVst3MidiDuplicateMappingCount === 1 &&
      matrix.parameterInvalidVst3MidiMappingCount === 5 &&
      matrix.parameterInvalidVst3MidiMappingRouteCount === 4 &&
      matrix.parameterInvalidVst3MidiMappingControllerCount === 2 &&
      matrix.parameterVst3MidiCcMappingCount === 6 &&
      matrix.parameterVst3MidiAftertouchMappingCount === 1 &&
      matrix.parameterVst3MidiPitchBendMappingCount === 1 &&
      JSON.stringify(matrix.parameterVst3MidiMappingControllers) === JSON.stringify([0, 1, 74, 127, 128, 129]) &&
      JSON.stringify(matrix.parameterVst3MidiMappingBuses) === JSON.stringify([0, 1, 2, 31]) &&
      JSON.stringify(matrix.parameterVst3MidiMappingChannels) === JSON.stringify([0, 2, 3, 15]) &&
      matrix.parameterFlags.includes("program-change-without-list") &&
      cappedMappingProfile.vst3MidiMappingCount === 256 &&
      cappedMappingProfile.vst3MidiDuplicateMappingCount === 128 &&
      cappedMappingProfile.flags.includes("vst3-midi-mapping-at-limit") &&
      cappedMappingMatrix.parameterVst3MidiMappingCount === 256 &&
      cappedMappingMatrix.parameterVst3MidiDuplicateMappingCount === 128 &&
      cappedMappingMatrix.parameterFlags.includes("vst3-midi-mapping-at-limit") &&
      saturatedMappingProfile.vst3MidiMappingCount === 256 &&
      saturatedMappingProfile.invalidVst3MidiMappingCount === 3 &&
      saturatedMappingProfile.invalidVst3MidiMappingRouteCount === 2 &&
      saturatedMappingProfile.invalidVst3MidiMappingControllerCount === 2 &&
      saturatedMappingProfile.flags.includes("vst3-midi-mapping-at-limit") &&
      saturatedMappingProfile.flags.includes("invalid-vst3-midi-mapping-route") &&
      saturatedMappingProfile.flags.includes("invalid-vst3-midi-mapping-controller") &&
      saturatedMappingMatrix.parameterVst3MidiMappingCount === 256 &&
      saturatedMappingMatrix.parameterInvalidVst3MidiMappingCount === 3 &&
      saturatedMappingMatrix.parameterInvalidVst3MidiMappingRouteCount === 2 &&
      saturatedMappingMatrix.parameterInvalidVst3MidiMappingControllerCount === 2 &&
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
  check(
    statusOnlyParameterSummary.matrix[0].parameterProfile === "read-only" &&
      statusOnlyParameterSummary.matrix[0].featureStatus.parameters === "passed" &&
      statusOnlyParameterSummary.matrix[1].parameterProfile === "none" &&
      statusOnlyParameterSummary.matrix[1].featureStatus.parameters === "passed" &&
      statusOnlyParameterSummary.matrix[2].parameterProfile === "failed" &&
      statusOnlyParameterSummary.matrix[2].featureStatus.parameters === "failed",
    "installed plugin probe reports status-only parameter profile results"
  );
}
