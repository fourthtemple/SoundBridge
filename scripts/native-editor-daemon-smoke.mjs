import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, createRequestClient } from "./security-smoke-client.mjs";
import { waitForListen } from "./security-smoke-daemon-cases.mjs";

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
    const closed = await request(main, "closeEditor", { editorId: generic.editorId }, true, session);
    assert(closed.closed === true, "generic editor closes under configured broker");
  } finally {
    main.socket?.destroy();
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
