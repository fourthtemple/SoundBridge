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

  const targetedProgramDataProfile = summarizeVst3ProgramDataProfile({
    format: "vst3",
    vst3ProgramLists: [
      { id: 1, programDataSupported: false, programs: [{ index: 0 }] },
      { id: 2, programDataSupported: true, programs: [{ index: 3 }, { index: 3 }, { index: "bad" }] }
    ]
  });
  const weirdProgramDataProfile = summarizeVst3ProgramDataProfile({
    format: "vst3",
    vst3ProgramLists: [
      { id: "bad", programDataSupported: true, programs: [{ index: 0 }] },
      { id: 4, programDataSupported: true, programs: [] },
      { id: 5, programDataSupported: true, programs: [{ index: 256 }] }
    ]
  });
  const missingProgramsProfile = summarizeVst3ProgramDataProfile({
    format: "vst3",
    vst3ProgramLists: [
      { id: 6, programDataSupported: true },
      { id: 7, programs: [{ index: 0 }] }
    ]
  });
  check(
    targetedProgramDataProfile.category === "targeted" &&
      targetedProgramDataProfile.flags.includes("program-data-unsupported") &&
      targetedProgramDataProfile.flags.includes("bounded-target") &&
      targetedProgramDataProfile.programListCount === 2 &&
      targetedProgramDataProfile.programDataListCount === 1 &&
      targetedProgramDataProfile.candidateProgramCount === 2 &&
      targetedProgramDataProfile.unsupportedProgramListCount === 1 &&
      targetedProgramDataProfile.invalidProgramIndexCount === 1 &&
      targetedProgramDataProfile.duplicateProgramIndexCount === 1 &&
      targetedProgramDataProfile.flags.includes("duplicate-program-index") &&
      weirdProgramDataProfile.category === "no-valid-programs" &&
      weirdProgramDataProfile.invalidProgramListCount === 1 &&
      weirdProgramDataProfile.emptyProgramListCount === 1 &&
      weirdProgramDataProfile.invalidProgramIndexCount === 1 &&
      weirdProgramDataProfile.flags.includes("invalid-program-list-id") &&
      weirdProgramDataProfile.flags.includes("empty-program-list") &&
      weirdProgramDataProfile.flags.includes("invalid-program-index") &&
      missingProgramsProfile.category === "no-valid-programs" &&
      missingProgramsProfile.missingProgramArrayCount === 1 &&
      missingProgramsProfile.undisclosedProgramListCount === 1 &&
      missingProgramsProfile.flags.includes("missing-programs") &&
      missingProgramsProfile.flags.includes("program-data-undisclosed"),
    "installed plugin probe classifies VST3 program-data target edge cases"
  );
}
