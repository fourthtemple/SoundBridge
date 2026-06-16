const FILE_GRANT_OPERATION_DEFINITIONS = Object.freeze([
  ["loadPreset", { access: "read", kind: "file", purpose: "preset" }],
  ["loadSample", { access: "read", kind: "file", purpose: "sample" }],
  ["openCacheDirectory", { access: "readWrite", kind: "directory", purpose: "cache" }],
  ["loadLicense", { access: "read", kind: "file", purpose: "license" }],
  ["restoreState", { access: "read", kind: "file", purpose: "state" }],
  ["saveStateDirectory", { access: "readWrite", kind: "directory", purpose: "state" }],
  ["other", {}]
]);

export const FILE_GRANT_OPERATION_NAMES = Object.freeze(
  FILE_GRANT_OPERATION_DEFINITIONS.map(([operation]) => operation)
);

const FILE_GRANT_OPERATIONS = new Map(FILE_GRANT_OPERATION_DEFINITIONS);

export function isKnownFileGrantOperation(operation) {
  return FILE_GRANT_OPERATIONS.has(operation);
}

export function createDaemonFileGrantOperations({
  getInstance,
  instanceFileGrantSupport,
  makeProtocolError
}) {
  async function useFileGrant(payload, session) {
    const request = payload && typeof payload === "object" ? payload : {};
    const instance = getInstance(request.instanceId, session);
    const operation = requireOperation(request.operation);
    const constraints = operationConstraints(operation, request);
    if (!instanceAdvertisesOperation(instance, operation)) {
      throw makeProtocolError("unsupported_file_grant_operation", "This plugin did not advertise support for this file grant operation.");
    }
    if (!instance.worker || typeof instance.worker.useFileGrant !== "function") {
      throw makeProtocolError("unsupported_file_grant_operation", "This plugin worker cannot consume file grants.");
    }

    const grant = instanceFileGrantSupport.nativeFileGrantForInstance(
      instance,
      session,
      request.grantId,
      constraints
    );

    let result;
    try {
      result = await instance.worker.useFileGrant({ grant, operation });
    } catch (error) {
      const message = String(error?.message ?? error);
      if (message.includes("unknown_command") || message.includes("unsupported_file_grant_operation")) {
        throw makeProtocolError("unsupported_file_grant_operation", "This plugin worker does not support file grant operations.");
      }
      throw makeProtocolError("file_grant_operation_failed", "The plugin worker failed while consuming this file grant.");
    }

    const workerStatus = pathFreeWorkerStatus(result?.status, grant);
    return {
      accepted: true,
      applied: result?.applied === true,
      instanceId: instance.instanceId,
      operation,
      grant: publicGrant(grant),
      ...(workerStatus ? { workerStatus } : {})
    };
  }

  function operationConstraints(operation, payload) {
    if (operation === "other") {
      requireOtherOperationConstraints(payload);
    }
    const defaults = FILE_GRANT_OPERATIONS.get(operation) ?? {};
    const constraints = { ...defaults };
    for (const field of ["access", "kind", "purpose"]) {
      if (payload[field] == null) {
        continue;
      }
      const requested = String(payload[field]);
      if (defaults[field] && requested !== defaults[field]) {
        throw makeProtocolError("invalid_argument", `${field} does not match the requested file grant operation.`);
      }
      constraints[field] = requested;
    }
    return constraints;
  }

  function requireOtherOperationConstraints(payload) {
    for (const field of ["purpose", "access", "kind"]) {
      if (payload[field] == null) {
        throw makeProtocolError("invalid_argument", "`other` file grant operations require explicit purpose, access, and kind constraints.");
      }
    }
  }

  function requireOperation(value) {
    if (value == null) {
      throw makeProtocolError("invalid_argument", "File grant operation is required.");
    }
    const operation = String(value ?? "");
    if (!FILE_GRANT_OPERATIONS.has(operation)) {
      throw makeProtocolError("invalid_argument", "Unsupported file grant operation.", {
        operation
      });
    }
    return operation;
  }

  return {
    useFileGrant
  };
}

function pathFreeWorkerStatus(value, grant) {
  const rawText = String(value ?? "");
  if (!rawText) {
    return "";
  }
  const privateTexts = [grant.absolutePath, grant.rootId].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  if (privateTexts.some((candidate) => rawText.includes(candidate))) {
    return "";
  }
  return boundedText(rawText, 64);
}

function instanceAdvertisesOperation(instance, operation) {
  return Array.isArray(instance?.fileGrantOperations) &&
    instance.fileGrantOperations.some((candidate) => candidate === operation && isKnownFileGrantOperation(candidate));
}

function publicGrant(grant) {
  return {
    grantId: grant.grantId,
    purpose: grant.purpose,
    access: grant.access,
    kind: grant.kind,
    displayName: grant.displayName,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt
  };
}

function boundedText(value, maxBytes) {
  const text = String(value ?? "");
  let output = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    if (Buffer.byteLength(output + char, "utf8") > maxBytes) {
      break;
    }
    output += char;
  }
  return output;
}
