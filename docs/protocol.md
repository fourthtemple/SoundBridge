# Protocol

The MVP protocol runs over `ws://127.0.0.1:47370/bridge`. The daemon must bind loopback only by default. All privileged commands require pairing. Daemons must also reject any request or WebSocket upgrade whose `Host` header is not a loopback name (DNS-rebinding defense) and must validate and bound every numeric field on untrusted commands. See [Security](security.md) for the normative `Host`-header and resource-limit requirements; `packages/protocol/schema/protocol.schema.json` encodes the per-command field bounds.

## Envelope

Requests:

```json
{
  "type": "request",
  "id": "req-1",
  "command": "listPlugins",
  "payload": {}
}
```

Responses:

```json
{
  "type": "response",
  "id": "req-1",
  "ok": true,
  "payload": {}
}
```

Errors:

```json
{
  "type": "response",
  "id": "req-1",
  "ok": false,
  "error": {
    "code": "not_paired",
    "message": "Pair before calling listPlugins."
  }
}
```

Events:

```json
{
  "type": "event",
  "event": "stats",
  "payload": {
    "processedBlocks": 120,
    "underruns": 2
  }
}
```

## Commands

### `hello`

Returns daemon name, protocol version, supported transports, and whether pairing is required. Before pairing, `hello` returns only protocol and security basics; detailed VST3/AU/LV2 host capabilities require a valid session token.

Example paired capability payload:

```json
{
  "capabilities": {
    "pluginFormats": {
      "vst3": {
        "scan": true,
        "host": true,
        "exampleHost": true,
        "notes": "VST3 SDK host worker is available for installed audio-effect bundles."
      },
      "au": {
        "scan": true,
        "host": true,
        "exampleHost": true,
        "notes": "Audio Unit scanner and CoreAudio host worker are available."
      },
      "lv2": {
        "scan": true,
        "host": false,
        "exampleHost": true,
        "notes": "LV2 scanner and SoundBridge example worker are active; LV2 binary hosting adapter is not linked yet."
      }
    },
    "security": {
      "originAllowlist": false,
      "sessionBoundToConnection": true,
      "sessionBoundToOrigin": true,
      "instanceOwnership": true,
      "cleanupOnDisconnect": true,
      "maxInstancesPerSession": 8,
      "maxTotalInstances": 32
    },
    "nativeExampleRenderer": true
  }
}
```

`host` means the daemon can instantiate installed binary plugins for that format. `exampleHost` means the daemon can run SoundBridge's repo-local example bundles for that format through the same browser protocol path; it must not be treated as proof that arbitrary installed VST3, Audio Unit, or LV2 binaries can be hosted. `notes` is optional human-readable status text from the native backend.

`capabilities.security` describes local multi-host protections and is safe to expose before pairing. Production hosts should require `sessionBoundToOrigin` and `instanceOwnership` before exposing installed plugins to arbitrary web origins.

### `pair`

Request:

```json
{
  "origin": "http://127.0.0.1:5173",
  "pairingToken": "token-printed-by-daemon"
}
```

Response:

```json
{
  "sessionToken": "short-lived-token",
  "expiresAt": 1781126400000
}
```

The native daemon should show a confirmation prompt for unknown origins. The development daemon requires the WebSocket `Origin` header, prints an ephemeral pairing token at startup, binds the resulting session to the WebSocket connection and Origin header that paired it, and destroys session-owned plugin instances when that connection closes.

### `scanPlugins`

Starts or refreshes plugin scanning and returns a summary. Native scanners should avoid exposing filesystem paths to the browser unless the user enables diagnostics.

Optional request:

```json
{
  "formats": ["vst3", "au", "lv2"],
  "includeDiagnostics": false
}
```

### `listPlugins`

Returns plugin metadata:

```json
{
  "plugins": [
    {
      "pluginId": "mock.gain",
      "format": "mock",
      "name": "Mock Gain",
      "vendor": "SoundBridge",
      "category": "Fx|Gain",
      "kind": "effect",
      "hostable": true,
      "inputs": 2,
      "outputs": 2,
      "parameters": []
    }
  ]
}
```

`format` is required and is one of `vst3`, `au`, `lv2`, `mock`, or `unknown`. `pluginId` must be stable within that format namespace; native daemons should prefix or otherwise scope ids so a VST3 and AU from the same vendor do not collide.

`hostable` defaults to `true` when omitted. A scanned installed plugin with `hostable: false` should be shown as discovery-only by browser hosts; `createInstance` must reject it until the matching native binary host adapter is available. `hostUnavailableReason` is display text for that state and must not include private filesystem paths.

Plugin instances are owned by the session that creates them. Commands that reference `instanceId` must fail with `instance_access_denied` when another session attempts to control the instance.

### `createInstance`

Creates one plugin instance for a sample rate, max block size, and channel layout. `pluginId` is required; `format` is optional when the id is globally unique but recommended for hosts that cache plugin descriptors.

Example:

```json
{
  "pluginId": "vst3:Example.vst3",
  "format": "vst3",
  "sampleRate": 48000,
  "maxBlockSize": 128,
  "inputChannels": 2,
  "outputChannels": 2
}
```

Numeric fields are bounded and out-of-range values are rejected with `invalid_argument`: `sampleRate` 8000–384000 Hz, `maxBlockSize` 1–8192, `inputChannels` 0–32, `outputChannels` 1–32. See [Security → Resource Limits And Input Validation](security.md#resource-limits-and-input-validation).

### `destroyInstance`

Releases an instance.

### `getParameters`

Returns parameter metadata and current normalized values. All automatable parameter values are normalized to `0..1`; display mapping is metadata.

### `setParameter`

Sets one normalized parameter value. The daemon applies sample-accurate automation later; the MVP applies values before the next block.

### `getState` / `setState`

State is opaque base64. Hosts store it without interpreting it.

### `processAudioBlock`

MVP request:

```json
{
  "instanceId": "inst-1",
  "blockId": 42,
  "sampleRate": 48000,
  "channels": [
    [0.0, 0.1],
    [0.0, 0.1]
  ],
  "timestamp": 1781126400000
}
```

MVP response:

```json
{
  "blockId": 42,
  "channels": [
    [0.0, 0.08],
    [0.0, 0.08]
  ],
  "latencySamples": 0,
  "renderEngine": "bundle-worker"
}
```

`renderEngine` is optional diagnostics for example instruments. Current values are `bundle-worker`, `bundle-executable`, `native-example`, or `js-fallback`. JSON arrays are intentionally only for the mock daemon and early validation. Production transports should use binary Float32 frames or shared memory.

Block size is bounded: the daemon clamps the frame count to the instance's `maxBlockSize`, accepts at most 32 channels, and clamps `sampleRate` to 8000–384000 Hz. Native host workers re-clamp these values before allocating.

### `sendMidiEvents`

Sends MIDI-like events to an instrument or MIDI effect instance. The MVP supports note events for example instruments; production hosts should preserve event timestamps and support sample-accurate scheduling.

Request:

```json
{
  "instanceId": "inst-2",
  "events": [
    {
      "type": "noteOn",
      "note": 60,
      "velocity": 0.8,
      "channel": 0
    },
    {
      "type": "noteOff",
      "note": 60,
      "velocity": 0,
      "channel": 0
    }
  ]
}
```

Response:

```json
{
  "accepted": true,
  "eventCount": 2
}
```

### `getLatency`

Reports plugin latency and bridge buffering:

```json
{
  "pluginLatencySamples": 0,
  "transportLatencySamples": 256,
  "reportedLatencySamples": 256
}
```

### `openEditor` / `closeEditor`

Reserved. Native editor streaming is out of scope for the MVP. Generic parameter UI is the fallback.

### `heartbeat`

Measures liveness and rough round-trip time.

## Versioning

Every daemon reports a semantic `protocolVersion`. Backward-compatible additions add optional fields. Breaking changes increment the major version and must negotiate capabilities in `hello`.
