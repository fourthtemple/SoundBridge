import { applyNativeParameterSnapshot } from "./daemon-parameter-snapshots.mjs";

const VST3_NO_PROGRAM_LIST_ID = -1;

export function createDaemonVst3ProgramData({
  getInstance,
  limits,
  normalizers,
  protocolError,
  requireIntInRange
}) {
  const {
    isBase64Text,
    normalizeVst3ProgramData
  } = normalizers;
  const {
    maxPluginProgramDataEnvelopeBytes,
    maxPluginParameters = 1024,
    maxPluginPrograms
  } = limits;

  async function getVst3ProgramData(instanceId, programListId, programIndex, session) {
    const instance = requireVst3ProgramDataInstance(instanceId, session, "getVst3ProgramData");
    const safeProgramListId = requireRequestProgramListId(programListId);
    const safeProgramIndex = requireIntInRange(programIndex, 0, maxPluginPrograms - 1, "programIndex");
    assertListedProgramData(instance, safeProgramListId, safeProgramIndex);

    const programData = normalizeVst3ProgramData(
      await instance.worker.getVst3ProgramData(safeProgramListId, safeProgramIndex)
    );
    if (!programData) {
      throw protocolError("program_data_not_supported", "The VST3 worker did not return program data.");
    }
    assertProgramDataMatch(programData, safeProgramListId, safeProgramIndex);
    return {
      ...programData,
      instanceId,
      programData: encodeProgramDataEnvelope(instance.pluginId, programData)
    };
  }

  async function setVst3ProgramData(instanceId, programDataEnvelope, session) {
    const instance = requireVst3ProgramDataInstance(instanceId, session, "setVst3ProgramData");
    const envelope = decodeProgramDataEnvelope(programDataEnvelope);
    if (envelope.pluginId !== instance.pluginId) {
      throw protocolError("program_data_plugin_mismatch", "Program data belongs to a different plugin.");
    }

    const programData = normalizeVst3ProgramData(envelope);
    assertProgramDataMatch(programData, envelope.programListId, envelope.programIndex);
    assertListedProgramData(instance, programData.programListId, programData.programIndex);

    await instance.worker.setVst3ProgramData(programData.programListId, programData.programIndex, programData.data);
    applyNativeParameterSnapshot(instance, await instance.worker.getParameters(), maxPluginParameters);
    return {
      restored: true,
      instanceId,
      format: "vst3",
      programListId: programData.programListId,
      programIndex: programData.programIndex,
      ...(instance.parameterMetadataAtLimit ? { parameterMetadataAtLimit: true } : {}),
      parameters: instance.parameters.map((parameter) => ({ ...parameter }))
    };
  }

  function requireVst3ProgramDataInstance(instanceId, session, operation) {
    const instance = getInstance(instanceId, session);
    if (
      instance.format !== "vst3" ||
      !instance.worker ||
      typeof instance.worker.getVst3ProgramData !== "function" ||
      (operation === "setVst3ProgramData" && typeof instance.worker.setVst3ProgramData !== "function")
    ) {
      throw protocolError("program_data_not_supported", "VST3 program data is available only for supported VST3 instances.");
    }
    return instance;
  }

  function assertListedProgramData(instance, programListId, programIndex) {
    const matchingProgramLists = (instance.vst3ProgramLists ?? []).filter((list) => list?.id === programListId);
    const programList = matchingProgramLists.length === 1 ? matchingProgramLists[0] : undefined;
    const matchingPrograms = Array.isArray(programList?.programs)
      ? programList.programs.slice(0, maxPluginPrograms).filter((program) => program?.index === programIndex)
      : [];
    if (!programList?.programDataSupported || !hasBoundedProgramDataTarget(matchingPrograms)) {
      throw protocolError("program_data_not_supported", "The requested VST3 program does not expose bounded program data.");
    }
  }

  function hasBoundedProgramDataTarget(programs) {
    if (programs.length === 1) {
      return true;
    }
    if (programs.length < 1) {
      return false;
    }
    const values = programs.map((program) => program?.normalizedValue);
    return values.every(isBoundedProgramValue) && values.every((value) => value === values[0]);
  }

  function isBoundedProgramValue(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  }

  function encodeProgramDataEnvelope(pluginId, programData) {
    const encoded = Buffer.from(JSON.stringify({
      version: 1,
      pluginId,
      format: "vst3",
      programListId: programData.programListId,
      programIndex: programData.programIndex,
      data: programData.data
    }), "utf8").toString("base64");
    if (Buffer.byteLength(encoded, "utf8") > maxPluginProgramDataEnvelopeBytes) {
      throw protocolError("program_data_too_large", "VST3 program data exceeded the configured envelope limit.", {
        maxProgramDataEnvelopeBytes: maxPluginProgramDataEnvelopeBytes
      });
    }
    return encoded;
  }

  function decodeProgramDataEnvelope(programDataEnvelope) {
    const text = String(programDataEnvelope ?? "");
    if (
      text.length === 0 ||
      !isBase64Text(text)
    ) {
      throw protocolError("bad_program_data", "Program data was not valid SoundBridge VST3 program data.");
    }
    if (Buffer.byteLength(text, "utf8") > maxPluginProgramDataEnvelopeBytes) {
      throw protocolError("program_data_too_large", "VST3 program data exceeded the configured envelope limit.", {
        maxProgramDataEnvelopeBytes: maxPluginProgramDataEnvelopeBytes
      });
    }

    try {
      const envelope = JSON.parse(Buffer.from(text, "base64").toString("utf8"));
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
        throw protocolError("bad_program_data", "Program data envelope was malformed.");
      }
      if (envelope.version !== 1 || envelope.format !== "vst3" || typeof envelope.pluginId !== "string") {
        throw protocolError("bad_program_data", "Program data envelope was not for VST3 program data.");
      }
      return {
        pluginId: envelope.pluginId,
        format: "vst3",
        programListId: strictProgramListId(envelope.programListId),
        programIndex: strictInteger(envelope.programIndex, 0, maxPluginPrograms - 1, "programIndex"),
        data: envelope.data
      };
    } catch (error) {
      if (error?.code) {
        throw error;
      }
      throw protocolError("bad_program_data", "Program data was not valid SoundBridge VST3 program data.");
    }
  }

  function strictInteger(value, min, max, label) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw protocolError("bad_program_data", `Program data ${label} was out of range.`);
    }
    return value;
  }

  function strictProgramListId(value) {
    const id = strictInteger(value, -2147483648, 2147483647, "programListId");
    if (id === VST3_NO_PROGRAM_LIST_ID) {
      throw protocolError("bad_program_data", "Program data cannot use the VST3 no-program-list sentinel.");
    }
    return id;
  }

  function requireRequestProgramListId(value) {
    const id = requireIntInRange(value, -2147483648, 2147483647, "programListId");
    if (id === VST3_NO_PROGRAM_LIST_ID) {
      throw protocolError("invalid_argument", "programListId cannot use the VST3 no-program-list sentinel.");
    }
    return id;
  }

  function assertProgramDataMatch(programData, programListId, programIndex) {
    if (!programData || programData.programListId !== programListId || programData.programIndex !== programIndex) {
      throw protocolError("bad_program_data", "The VST3 worker returned mismatched program data metadata.");
    }
  }

  return {
    getVst3ProgramData,
    setVst3ProgramData
  };
}
