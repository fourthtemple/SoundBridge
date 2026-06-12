import { createDaemonFileGrantOperations } from "./daemon-file-grant-operations.mjs";
import { createDaemonInstanceFileGrants } from "./daemon-instance-file-grants.mjs";

export async function exerciseDaemonFileGrantOperation({ absolutePath, check, protocolError }) {
  const session = { sessionToken: "session-test", origin: "http://127.0.0.1:5173" };
  const grant = {
    grantId: "filegrant-test",
    ownerSessionToken: session.sessionToken,
    ownerOrigin: session.origin,
    purpose: "sample",
    access: "read",
    kind: "file",
    displayName: "Fixture Grant.wav",
    absolutePath,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000
  };
  let observedAbsolutePath;
  const instance = {
    instanceId: "inst-test",
    ownerSessionToken: session.sessionToken,
    fileGrantAttachments: new Map(),
    fileGrantOperations: ["loadSample", "loadLicense"],
    worker: {
      async useFileGrant({ operation, grant: workerGrant }) {
        observedAbsolutePath = workerGrant.absolutePath;
        return { applied: operation === "loadSample", status: "ok", absolutePath: workerGrant.absolutePath };
      }
    }
  };
  const instanceFileGrantSupport = createDaemonInstanceFileGrants({
    fileGrantSupport: createFakeFileGrantSupport(grant, protocolError),
    maxFileGrantsPerInstance: 4,
    makeProtocolError: protocolError
  });
  const operations = createDaemonFileGrantOperations({
    getInstance(instanceId) {
      if (instanceId !== instance.instanceId) {
        throw protocolError("instance_not_found", "missing instance");
      }
      return instance;
    },
    instanceFileGrantSupport,
    makeProtocolError: protocolError
  });
  instanceFileGrantSupport.attachFileGrant({
    instanceId: instance.instanceId,
    grantId: grant.grantId,
    purpose: "sample",
    access: "read",
    kind: "file"
  }, session, () => instance);
  const response = await operations.useFileGrant({
    instanceId: instance.instanceId,
    grantId: grant.grantId,
    operation: "loadSample"
  }, session);

  let mismatchCode;
  try {
    await operations.useFileGrant({
      instanceId: instance.instanceId,
      grantId: grant.grantId,
      operation: "loadLicense"
    }, session);
  } catch (error) {
    mismatchCode = error.code;
  }
  check(mismatchCode === "file_grant_purpose_mismatch", "daemon file grant operations enforce operation purpose");

  let missingAttachmentCode;
  try {
    await operations.useFileGrant({
      instanceId: instance.instanceId,
      grantId: "filegrant-missing",
      operation: "loadSample"
    }, session);
  } catch (error) {
    missingAttachmentCode = error.code;
  }
  check(missingAttachmentCode === "file_grant_not_attached", "daemon file grant operations require instance attachment");

  let missingOperationCode;
  try {
    await operations.useFileGrant({
      instanceId: instance.instanceId,
      grantId: grant.grantId
    }, session);
  } catch (error) {
    missingOperationCode = error.code;
  }
  check(missingOperationCode === "invalid_argument", "daemon file grant operations require an explicit operation");

  let invalidOperationCode;
  try {
    await operations.useFileGrant({
      instanceId: instance.instanceId,
      grantId: grant.grantId,
      operation: "runAnything"
    }, session);
  } catch (error) {
    invalidOperationCode = error.code;
  }
  check(invalidOperationCode === "invalid_argument", "daemon file grant operations reject unknown operations");

  const unadvertisedInstance = {
    ...instance,
    instanceId: "inst-unadvertised",
    fileGrantOperations: ["loadPreset"]
  };
  const unadvertisedOperations = createDaemonFileGrantOperations({
    getInstance(instanceId) {
      if (instanceId !== unadvertisedInstance.instanceId) {
        throw protocolError("instance_not_found", "missing instance");
      }
      return unadvertisedInstance;
    },
    instanceFileGrantSupport,
    makeProtocolError: protocolError
  });
  let unadvertisedCode;
  try {
    await unadvertisedOperations.useFileGrant({
      instanceId: unadvertisedInstance.instanceId,
      grantId: "filegrant-missing",
      operation: "loadSample"
    }, session);
  } catch (error) {
    unadvertisedCode = error.code;
  }
  check(unadvertisedCode === "unsupported_file_grant_operation", "daemon file grant operations reject unadvertised worker operations before path use");

  return { response, observedAbsolutePath };
}

function createFakeFileGrantSupport(grant, protocolError) {
  return {
    publicFileGrant(candidate) {
      return {
        grantId: candidate.grantId,
        purpose: candidate.purpose,
        access: candidate.access,
        kind: candidate.kind,
        displayName: candidate.displayName,
        createdAt: candidate.createdAt,
        expiresAt: candidate.expiresAt
      };
    },
    resolveFileGrantForUse(grantId, session, constraints = {}) {
      if (grantId !== grant.grantId) {
        throw protocolError("file_grant_not_found", "missing grant");
      }
      if (session?.sessionToken !== grant.ownerSessionToken) {
        throw protocolError("file_grant_access_denied", "wrong owner");
      }
      for (const field of ["purpose", "access", "kind"]) {
        if (constraints[field] && constraints[field] !== grant[field]) {
          throw protocolError(`file_grant_${field}_mismatch`, "grant constraint mismatch");
        }
      }
      return grant;
    }
  };
}
