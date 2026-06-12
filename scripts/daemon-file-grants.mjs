import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PURPOSES = new Set(["preset", "sample", "cache", "license", "state", "other"]);
const ACCESS_MODES = new Set(["read", "write", "readWrite"]);
const KINDS = new Set(["file", "directory"]);

export function createDaemonFileGrants({
  fileGrants,
  sessions,
  roots,
  limits,
  makeProtocolError
}) {
  const allowedRoots = normalizeRoots(roots);
  const {
    fileGrantTtlMs,
    maxFileGrantDisplayNameBytes,
    maxFileGrantPathBytes,
    maxFileGrantsPerSession,
    maxTotalFileGrants
  } = limits;

  function available() {
    return allowedRoots.length > 0;
  }

  function createFileGrant(payload, session) {
    cleanupExpiredFileGrants();
    if (!available()) {
      throw makeProtocolError("file_broker_unavailable", "File grants require configured broker roots.");
    }
    ensureSessionGrantSet(session);
    if (session.fileGrants.size >= maxFileGrantsPerSession) {
      throw makeProtocolError("quota_exceeded", "This browser session has reached its file grant limit.", {
        maxFileGrantsPerSession
      });
    }
    if (fileGrants.size >= maxTotalFileGrants) {
      throw makeProtocolError("quota_exceeded", "The local SoundBridge daemon has reached its total file grant limit.", {
        maxTotalFileGrants
      });
    }

    const requestedPath = requireBoundedPath(payload.path);
    const access = requireEnum(payload.access ?? "read", ACCESS_MODES, "access");
    const purpose = requireEnum(payload.purpose ?? "other", PURPOSES, "purpose");
    const requestedKind = payload.kind == null ? undefined : requireEnum(payload.kind, KINDS, "kind");
    const resolved = resolveAllowedPath(requestedPath, requestedKind);
    const grantId = `filegrant-${crypto.randomUUID()}`;
    const expiresAt = Math.min(Date.now() + fileGrantTtlMs, session.expiresAt);
    const grant = {
      grantId,
      ownerSessionToken: session.sessionToken,
      ownerOrigin: session.origin,
      absolutePath: resolved.absolutePath,
      rootId: resolved.rootId,
      purpose,
      access,
      kind: resolved.kind,
      displayName: boundedText(resolved.displayName, maxFileGrantDisplayNameBytes) || resolved.kind,
      createdAt: Date.now(),
      expiresAt
    };
    fileGrants.set(grantId, grant);
    session.fileGrants.add(grantId);
    return publicFileGrant(grant);
  }

  function listFileGrants(payload, session) {
    cleanupExpiredFileGrants();
    ensureSessionGrantSet(session);
    const grants = Array.from(session.fileGrants)
      .map((grantId) => fileGrants.get(grantId))
      .filter(Boolean)
      .map(publicFileGrant);
    return { grants };
  }

  function revokeFileGrant(grantId, session) {
    const grant = getFileGrant(grantId, session);
    destroyFileGrantRecord(grant);
    return {
      revoked: true,
      grantId: grant.grantId
    };
  }

  function getFileGrant(grantId, session) {
    cleanupExpiredFileGrants();
    const safeGrantId = String(grantId ?? "");
    const grant = fileGrants.get(safeGrantId);
    if (!grant) {
      throw makeProtocolError("file_grant_not_found", `Unknown file grant: ${safeGrantId}`);
    }
    if (session && grant.ownerSessionToken !== session.sessionToken) {
      throw makeProtocolError("file_grant_access_denied", "This file grant belongs to a different browser session.", {
        grantId: safeGrantId,
        requestOrigin: session.origin
      });
    }
    return grant;
  }

  function destroyFileGrantRecord(grant) {
    fileGrants.delete(grant.grantId);
    sessions.get(grant.ownerSessionToken)?.fileGrants?.delete(grant.grantId);
  }

  function cleanupExpiredFileGrants() {
    const now = Date.now();
    for (const grant of Array.from(fileGrants.values())) {
      if (grant.expiresAt <= now) {
        destroyFileGrantRecord(grant);
      }
    }
  }

  function resolveAllowedPath(requestedPath, requestedKind) {
    let realPath;
    let stats;
    try {
      realPath = fs.realpathSync(requestedPath);
      stats = fs.statSync(realPath);
    } catch {
      throw makeProtocolError("file_grant_path_not_found", "File grants require an existing file or directory.");
    }

    const kind = stats.isDirectory() ? "directory" : "file";
    if (requestedKind && requestedKind !== kind) {
      throw makeProtocolError("invalid_argument", `File grant kind must match the target ${kind}.`, {
        kind: requestedKind
      });
    }

    const root = allowedRoots.find((candidate) => isWithinRoot(realPath, candidate.realPath));
    if (!root) {
      throw makeProtocolError("file_grant_outside_roots", "File grants are limited to configured broker roots.");
    }

    return {
      absolutePath: realPath,
      rootId: root.rootId,
      kind,
      displayName: path.basename(realPath)
    };
  }

  function requireBoundedPath(value) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      throw makeProtocolError("invalid_argument", "path must be a non-empty string without NUL bytes.");
    }
    if (Buffer.byteLength(value, "utf8") > maxFileGrantPathBytes) {
      throw makeProtocolError("invalid_argument", `path must be at most ${maxFileGrantPathBytes} bytes.`);
    }
    if (!path.isAbsolute(value)) {
      throw makeProtocolError("invalid_argument", "path must be absolute.");
    }
    return path.resolve(value);
  }

  function requireEnum(value, allowed, label) {
    const normalized = String(value ?? "");
    if (!allowed.has(normalized)) {
      throw makeProtocolError("invalid_argument", `${label} is not supported.`, {
        value
      });
    }
    return normalized;
  }

  function publicFileGrant(grant) {
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

  return {
    available,
    cleanupExpiredFileGrants,
    createFileGrant,
    destroyFileGrantRecord,
    getFileGrant,
    listFileGrants,
    publicFileGrant,
    revokeFileGrant
  };
}

function normalizeRoots(roots) {
  return roots
    .map((root, index) => normalizeRoot(root, index))
    .filter(Boolean);
}

function normalizeRoot(root, index) {
  const text = String(root ?? "").trim();
  if (!text || !path.isAbsolute(text)) {
    return undefined;
  }
  try {
    const realPath = fs.realpathSync(text);
    if (!fs.statSync(realPath).isDirectory()) {
      return undefined;
    }
    return {
      rootId: `root-${index + 1}`,
      realPath
    };
  } catch {
    return undefined;
  }
}

function isWithinRoot(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureSessionGrantSet(session) {
  if (!session.fileGrants) {
    session.fileGrants = new Set();
  }
}

function boundedText(value, maxBytes) {
  let output = "";
  for (const char of String(value ?? "")) {
    if (Buffer.byteLength(output + char, "utf8") > maxBytes) {
      break;
    }
    output += char;
  }
  return output;
}
