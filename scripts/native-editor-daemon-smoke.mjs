import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, createRequestClient } from "./security-smoke-client.mjs";
import { waitForListen } from "./security-smoke-daemon-cases.mjs";
import { assertPublicPluginMetadata } from "./smoke-test-assertions.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SOUNDBRIDGE_NATIVE_EDITOR_DAEMON_SMOKE_PORT ?? 48019);
const TOKEN = "dev-token";
const ORIGIN = "http://127.0.0.1:5173";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(scriptDir, "native-editor-broker-fixture.mjs");
const request = createRequestClient({ idPrefix: "native-editor-daemon", timeoutMs: 3000 });

const daemon = spawn("node", ["scripts/mock-daemon.mjs"], {
  env: {
    ...process.env,
    SOUNDBRIDGE_HOST: HOST,
    SOUNDBRIDGE_PORT: String(PORT),
    SOUNDBRIDGE_PAIRING_TOKEN: TOKEN,
    SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH: process.execPath,
    SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS: JSON.stringify([fixturePath])
  },
  stdio: ["ignore", "pipe", "pipe"]
});
daemon.stderr.on("data", () => {});

try {
  await waitForListen(daemon);
  await run();
} finally {
  daemon.kill("SIGKILL");
}

console.log("Native editor broker daemon smoke test passed.");

async function run() {
  const main = await connect(HOST, PORT, `${HOST}:${PORT}`, ORIGIN);
  try {
    const paired = await request(main, "pair", { origin: ORIGIN, pairingToken: TOKEN }, false);
    assert(typeof paired.sessionToken === "string" && paired.sessionToken.length > 0, "pairing returns a session token");
    const session = paired.sessionToken;

    const hello = await request(main, "hello", {}, true, session);
    assert(hello.capabilities?.nativeEditor === true, "configured broker advertises nativeEditor capability");
    assert(hello.capabilities?.security?.nativeEditorBroker === true, "configured broker advertises security flag");
    assert(hello.capabilities?.security?.nativeEditorFileDialogs === false, "native editor file dialogs are denied by default");
    assert(hello.capabilities?.security?.nativeEditorClipboard === false, "native editor clipboard is denied by default");
    assert(hello.capabilities?.security?.nativeEditorDragAndDrop === false, "native editor drag/drop is denied by default");

    const created = await request(main, "createInstance", { pluginId: "mock.gain" }, true, session);
    const denied = await request(
      main,
      "openEditor",
      { instanceId: created.instanceId, mode: "native" },
      true,
      session
    ).then(
      () => ({ ok: true }),
      (error) => ({ code: error.code })
    );
    assert(
      denied.code === "unsupported_command",
      "configured broker still refuses native editors for non-native plugin instances"
    );

    const generic = await request(main, "openEditor", { instanceId: created.instanceId }, true, session);
    assert(generic.kind === "generic-parameters", "configured broker keeps generic editors available");
    assert(generic.native === false, "generic editor remains non-native");
    assert(
      generic.plugin.editorKinds?.length === 1 && generic.plugin.editorKinds[0] === "generic-parameters",
      "generic editor response advertises only generic editor support for mock plugins"
    );
    const closed = await request(main, "closeEditor", { editorId: generic.editorId }, true, session);
    assert(closed.closed === true, "generic editor closes under configured broker");

    const exercisedNativeBroker = await assertNativeEditorBrokerPath(main, session);
    console.log(
      exercisedNativeBroker
        ? "Native editor broker opened a hostable native example plugin."
        : "Native editor broker native-open path skipped: no hostable native example plugin was available."
    );
  } finally {
    main.socket?.destroy();
  }
}

async function assertNativeEditorBrokerPath(main, session) {
  const listed = await request(main, "listPlugins", {}, true, session);
  const nativePlugin = listed.plugins?.find((plugin) =>
    plugin.hostable === true &&
    plugin.source === "example-bundle" &&
    Array.isArray(plugin.editorKinds) &&
    plugin.editorKinds.includes("native-window")
  );
  if (!nativePlugin) {
    return false;
  }

  const created = await request(
    main,
    "createInstance",
    {
      pluginId: nativePlugin.pluginId,
      format: nativePlugin.format,
      sampleRate: 48000,
      maxBlockSize: 128,
      inputChannels: nativePlugin.inputs ?? 0,
      outputChannels: nativePlugin.outputs ?? 2
    },
    true,
    session
  );
  try {
    const native = await request(
      main,
      "openEditor",
      { instanceId: created.instanceId, mode: "native" },
      true,
      session
    );
    assert(native.kind === "native-window", "configured broker opens native-window editor sessions for native plugins");
    assert(native.native === true, "native broker editor response marks native sessions explicitly");
    assert(native.transport === "native-broker", "native broker editor response advertises broker transport");
    assert(native.capabilities?.nativeWindow === true, "native broker editor enables nativeWindow capability");
    assert(native.capabilities?.fileDialogs === false, "native broker editor keeps file dialogs denied by default");
    assert(native.capabilities?.clipboard === false, "native broker editor keeps clipboard denied by default");
    assert(native.capabilities?.dragAndDrop === false, "native broker editor keeps drag/drop denied by default");
    assert(Array.isArray(native.plugin?.editorKinds) && native.plugin.editorKinds.includes("native-window"), "native editor response preserves native editor guidance");
    assert(!("nativeHost" in native.plugin), "native editor response does not expose daemon-to-broker nativeHost details");
    assert(!("executablePath" in native.plugin), "native editor response does not expose executable paths");
    assert(!("diagnostics" in native.plugin), "native editor response does not expose scanner diagnostics");
    assertPublicPluginMetadata(native.plugin, "native editor response exposes only path-free public plugin metadata");

    const closed = await request(main, "closeEditor", { editorId: native.editorId }, true, session);
    assert(closed.closed === true, "native broker editor closes through daemon ownership checks");
    return true;
  } finally {
    await request(main, "destroyInstance", { instanceId: created.instanceId }, true, session);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
