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
      nameFallback: true,
      programListId: 7
    }
  });
  check(
    unitParameter?.vst3Unit?.id === 2 &&
      unitParameter.vst3Unit.parentUnitId === 0 &&
      unitParameter.vst3Unit.programListId === 7 &&
      unitParameter.vst3Unit.name === "12345678" &&
      unitParameter.vst3Unit.nameFallback === true,
    "daemon normalizers bound VST3 unit metadata"
  );
  const nulTextParameter = unitNormalizers.normalizeWorkerParameter({
    id: "nul-text",
    name: "Cut\u0000off",
    normalizedValue: 0.5,
    defaultNormalizedValue: 0.5,
    displayValue: "12\u0000 dB",
    unit: "d\u0000B"
  });
  const [nulTextProgramList] = unitNormalizers.normalizeVst3ProgramLists([
    { id: 11, name: "Bank\u0000 A", programs: [{ index: 0, name: "Init\u0000", normalizedValue: 0 }] }
  ]);
  const [nulTextExpression] = unitNormalizers.normalizeVst3NoteExpressions([
    { typeId: 3, name: "Expr\u0000", shortName: "E\u0000", unit: "%\u0000" }
  ]);
  check(
    nulTextParameter?.name === "Cutoff" &&
      nulTextParameter.displayValue === "12 dB" &&
      nulTextParameter.unit === "dB" &&
      nulTextProgramList?.name === "Bank A" &&
      nulTextProgramList.programs?.[0]?.name === "Init" &&
      nulTextExpression?.name === "Expr" &&
      nulTextExpression.shortName === "E" &&
      nulTextExpression.unit === "%",
    "daemon normalizers strip NULs from VST3 metadata text"
  );
  const invalidUnitLink = unitNormalizers.normalizeWorkerParameter({
    id: "bad-unit-link",
    normalizedValue: 0,
    vst3Unit: { id: 3, programListId: "bad" }
  });
  const sentinelUnitLink = unitNormalizers.normalizeWorkerParameter({
    id: "sentinel-unit-link",
    normalizedValue: 0,
    vst3Unit: { id: 4, programListId: -1 }
  });
  check(
    invalidUnitLink?.vst3Unit?.id === 3 &&
      invalidUnitLink.vst3Unit.name === "Unit 3" &&
      invalidUnitLink.vst3Unit.nameFallback === true &&
      !Object.hasOwn(invalidUnitLink.vst3Unit, "programListId") &&
      sentinelUnitLink?.vst3Unit?.id === 4 &&
      sentinelUnitLink.vst3Unit.name === "Unit 4" &&
      sentinelUnitLink.vst3Unit.nameFallback === true &&
      !Object.hasOwn(sentinelUnitLink.vst3Unit, "programListId"),
    "daemon normalizers omit invalid VST3 unit program-list links"
  );

  const [unitProgramList] = unitNormalizers.normalizeVst3ProgramLists([
    {
      id: 7,
      name: "1234567890",
      nameFallback: true,
      unitId: 2,
      programDataSupported: true,
      programs: [{ index: 0, name: "1234567890", normalizedValue: 0.5, nameFallback: true }]
    }
  ]);
  check(
    unitProgramList?.id === 7 &&
      unitProgramList.unitId === 2 &&
      unitProgramList.programDataSupported === true &&
      unitProgramList.name === "12345678" &&
      unitProgramList.nameFallback === true &&
      unitProgramList.programs?.[0]?.name === "12345678" &&
      unitProgramList.programs?.[0]?.nameFallback === true,
    "daemon normalizers bound VST3 program-list metadata"
  );
  const [unsupportedProgramDataList] = unitNormalizers.normalizeVst3ProgramLists([
    { id: 9, programDataSupported: false, programs: [{ index: 0, name: "Init", normalizedValue: 0 }] }
  ]);
  check(
    unsupportedProgramDataList?.programDataSupported === false,
    "daemon normalizers preserve explicit VST3 program-data unsupported metadata"
  );
  const [partialProgramList] = unitNormalizers.normalizeVst3ProgramLists([
    { id: "bad", programs: [{ index: 0, name: "Broken", normalizedValue: 0.25 }] },
    { id: -1, programs: [{ index: 0, name: "Sentinel", normalizedValue: 0.25 }] },
    {
      id: 8,
      unitId: "bad",
      programs: [
        { index: "bad", name: "Broken", normalizedValue: 0.25 },
        { name: "Fallback", normalizedValue: 0.5 },
        { index: 255, name: "Boundary", normalizedValue: 1 },
        { index: 256, name: "Out of Range", normalizedValue: 0.75 }
      ]
    }
  ]);
  check(
    partialProgramList?.id === 8 &&
      !Object.hasOwn(partialProgramList, "unitId") &&
      partialProgramList.programs.length === 2 &&
      partialProgramList.programs[0].index === 1 &&
      partialProgramList.programs[0].name === "Fallback" &&
      partialProgramList.programs[1].index === 255,
    "daemon normalizers skip invalid VST3 program-list metadata"
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
  check(
    (await rejectedCode(() =>
      unitNormalizers.normalizeVst3ProgramData({ programListId: -1, programIndex: 0, data: "YWI=" })
    )) === "bad_program_data",
    "daemon normalizers reject VST3 no-program-list program-data targets"
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
  }, {
    id: -2147483648,
    programDataSupported: true,
    programs: [{ index: 0 }]
  }];
  const restoredBoundaryProgramData = await programDataSupport.setVst3ProgramData(
    "inst-test",
    programEnvelope({ programListId: 2147483647, programIndex: 255, data: "+/8=" }),
    {}
  );
  const restoredUpperBoundaryData = fakeInstance.restoredProgramData?.data;
  const restoredSignedBoundaryProgramData = await programDataSupport.setVst3ProgramData(
    "inst-test",
    programEnvelope({ programListId: -2147483648, programIndex: 0, data: "" }),
    {}
  );
  check(
    restoredBoundaryProgramData.restored === true &&
      restoredBoundaryProgramData.programListId === 2147483647 &&
      restoredBoundaryProgramData.programIndex === 255 &&
      restoredUpperBoundaryData === "+/8=" &&
      restoredSignedBoundaryProgramData.restored === true &&
      restoredSignedBoundaryProgramData.programListId === -2147483648 &&
      restoredSignedBoundaryProgramData.programIndex === 0 &&
      fakeInstance.restoredProgramData?.data === "",
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
    (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope({ pluginId: undefined }), {}))) ===
      "bad_program_data" &&
      (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope({ pluginId: 7 }), {}))) ===
        "bad_program_data",
    "daemon VST3 program-data helper rejects missing or non-string plugin ids"
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
  check(
    (await rejectedCode(() => programDataSupport.getVst3ProgramData("inst-test", -1, 0, {}))) === "invalid_argument" &&
      (await rejectedCode(() =>
        programDataSupport.setVst3ProgramData("inst-test", programEnvelope({ programListId: -1 }), {})
      )) === "bad_program_data",
    "daemon VST3 program-data helper rejects no-program-list sentinel targets"
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
  fakeInstance.vst3ProgramLists = [{
    id: 7,
    programDataSupported: true,
    programs: [
      { index: 0, normalizedValue: 0.25 },
      { index: 0, normalizedValue: 0.25 }
    ]
  }];
  const exportedConsistentDuplicateProgramData = await programDataSupport.getVst3ProgramData("inst-test", 7, 0, {});
  const restoredConsistentDuplicateProgramData = await programDataSupport.setVst3ProgramData("inst-test", programEnvelope(), {});
  check(
    exportedConsistentDuplicateProgramData.programListId === 7 &&
      exportedConsistentDuplicateProgramData.programIndex === 0 &&
      restoredConsistentDuplicateProgramData.restored === true &&
      fakeInstance.restoredProgramData?.programListId === 7 &&
      fakeInstance.restoredProgramData?.programIndex === 0,
    "daemon VST3 program-data helper restores consistent duplicate program-index targets"
  );
  fakeInstance.vst3ProgramLists = [{
    id: 7,
    programDataSupported: true,
    programs: [
      { index: 0, normalizedValue: 0.25 },
      { index: 0, normalizedValue: 0.75 }
    ]
  }];
  check(
    (await rejectedCode(() => programDataSupport.getVst3ProgramData("inst-test", 7, 0, {}))) === "program_data_not_supported" &&
      (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope(), {}))) ===
        "program_data_not_supported",
    "daemon VST3 program-data helper rejects conflicting duplicate program-index targets"
  );
  fakeInstance.vst3ProgramLists = [{ id: 7, programDataSupported: true, programs: [{ index: 0 }, { index: 0 }] }];
  check(
    (await rejectedCode(() => programDataSupport.getVst3ProgramData("inst-test", 7, 0, {}))) === "program_data_not_supported" &&
      (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope(), {}))) ===
        "program_data_not_supported",
    "daemon VST3 program-data helper rejects unresolved duplicate program-index targets"
  );
  fakeInstance.vst3ProgramLists = [{ id: 7, programDataSupported: false, programs: [{ index: 0 }] }];
  check(
    (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope(), {}))) ===
      "program_data_not_supported",
    "daemon VST3 program-data helper rejects restore targets without program-data support"
  );
  fakeInstance.vst3ProgramLists = [{
    id: 7,
    programDataSupported: true,
    programs: [
      ...Array.from({ length: 256 }, () => ({ index: 1, normalizedValue: 0.5 })),
      { index: 0, normalizedValue: 0 }
    ]
  }];
  check(
    (await rejectedCode(() => programDataSupport.getVst3ProgramData("inst-test", 7, 0, {}))) === "program_data_not_supported" &&
      (await rejectedCode(() => programDataSupport.setVst3ProgramData("inst-test", programEnvelope(), {}))) ===
        "program_data_not_supported",
    "daemon VST3 program-data helper rejects targets beyond the listed program cap"
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
  check(
    (await rejectedCode(() =>
      tinyEnvelopeSupport.setVst3ProgramData("inst-test", programEnvelope({ data: "x".repeat(64) }), {})
    )) === "program_data_too_large",
    "daemon VST3 program-data helper rejects oversized restore envelopes"
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
      unitExpression.unitId === 2 &&
      unitExpression.channel === 1 &&
      unitExpression.bipolar === true,
    "daemon normalizers bound VST3 note-expression metadata"
  );
  const [invalidUnitExpression] = unitNormalizers.normalizeVst3NoteExpressions([
    {
      typeId: 1,
      name: "Expression",
      unitId: 9999999999
    }
  ]);
  check(
    invalidUnitExpression?.typeId === 1 &&
      !Object.hasOwn(invalidUnitExpression, "unitId"),
    "daemon normalizers omit invalid VST3 note-expression unit links"
  );
  const invalidAssociatedExpressions = unitNormalizers.normalizeVst3NoteExpressions([
    {
      typeId: 2,
      name: "Expression",
      associatedParameterId: "4294967295"
    },
    {
      typeId: 3,
      name: "Expression",
      associatedParameterId: -1
    }
  ]);
  check(
    invalidAssociatedExpressions.length === 2 &&
      invalidAssociatedExpressions.every((expression) => !Object.hasOwn(expression, "associatedParameterId")),
    "daemon normalizers omit invalid VST3 note-expression parameter links"
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
