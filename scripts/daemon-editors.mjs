import crypto from "node:crypto";

export function createDaemonEditors({
  clonePluginMetadata,
  cleanupExpiredEditors,
  destroyEditorRecord,
  editors,
  formatCategory,
  getInstance,
  limits,
  makeProtocolError,
  resolvePlugin
}) {
  function openEditor(payload, session) {
    cleanupExpiredEditors();
    const instance = getInstance(payload.instanceId, session);
    const mode = payload.mode == null ? "generic" : String(payload.mode);
    if (mode === "native") {
      throw makeProtocolError(
        "unsupported_command",
        "Native plugin editors require a future UI worker or broker process."
      );
    }
    if (mode !== "generic") {
      throw makeProtocolError("invalid_argument", "openEditor.mode must be generic or native.");
    }

    if (session.editors.size >= limits.maxEditorsPerSession) {
      throw makeProtocolError("quota_exceeded", "This browser session has reached its editor session limit.", {
        maxEditorsPerSession: limits.maxEditorsPerSession
      });
    }
    if (editors.size >= limits.maxTotalEditors) {
      throw makeProtocolError(
        "quota_exceeded",
        "The local SoundBridge daemon has reached its total editor session limit.",
        {
          maxTotalEditors: limits.maxTotalEditors
        }
      );
    }

    const editorId = `editor-${crypto.randomUUID()}`;
    const expiresAt = Math.min(Date.now() + limits.editorSessionTtlMs, session.expiresAt);
    const editor = {
      editorId,
      instanceId: instance.instanceId,
      ownerSessionToken: session.sessionToken,
      ownerOrigin: session.origin,
      kind: "generic-parameters",
      native: false,
      createdAt: Date.now(),
      expiresAt
    };
    editors.set(editorId, editor);
    session.editors.add(editorId);

    return editorResponse(editor, instance);
  }

  function closeEditor(editorId, session) {
    const editor = getEditor(editorId, session);
    destroyEditorRecord(editor);
    return {
      closed: true,
      editorId: editor.editorId
    };
  }

  function getEditor(editorId, session) {
    cleanupExpiredEditors();
    const safeEditorId = String(editorId ?? "");
    const editor = editors.get(safeEditorId);
    if (!editor) {
      throw makeProtocolError("editor_not_found", `Unknown editor: ${safeEditorId}`);
    }
    if (session && editor.ownerSessionToken !== session.sessionToken) {
      throw makeProtocolError("editor_access_denied", "This editor session belongs to a different browser session.", {
        editorId: safeEditorId,
        requestOrigin: session.origin
      });
    }
    return editor;
  }

  function editorResponse(editor, instance) {
    const plugin = resolvePlugin(instance.pluginId) ?? {};
    return {
      editorId: editor.editorId,
      instanceId: editor.instanceId,
      kind: editor.kind,
      native: editor.native,
      transport: "web",
      expiresAt: editor.expiresAt,
      plugin: clonePluginMetadata({
        ...plugin,
        pluginId: plugin.pluginId ?? instance.pluginId,
        format: instance.format,
        name: plugin.name ?? instance.pluginId,
        vendor: plugin.vendor ?? "Unknown",
        category: plugin.category ?? formatCategory(instance.format),
        kind: instance.kind,
        source: instance.source ?? plugin.source,
        inputs: instance.inputChannels,
        outputs: instance.outputChannels,
        parameters: instance.parameters,
        hostable: true
      }),
      parameters: instance.parameters.map((parameter) => ({ ...parameter })),
      capabilities: {
        parameterEditing: true,
        nativeWindow: false,
        fileDialogs: false,
        clipboard: false,
        dragAndDrop: false
      }
    };
  }

  return {
    closeEditor,
    openEditor
  };
}
