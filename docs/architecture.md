# Architecture

SoundBridge splits browser audio hosting from native plugin hosting. The browser never loads VST3, Audio Unit, or LV2 code. It captures or generates Web Audio blocks, moves them to an `AudioWorklet`, and exchanges audio/control messages with a local daemon that owns native plugin discovery, instantiation, DSP, state, latency/tail reporting, root-limited file grants, and crash containment.

## Components

### Browser SDK

The SDK is a small TypeScript package that gives Web DAWs:

- a `SoundBridgeClient` for pairing, scanning, plugin instantiation, parameter changes, state, latency, tail time, editor sessions, opaque file grants, and grant-backed worker operations
- a `SoundBridgeAudioNode` wrapper around `AudioWorkletNode`
- bounded generic parameter editor sessions for hosts that do not have their own plugin UI
- protocol message types shared with daemon implementations
- format-aware plugin metadata for VST3, AU, LV2, and mock/test plugins

The `AudioWorkletProcessor` never blocks. It copies input blocks into a queue, posts them to the main thread, and consumes returned processed blocks when available. If the queue underruns, it falls back to dry audio for the block and reports underrun stats. A production build should move the socket work into a dedicated worker and use `SharedArrayBuffer` ring buffers when cross-origin isolation is available.

### Local Bridge Daemon

The daemon listens on loopback only. It provides:

- plugin scanning for VST3, Audio Unit, and LV2 search paths
- bounded path-free public plugin metadata for host catalogs
- pairing and origin allowlisting
- plugin instance lifecycle
- parameter metadata and normalized values
- audio block processing
- opaque state save/restore
- latency, tail-time, and error reporting

The development daemon in this repository implements the protocol with a stereo gain effect, example bundle instruments, and native worker handoff for installed VST3, AU, and compatible LV2 audio/control plugins. It also owns root-limited file grants and resolves attached grants for compatible native workers through operation-specific IPC instead of exposing paths to browser hosts. The reference native workers implement grant-backed preset-state load and restore/save for bounded worker-native state files; other file operations remain explicit adapter work. That lets Web DAWs integrate the browser transport while the production daemon is still taking shape.

### Native Plugin Hosts

The macOS-first native daemon is C++17 today. C++ is the conservative choice because the VST3 SDK, JUCE, Audio Unit APIs, LV2 hosting stacks, real-time thread rules, and plugin crash isolation patterns are best supported there. The current skeleton performs real bundle discovery for VST3, AU, and LV2, then isolates DSP hosting behind per-format worker adapters.

Format support is intentionally split:

| Format | Scanner | Hosting Path | Notes |
| --- | --- | --- | --- |
| VST3 | Active macOS bundle scanner with plist metadata and brokered SDK factory class metadata | Steinberg VST3 SDK adapter | First real DSP target. Public scanner metadata is path-free, and factory probes refine bounded kind/category metadata without exposing local paths to browser hosts. Parameters can expose bounded SDK unit metadata, plugin-level and parameter-attached program-list metadata is capped, supported daemon-listed program data can be exported and restored as opaque capped base64, note-expression metadata plus value/text events are capped, bounded worker-native preset-state files load through grants, and bounded host transport context maps to SDK `ProcessContext`. Keep SDK optional and review licensing before vendoring. |
| AU | Active macOS `.component` scanner plus AudioComponent registry metadata | Active CoreAudio AudioComponent worker with bounded input/output element routing | macOS-only. Runs installed AU binaries in a separate worker process, exposes path-free AudioComponent identifiers, and maps bounded host transport context through CoreAudio host callbacks. |
| LV2 | Active `.lv2` bundle scanner with bounded TTL parsing | Basic LV2 C-ABI audio/control worker with discrete control metadata, bounded `buf-size` / options data, atom MIDI, atom `time:Position`, synchronous `work:schedule`, `pg:group` main-bus routing with aggregate/per-port fallback, worker-native preset-state loading, portable POD state, and brokered file-backed state | Important for open-source plugin ecosystems. Public LV2 URI and UI declaration metadata is path-free. UI hosting and fuller extension support remain future work; keep GPL components out of the core. |

The native daemon also exposes repo-local VST3/AU/LV2 example bundles through `--scan-examples`. The native build installs a small Mach-O helper into each example instrument bundle, and the browser demo daemon launches a long-lived worker from that bundle executable per plugin instance. Note events are sent into that worker, and render calls advance worker-owned oscillator state across audio blocks. This means the website exercises scanned AU/VST/LV2 example bundle metadata plus native C++ example DSP over a worker-process boundary. Installed Audio Units use a real CoreAudio worker today, including bounded host transport callbacks and bounded input/output element routing. Installed VST3 audio effects use a Steinberg SDK worker when the SDK is available at build time, including bounded process transport context, bounded program-data export/restore for supported daemon-listed programs, and bounded note-expression metadata plus value/text events. Compatible LV2 audio/control effects use the built-in LV2 C-ABI worker, including bounded atom `time:Position` transport for ports that advertise it, bounded synchronous `work:schedule` callbacks for plugins that expose `work:interface`, and bounded `pg:group` main-bus routing with aggregate/per-audio-port fallback for older metadata. A small repo-local LV2 gain dynamic library exists as a native worker regression fixture.

The intended production topology is:

```mermaid
flowchart LR
  WebDAW["Web DAW"] --> Worklet["AudioWorklet"]
  Worklet --> SDK["SoundBridge SDK"]
  SDK --> WS["Local WebSocket"]
  WS --> Daemon["Bridge Daemon"]
  Daemon --> Worker["Plugin Worker Process"]
  Worker --> Plugin["VST3/AU/LV2 Plugin"]
```

The worker process boundary is important. A bad plugin should be able to kill its own worker without taking down the daemon, browser, or other plugin instances.

The core architectural target is a compatibility worker boundary, not a universal sandbox-first runtime. Many real plugins expect the same normal user environment they see in desktop DAWs, including license files, caches, sample libraries, helper services, and vendor authorization state. SoundBridge's boundary is that browser and desktop hosts talk to the bounded protocol, while plugin code stays in worker processes behind pairing, ownership checks, resource limits, and brokered file workflows.

An operating-system sandbox around third-party plugin workers is still a real extended security profile. It should be added after core host behavior is understood well enough to avoid accidentally breaking normal plugins, and it should be advertised separately for deployments that prefer stricter containment over maximum plugin compatibility.

## Source Size Fitness

`npm run check` includes `scripts/check-file-sizes.mjs`. Source, schema, config, and documentation files must stay below 800 lines (799 lines maximum), and files at or above 750 lines must either be split or receive an explicit reviewed near-limit budget that cannot grow. The current tree has no reviewed near-limit exceptions, so new host features should extract focused modules instead of quietly extending already-large files.

When adding behavior near that limit, prefer extracting a focused scanner, parser, bus router, state adapter, or smoke helper before adding more logic. This keeps security-sensitive code reviewable and makes future sandboxing boundaries easier to see.

## Language And Framework Choices

Browser:

- TypeScript for SDK and protocol types.
- Plain Web Audio and AudioWorklet APIs for maximum host compatibility.
- No framework dependency for the reference UI.
- WebSocket first because it works in Safari, Chrome, and Firefox and is easy for Web DAWs to adopt.

Native:

- C++17 for the daemon and native hosting layer.
- CMake for cross-platform build hygiene, even though macOS is first.
- Optional future JUCE adapter may speed up VST3/AU hosting and plugin editor work, but the core protocol should not require JUCE.
- LV2 should use a permissively compatible adapter path. Lilv and related libraries are common LV2 choices, but their licenses and transitive dependencies must be reviewed before becoming core dependencies.
- No GPL dependencies in the core. Carla can remain an optional backend experiment, not a required dependency.

Protocol:

- JSON request/response envelopes first for debuggability and schema stability.
- Audio blocks are JSON arrays in the mock daemon to keep the zero-dependency prototype simple.
- The protocol reserves a binary audio transport for later WebSocket binary frames, WebRTC data channels, shared memory, or a browser-native helper transport.

## Latency Tradeoffs

The MVP prioritizes correctness over ultra-low latency. WebSocket plus JSON audio blocks is not a final real-time transport. It is useful because it exposes:

- browser scheduling behavior
- AudioWorklet queue depth requirements
- daemon processing timing
- round-trip jitter
- browser-specific limitations, especially Safari

The production path should add:

- binary audio frames
- a dedicated browser worker for transport
- `SharedArrayBuffer` ring buffers where available
- adaptive buffering and latency compensation
- daemon-side plugin worker processes
- a transport abstraction that can support WebRTC data channels or shared-memory helpers later

## Safari Compatibility

Safari supports AudioWorklet in current versions, but the safest cross-browser design avoids relying on WebSocket directly inside the worklet. This prototype keeps socket ownership outside the worklet and communicates through `MessagePort`, which is less efficient but more compatible.
