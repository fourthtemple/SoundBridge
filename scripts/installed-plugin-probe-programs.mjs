import { assertNoNativeLaunchData } from "./installed-plugin-probe-file-grants.mjs";

const MAX_PLUGIN_PARAMETERS = 1024;
const MAX_PLUGIN_PROGRAM_DATA_BYTES = 384 * 1024;

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

  const target = firstVst3ProgramDataTarget(createdPlugin) ?? firstVst3ProgramDataTarget(plugin);
  result.vst3ProgramListCount = vst3ProgramLists(createdPlugin).length || undefined;
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
  for (const programList of vst3ProgramLists(plugin)) {
    if (programList?.programDataSupported !== true || !Array.isArray(programList.programs)) {
      continue;
    }
    const program = programList.programs.find((candidate) => Number.isInteger(candidate?.index));
    if (Number.isInteger(programList.id) && program) {
      return {
        programListId: programList.id,
        programIndex: program.index
      };
    }
  }
  return undefined;
}

function vst3ProgramLists(plugin) {
  return Array.isArray(plugin?.vst3ProgramLists) ? plugin.vst3ProgramLists : [];
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
