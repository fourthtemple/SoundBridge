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
9. Render generic parameter controls or bind host automation to `setParameter()` / `setParameterEvents()`.
10. Store `getState()` output in the DAW project.
11. Restore using `setState()` when reopening the project.

## WebAudioModules Compatibility

The first compatibility target is an adapter that exposes:

- descriptor metadata from `listPlugins()`
- format-aware plugin identity for VST3, AU, LV2, and mock plugins
- an AudioNode-like instance backed by `SoundBridgeAudioNode`
- normalized parameter automation
- opaque state serialization
- generic parameter UI fallback

The adapter should not require hosts to adopt SoundBridge-specific UI primitives.

## Host Responsibilities

Hosts should:

- clearly show when audio is being routed through a local daemon
- use `createInstance().layout` or `getLayout()` when sizing host nodes and meters
- store opaque plugin state without editing it
- account for `getLatency()` in timeline scheduling and monitoring UI
- degrade gracefully when the daemon disconnects
- avoid real-time assumptions until the transport reports stable timing

## Current Prototype Limitations

- JSON audio blocks are for correctness testing, not final latency.
- Parameter automation supports bounded event lists with sample offsets; continuous curve interpolation and high-density automation lanes are still future work.
- The mock plugin is a gain effect.
- The demo uses a `MessagePort` queue between main thread and AudioWorklet for compatibility.
- Installed VST3 audio effects can instantiate, render, expose parameters, set parameters, accept bounded MIDI note/poly-pressure events and mapped MIDI controllers, report bounded per-bus layout metadata, process explicit bus-indexed input buffers, return bus-indexed output buffers, report bounded plugin latency and tail time, and save/restore opaque state when the Steinberg SDK worker is linked. Installed Audio Units can do the same through the CoreAudio worker, including bounded short MIDI messages where the unit supports them, while currently routing the main audio bus. Compatible installed LV2 audio/control effects can instantiate, render, expose TTL-derived control ports as parameters, set parameters, save/restore bounded control-port state, report conservative per-bus layout metadata, validate bounded MIDI batches, and report conservative latency/tail metadata through the basic LV2 worker.
- The website-playable VST3/AU/LV2 instruments are repo-local example bundles rendered by the native example renderer; automation curve interpolation, LV2 atom MIDI/extension-state/worker/UI extensions, advanced bus negotiation, plugin UI, and brokered filesystem access are still security-sensitive native milestones.
