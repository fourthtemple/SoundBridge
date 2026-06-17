import {
  firstListedPreset,
  firstVst3ProgramDataTarget,
  probeVst3ProgramData,
  summarizeVst3ProgramDataProfile,
  vst3ProgramDataByteLength
} from "./installed-plugin-probe-programs.mjs";
import { summarizeProbeResults } from "./installed-plugin-probe-reporting.mjs";
import { vst3ProgramDataStatus } from "./installed-plugin-probe-status.mjs";

export async function exerciseInstalledProbeProgramSupport({ check }) {
  check(
    firstListedPreset({ presets: [{ id: "init", name: "Init" }] })?.id === "init" &&
      firstListedPreset({ presets: [{ id: "x".repeat(65) }] }) === undefined,
    "installed plugin probe selects bounded listed presets"
  );
  check(
    vst3ProgramDataByteLength("") === 0 &&
      vst3ProgramDataByteLength("YWI=") === 2 &&
      vst3ProgramDataByteLength("+/8=") === 2 &&
      vst3ProgramDataByteLength("AAA") === undefined &&
      vst3ProgramDataByteLength("not-base64") === undefined,
    "installed plugin probe validates VST3 program-data byte lengths"
  );

  const sentinelProgramTarget = firstVst3ProgramDataTarget({
    vst3ProgramLists: [
      { id: -1, programDataSupported: true, programs: [{ index: 0 }] },
      { id: 8, programDataSupported: true, programs: [{ index: 1 }] }
    ]
  });
  const programTarget = firstVst3ProgramDataTarget({
    vst3ProgramLists: [
      { id: 1, programDataSupported: false, programs: [{ index: 0 }] },
      { id: 2, programDataSupported: true, programs: [{ index: 3 }] }
    ]
  });
  const uniqueFallbackProgramTarget = firstVst3ProgramDataTarget({
    vst3ProgramLists: [
      { id: 3, programDataSupported: true, programs: [{ index: 1 }, { index: 1 }, { index: 2 }] }
    ]
  });
  const consistentDuplicateProgramTarget = firstVst3ProgramDataTarget({
    vst3ProgramLists: [
      { id: 9, programDataSupported: true, programs: [{ index: 5, normalizedValue: 0.25 }, { index: 5, normalizedValue: 0.25 }] }
    ]
  });
  check(
    sentinelProgramTarget?.programListId === 8 &&
      sentinelProgramTarget.programIndex === 1 &&
      programTarget?.programListId === 2 &&
      programTarget.programIndex === 3 &&
      uniqueFallbackProgramTarget?.programListId === 3 &&
      uniqueFallbackProgramTarget.programIndex === 2 &&
      consistentDuplicateProgramTarget?.programListId === 9 &&
      consistentDuplicateProgramTarget.programIndex === 5 &&
      firstVst3ProgramDataTarget({ vst3ProgramLists: [{ id: 4, programDataSupported: true, programs: [] }] }) === undefined &&
      firstVst3ProgramDataTarget({
        vst3ProgramLists: [{ id: "bad", programDataSupported: true, programs: [{ index: 0 }] }]
      }) === undefined &&
      firstVst3ProgramDataTarget({
        vst3ProgramLists: [{ id: 5, programDataSupported: true, programs: [{ index: -1 }, { index: 256 }] }]
      }) === undefined &&
      firstVst3ProgramDataTarget({
        vst3ProgramLists: [{ id: 6, programDataSupported: true, programs: [{ index: 0 }, { index: 0 }] }]
      }) === undefined &&
      firstVst3ProgramDataTarget({
        vst3ProgramLists: [
          { id: 7, programDataSupported: true, programs: [{ index: 0 }] },
          { id: 7, programDataSupported: true, programs: [{ index: 1 }] }
        ]
      }) === undefined,
    "installed plugin probe selects bounded VST3 program-data targets"
  );

  const targetedProgramDataProfile = summarizeVst3ProgramDataProfile({
    format: "vst3",
    vst3ProgramLists: [
      { id: 1, programDataSupported: false, programs: [{ index: 0 }] },
      {
        id: 2,
        nameFallback: true,
        unitId: 4,
        programDataSupported: true,
        programs: [
          { index: 3, normalizedValue: 0 },
          { index: 3 },
          { index: 4, normalizedValue: 1, nameFallback: true },
          { index: "bad", normalizedValue: "bad" }
        ]
      }
    ]
  });
  const weirdProgramDataProfile = summarizeVst3ProgramDataProfile({
    format: "vst3",
    vst3ProgramLists: [
      { id: "bad", programDataSupported: true, programs: [{ index: 0 }] },
      { id: -1, programDataSupported: true, programs: [{ index: 1 }] },
      { id: 4, programDataSupported: true, programs: [] },
      { id: 4, programDataSupported: true, programs: [] },
      { id: 5, unitId: "bad", programDataSupported: true, programs: [{ index: 256, normalizedValue: -0.25 }] }
    ]
  });
  const targetedProgramDataMatrix = summarizeProbeResults([{
    ok: true,
    format: "vst3",
    vst3ProgramDataProfile: targetedProgramDataProfile
  }]).matrix[0];
  const weirdProgramDataMatrix = summarizeProbeResults([{
    ok: true,
    format: "vst3",
    vst3ProgramDataProfile: weirdProgramDataProfile
  }]).matrix[0];
  const ambiguousProgramDataProfile = summarizeVst3ProgramDataProfile({
    format: "vst3",
    vst3ProgramLists: [
      { id: 8, programDataSupported: true, programs: [{ index: 0, normalizedValue: 0.25 }, { index: 0, normalizedValue: 0.75 }] }
    ]
  });
  const consistentDuplicateProgramDataProfile = summarizeVst3ProgramDataProfile({
    format: "vst3",
    vst3ProgramLists: [
      { id: 9, programDataSupported: true, programs: [{ index: 5, normalizedValue: 0.25 }, { index: 5, normalizedValue: 0.25 }] }
    ]
  });
  const consistentDuplicateProgramDataMatrix = summarizeProbeResults([{
    ok: true,
    format: "vst3",
    vst3ProgramDataProfile: consistentDuplicateProgramDataProfile
  }]).matrix[0];
  const missingProgramsProfile = summarizeVst3ProgramDataProfile({
    format: "vst3",
    vst3ProgramLists: [
      { id: 6, programDataSupported: true },
      { id: 7, programs: [{ index: 0 }] }
    ]
  });
  const cappedProgramDataProfile = summarizeVst3ProgramDataProfile({
    format: "vst3",
    vst3ProgramLists: Array.from({ length: 256 }, (_, listIndex) => ({
      id: listIndex,
      programDataSupported: listIndex === 0,
      programs: Array.from({ length: listIndex === 0 ? 256 : 1 }, (_, programIndex) => ({
        index: programIndex,
        normalizedValue: listIndex === 0 ? programIndex / 255 : 0
      }))
    }))
  });
  check(
    targetedProgramDataProfile.category === "targeted" &&
      targetedProgramDataProfile.flags.includes("program-data-unsupported") &&
      targetedProgramDataProfile.flags.includes("bounded-target") &&
      targetedProgramDataProfile.programListCount === 2 &&
      targetedProgramDataProfile.programDataListCount === 1 &&
      targetedProgramDataProfile.candidateProgramCount === 1 &&
      targetedProgramDataProfile.unsupportedProgramListCount === 1 &&
      targetedProgramDataProfile.invalidProgramIndexCount === 1 &&
      targetedProgramDataProfile.duplicateProgramIndexCount === 1 &&
      targetedProgramDataProfile.ambiguousProgramIndexCount === 1 &&
      targetedProgramDataProfile.unitLinkedProgramListCount === 1 &&
      targetedProgramDataProfile.programListNameFallbackCount === 1 &&
      targetedProgramDataProfile.programNameFallbackCount === 1 &&
      targetedProgramDataProfile.missingProgramValueCount === 1 &&
      targetedProgramDataProfile.invalidProgramValueCount === 1 &&
      targetedProgramDataProfile.minProgramValueCount === 1 &&
      targetedProgramDataProfile.maxProgramValueCount === 1 &&
      targetedProgramDataProfile.flags.includes("duplicate-program-index") &&
      targetedProgramDataProfile.flags.includes("ambiguous-program-index") &&
      targetedProgramDataProfile.flags.includes("unit-linked-program-list") &&
      targetedProgramDataProfile.flags.includes("program-list-name-fallback") &&
      targetedProgramDataProfile.flags.includes("program-name-fallback") &&
      targetedProgramDataProfile.flags.includes("missing-program-value") &&
      targetedProgramDataProfile.flags.includes("invalid-program-value") &&
      targetedProgramDataMatrix.vst3ProgramDataUnitLinkedLists === 1 &&
      targetedProgramDataMatrix.vst3ProgramDataProgramListNameFallbacks === 1 &&
      targetedProgramDataMatrix.vst3ProgramDataProgramNameFallbacks === 1 &&
      targetedProgramDataMatrix.vst3ProgramDataMissingProgramValues === 1 &&
      targetedProgramDataMatrix.vst3ProgramDataInvalidProgramValues === 1 &&
      targetedProgramDataMatrix.vst3ProgramDataMinProgramValues === 1 &&
      targetedProgramDataMatrix.vst3ProgramDataMaxProgramValues === 1 &&
      targetedProgramDataMatrix.vst3ProgramDataAmbiguousProgramIndexes === 1 &&
      weirdProgramDataProfile.category === "no-valid-programs" &&
      weirdProgramDataProfile.invalidProgramListCount === 2 &&
      weirdProgramDataProfile.noProgramListSentinelCount === 1 &&
      weirdProgramDataProfile.emptyProgramListCount === 2 &&
      weirdProgramDataProfile.invalidProgramIndexCount === 1 &&
      weirdProgramDataProfile.duplicateProgramListIdCount === 1 &&
      weirdProgramDataProfile.invalidProgramListUnitCount === 1 &&
      weirdProgramDataProfile.invalidProgramValueCount === 1 &&
      weirdProgramDataProfile.flags.includes("invalid-program-list-id") &&
      weirdProgramDataProfile.flags.includes("no-program-list-sentinel") &&
      weirdProgramDataProfile.flags.includes("empty-program-list") &&
      weirdProgramDataProfile.flags.includes("invalid-program-index") &&
      weirdProgramDataProfile.flags.includes("duplicate-program-list-id") &&
      weirdProgramDataProfile.flags.includes("invalid-program-list-unit") &&
      weirdProgramDataProfile.flags.includes("invalid-program-value") &&
      weirdProgramDataMatrix.vst3ProgramDataInvalidUnitLinkedLists === 1 &&
      weirdProgramDataMatrix.vst3ProgramDataInvalidProgramValues === 1 &&
      ambiguousProgramDataProfile.category === "no-valid-programs" &&
      ambiguousProgramDataProfile.candidateProgramCount === 0 &&
      ambiguousProgramDataProfile.duplicateProgramIndexCount === 1 &&
      ambiguousProgramDataProfile.ambiguousProgramIndexCount === 1 &&
      ambiguousProgramDataProfile.flags.includes("duplicate-program-index") &&
      ambiguousProgramDataProfile.flags.includes("ambiguous-program-index") &&
      ambiguousProgramDataProfile.flags.includes("no-valid-program-data-programs") &&
      consistentDuplicateProgramDataProfile.category === "targeted" &&
      consistentDuplicateProgramDataProfile.candidateProgramCount === 1 &&
      consistentDuplicateProgramDataProfile.duplicateProgramIndexCount === 1 &&
      consistentDuplicateProgramDataProfile.ambiguousProgramIndexCount === 0 &&
      consistentDuplicateProgramDataProfile.consistentDuplicateProgramIndexCount === 1 &&
      consistentDuplicateProgramDataProfile.flags.includes("consistent-duplicate-program-index") &&
      !consistentDuplicateProgramDataProfile.flags.includes("ambiguous-program-index") &&
      consistentDuplicateProgramDataMatrix.vst3ProgramDataConsistentDuplicateProgramIndexes === 1 &&
      missingProgramsProfile.category === "no-valid-programs" &&
      missingProgramsProfile.missingProgramArrayCount === 1 &&
      missingProgramsProfile.undisclosedProgramListCount === 1 &&
      missingProgramsProfile.flags.includes("missing-programs") &&
      missingProgramsProfile.flags.includes("program-data-undisclosed") &&
      cappedProgramDataProfile.category === "targeted" &&
      cappedProgramDataProfile.programListCount === 256 &&
      cappedProgramDataProfile.candidateProgramCount === 256 &&
      cappedProgramDataProfile.minProgramValueCount === 1 &&
      cappedProgramDataProfile.maxProgramValueCount === 1 &&
      cappedProgramDataProfile.programListMetadataAtLimit === true &&
      cappedProgramDataProfile.programMetadataAtLimit === true &&
      cappedProgramDataProfile.flags.includes("program-list-metadata-at-limit") &&
      cappedProgramDataProfile.flags.includes("program-metadata-at-limit"),
    "installed plugin probe classifies VST3 program-data target edge cases"
  );

  await exerciseVst3ProgramDataFailureReporting({ check });
}

async function exerciseVst3ProgramDataFailureReporting({ check }) {
  const restoreResult = { phases: [] };
  let restoreFailureCode = "";
  try {
    await probeVst3ProgramData({
      assertProbe,
      createdPlugin: {
        vst3ProgramLists: [
          { id: 7, programDataSupported: true, programs: [{ index: 2 }] }
        ]
      },
      instanceId: "inst-program-data",
      phase: recordPhase,
      plugin: { format: "vst3" },
      request: mismatchedRestoreRequest,
      result: restoreResult,
      session: "session",
      socket: {}
    });
  } catch (error) {
    restoreFailureCode = error.code;
  }

  const failedProgramDataSummary = summarizeProbeResults([
    {
      ok: false,
      format: "vst3",
      pluginId: "vst3:export-failed",
      phases: [{ name: "getVst3ProgramData", ok: false, error: { code: "bad_vst3_program_data" } }]
    },
    {
      ok: false,
      format: "vst3",
      pluginId: "vst3:restore-failed",
      phases: [{ name: "setVst3ProgramData", ok: false, error: { code: "bad_vst3_program_data_restore" } }]
    },
    {
      ok: false,
      format: "vst3",
      pluginId: "vst3:create-failed",
      phases: [{ name: "createInstance", ok: false, error: { code: "native_worker_failed" } }]
    }
  ]);
  check(
    restoreFailureCode === "bad_vst3_program_data_restore" &&
      restoreResult.phases.some((phase) => phase.name === "getVst3ProgramData" && phase.ok === true) &&
      restoreResult.phases.some((phase) => phase.name === "setVst3ProgramData" && phase.ok === false) &&
      vst3ProgramDataStatus(restoreResult) === "restore-failed" &&
      failedProgramDataSummary.coverage.vst3ProgramData["export-failed"] === 1 &&
      failedProgramDataSummary.coverage.vst3ProgramData["restore-failed"] === 1 &&
      failedProgramDataSummary.matrix[0].vst3ProgramData === "export-failed" &&
      failedProgramDataSummary.matrix[0].featureStatus.vst3ProgramData === "export-failed" &&
      failedProgramDataSummary.matrix[1].vst3ProgramData === "restore-failed" &&
      failedProgramDataSummary.matrix[1].featureStatus.vst3ProgramData === "restore-failed" &&
      failedProgramDataSummary.coverage.vst3ProgramData.failed === 1 &&
      failedProgramDataSummary.coverage.vst3ProgramDataTargets.failed === 1 &&
      failedProgramDataSummary.coverage.vst3ProgramLists.failed === 1 &&
      failedProgramDataSummary.matrix[2].vst3ProgramData === "failed" &&
      failedProgramDataSummary.matrix[2].vst3ProgramDataTarget === "failed" &&
      failedProgramDataSummary.matrix[2].vst3ProgramLists === "failed" &&
      failedProgramDataSummary.matrix[2].featureStatus.vst3ProgramData === "failed",
    "installed plugin probe reports VST3 program-data export, restore, and instantiation failures"
  );
}

function assertProbe(ok, code, message) {
  if (ok) {
    return;
  }
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function recordPhase(result, name, operation) {
  try {
    const value = await operation();
    result.phases.push({ name, ok: true });
    return value;
  } catch (error) {
    result.phases.push({ name, ok: false, error: { code: error.code ?? error.message } });
    throw error;
  }
}

async function mismatchedRestoreRequest(_socket, method) {
  if (method === "getVst3ProgramData") {
    return {
      format: "vst3",
      programListId: 7,
      programIndex: 2,
      size: 2,
      data: "YWI=",
      programData: "opaque-program-data-envelope"
    };
  }
  if (method === "setVst3ProgramData") {
    return {
      restored: true,
      programListId: 7,
      programIndex: 3,
      parameterCount: 0,
      parameters: []
    };
  }
  throw new Error(`unexpected method ${method}`);
}
