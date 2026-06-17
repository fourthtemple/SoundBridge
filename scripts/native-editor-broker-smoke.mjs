import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NativeEditorBroker,
  createConfiguredNativeEditorBroker
} from "./native-editor-broker-process.mjs";
import { createDaemonEditors } from "./daemon-editors.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(scriptDir, "native-editor-broker-fixture.mjs");
const fixtureEditor = {
  editorId: "editor-00000000-0000-4000-8000-000000000001"
};
const fixtureFileGrantPath = "/tmp/soundbridge-fixture-grant.wav";
const fixtureFileGrant = {
  grantId: "filegrant-00000000-0000-4000-8000-000000000001",
  purpose: "sample",
  access: "read",
  kind: "file",
  displayName: "Fixture Grant",
  absolutePath: fixtureFileGrantPath,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000
};
const fixtureInstance = {
  instanceId: "inst-00000000-0000-4000-8000-000000000001",
  pluginId: "vst3:fixture.vst3",
  format: "vst3",
  kind: "effect",
  sampleRate: 48000,
  maxBlockSize: 128,
  nativeHost: {
    format: "vst3",
    renderEngine: "native-vst3",
    bundlePath: "/tmp/fixture.vst3"
  }
};
const broker = new NativeEditorBroker({
  executablePath: process.execPath,
  args: [fixturePath],
  limits: {
    maxWorkerStdoutLineBytes: 64 * 1024,
    maxWorkerCommandBytes: 64 * 1024,
    maxWorkerStderrLineBytes: 16 * 1024,
    maxWorkerStderrBytes: 64 * 1024,
    maxWorkerDiagnosticLogChars: 1024,
    workerReadyTimeoutMs: 1000,
    nativeWorkerCommandTimeoutMs: 1000,
    workerTerminationGraceMs: 50
  }
});

const opened = await broker.openEditor({
  editor: fixtureEditor,
  instance: fixtureInstance
});

assert(opened.brokerSessionId.startsWith("fixture-editor-"), "broker returns bounded session id");
assert(opened.capabilities.nativeWindow === true, "broker advertises native window support");
assert(opened.capabilities.fileDialogs === false, "broker capabilities default to denied file dialogs");
await opened.brokerSession.close("editor-00000000-0000-4000-8000-000000000001");

const privilegedBroker = new NativeEditorBroker({
  executablePath: process.execPath,
  args: [fixturePath, "privileged-capabilities"],
  limits: {
    maxWorkerStdoutLineBytes: 64 * 1024,
    maxWorkerCommandBytes: 64 * 1024,
    maxWorkerStderrLineBytes: 16 * 1024,
    maxWorkerStderrBytes: 64 * 1024,
    maxWorkerDiagnosticLogChars: 1024,
    workerReadyTimeoutMs: 1000,
    nativeWorkerCommandTimeoutMs: 1000,
    workerTerminationGraceMs: 50
  }
});
const privilegedDenied = await privilegedBroker.openEditor({
  editor: fixtureEditor,
  instance: fixtureInstance
});
assert(privilegedDenied.capabilities.fileDialogs === false, "broker file dialogs require daemon policy");
assert(privilegedDenied.capabilities.clipboard === false, "broker clipboard requires daemon policy");
assert(privilegedDenied.capabilities.dragAndDrop === false, "broker drag/drop requires daemon policy");
await privilegedDenied.brokerSession.close("editor-00000000-0000-4000-8000-000000000001");

const privilegedAllowedBroker = new NativeEditorBroker({
  executablePath: process.execPath,
  args: [fixturePath, "privileged-capabilities"],
  policy: {
    fileDialogs: true,
    clipboard: true,
    dragAndDrop: true
  },
  limits: {
    maxWorkerStdoutLineBytes: 64 * 1024,
    maxWorkerCommandBytes: 64 * 1024,
    maxWorkerStderrLineBytes: 16 * 1024,
    maxWorkerStderrBytes: 64 * 1024,
    maxWorkerDiagnosticLogChars: 1024,
    workerReadyTimeoutMs: 1000,
    nativeWorkerCommandTimeoutMs: 1000,
    workerTerminationGraceMs: 50
  }
});
const privilegedAllowed = await privilegedAllowedBroker.openEditor({
  editor: fixtureEditor,
  instance: fixtureInstance
});
assert(privilegedAllowed.capabilities.fileDialogs === true, "daemon policy can allow broker file dialogs");
assert(privilegedAllowed.capabilities.clipboard === true, "daemon policy can allow broker clipboard");
assert(privilegedAllowed.capabilities.dragAndDrop === true, "daemon policy can allow broker drag/drop");
await privilegedAllowed.brokerSession.close("editor-00000000-0000-4000-8000-000000000001");

const defaultPolicyBroker = new NativeEditorBroker({
  executablePath: process.execPath,
  args: [fixturePath, "require-default-policy"],
  limits: {
    maxWorkerStdoutLineBytes: 64 * 1024,
    maxWorkerCommandBytes: 64 * 1024,
    maxWorkerStderrLineBytes: 16 * 1024,
    maxWorkerStderrBytes: 64 * 1024,
    maxWorkerDiagnosticLogChars: 1024,
    workerReadyTimeoutMs: 1000,
    nativeWorkerCommandTimeoutMs: 1000,
    workerTerminationGraceMs: 50
  }
});
const defaultPolicyOpened = await defaultPolicyBroker.openEditor({
  editor: fixtureEditor,
  instance: fixtureInstance
});
assert(defaultPolicyOpened.brokerSessionId.startsWith("fixture-editor-"), "broker receives default deny policy");
await defaultPolicyOpened.brokerSession.close("editor-00000000-0000-4000-8000-000000000001");

const grantAwareBroker = new NativeEditorBroker({
  executablePath: process.execPath,
  args: [fixturePath, "require-file-grants", fixtureFileGrantPath],
  limits: {
    maxWorkerStdoutLineBytes: 64 * 1024,
    maxWorkerCommandBytes: 64 * 1024,
    maxWorkerStderrLineBytes: 16 * 1024,
    maxWorkerStderrBytes: 64 * 1024,
    maxWorkerDiagnosticLogChars: 1024,
    workerReadyTimeoutMs: 1000,
    nativeWorkerCommandTimeoutMs: 1000,
    workerTerminationGraceMs: 50
  }
});
const grantOpened = await grantAwareBroker.openEditor({
  editor: fixtureEditor,
  fileGrants: [fixtureFileGrant],
  instance: fixtureInstance
});
assert(grantOpened.brokerSessionId.startsWith("fixture-editor-"), "broker receives attached file grants");
await grantOpened.brokerSession.close("editor-00000000-0000-4000-8000-000000000001");

const nativeHostBroker = new NativeEditorBroker({
  executablePath: process.execPath,
  args: [fixturePath, "require-vst3-native-host", fixtureInstance.nativeHost.bundlePath],
  limits: {
    maxWorkerStdoutLineBytes: 64 * 1024,
    maxWorkerCommandBytes: 64 * 1024,
    maxWorkerStderrLineBytes: 16 * 1024,
    maxWorkerStderrBytes: 64 * 1024,
    maxWorkerDiagnosticLogChars: 1024,
    workerReadyTimeoutMs: 1000,
    nativeWorkerCommandTimeoutMs: 1000,
    workerTerminationGraceMs: 50
  }
});
const nativeHostOpened = await nativeHostBroker.openEditor({
  editor: fixtureEditor,
  instance: {
    ...fixtureInstance,
    nativeHost: {
      ...fixtureInstance.nativeHost,
      extraLaunchSecret: "drop-me"
    }
  }
});
assert(
  nativeHostOpened.brokerSessionId.startsWith("fixture-editor-"),
  "broker receives bounded VST3 native host launch descriptors"
);
await nativeHostOpened.brokerSession.close("editor-00000000-0000-4000-8000-000000000001");

const configured = createConfiguredNativeEditorBroker({
  env: {
    SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH: process.execPath,
    SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS: JSON.stringify([fixturePath])
  }
});
assert(configured?.available === true, "configured broker is available");
assert(configured.capabilityPolicy.fileDialogs === false, "configured broker denies file dialogs by default");
const configuredWithPolicy = createConfiguredNativeEditorBroker({
  env: {
    SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH: process.execPath,
    SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS: JSON.stringify([fixturePath]),
    SOUNDBRIDGE_NATIVE_EDITOR_ALLOW_FILE_DIALOGS: "1",
    SOUNDBRIDGE_NATIVE_EDITOR_ALLOW_CLIPBOARD: "1",
    SOUNDBRIDGE_NATIVE_EDITOR_ALLOW_DRAG_DROP: "1"
  }
});
assert(
  configuredWithPolicy.capabilityPolicy.fileDialogs === true &&
    configuredWithPolicy.capabilityPolicy.clipboard === true &&
    configuredWithPolicy.capabilityPolicy.dragAndDrop === true,
  "configured broker exposes explicit native editor capability policy"
);
const configuredPolicyBroker = createConfiguredNativeEditorBroker({
  env: {
    SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH: process.execPath,
    SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS: JSON.stringify([fixturePath, "require-allowed-policy"]),
    SOUNDBRIDGE_NATIVE_EDITOR_ALLOW_FILE_DIALOGS: "1",
    SOUNDBRIDGE_NATIVE_EDITOR_ALLOW_CLIPBOARD: "1",
    SOUNDBRIDGE_NATIVE_EDITOR_ALLOW_DRAG_DROP: "1"
  }
});
const configuredPolicyOpened = await configuredPolicyBroker.openEditor({
  editor: fixtureEditor,
  instance: fixtureInstance
});
assert(configuredPolicyOpened.brokerSessionId.startsWith("fixture-editor-"), "configured broker sends allowed policy");
await configuredPolicyOpened.brokerSession.close("editor-00000000-0000-4000-8000-000000000001");
const grantAwareConfigured = createConfiguredNativeEditorBroker({
  env: {
    SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH: process.execPath,
    SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS: JSON.stringify([fixturePath, "require-file-grants", fixtureFileGrantPath])
  }
});
assert(grantAwareConfigured?.available === true, "configured broker can receive file grants");
assert(createConfiguredNativeEditorBroker({ env: {} }) === undefined, "missing broker configuration keeps native editors disabled");
assertThrows(
  () => createConfiguredNativeEditorBroker({ env: { SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH: "relative-broker" } }),
  "relative broker paths are rejected"
);
assertThrows(
  () =>
    createConfiguredNativeEditorBroker({
      env: {
        SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH: process.execPath,
        SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS: "{"
      }
    }),
  "malformed broker args are rejected"
);
assertThrows(
  () =>
    createConfiguredNativeEditorBroker({
      env: {
        SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH: process.execPath,
        SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS: JSON.stringify({ arg: fixturePath })
      }
    }),
  "non-array broker args are rejected"
);
assertThrows(
  () =>
    createConfiguredNativeEditorBroker({
      env: {
        SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH: process.execPath,
        SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS: JSON.stringify([fixturePath, 1])
      }
    }),
  "non-string broker args are rejected"
);
assertThrows(
  () =>
    createConfiguredNativeEditorBroker({
      env: {
        SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH: process.execPath,
        SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS: JSON.stringify(["x".repeat(4097)])
      }
    }),
  "oversized broker args are rejected"
);
await assertRejectsBroker("bad-ready", "bad ready handshakes are rejected", "native_editor_broker_ready_invalid");
await assertRejectsBroker("malformed-ready", "malformed ready handshakes are rejected", "stdout_malformed");
await assertRejectsBroker("ready-timeout", "missing ready handshakes time out", "ready_timeout");
await assertRejectsBroker("open-error", "broker open errors are rejected", "fixture_open_failed");
await assertRejectsBroker("bad-open-ok", "broker open responses must set ok true", "open_invalid");
await assertRejectsBroker("missing-session-id", "broker open responses must include a session id", "invalid_session_id");
await assertRejectsBroker("oversized-session-id", "broker session ids must stay bounded", "invalid_session_id");
await assertRejectsBroker("malformed-open", "malformed command responses are rejected", "stdout_malformed");
await assertRejectsBroker("oversized-open", "oversized command responses are rejected", "line_too_large");
await assertRejectsBroker("open-timeout", "missing command responses time out", "command_timeout");

const editors = new Map();
const session = {
  sessionToken: "session-token",
  origin: "http://127.0.0.1:5173",
  expiresAt: Date.now() + 60_000,
  editors: new Set()
};
const nativeInstance = {
  instanceId: "inst-00000000-0000-4000-8000-000000000002",
  ownerSessionToken: session.sessionToken,
  pluginId: "vst3:fixture.vst3",
  format: "vst3",
  kind: "effect",
  sampleRate: 48000,
  maxBlockSize: 128,
  inputChannels: 2,
  outputChannels: 2,
  parameters: [],
  source: "scan",
  nativeHost: {
    format: "vst3",
    renderEngine: "native-vst3",
    bundlePath: "/tmp/fixture.vst3"
  }
};
const editorSupport = createDaemonEditors({
  cleanupExpiredEditors() {},
  clonePluginMetadata(plugin) {
    const { nativeHost, diagnostics, bundlePath, ...publicPlugin } = plugin;
    return publicPlugin;
  },
  destroyEditorRecord(editor) {
    editor.close?.();
    editors.delete(editor.editorId);
    session.editors.delete(editor.editorId);
  },
  editors,
  formatCategory(format) {
    return String(format).toUpperCase();
  },
  getInstance(instanceId, ownerSession) {
    assert(instanceId === nativeInstance.instanceId, "daemon editor test requested known instance");
    assert(ownerSession.sessionToken === session.sessionToken, "daemon editor test preserves session ownership");
    return nativeInstance;
  },
  limits: {
    editorSessionTtlMs: 60_000,
    maxEditorsPerSession: 8,
    maxTotalEditors: 32
  },
  makeProtocolError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  },
  nativeEditorBroker: grantAwareConfigured,
  resolveNativeFileGrants() {
    return [fixtureFileGrant];
  },
  resolvePlugin() {
    return {
      pluginId: nativeInstance.pluginId,
      format: nativeInstance.format,
      name: "Fixture VST3",
      vendor: "SoundBridge",
      category: "Effect",
      kind: nativeInstance.kind,
      source: "scan",
      inputs: 2,
      outputs: 2
    };
  }
});
const nativeEditor = await editorSupport.openEditor({ instanceId: nativeInstance.instanceId, mode: "native" }, session);
assert(nativeEditor.kind === "native-window", "daemon editor support returns native-window kind");
assert(nativeEditor.native === true, "daemon editor support marks native editor sessions");
assert(nativeEditor.transport === "native-broker", "daemon editor support returns native-broker transport");
assert(nativeEditor.capabilities.nativeWindow === true, "daemon editor support returns broker capabilities");
assert(
  nativeEditor.plugin.editorKinds?.includes("native-window") &&
    nativeEditor.plugin.editorKinds?.includes("generic-parameters"),
  "daemon editor response advertises bounded editor kinds"
);
assert(!("nativeHost" in nativeEditor.plugin), "daemon editor support keeps native launch data out of public plugin metadata");
assert(!hasPrivatePathFields(nativeEditor), "daemon editor response keeps broker file grants out of browser-visible data");
editorSupport.closeEditor(nativeEditor.editorId, session);

console.log("Native editor broker IPC smoke test passed.");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertThrows(callback, message) {
  let threw = false;
  try {
    callback();
  } catch {
    threw = true;
  }
  assert(threw, message);
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

async function assertRejectsBroker(mode, message, expectedErrorText) {
  const failingBroker = new NativeEditorBroker({
    executablePath: process.execPath,
    args: [fixturePath, mode],
    limits: {
      maxWorkerStdoutLineBytes: 128,
      maxWorkerCommandBytes: 64 * 1024,
      maxWorkerStderrLineBytes: 16 * 1024,
      maxWorkerStderrBytes: 64 * 1024,
      maxWorkerDiagnosticLogChars: 1024,
      workerReadyTimeoutMs: 250,
      nativeWorkerCommandTimeoutMs: 250,
      workerTerminationGraceMs: 10
    }
  });
  try {
    await failingBroker.openEditor({
      editor: fixtureEditor,
      instance: fixtureInstance
    });
  } catch (error) {
    const errorText = String(error?.message ?? error);
    assert(
      errorText.includes(expectedErrorText) || errorText.includes("native_editor_broker_exited"),
      `${message}: ${errorText}`
    );
    return;
  }
  throw new Error(message);
}
