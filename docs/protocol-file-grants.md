# Protocol File Grants

This companion page holds file-grant request and response examples for the main [Protocol](protocol.md). File grants are path-free browser capabilities that let a paired session ask daemon-side native code to work with approved preset, sample, cache, license, or state files without exposing absolute paths to browser code.

## Creating Grants

Production-style grants omit `path`. The daemon asks an explicitly configured native approval broker to select or deny the local path, then validates the approved path against configured roots:

```json
{
  "purpose": "sample",
  "access": "read",
  "kind": "file"
}
```

The reference daemon only accepts browser-supplied paths when `SOUNDBRIDGE_FILE_GRANT_ALLOW_BROWSER_PATHS=1` is set for development or test harnesses:

```json
{
  "path": "/absolute/user-approved/path/Kick.wav",
  "purpose": "sample",
  "access": "read",
  "kind": "file"
}
```

In both modes, the browser-facing response is path-free:

```json
{
  "grantId": "filegrant-...",
  "purpose": "sample",
  "access": "read",
  "kind": "file",
  "displayName": "Kick.wav",
  "createdAt": 1710000000000,
  "expiresAt": 1710000600000
}
```

## Attaching Grants

Plugin instances can hold path-free references to session-owned grants:

```json
{
  "instanceId": "inst-...",
  "grantId": "filegrant-...",
  "purpose": "sample",
  "access": "read",
  "kind": "file"
}
```

`purpose`, `access`, and `kind` are optional constraints. When supplied, they must match the grant before the daemon records the attachment:

```json
{
  "attached": true,
  "instanceId": "inst-...",
  "grant": {
    "grantId": "filegrant-...",
    "purpose": "sample",
    "access": "read",
    "kind": "file",
    "displayName": "Kick.wav",
    "createdAt": 1710000000000,
    "expiresAt": 1710000600000,
    "attachedAt": 1710000001000
  }
}
```

`listInstanceFileGrants` returns only live, path-free attachments for the paired session's instance, and `detachFileGrant` removes one attached grant by id.

## Using Grants

`useFileGrant` asks a compatible native worker to consume an already attached grant for a known operation:

```json
{
  "instanceId": "inst-...",
  "grantId": "filegrant-...",
  "operation": "loadSample",
  "purpose": "sample",
  "access": "read",
  "kind": "file"
}
```

The daemon resolves the absolute path only after verifying that the paired session owns the instance, owns the grant, and has attached that grant to the instance. Browser responses remain path-free:

```json
{
  "accepted": true,
  "applied": true,
  "instanceId": "inst-...",
  "operation": "loadSample",
  "grant": {
    "grantId": "filegrant-...",
    "purpose": "sample",
    "access": "read",
    "kind": "file",
    "displayName": "Kick.wav",
    "createdAt": 1710000000000,
    "expiresAt": 1710000600000
  },
  "workerStatus": "ok"
}
```

The absolute path is sent only over bounded daemon-to-worker IPC. Workers that do not implement the requested operation return `unsupported_file_grant_operation`.
