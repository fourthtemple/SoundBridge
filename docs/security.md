# Security Model

SoundBridge exposes native audio plugins to browser origins. That is powerful, so the default posture must be narrow and explicit.

## Threat Model

Risks:

- a malicious website tries to scan installed plugins
- a site attempts to load plugins without user consent
- a plugin state blob is abused as a filesystem or code execution path
- a compromised plugin crashes or attacks the daemon
- an origin reuses an old session token
- a paired origin tries to control another origin's plugin instance
- one browser host tries to exhaust local plugin worker resources
- the daemon accidentally binds a non-loopback interface

Non-goals for the MVP:

- protecting against a fully compromised local user account
- sandboxing every third-party plugin on day one
- exposing native plugin editors to arbitrary browser frames

## Required Controls

- Bind to `127.0.0.1` and `::1` only by default.
- Require pairing before scan, list, instantiate, parameter, state, or audio commands.
- Maintain an origin allowlist.
- Use short-lived session tokens.
- Bind session tokens to the origin and browser connection that paired them.
- Make plugin instances session-owned and reject cross-session `instanceId` access.
- Destroy session-owned plugin instances when the browser connection closes.
- Enforce per-session and daemon-wide plugin instance limits.
- Prompt natively for new origins in the production daemon.
- Do not expose arbitrary filesystem access.
- Do not expose plugin paths unless diagnostics are explicitly enabled.
- Treat plugin state as opaque bytes and pass it only to the plugin instance that produced it.
- Run plugin DSP in a worker process where practical.
- Restart crashed plugin workers without killing the daemon.
- Keep VST3, AU, and LV2 host adapters behind the same pairing and origin checks.
- Prefer per-format worker processes so a crash or exploit in one plugin stack cannot poison all native hosting.

## Development Token

The mock daemon uses `SOUNDBRIDGE_PAIRING_TOKEN` or `dev-token`. That is intentionally convenient and intentionally not production security. The real macOS daemon should generate a one-time token or show a native confirmation prompt with the requesting origin.

The development daemon now enforces the important multi-host boundaries even with the simple token flow:

- sessions are bound to the WebSocket connection and Origin header that paired them
- plugin instances are owned by the creating session
- commands for another session's `instanceId` fail with `instance_access_denied`
- disconnecting a WebSocket destroys its session-owned plugin workers
- quotas default to 8 instances per session and 32 instances total

Those defaults can be adjusted for testing with `SOUNDBRIDGE_MAX_INSTANCES_PER_SESSION`, `SOUNDBRIDGE_MAX_TOTAL_INSTANCES`, `SOUNDBRIDGE_MAX_SESSIONS_PER_ORIGIN`, and `SOUNDBRIDGE_SESSION_TTL_MS`.

Set `SOUNDBRIDGE_ALLOWED_ORIGINS` to a comma-separated list to restrict pairing to known sites:

```sh
SOUNDBRIDGE_ALLOWED_ORIGINS=https://your-daw.example,http://127.0.0.1:5173 npm run bridge
```

## Browser Headers

The reference demo sets:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

These headers prepare the demo for `SharedArrayBuffer` ring buffers. The current mock path works without shared memory, but production low-latency transports should prefer it when available.
