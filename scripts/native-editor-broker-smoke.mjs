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

const configured = createConfiguredNativeEditorBroker({
  env: {
    SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH: process.execPath,
    SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS: JSON.stringify([fixturePath])
  }
});
assert(configured?.available === true, "configured broker is available");
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
        SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS: JSON.stringify(["x".repeat(4097)])
      }
    }),
  "oversized broker args are rejected"
);
await assertRejectsBroker("bad-ready", "bad ready handshakes are rejected", "native_editor_broker_ready_invalid");
await assertRejectsBroker("malformed-ready", "malformed ready handshakes are rejected", "stdout_malformed");
await assertRejectsBroker("ready-timeout", "missing ready handshakes time out", "ready_timeout");
await assertRejectsBroker("open-error", "broker open errors are rejected", "fixture_open_failed");
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
  nativeEditorBroker: configured,
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
assert(!("nativeHost" in nativeEditor.plugin), "daemon editor support keeps native launch data out of public plugin metadata");
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
