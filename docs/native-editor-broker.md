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

When no broker path is configured, `hello.capabilities.nativeEditor` and `hello.capabilities.security.nativeEditorBroker` remain `false`, and `openEditor({ mode: "native" })` fails closed.

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
  "nativeHost": {
    "format": "vst3",
    "renderEngine": "native-vst3"
  }
}
```

The `nativeHost` object is daemon-to-broker data only. Browser responses must remain path-free.

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

Native editor sessions keep the same ownership model as generic editor sessions:

- opening requires a paired session that owns the plugin instance
- closing requires the same paired session
- editor sessions are capped per session and globally
- editor sessions expire with the configured editor TTL
- editor cleanup runs when the editor closes, the instance is destroyed, the WebSocket session disconnects, or the editor expires

The broker must treat plugin UI code as untrusted native code. Platform implementations should broker file dialogs, clipboard, drag/drop, focus, and window ownership explicitly, then add OS-level sandboxing after the core host behavior is complete.
