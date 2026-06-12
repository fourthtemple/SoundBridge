import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FileGrantApprovalBroker,
  createConfiguredFileGrantApprovalBroker
} from "./file-grant-approval-broker-process.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(scriptDir, "file-grant-approval-broker-fixture.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "soundbridge-grant-broker-"));
const approvedFile = path.join(root, "Approved.wav");
fs.writeFileSync(approvedFile, "sample");

try {
  const broker = brokerFor("ok", approvedFile);
  const approved = await broker.requestFileGrant({
    request: { purpose: "sample", access: "read", kind: "file" },
    session: { origin: "http://127.0.0.1:5173" }
  });
  assert(approved.path === approvedFile, "approval broker returns selected path");
  assert(approved.displayName === "Approved Fixture", "approval broker returns bounded display name");

  const configured = createConfiguredFileGrantApprovalBroker({
    env: {
      SOUNDBRIDGE_FILE_GRANT_BROKER_PATH: process.execPath,
      SOUNDBRIDGE_FILE_GRANT_BROKER_ARGS: JSON.stringify([fixturePath, "ok", approvedFile])
    }
  });
  assert(configured?.available === true, "configured file grant approval broker is available");
  assert(createConfiguredFileGrantApprovalBroker({ env: {} }) === undefined, "missing approval broker keeps it disabled");
  assertThrows(
    () => createConfiguredFileGrantApprovalBroker({ env: { SOUNDBRIDGE_FILE_GRANT_BROKER_PATH: "relative-broker" } }),
    "relative approval broker paths are rejected"
  );
  assertThrows(
    () =>
      createConfiguredFileGrantApprovalBroker({
        env: {
          SOUNDBRIDGE_FILE_GRANT_BROKER_PATH: process.execPath,
          SOUNDBRIDGE_FILE_GRANT_BROKER_ARGS: "{"
        }
      }),
    "malformed approval broker args are rejected"
  );
  assertThrows(
    () =>
      createConfiguredFileGrantApprovalBroker({
        env: {
          SOUNDBRIDGE_FILE_GRANT_BROKER_PATH: process.execPath,
          SOUNDBRIDGE_FILE_GRANT_BROKER_ARGS: JSON.stringify({ arg: fixturePath })
        }
      }),
    "non-array approval broker args are rejected"
  );
  assertThrows(
    () =>
      createConfiguredFileGrantApprovalBroker({
        env: {
          SOUNDBRIDGE_FILE_GRANT_BROKER_PATH: process.execPath,
          SOUNDBRIDGE_FILE_GRANT_BROKER_ARGS: JSON.stringify([fixturePath, 1])
        }
      }),
    "non-string approval broker args are rejected"
  );
  assertThrows(
    () =>
      createConfiguredFileGrantApprovalBroker({
        env: {
          SOUNDBRIDGE_FILE_GRANT_BROKER_PATH: process.execPath,
          SOUNDBRIDGE_FILE_GRANT_BROKER_ARGS: JSON.stringify(["x".repeat(4097)])
        }
      }),
    "oversized approval broker args are rejected"
  );

  await assertRejectsBroker("bad-ready", "bad ready handshakes are rejected", "file_grant_broker_ready_invalid");
  await assertRejectsBroker("malformed-ready", "malformed ready handshakes are rejected", "stdout_malformed");
  await assertRejectsBroker("ready-timeout", "missing ready handshakes time out", "ready_timeout");
  await assertRejectsBroker("request-error", "approval broker denials are rejected", "fixture_file_grant_denied");
  await assertRejectsBroker("missing-path", "approval broker responses must include a path", "missing_path");
  await assertRejectsBroker("malformed-request", "malformed command responses are rejected", "stdout_malformed");
  await assertRejectsBroker("oversized-request", "oversized command responses are rejected", "line_too_large");
  await assertRejectsBroker("request-timeout", "missing command responses time out", "command_timeout");

  console.log("File grant approval broker IPC smoke test passed.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function brokerFor(mode, selectedPath = approvedFile) {
  return new FileGrantApprovalBroker({
    executablePath: process.execPath,
    args: [fixturePath, mode, selectedPath],
    limits: {
      maxWorkerStdoutLineBytes: 1024,
      maxWorkerCommandBytes: 64 * 1024,
      maxWorkerStderrLineBytes: 16 * 1024,
      maxWorkerStderrBytes: 64 * 1024,
      maxWorkerDiagnosticLogChars: 1024,
      workerReadyTimeoutMs: 50,
      nativeWorkerCommandTimeoutMs: 50,
      workerTerminationGraceMs: 10
    }
  });
}

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
  try {
    await brokerFor(mode).requestFileGrant({
      request: { purpose: "sample", access: "read", kind: "file" },
      session: { origin: "http://127.0.0.1:5173" }
    });
  } catch (error) {
    const errorText = String(error?.message ?? error);
    assert(
      errorText.includes(expectedErrorText) || errorText.includes("file_grant_broker_exited"),
      `${message}: ${errorText}`
    );
    return;
  }
  throw new Error(message);
}
