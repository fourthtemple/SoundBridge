# File Grant Approval Broker

Preset files, samples, caches, licenses, and other plugin files cross a separate trust boundary from audio/MIDI/control data. SoundBridge therefore keeps browser-visible file access as opaque grants and expects production hosts to approve local files through a native broker.

The reference daemon enables the approval broker only when `SOUNDBRIDGE_FILE_GRANT_BROKER_PATH` names an absolute executable path. Optional arguments use `SOUNDBRIDGE_FILE_GRANT_BROKER_ARGS` as a bounded JSON string array. Broker-selected paths must still resolve inside `SOUNDBRIDGE_FILE_GRANT_ROOTS`; the daemon rejects outside-root paths and symlink escapes after `realpath`.

## Handshake

The broker writes a ready line before accepting commands:

```json
{"ok":true,"ready":true}
```

Invalid, missing, oversized, or malformed ready lines fail closed.

## Request

For `createFileGrant` requests without a browser-supplied `path`, the daemon sends one JSON line:

```json
{
  "command": "requestFileGrant",
  "origin": "https://daw.example",
  "purpose": "sample",
  "access": "read",
  "kind": "file"
}
```

The broker should present a native picker or equivalent local approval UI, scoped to the requesting origin and requested purpose/access/kind.

## Response

The broker returns one JSON line:

```json
{
  "ok": true,
  "path": "/absolute/native-approved/path/Kick.wav",
  "displayName": "Kick.wav"
}
```

The daemon validates `path` against configured roots and returns only a path-free grant to the browser. `displayName` is optional and bounded; it is display text, not authority.

To deny the request:

```json
{"error":"user_denied"}
```

## Limits

The approval broker uses the daemon worker limits for stdout line size, stderr line size and budget, command size, ready timeout, command timeout, diagnostic log length, and termination grace. These limits are advertised under `hello.capabilities.security`.

Browser-supplied paths remain disabled unless `SOUNDBRIDGE_FILE_GRANT_ALLOW_BROWSER_PATHS=1` is set for development or test harnesses.
