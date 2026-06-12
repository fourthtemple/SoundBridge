const UNPAIRED_COMMANDS = [
  "scanPlugins",
  "listPlugins",
  "createInstance",
  "destroyInstance",
  "getParameters",
  "setParameter",
  "setParameterDisplayValue",
  "setPreset",
  "getVst3ProgramData",
  "setVst3ProgramData",
  "setParameterEvents",
  "setParameterCurve",
  "setAutomationLane",
  "clearAutomationLane",
  "getState",
  "setState",
  "processAudioBlock",
  "sendMidiEvents",
  "getLatency",
  "getTailTime",
  "getLayout",
  "openEditor",
  "closeEditor",
  "createFileGrant",
  "listFileGrants",
  "revokeFileGrant",
  "attachFileGrant",
  "listInstanceFileGrants",
  "detachFileGrant",
  "useFileGrant"
];

export function createSecuritySessionCases({ check, connect, host, origin, port, request }) {
  async function checkUnpairedSurface(main) {
    const helloUnpaired = await request(main, "hello", {}, false);
    check(helloUnpaired.pairingRequired === true, "unpaired hello reports pairingRequired");
    check(
      Object.keys(helloUnpaired.capabilities?.pluginFormats ?? {}).length === 0,
      "unpaired hello does not disclose plugin host adapters"
    );
    check(helloUnpaired.capabilities?.security?.hostHeaderValidation === true, "hello advertises hostHeaderValidation");

    for (const command of UNPAIRED_COMMANDS) {
      const blocked = await request(main, command, {}, false).then(
        () => ({ ok: true }),
        (error) => ({ code: error.code })
      );
      check(blocked.code === "not_paired", `unpaired ${command} is rejected`);
    }
  }

  function checkPairedHelloCapabilities(pairedHello) {
    check(pairedHello.capabilities?.automation === true, "paired hello advertises bounded parameter automation");
    check(
      pairedHello.capabilities?.parameterDisplayInput === true &&
        pairedHello.capabilities?.security?.maxPluginParameterTextBytes === 160,
      "paired hello advertises bounded parameter display input"
    );
    check(
      pairedHello.capabilities?.security?.maxAutomationLanesPerInstance >= 1 &&
        pairedHello.capabilities?.security?.maxAutomationLanePoints >= 1,
      "paired hello advertises bounded automation lane limits"
    );
    check(
      pairedHello.capabilities?.transport === true &&
        pairedHello.capabilities?.security?.maxTransportTempoBpm >= 960 &&
        pairedHello.capabilities?.security?.maxTransportSamplePosition > 0,
      "paired hello advertises bounded host transport context"
    );
    check(pairedHello.capabilities?.security?.maxWorkerStdoutLineBytes > 0, "paired hello advertises bounded native worker stdout lines");
    check(pairedHello.capabilities?.security?.maxWorkerCommandBytes > 0, "paired hello advertises bounded worker command lines");
    check(
      pairedHello.capabilities?.security?.maxWorkerPendingCommandBytes > 0,
      "paired hello advertises bounded worker pending command bytes"
    );
    check(pairedHello.capabilities?.security?.maxWorkerStderrLineBytes > 0, "paired hello advertises bounded native worker stderr lines");
    check(pairedHello.capabilities?.security?.maxWorkerStderrBytes > 0, "paired hello advertises bounded native worker stderr budgets");
    check(pairedHello.capabilities?.security?.maxWorkerDiagnosticLogChars > 0, "paired hello advertises bounded worker diagnostic logs");
    check(
      pairedHello.capabilities?.security?.maxPluginProgramLists > 0 &&
        pairedHello.capabilities?.security?.maxPluginPrograms > 0,
      "paired hello advertises bounded program-list metadata"
    );
    check(pairedHello.capabilities?.security?.maxPluginProgramDataBytes > 0, "paired hello advertises bounded VST3 program data");
    check(
      pairedHello.capabilities?.security?.maxPluginProgramDataEnvelopeBytes > 0,
      "paired hello advertises bounded VST3 program-data envelopes"
    );
    check(pairedHello.capabilities?.security?.maxNoteExpressionTextBytes > 0, "paired hello advertises bounded note-expression text");
    check(pairedHello.capabilities?.security?.maxWorkerPendingCommands > 0, "paired hello advertises bounded worker pending commands");
    check(pairedHello.capabilities?.security?.workerReadyTimeoutMs > 0, "paired hello advertises bounded native worker startup");
    check(pairedHello.capabilities?.security?.workerTerminationGraceMs >= 0, "paired hello advertises bounded worker termination grace");
    check(
      pairedHello.capabilities?.security?.exampleWorkerCommandTimeoutMs > 0 &&
        pairedHello.capabilities?.security?.nativeWorkerCommandTimeoutMs > 0,
      "paired hello advertises bounded worker commands"
    );
    check(
      pairedHello.capabilities?.genericEditor === true &&
        pairedHello.capabilities?.nativeEditor === false &&
        pairedHello.capabilities?.security?.nativeEditorBroker === false &&
        pairedHello.capabilities?.security?.nativeEditorFileDialogs === false &&
        pairedHello.capabilities?.security?.nativeEditorClipboard === false &&
        pairedHello.capabilities?.security?.nativeEditorDragAndDrop === false &&
        pairedHello.capabilities?.security?.maxEditorsPerSession > 0,
      "paired hello advertises bounded generic editor brokering"
    );
    check(
      pairedHello.capabilities?.fileAccess === false &&
        pairedHello.capabilities?.fileGrantOperations === true &&
        pairedHello.capabilities?.security?.fileBroker === false &&
        pairedHello.capabilities?.security?.browserFileGrantPaths === false &&
        pairedHello.capabilities?.security?.nativeWorkerFileGrants === true &&
        pairedHello.capabilities?.security?.maxFileGrantsPerSession > 0 &&
        pairedHello.capabilities?.security?.maxFileGrantsPerInstance > 0 &&
        pairedHello.capabilities?.security?.maxFileGrantPathBytes <= 4096,
      "paired hello advertises file brokering as disabled by default"
    );
  }

  async function checkPublicPluginMetadata(main, session) {
    const listed = await request(main, "listPlugins", {}, true, session);
    check(publicPluginsArePathFree(listed.plugins), "listPlugins returns path-free public plugin metadata");
    const scanned = await request(main, "scanPlugins", {}, true, session);
    check(
      Array.isArray(scanned.nativeSearchPaths) &&
        scanned.nativeSearchPaths.length === 0 &&
        publicPluginsArePathFree(scanned.plugins),
      "scanPlugins returns path-free public plugin metadata"
    );
  }

  async function checkSessionReplay(session) {
    const replay = await connect(host, port, `${host}:${port}`, origin);
    const replayedSession = await request(replay, "hello", {}, true, session).then(
      () => ({ ok: true }),
      (error) => ({ code: error.code })
    );
    check(replayedSession.code === "session_connection_mismatch", "session tokens cannot be replayed on a different WebSocket");
    replay.socket?.destroy();
  }

  return {
    checkPairedHelloCapabilities,
    checkPublicPluginMetadata,
    checkSessionReplay,
    checkUnpairedSurface
  };
}

export function publicPluginsArePathFree(plugins) {
  return Array.isArray(plugins) && plugins.length > 0 && plugins.every(publicPluginIsPathFree);
}

export function publicPluginIsPathFree(plugin) {
  return plugin && typeof plugin === "object" && !hasPrivatePathFields(plugin);
}

function hasPrivatePathFields(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (["bundlePath", "diagnostics", "executablePath", "nativeHost", "path"].includes(key)) {
      return true;
    }
    if (key === "parameters" && !Array.isArray(child)) {
      continue;
    }
    if (hasPrivatePathFields(child)) {
      return true;
    }
  }
  return false;
}
