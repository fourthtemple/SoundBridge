# SoundBridge Native Bridge Daemon

This is the macOS-first native daemon skeleton. It currently builds command-line scanners for VST3, Audio Unit, and LV2 plugins, plus worker-process hosting for Audio Unit, SDK-backed VST3 audio effects, and basic LV2 audio/control effects.

VST3:

- `/Library/Audio/Plug-Ins/VST3`
- `~/Library/Audio/Plug-Ins/VST3`

Audio Unit:

- `/Library/Audio/Plug-Ins/Components`
- `~/Library/Audio/Plug-Ins/Components`
- macOS AudioComponent registry entries for installed and built-in Audio Units

LV2:

- `/Library/Audio/Plug-Ins/LV2`
- `~/Library/Audio/Plug-Ins/LV2`
- `~/.lv2`
- `/opt/homebrew/lib/lv2`
- `/usr/local/lib/lv2`
- `/usr/lib/lv2`

It deliberately does not vendor Steinberg's VST3 SDK or require an external LV2 stack. Audio Unit hosting is implemented through the macOS CoreAudio APIs. VST3 hosting is enabled when `SOUNDBRIDGE_VST3_SDK_PATH` points at a Steinberg SDK checkout or the local development SDK path is present, including bounded note-expression metadata plus value/text event delivery where plugins expose it. LV2 hosting uses the stable LV2 C ABI directly for bundle-local dynamic libraries with basic audio/control ports, bounded integer/toggle/enumeration control metadata, bounded atom MIDI delivery, atom time-position transport, bounded fixed/power-of-two block-size profiles, bounded synchronous LV2 `work:schedule`, bounded standard latency output-port reporting, bounded portable POD `state:interface` save/restore, brokered file-backed state, and worker-native preset-state loading through file grants; UI and other advanced LV2 extensions remain future work.

## Build

```sh
cmake -S native/bridge-daemon -B native/bridge-daemon/build
cmake --build native/bridge-daemon/build
native/bridge-daemon/build/soundbridge-daemon --scan
```

Focused scans:

```sh
native/bridge-daemon/build/soundbridge-daemon --scan-vst3
native/bridge-daemon/build/soundbridge-daemon --scan-au
native/bridge-daemon/build/soundbridge-daemon --scan-lv2
native/bridge-daemon/build/soundbridge-daemon --scan-examples
native/bridge-daemon/build/soundbridge-daemon --scan-installed
native/bridge-daemon/build/soundbridge-daemon --host-status
```

`--scan-vst3` discovers VST3 bundles and reads macOS `Info.plist` metadata when present, including display name, bundle identifier, version, and vendor hints. Public scanner metadata is path-free; bundle and executable paths stay in diagnostics for the daemon's internal worker launch path. Scanning remains lightweight; binary loading happens in the separate `--host-vst3-worker` process.

`--scan-au` combines `.component` bundle discovery with the macOS AudioComponent registry. Bundle hits are enriched with path-free public AudioComponent metadata when the component names match; registry-only built-in Audio Units are returned with `diagnostics.isRegistry: true` and no bundle path.

`--scan-lv2` discovers `.lv2` bundles, reads bounded Turtle metadata, verifies bundle-local `lv2:binary` paths, exposes path-free public LV2 URI and block-size profile metadata, counts basic audio ports when present, and flags unsupported `lv2:requiredFeature` and `opts:requiredOption` declarations. Scanned plugins that do not match the basic audio/control worker profile remain discovery-only in the browser daemon.

`--host-au-worker` runs the native Audio Unit host worker used by the browser daemon. It instantiates one AudioComponent, accepts newline-delimited `parameters`, `setParameter`, `setParameterDisplayValue`, `getState`, `setState`, `latency`, `tail`, `layout`, `midi`, `noteOn`, `noteOff`, `render`, and `quit` commands, and renders JSON float audio blocks back to the daemon process. Bounded parameter metadata is read from CoreAudio, normalized parameter writes are mapped back to each AU parameter range with bounded sample offsets, bounded display strings are parsed through CoreAudio where supported, bounded host transport fields are re-validated by the worker and exposed through `AudioTimeStamp` sample time plus `kAudioUnitProperty_HostCallbacks`, bounded note/CC/pitch-bend/pressure/program-change events are delivered through `MusicDeviceMIDIEvent` where the unit supports them, opaque state is stored through the CoreAudio class-info property list, and plugin latency/tail/layout data are reported from CoreAudio properties and the negotiated worker setup. AU layout currently reports the active main audio buses used by this render path.

`--inspect-vst3-factory` runs a short-lived VST3 SDK factory probe for one `.vst3` bundle and returns only bounded public class metadata (`name`, `vendor`, `category`, `kind`, and `version`). Browser-visible plugin listings use this to improve real plugin browsers without exposing local bundle paths.

`--host-vst3-worker` runs the native VST3 host worker used by the browser daemon when the SDK is linked. It loads one `.vst3` bundle through Steinberg's module loader, creates the audio component and edit controller, configures a realtime 32-bit stereo processing setup, accepts newline-delimited `parameters`, `programLists`, `noteExpressions`, `setParameter`, `setParameterDisplayValue`, `getState`, `setState`, `latency`, `tail`, `layout`, `render`, `midi`, `noteOn`, `noteOff`, and `quit` commands, and renders JSON float audio blocks back to the daemon process. Bounded note and poly-pressure events are queued in the worker and delivered to the plugin as a VST3 `IEventList` on the next render block. Bounded CC, pitch-bend, and channel-pressure events are translated through VST3 `IMidiMapping` when the plugin exposes a parameter assignment. Bounded parameter changes update the edit controller and are delivered to DSP as VST3 `IParameterChanges` on the next render block, and bounded display strings are parsed through the VST3 edit controller when supported. Bounded host transport fields are re-validated by the worker and mapped into VST3 `ProcessContext` for play state, sample position, tempo, time signature, musical position, bar position, and cycle range. Parameters include bounded SDK unit metadata where `IUnitInfo` exposes it, and program-change parameters are marked with capped program names and normalized selection values when the SDK exposes a matching unit program list; plugin snapshots also include bounded all-list program metadata from `IUnitInfo`. Opaque state is stored as bounded VST3 component and edit-controller streams, and plugin latency/tail/layout data are reported from `IAudioProcessor` and the negotiated bus setup. VST3 layout includes bounded SDK bus metadata, including aux buses that may represent sidechains or extra outputs, and render commands can carry explicit bounded bus-indexed input buffers and return bounded bus-indexed output buffers for active VST3 buses.

`--host-lv2-worker` runs the native LV2 host worker used by the browser daemon for compatible installed LV2 effects. It loads one `.lv2` bundle-local dynamic library through `lv2_descriptor`, accepts newline-delimited `parameters`, `setParameter`, `getState`, `setState`, `latency`, `tail`, `layout`, `render`, `midi`, `noteOn`, `noteOff`, and `quit` commands, and renders JSON float audio blocks back to the daemon process. The browser daemon only enables this worker for LV2 bundles whose required host features and options match the worker profile. The worker exposes bounded input control ports as parameters, reports bounded step metadata for `lv2:toggled`, `lv2:integer`, and `lv2:enumeration` controls, maps normalized writes back onto each LV2 port range with discrete controls quantized to legal plain values, applies queued control-port events by splitting render blocks at bounded offsets for unrestricted profiles, rejects mid-block control changes for fixed/power-of-two block profiles, stores bounded control-port state keyed by LV2 port index, saves and restores bounded portable POD LV2 `state:interface` properties, brokers file-backed state through LV2 path features with relative paths and capped embedded file bytes, delivers bounded MIDI batches to compatible atom/event MIDI input ports, re-validates bounded host transport fields and emits LV2 atom `time:Position` events for compatible atom/event input ports, provides bounded synchronous LV2 `work:schedule` callbacks to plugins that expose `work:interface`, enforces declared fixed/power-of-two render block sizes, refreshes and reports bounded standard LV2 latency output ports, reports the fixed LV2 audio port layout with bounded bus metadata, and returns conservative zero tail metadata until the relevant LV2 tail extension support is implemented.

`--scan-examples` returns the repo-local AU/VST/LV2 example bundles used by the browser demo:

- `vst3:soundbridge-example-polysynth.vst3`
- `au:soundbridge-example-tonewheel.component`
- `lv2:soundbridge-example-wavefold.lv2`
- `lv2:soundbridge-example-gain.lv2`

`--host-status` reports `exampleHostAvailable` separately from real binary plugin `hostAvailable`. On macOS, AU reports `hostAvailable: true`; VST3 reports `hostAvailable: true` when the SDK worker is linked; LV2 reports `hostAvailable: true` when the basic LV2 audio/control worker is available.

For installed-plugin compatibility checks, run:

```sh
SOUNDBRIDGE_PROBE_FILTER=Cymatics npm run probe:installed
```

The probe starts a temporary paired loopback daemon with an explicit origin allowlist and runs bounded create, parameter, state, latency, tail, MIDI, render, output-bus layout, and destroy checks against matching installed VST3, AU, and LV2 plugins. Set `SOUNDBRIDGE_PROBE_FORMATS` only when you intentionally want to narrow the run to a comma-separated subset such as `vst3,au` or `lv2`. It is intended for compatibility evidence and debugging; it does not replace OS-level worker sandboxing.

Add `SOUNDBRIDGE_PROBE_NATIVE_EDITOR_BROKER=1` to also verify the opt-in native editor broker open/close path with the safe fixture broker, or with `SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH` and `SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS` when testing a real UI broker.

The example bundles live at:

- `native/example-plugins/VST3/soundbridge-example-polysynth.vst3`
- `native/example-plugins/Components/soundbridge-example-tonewheel.component`
- `native/example-plugins/LV2/soundbridge-example-wavefold.lv2`
- `native/example-plugins/LV2/soundbridge-example-gain.lv2`

The native build installs a shared Mach-O helper into each instrument bundle:

- `Contents/MacOS/soundbridge-example-polysynth`
- `Contents/MacOS/soundbridge-example-tonewheel`
- `soundbridge-example-wavefold`

Those helpers are not full VST3 SDK, AudioComponent, or LV2 binaries. They are SoundBridge example executables that render the instrument blocks used by the website demo.
They support both one-shot rendering and worker mode. Worker mode owns note state and oscillator phase across render calls:

The LV2 gain fixtures are different: they are small real LV2 dynamic-library bundles used by the native worker smoke path, including a restricted block-profile variant.

```sh
native/example-plugins/VST3/soundbridge-example-polysynth.vst3/Contents/MacOS/soundbridge-example-polysynth --worker
```

Worker mode accepts newline-delimited commands on stdin:

```text
noteOn 60 0.8
render 128 48000 0.42 0.68 0.5
render 128 48000 0.42 0.68 0.5
noteOff 60
quit
```

Render one native example block:

```sh
native/bridge-daemon/build/soundbridge-daemon --render-example-block vst3:soundbridge-example-polysynth.vst3 128 48000 0.42 0.68 0.5 60:0.8
native/bridge-daemon/build/soundbridge-daemon --render-example-block au:soundbridge-example-tonewheel.component 128 48000 0.48 0.36 0.5 60:0.8
native/bridge-daemon/build/soundbridge-daemon --render-example-block lv2:soundbridge-example-wavefold.lv2 128 48000 0.40 0.58 0.5 60:0.8
```

Arguments are plugin id, frame count, sample rate, normalized gain, normalized tone, normalized detune, and a comma-separated `note:velocity` list.

## Next Native Milestones

Full VST3/AU/LV2 hosting should land as core compatibility work with feature-specific security controls. The near-term goal is that musicians can load, tweak, save, reopen, automate, and route real plugins. OS-level worker sandboxing remains the final hardening layer after the core host behavior is working.

- Complete deeper VST3 musical-control support where the SDK exposes a safe host path, including program-data handling and remaining note-expression edge cases beyond bounded value/text note-expression events, bounded process transport context, bounded unit metadata, and bounded program-list metadata, with event-count, byte-size, timing-offset, channel/note, and worker-queue limits.
- Expand VST3/AU/LV2 automation from bounded event lists and per-block step/linear curves to higher-density timeline automation only with parameter-count, string-length, point-count, event-count, timing-offset, and per-instance rate limits.
- Strengthen advanced bus and format negotiation across VST3 and AU. VST3 now has bounded bus-indexed render buffers for active SDK buses; AU reports bounded realtime main-bus, format-converter, multi-source merger, and multi-output splitter profiles where the current worker can host them. Deeper AU utility/offline profiles, deeper VST3 bus negotiation, and cross-format routing polish still need the same hard channel, block-size, sample-rate, and allocation limits at the daemon boundary and again inside workers.
- Add platform-specific plugin editor/UI hosting on top of the opt-in daemon broker contract. Public plugin listings now expose bounded `editorKinds` for generic/native editor UI gating, and broker file-dialog/clipboard/drag-drop capabilities require daemon allow flags before becoming browser-visible; remaining work is the real platform UI broker. Do not load native editor code into the daemon; keep native UI in a separate broker process and broker windowing, focus, clipboard, drag/drop, and file dialogs explicitly.
- Wire preset, sample, cache, and licensing file access through the opt-in root-limited file grant foundation, native approval broker contract, and instance-scoped file grant attachments. Grant-backed worker-native preset-state load and state restore/save are implemented for VST3/AU/LV2; remaining vendor preset/sample/cache/license workflows should still avoid ambient filesystem access, grant only narrow user-approved paths where practical, and keep browser-supplied path grants behind development opt-in.
- Add LV2 UI and remaining extension-feature support behind the same worker, validation, state, bus, file-broker, and sandbox rules. Basic LV2 control-port state, bounded portable POD state, bounded file-backed state, bounded atom MIDI delivery, atom time-position transport, fixed/power-of-two block profiles, synchronous `work:schedule`, standard latency reporting, and unsupported required-feature/option gating are already supported for compatible plugins.
- Deepen VST3 factory/class metadata extraction beyond path-free scanner identifiers without exposing private filesystem paths unless diagnostics are explicitly enabled.
- Add an internal real-time-safe audio queue between daemon and worker.
- Add OS-level worker sandboxing as the final hardening milestone once core hosting compatibility is in place.
