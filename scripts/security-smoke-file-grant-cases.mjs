import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect, sendCloseFrame, waitForClose } from "./security-smoke-client.mjs";
import { waitForListen } from "./security-smoke-daemon-cases.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const approvalFixturePath = path.join(scriptDir, "file-grant-approval-broker-fixture.mjs");

export function createSecurityFileGrantCases({
  check,
  host,
  origin,
  port,
  request,
  token
}) {
  async function checkDefaultFileBrokerClosed(ctx, session) {
    const denied = await request(
      ctx,
      "createFileGrant",
      { path: "/tmp/soundbridge-no-ambient-access", purpose: "sample", access: "read" },
      true,
      session
    ).then(
      () => ({ ok: true }),
      (error) => ({ code: error.code })
    );
    check(denied.code === "file_broker_unavailable", "file grants fail closed when no broker roots are configured");
  }

  async function checkConfiguredFileBroker() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "soundbridge-grants-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "soundbridge-outside-"));
    const sampleDir = path.join(root, "Samples");
    const samplePath = path.join(sampleDir, "Kick.wav");
    const secondPath = path.join(sampleDir, "Snare.wav");
    const outsidePath = path.join(outsideRoot, "Secret.wav");
    const symlinkPath = path.join(root, "LinkedSecret.wav");
    fs.mkdirSync(sampleDir, { recursive: true });
    fs.writeFileSync(samplePath, "sample");
    fs.writeFileSync(secondPath, "sample-2");
    fs.writeFileSync(outsidePath, "secret");
    try {
      fs.symlinkSync(outsidePath, symlinkPath);
    } catch {}

    const approvalPort = port + 4;
    const approvalDaemon = spawn("node", ["scripts/mock-daemon.mjs"], {
      env: {
        ...process.env,
        SOUNDBRIDGE_HOST: host,
        SOUNDBRIDGE_PORT: String(approvalPort),
        SOUNDBRIDGE_PAIRING_TOKEN: token,
        SOUNDBRIDGE_FILE_GRANT_ROOTS: root
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    approvalDaemon.stderr.on("data", () => {});

    try {
      await waitForListen(approvalDaemon);
      const approval = await connect(host, approvalPort, `${host}:${approvalPort}`, origin);
      const approvalPair = await request(approval, "pair", { origin, pairingToken: token }, false);
      const hello = await request(approval, "hello", {}, true, approvalPair.sessionToken);
      check(
        hello.capabilities?.fileAccess === false &&
          hello.capabilities?.security?.fileBroker === true &&
          hello.capabilities?.security?.browserFileGrantPaths === false,
        "configured file roots still require native approval or development opt-in"
      );
      const approvalRequired = await request(
        approval,
        "createFileGrant",
        { path: samplePath, purpose: "sample", access: "read", kind: "file" },
        true,
        approvalPair.sessionToken
      ).then(
        () => ({ ok: true }),
        (error) => ({ code: error.code })
      );
      check(
        approvalRequired.code === "file_grant_approval_required",
        "browser-supplied file paths are denied without explicit development opt-in"
      );
      approval.socket?.destroy();
    } finally {
      approvalDaemon.kill("SIGKILL");
    }

    const nativeApprovalPort = port + 5;
    const nativeApprovalDaemon = spawn("node", ["scripts/mock-daemon.mjs"], {
      env: {
        ...process.env,
        SOUNDBRIDGE_HOST: host,
        SOUNDBRIDGE_PORT: String(nativeApprovalPort),
        SOUNDBRIDGE_PAIRING_TOKEN: token,
        SOUNDBRIDGE_FILE_GRANT_ROOTS: root,
        SOUNDBRIDGE_FILE_GRANT_BROKER_PATH: process.execPath,
        SOUNDBRIDGE_FILE_GRANT_BROKER_ARGS: JSON.stringify([approvalFixturePath, "ok", samplePath])
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    nativeApprovalDaemon.stderr.on("data", () => {});

    try {
      await waitForListen(nativeApprovalDaemon);
      const approved = await connect(host, nativeApprovalPort, `${host}:${nativeApprovalPort}`, origin);
      const approvedPair = await request(approved, "pair", { origin, pairingToken: token }, false);
      const hello = await request(approved, "hello", {}, true, approvedPair.sessionToken);
      check(
        hello.capabilities?.fileAccess === true &&
          hello.capabilities?.security?.fileBroker === true &&
          hello.capabilities?.security?.fileGrantApprovalBroker === true &&
          hello.capabilities?.security?.browserFileGrantPaths === false,
        "native approval broker enables path-free file grants without browser path mode"
      );
      const grant = await request(
        approved,
        "createFileGrant",
        { purpose: "sample", access: "read", kind: "file" },
        true,
        approvedPair.sessionToken
      );
      check(
        /^filegrant-[0-9a-f-]{36}$/.test(grant.grantId) &&
          grant.displayName === "Approved Fixture" &&
          grant.purpose === "sample" &&
          grant.access === "read" &&
          grant.kind === "file" &&
          publicGrantIsPathFree(grant),
        "native approval broker grants stay path-free in browser responses"
      );
      await request(approved, "revokeFileGrant", { grantId: grant.grantId }, true, approvedPair.sessionToken);
      approved.socket?.destroy();
    } finally {
      nativeApprovalDaemon.kill("SIGKILL");
    }

    const outsideBrokerPort = port + 6;
    const outsideBrokerDaemon = spawn("node", ["scripts/mock-daemon.mjs"], {
      env: {
        ...process.env,
        SOUNDBRIDGE_HOST: host,
        SOUNDBRIDGE_PORT: String(outsideBrokerPort),
        SOUNDBRIDGE_PAIRING_TOKEN: token,
        SOUNDBRIDGE_FILE_GRANT_ROOTS: root,
        SOUNDBRIDGE_FILE_GRANT_BROKER_PATH: process.execPath,
        SOUNDBRIDGE_FILE_GRANT_BROKER_ARGS: JSON.stringify([approvalFixturePath, "ok", outsidePath])
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    outsideBrokerDaemon.stderr.on("data", () => {});

    try {
      await waitForListen(outsideBrokerDaemon);
      const outsideBroker = await connect(host, outsideBrokerPort, `${host}:${outsideBrokerPort}`, origin);
      const outsideBrokerPair = await request(outsideBroker, "pair", { origin, pairingToken: token }, false);
      const outsideApproved = await request(
        outsideBroker,
        "createFileGrant",
        { purpose: "sample", access: "read", kind: "file" },
        true,
        outsideBrokerPair.sessionToken
      ).then(
        () => ({ ok: true }),
        (error) => ({ code: error.code })
      );
      check(
        outsideApproved.code === "file_grant_outside_roots",
        "native approval broker paths are still constrained to configured roots"
      );
      outsideBroker.socket?.destroy();
    } finally {
      outsideBrokerDaemon.kill("SIGKILL");
    }

    const brokerPort = port + 7;
    const daemon = spawn("node", ["scripts/mock-daemon.mjs"], {
      env: {
        ...process.env,
        SOUNDBRIDGE_HOST: host,
        SOUNDBRIDGE_PORT: String(brokerPort),
        SOUNDBRIDGE_PAIRING_TOKEN: token,
        SOUNDBRIDGE_FILE_GRANT_ROOTS: root,
        SOUNDBRIDGE_FILE_GRANT_ALLOW_BROWSER_PATHS: "1",
        SOUNDBRIDGE_MAX_FILE_GRANTS_PER_SESSION: "1",
        SOUNDBRIDGE_MAX_TOTAL_FILE_GRANTS: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    daemon.stderr.on("data", () => {});

    try {
      await waitForListen(daemon);
      const owner = await connect(host, brokerPort, `${host}:${brokerPort}`, origin);
      const ownerPair = await request(owner, "pair", { origin, pairingToken: token }, false);
      const hello = await request(owner, "hello", {}, true, ownerPair.sessionToken);
      check(
        hello.capabilities?.fileAccess === true &&
          hello.capabilities?.security?.fileBroker === true &&
          hello.capabilities?.security?.browserFileGrantPaths === true &&
          hello.capabilities?.security?.maxFileGrantsPerSession === 1,
        "development opt-in advertises bounded browser-path file brokering"
      );

      const outside = await request(
        owner,
        "createFileGrant",
        { path: outsidePath, purpose: "sample", access: "read", kind: "file" },
        true,
        ownerPair.sessionToken
      ).then(
        () => ({ ok: true }),
        (error) => ({ code: error.code })
      );
      check(outside.code === "file_grant_outside_roots", "file grants reject paths outside configured roots");

      if (fs.existsSync(symlinkPath)) {
        const symlink = await request(
          owner,
          "createFileGrant",
          { path: symlinkPath, purpose: "sample", access: "read", kind: "file" },
          true,
          ownerPair.sessionToken
        ).then(
          () => ({ ok: true }),
          (error) => ({ code: error.code })
        );
        check(symlink.code === "file_grant_outside_roots", "file grants reject symlink escapes from configured roots");
      }

      const oversized = await request(
        owner,
        "createFileGrant",
        { path: `/${"x".repeat(4097)}`, purpose: "sample", access: "read" },
        true,
        ownerPair.sessionToken
      ).then(
        () => ({ ok: true }),
        (error) => ({ code: error.code })
      );
      check(oversized.code === "invalid_argument", "file grants reject oversized path arguments");

      const grant = await request(
        owner,
        "createFileGrant",
        { path: samplePath, purpose: "sample", access: "read", kind: "file" },
        true,
        ownerPair.sessionToken
      );
      check(
        /^filegrant-[0-9a-f-]{36}$/.test(grant.grantId) &&
          grant.displayName === "Kick.wav" &&
          grant.purpose === "sample" &&
          grant.access === "read" &&
          grant.kind === "file" &&
          publicGrantIsPathFree(grant),
        "createFileGrant returns a bounded path-free grant"
      );

      const instance = await request(
        owner,
        "createInstance",
        { pluginId: "mock.gain", sampleRate: 48000, maxBlockSize: 128, inputChannels: 2, outputChannels: 2 },
        true,
        ownerPair.sessionToken
      );
      const attachment = await request(
        owner,
        "attachFileGrant",
        { instanceId: instance.instanceId, grantId: grant.grantId, purpose: "sample", access: "read", kind: "file" },
        true,
        ownerPair.sessionToken
      );
      check(
        attachment.attached === true &&
          attachment.instanceId === instance.instanceId &&
          attachment.grant?.grantId === grant.grantId &&
          attachment.grant?.displayName === "Kick.wav" &&
          publicGrantIsPathFree(attachment),
        "attachFileGrant binds a path-free grant to a session-owned instance"
      );

      const attached = await request(
        owner,
        "listInstanceFileGrants",
        { instanceId: instance.instanceId },
        true,
        ownerPair.sessionToken
      );
      check(
        attached.instanceId === instance.instanceId &&
          attached.grants?.length === 1 &&
          attached.grants[0].grantId === grant.grantId &&
          publicGrantIsPathFree(attached),
        "listInstanceFileGrants returns only path-free instance attachments"
      );

      const purposeMismatch = await request(
        owner,
        "attachFileGrant",
        { instanceId: instance.instanceId, grantId: grant.grantId, purpose: "license" },
        true,
        ownerPair.sessionToken
      ).then(
        () => ({ ok: true }),
        (error) => ({ code: error.code })
      );
      check(purposeMismatch.code === "file_grant_purpose_mismatch", "file grant attachments enforce requested purpose");

      const listed = await request(owner, "listFileGrants", {}, true, ownerPair.sessionToken);
      check(
        listed.grants?.length === 1 &&
          listed.grants[0].grantId === grant.grantId &&
          publicGrantIsPathFree(listed.grants[0]),
        "listFileGrants returns only session-owned path-free grants"
      );

      const quota = await request(
        owner,
        "createFileGrant",
        { path: secondPath, purpose: "sample", access: "read", kind: "file" },
        true,
        ownerPair.sessionToken
      ).then(
        () => ({ ok: true }),
        (error) => ({ code: error.code })
      );
      check(quota.code === "quota_exceeded", "file grants enforce per-session quotas");

      const other = await connect(host, brokerPort, `${host}:${brokerPort}`, origin);
      const otherPair = await request(other, "pair", { origin, pairingToken: token }, false);
      const otherInstance = await request(
        other,
        "createInstance",
        { pluginId: "mock.gain", sampleRate: 48000, maxBlockSize: 128, inputChannels: 2, outputChannels: 2 },
        true,
        otherPair.sessionToken
      );
      const crossGrantAttach = await request(
        other,
        "attachFileGrant",
        { instanceId: otherInstance.instanceId, grantId: grant.grantId, purpose: "sample", access: "read", kind: "file" },
        true,
        otherPair.sessionToken
      ).then(
        () => ({ ok: true }),
        (error) => ({ code: error.code })
      );
      check(crossGrantAttach.code === "file_grant_access_denied", "another session cannot attach this file grant");

      const crossInstanceAttach = await request(
        other,
        "attachFileGrant",
        { instanceId: instance.instanceId, grantId: grant.grantId, purpose: "sample", access: "read", kind: "file" },
        true,
        otherPair.sessionToken
      ).then(
        () => ({ ok: true }),
        (error) => ({ code: error.code })
      );
      check(crossInstanceAttach.code === "instance_access_denied", "another session cannot attach grants to this instance");

      const revokeDenied = await request(
        other,
        "revokeFileGrant",
        { grantId: grant.grantId },
        true,
        otherPair.sessionToken
      ).then(
        () => ({ ok: true }),
        (error) => ({ code: error.code })
      );
      check(revokeDenied.code === "file_grant_access_denied", "another session cannot revoke this file grant");

      const detached = await request(
        owner,
        "detachFileGrant",
        { instanceId: instance.instanceId, grantId: grant.grantId },
        true,
        ownerPair.sessionToken
      );
      const afterDetach = await request(
        owner,
        "listInstanceFileGrants",
        { instanceId: instance.instanceId },
        true,
        ownerPair.sessionToken
      );
      check(
        detached.detached === true &&
          detached.grantId === grant.grantId &&
          afterDetach.grants?.length === 0,
        "owner session can detach an instance file grant"
      );

      const revoked = await request(owner, "revokeFileGrant", { grantId: grant.grantId }, true, ownerPair.sessionToken);
      const afterRevoke = await request(owner, "listFileGrants", {}, true, ownerPair.sessionToken);
      check(
        revoked.revoked === true &&
          revoked.grantId === grant.grantId &&
          Array.isArray(afterRevoke.grants) &&
          afterRevoke.grants.length === 0,
        "owner session can revoke its file grant"
      );
      await request(
        owner,
        "createFileGrant",
        { path: samplePath, purpose: "sample", access: "read", kind: "file" },
        true,
        ownerPair.sessionToken
      );
      sendCloseFrame(owner);
      await waitForClose(owner);
      const afterDisconnect = await request(
        other,
        "createFileGrant",
        { path: secondPath, purpose: "sample", access: "read", kind: "file" },
        true,
        otherPair.sessionToken
      );
      check(
        /^filegrant-[0-9a-f-]{36}$/.test(afterDisconnect.grantId),
        "disconnecting a WebSocket destroys session-owned file grants"
      );
      await request(other, "revokeFileGrant", { grantId: afterDisconnect.grantId }, true, otherPair.sessionToken);
      owner.socket?.destroy();
      other.socket?.destroy();
    } finally {
      daemon.kill("SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  }

  return {
    checkConfiguredFileBroker,
    checkDefaultFileBrokerClosed
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
