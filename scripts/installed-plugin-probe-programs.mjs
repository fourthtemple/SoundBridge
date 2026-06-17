import { assertNoNativeLaunchData } from "./installed-plugin-probe-file-grants.mjs";

const MAX_PLUGIN_PARAMETERS = 1024;
const MAX_PLUGIN_PROGRAMS = 256;
const MAX_PLUGIN_PROGRAM_LISTS = 256;
const MAX_PLUGIN_PROGRAM_DATA_BYTES = 384 * 1024;
const VST3_NO_PROGRAM_LIST_ID = -1;

export async function probeListedPreset({
  assertProbe,
  createdPlugin,
  instanceId,
  phase,
  plugin,
  request,
  result,
  session,
  socket
}) {
  const preset = firstListedPreset(createdPlugin) ?? firstListedPreset(plugin);
  if (!preset) {
    result.listedPreset = "skipped";
    return;
  }

  const response = await phase(result, "setPreset", () =>
    request(socket, "setPreset", { instanceId, presetId: preset.id }, true, session)
  );
  assertProbe(response.presetId === preset.id, "bad_listed_preset", "setPreset returned the wrong preset id");
  assertBoundedParameterSnapshot(response, assertProbe, "listed preset response");
  assertNoNativeLaunchData(response, "listed preset response", assertProbe);
  result.listedPreset = response.applied === true ? "applied" : "accepted";
  result.listedPresetParameterCount = response.parameterCount;
}

export async function probeVst3ProgramData({
  assertProbe,
  createdPlugin,
  instanceId,
  phase,
  plugin,
  request,
  result,
  session,
  socket
}) {
  if (String(plugin.format ?? "").toLowerCase() !== "vst3") {
    result.vst3ProgramData = "skipped-format";
    return;
  }

  const profileSource = {
    ...plugin,
    ...createdPlugin,
    format: plugin.format,
    vst3ProgramLists: Array.isArray(createdPlugin?.vst3ProgramLists) ? createdPlugin.vst3ProgramLists : plugin.vst3ProgramLists
  };
  result.vst3ProgramDataProfile = summarizeVst3ProgramDataProfile(profileSource);
  result.vst3ProgramListCount = result.vst3ProgramDataProfile.programListCount;
  const target = firstVst3ProgramDataTarget(createdPlugin) ?? firstVst3ProgramDataTarget(plugin);
  if (!target) {
    result.vst3ProgramData = "skipped";
    return;
  }

  const exported = await phase(result, "getVst3ProgramData", () =>
    request(
      socket,
      "getVst3ProgramData",
      {
        instanceId,
        programListId: target.programListId,
        programIndex: target.programIndex
      },
      true,
      session
    )
  );
  assertProbe(exported.format === "vst3", "bad_vst3_program_data", "VST3 program data reported the wrong format");
  assertProbe(exported.programListId === target.programListId, "bad_vst3_program_data", "VST3 program data reported the wrong program list");
  assertProbe(exported.programIndex === target.programIndex, "bad_vst3_program_data", "VST3 program data reported the wrong program index");
  assertProbe(
    Number.isInteger(exported.size) && exported.size >= 0 && exported.size <= MAX_PLUGIN_PROGRAM_DATA_BYTES,
    "bad_vst3_program_data",
    "VST3 program data size is not bounded"
  );
  assertProbe(typeof exported.data === "string", "bad_vst3_program_data", "VST3 raw program data is missing");
  assertProbe(
    typeof exported.programData === "string" && exported.programData.length > 0,
    "bad_vst3_program_data",
    "VST3 restore envelope is missing"
  );
  assertNoNativeLaunchData(exported, "VST3 program data response", assertProbe);

  const restored = await phase(result, "setVst3ProgramData", () =>
    request(socket, "setVst3ProgramData", { instanceId, programData: exported.programData }, true, session)
  );
  assertProbe(restored.restored === true, "bad_vst3_program_data_restore", "VST3 program data restore was not applied");
  assertProbe(restored.programListId === target.programListId, "bad_vst3_program_data_restore", "VST3 restore reported the wrong program list");
  assertProbe(restored.programIndex === target.programIndex, "bad_vst3_program_data_restore", "VST3 restore reported the wrong program index");
  assertBoundedParameterSnapshot(restored, assertProbe, "VST3 program data restore response");
  assertNoNativeLaunchData(restored, "VST3 program data restore response", assertProbe);
  result.vst3ProgramData = "restored";
  result.vst3ProgramDataSize = exported.size;
}

export function firstListedPreset(plugin) {
  const presets = Array.isArray(plugin?.presets) ? plugin.presets : [];
  for (const preset of presets) {
    if (!preset || typeof preset !== "object") {
      continue;
    }
    const id = String(preset.id ?? "");
    if (id && Buffer.byteLength(id, "utf8") <= 64) {
      return { id };
    }
  }
  return undefined;
}

export function firstVst3ProgramDataTarget(plugin) {
  const programLists = vst3ProgramLists(plugin).slice(0, MAX_PLUGIN_PROGRAM_LISTS);
  const programListIdCounts = boundedProgramListIdCounts(programLists);
  for (const programList of programLists) {
    const programListId = boundedProgramListId(programList?.id);
    if (
      programList?.programDataSupported !== true ||
      programListId === undefined ||
      programListIdCounts.get(programListId) !== 1 ||
      !Array.isArray(programList.programs)
    ) {
      continue;
    }
    const programIndexCounts = boundedProgramIndexCounts(programList.programs);
    const program = programList.programs
      .slice(0, MAX_PLUGIN_PROGRAMS)
      .find((candidate) => {
        const programIndex = boundedProgramIndex(candidate?.index);
        return programIndex !== undefined && programIndexCounts.get(programIndex) === 1;
      });
    if (program) {
      return {
        programListId,
        programIndex: boundedProgramIndex(program.index)
      };
    }
  }
  return undefined;
}

export function summarizeVst3ProgramDataProfile(plugin) {
  if (String(plugin?.format ?? "").toLowerCase() !== "vst3") {
    return {
      category: "skipped-format",
      flags: ["skipped-format"],
      programListCount: 0,
      programDataListCount: 0,
      candidateProgramCount: 0,
      programListMetadataAtLimit: false,
      programMetadataAtLimit: false
    };
  }

  const sourceLists = vst3ProgramLists(plugin);
  const lists = sourceLists.slice(0, MAX_PLUGIN_PROGRAM_LISTS);
  const programListMetadataAtLimit = sourceLists.length >= MAX_PLUGIN_PROGRAM_LISTS;
  const flags = [];
  let programDataListCount = 0;
  let candidateProgramCount = 0;
  let unsupportedProgramListCount = 0;
  let undisclosedProgramListCount = 0;
  let missingProgramArrayCount = 0;
  let emptyProgramListCount = 0;
  let invalidProgramListCount = 0;
  let invalidProgramIndexCount = 0;
  let duplicateProgramListIdCount = 0;
  let duplicateProgramIndexCount = 0;
  let programMetadataAtLimit = false;

  if (lists.length === 0) {
    flags.push("no-program-lists");
  }
  if (programListMetadataAtLimit) {
    flags.push("program-list-metadata-at-limit");
  }

  const programListIdCounts = boundedProgramListIdCounts(lists);
  const seenProgramListIds = new Set();
  for (const programList of lists) {
    const programListId = boundedProgramListId(programList?.id);
    if (programListId === undefined) {
      invalidProgramListCount += 1;
      flags.push("invalid-program-list-id");
      continue;
    }
    if (seenProgramListIds.has(programListId)) {
      duplicateProgramListIdCount += 1;
    }
    seenProgramListIds.add(programListId);

    if (programList?.programDataSupported !== true) {
      if (programList?.programDataSupported === false) {
        unsupportedProgramListCount += 1;
      } else {
        undisclosedProgramListCount += 1;
      }
      flags.push(programList?.programDataSupported === false ? "program-data-unsupported" : "program-data-undisclosed");
      continue;
    }

    programDataListCount += 1;
    if (!Array.isArray(programList.programs)) {
      missingProgramArrayCount += 1;
      flags.push("missing-programs");
      continue;
    }
    if (programList.programs.length >= MAX_PLUGIN_PROGRAMS) {
      programMetadataAtLimit = true;
      flags.push("program-metadata-at-limit");
    }
    if (programList.programs.length === 0) {
      emptyProgramListCount += 1;
      flags.push("empty-program-list");
      continue;
    }

    const programIndexCounts = boundedProgramIndexCounts(programList.programs);
    let validProgramIndexCount = 0;
    const seenProgramIndexes = new Set();
    for (const program of programList.programs.slice(0, MAX_PLUGIN_PROGRAMS)) {
      const programIndex = boundedProgramIndex(program?.index);
      if (programIndex === undefined) {
        invalidProgramIndexCount += 1;
      } else {
        if (seenProgramIndexes.has(programIndex)) {
          duplicateProgramIndexCount += 1;
        }
        seenProgramIndexes.add(programIndex);
        validProgramIndexCount += 1;
      }
    }
    if (validProgramIndexCount === 0) {
      flags.push("invalid-program-index");
      continue;
    }
    if (programListIdCounts.get(programListId) === 1) {
      candidateProgramCount += [...programIndexCounts.values()].filter((count) => count === 1).length;
    }
  }

  if (programDataListCount === 0 && lists.length > 0) {
    flags.push("no-program-data-support");
  } else if (programDataListCount > 0 && candidateProgramCount === 0) {
    flags.push("no-valid-program-data-programs");
  } else if (candidateProgramCount > 0) {
    flags.push("bounded-target");
  }
  if (duplicateProgramIndexCount > 0) {
    flags.push("duplicate-program-index");
  }
  if (duplicateProgramListIdCount > 0) {
    flags.push("duplicate-program-list-id");
  }

  return {
    category: vst3ProgramDataProfileCategory(lists.length, programDataListCount, candidateProgramCount),
    flags: [...new Set(flags)],
    programListCount: lists.length,
    programDataListCount,
    candidateProgramCount,
    unsupportedProgramListCount,
    undisclosedProgramListCount,
    missingProgramArrayCount,
    emptyProgramListCount,
    invalidProgramListCount,
    invalidProgramIndexCount,
    duplicateProgramListIdCount,
    duplicateProgramIndexCount,
    programListMetadataAtLimit,
    programMetadataAtLimit
  };
}

function vst3ProgramDataProfileCategory(programListCount, programDataListCount, candidateProgramCount) {
  if (programListCount === 0) {
    return "none";
  }
  if (candidateProgramCount > 0) {
    return "targeted";
  }
  return programDataListCount > 0 ? "no-valid-programs" : "unsupported";
}

function vst3ProgramLists(plugin) {
  return Array.isArray(plugin?.vst3ProgramLists) ? plugin.vst3ProgramLists : [];
}

function boundedProgramListId(value) {
  const id = boundedInt(value, -2147483648, 2147483647);
  return id === VST3_NO_PROGRAM_LIST_ID ? undefined : id;
}

function boundedProgramIndex(value) {
  return boundedInt(value, 0, MAX_PLUGIN_PROGRAMS - 1);
}

function boundedProgramListIdCounts(programLists) {
  const counts = new Map();
  for (const programList of programLists) {
    const programListId = boundedProgramListId(programList?.id);
    if (programListId !== undefined) {
      counts.set(programListId, (counts.get(programListId) ?? 0) + 1);
    }
  }
  return counts;
}

function boundedProgramIndexCounts(programs) {
  const counts = new Map();
  if (!Array.isArray(programs)) {
    return counts;
  }
  for (const program of programs.slice(0, MAX_PLUGIN_PROGRAMS)) {
    const programIndex = boundedProgramIndex(program?.index);
    if (programIndex !== undefined) {
      counts.set(programIndex, (counts.get(programIndex) ?? 0) + 1);
    }
  }
  return counts;
}

function boundedInt(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

function assertBoundedParameterSnapshot(response, assertProbe, context) {
  assertProbe(Number.isInteger(response.parameterCount), "bad_parameter_snapshot", `${context} did not report a bounded parameter count`);
  assertProbe(
    Array.isArray(response.parameters) && response.parameters.length === response.parameterCount,
    "bad_parameter_snapshot",
    `${context} parameter array did not match parameterCount`
  );
  assertProbe(response.parameterCount <= MAX_PLUGIN_PARAMETERS, "bad_parameter_snapshot", `${context} exceeded the parameter limit`);
  for (const [index, parameter] of response.parameters.entries()) {
    assertProbe(parameter && typeof parameter === "object", "bad_parameter_snapshot", `${context} parameter ${index} was not an object`);
    assertProbe(
      typeof parameter.id === "string" && Buffer.byteLength(parameter.id, "utf8") <= 64,
      "bad_parameter_snapshot",
      `${context} parameter ${index} id was not bounded`
    );
    if (parameter.displayValue != null) {
      assertProbe(
        typeof parameter.displayValue === "string" &&
          Buffer.byteLength(parameter.displayValue, "utf8") <= 160 &&
          !parameter.displayValue.includes("\u0000"),
        "bad_parameter_snapshot",
        `${context} parameter ${index} displayValue was not bounded`
      );
    }
  }
}
