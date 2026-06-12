export function createSecurityEditorCases({ check, request }) {
  async function checkOpenEditor({ main, session, created }) {
    const editor = await request(main, "openEditor", { instanceId: created.instanceId }, true, session);
    check(
      /^editor-[0-9a-f-]{36}$/.test(editor.editorId) &&
        editor.kind === "generic-parameters" &&
        editor.native === false &&
        editor.capabilities?.parameterEditing === true &&
        editor.capabilities?.nativeWindow === false &&
        Array.isArray(editor.parameters) &&
        !("diagnostics" in (editor.plugin ?? {})),
      "openEditor returns a bounded generic parameter editor session"
    );
    const nativeEditor = await request(
      main,
      "openEditor",
      { instanceId: created.instanceId, mode: "native" },
      true,
      session
    ).then(
      () => ({ ok: true }),
      (error) => ({ code: error.code })
    );
    check(nativeEditor.code === "unsupported_command", "openEditor refuses native editors until a UI worker is available");
    return editor;
  }

  async function checkEditorOwnership({ main, other, session, otherSessionToken, created, editor }) {
    const editorOpenDenied = await request(
      other,
      "openEditor",
      { instanceId: created.instanceId },
      true,
      otherSessionToken
    ).then(
      () => ({ ok: true }),
      (error) => ({ code: error.code })
    );
    check(editorOpenDenied.code === "instance_access_denied", "another session cannot open an editor for this instance");
    const editorCloseDenied = await request(
      other,
      "closeEditor",
      { editorId: editor.editorId },
      true,
      otherSessionToken
    ).then(
      () => ({ ok: true }),
      (error) => ({ code: error.code })
    );
    check(editorCloseDenied.code === "editor_access_denied", "another session cannot close this editor session");
    const editorClosed = await request(main, "closeEditor", { editorId: editor.editorId }, true, session);
    check(editorClosed.closed === true, "owner session can close its generic editor session");
  }

  return {
    checkEditorOwnership,
    checkOpenEditor
  };
}
