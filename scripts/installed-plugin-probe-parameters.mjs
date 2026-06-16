const MAX_PLUGIN_PARAMETERS = 1024;

export function assertParameterDisplayMetadata({ assertProbe, parameters, plugin }) {
  if (!Array.isArray(parameters)) {
    return 0;
  }
  let count = 0;
  for (const [index, parameter] of parameters.entries()) {
    if (parameter?.displayValue == null) {
      continue;
    }
    ++count;
    const ok = typeof parameter.displayValue === "string" &&
      Buffer.byteLength(parameter.displayValue, "utf8") <= 160 &&
      !parameter.displayValue.includes("\u0000");
    assertProbe(ok, "bad_parameter_display_value", `${plugin.pluginId} parameter ${index} returned an unbounded displayValue`);
  }
  return count;
}

export async function probeParameterDisplayInput({
  assertProbe,
  instanceId,
  parameter,
  phase,
  request,
  result,
  session,
  socket
}) {
  if (typeof parameter.displayValue !== "string" || parameter.displayValue.length === 0) {
    result.parameterDisplayInput = "skipped";
    return;
  }
  const response = await phase(result, "setParameterDisplayValue", () =>
    request(
      socket,
      "setParameterDisplayValue",
      { instanceId, parameterId: parameter.id, displayValue: parameter.displayValue },
      true,
      session
    )
  );
  assertProbe(response.parameter?.id === parameter.id, "bad_parameter_display_input", "display text updated the wrong parameter");
  result.parameterDisplayInput = "applied";
}

export function summarizeParameterProfile(parameters, { atLimit = false, format = "" } = {}) {
  if (!Array.isArray(parameters)) {
    return {
      category: "missing",
      flags: ["missing"],
      parameterCount: 0,
      automatableCount: 0,
      writableCount: 0,
      readOnlyCount: 0,
      displayValueCount: 0,
      unitCount: 0,
      programChangeCount: 0,
      vst3UnitCount: 0,
      duplicateParameterIdCount: 0
    };
  }

  const bounded = parameters.slice(0, MAX_PLUGIN_PARAMETERS);
  const isVst3 = String(format ?? "").toLowerCase() === "vst3";
  const profile = {
    category: "none",
    flags: [],
    parameterCount: bounded.length,
    automatableCount: 0,
    writableCount: 0,
    readOnlyCount: 0,
    displayValueCount: 0,
    unitCount: 0,
    programChangeCount: 0,
    vst3UnitCount: 0,
    duplicateParameterIdCount: 0
  };

  const seenIds = new Set();
  for (const parameter of bounded) {
    const parameterId = typeof parameter?.id === "string" ? parameter.id : "";
    if (parameterId) {
      if (seenIds.has(parameterId)) {
        profile.duplicateParameterIdCount += 1;
      }
      seenIds.add(parameterId);
    }
    if (parameter?.automatable !== false) {
      profile.automatableCount += 1;
    }
    if (parameter?.readOnly === true) {
      profile.readOnlyCount += 1;
    }
    if (parameter?.automatable !== false && parameter?.readOnly !== true) {
      profile.writableCount += 1;
    }
    if (typeof parameter?.displayValue === "string" && parameter.displayValue.length > 0) {
      profile.displayValueCount += 1;
    }
    if (typeof parameter?.unit === "string" && parameter.unit.length > 0) {
      profile.unitCount += 1;
    }
    if (parameter?.programChange === true) {
      profile.programChangeCount += 1;
    }
    if (isVst3 && parameter?.vst3Unit && typeof parameter.vst3Unit === "object") {
      profile.vst3UnitCount += 1;
    }
  }

  profile.category = parameterProfileCategory(profile);
  profile.flags = parameterProfileFlags(profile, { atLimit, isVst3 });
  return profile;
}

function parameterProfileCategory(profile) {
  if (profile.parameterCount === 0) {
    return "none";
  }
  if (profile.writableCount > 0) {
    return "writable";
  }
  if (profile.automatableCount > 0) {
    return "automation-only";
  }
  if (profile.readOnlyCount > 0) {
    return "read-only";
  }
  return "listed";
}

function parameterProfileFlags(profile, { atLimit, isVst3 }) {
  const flags = [];
  if (profile.parameterCount === 0) {
    flags.push("no-parameters");
  }
  if (atLimit) {
    flags.push("metadata-at-limit");
  }
  if (profile.writableCount > 0) {
    flags.push("writable");
  } else if (profile.parameterCount > 0) {
    flags.push("no-writable-parameters");
  }
  if (profile.automatableCount > 0) {
    flags.push("automatable");
  }
  if (profile.readOnlyCount > 0) {
    flags.push("read-only");
  }
  flags.push(profile.displayValueCount > 0 ? "display-values" : "no-display-values");
  if (profile.unitCount > 0) {
    flags.push("units");
  }
  if (profile.programChangeCount > 0) {
    flags.push("program-change");
  }
  if (isVst3 && profile.vst3UnitCount > 0) {
    flags.push("vst3-units");
  }
  if (profile.duplicateParameterIdCount > 0) {
    flags.push("duplicate-parameter-id");
  }
  return flags;
}
