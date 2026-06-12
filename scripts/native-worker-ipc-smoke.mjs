import fs from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { AUDIO_UNIT_HOST_PROFILES, isKnownAudioUnitHostProfile } from "./daemon-au-host-profiles.mjs";
import { exerciseDaemonFileGrantOperation } from "./daemon-file-grant-operations-smoke.mjs";
import { createDaemonNormalizers } from "./daemon-normalizers.mjs";
import { applyNativeParameterSnapshot, parameterSnapshotResponse } from "./daemon-parameter-snapshots.mjs";
import { createDaemonVst3ProgramData } from "./daemon-vst3-program-data.mjs";
import { installedProbeFormats } from "./installed-plugin-probe-formats.mjs";
import { writeNativeWorkerIpcFixtures } from "./native-worker-ipc-fixtures.mjs";
import { createNativeWorkerProcesses } from "./native-worker-processes.mjs";

const MAX_TEST_STDOUT_LINE_BYTES = 128;
const MAX_TEST_COMMAND_BYTES = 128;
const MAX_TEST_PENDING_COMMAND_BYTES = 256;
const MAX_TEST_STDERR_LINE_BYTES = 128;
const MAX_TEST_STDERR_BYTES = 64;
const MAX_TEST_PENDING_COMMANDS = 8;
const TEST_READY_TIMEOUT_MS = 500;
const TEST_TERMINATION_GRACE_MS = 50;
const TEST_COMMAND_TIMEOUT_MS = 500;

let passed = 0;
const failures = [];

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "soundbridge-worker-ipc-"));

function protocolError(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

try {
  check(
    JSON.stringify([...installedProbeFormats({})]) === JSON.stringify(["vst3", "au", "lv2"]),
    "installed plugin probe includes VST3, AU, and LV2 by default"
  );
  check(
    JSON.stringify([...installedProbeFormats({ SOUNDBRIDGE_PROBE_FORMATS: " lv2,VST3,lv2 " })]) ===
      JSON.stringify(["lv2", "vst3"]),
    "installed plugin probe normalizes explicit format filters"
  );
  let badProbeFormatCode;
  try {
    installedProbeFormats({ SOUNDBRIDGE_PROBE_FORMATS: "vst2" });
  } catch (error) {
    badProbeFormatCode = error.message;
  }
  check(
    badProbeFormatCode?.includes("unsupported format"),
    "installed plugin probe rejects unsupported format filters"
  );

  check(
    isKnownAudioUnitHostProfile(AUDIO_UNIT_HOST_PROFILES.REALTIME_MULTI_OUTPUT_SPLITTER) &&
      !isKnownAudioUnitHostProfile("ambient-filesystem"),
    "daemon Audio Unit host profiles use a known bounded vocabulary"
  );

  const cappedParameterResponse = parameterSnapshotResponse({ parameters: [{ id: "a" }, { id: "b" }] }, 2);
  check(
    cappedParameterResponse.parameterMetadataAtLimit === true &&
      cappedParameterResponse.parameters.length === 2,
    "daemon parameter snapshots report metadata at the configured cap"
  );
  const refreshedInstance = { parameters: [], nativeParameterIds: new Set() };
  applyNativeParameterSnapshot(refreshedInstance, [{ id: "native-param" }], 1);
  check(
    refreshedInstance.parameterMetadataAtLimit === true &&
      refreshedInstance.nativeParameterIds.has("native-param"),
    "daemon parameter snapshots refresh native ids and cap status"
  );

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
  check(
    programData?.format === "vst3" &&
      programData.programListId === 7 &&
      programData.programIndex === 0 &&
      programData.size === 2,
    "daemon normalizers bound VST3 program data"
  );
  const tinyProgramDataNormalizers = createDaemonNormalizers({ maxPluginProgramDataBytes: 1 });
  let oversizedProgramData;
  try {
    tinyProgramDataNormalizers.normalizeVst3ProgramData({ programListId: 7, programIndex: 0, data: "YWI=" });
  } catch (error) {
    oversizedProgramData = error.code;
  }
  check(oversizedProgramData === "program_data_too_large", "daemon normalizers reject oversized VST3 program data");
  const fakeInstance = {
    instanceId: "inst-test",
    pluginId: "vst3:test",
    format: "vst3",
    vst3ProgramLists: [{
      id: 7,
      programDataSupported: true,
      programs: [{ index: 0, name: "Init", normalizedValue: 0 }]
    }],
    parameters: [],
    nativeParameterIds: new Set(),
    worker: {
      async getVst3ProgramData(programListId, programIndex) {
        return { format: "vst3", programListId, programIndex, data: "YWI=" };
      },
      async setVst3ProgramData(programListId, programIndex, data) {
        fakeInstance.restoredProgramData = { programListId, programIndex, data };
      },
      async getParameters() {
        return [{ id: "program", name: "Program", normalizedValue: 0, defaultNormalizedValue: 0, automatable: true }];
      }
    }
  };
  const programDataSupport = createDaemonVst3ProgramData({
    getInstance() {
      return fakeInstance;
    },
    limits: {
      maxPluginProgramDataEnvelopeBytes: 1024 * 1024,
      maxPluginPrograms: 256
    },
    normalizers: unitNormalizers,
    protocolError,
    requireIntInRange(value, min, max, label) {
      const number = Number(value);
      if (!Number.isInteger(number) || number < min || number > max) {
        throw protocolError("invalid_argument", `${label} out of range`);
      }
      return number;
    }
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
  const wrongPluginEnvelope = Buffer.from(JSON.stringify({
    version: 1,
    pluginId: "vst3:other",
    format: "vst3",
    programListId: 7,
    programIndex: 0,
    data: "YWI="
  }), "utf8").toString("base64");
  let wrongPluginCode;
  try {
    await programDataSupport.setVst3ProgramData("inst-test", wrongPluginEnvelope, {});
  } catch (error) {
    wrongPluginCode = error.code;
  }
  check(wrongPluginCode === "program_data_plugin_mismatch", "daemon VST3 program-data helper rejects other-plugin envelopes");
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

  const fixtureGrantPath = path.join(tempDir, "Fixture Grant.wav");
  const {
    exampleWorkerPath,
    nativeWorkerPath,
    exampleStderrWorkerPath,
    nativeStderrWorkerPath,
    exampleStderrBudgetWorkerPath,
    nativeStderrBudgetWorkerPath,
    diagnosticControlWorkerPath,
    malformedExampleWorkerPath,
    malformedNativeReadyWorkerPath,
    invalidNativeReadyWorkerPath,
    malformedNativeCommandWorkerPath,
    unsolicitedExampleWorkerPath,
    unsolicitedNativeWorkerPath,
    hangingNativeWorkerPath,
    hangingExampleCommandWorkerPath,
    hangingNativeCommandWorkerPath,
    stubbornExampleCommandWorkerPath,
    stubbornNativeCommandWorkerPath,
    grantAwareNativeWorkerPath
  } = writeNativeWorkerIpcFixtures({ tempDir, fixtureGrantPath });

  const workers = createTestWorkers(nativeWorkerPath);

  const grantWorkers = createTestWorkers(grantAwareNativeWorkerPath, {
    maxWorkerCommandBytes: 4096,
    maxWorkerPendingCommandBytes: 4096
  });
  const grantWorker = new grantWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await grantWorker.ready;
  const grantWorkerResult = await grantWorker.useFileGrant({
    operation: "loadSample",
    grant: {
      grantId: "filegrant-test",
      purpose: "sample",
      access: "read",
      kind: "file",
      displayName: "Fixture Grant.wav",
      absolutePath: fixtureGrantPath
    }
  });
  check(
    grantWorkerResult.applied === true && grantWorkerResult.status === "grant-ok",
    "native host workers encode bounded file grant commands"
  );
  const stateDirectoryGrantWorkerResult = await grantWorker.useFileGrant({
    operation: "saveStateDirectory",
    grant: {
      grantId: "filegrant-state-dir",
      purpose: "state",
      access: "readWrite",
      kind: "directory",
      displayName: "Fixture Grants",
      absolutePath: tempDir
    }
  });
  check(
    stateDirectoryGrantWorkerResult.applied === true && stateDirectoryGrantWorkerResult.status === "state-dir-ok",
    "native host workers encode bounded directory file grant commands"
  );
  const textWorker = new grantWorkers.NativeHostWorker(
    { format: "vst3", bundlePath: tempDir, renderEngine: "native-vst3" },
    nativeWorkerInstance()
  );
  await textWorker.ready;
  const textParameter = await textWorker.setParameterDisplayValue("42", "0.0 dB");
  check(
    textParameter?.id === "42" &&
      textParameter.displayValue === "0.0 dB" &&
      Math.abs(textParameter.normalizedValue - 0.5) < 0.000001,
    "native host workers encode bounded parameter display text commands"
  );
  textWorker.destroy();
  grantWorker.destroy();

  const fileGrantOperation = await exerciseDaemonFileGrantOperation({
    absolutePath: fixtureGrantPath,
    check,
    protocolError
  });
  check(
    fileGrantOperation.response.applied === true &&
      publicGrantIsPathFree(fileGrantOperation.response) &&
      fileGrantOperation.observedAbsolutePath === fixtureGrantPath,
    "daemon file grant operations resolve attached grants only for worker IPC"
  );

  const exampleWorker = new workers.ExampleInstrumentWorker(exampleWorkerPath);
  await expectRejected(
    () => exampleWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker_stdout_too_large",
    "example instrument workers reject oversized stdout lines"
  );
  exampleWorker.destroy();

  const nativeWorker = new workers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await nativeWorker.ready;
  await expectRejected(
    () => nativeWorker.getParameters(),
    "worker_stdout_too_large",
    "native host workers reject oversized stdout lines"
  );
  nativeWorker.destroy();

  const stderrWorkers = createTestWorkers(nativeStderrWorkerPath);
  const exampleStderrWorker = new stderrWorkers.ExampleInstrumentWorker(exampleStderrWorkerPath);
  await expectRejected(
    () => exampleStderrWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker_stderr_too_large",
    "example instrument workers reject oversized stderr lines"
  );
  check(exampleStderrWorker.process?.killed === true, "oversized-stderr example instrument worker process is killed");
  exampleStderrWorker.destroy();

  const nativeStderrWorker = new stderrWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await nativeStderrWorker.ready;
  await expectRejected(
    () => nativeStderrWorker.getParameters(),
    "worker_stderr_too_large",
    "native host workers reject oversized stderr lines"
  );
  check(nativeStderrWorker.process?.killed === true, "oversized-stderr native host worker process is killed");
  nativeStderrWorker.destroy();

  const stderrBudgetWorkers = createTestWorkers(nativeStderrBudgetWorkerPath);
  const exampleStderrBudgetWorker = new stderrBudgetWorkers.ExampleInstrumentWorker(exampleStderrBudgetWorkerPath);
  await expectRejected(
    () => exampleStderrBudgetWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker_stderr_budget_exceeded",
    "example instrument workers reject cumulative stderr floods"
  );
  check(exampleStderrBudgetWorker.process?.killed === true, "stderr-flood example instrument worker process is killed");
  exampleStderrBudgetWorker.destroy();

  const nativeStderrBudgetWorker = new stderrBudgetWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await nativeStderrBudgetWorker.ready;
  await expectRejected(
    () => nativeStderrBudgetWorker.getParameters(),
    "worker_stderr_budget_exceeded",
    "native host workers reject cumulative stderr floods"
  );
  check(nativeStderrBudgetWorker.process?.killed === true, "stderr-flood native host worker process is killed");
  nativeStderrBudgetWorker.destroy();

  const diagnosticWorkers = createTestWorkers(nativeWorkerPath);
  const diagnosticWorker = new diagnosticWorkers.ExampleInstrumentWorker(diagnosticControlWorkerPath);
  const warnings = await captureWarnings(() =>
    diagnosticWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 })
  );
  diagnosticWorker.destroy();
  check(
    warnings.some((warning) => warning.includes("\\u001b[31mwarning\\u000dfake\\u007f")),
    "worker stderr diagnostics escape terminal control characters"
  );
  check(
    warnings.every((warning) => !warning.includes(String.fromCharCode(27)) && !warning.includes("\r")),
    "worker stderr diagnostics do not log raw terminal controls"
  );
  const cappedDiagnosticWorkers = createTestWorkers(nativeWorkerPath, { maxWorkerDiagnosticLogChars: 16 });
  const cappedDiagnosticWorker = new cappedDiagnosticWorkers.ExampleInstrumentWorker(diagnosticControlWorkerPath);
  const cappedWarnings = await captureWarnings(() =>
    cappedDiagnosticWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 })
  );
  cappedDiagnosticWorker.destroy();
  check(
    cappedWarnings.some((warning) => warning.endsWith("...")),
    "worker stderr diagnostics cap displayed log length"
  );

  const malformedWorkers = createTestWorkers(malformedNativeCommandWorkerPath);
  const malformedExampleWorker = new malformedWorkers.ExampleInstrumentWorker(malformedExampleWorkerPath);
  await expectRejected(
    () => malformedExampleWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker_stdout_malformed",
    "example instrument workers reject malformed stdout responses"
  );
  check(malformedExampleWorker.process?.killed === true, "malformed-stdout example instrument worker process is killed");
  malformedExampleWorker.destroy();

  const malformedNativeCommandWorker = new malformedWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await malformedNativeCommandWorker.ready;
  await expectRejected(
    () => malformedNativeCommandWorker.getParameters(),
    "worker_stdout_malformed",
    "native host workers reject malformed stdout responses"
  );
  check(malformedNativeCommandWorker.process?.killed === true, "malformed-stdout native host worker process is killed");
  malformedNativeCommandWorker.destroy();

  const malformedReadyWorkers = createTestWorkers(malformedNativeReadyWorkerPath);
  const malformedNativeReadyWorker = new malformedReadyWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await expectRejected(
    () => malformedNativeReadyWorker.ready,
    "worker_stdout_malformed",
    "native host workers reject malformed ready handshakes"
  );
  check(malformedNativeReadyWorker.process?.killed === true, "malformed-ready native host worker process is killed");
  malformedNativeReadyWorker.destroy();

  const invalidReadyWorkers = createTestWorkers(invalidNativeReadyWorkerPath);
  const invalidNativeReadyWorker = new invalidReadyWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await expectRejected(
    () => invalidNativeReadyWorker.ready,
    "worker_ready_invalid",
    "native host workers reject invalid ready handshakes"
  );
  check(invalidNativeReadyWorker.process?.killed === true, "invalid-ready native host worker process is killed");
  invalidNativeReadyWorker.destroy();

  const unsolicitedExampleWorkers = createTestWorkers(nativeWorkerPath);
  const unsolicitedExampleWorker = new unsolicitedExampleWorkers.ExampleInstrumentWorker(unsolicitedExampleWorkerPath);
  await waitForKilled(unsolicitedExampleWorker);
  check(unsolicitedExampleWorker.process?.killed === true, "unsolicited-stdout example instrument worker process is killed");
  await expectRejected(
    () => unsolicitedExampleWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker is not writable",
    "example instrument workers reject commands after unsolicited stdout"
  );
  unsolicitedExampleWorker.destroy();

  const unsolicitedNativeWorkers = createTestWorkers(unsolicitedNativeWorkerPath);
  const unsolicitedNativeWorker = new unsolicitedNativeWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await unsolicitedNativeWorker.ready;
  await waitForKilled(unsolicitedNativeWorker);
  check(unsolicitedNativeWorker.process?.killed === true, "unsolicited-stdout native host worker process is killed");
  await expectRejected(
    () => unsolicitedNativeWorker.getParameters(),
    "worker is not writable",
    "native host workers reject commands after unsolicited stdout"
  );
  unsolicitedNativeWorker.destroy();

  const commandLimitWorkers = createTestWorkers(nativeWorkerPath, { maxWorkerCommandBytes: 16 });
  const commandLimitExampleWorker = new commandLimitWorkers.ExampleInstrumentWorker(hangingExampleCommandWorkerPath);
  await expectRejected(
    () => commandLimitExampleWorker.request("x".repeat(64)),
    "worker_command_too_large",
    "example instrument workers reject oversized commands before stdin write"
  );
  check(commandLimitExampleWorker.pending.length === 0, "oversized example worker commands are not queued");
  commandLimitExampleWorker.destroy();

  const commandLimitNativeWorker = new commandLimitWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await commandLimitNativeWorker.ready;
  await expectRejected(
    () => commandLimitNativeWorker.request("x".repeat(64)),
    "worker_command_too_large",
    "native host workers reject oversized commands before stdin write"
  );
  check(commandLimitNativeWorker.pending.length === 0, "oversized native worker commands are not queued");
  commandLimitNativeWorker.destroy();

  const commandByteBudgetWorkers = createTestWorkers(hangingNativeCommandWorkerPath, {
    maxWorkerPendingCommandBytes: 16
  });
  const commandByteBudgetExampleWorker =
    new commandByteBudgetWorkers.ExampleInstrumentWorker(hangingExampleCommandWorkerPath);
  const pendingByteBudgetExampleCommand = commandByteBudgetExampleWorker.request("x".repeat(8)).catch(() => undefined);
  await expectRejected(
    () => commandByteBudgetExampleWorker.request("x".repeat(8)),
    "worker_pending_command_bytes_exceeded",
    "example instrument workers reject commands beyond the pending byte budget"
  );
  check(commandByteBudgetExampleWorker.pending.length === 1, "oversized pending-byte example commands are not queued");
  commandByteBudgetExampleWorker.destroy();
  await pendingByteBudgetExampleCommand;

  const commandByteBudgetNativeWorker = new commandByteBudgetWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await commandByteBudgetNativeWorker.ready;
  const pendingByteBudgetNativeCommand = commandByteBudgetNativeWorker.request("x".repeat(8)).catch(() => undefined);
  await expectRejected(
    () => commandByteBudgetNativeWorker.request("x".repeat(8)),
    "worker_pending_command_bytes_exceeded",
    "native host workers reject commands beyond the pending byte budget"
  );
  check(commandByteBudgetNativeWorker.pending.length === 1, "oversized pending-byte native commands are not queued");
  commandByteBudgetNativeWorker.destroy();
  await pendingByteBudgetNativeCommand;

  const cappedExampleWorkers = createTestWorkers(hangingNativeCommandWorkerPath, { maxWorkerPendingCommands: 1 });
  const cappedExampleWorker = new cappedExampleWorkers.ExampleInstrumentWorker(hangingExampleCommandWorkerPath);
  const pendingExampleCommand = cappedExampleWorker
    .render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 })
    .catch(() => undefined);
  await expectRejected(
    () => cappedExampleWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker_pending_commands_exceeded",
    "example instrument workers reject commands beyond the pending limit"
  );
  cappedExampleWorker.destroy();
  await pendingExampleCommand;

  const cappedNativeWorkers = createTestWorkers(hangingNativeCommandWorkerPath, { maxWorkerPendingCommands: 1 });
  const cappedNativeWorker = new cappedNativeWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await cappedNativeWorker.ready;
  const pendingNativeCommand = cappedNativeWorker.getParameters().catch(() => undefined);
  await expectRejected(
    () => cappedNativeWorker.getLatency(),
    "worker_pending_commands_exceeded",
    "native host workers reject commands beyond the pending limit"
  );
  cappedNativeWorker.destroy();
  await pendingNativeCommand;

  const hangingWorkers = createTestWorkers(hangingNativeWorkerPath);
  const hangingWorker = new hangingWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await expectRejected(
    () => hangingWorker.ready,
    "worker_ready_timeout",
    "native host workers reject missing ready handshakes"
  );
  hangingWorker.destroy();

  const hangingCommandWorkers = createTestWorkers(hangingNativeCommandWorkerPath);
  const hangingExampleCommandWorker = new hangingCommandWorkers.ExampleInstrumentWorker(hangingExampleCommandWorkerPath);
  await expectRejected(
    () => hangingExampleCommandWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker_command_timeout",
    "example instrument workers terminate timed-out commands"
  );
  check(hangingExampleCommandWorker.process?.killed === true, "timed-out example instrument worker process is killed");
  hangingExampleCommandWorker.destroy();

  const hangingNativeCommandWorker = new hangingCommandWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await hangingNativeCommandWorker.ready;
  await expectRejected(
    () => hangingNativeCommandWorker.getParameters(),
    "worker_command_timeout",
    "native host workers terminate timed-out commands"
  );
  check(hangingNativeCommandWorker.process?.killed === true, "timed-out native host worker process is killed");
  hangingNativeCommandWorker.destroy();

  const stubbornWorkers = createTestWorkers(stubbornNativeCommandWorkerPath, {
    workerTerminationGraceMs: TEST_TERMINATION_GRACE_MS
  });
  const stubbornExampleCommandWorker = new stubbornWorkers.ExampleInstrumentWorker(stubbornExampleCommandWorkerPath);
  await delay(100);
  await expectRejected(
    () => stubbornExampleCommandWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker_command_timeout",
    "example instrument workers time out stubborn commands"
  );
  check((await waitForExitSignal(stubbornExampleCommandWorker)) === "SIGKILL", "stubborn example worker escalates to SIGKILL");
  stubbornExampleCommandWorker.destroy();

  const stubbornNativeCommandWorker = new stubbornWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await stubbornNativeCommandWorker.ready;
  await expectRejected(
    () => stubbornNativeCommandWorker.getParameters(),
    "worker_command_timeout",
    "native host workers time out stubborn commands"
  );
  check((await waitForExitSignal(stubbornNativeCommandWorker)) === "SIGKILL", "stubborn native worker escalates to SIGKILL");
  stubbornNativeCommandWorker.destroy();
} finally {
  fs.rmSync(tempDir, { force: true, recursive: true });
}

function createTestWorkers(nativeRenderer, options = {}) {
  return createNativeWorkerProcesses({
    nativeRenderer,
    normalizers: createDaemonNormalizers(),
    maxWorkerStdoutLineBytes: MAX_TEST_STDOUT_LINE_BYTES,
    maxWorkerCommandBytes: options.maxWorkerCommandBytes ?? MAX_TEST_COMMAND_BYTES,
    maxWorkerPendingCommandBytes: options.maxWorkerPendingCommandBytes ?? MAX_TEST_PENDING_COMMAND_BYTES,
    maxWorkerStderrLineBytes: MAX_TEST_STDERR_LINE_BYTES,
    maxWorkerStderrBytes: MAX_TEST_STDERR_BYTES,
    maxWorkerDiagnosticLogChars: options.maxWorkerDiagnosticLogChars,
    maxWorkerPendingCommands: options.maxWorkerPendingCommands ?? MAX_TEST_PENDING_COMMANDS,
    workerReadyTimeoutMs: TEST_READY_TIMEOUT_MS,
    workerTerminationGraceMs: options.workerTerminationGraceMs ?? TEST_TERMINATION_GRACE_MS,
    exampleWorkerCommandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
    nativeWorkerCommandTimeoutMs: TEST_COMMAND_TIMEOUT_MS
  });
}

function nativeWorkerInstance() {
  return {
    sampleRate: 48000,
    maxBlockSize: 1,
    inputChannels: 0,
    outputChannels: 1,
    kind: "effect",
    layout: {
      requestedInputChannels: 0,
      requestedOutputChannels: 1,
      inputChannels: 0,
      outputChannels: 1,
      inputBuses: 0,
      outputBuses: 1,
      inputBusLayouts: [],
      outputBusLayouts: [
        {
          index: 0,
          direction: "output",
          mediaType: "audio",
          name: "Main Output",
          type: "main",
          channels: 1,
          active: true
        }
      ],
      sampleRate: 48000,
      maxBlockSize: 1
    }
  };
}

function publicGrantIsPathFree(grant) {
  return grant && typeof grant === "object" && !hasPrivatePathFields(grant);
}

function hasPrivatePathFields(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (["absolutePath", "bundlePath", "diagnostics", "executablePath", "nativeHost", "path", "rootId"].includes(key)) {
      return true;
    }
    if (hasPrivatePathFields(child)) {
      return true;
    }
  }
  return false;
}

console.log(`\n${passed} worker IPC checks passed, ${failures.length} failed.`);
if (failures.length > 0) {
  process.exit(1);
}

async function expectRejected(operation, expectedText, message) {
  try {
    await operation();
    fail(message);
  } catch (error) {
    check(String(error?.message ?? error).includes(expectedText), message);
  }
}

async function captureWarnings(operation) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    await operation();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

async function waitForKilled(worker) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (worker.process?.killed === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForExitSignal(worker) {
  const process = worker.process;
  if (!process) {
    return undefined;
  }
  if (process.signalCode) {
    return process.signalCode;
  }
  const result = await Promise.race([once(process, "exit"), delay(1000).then(() => [undefined, undefined])]);
  return result[1];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function check(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ok  - ${message}`);
  } else {
    fail(message);
  }
}

function fail(message) {
  failures.push(message);
  console.log(`  FAIL- ${message}`);
}
