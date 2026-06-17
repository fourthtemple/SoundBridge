import { createMidiEventEncoder } from "./daemon-midi-event-encoding.mjs";

export function createDaemonNormalizers(options = {}) {
  const vst3NoParamId = "4294967295";
  const vst3NoProgramListId = -1;
  const limits = {
    maxAudioChannels: positiveInteger(options.maxAudioChannels, 32),
    maxBlockSize: positiveInteger(options.maxBlockSize, 8192),
    maxPluginBuses: positiveInteger(options.maxPluginBuses, 32),
    maxPluginLatencySamples: positiveInteger(options.maxPluginLatencySamples, 1_048_576),
    maxPluginParameters: positiveInteger(options.maxPluginParameters, 1024),
    maxPluginParameterTextBytes: positiveInteger(options.maxPluginParameterTextBytes, 160),
    maxPluginNoteExpressions: positiveInteger(options.maxPluginNoteExpressions, 256),
    maxPluginNoteExpressionTextBytes: positiveInteger(options.maxPluginNoteExpressionTextBytes, 256),
    maxPluginMidiMappings: positiveInteger(options.maxPluginMidiMappings, 256),
    maxPluginProgramDataBytes: positiveInteger(options.maxPluginProgramDataBytes, 384 * 1024),
    maxPluginProgramLists: positiveInteger(options.maxPluginProgramLists, 256),
    maxPluginPrograms: positiveInteger(options.maxPluginPrograms, 256),
    maxPluginStateBytes: positiveInteger(options.maxPluginStateBytes, 384 * 1024),
    maxPluginTailSamples: positiveInteger(options.maxPluginTailSamples, 1_048_576),
    minSampleRate: positiveInteger(options.minSampleRate, 8000),
    maxSampleRate: positiveInteger(options.maxSampleRate, 384000)
  };
  const protocolError = options.makeProtocolError ?? defaultProtocolError;
  const { encodeMidiEvents } = createMidiEventEncoder({ limits, protocolError });

  function normalizeWorkerParameters(parameters) {
    if (!Array.isArray(parameters)) {
      return [];
    }
    return parameters
      .slice(0, limits.maxPluginParameters)
      .map((parameter) => normalizeWorkerParameter(parameter))
      .filter(Boolean);
  }

  function normalizeWorkerParameter(parameter) {
    if (!parameter || typeof parameter !== "object") {
      return undefined;
    }
    const id = truncateText(parameter.id, 64);
    if (!id) {
      return undefined;
    }
    const normalizedValue = clamp01(Number(parameter.normalizedValue));
    const defaultNormalizedValue = clamp01(Number(parameter.defaultNormalizedValue ?? normalizedValue));
    const minPlain = finiteNumber(parameter.minPlain, 0);
    const maxPlain = finiteNumber(parameter.maxPlain, 1);
    const plainValue = finiteNumber(parameter.plainValue, minPlain + (maxPlain - minPlain) * normalizedValue);

    const normalized = {
      id,
      name: truncateText(parameter.name, limits.maxPluginParameterTextBytes) || id,
      normalizedValue,
      defaultNormalizedValue,
      displayValue: truncateText(parameter.displayValue, limits.maxPluginParameterTextBytes) || undefined,
      unit: truncateText(parameter.unit, 64) || undefined,
      minPlain,
      maxPlain,
      plainValue,
      automatable: parameter.automatable !== false,
      stepCount: Math.max(0, Math.min(1_000_000, Math.floor(Number(parameter.stepCount ?? 0)))),
      readOnly: Boolean(parameter.readOnly)
    };
    if (parameter.nameFallback === true) {
      normalized.nameFallback = true;
    }
    const vst3Unit = normalizeVst3Unit(parameter.vst3Unit);
    if (vst3Unit) {
      normalized.vst3Unit = vst3Unit;
    }
    const vst3MidiMappings = normalizeVst3MidiMappings(parameter.vst3MidiMappings);
    if (vst3MidiMappings.length > 0) {
      normalized.vst3MidiMappings = vst3MidiMappings;
    }
    if (parameter.programChange === true) {
      normalized.programChange = true;
      const programList = normalizeProgramList(parameter.programList);
      if (programList) {
        normalized.programList = programList;
      }
    }
    return normalized;
  }

  function normalizeVst3MidiMappings(mappings) {
    if (!Array.isArray(mappings)) {
      return [];
    }
    return mappings
      .slice(0, limits.maxPluginMidiMappings)
      .map((mapping) => {
        if (!mapping || typeof mapping !== "object") {
          return undefined;
        }
        const busIndex = boundedInteger(mapping.busIndex, 0, limits.maxPluginBuses - 1);
        const channel = boundedInteger(mapping.channel, 0, 15);
        const controller = boundedInteger(mapping.controller, 0, 129);
        return busIndex === undefined || channel === undefined || controller === undefined
          ? undefined
          : { busIndex, channel, controller };
      })
      .filter(Boolean);
  }

  function normalizeVst3Unit(unit) {
    if (!unit || typeof unit !== "object") {
      return undefined;
    }
    const rawId = Number(unit.id);
    if (!Number.isInteger(rawId) || rawId < -2147483648 || rawId > 2147483647) {
      return undefined;
    }
    const id = rawId;
    const fallbackName = `Unit ${id}`;
    const name = truncateText(unit.name, limits.maxPluginParameterTextBytes);
    const nameFallback = unit.nameFallback === true || !name;
    const normalized = {
      id,
      parentUnitId: normalizeInt(unit.parentUnitId, -2147483648, 2147483647, 0),
      name: name || fallbackName
    };
    if (nameFallback) {
      normalized.nameFallback = true;
    }
    if (unit.programListId !== undefined) {
      const programListId = normalizeSignedInt32(unit.programListId);
      if (programListId !== undefined && programListId !== vst3NoProgramListId) {
        normalized.programListId = programListId;
      }
    }
    return normalized;
  }

  function normalizeProgramList(programList) {
    if (!programList || typeof programList !== "object" || !Array.isArray(programList.programs)) {
      return undefined;
    }
    const programs = programList.programs
      .slice(0, limits.maxPluginPrograms)
      .map((program, fallbackIndex) => {
        if (!program || typeof program !== "object") {
          return undefined;
        }
        const index = normalizeProgramIndex(program.index, fallbackIndex);
        if (index === undefined) {
          return undefined;
        }
        const name = truncateText(program.name ?? `Program ${index + 1}`, limits.maxPluginParameterTextBytes) || `Program ${index + 1}`;
        const normalized = {
          index,
          name,
          normalizedValue: clamp01(Number(program.normalizedValue))
        };
        if (program.nameFallback === true) {
          normalized.nameFallback = true;
        }
        return normalized;
      })
      .filter(Boolean);
    if (programs.length === 0) {
      return undefined;
    }
    const id = normalizeProgramListId(programList.id);
    if (id === undefined) {
      return undefined;
    }
    const normalized = {
      id,
      name: truncateText(programList.name ?? "Programs", limits.maxPluginParameterTextBytes) || "Programs",
      programs
    };
    if (programList.nameFallback === true) {
      normalized.nameFallback = true;
    }
    if (programList.unitId !== undefined) {
      const unitId = normalizeSignedInt32(programList.unitId);
      if (unitId !== undefined) {
        normalized.unitId = unitId;
      }
    }
    if (programList.programDataSupported === true || programList.programDataSupported === false) {
      normalized.programDataSupported = programList.programDataSupported;
    }
    return normalized;
  }

  function normalizeProgramListId(value) {
    const id = normalizeSignedInt32(value);
    return id === vst3NoProgramListId ? undefined : id;
  }

  function normalizeSignedInt32(value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647) {
      return undefined;
    }
    return number;
  }

  function normalizeProgramIndex(value, fallbackIndex) {
    if (value == null) {
      return normalizeInt(fallbackIndex, 0, limits.maxPluginPrograms - 1, 0);
    }
    if (typeof value === "string" && value.trim() === "") {
      return undefined;
    }
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number >= limits.maxPluginPrograms) {
      return undefined;
    }
    return number;
  }

  function normalizeVst3ProgramLists(programLists) {
    if (!Array.isArray(programLists)) {
      return [];
    }
    return programLists
      .slice(0, limits.maxPluginProgramLists)
      .map((programList) => normalizeProgramList(programList))
      .filter(Boolean);
  }

  function normalizeVst3ProgramData(programData) {
    if (!programData || typeof programData !== "object") {
      return undefined;
    }
    if (programData.format !== undefined && programData.format !== "vst3") {
      throw protocolError("bad_program_data", "VST3 program data reported the wrong format.");
    }
    if (typeof programData.data !== "string") {
      throw protocolError("bad_program_data", "VST3 program data bytes must be base64 text.");
    }
    const data = programData.data;
    if (!isBase64Text(data)) {
      throw protocolError("bad_program_data", "VST3 program data was not valid base64.");
    }
    const size = decodedBase64Length(data);
    if (size > limits.maxPluginProgramDataBytes) {
      throw protocolError("program_data_too_large", "VST3 program data exceeded the configured limit.", {
        maxProgramDataBytes: limits.maxPluginProgramDataBytes
      });
    }
    const programListId = requireVst3ProgramDataProgramListId(programData.programListId);
    const programIndex = requireVst3ProgramDataInteger(
      programData.programIndex,
      0,
      limits.maxPluginPrograms - 1,
      "programIndex"
    );
    return {
      format: "vst3",
      programListId,
      programIndex,
      size,
      data
    };
  }

  function requireVst3ProgramDataInteger(value, min, max, label) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw protocolError("bad_program_data", `VST3 program data ${label} was out of range.`);
    }
    return value;
  }

  function requireVst3ProgramDataProgramListId(value) {
    const id = requireVst3ProgramDataInteger(value, -2147483648, 2147483647, "programListId");
    if (id === vst3NoProgramListId) {
      throw protocolError("bad_program_data", "VST3 program data cannot use the no-program-list sentinel.");
    }
    return id;
  }

  function normalizeVst3NoteExpressions(expressions) {
    if (!Array.isArray(expressions)) {
      return [];
    }
    return expressions
      .slice(0, limits.maxPluginNoteExpressions)
      .map((expression) => normalizeVst3NoteExpression(expression))
      .filter(Boolean);
  }

  function normalizeVst3NoteExpression(expression) {
    if (!expression || typeof expression !== "object") {
      return undefined;
    }
    const rawTypeId = Number(expression.typeId);
    if (!Number.isInteger(rawTypeId) || rawTypeId < 0 || rawTypeId > 4_294_967_295) {
      return undefined;
    }
    const name = truncateText(expression.name ?? `Expression ${rawTypeId}`, limits.maxPluginParameterTextBytes);
    const minValue = clamp01(Number(expression.minValue));
    const maxValue = Math.max(minValue, clamp01(Number(expression.maxValue)));
    const normalized = {
      typeId: rawTypeId,
      name: name || `Expression ${rawTypeId}`,
      defaultValue: Math.max(minValue, Math.min(maxValue, clamp01(Number(expression.defaultValue)))),
      minValue,
      maxValue,
      stepCount: normalizeInt(expression.stepCount, 0, 1_000_000, 0),
      busIndex: normalizeInt(expression.busIndex, 0, limits.maxPluginBuses - 1, 0),
      channel: normalizeInt(expression.channel, 0, 15, 0)
    };
    const shortName = truncateText(expression.shortName, limits.maxPluginParameterTextBytes);
    const unit = truncateText(expression.unit, 64);
    const associatedParameterId = normalizeVst3AssociatedParameterId(expression.associatedParameterId);
    if (shortName) normalized.shortName = shortName;
    if (unit) normalized.unit = unit;
    if (associatedParameterId) normalized.associatedParameterId = associatedParameterId;
    if (expression.unitId !== undefined) {
      const unitId = normalizeSignedInt32(expression.unitId);
      if (unitId !== undefined) {
        normalized.unitId = unitId;
      }
    }
    if (expression.nameFallback === true) normalized.nameFallback = true;
    if (expression.bipolar === true) normalized.bipolar = true;
    if (expression.oneShot === true) normalized.oneShot = true;
    if (expression.absolute === true) normalized.absolute = true;
    return normalized;
  }

  function normalizeVst3AssociatedParameterId(value) {
    const id = truncateText(value, 64);
    if (!id || id === vst3NoParamId || id === "-1") {
      return undefined;
    }
    return id;
  }

  function normalizeNativeState(nativeState, format) {
    if (nativeState == null) {
      return undefined;
    }
    if (!nativeState || typeof nativeState !== "object" || nativeState.format !== format) {
      throw protocolError("bad_state", "State belongs to a different native plugin format.");
    }

    if (format === "au" || format === "lv2") {
      return {
        format,
        state: normalizeStatePart(nativeState.state, "nativeState.state")
      };
    }

    if (format === "vst3") {
      const component = normalizeStatePart(nativeState.component, "nativeState.component");
      const controller = normalizeStatePart(nativeState.controller, "nativeState.controller");
      const totalBytes = decodedBase64Length(component) + decodedBase64Length(controller);
      if (totalBytes > limits.maxPluginStateBytes) {
        throw protocolError("state_too_large", "Native plugin state exceeded the configured state limit.", {
          maxStateBytes: limits.maxPluginStateBytes
        });
      }
      return {
        format,
        component,
        controller
      };
    }

    return undefined;
  }

  function normalizeWorkerState(format, state) {
    if (format === "au" || format === "lv2") {
      return {
        format,
        state: normalizeStatePart(state, "worker.state")
      };
    }

    if (format === "vst3") {
      if (!state || typeof state !== "object") {
        return {
          format,
          component: "",
          controller: ""
        };
      }
      const component = normalizeStatePart(state.component, "worker.state.component");
      const controller = normalizeStatePart(state.controller, "worker.state.controller");
      const totalBytes = decodedBase64Length(component) + decodedBase64Length(controller);
      if (totalBytes > limits.maxPluginStateBytes) {
        throw protocolError("state_too_large", "Native plugin state exceeded the configured state limit.", {
          maxStateBytes: limits.maxPluginStateBytes
        });
      }
      return {
        format,
        component,
        controller
      };
    }

    return undefined;
  }

  function normalizeStatePart(value, label) {
    const text = String(value ?? "");
    if (text.length === 0) {
      return "";
    }
    if (!isBase64Text(text)) {
      throw protocolError("bad_state", `${label} was not valid base64.`);
    }
    const decodedLength = decodedBase64Length(text);
    if (decodedLength > limits.maxPluginStateBytes) {
      throw protocolError("state_too_large", `${label} exceeded the configured state limit.`, {
        maxStateBytes: limits.maxPluginStateBytes
      });
    }
    return text;
  }

  function normalizeLatencySamples(value) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number) || number < 0) {
      return 0;
    }
    return Math.min(number, limits.maxPluginLatencySamples);
  }

  function normalizeTailSamples(value) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number) || number < 0) {
      return 0;
    }
    return Math.min(number, limits.maxPluginTailSamples);
  }

  function normalizeTailReport(value) {
    return {
      tailSamples: normalizeTailSamples(value?.tailSamples),
      infiniteTail: Boolean(value?.infiniteTail)
    };
  }

  function normalizePluginLayout(value, fallback = {}) {
    const requestedInputChannels = normalizeInt(
      value?.requestedInputChannels,
      0,
      limits.maxAudioChannels,
      fallback.requestedInputChannels ?? fallback.inputChannels ?? 0
    );
    const requestedOutputChannels = normalizeInt(
      value?.requestedOutputChannels,
      1,
      limits.maxAudioChannels,
      fallback.requestedOutputChannels ?? fallback.outputChannels ?? 2
    );
    const inputChannels = normalizeInt(
      value?.inputChannels,
      0,
      limits.maxAudioChannels,
      fallback.inputChannels ?? requestedInputChannels
    );
    const outputChannels = normalizeInt(
      value?.outputChannels,
      1,
      limits.maxAudioChannels,
      fallback.outputChannels ?? requestedOutputChannels
    );
    const inputBuses = normalizeInt(value?.inputBuses, 0, limits.maxPluginBuses, fallback.inputBuses ?? (inputChannels > 0 ? 1 : 0));
    const outputBuses = normalizeInt(value?.outputBuses, 1, limits.maxPluginBuses, fallback.outputBuses ?? 1);
    const inputBusLayouts = normalizeBusLayouts(
      value?.inputBusLayouts,
      fallback.inputBusLayouts,
      "input",
      inputBuses,
      inputChannels
    );
    const outputBusLayouts = normalizeBusLayouts(
      value?.outputBusLayouts,
      fallback.outputBusLayouts,
      "output",
      outputBuses,
      outputChannels
    );
    return {
      requestedInputChannels,
      requestedOutputChannels,
      inputChannels,
      outputChannels,
      inputBuses: inputBusLayouts.length,
      outputBuses: Math.max(1, outputBusLayouts.length),
      inputBusLayouts,
      outputBusLayouts,
      sampleRate: clampSampleRate(value?.sampleRate, fallback.sampleRate ?? 48000),
      maxBlockSize: normalizeInt(value?.maxBlockSize, 1, limits.maxBlockSize, fallback.maxBlockSize ?? 128)
    };
  }

  function normalizeBusLayouts(value, fallback, direction, busCount, totalChannels) {
    const source = Array.isArray(value) ? value : Array.isArray(fallback) ? fallback : undefined;
    const normalized = [];
    if (source) {
      for (const bus of source.slice(0, limits.maxPluginBuses)) {
        normalized.push(normalizeBusLayout(bus, direction, normalized.length));
      }
    }
    if (normalized.length > 0) {
      return normalized;
    }
    return defaultBusLayouts(direction, busCount, totalChannels);
  }

  function defaultBusLayouts(direction, busCount, totalChannels) {
    const count = normalizeInt(busCount, direction === "input" ? 0 : 1, limits.maxPluginBuses, direction === "input" ? 0 : 1);
    return Array.from({ length: count }, (_, index) => ({
      index,
      direction,
      mediaType: "audio",
      name: index === 0 ? (direction === "input" ? "Main Input" : "Main Output") : `${direction === "input" ? "Aux Input" : "Aux Output"} ${index}`,
      type: index === 0 ? "main" : "aux",
      channels: index === 0 ? normalizeInt(totalChannels, 0, limits.maxAudioChannels, direction === "input" ? 0 : 2) : 0,
      active: index === 0
    }));
  }

  function normalizeBusLayout(bus, direction, fallbackIndex) {
    const type = bus?.type === "main" || bus?.type === "aux" ? bus.type : "unknown";
    const fallbackName = `${direction === "input" ? "Input" : "Output"} ${fallbackIndex + 1}`;
    const name = truncateText(bus?.name, limits.maxPluginParameterTextBytes);
    const nameFallback = bus?.nameFallback === true || !name;
    return {
      index: normalizeInt(bus?.index, 0, limits.maxPluginBuses - 1, fallbackIndex),
      direction,
      mediaType: "audio",
      name: name || fallbackName,
      ...(nameFallback ? { nameFallback: true } : {}),
      type,
      channels: normalizeInt(bus?.channels, 0, limits.maxAudioChannels, 0),
      active: Boolean(bus?.active)
    };
  }

  function clonePluginLayout(layout) {
    return { ...normalizePluginLayout(layout) };
  }

  function clampSampleRate(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.max(limits.minSampleRate, Math.min(limits.maxSampleRate, number));
  }

  function normalizeInt(value, min, max, fallback) {
    const fallbackNumber = Math.floor(Number(fallback));
    const number = Math.floor(Number(value));
    const candidate = Number.isFinite(number) ? number : fallbackNumber;
    if (!Number.isFinite(candidate)) {
      return min;
    }
    return Math.max(min, Math.min(max, candidate));
  }

  function boundedInteger(value, min, max) {
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
  }

  function truncateText(value, maxBytes) {
    const text = String(value ?? "").replace(/\u0000/g, "");
    if (Buffer.byteLength(text, "utf8") <= maxBytes) {
      return text;
    }
    return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
  }

  return {
    clamp01,
    clampSampleRate,
    clonePluginLayout,
    decodedBase64Length,
    encodeMidiEvents,
    finiteNumber,
    isBase64Text,
    limits,
    normalizeInt,
    normalizeLatencySamples,
    normalizeNativeState,
    normalizePluginLayout,
    normalizeTailReport,
    normalizeTailSamples,
    normalizeVst3NoteExpressions,
    normalizeVst3ProgramData,
    normalizeVst3ProgramLists,
    normalizeWorkerParameter,
    normalizeWorkerParameters,
    normalizeWorkerState,
    truncateText
  };
}

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function decodedBase64Length(text) {
  if (!text) {
    return 0;
  }
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((text.length / 4) * 3) - padding);
}

function defaultProtocolError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isBase64Text(text) {
  return typeof text === "string" && text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(text);
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
