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
8. For instruments, send notes or MIDI clips through `sendMidiEvents()`.
9. Apply bounded listed presets with `setPreset()` when the selected plugin exposes preset metadata.
10. Open a bounded generic parameter editor with `openEditor()` or bind host automation to `setParameter()`, `setParameterEvents()`, `setParameterCurve()`, or stored `setAutomationLane()` timeline lanes.
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
- apply only daemon-listed preset ids and keep arbitrary preset/sample file access behind future user-approved brokers
- degrade gracefully when the daemon disconnects

## Current Prototype Limitations

- JSON audio blocks are for correctness testing, not final latency.
- Parameter automation supports bounded event lists, bounded per-block step/linear curves with sample offsets, and stored absolute-sample timeline lanes applied from `processAudioBlock.transport.samplePosition`.
- Editor support currently means bounded generic parameter editor sessions; native plugin windows remain future UI-broker work.
- The mock plugin is a gain effect.
- The demo uses a `MessagePort` queue between main thread and AudioWorklet for compatibility.
- Installed VST3 audio effects can instantiate, render, expose path-free scanner metadata, expose parameters, expose bounded program-list metadata where the SDK ties program lists to program-change parameters, apply bounded listed preset snapshots, set parameters, accept bounded MIDI note/poly-pressure events and mapped MIDI controllers, accept bounded host transport context, report bounded per-bus layout metadata, negotiate bounded per-bus SDK speaker arrangements with main-bus fallback, process explicit bus-indexed input buffers, return bus-indexed output buffers, report bounded plugin latency and tail time, and save/restore opaque state when the Steinberg SDK worker is linked. Realtime-compatible installed Audio Units can do the same through the CoreAudio worker, including path-free AudioComponent identifiers, bounded host transport callbacks, bounded short MIDI messages where the unit supports them, active CoreAudio input-element routing from explicit bus-indexed buffers, and explicit bus-0 output buffers; AU multi-output, offline effects, and units requiring dedicated splitter or format-converter profiles are discovery-only or roadmap items for now. Compatible installed LV2 audio/control effects can instantiate, render, expose path-free LV2 URI metadata, expose TTL-derived control ports as parameters, apply bounded listed preset snapshots, set parameters, save/restore bounded control-port state, portable POD extension state, and brokered file-backed state, deliver bounded atom MIDI and LV2 atom `time:Position` transport to compatible input ports, report bounded standard LV2 latency output ports, report conservative per-bus layout metadata, consume and return explicit bus-0 buffers, and report conservative tail metadata through the basic LV2 worker.
- The website-playable VST3/AU/LV2 instruments are repo-local example bundles rendered by the native example renderer; LV2 worker/UI extensions, advanced bus negotiation, native plugin UI, and broader brokered filesystem access are still security-sensitive native milestones.
