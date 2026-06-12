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
        "host": true,
        "exampleHost": true,
        "notes": "Basic LV2 audio/control host worker is available with bounded atom MIDI, atom time-position transport, synchronous LV2 worker scheduling, LV2 port-group bus routing with per-port fallback, standard latency output-port reporting, and brokered portable/file-backed state delivery; LV2 UI extensions remain disabled."
      }
    },
    "security": {
      "originAllowlist": false,
      "sessionBoundToConnection": true,
      "sessionBoundToOrigin": true,
      "instanceOwnership": true,
      "cleanupOnDisconnect": true,
      "maxInstancesPerSession": 8,
      "maxTotalInstances": 32,
      "maxParameterEventsPerRequest": 4096,
      "maxAutomationCurvePoints": 256,
      "maxAutomationLanesPerInstance": 128,
      "maxAutomationLanePoints": 4096,
      "maxWorkerStdoutLineBytes": 16777216,
      "maxWorkerStderrLineBytes": 1048576,
      "maxWorkerStderrBytes": 4194304,
      "workerReadyTimeoutMs": 5000,
      "exampleWorkerCommandTimeoutMs": 1500,
      "nativeWorkerCommandTimeoutMs": 5000
    },
    "nativeExampleRenderer": true,
    "automation": true
  }
}
```

`host` means the daemon can instantiate installed binary plugins for that format. `exampleHost` means the daemon can run SoundBridge's repo-local example bundles for that format through the same browser protocol path; it must not be treated as proof that arbitrary installed VST3, Audio Unit, or LV2 binaries can be hosted. The reference LV2 host currently means compatible basic audio/control LV2 plugins with optional atom/event MIDI input ports, bounded portable POD `state:interface` properties, and brokered file-backed state through LV2 state path features, not every LV2 extension profile. `notes` is optional human-readable status text from the native backend.

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
      "metadata": {
        "stableId": "com.vendor.Plugin",
        "bundleIdentifier": "com.vendor.Plugin",
        "version": "1.0.0"
      },
      "parameters": []
    }
  ]
}
```

`format` is required and is one of `vst3`, `au`, `lv2`, `mock`, or `unknown`. `pluginId` must be stable within that format namespace; native daemons should prefix or otherwise scope ids so a VST3 and AU from the same vendor do not collide.

`metadata` is optional bounded public class metadata for host caching and plugin browsers. It must not contain local filesystem paths. Current fields include `stableId`, `bundleIdentifier`, `version`, AudioComponent `componentType` / `componentSubType` / `componentManufacturer`, and `lv2Uri`. Installed VST3 plugin listings may also use a short-lived brokered factory probe to refine public `name`, `vendor`, `category`, and `kind` values from SDK class metadata without exposing the bundle path to the browser.

`presets` is optional bounded host-display metadata. Preset ids are capped at 64 bytes, names at 160 bytes, and the daemon exposes at most 256 presets per plugin. These presets are parameter snapshots; arbitrary preset files, sample locations, and licensing data require a separate brokered file-access path.

`hostable` defaults to `true` when omitted. A scanned installed plugin with `hostable: false` should be shown as discovery-only by browser hosts; `createInstance` must reject it until the matching native binary host adapter or compatible host profile is available. For LV2, unsupported `lv2:requiredFeature` declarations are a reason to keep a bundle discovery-only. For AU, offline effects and system units that require a dedicated format-converter, splitter, or offline-render profile should remain discovery-only until that profile is implemented. `hostUnavailableReason` is display text for that state and must not include private filesystem paths.

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

Response payloads include the negotiated layout. Hosts should prefer `layout.inputChannels` and `layout.outputChannels` over the original request when constructing audio nodes or allocating buffers:

```json
{
  "instanceId": "inst-1",
  "layout": {
    "requestedInputChannels": 2,
    "requestedOutputChannels": 2,
    "inputChannels": 2,
    "outputChannels": 2,
    "inputBuses": 1,
    "outputBuses": 1,
    "sampleRate": 48000,
    "maxBlockSize": 128
  },
  "latencySamples": 0,
  "tailSamples": 0,
  "infiniteTail": false
}
```

### `destroyInstance`

Releases an instance.

### `getParameters`

Returns parameter metadata and current normalized values. All automatable parameter values are normalized to `0..1`; display mapping is metadata.

Parameter metadata is plugin-controlled and must be bounded before it reaches a host UI. The reference daemon caps native parameters to 1024 items per instance, parameter ids to 64 bytes, parameter names to 160 bytes, and units to 64 bytes. Native VST3 parameters are enumerated from the plugin edit controller after instance creation; native AU parameters are enumerated from CoreAudio parameter metadata.

VST3 parameters flagged by the SDK as program-change parameters include `programChange: true`. When the parameter's unit can be associated with a VST3 program list, the worker may include a bounded `programList` with at most 256 named programs and normalized values suitable for `setParameter`. Hosts should treat this as plugin-provided metadata, not as permission to read or load arbitrary preset files.

Compatible LV2 control ports marked with `lv2:toggled`, `lv2:integer`, or `lv2:enumeration` expose bounded `stepCount` metadata. The reference LV2 worker caps reported step counts and quantizes normalized writes back to legal plain values before writing the plugin port.

### `getLayout`

Returns the negotiated channel and bus layout for an instance. `requestedInputChannels` and `requestedOutputChannels` record the bounded host request; `inputChannels` and `outputChannels` are the effective worker layout. All channel and bus counts are clamped to `0..32` for inputs and `1..32` for outputs before they reach the host.

`inputBusLayouts` and `outputBusLayouts` expose bounded per-bus metadata for routing UIs and sidechain/multi-output scheduling. Each bus has an `index`, `direction`, `mediaType`, display `name`, `type` (`main`, `aux`, or `unknown`), `channels`, and `active`. VST3 reports SDK bus info, including aux input buses that commonly represent sidechains, and attempts bounded per-bus speaker arrangement negotiation before falling back to main-bus negotiation for compatibility. AU reports active CoreAudio input elements where stream-format and render-callback setup succeeds, and active CoreAudio output elements where stream-format setup succeeds. LV2 honors bounded `pg:group`, `pg:mainInput`, and `pg:mainOutput` metadata for grouped main buses, then falls back to aggregate bus 0 plus bounded mono aux buses for parsed ungrouped LV2 audio ports. Mock workers report conservative main-bus layouts that match their render paths. AU units requiring offline, splitter, or multi-source converter profiles are marked discovery-only instead of being instantiated through this realtime path.

```json
{
  "requestedInputChannels": 2,
  "requestedOutputChannels": 2,
  "inputChannels": 2,
  "outputChannels": 2,
  "inputBuses": 1,
  "outputBuses": 1,
  "inputBusLayouts": [
    {
      "index": 0,
      "direction": "input",
      "mediaType": "audio",
      "name": "Main Input",
      "type": "main",
      "channels": 2,
      "active": true
    }
  ],
  "outputBusLayouts": [
    {
      "index": 0,
      "direction": "output",
      "mediaType": "audio",
      "name": "Main Output",
      "type": "main",
      "channels": 2,
      "active": true
    }
  ],
  "sampleRate": 48000,
  "maxBlockSize": 128
}
```

### `setParameter`

Sets one normalized parameter value. Values outside `0..1` are rejected. For installed VST3 plugins, the reference daemon updates the edit controller and queues a processor-side `IParameterChanges` point for the next render block. For installed Audio Units, the reference daemon maps normalized values onto the CoreAudio parameter range and calls `AudioUnitSetParameter`. For compatible LV2 audio/control plugins, the reference daemon maps normalized values onto bounded LV2 input control ports parsed from bundle TTL and rounds toggled/integer/enumeration controls to legal plain values.

Parameters marked `readOnly: true` are display-only. Conforming daemons must reject `setParameter` for those ids with `parameter_read_only` before dispatching to native workers.

### `setPreset`

Applies one daemon-listed preset snapshot to an existing instance.

```json
{
  "instanceId": "inst-2",
  "presetId": "gain-bright"
}
```

The browser sends only `presetId`; it does not send an arbitrary parameter map or file path. The daemon looks up the preset in the bounded metadata it already exposed for that plugin, enforces instance ownership, applies only matching known live parameters, and returns the updated parameter metadata:

```json
{
  "applied": true,
  "presetId": "gain-bright",
  "parameterCount": 1,
  "parameters": [
    {
      "id": "gain",
      "name": "Gain",
      "normalizedValue": 0.75,
      "defaultNormalizedValue": 0.5,
      "unit": "dB",
      "minPlain": -24,
      "maxPlain": 24,
      "plainValue": 12,
      "automatable": true
    }
  ]
}
```

`presetId` is capped at 64 bytes. Preset snapshots are capped to the same 1024 parameter-value ceiling used for parameter metadata, and every value is clamped to normalized `0..1` before the snapshot can be applied. If a listed snapshot contains parameters that the live worker does not expose, those entries are ignored rather than treated as new host commands. Read-only live parameters are skipped. Arbitrary preset files, sample folders, caches, and licensing data still require a separate user-approved file broker.

### `setParameterEvents`

Queues a bounded list of normalized parameter events for the next render block. `time` is an integer sample offset into the next block and is clamped by schema/daemon validation to the instance block size. The reference daemon rejects more than 4096 events per request, rejects parameter ids longer than 64 bytes, and enforces instance ownership before dispatching events to workers.

Automation requests must target writable automatable parameters. `readOnly: true` parameters are rejected with `parameter_read_only`, and `automatable: false` parameters are rejected with `parameter_not_automatable`.

```json
{
  "instanceId": "inst-2",
  "events": [
    {
      "parameterId": "gain",
      "normalizedValue": 0.25,
      "time": 0
    },
    {
      "parameterId": "gain",
      "normalizedValue": 0.75,
      "time": 64
    }
  ]
}
```

VST3 workers deliver queued values as `IParameterChanges` with sample offsets. Audio Unit workers pass the bounded offset to `AudioUnitSetParameter`. Basic LV2 audio/control workers apply control-port changes by splitting the render block at requested offsets.

### `setParameterCurve`

Expands a bounded step or linear automation curve for one parameter into a bounded list of per-block parameter events. `points` must contain strictly increasing sample offsets within the instance block size. The default curve cap is 256 points, and the daemon advertises the active cap as `hello.capabilities.security.maxAutomationCurvePoints`. Expanded curves are capped by the same 4096-event worker limit used by `setParameterEvents`.

```json
{
  "instanceId": "inst-2",
  "parameterId": "gain",
  "interpolation": "linear",
  "points": [
    { "time": 0, "normalizedValue": 0.1 },
    { "time": 64, "normalizedValue": 0.9 },
    { "time": 127, "normalizedValue": 0.25 }
  ]
}
```

This is per-render-block curve interpolation. For timeline automation that should persist across render calls, use `setAutomationLane`.

### `setAutomationLane` / `clearAutomationLane`

Stores or clears a bounded absolute-sample automation lane for one known writable parameter on one instance. Lanes are owned by the same paired session as the plugin instance and are destroyed with the instance or session.

```json
{
  "instanceId": "inst-2",
  "parameterId": "gain",
  "points": [
    { "samplePosition": 1536000, "normalizedValue": 0.1 },
    { "samplePosition": 1536064, "normalizedValue": 0.8 }
  ]
}
```

`points` must be strictly increasing by `samplePosition`. The reference daemon defaults to 128 lanes per instance and 4096 points per lane, advertised as `hello.capabilities.security.maxAutomationLanesPerInstance` and `maxAutomationLanePoints`. Values are normalized `0..1`; sample positions are integers in the same bounded range as `processAudioBlock.transport.samplePosition`.

During `processAudioBlock`, if the host supplies `transport.samplePosition`, the daemon dispatches only lane points that fall inside that render block as bounded parameter events with sample offsets. The combined lane-derived event count for one block is capped by `maxParameterEventsPerRequest`. If a host omits `transport.samplePosition`, stored lanes remain in memory but are not applied because the daemon cannot infer the host timeline.

`clearAutomationLane` takes `{ "instanceId": "inst-2", "parameterId": "gain" }` to clear one lane, or `{ "instanceId": "inst-2" }` to clear every lane owned by that instance.

### `getState` / `setState`

State is opaque base64. Hosts store it without interpreting it.

The reference daemon wraps state in a bounded base64 JSON envelope that records the producing `pluginId`, `format`, normalized parameter snapshot, and, for installed VST3/AU/LV2 instances that expose native worker state, a `nativeState` payload. `setState` rejects state produced by a different plugin id. Native state is bounded before it is returned to the host or restored into a worker.

For daemon-managed parameter snapshots, read-only live parameters are not restored from host-supplied state values. Native worker state remains opaque and format-specific.

Installed VST3 state stores the component and edit-controller state streams. Installed Audio Unit state stores the CoreAudio `kAudioUnitProperty_ClassInfo` property list. Compatible basic LV2 audio/control plugins store bounded control-port state keyed by LV2 port index and can also save/restore bounded portable POD `state:interface` properties. LV2 file-backed state is supported only through brokered `state:makePath`, `state:mapPath`, and `state:freePath` callbacks: paths must be relative, path text is bounded, symlinks and traversal are rejected, file bytes are capped, and the host stores the resulting files as opaque state payload data. Hosts should treat native state payloads as opaque bytes.

### `processAudioBlock`

Request:

```json
{
  "instanceId": "inst-1",
  "blockId": 42,
  "sampleRate": 48000,
  "channels": [
    [0.0, 0.1],
    [0.0, 0.1]
  ],
  "inputBuses": [
    {
      "index": 0,
      "channels": [
        [0.0, 0.1],
        [0.0, 0.1]
      ]
    },
    {
      "index": 1,
      "channels": [
        [0.2, 0.2],
        [0.2, 0.2]
      ]
    }
  ],
  "transport": {
    "playing": true,
    "tempo": 128,
    "timeSignatureNumerator": 4,
    "timeSignatureDenominator": 4,
    "projectTimeMusic": 32,
    "barPositionMusic": 32,
    "samplePosition": 1536000
  },
  "timestamp": 1781126400000
}
```

`channels` is the backwards-compatible main input bus. `inputBuses` is optional and carries explicit indexed input bus buffers for sidechain-style routing. When both are present, bus index `0` is the main input bus. Explicit `inputBuses` must be an array of at most 32 bus blocks with unique integer indexes in `0..31`; malformed, duplicate, non-integer, or out-of-range indexes are rejected at the daemon boundary and rechecked by native worker line-protocol parsers. All channel counts are capped to 32, and all frame counts are capped to the instance `maxBlockSize`. Installed VST3 workers negotiate bounded per-bus SDK speaker arrangements where accepted and route bounded indexed input buffers into active VST3 buses. Installed AU workers route bounded indexed input buffers into matching active CoreAudio input elements where the unit exposes them. Installed LV2 workers route bus index `0` into the declared main LV2 port group when `pg:group` metadata is present; ungrouped LV2 metadata keeps the compatibility fallback where bus index `0` is the aggregate main input and bus indexes `1..31` are bounded mono overrides for parsed audio input ports.

`transport` is optional bounded host timeline context. Supported fields are `playing`, `recording`, `loopActive`, `tempo`, `timeSignatureNumerator`, `timeSignatureDenominator`, `projectTimeMusic`, `barPositionMusic`, `cycleStartMusic`, `cycleEndMusic`, and `samplePosition`. Tempo is `1..960` BPM, time-signature denominators must be powers of two in `1..64`, musical positions are quarter-note values in `0..1000000000`, sample positions are integers in `0..9007199254740991`, and cycle start/end must be supplied together with `cycleEndMusic >= cycleStartMusic`. VST3 workers map accepted values into Steinberg `ProcessContext`; AU workers map accepted values into `AudioTimeStamp` sample time plus `kAudioUnitProperty_HostCallbacks`; LV2 workers map supported timeline values into bounded atom `time:Position` events for compatible atom/event input ports.

Compatible LV2 plugins that declare `work:schedule` and expose `work:interface` receive a bounded synchronous worker feature inside the LV2 worker process. The reference host caps worker message counts and byte sizes, copies all request/response bodies before delivery, never exposes browser-controlled pointers to plugin code, and calls `work_response` / `end_run` after `run()` returns. This is compatibility support for the LV2 worker extension, not an OS sandbox.

Stored automation lanes use `transport.samplePosition` to decide which absolute-sample points belong in the current render block. Lane points are expanded into the same bounded per-block parameter event path used by `setParameterEvents`.

Response:

```json
{
  "blockId": 42,
  "channels": [
    [0.0, 0.08],
    [0.0, 0.08]
  ],
  "outputBuses": [
    {
      "index": 0,
      "channels": [
        [0.0, 0.08],
        [0.0, 0.08]
      ]
    }
  ],
  "transport": {
    "playing": true,
    "tempo": 128,
    "timeSignatureNumerator": 4,
    "timeSignatureDenominator": 4,
    "projectTimeMusic": 32,
    "barPositionMusic": 32,
    "samplePosition": 1536000
  },
  "latencySamples": 0,
  "tailSamples": 0,
  "infiniteTail": false,
  "renderEngine": "bundle-worker"
}
```

`channels` is the backwards-compatible main output bus. `outputBuses` carries indexed output bus buffers and bus index `0` mirrors `channels`. The VST3 worker can route bounded indexed input buffers into active VST3 buses and return indexed output bus buffers. Installed AU workers can consume active indexed input buses and return active CoreAudio output elements as indexed output buses. Installed LV2 workers return output buses from the bounded bus map reported by `getLayout`: declared `pg:group` output buses where metadata exists, otherwise aggregate bus 0 plus bounded mono taps for parsed ungrouped LV2 audio output ports. Mock and example workers use the daemon-normalized bus-0 response.

`transport` is echoed only when the request supplied accepted bounded transport data. It is an acknowledgement of the host context delivered for that block, not plugin-generated timing.

`renderEngine` is optional diagnostics. Current values include `bundle-worker`, `bundle-executable`, `native-example`, `native-au`, `native-vst3`, `native-lv2`, and `js-fallback`. JSON arrays are intentionally only for the mock daemon and early validation. Production transports should use binary Float32 frames or shared memory/shared ring buffers for bus-indexed audio.

Block size is bounded: the daemon clamps the frame count to the instance's `maxBlockSize`, accepts at most 32 channels, and clamps `sampleRate` to 8000–384000 Hz. Native host workers re-clamp these values before allocating. Worker startup, command execution, and response lines are also bounded so a crashed or malicious worker cannot strand requests forever or force the daemon to buffer unlimited stdout.

### `sendMidiEvents`

Sends MIDI-like events to an instrument, MIDI effect, or native plugin worker that accepts MIDI. The reference daemon validates bounded note, control-change, pitch-bend, channel-pressure, poly-pressure, and program-change events before worker dispatch. VST3 workers deliver note and poly-pressure through `IEventList`; control-change, pitch-bend, and channel-pressure use VST3 `IMidiMapping` when the plugin exposes a parameter mapping. Audio Units receive short MIDI messages through `MusicDeviceMIDIEvent` where the CoreAudio unit supports them. Compatible LV2 atom/event MIDI input ports receive bounded MIDI events as LV2 atom sequences on the next render block; if an LV2 plugin has no compatible MIDI input port, the worker validates and acknowledges the bounded batch without delivery.

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
    },
    {
      "type": "controlChange",
      "controller": 1,
      "value": 0.5,
      "channel": 0,
      "time": 32
    },
    {
      "type": "pitchBend",
      "value": 0.1,
      "channel": 0,
      "time": 64
    }
  ]
}
```

`events` is bounded to 4096 items per request. Supported event types are `noteOn`, `noteOff`, `controlChange`, `pitchBend`, `channelPressure`, `polyPressure`, and `programChange`. `note`, `controller`, and `program` are `0..127`; `velocity`, `value` for control change, and `pressure` are `0..1`; pitch-bend `value` is `-1..1`; `channel` is `0..15`; and `time` is an integer sample offset into the next render block. Daemons must reject malformed or out-of-range MIDI events before dispatching them to a native worker.

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
instance sample rate. Compatible LV2 workers read standard control output ports marked with `lv2:reportsLatency` / `lv2:latency` after a zero-frame refresh run. Daemons must clamp plugin latency and any caller-provided
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

`openEditor` opens a bounded editor session for an existing plugin instance. The reference daemon supports `mode: "generic"` today and returns a `generic-parameters` editor that a web or desktop host can render using the bounded parameter metadata from the owning instance.

```json
{
  "instanceId": "inst-2",
  "mode": "generic"
}
```

The response includes an `editorId`, the owning `instanceId`, `expiresAt`, a path-free plugin snapshot, current parameter metadata, and editor capabilities. Generic editor sessions are owned by the same paired session as the plugin instance, are capped per session and globally, expire automatically, and close when the instance or WebSocket session is destroyed.

`closeEditor` takes `{ "editorId": "editor-..." }` and requires the same session that opened the editor. Native plugin editor windows remain disabled until they can run in a separate UI worker or broker process with explicit handling for windows, focus, clipboard, drag/drop, file dialogs, and ownership.

### `heartbeat`

Measures liveness and rough round-trip time.

## Versioning

Every daemon reports a semantic `protocolVersion`. Backward-compatible additions add optional fields. Breaking changes increment the major version and must negotiate capabilities in `hello`.
