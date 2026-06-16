import { createDaemonFileGrantOperations } from "./daemon-file-grant-operations.mjs";
import { createDaemonInstanceFileGrants } from "./daemon-instance-file-grants.mjs";

export async function exerciseDaemonFileGrantOperation({ absolutePath, check, protocolError }) {
  const session = { sessionToken: "session-test", origin: "http://127.0.0.1:5173" };
  const sampleGrant = {
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
  const presetGrant = grantFixture(sampleGrant, {
    grantId: "filegrant-preset",
    purpose: "preset",
    displayName: "Fixture Preset.fxp",
    absolutePath: `${absolutePath}.preset`
  });
  const cacheGrant = grantFixture(sampleGrant, {
    grantId: "filegrant-cache",
    purpose: "cache",
    access: "readWrite",
    kind: "directory",
    displayName: "Fixture Cache",
    absolutePath: `${absolutePath}.cache`
  });
  const licenseGrant = grantFixture(sampleGrant, {
    grantId: "filegrant-license",
    purpose: "license",
    displayName: "Fixture License.key",
    absolutePath: `${absolutePath}.license`
  });
  let observedAbsolutePath;
  const observedOperations = [];
  const instance = {
    instanceId: "inst-test",
    ownerSessionToken: session.sessionToken,
    fileGrantAttachments: new Map(),
    fileGrantOperations: ["loadPreset", "loadSample", "openCacheDirectory", "loadLicense", "other"],
    worker: {
      async useFileGrant({ operation, grant: workerGrant }) {
        observedAbsolutePath = workerGrant.absolutePath;
        observedOperations.push({ operation, grant: workerGrant });
        const status = operation === "loadSample" ? `loaded ${workerGrant.absolutePath}` : `${operation}-ok`;
        return { applied: operation !== "other", status, absolutePath: workerGrant.absolutePath };
      }
    }
  };
  const instanceFileGrantSupport = createDaemonInstanceFileGrants({
    fileGrantSupport: createFakeFileGrantSupport([sampleGrant, presetGrant, cacheGrant, licenseGrant], protocolError),
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
    grantId: sampleGrant.grantId,
    purpose: "sample",
    access: "read",
    kind: "file"
  }, session, () => instance);
  instanceFileGrantSupport.attachFileGrant({
    instanceId: instance.instanceId,
    grantId: presetGrant.grantId,
    purpose: "preset",
    access: "read",
    kind: "file"
  }, session, () => instance);
  instanceFileGrantSupport.attachFileGrant({
    instanceId: instance.instanceId,
    grantId: cacheGrant.grantId,
    purpose: "cache",
    access: "readWrite",
    kind: "directory"
  }, session, () => instance);
  instanceFileGrantSupport.attachFileGrant({
    instanceId: instance.instanceId,
    grantId: licenseGrant.grantId,
    purpose: "license",
    access: "read",
    kind: "file"
  }, session, () => instance);
  const response = await operations.useFileGrant({
    instanceId: instance.instanceId,
    grantId: sampleGrant.grantId,
    operation: "loadSample"
  }, session);
  check(
    response.applied === true &&
      response.workerStatus === undefined &&
      observedOperations.at(-1)?.grant.absolutePath === sampleGrant.absolutePath,
    "daemon file grant operations suppress worker statuses that include private paths"
  );

  const presetResponse = await operations.useFileGrant({
    instanceId: instance.instanceId,
    grantId: presetGrant.grantId,
    operation: "loadPreset"
  }, session);
  check(
    presetResponse.applied === true &&
      presetResponse.operation === "loadPreset" &&
      presetResponse.grant.purpose === "preset" &&
      presetResponse.workerStatus === "loadPreset-ok",
    "daemon file grant operations route preset file grants"
  );

  const cacheResponse = await operations.useFileGrant({
    instanceId: instance.instanceId,
    grantId: cacheGrant.grantId,
    operation: "openCacheDirectory"
  }, session);
  check(
    cacheResponse.applied === true &&
      cacheResponse.operation === "openCacheDirectory" &&
      cacheResponse.grant.kind === "directory" &&
      cacheResponse.workerStatus === "openCacheDirectory-ok",
    "daemon file grant operations route cache directory grants"
  );

  const licenseResponse = await operations.useFileGrant({
    instanceId: instance.instanceId,
    grantId: licenseGrant.grantId,
    operation: "loadLicense"
  }, session);
  check(
    licenseResponse.applied === true &&
      licenseResponse.operation === "loadLicense" &&
      licenseResponse.grant.purpose === "license" &&
      licenseResponse.workerStatus === "loadLicense-ok",
    "daemon file grant operations route license file grants"
  );

  let mismatchCode;
  try {
    await operations.useFileGrant({
      instanceId: instance.instanceId,
      grantId: sampleGrant.grantId,
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
      grantId: sampleGrant.grantId
    }, session);
  } catch (error) {
    missingOperationCode = error.code;
  }
  check(missingOperationCode === "invalid_argument", "daemon file grant operations require an explicit operation");

  let unconstrainedOtherCode;
  try {
    await operations.useFileGrant({
      instanceId: instance.instanceId,
      grantId: sampleGrant.grantId,
      operation: "other"
    }, session);
  } catch (error) {
    unconstrainedOtherCode = error.code;
  }
  check(unconstrainedOtherCode === "invalid_argument", "daemon file grant operations require explicit constraints for other operations");

  const otherResponse = await operations.useFileGrant({
    instanceId: instance.instanceId,
    grantId: sampleGrant.grantId,
    operation: "other",
    purpose: "sample",
    access: "read",
    kind: "file"
  }, session);
  check(
    otherResponse.accepted === true &&
      otherResponse.operation === "other" &&
      otherResponse.applied === false &&
      observedAbsolutePath === absolutePath,
    "daemon file grant operations allow explicitly constrained other operations"
  );

  let invalidOperationCode;
  try {
    await operations.useFileGrant({
      instanceId: instance.instanceId,
      grantId: sampleGrant.grantId,
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

  const unsupportedWorkerInstance = {
    ...instance,
    instanceId: "inst-worker-unsupported",
    fileGrantAttachments: new Map(),
    fileGrantOperations: ["loadSample"],
    worker: {
      async useFileGrant() {
        throw new Error("unsupported_file_grant_operation");
      }
    }
  };
  instanceFileGrantSupport.attachFileGrant({
    instanceId: unsupportedWorkerInstance.instanceId,
    grantId: sampleGrant.grantId,
    purpose: "sample",
    access: "read",
    kind: "file"
  }, session, () => unsupportedWorkerInstance);
  const unsupportedWorkerOperations = createDaemonFileGrantOperations({
    getInstance(instanceId) {
      if (instanceId !== unsupportedWorkerInstance.instanceId) {
        throw protocolError("instance_not_found", "missing instance");
      }
      return unsupportedWorkerInstance;
    },
    instanceFileGrantSupport,
    makeProtocolError: protocolError
  });
  let unsupportedWorkerCode;
  let unsupportedWorkerMessage = "";
  try {
    await unsupportedWorkerOperations.useFileGrant({
      instanceId: unsupportedWorkerInstance.instanceId,
      grantId: sampleGrant.grantId,
      operation: "loadSample"
    }, session);
  } catch (error) {
    unsupportedWorkerCode = error.code;
    unsupportedWorkerMessage = String(error.message ?? "");
  }
  check(
    unsupportedWorkerCode === "unsupported_file_grant_operation" &&
      !unsupportedWorkerMessage.includes(sampleGrant.absolutePath),
    "daemon file grant operations keep worker-refused advanced grants path-free"
  );

  return { response, observedAbsolutePath };
}

function grantFixture(base, overrides) {
  return { ...base, ...overrides };
}

function createFakeFileGrantSupport(grants, protocolError) {
  const grantsById = new Map(grants.map((grant) => [grant.grantId, grant]));
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
      const grant = grantsById.get(grantId);
      if (!grant) {
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
