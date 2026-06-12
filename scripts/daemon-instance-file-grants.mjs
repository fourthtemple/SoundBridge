export function createDaemonInstanceFileGrants({
  fileGrantSupport,
  maxFileGrantsPerInstance,
  makeProtocolError
}) {
  function attachFileGrant(payload, session, getInstance) {
    const instance = getInstance(payload.instanceId, session);
    const attachments = ensureAttachmentMap(instance);
    cleanupStaleAttachments(instance, session);
    if (!attachments.has(String(payload.grantId ?? "")) && attachments.size >= maxFileGrantsPerInstance) {
      throw makeProtocolError("quota_exceeded", "This plugin instance has reached its file grant attachment limit.", {
        maxFileGrantsPerInstance
      });
    }

    const grant = fileGrantSupport.resolveFileGrantForUse(payload.grantId, session, {
      access: payload.access,
      kind: payload.kind,
      purpose: payload.purpose
    });
    const attachment = publicAttachment(grant, Date.now());
    attachments.set(grant.grantId, attachment);
    return {
      attached: true,
      instanceId: instance.instanceId,
      grant: attachment
    };
  }

  function listInstanceFileGrants(payload, session, getInstance) {
    const instance = getInstance(payload.instanceId, session);
    cleanupStaleAttachments(instance, session);
    return {
      instanceId: instance.instanceId,
      grants: Array.from(ensureAttachmentMap(instance).values())
    };
  }

  function detachFileGrant(payload, session, getInstance) {
    const instance = getInstance(payload.instanceId, session);
    const grantId = requireGrantId(payload.grantId);
    const attachments = ensureAttachmentMap(instance);
    const detached = attachments.delete(grantId);
    return {
      detached,
      instanceId: instance.instanceId,
      grantId
    };
  }

  function cleanupStaleAttachments(instance, session) {
    const attachments = ensureAttachmentMap(instance);
    for (const [grantId, attachment] of Array.from(attachments.entries())) {
      try {
        fileGrantSupport.resolveFileGrantForUse(grantId, session, {
          kind: attachment.kind,
          purpose: attachment.purpose
        });
      } catch {
        attachments.delete(grantId);
      }
    }
  }

  function publicAttachment(grant, attachedAt) {
    return {
      ...fileGrantSupport.publicFileGrant(grant),
      attachedAt
    };
  }

  function requireGrantId(value) {
    const grantId = String(value ?? "");
    if (!grantId || Buffer.byteLength(grantId, "utf8") > 80) {
      throw makeProtocolError("invalid_argument", "grantId must be a non-empty string of at most 80 bytes.");
    }
    return grantId;
  }

  return {
    attachFileGrant,
    detachFileGrant,
    listInstanceFileGrants
  };
}

function ensureAttachmentMap(instance) {
  if (!instance.fileGrantAttachments) {
    instance.fileGrantAttachments = new Map();
  }
  return instance.fileGrantAttachments;
}
