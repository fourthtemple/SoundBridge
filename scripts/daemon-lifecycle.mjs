export function createDaemonLifecycle({
  sessions,
  instances,
  editors,
  fileGrants,
  destroyFileGrantRecord,
  makeProtocolError
}) {
  function assertPaired(sessionToken, command, context) {
    const session = sessions.get(sessionToken);
    if (!session) {
      throw makeProtocolError("not_paired", `Pair before calling ${command}.`);
    }
    if (session.expiresAt <= Date.now()) {
      destroySession(sessionToken);
      throw makeProtocolError("session_expired", "Pairing session expired.");
    }
    if (session.connectionId !== context.connectionId) {
      throw makeProtocolError("session_connection_mismatch", "This session token is bound to a different browser connection.");
    }
    if (session.origin !== context.requestOrigin) {
      throw makeProtocolError("origin_mismatch", "This session token is bound to a different browser origin.");
    }
    session.lastSeenAt = Date.now();
    return session;
  }

  function cleanupConnection(context) {
    for (const sessionToken of context.sessionTokens) {
      destroySession(sessionToken);
    }
    context.sessionTokens.clear();
  }

  function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sessionToken, session] of sessions) {
      if (session.expiresAt <= now) {
        destroySession(sessionToken);
      }
    }
  }

  function destroySession(sessionToken) {
    const session = sessions.get(sessionToken);
    if (!session) {
      return;
    }
    for (const editorId of Array.from(session.editors)) {
      const editor = editors.get(editorId);
      if (editor) {
        destroyEditorRecord(editor);
      }
    }
    for (const grantId of Array.from(session.fileGrants ?? [])) {
      const grant = fileGrants?.get(grantId);
      if (grant) {
        destroyFileGrantRecord?.(grant);
      }
    }
    for (const instanceId of Array.from(session.instances)) {
      const instance = instances.get(instanceId);
      if (instance) {
        destroyInstanceRecord(instance);
      }
    }
    sessions.delete(sessionToken);
  }

  function destroyInstanceRecord(instance) {
    destroyEditorsForInstance(instance.instanceId);
    instance.worker?.destroy();
    instances.delete(instance.instanceId);
    const owner = sessions.get(instance.ownerSessionToken);
    owner?.instances.delete(instance.instanceId);
  }

  function cleanupExpiredEditors() {
    const now = Date.now();
    for (const editor of Array.from(editors.values())) {
      if (editor.expiresAt <= now || !instances.has(editor.instanceId)) {
        destroyEditorRecord(editor);
      }
    }
  }

  function destroyEditorsForInstance(instanceId) {
    for (const editor of Array.from(editors.values())) {
      if (editor.instanceId === instanceId) {
        destroyEditorRecord(editor);
      }
    }
  }

  function destroyEditorRecord(editor) {
    const close = editor.close;
    editor.close = undefined;
    try {
      close?.();
    } catch {
    }
    editors.delete(editor.editorId);
    const owner = sessions.get(editor.ownerSessionToken);
    owner?.editors.delete(editor.editorId);
  }

  function sessionsForOrigin(origin) {
    cleanupExpiredSessions();
    return Array.from(sessions.values()).filter((session) => session.origin === origin);
  }

  return {
    assertPaired,
    cleanupConnection,
    cleanupExpiredEditors,
    cleanupExpiredSessions,
    destroyEditorRecord,
    destroyInstanceRecord,
    sessionsForOrigin
  };
}
