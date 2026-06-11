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

Parameter metadata is plugin-controlled and must be bounded before it reaches a host UI. The reference daemon caps native parameters to 1024 items per instance, parameter ids to 64 bytes, parameter names to 160 bytes, and units to 64 bytes. Native VST3 parameters are enumerated from the plugin edit controller after instance creation; native AU parameters are enumerated from CoreAudio parameter metadata.

### `setParameter`

Sets one normalized parameter value. Values outside `0..1` are rejected. For installed VST3 plugins, the reference daemon updates the edit controller and queues a processor-side `IParameterChanges` point for the next render block. For installed Audio Units, the reference daemon maps normalized values onto the CoreAudio parameter range and calls `AudioUnitSetParameter`. Broader sample-accurate automation curves are still future work.

### `getState` / `setState`

State is opaque base64. Hosts store it without interpreting it.

The reference daemon wraps state in a bounded base64 JSON envelope that records the producing `pluginId`, `format`, normalized parameter snapshot, and, for installed VST3/AU instances, a `nativeState` payload. `setState` rejects state produced by a different plugin id. Native state is bounded before it is returned to the host or restored into a worker.

Installed VST3 state stores the component and edit-controller state streams. Installed Audio Unit state stores the CoreAudio `kAudioUnitProperty_ClassInfo` property list. Hosts should treat both as opaque bytes.

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
  "tailSamples": 0,
  "infiniteTail": false,
  "renderEngine": "bundle-worker"
}
```

`renderEngine` is optional diagnostics for example instruments. Current values are `bundle-worker`, `bundle-executable`, `native-example`, or `js-fallback`. JSON arrays are intentionally only for the mock daemon and early validation. Production transports should use binary Float32 frames or shared memory.

Block size is bounded: the daemon clamps the frame count to the instance's `maxBlockSize`, accepts at most 32 channels, and clamps `sampleRate` to 8000–384000 Hz. Native host workers re-clamp these values before allocating.

### `sendMidiEvents`

Sends MIDI-like events to an instrument, MIDI effect, or native plugin worker that accepts MIDI. The MVP supports bounded note events for example instruments and installed VST3 workers; production hosts should preserve event timestamps and support sample-accurate scheduling.

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

`events` is bounded to 4096 items per request. Supported MVP event types are `noteOn` and `noteOff`; `note` is `0..127`, `velocity` is `0..1`, `channel` is `0..15`, and `time` is an integer sample offset into the next render block. Daemons must reject malformed or out-of-range MIDI events before dispatching them to a native worker.

Response:

```json
{
  "accepted": true,
  "eventCount": 2
}
```

### `getLatency`

Reports plugin latency and bridge buffering. Installed VST3 workers read `IAudioProcessor::getLatencySamples()`;
installed Audio Unit workers read `kAudioUnitProperty_Latency` and convert seconds to samples at the
instance sample rate. Daemons must clamp plugin latency and any caller-provided
`transportLatencySamples` to `0..1048576` before hosts use the value for scheduling.

```json
{
  "pluginLatencySamples": 0,
  "transportLatencySamples": 256,
  "reportedLatencySamples": 256
}
```

### `getTailTime`

Reports how long a plugin may continue producing output after input stops. Installed VST3 workers read
`IAudioProcessor::getTailSamples()`, preserving the VST3 infinite-tail signal as `infiniteTail: true`.
Installed Audio Unit workers read `kAudioUnitProperty_TailTime` and convert seconds to samples at the
instance sample rate. Daemons must clamp reported tail samples to `0..1048576`.

```json
{
  "tailSamples": 0,
  "infiniteTail": false
}
```

### `openEditor` / `closeEditor`

Reserved. Native editor streaming is out of scope for the MVP. Generic parameter UI is the fallback.

### `heartbeat`

Measures liveness and rough round-trip time.

## Versioning

Every daemon reports a semantic `protocolVersion`. Backward-compatible additions add optional fields. Breaking changes increment the major version and must negotiate capabilities in `hello`.
