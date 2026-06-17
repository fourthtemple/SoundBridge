const MAX_PLUGIN_PARAMETERS = 1024;
const MAX_VST3_MIDI_MAPPINGS = 256;
const MAX_VST3_MIDI_MAPPING_SCAN = MAX_VST3_MIDI_MAPPINGS * 2;
const VST3_MIDI_AFTERTOUCH_CONTROLLER = 128;
const VST3_MIDI_PITCH_BEND_CONTROLLER = 129;

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
      nameFallbackCount: 0,
      displayValueCount: 0,
      unitCount: 0,
      programChangeCount: 0,
      programChangeWithoutListCount: 0,
      vst3UnitCount: 0,
      vst3UnitNameFallbackCount: 0,
      vst3UnitProgramListLinkCount: 0,
      invalidVst3UnitProgramListLinkCount: 0,
      vst3MidiMappedParameterCount: 0,
      vst3MidiMappingCount: 0,
      vst3MidiMappingControllerCount: 0,
      vst3MidiMappingBusCount: 0,
      vst3MidiMappingChannelCount: 0,
      vst3MidiDuplicateMappingCount: 0,
      invalidVst3MidiMappingCount: 0,
      invalidVst3MidiMappingRouteCount: 0,
      invalidVst3MidiMappingControllerCount: 0,
      vst3MidiCcMappingCount: 0,
      vst3MidiAftertouchMappingCount: 0,
      vst3MidiPitchBendMappingCount: 0,
      vst3MidiMappingControllers: [],
      vst3MidiMappingBuses: [],
      vst3MidiMappingChannels: [],
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
    nameFallbackCount: 0,
    displayValueCount: 0,
    unitCount: 0,
    programChangeCount: 0,
    programChangeWithoutListCount: 0,
    vst3UnitCount: 0,
    vst3UnitNameFallbackCount: 0,
    vst3UnitProgramListLinkCount: 0,
    invalidVst3UnitProgramListLinkCount: 0,
    vst3MidiMappedParameterCount: 0,
    vst3MidiMappingCount: 0,
    vst3MidiMappingControllerCount: 0,
    vst3MidiMappingBusCount: 0,
    vst3MidiMappingChannelCount: 0,
    vst3MidiDuplicateMappingCount: 0,
    invalidVst3MidiMappingCount: 0,
    invalidVst3MidiMappingRouteCount: 0,
    invalidVst3MidiMappingControllerCount: 0,
    vst3MidiCcMappingCount: 0,
    vst3MidiAftertouchMappingCount: 0,
    vst3MidiPitchBendMappingCount: 0,
    vst3MidiMappingControllers: [],
    vst3MidiMappingBuses: [],
    vst3MidiMappingChannels: [],
    duplicateParameterIdCount: 0
  };

  const seenIds = new Set();
  const midiMappingControllers = new Set();
  const midiMappingBuses = new Set();
  const midiMappingChannels = new Set();
  const midiMappingKeys = new Set();
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
    if (parameter?.nameFallback === true || hasEmptyName(parameter)) {
      profile.nameFallbackCount += 1;
    }
    if (typeof parameter?.displayValue === "string" && parameter.displayValue.length > 0) {
      profile.displayValueCount += 1;
    }
    if (typeof parameter?.unit === "string" && parameter.unit.length > 0) {
      profile.unitCount += 1;
    }
    if (parameter?.programChange === true) {
      profile.programChangeCount += 1;
      if (!Array.isArray(parameter.programList?.programs) || parameter.programList.programs.length === 0) {
        profile.programChangeWithoutListCount += 1;
      }
    }
    if (isVst3 && parameter?.vst3Unit && typeof parameter.vst3Unit === "object") {
      profile.vst3UnitCount += 1;
      if (parameter.vst3Unit.nameFallback === true || hasEmptyName(parameter.vst3Unit)) {
        profile.vst3UnitNameFallbackCount += 1;
      }
      const programListId = boundedVst3ProgramListId(parameter.vst3Unit.programListId);
      if (programListId !== undefined) {
        profile.vst3UnitProgramListLinkCount += 1;
      } else if (hasOwn(parameter.vst3Unit, "programListId")) {
        profile.invalidVst3UnitProgramListLinkCount += 1;
      }
    }
    const remainingValidMidiMappings = MAX_VST3_MIDI_MAPPINGS - profile.vst3MidiMappingCount;
    const remainingInvalidMidiMappings = MAX_VST3_MIDI_MAPPINGS - profile.invalidVst3MidiMappingCount;
    const midiMappingProfile = isVst3 && (remainingValidMidiMappings > 0 || remainingInvalidMidiMappings > 0)
      ? boundedVst3MidiMappings(parameter?.vst3MidiMappings, {
        validLimit: remainingValidMidiMappings,
        invalidLimit: remainingInvalidMidiMappings
      })
      : { valid: [], invalidCount: 0 };
    const midiMappings = midiMappingProfile.valid;
    profile.invalidVst3MidiMappingCount = Math.min(
      MAX_VST3_MIDI_MAPPINGS,
      profile.invalidVst3MidiMappingCount + midiMappingProfile.invalidCount
    );
    profile.invalidVst3MidiMappingRouteCount = Math.min(
      MAX_VST3_MIDI_MAPPINGS,
      profile.invalidVst3MidiMappingRouteCount + midiMappingProfile.invalidRouteCount
    );
    profile.invalidVst3MidiMappingControllerCount = Math.min(
      MAX_VST3_MIDI_MAPPINGS,
      profile.invalidVst3MidiMappingControllerCount + midiMappingProfile.invalidControllerCount
    );
    if (midiMappings.length > 0) {
      profile.vst3MidiMappedParameterCount += 1;
      profile.vst3MidiMappingCount += midiMappings.length;
      for (const mapping of midiMappings) {
        midiMappingControllers.add(mapping.controller);
        midiMappingBuses.add(mapping.busIndex);
        midiMappingChannels.add(mapping.channel);
        if (mapping.controller === VST3_MIDI_PITCH_BEND_CONTROLLER) {
          profile.vst3MidiPitchBendMappingCount += 1;
        } else if (mapping.controller === VST3_MIDI_AFTERTOUCH_CONTROLLER) {
          profile.vst3MidiAftertouchMappingCount += 1;
        } else {
          profile.vst3MidiCcMappingCount += 1;
        }
        const mappingKey = `${mapping.busIndex}:${mapping.channel}:${mapping.controller}`;
        if (midiMappingKeys.has(mappingKey)) {
          profile.vst3MidiDuplicateMappingCount += 1;
        }
        midiMappingKeys.add(mappingKey);
      }
    }
  }

  profile.vst3MidiMappingControllers = sortedIntegers(midiMappingControllers);
  profile.vst3MidiMappingBuses = sortedIntegers(midiMappingBuses);
  profile.vst3MidiMappingChannels = sortedIntegers(midiMappingChannels);
  profile.vst3MidiMappingControllerCount = profile.vst3MidiMappingControllers.length;
  profile.vst3MidiMappingBusCount = profile.vst3MidiMappingBuses.length;
  profile.vst3MidiMappingChannelCount = profile.vst3MidiMappingChannels.length;
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
  if (profile.nameFallbackCount > 0) {
    flags.push("parameter-name-fallback");
  }
  flags.push(profile.displayValueCount > 0 ? "display-values" : "no-display-values");
  if (profile.unitCount > 0) {
    flags.push("units");
  }
  if (profile.programChangeCount > 0) {
    flags.push("program-change");
  }
  if (profile.programChangeWithoutListCount > 0) {
    flags.push("program-change-without-list");
  }
  if (isVst3 && profile.vst3UnitCount > 0) {
    flags.push("vst3-units");
  }
  if (isVst3 && profile.vst3UnitNameFallbackCount > 0) {
    flags.push("vst3-unit-name-fallback");
  }
  if (isVst3 && profile.vst3UnitProgramListLinkCount > 0) {
    flags.push("vst3-unit-program-list-link");
  }
  if (isVst3 && profile.invalidVst3UnitProgramListLinkCount > 0) {
    flags.push("invalid-vst3-unit-program-list-link");
  }
  if (isVst3 && profile.vst3MidiMappingCount > 0) {
    flags.push("vst3-midi-mapping");
    if (profile.vst3MidiMappingControllerCount > 1) {
      flags.push("vst3-midi-mapping-multi-controller");
    }
    if (profile.vst3MidiMappingBuses.some((busIndex) => busIndex > 0)) {
      flags.push("vst3-midi-mapping-non-main-event-bus");
    }
    if (profile.vst3MidiMappingChannels.some((channel) => channel > 0)) {
      flags.push("vst3-midi-mapping-non-main-channel");
    }
    if (profile.vst3MidiMappingCount >= MAX_VST3_MIDI_MAPPINGS) {
      flags.push("vst3-midi-mapping-at-limit");
    }
    if (profile.vst3MidiDuplicateMappingCount > 0) {
      flags.push("vst3-midi-mapping-duplicate");
    }
    if (profile.vst3MidiCcMappingCount > 0) {
      flags.push("vst3-midi-mapping-cc");
    }
    if (profile.vst3MidiAftertouchMappingCount > 0) {
      flags.push("vst3-midi-mapping-aftertouch");
    }
    if (profile.vst3MidiPitchBendMappingCount > 0) {
      flags.push("vst3-midi-mapping-pitch-bend");
    }
  }
  if (isVst3 && profile.invalidVst3MidiMappingCount > 0) {
    flags.push("invalid-vst3-midi-mapping");
  }
  if (isVst3 && profile.invalidVst3MidiMappingRouteCount > 0) {
    flags.push("invalid-vst3-midi-mapping-route");
  }
  if (isVst3 && profile.invalidVst3MidiMappingControllerCount > 0) {
    flags.push("invalid-vst3-midi-mapping-controller");
  }
  if (profile.duplicateParameterIdCount > 0) {
    flags.push("duplicate-parameter-id");
  }
  return flags;
}

function boundedVst3MidiMappings(
  mappings,
  { validLimit = MAX_VST3_MIDI_MAPPINGS, invalidLimit = MAX_VST3_MIDI_MAPPINGS } = {}
) {
  if (!Array.isArray(mappings)) {
    return { valid: [], invalidCount: 0, invalidRouteCount: 0, invalidControllerCount: 0 };
  }
  const valid = [];
  let invalidCount = 0;
  let invalidRouteCount = 0;
  let invalidControllerCount = 0;
  for (const mapping of mappings.slice(0, MAX_VST3_MIDI_MAPPING_SCAN)) {
    const issues = vst3MidiMappingIssues(mapping);
    if (!issues.invalidRoute && !issues.invalidController) {
      if (valid.length >= validLimit) {
        continue;
      }
      valid.push(mapping);
      continue;
    }
    if (invalidCount >= invalidLimit) {
      continue;
    }
    invalidCount += 1;
    invalidRouteCount += issues.invalidRoute ? 1 : 0;
    invalidControllerCount += issues.invalidController ? 1 : 0;
  }
  return { valid, invalidCount, invalidRouteCount, invalidControllerCount };
}

function validVst3MidiMapping(mapping) {
  const issues = vst3MidiMappingIssues(mapping);
  return !issues.invalidRoute && !issues.invalidController;
}

function vst3MidiMappingIssues(mapping) {
  return {
    invalidRoute:
      !Number.isInteger(mapping?.busIndex) ||
      mapping.busIndex < 0 ||
      mapping.busIndex > 31 ||
      !Number.isInteger(mapping?.channel) ||
      mapping.channel < 0 ||
      mapping.channel > 15,
    invalidController:
      !Number.isInteger(mapping?.controller) ||
      mapping.controller < 0 ||
      mapping.controller > 129
  };
}

function sortedIntegers(values) {
  return [...values].sort((left, right) => left - right);
}

function boundedVst3ProgramListId(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < -2_147_483_648 || numeric > 2_147_483_647 || numeric === -1) {
    return undefined;
  }
  return numeric;
}

function hasOwn(object, key) {
  return object != null && Object.prototype.hasOwnProperty.call(object, key);
}

function hasEmptyName(value) {
  return hasOwn(value, "name") && String(value.name ?? "").length === 0;
}
