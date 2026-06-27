# Web DAW Integration

SoundBridge should feel like an AudioNode plus a plugin-management API.

## Minimal Host Flow

1. Create `AudioContext`.
2. Create `SoundBridgeClient` with `ws://127.0.0.1:47370/bridge`.
3. Call `connect()`, `hello()`, and `pair()`.
4. Call `scanPlugins()` or `listPlugins()`.
5. Create a plugin instance with the current sample rate and block size.
6. Create `SoundBridgeAudioNode`.
7. Connect source nodes into the bridge node and connect the bridge node to the destination.
8. For instruments, send notes or MIDI clips through `sendMidiEvents()`; for VST3 note expression, include explicit bounded `noteId` values.
9. Apply bounded listed presets with `setPreset()` when the selected plugin exposes preset metadata.
10. Check the plugin's `editorKinds`, then open a bounded generic parameter editor with `openEditor()` or a configured native editor broker when both the plugin and daemon advertise it.
11. Close editor sessions with `closeEditor()` when the UI tab or panel is done.
12. Store `getState()` output in the DAW project.
13. Restore using `setState()` when reopening the project.

## WebAudioModules Compatibility

The first compatibility target is an adapter that exposes:

- descriptor metadata from `listPlugins()`
- format-aware plugin identity for VST3, AU, LV2, and mock plugins
- an AudioNode-like instance backed by `SoundBridgeAudioNode`
- normalized parameter automation
- bounded preset snapshot application
- opaque state serialization
- generic parameter UI fallback

The adapter should not require hosts to adopt SoundBridge-specific UI primitives.

## Host Responsibilities

Hosts should:

- clearly show when audio is being routed through a local daemon
- use `createInstance().layout` or `getLayout()` when sizing host nodes and meters
- store opaque plugin state without editing it
- account for `getLatency()` in timeline scheduling and monitoring UI
- send bounded `processAudioBlock.transport` context when the host knows play state, sample position, tempo, time signature, or loop range
- check each plugin's `editorKinds` before showing editor actions; native editor buttons should require both `editorKinds: ["native-window"]` and `hello.capabilities.nativeEditor`, and hosts should honor `hello.capabilities.security.nativeEditorFileDialogs` / `nativeEditorClipboard` / `nativeEditorDragAndDrop` before surfacing those UI affordances
- apply only daemon-listed preset ids and pass native-approved preset/sample/cache/license files through opaque session-owned file grants attached to the owning plugin instance; check each plugin's `fileGrantOperations` before showing file-backed actions, use `useFileGrant restoreState` / `loadPreset` / `saveStateDirectory` for advertised worker-native preset/state files, and avoid arbitrary filesystem access for remaining file workflows
- degrade gracefully when the daemon disconnects

## DJ And Live Performance Effects

For a DJ app or live-performance tool, treat SoundBridge as an out-of-process effects rack rather than as a UI-first plugin panel. The host should own deck routing, metering, beat/grid timing, wet/dry controls, bypass, and emergency failover. SoundBridge should own plugin scanning, instance lifecycle, bounded parameter/state/preset operations, and native worker crash containment.

The web client exports `SoundBridgeLiveEffectRack` as a small host-side pattern for this mode:

- create one rack per deck, bus, send, or master insert
- process stereo main-bus blocks through binary `processBlock()` by default when the plugin is healthy
- return dry audio immediately when the rack is manually bypassed
- optionally fade the first samples of wet/dry transitions to reduce bypass clicks
- return dry audio for timestamped input that is already older than the host's configured live window
- return dry audio instead of queuing new work when the rack's in-flight block limit is full
- fail dry on a bounded `processBlock()` timeout when the host configures one
- return dry audio and mark the rack unhealthy when `processAudioBlock` fails
- count render-budget misses and fail closed to dry audio after a bounded consecutive miss threshold
- optionally recover from render-pressure trips after a bounded number of dry cooldown blocks
- call `recreate()` only from a non-audio-control path after the UI/user decides to retry the plugin

This is the right policy for live sets: a stale, slow, failed, backed-up, or repeatedly over-budget effect should become a dry bypass, not silence and not an app crash. `transitionFadeSamples` defaults to `0`; live hosts can set a small bounded value to smooth wet/dry edge changes when bypass, stale input, backpressure, timeout, or render-pressure recovery changes the rack's output path. `maxInputAgeMs` defaults to `0`; live hosts can set it when they pass `performance.now()`-style input timestamps to avoid spending native processing on blocks that already missed the host's live window. `maxInFlightBlocks` defaults to `1` so live rack callers cannot accidentally queue an unbounded backlog behind a slow plugin. `processTimeoutMs` defaults to `0` so compatibility hosts can keep normal request-timeout behavior; live hosts can set a small bounded timeout from their block size and monitoring latency policy, and positive values also bound the matching audio request so native in-flight capacity does not outlive the rack's deadline. `maxConsecutiveRenderBudgetMisses` defaults to `3`, can be set to `0` to observe without failing closed, and is capped to keep host policy bounded. `renderBudgetRecoveryBlocks` defaults to `0`; hosts can opt into automatic retry after that many dry blocks for transient CPU spikes, while processing errors and process timeouts still require `recreate()`. Binary frames, direct worklet-to-worker audio ports, `SharedArrayBuffer` rings where browser isolation allows them, atomic worker wakeups where supported, bounded shared-path in-flight requests, newest-input and newest-output overwrite under shared ring pressure, recycled worklet buffers plus transport-worker shared-input buffers, measured native render duration, per-block render-budget verdicts, measured response deadline lead/jitter, and bounded adaptive output latency reduce page-thread serialization work and smooth short jitter bursts. The worklet can also raise latency before dropouts when responses repeatedly arrive below its configured deadline-lead target, then recover toward the host's minimum latency after the configured on-time window. Production DJ use still needs deeper shared-memory tuning, latency calibration, and host scheduling policy.

## Current Prototype Limitations

- Main-bus and bus-indexed audio blocks use binary WebSocket frames in the reference web client. The demo opts into worker-owned WebSocket transport with a direct `AudioWorklet` audio port and `SharedArrayBuffer` rings when cross-origin isolation is available. The shared path wakes the transport worker with `Atomics.waitAsync`/`notify` where supported and reports whether the shared path is using atomic or timer wakeups. The worklet reports native render duration, render-budget misses, response deadline lead, and jitter in both render blocks and samples, so hosts can tell plugin-side render pressure from transport timing. The fallback port path bounds in-flight posts at the worklet edge, and `audioRequestTimeoutMs` bounds how long worker-owned and page-fallback audio requests can hold native in-flight capacity without a response. Recycled input buffers after worker send, transferred binary output buffers without an extra clone, bounded adaptive latency changes, and transport latency samples keep the path observable. JSON audio blocks remain the compatibility path for hosts that opt out of binary transport.
- Parameter automation supports bounded event lists, bounded per-block step/linear curves with sample offsets, and stored absolute-sample timeline lanes applied from `processAudioBlock.transport.samplePosition`.
- Editor support currently means bounded generic parameter editor sessions plus an opt-in native editor broker contract; platform-specific native plugin windows remain future broker implementation work.
- The mock plugin is a gain effect.
- The demo uses a `MessagePort` queue between main thread and AudioWorklet for compatibility.
- Installed VST3 audio effects can instantiate, render, expose path-free scanner metadata, expose parameters, expose bounded SDK unit metadata, expose bounded plugin-level and parameter-attached program-list metadata, export and restore bounded opaque SDK program data for daemon-listed programs when supported, expose bounded note-expression metadata, apply bounded listed preset snapshots, load bounded worker-native preset-state snapshots through file grants, set parameters, accept bounded MIDI note/poly-pressure events, mapped MIDI controllers, and value/text note-expression events, accept bounded host transport context, report bounded per-bus layout metadata, negotiate bounded per-bus SDK speaker arrangements with main-bus fallback, process explicit bus-indexed input buffers, return bus-indexed output buffers, report bounded plugin latency and tail time, and save/restore opaque state when the Steinberg SDK worker is linked. Realtime-compatible installed Audio Units can do the same through the CoreAudio worker, including path-free AudioComponent identifiers, bounded host transport callbacks, bounded short MIDI messages where the unit supports them, active CoreAudio input-element routing from explicit bus-indexed buffers, active CoreAudio output-element rendering into explicit bus-indexed buffers, and explicit realtime format-converter, multi-source merger, and multi-output splitter profile metadata for supported Apple utility units; AU offline effects and incompatible utility profiles remain discovery-only or roadmap items for now. Compatible installed LV2 audio/control effects can instantiate, render, expose path-free LV2 URI and block-size profile metadata, expose TTL-derived control ports as parameters, apply bounded listed preset snapshots, load bounded worker-native preset-state snapshots through file grants, set parameters, save/restore bounded control-port state, portable POD extension state, and brokered file-backed state, deliver bounded atom MIDI and LV2 atom `time:Position` transport to compatible input ports, expose bounded `buf-size:boundedBlockLength`, `fixedBlockLength`, `powerOf2BlockLength`, and `options#options` host data, run bounded synchronous LV2 worker jobs for plugins that expose `work:interface`, report bounded standard LV2 latency output ports, report bounded LV2 `pg:group` main buses with aggregate/per-audio-port fallback for ungrouped metadata, route explicit bus-indexed input buffers, return bus-indexed output buffers, and report conservative tail metadata through the basic LV2 worker.
- The website-playable VST3/AU/LV2 instruments are repo-local example bundles rendered by the native example renderer; LV2 UI declaration metadata is path-free scanner data, and grant-backed worker-native preset/state load/restore/save works through `useFileGrant`. LV2 UI hosting, platform-native plugin UI, advanced LV2 extension profiles, and vendor-specific sample/cache/license file handlers remain security-sensitive native milestones.
