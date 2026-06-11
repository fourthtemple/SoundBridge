# Security Model

SoundBridge exposes native audio plugins to browser origins. That is powerful, so the default posture must be narrow and explicit.

This is also why browser-to-native plugin bridges should converge on an auditable open standard. A web origin that can ask a local companion app to scan or load VST3, Audio Unit, or LV2 plugins is crossing the browser sandbox into native code. See [Why Browser Plugin Bridges Need An Open Standard](open-standard.md).

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
- Keep unpaired `hello` responses minimal; detailed plugin-host capabilities require pairing.
- Require a WebSocket `Origin` header before pairing.
- Maintain an origin allowlist.
- Use short-lived session tokens.
- Bind session tokens to the origin and browser connection that paired them.
- Make plugin instances session-owned and reject cross-session `instanceId` access.
- Destroy session-owned plugin instances when the browser connection closes.
- Enforce per-session and daemon-wide plugin instance limits.
- Cap WebSocket message size before pairing.
- Prompt natively for new origins in the production daemon.
- Do not expose arbitrary filesystem access.
- Do not expose plugin paths unless diagnostics are explicitly enabled.
- Treat plugin state as opaque bytes and pass it only to the plugin instance that produced it.
- Run plugin DSP in a worker process where practical.
- Restart crashed plugin workers without killing the daemon.
- Keep VST3, AU, and LV2 host adapters behind the same pairing and origin checks.
- Prefer per-format worker processes so a crash or exploit in one plugin stack cannot poison all native hosting.
- Treat worker process sandboxing as a production hardening requirement for third-party plugin code.
- Reject any HTTP request or WebSocket upgrade whose `Host` header is not a loopback name, to defeat DNS rebinding.
- Compare the pairing token in constant time and throttle/lock out repeated failed pairing attempts.
- Validate and bound every numeric field on untrusted commands before allocating buffers or spawning workers.

## Worker Process Sandboxing Roadmap

Worker processes contain plugin crashes, but they do not automatically contain a malicious plugin. Production hosts should apply an operating-system sandbox around third-party plugin workers as the final hardening layer after core hosting behavior works. On macOS, that means evaluating an App Sandbox entitlement model for distributed builds and a tighter seatbelt profile for internal helpers where allowed. The sandbox should deny ambient network access, keep filesystem access to explicit plugin/state locations, and expose only the brokered audio, MIDI, parameter, and state IPC needed by SoundBridge.

The reference implementation does not claim that sandboxing is complete today. It keeps plugin hosting behind worker boundaries and input validation now, and tracks OS sandboxing as the last containment milestone before this should be treated as a hardened general-purpose host.

## Full Host Feature Security Roadmap

Full VST3/AU/LV2 hosting adds more than audio rendering. MIDI event lists, parameter metadata, automation, opaque state, latency/tail reporting, bus negotiation, native editor windows, presets, samples, and licensing flows all increase the attack surface. This applies to browser hosts and local desktop hosts: once the system loads third-party plugin code, the plugin boundary must be treated as untrusted.

| Feature | Added risk | Required control |
| --- | --- | --- |
| MIDI event lists | Oversized or malformed event batches can stress workers or confuse adapters. | Bound event count, byte size, timing offsets, channel/note/controller/program/value ranges, and reject malformed events before worker dispatch; LV2 atom MIDI must use worker-owned bounded sequence buffers. |
| Parameter enumeration, program metadata, and automation | Plugin-controlled names/units/ids/program labels and oversized automation bursts can break JSON, UI, logs, or automation paths. | Cap counts and string lengths, escape text, normalize values, bound VST3 program-list metadata, bound automation event lists, and enforce per-instance ownership. |
| Public plugin metadata | Scanner-controlled identifiers can leak local paths or become oversized UI/cache data. | Expose only bounded path-free public metadata such as bundle ids, AudioComponent tuples, versions, and LV2 URIs; keep launch paths in internal diagnostics. |
| State save/restore | Opaque blobs can be huge or maliciously malformed. | VST3/AU now enforce blob-size limits, keep state opaque, bind it to the producing instance/session, and never interpret it as a path or command; LV2 control-port state and portable POD extension properties are bounded and keyed only to known ports or URIs; LV2 file-backed state is allowed only through brokered relative paths, symlink/traversal rejection, and capped embedded file bytes. |
| Latency and tail reporting | Bogus values can break host scheduling. | Clamp to sane numeric ranges, preserve explicit infinite-tail signals, and treat negative, NaN, or extreme values as invalid. |
| Bus and layout negotiation | Bad channel/block/sample-rate combinations can trigger large allocations or crashes. | Keep hard resource limits at the daemon boundary and inside each worker before allocation, expose only bounded negotiated per-bus layout metadata, and route sidechain or multi-output audio only through explicit bounded bus buffers. |
| LV2 extensions | Worker, UI, and other extension features require host-provided feature data and callbacks. | Keep unsupported extensions disabled; enable each extension only with explicit feature structs, bounded data, ownership checks, file-broker rules where needed, and worker containment. |
| Plugin editor/UI hosting | Native editor code can open windows, dialogs, clipboard, drag/drop, and platform UI surfaces. | Run editor code outside the daemon, broker UI actions explicitly, and keep web/local host ownership checks in place. |
| Presets, samples, caches, licensing | Plugins may expect broad filesystem or network access. | Broker narrow user-approved file access, avoid ambient filesystem access, and deny network access where the OS sandbox permits it. |

## DNS Rebinding And Host Headers

Binding to loopback is necessary but not sufficient. A public website can use DNS rebinding to point its own name at `127.0.0.1` and reach the daemon from the browser. The browser still sends the site's real `Origin`, so the origin allowlist is the primary defense — but a daemon with an empty allowlist would then rely on the pairing token alone.

Conforming daemons MUST reject any request or upgrade whose `Host` header is not `127.0.0.1`, `localhost`, or `[::1]` (optionally with the expected port). Production daemons MUST also ship a non-empty origin allowlist and/or a native per-origin approval prompt; the reference daemon warns at startup when no allowlist is configured. The reference daemon enforces the `Host` check on both the HTTP and WebSocket-upgrade paths.

## Resource Limits And Input Validation

Pairing and instance ownership stop other origins from reaching an instance, but a single authorized origin (including one compromised by XSS) can still try to exhaust the host. Instance-count quotas alone do not cover this: a single instance with an attacker-chosen channel count or block size can exhaust memory. Conforming daemons MUST validate and bound the numeric fields on untrusted commands and reject out-of-range values rather than coercing them.

The reference daemon enforces these defaults (all overridable by environment variable for testing):

| Limit | Default | Field(s) |
| --- | --- | --- |
| Sample rate | 8000–384000 Hz | `createInstance.sampleRate`, `processAudioBlock.sampleRate` |
| Max block size | 1–8192 frames | `createInstance.maxBlockSize` |
| Frames per block | clamped to the instance `maxBlockSize` | `processAudioBlock` |
| Audio channels | 0–32 in, 1–32 out | `createInstance.inputChannels` / `outputChannels` |
| Plugin buses | 0–32 in, 1–32 out | `getLayout`, `createInstance.layout` |
| MIDI events per request | 4096 | `sendMidiEvents.events` |
| Parameter automation events per request | 4096 | `setParameterEvents.events` |
| Plugin parameters per instance | 1024 | `getParameters`, `listPlugins`, `createInstance.plugin.parameters` |
| Parameter id/name/unit text | 64 / 160 / 64 bytes | `getParameters`, `setParameter.parameterId`, `setParameterEvents.events[].parameterId` |
| Plugin presets | 256 presets, 64-byte ids, 160-byte names, 1024 bounded parameter values per preset | `listPlugins`, `scanPlugins` |
| VST3 program metadata | 256 lists, 1024 units, 256 programs per parameter, 160-byte names | `getParameters`, `createInstance.plugin.parameters` |
| Native plugin state bytes / state envelope | 384 KiB / 1 MiB | `getState`, `setState` |
| LV2 file-backed state | 64 files, 64 KiB per file, 192 KiB total, 256-byte relative paths | LV2 `state:mapPath` / `state:makePath` |
| Plugin/transport latency samples | 0–1048576 | `getLatency`, `processAudioBlock.latencySamples` |
| Plugin tail samples | 0–1048576 | `getTailTime`, `processAudioBlock.tailSamples` |
| Sessions per origin | 8 | `pair` |
| Total sessions | 64 | `pair` |
| Instances per session / total | 8 / 32 | `createInstance` |
| Pairing attempts per connection | 5, then the connection is closed | `pair` |
| WebSocket message size | 1 MiB, enforced before pairing | all frames |

Out-of-range `createInstance` values fail with `invalid_argument`. Native host workers independently clamp block size and channel counts before allocating, so a misbehaving daemon layer cannot drive a worker into an oversized allocation. `packages/protocol/schema/protocol.schema.json` encodes these bounds per command so other implementations can validate against the same contract.

## Development Token

The mock daemon generates an ephemeral pairing token each time it starts and prints it to the local terminal. `SOUNDBRIDGE_PAIRING_TOKEN` exists for controlled automation and test fixtures; do not ship a public static token. The real macOS daemon should show a native confirmation prompt with the requesting origin.

The development daemon now enforces the important multi-host boundaries even with the simple token flow:

- sessions are bound to the WebSocket connection and Origin header that paired them
- plugin instances are owned by the creating session
- commands for another session's `instanceId` fail with `instance_access_denied`
- disconnecting a WebSocket destroys its session-owned plugin workers
- quotas default to 8 instances per session and 32 instances total

Those defaults can be adjusted for testing with `SOUNDBRIDGE_MAX_INSTANCES_PER_SESSION`, `SOUNDBRIDGE_MAX_TOTAL_INSTANCES`, `SOUNDBRIDGE_MAX_SESSIONS_PER_ORIGIN`, `SOUNDBRIDGE_SESSION_TTL_MS`, and `SOUNDBRIDGE_MAX_WEBSOCKET_MESSAGE_BYTES`.

Set `SOUNDBRIDGE_ALLOWED_ORIGINS` to a comma-separated list to restrict pairing to known sites:

```sh
SOUNDBRIDGE_ALLOWED_ORIGINS=https://your-daw.example,http://127.0.0.1:5173 npm run bridge
```

The daemon refuses non-loopback binds unless `SOUNDBRIDGE_ALLOW_NON_LOOPBACK=1` is set. The demo server has the same guard through `SOUNDBRIDGE_DEMO_ALLOW_NON_LOOPBACK=1` and only serves the browser demo plus the built web-client bundle.

## Browser Headers

The reference demo sets:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

These headers prepare the demo for `SharedArrayBuffer` ring buffers. The current mock path works without shared memory, but production low-latency transports should prefer it when available.
