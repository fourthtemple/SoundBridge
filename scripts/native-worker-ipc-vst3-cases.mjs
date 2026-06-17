import { createDaemonNormalizers } from "./daemon-normalizers.mjs";
import { createDaemonVst3ProgramData } from "./daemon-vst3-program-data.mjs";

export async function exerciseVst3ProgramDataSupport({ check, protocolError }) {
  const unitNormalizers = createDaemonNormalizers({ maxPluginParameterTextBytes: 8 });
  const unitParameter = unitNormalizers.normalizeWorkerParameter({
    id: "unit-param",
    name: "Unit Param",
    normalizedValue: 0.5,
    defaultNormalizedValue: 0.5,
    automatable: true,
    vst3Unit: {
      id: 2,
      parentUnitId: 0,
      name: "1234567890",
      programListId: 7
    }
  });
  check(
    unitParameter?.vst3Unit?.id === 2 &&
      unitParameter.vst3Unit.parentUnitId === 0 &&
      unitParameter.vst3Unit.programListId === 7 &&
      unitParameter.vst3Unit.name === "12345678",
    "daemon normalizers bound VST3 unit metadata"
  );

  const [unitProgramList] = unitNormalizers.normalizeVst3ProgramLists([
    {
      id: 7,
      name: "1234567890",
      unitId: 2,
      programDataSupported: true,
      programs: [{ index: 0, name: "1234567890", normalizedValue: 0.5 }]
    }
  ]);
  check(
    unitProgramList?.id === 7 &&
      unitProgramList.unitId === 2 &&
      unitProgramList.programDataSupported === true &&
      unitProgramList.name === "12345678" &&
      unitProgramList.programs?.[0]?.name === "12345678",
    "daemon normalizers bound VST3 program-list metadata"
  );

  const programData = unitNormalizers.normalizeVst3ProgramData({
    programListId: 7,
    programIndex: 0,
    data: "YWI="
  });
  const emptyProgramData = unitNormalizers.normalizeVst3ProgramData({
    programListId: -2147483648,
    programIndex: 0,
    data: ""
  });
  check(
    programData?.format === "vst3" &&
      programData.programListId === 7 &&
      programData.programIndex === 0 &&
      programData.size === 2 &&
      emptyProgramData?.programListId === -2147483648 &&
      emptyProgramData.size === 0,
    "daemon normalizers bound VST3 program data"
  );

  const tinyProgramDataNormalizers = createDaemonNormalizers({ maxPluginProgramDataBytes: 1 });
  check(
    (await rejectedCode(() =>
      tinyProgramDataNormalizers.normalizeVst3ProgramData({ programListId: 7, programIndex: 0, data: "YWI=" })
    )) === "program_data_too_large",
    "daemon normalizers reject oversized VST3 program data"
  );
  check(
    (await rejectedCode(() =>
      unitNormalizers.normalizeVst3ProgramData({ format: "au", programListId: 7, programIndex: 0, data: "YWI=" })
    )) === "bad_program_data",
    "daemon normalizers reject wrong-format VST3 program data"
  );
  check(
    (await rejectedCode(() =>
      unitNormalizers.normalizeVst3ProgramData({ programListId: 7, programIndex: 0 })
    )) === "bad_program_data",
    "daemon normalizers reject missing VST3 program data bytes"
  );
  check(
    (await rejectedCode(() =>
      unitNormalizers.normalizeVst3ProgramData({ programIndex: 0, data: "YWI=" })
    )) === "bad_program_data" &&
      (await rejectedCode(() =>
        unitNormalizers.normalizeVst3ProgramData({ programListId: 7, data: "YWI=" })
      )) === "bad_program_data",
    "daemon normalizers reject missing VST3 program-data target metadata"
  );

  const fakeInstance = vst3ProgramDataInstance();
  const programDataSupport = createProgramDataSupport({
    fakeInstance,
    normalizers: unitNormalizers,
    protocolError
  });
  const exportedProgramData = await programDataSupport.getVst3ProgramData("inst-test", 7, 0, {});
  check(
    exportedProgramData.programData &&
      exportedProgramData.size === 2 &&
      exportedProgramData.programListId === 7,
    "daemon VST3 program-data helper exports a bounded restore envelope"
  );
  const restoredProgramData = await programDataSupport.setVst3ProgramData("inst-test", exportedProgramData.programData, {});
  check(
    restoredProgramData.restored === true &&
      fakeInstance.restoredProgramData?.data === "YWI=" &&
      fakeInstance.parameters?.[0]?.id === "program",
    "daemon VST3 program-data helper restores an owned bounded envelope"
  );
  fakeInstance.workerProgramData = { format: "vst3", programListId: 7, programIndex: 0, data: "" };
  const exportedEmptyProgramData = await programDataSupport.getVst3ProgramData("inst-test", 7, 0, {});
  const restoredEmptyProgramData = await programDataSupport.setVst3ProgramData("inst-test", exportedEmptyProgramData.programData, {});
  check(
    exportedEmptyProgramData.size === 0 &&
      exportedEmptyProgramData.data === "" &&
      restoredEmptyProgramData.restored === true &&
      fakeInstance.restoredProgramData?.data === "",
    "daemon VST3 program-data helper preserves empty restore envelopes"
  );
  delete fakeInstance.workerProgramData;

  const originalBoundaryProgramLists = fakeInstance.vst3ProgramLists;
  fakeInstance.vst3ProgramLists = [{
    id: 2147483647,
    programDataSupported: true,
    programs: [{ index: 255 }]
  }];
  const restoredBoundaryProgramData = await programDataSupport.setVst3ProgramData(
    "inst-test",
    programEnvelope({ programListId: 2147483647, programIndex: 255, data: "+/8=" }),
    {}
  );
  check(
    restoredBoundaryProgramData.restored === true &&
      restoredBoundaryProgramData.programListId === 2147483647 &&
      restoredBoundaryProgramData.programIndex === 255 &&
      fakeInstance.restoredProgramData?.data === "+/8=",
    "daemon VST3 program-data helper restores boundary-listed envelopes"
  );
  fakeInstance.vst3ProgramLists = originalBoundaryProgramLists;

  fakeInstance.workerParameters = [
    { id: "program", name: "Program", normalizedValue: 0, defaultNormalizedValue: 0, automatable: true },
    { id: "variant", name: "Variant", normalizedValue: 0.5, defaultNormalizedValue: 0.5, automatable: true }
  ];
  const cappedParameterProgramDataSupport = createProgramDataSupport({
    fakeInstance,
    maxPluginParameters: 1,
    normalizers: unitNormalizers,
    protocolError
  });
  const cappedParameterRestore = await cappedParameterProgramDataSupport.setVst3ProgramData("inst-test", programEnvelope(), {});
  check(
    cappedParameterRestore.restored === true &&
      cappedParameterRestore.parameterMetadataAtLimit === true &&
      cappedParameterRestore.parameters.length === 2 &&
      fakeInstance.nativeParameterIds.has("variant"),
    "daemon VST3 program-data helper reports capped parameter refreshes"
  );
  delete fakeInstance.workerParameters;
  fakeInstance.parameters = [];
  fakeInstance.nativeParameterIds = new Set();
  fakeInstance.parameterMetadataAtLimit = false;

  check(
    (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope({ pluginId: "vst3:other" }), {}))) ===
      "program_data_plugin_mismatch",
    "daemon VST3 program-data helper rejects other-plugin envelopes"
  );
  check(
    (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", "not-base64!!", {}))) === "bad_program_data" &&
      (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", base64Text("not-json"), {}))) === "bad_program_data" &&
      (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", base64Json([]), {}))) === "bad_program_data",
    "daemon VST3 program-data helper rejects malformed restore envelopes"
  );
  check(
    (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope({ format: "au" }), {}))) ===
      "bad_program_data" &&
      (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope({ version: 2 }), {}))) ===
        "bad_program_data" &&
      (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope({ programIndex: 256 }), {}))) ===
        "bad_program_data",
    "daemon VST3 program-data helper rejects wrong-version and out-of-range envelopes"
  );
  check(
    (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope({ data: "not-base64" }), {}))) ===
      "bad_program_data",
    "daemon VST3 program-data helper rejects non-base64 program bytes"
  );
  check(
    (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope({ data: undefined }), {}))) ===
      "bad_program_data",
    "daemon VST3 program-data helper rejects restore envelopes without bytes"
  );
  check(
    (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope({ programListId: 8 }), {}))) ===
      "program_data_not_supported",
    "daemon VST3 program-data helper rejects unlisted restore targets"
  );

  const originalProgramLists = fakeInstance.vst3ProgramLists;
  fakeInstance.vst3ProgramLists = [
    { id: 7, programDataSupported: true, programs: [{ index: 0 }] },
    { id: 7, programDataSupported: true, programs: [{ index: 0 }] }
  ];
  check(
    (await rejectedCode(() => programDataSupport.getVst3ProgramData("inst-test", 7, 0, {}))) === "program_data_not_supported" &&
      (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope(), {}))) ===
        "program_data_not_supported",
    "daemon VST3 program-data helper rejects duplicate program-list restore targets"
  );
  fakeInstance.vst3ProgramLists = [{ id: 7, programDataSupported: true, programs: [{ index: 0 }, { index: 0 }] }];
  check(
    (await rejectedCode(() => programDataSupport.getVst3ProgramData("inst-test", 7, 0, {}))) === "program_data_not_supported" &&
      (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope(), {}))) ===
        "program_data_not_supported",
    "daemon VST3 program-data helper rejects duplicate program-index restore targets"
  );
  fakeInstance.vst3ProgramLists = [{ id: 7, programDataSupported: false, programs: [{ index: 0 }] }];
  check(
    (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope(), {}))) ===
      "program_data_not_supported",
    "daemon VST3 program-data helper rejects restore targets without program-data support"
  );
  fakeInstance.vst3ProgramLists = originalProgramLists;

  fakeInstance.vst3ProgramLists = [{ id: 0, programDataSupported: true, programs: [{ index: 0 }] }];
  fakeInstance.workerProgramData = { format: "vst3", data: "YWI=" };
  check(
    (await rejectedCode(() => programDataSupport.getVst3ProgramData("inst-test", 0, 0, {}))) === "bad_program_data",
    "daemon VST3 program-data helper rejects worker exports without target metadata"
  );
  delete fakeInstance.workerProgramData;
  fakeInstance.vst3ProgramLists = originalProgramLists;

  fakeInstance.workerProgramData = { format: "vst3", programListId: 8, programIndex: 0, data: "YWI=" };
  check(
    (await rejectedCode(() => programDataSupport.getVst3ProgramData("inst-test", 7, 0, {}))) === "bad_program_data",
    "daemon VST3 program-data helper rejects mismatched worker export metadata"
  );
  fakeInstance.workerProgramData = { format: "au", programListId: 7, programIndex: 0, data: "YWI=" };
  check(
    (await rejectedCode(() => programDataSupport.getVst3ProgramData("inst-test", 7, 0, {}))) === "bad_program_data",
    "daemon VST3 program-data helper rejects wrong-format worker export metadata"
  );
  fakeInstance.workerProgramData = { format: "vst3", programListId: 7, programIndex: 0 };
  check(
    (await rejectedCode(() => programDataSupport.getVst3ProgramData("inst-test", 7, 0, {}))) === "bad_program_data",
    "daemon VST3 program-data helper rejects worker exports without bytes"
  );
  delete fakeInstance.workerProgramData;

  const tinyEnvelopeSupport = createProgramDataSupport({
    fakeInstance,
    maxPluginProgramDataEnvelopeBytes: 16,
    normalizers: unitNormalizers,
    protocolError
  });
  check(
    (await rejectedCode(() => tinyEnvelopeSupport.getVst3ProgramData("inst-test", 7, 0, {}))) === "program_data_too_large",
    "daemon VST3 program-data helper rejects oversized export envelopes"
  );

  const [unitExpression] = unitNormalizers.normalizeVst3NoteExpressions([
    {
      typeId: 0,
      name: "1234567890",
      shortName: "Velocity",
      unit: "%",
      unitId: 2,
      defaultValue: 0.5,
      minValue: 0,
      maxValue: 1,
      stepCount: 0,
      associatedParameterId: "1234567890",
      busIndex: 0,
      channel: 1,
      bipolar: true
    }
  ]);
  check(
    unitExpression?.name === "12345678" &&
      unitExpression.associatedParameterId === "1234567890" &&
      unitExpression.channel === 1 &&
      unitExpression.bipolar === true,
    "daemon normalizers bound VST3 note-expression metadata"
  );
  check(
    unitNormalizers.encodeMidiEvents(
      [
        { type: "noteOn", note: 60, velocity: 0.8, channel: 0, time: 0, noteId: 42 },
        { type: "noteExpression", typeId: 0, value: 0.5, noteId: 42, channel: 0, time: 1 },
        { type: "noteExpressionText", typeId: 6, text: "ah", noteId: 42, channel: 0, time: 2 }
      ],
      "vst3"
    ) === "on:60:0.8:0:0:42;expr:0:0.5:42:0:1;exprText:6:YWg=:42:0:2",
    "daemon normalizers encode VST3 note-expression worker events"
  );
  check(
    unitNormalizers.encodeMidiEvents(
      [
        { type: "controlChange", controller: 74, value: 0.25, channel: 2, time: 3 },
        { type: "pitchBend", value: -0.5, channel: 2, time: 4 },
        { type: "channelPressure", pressure: 0.75, channel: 2, time: 5 }
      ],
      "vst3"
    ) === "cc:74:0.25:2:3;bend:-0.5:2:4;pressure:0.75:2:5",
    "daemon normalizers encode VST3 MIDI-controller mapping events"
  );
  check(
    unitNormalizers.encodeMidiEvents(
      [
        { type: "noteOn", note: 60, velocity: 0.8, channel: 0, time: 0, busIndex: 3 },
        { type: "noteExpression", typeId: 0, value: 0.5, noteId: 42, channel: 0, time: 1, busIndex: 3 },
        { type: "controlChange", controller: 74, value: 0.25, channel: 2, time: 3, busIndex: 3 },
        { type: "programChange", program: 7, channel: 2, time: 4, busIndex: 3 }
      ],
      "vst3"
    ) === "on:60:0.8:0:0:bus=3;expr:0:0.5:42:0:1:bus=3;cc:74:0.25:2:3:bus=3;program:7:2:4:bus=3",
    "daemon normalizers encode VST3 event-bus worker events"
  );
}

function createProgramDataSupport({
  fakeInstance,
  maxPluginProgramDataEnvelopeBytes = 1024 * 1024,
  maxPluginParameters,
  normalizers,
  protocolError
}) {
  return createDaemonVst3ProgramData({
    getInstance() {
      return fakeInstance;
    },
    limits: {
      maxPluginProgramDataEnvelopeBytes,
      ...(maxPluginParameters ? { maxPluginParameters } : {}),
      maxPluginPrograms: 256
    },
    normalizers,
    protocolError,
    requireIntInRange(value, min, max, label) {
      const number = Number(value);
      if (!Number.isInteger(number) || number < min || number > max) {
        throw protocolError("invalid_argument", `${label} out of range`);
      }
      return number;
    }
  });
}

function vst3ProgramDataInstance() {
  const instance = {
    instanceId: "inst-test",
    pluginId: "vst3:test",
    format: "vst3",
    vst3ProgramLists: [{
      id: 7,
      programDataSupported: true,
      programs: [{ index: 0, name: "Init", normalizedValue: 0 }]
    }],
    parameters: [],
    nativeParameterIds: new Set()
  };
  instance.worker = {
    async getVst3ProgramData(programListId, programIndex) {
      return instance.workerProgramData ?? { format: "vst3", programListId, programIndex, data: "YWI=" };
    },
    async setVst3ProgramData(programListId, programIndex, data) {
      instance.restoredProgramData = { programListId, programIndex, data };
    },
    async getParameters() {
      return instance.workerParameters ?? [
        { id: "program", name: "Program", normalizedValue: 0, defaultNormalizedValue: 0, automatable: true }
      ];
    }
  };
  return instance;
}

async function rejectedCode(operation) {
  try {
    await operation();
  } catch (error) {
    return error.code;
  }
  return undefined;
}

function programEnvelope(overrides = {}) {
  return base64Json({
    version: 1,
    pluginId: "vst3:test",
    format: "vst3",
    programListId: 7,
    programIndex: 0,
    data: "YWI=",
    ...overrides
  });
}

function base64Json(value) {
  return base64Text(JSON.stringify(value));
}

function base64Text(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}
