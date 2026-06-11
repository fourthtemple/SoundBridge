# SoundBridge Native Bridge Daemon

This is the macOS-first native daemon skeleton. It currently builds command-line scanners for VST3, Audio Unit, and LV2 plugins, plus worker-process hosting for Audio Unit and SDK-backed VST3 audio effects.

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

It deliberately does not vendor Steinberg's VST3 SDK or require an LV2 stack yet. Audio Unit hosting is implemented through the macOS CoreAudio APIs. VST3 hosting is enabled when `SOUNDBRIDGE_VST3_SDK_PATH` points at a Steinberg SDK checkout or the local development SDK path is present; LV2 still needs an optional host adapter after dependency review.

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

`--scan-vst3` discovers VST3 bundles and reads macOS `Info.plist` metadata when present, including display name, bundle identifier, version, and vendor hints. Scanning remains lightweight; binary loading happens in the separate `--host-vst3-worker` process.

`--scan-au` combines `.component` bundle discovery with the macOS AudioComponent registry. Bundle hits are enriched with registry metadata when the component names match; registry-only built-in Audio Units are returned with `diagnostics.isRegistry: true` and no bundle path.

`--host-au-worker` runs the native Audio Unit host worker used by the browser daemon. It instantiates one AudioComponent, accepts newline-delimited `noteOn`, `noteOff`, `render`, and `quit` commands, and renders JSON float audio blocks back to the daemon process.

`--host-vst3-worker` runs the native VST3 host worker used by the browser daemon when the SDK is linked. It loads one `.vst3` bundle through Steinberg's module loader, creates the audio component, configures a realtime 32-bit stereo processing setup, accepts newline-delimited `render`, `midi`, `noteOn`, `noteOff`, and `quit` commands, and renders JSON float audio blocks back to the daemon process. Bounded note events are queued in the worker and delivered to the plugin as a VST3 `IEventList` on the next render block.

`--scan-examples` returns the repo-local AU/VST/LV2 example bundles used by the browser demo:

- `vst3:soundbridge-example-polysynth.vst3`
- `au:soundbridge-example-tonewheel.component`
- `lv2:soundbridge-example-wavefold.lv2`

`--host-status` reports `exampleHostAvailable` separately from real binary plugin `hostAvailable`. On macOS, AU reports `hostAvailable: true`; VST3 reports `hostAvailable: true` when the SDK worker is linked; LV2 remains false until its binary host adapter is linked.

The example bundles live at:

- `native/example-plugins/VST3/soundbridge-example-polysynth.vst3`
- `native/example-plugins/Components/soundbridge-example-tonewheel.component`
- `native/example-plugins/LV2/soundbridge-example-wavefold.lv2`

The native build installs a shared Mach-O helper into each bundle:

- `Contents/MacOS/soundbridge-example-polysynth`
- `Contents/MacOS/soundbridge-example-tonewheel`
- `soundbridge-example-wavefold`

Those helpers are not full VST3 SDK, AudioComponent, or LV2 binaries. They are SoundBridge example executables that render the instrument blocks used by the website demo.
They support both one-shot rendering and worker mode. Worker mode owns note state and oscillator phase across render calls:

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

Full VST3/AU/LV2 hosting should land as feature and security work together. Each new host feature expands the native plugin attack surface, even for local desktop hosts, so it must stay behind worker isolation, session ownership, bounded payloads, and eventually OS-level worker sandboxing.

- Broaden VST3 MIDI beyond bounded `noteOn`/`noteOff` event lists. Add additional event types only with event-count, byte-size, timing-offset, channel/note, and worker-queue limits.
- Expand VST3 and AU parameter enumeration/automation. Cap parameter counts and string lengths, escape plugin-controlled text, keep parameter writes normalized, and rate-limit automation bursts per instance.
- Add opaque state save/restore for VST3 and AU. Enforce blob-size limits, bind state to the owning instance/session, and never treat plugin state as a filesystem path or executable input.
- Report plugin latency through the shared protocol. Clamp plugin-reported latency to sane numeric ranges before hosts use it for scheduling.
- Strengthen bus and format negotiation for VST3 and AU. Keep hard channel, block-size, sample-rate, and allocation limits at the daemon boundary and again inside workers.
- Add plugin editor/UI hosting only through a separate UI worker or broker process. Do not load native editor code into the daemon; broker windowing, focus, clipboard, drag/drop, and file dialogs explicitly.
- Broker preset, sample, cache, and licensing file access. Avoid ambient filesystem access from plugin workers; grant only narrow, user-approved paths where practical.
- Add an LV2 host adapter behind an optional dependency boundary with the same worker, validation, state, bus, and sandbox rules.
- Implement factory/class metadata extraction for all supported formats without exposing private filesystem paths unless diagnostics are explicitly enabled.
- Add an internal real-time-safe audio queue between daemon and worker.
