# Native Editor Broker

Native plugin editors are a separate trust boundary from audio processing. They can create windows, receive focus, interact with clipboard and drag/drop APIs, and trigger file dialogs. SoundBridge therefore keeps native editor UI code out of the daemon.

The daemon supports an opt-in broker contract for future VST3/AU/LV2 editor windows. It is disabled by default. When enabled, the daemon spawns a separate broker process and communicates over bounded JSON lines on stdin/stdout.

## Enabling

Set:

```sh
SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH=/absolute/path/to/broker
SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS='["optional","args"]'
```

`SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH` must be an absolute executable path. Args are optional and must be a JSON array of up to 16 strings, each capped at 4096 UTF-8 bytes. The daemon uses `spawn()` without a shell.

Native editor file dialogs, clipboard access, and drag/drop reporting are denied by default even when the broker advertises them. A daemon must opt in with `SOUNDBRIDGE_NATIVE_EDITOR_ALLOW_FILE_DIALOGS=1`, `SOUNDBRIDGE_NATIVE_EDITOR_ALLOW_CLIPBOARD=1`, or `SOUNDBRIDGE_NATIVE_EDITOR_ALLOW_DRAG_DROP=1` before those broker capabilities can appear in browser-visible editor responses.

When no broker path is configured, `hello.capabilities.nativeEditor` and `hello.capabilities.security.nativeEditorBroker` remain `false`, and `openEditor({ mode: "native" })` fails closed.

Plugin listings may still advertise `editorKinds: ["generic-parameters", "native-window"]` for installed native plugins. Hosts should treat that as per-plugin UI guidance, not authority: a native editor action should require both plugin `native-window` support and daemon `hello.capabilities.nativeEditor`.

## Process Contract

The broker writes a ready line before accepting commands:

```json
{"ok":true,"ready":true}
```

The daemon then sends one JSON object per line.

Open:

```json
{
  "command": "openEditor",
  "editorId": "editor-...",
  "instanceId": "inst-...",
  "pluginId": "vst3:Example.vst3",
  "format": "vst3",
  "kind": "effect",
  "sampleRate": 48000,
  "maxBlockSize": 128,
  "capabilityPolicy": {
    "fileDialogs": false,
    "clipboard": false,
    "dragAndDrop": false
  },
  "fileGrants": [
    {
      "grantId": "filegrant-...",
      "purpose": "sample",
      "access": "read",
      "kind": "file",
      "displayName": "Kick.wav",
      "absolutePath": "/absolute/native-approved/path/Kick.wav",
      "createdAt": 1710000000000,
      "expiresAt": 1710000600000
    }
  ],
  "nativeHost": {
    "format": "vst3",
    "renderEngine": "native-vst3"
  }
}
```

The `capabilityPolicy` object is the daemon's effective allow/deny policy for privileged UI surfaces. Brokers must treat omitted or `false` policy fields as denied, even if the native platform windowing layer could expose the feature. The `nativeHost` object and `fileGrants[].absolutePath` are daemon-to-broker data only. The daemon includes only grants already attached to the owning plugin instance and only after session ownership checks. Browser responses must remain path-free.

Open response:

```json
{
  "ok": true,
  "brokerSessionId": "bounded-display-id",
  "capabilities": {
    "nativeWindow": true,
    "parameterEditing": false,
    "fileDialogs": false,
    "clipboard": false,
    "dragAndDrop": false
  }
}
```

`ok` must be `true`. `brokerSessionId` must be a non-empty UTF-8 string capped at 80 bytes and must not contain control characters. Invalid open responses fail closed and the daemon tears down the broker session before registering a browser-visible native editor session.

Close:

```json
{"command":"closeEditor","editorId":"editor-..."}
```

Quit:

```json
{"command":"quit"}
```

Command errors should be returned as:

```json
{"error":"short_error_code"}
```

## Bounds And Cleanup

The broker IPC uses the daemon worker limits for stdout line size, stderr line size and budget, command size, ready timeout, command timeout, diagnostic log length, and termination grace. These limits are advertised under `hello.capabilities.security`.

The effective native editor policy is also advertised under `hello.capabilities.security.nativeEditorFileDialogs`, `nativeEditorClipboard`, and `nativeEditorDragAndDrop`. Hosts should treat `false` as unavailable even if a platform broker internally supports the surface.

Malformed JSON, invalid ready handshakes, oversized stdout/stderr lines, missing responses, and broker-reported command errors fail closed and tear down the broker session.

Native editor sessions keep the same ownership model as generic editor sessions:

- opening requires a paired session that owns the plugin instance
- closing requires the same paired session
- editor sessions are capped per session and globally
- editor sessions expire with the configured editor TTL
- editor cleanup runs when the editor closes, the instance is destroyed, the WebSocket session disconnects, or the editor expires

The broker must treat plugin UI code as untrusted native code. Platform implementations should broker file dialogs, clipboard, drag/drop, focus, window ownership, and any attached file-grant use explicitly. OS-level sandboxing belongs in a separately advertised hardened profile after core host behavior is complete, because some commercial plugin UIs depend on normal user-environment license, cache, helper, and authorization workflows.
