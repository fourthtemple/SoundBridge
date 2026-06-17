import {
  firstListedPreset,
  firstVst3ProgramDataTarget,
  summarizeVst3ProgramDataProfile
} from "./installed-plugin-probe-programs.mjs";

export function exerciseInstalledProbeProgramSupport({ check }) {
  check(
    firstListedPreset({ presets: [{ id: "init", name: "Init" }] })?.id === "init" &&
      firstListedPreset({ presets: [{ id: "x".repeat(65) }] }) === undefined,
    "installed plugin probe selects bounded listed presets"
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
  check(
    sentinelProgramTarget?.programListId === 8 &&
      sentinelProgramTarget.programIndex === 1 &&
      programTarget?.programListId === 2 &&
      programTarget.programIndex === 3 &&
      uniqueFallbackProgramTarget?.programListId === 3 &&
      uniqueFallbackProgramTarget.programIndex === 2 &&
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
      { id: 2, programDataSupported: true, programs: [{ index: 3 }, { index: 3 }, { index: 4 }, { index: "bad" }] }
    ]
  });
  const weirdProgramDataProfile = summarizeVst3ProgramDataProfile({
    format: "vst3",
    vst3ProgramLists: [
      { id: "bad", programDataSupported: true, programs: [{ index: 0 }] },
      { id: -1, programDataSupported: true, programs: [{ index: 1 }] },
      { id: 4, programDataSupported: true, programs: [] },
      { id: 4, programDataSupported: true, programs: [] },
      { id: 5, programDataSupported: true, programs: [{ index: 256 }] }
    ]
  });
  const ambiguousProgramDataProfile = summarizeVst3ProgramDataProfile({
    format: "vst3",
    vst3ProgramLists: [
      { id: 8, programDataSupported: true, programs: [{ index: 0 }, { index: 0 }] }
    ]
  });
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
      programs: Array.from({ length: listIndex === 0 ? 256 : 1 }, (_, programIndex) => ({ index: programIndex }))
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
      targetedProgramDataProfile.flags.includes("duplicate-program-index") &&
      weirdProgramDataProfile.category === "no-valid-programs" &&
      weirdProgramDataProfile.invalidProgramListCount === 2 &&
      weirdProgramDataProfile.emptyProgramListCount === 2 &&
      weirdProgramDataProfile.invalidProgramIndexCount === 1 &&
      weirdProgramDataProfile.duplicateProgramListIdCount === 1 &&
      weirdProgramDataProfile.flags.includes("invalid-program-list-id") &&
      weirdProgramDataProfile.flags.includes("empty-program-list") &&
      weirdProgramDataProfile.flags.includes("invalid-program-index") &&
      weirdProgramDataProfile.flags.includes("duplicate-program-list-id") &&
      ambiguousProgramDataProfile.category === "no-valid-programs" &&
      ambiguousProgramDataProfile.candidateProgramCount === 0 &&
      ambiguousProgramDataProfile.duplicateProgramIndexCount === 1 &&
      ambiguousProgramDataProfile.flags.includes("duplicate-program-index") &&
      ambiguousProgramDataProfile.flags.includes("no-valid-program-data-programs") &&
      missingProgramsProfile.category === "no-valid-programs" &&
      missingProgramsProfile.missingProgramArrayCount === 1 &&
      missingProgramsProfile.undisclosedProgramListCount === 1 &&
      missingProgramsProfile.flags.includes("missing-programs") &&
      missingProgramsProfile.flags.includes("program-data-undisclosed") &&
      cappedProgramDataProfile.category === "targeted" &&
      cappedProgramDataProfile.programListCount === 256 &&
      cappedProgramDataProfile.candidateProgramCount === 256 &&
      cappedProgramDataProfile.programListMetadataAtLimit === true &&
      cappedProgramDataProfile.programMetadataAtLimit === true &&
      cappedProgramDataProfile.flags.includes("program-list-metadata-at-limit") &&
      cappedProgramDataProfile.flags.includes("program-metadata-at-limit"),
    "installed plugin probe classifies VST3 program-data target edge cases"
  );
}
