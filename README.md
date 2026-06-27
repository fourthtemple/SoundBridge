# SoundBridge

Host installed VST (VST3), Audio Unit, and LV2 plugins from a website.

SoundBridge runs a small local bridge daemon on the user's machine. Your browser app talks to that daemon over localhost WebSocket, and the daemon loads the native plugin.

## Quick Start: Host VST/AU/LV2 In A Web Page

Build the native bridge:

```sh
git clone git@github.com:fourthtemple/SoundBridge.git
cd SoundBridge
npm run build:native
```

Confirm native hosting is available:

```sh
npm run host-status
```

You want to see `hostAvailable: true` for the format you plan to use.

List installed plugins:

```sh
npm run scan:vst3
npm run scan:au
npm run scan:lv2
```

Start the local bridge daemon:

```sh
npm run bridge
```

The daemon prints an ephemeral pairing token. Your page needs that token before it can scan or instantiate local plugins.

## Use It From Your Website

Serve these files from your site:

```text
packages/web-client/dist/soundbridge-client.js
packages/web-client/dist/soundbridge-transport-worker.js
packages/web-client/dist/soundbridge-worklet.js
```

Then create a plugin instance and put it in your Web Audio graph:

```html
<script type="module">
  import {
    SoundBridgeAudioNode,
    SoundBridgeClient
  } from "/soundbridge/soundbridge-client.js";

  const audioContext = new AudioContext();
  const client = new SoundBridgeClient({
    url: "ws://127.0.0.1:47370/bridge",
    transport: "worker"
  });

  await client.connect();
  const pairingToken = window.prompt("SoundBridge pairing token")?.trim();
  if (!pairingToken) {
    throw new Error("SoundBridge pairing token is required.");
  }
  await client.pair(pairingToken);

  const { plugins } = await client.scanPlugins({
    formats: ["vst3", "au", "lv2"]
  });

  const plugin = plugins.find((candidate) =>
    candidate.hostable !== false &&
    candidate.kind !== "instrument"
  );

  if (!plugin) {
    throw new Error("No hostable VST3, AU, or LV2 effect found.");
  }

  const inputChannels = plugin.inputs ?? 2;
  const outputChannels = plugin.outputs ?? 2;
  const created = await client.createInstance({
    pluginId: plugin.pluginId,
    format: plugin.format,
    sampleRate: audioContext.sampleRate,
    maxBlockSize: 128,
    inputChannels,
    outputChannels
  });
  const { instanceId } = created;
  const negotiatedInputChannels = created.layout?.inputChannels ?? inputChannels;
  const negotiatedOutputChannels = created.layout?.outputChannels ?? outputChannels;

  if (plugin.presets?.[0]) {
    await client.setPreset(instanceId, plugin.presets[0].id);
  }

  const pluginNode = await SoundBridgeAudioNode.createLivePerformance(audioContext, client, {
    instanceId,
    inputChannels: negotiatedInputChannels,
    outputChannels: negotiatedOutputChannels,
    workletUrl: "/soundbridge/soundbridge-worklet.js"
  });
  pluginNode.addEventListener("render-budget-exceeded", () => {
    console.warn("Plugin render exceeded the live block budget.", pluginNode.health);
  });
  pluginNode.addEventListener("render-budget-auto-bypassed", () => {
    console.warn("Plugin was bypassed after repeated live render misses.", pluginNode.health);
  });
  pluginNode.addEventListener("transport-pressure-auto-bypassed", () => {
    console.warn("Plugin was bypassed after sustained live transport pressure.", pluginNode.health);
  });
  pluginNode.addEventListener("audio-error-auto-bypassed", () => {
    console.warn("Plugin was bypassed after a live audio error.", pluginNode.health);
  });
  pluginNode.addEventListener("audio-error", () => {
    console.warn("Plugin audio path reported an error.", pluginNode.health);
  });
  // Switch to dry audio immediately without destroying the native plugin instance.
  // pluginNode.setBypassed(true);

  const oscillator = new OscillatorNode(audioContext, { frequency: 110 });
  oscillator.connect(pluginNode.node);
  pluginNode.connect(audioContext.destination);
  oscillator.start();

  await audioContext.resume();
</script>
```

That is the core integration: scan, create an instance, connect `SoundBridgeAudioNode` with the live-performance Web Audio defaults.
For live UIs, call `pluginNode.setBypassed(true)` for emergency fail-dry behavior, call `pluginNode.setBypassed(false)` for an explicit retry after an auto-bypass, call `pluginNode.refreshLatency()` when transport latency changes or from your compensation loop, read `pluginNode.health` for bounded sample and millisecond latency totals, and listen for `latencychange`, `fallback-output`, and `transport-pressure` to monitor plugin latency changes from render responses, dry/silence fallback output, deadline misses, response jitter, stale output, dropped input, underruns, audio errors, render-budget pressure, transport-pressure auto-bypass, render-budget auto-bypass, and audio-error auto-bypass. The live Web Audio worker and fallback paths use `liveTransportForBlock()` so tempo-synced AU/VST effects receive bounded, output-latency-compensated block positions, shared-ring input pressure and response jitter participate in adaptive latency recovery, and `createLivePerformance()` reports worklet stats every 32 blocks by default for faster live pressure feedback.

If your host owns the audio blocks directly, such as a browser DJ deck or live effects rack, use the live-performance rack defaults:

```js
import { SoundBridgeLiveEffectRack } from "/soundbridge/soundbridge-client.js";

const rack = await SoundBridgeLiveEffectRack.createLivePerformance({
  client,
  plugin,
  sampleRate: audioContext.sampleRate,
  maxBlockSize: 128
});
rack.setWetMix(0.35);
```

That preset uses binary audio, one in-flight block, bounded end-to-end processing budgets and audio request timeouts, block-time input freshness and processing deadlines, bounded host-side wet/dry mix, wet/dry transition fades, bounded default block transport plus `rack.timing` snapshots and `liveTransportForBlock()` for host scheduling, bounded recovery after process or render pressure, `dryOutputBlocks`, `lastDryReason`, and per-block `dry-output` events for live dry-output causes, AudioNode `fallbackOutputBlocks`, `lastFallbackReason`, and bounded `fallback-output` events for worklet dry/silence fallback, render-response latency updates plus `refreshLatency()` health for plugin and transport latency compensation in samples and milliseconds, and `render_timeout`/`render_quarantined` handling with deadline-budget health details when a native worker misses the live render deadline.
Use `rack.setParameter()`, `rack.setParameterEvents()`, `rack.setParameterCurve()`, `rack.setAutomationLane()`, `rack.clearAutomationLane()`, `rack.setPreset()`, and `rack.sendMidiEvents()` to drive the rack-owned plugin instance from live controls without passing raw instance ids around the host.
Use `rack.processScheduledBlock()` with `scheduler.updateFromRackCalibration(rack.health, calibration)` and `createLiveEffectRackSchedulerAdaptiveLatencyController()` when a single host-owned effect follows scheduler pressure, stale-capture decisions, soundcheck, and adaptive scheduler latency. For deck, send, or master chains, use `createLivePerformanceRackChain()` with `chain.timing`, `createLiveEffectRackChainCalibrationWindow()`, `scheduler.updateFromChainCalibration(chain.health, calibration)`, and `createLiveEffectRackChainSchedulerAdaptiveLatencyController()` so the host gets block-based live defaults, aggregate chain budget/timeout fail-dry behavior, deadline-pressure snapshots, dry-output counters and reasons, optional dry skips for pressured scheduled blocks, soundcheck, and calibrated compensation for one serial effects chain instead of every plugin slot individually. For several chains sharing one host audio frame, use `createLivePerformanceFrameBatchProcessor()` with `createLiveEffectRackFrameBatchCalibrationWindow()`, `scheduler.updateFromFrameBatchCalibration(batchProcessor.health, calibration)`, and `createLiveEffectRackFrameBatchSchedulerAdaptiveLatencyController()` to collect aggregate deck/send/master batch duration, deadline lead/jitter, dry pressure, latency, budget/timeout recommendations, optional batch-wide dry skips for pressured shared frames, and shared-scheduler latency adjustments.
For live controls, call `rack.retry()` after a recoverable process-budget or render-budget pressure trip; use `rack.recreate()` when the plugin worker times out, crashes, is quarantined, or reports a non-recoverable processing error.

## Try The Demo

With `npm run bridge` running in one terminal:

```sh
npm run demo
```

Open <http://127.0.0.1:5173>. The demo can select installed VST3/AU/LV2 plugins that match the current host adapters, create an instance, process microphone or file input through the local bridge, apply daemon-listed presets, export/restore bounded VST3 program data when a plugin advertises it, and run brokered state/preset file grants when the selected plugin advertises them.

## What Works Now

- VST3: installed plugins through the Steinberg VST3 SDK host worker, including path-free public scanner metadata, brokered bounded factory class kind/category metadata, parameter metadata with bounded plugin-authored display values, bounded display-text-to-parameter parsing, generic parameter editor sessions, bounded SDK unit metadata for parameter grouping and program-list ownership, bounded plugin-level and parameter-attached program-list metadata, bounded opaque SDK program-data export/restore for daemon-listed programs where supported, bounded multi-event-bus note-expression metadata plus value/text event delivery with optional bounded event-bus indexes, bounded preset snapshot application where metadata exists, worker-native preset-state loading through file grants, normalized parameter writes, bounded automation event lists, per-block curves, stored timeline automation lanes, bounded note/poly-pressure events, VST3 MIDI-controller parameter mapping where plugins expose it, bounded host transport context, negotiated per-bus layout reporting, bounded per-bus speaker arrangement negotiation with main-bus fallback, bounded bus-aware rendering for active VST3 buses, bounded latency/tail reporting, and opaque state save/restore.
- AU: installed realtime-compatible macOS Audio Units through the CoreAudio host worker, including path-free public AudioComponent metadata, explicit realtime host-profile metadata for main-bus, format-converter, multi-source merger, and multi-output splitter profiles, parameter metadata with bounded Audio Unit display strings where provided, bounded display-text-to-parameter parsing where units support it, generic parameter editor sessions, bounded preset snapshot application where metadata exists, worker-native preset-state loading through file grants, normalized parameter writes, bounded automation event lists, per-block curves, stored timeline automation lanes, bounded host transport callbacks where units request them, conservative per-bus layout reporting, explicit bus-indexed input routing for active CoreAudio input elements, explicit bus-indexed output buffers for active CoreAudio output elements, rendering, bounded note, CC, pitch-bend, pressure, and program-change events where supported, bounded latency/tail reporting, and opaque state save/restore. AU offline effects and incompatible Apple system utility profiles remain visible as discovery-only entries.
- LV2: installed basic audio/control LV2 effects through the native LV2 host worker, including bounded TTL metadata parsing, path-free public LV2 URI, UI declaration, and block-size profile metadata, unsupported required-feature gating, bounded `buf-size:boundedBlockLength` / `fixedBlockLength` / `powerOf2BlockLength` / `options#options` host contracts, parameter metadata with bounded integer/toggle/enumeration step handling, generic parameter editor sessions, bounded preset snapshot application where metadata exists, worker-native preset-state loading through file grants, normalized and bounded display-text parameter writes, bounded automation event lists, per-block curves, and stored timeline automation lanes for control ports with block-boundary enforcement for restricted LV2 block profiles, bounded control-port state save/restore, bounded portable POD `state:interface` save/restore, brokered file-backed state through LV2 state path features, bounded atom MIDI delivery to compatible atom/event MIDI input ports, bounded host transport delivery as LV2 atom `time:Position` events where supported, bounded synchronous LV2 `work:schedule` delivery for plugins that expose `work:interface`, bounded latency reporting from standard LV2 latency output ports, bounded `pg:group` main input/output bus layout reporting with aggregate/per-audio-port fallback for older metadata, explicit bounded input/output bus buffers, rendering, and conservative tail reporting. LV2 UI hosting and advanced extension support are still roadmap items.
- VST2: not supported.

VST3 hosting is enabled when `SOUNDBRIDGE_VST3_SDK_PATH` points to a Steinberg VST3 SDK checkout, or when the local development SDK path exists.

## Multiple Websites And Safety

The local bridge can serve more than one browser host, but plugin instances are not shared:

- each website/tab pairs over its own WebSocket
- session tokens are bound to that WebSocket and its Origin header
- each plugin instance is owned by the session that created it
- another session cannot control that `instanceId`
- closing the WebSocket destroys that session's plugin workers
- the daemon enforces per-session and total instance limits

The development daemon generates a new pairing token each time it starts. A production app should replace the token prompt with a native approval prompt that shows the requesting origin.

You can restrict pairing to known origins during development:

```sh
SOUNDBRIDGE_ALLOWED_ORIGINS=https://your-site.example npm run bridge
```

The bridge and demo bind to loopback only by default. Non-loopback binds require an explicit unsafe test opt-in with `SOUNDBRIDGE_ALLOW_NON_LOOPBACK=1` or `SOUNDBRIDGE_DEMO_ALLOW_NON_LOOPBACK=1`.

Browser-to-native plugin bridges are powerful enough to need public review. SoundBridge documents its protocol and security model so this category can move toward an auditable open standard instead of opaque localhost helpers.

Native plugin editor windows are intentionally not loaded into the daemon. Generic parameter editors work today, and `listPlugins()` advertises bounded `editorKinds` so hosts can show editor actions per plugin. Native editor sessions require both plugin `native-window` support and an explicitly configured separate UI broker process, and remain disabled by default. Broker file-dialog, clipboard, and drag/drop capabilities stay hidden from browser responses unless the daemon is started with explicit native-editor allow flags.

Preset/sample/cache/license file access is also not ambient. The daemon exposes an opt-in file grant foundation that stays disabled unless `SOUNDBRIDGE_FILE_GRANT_ROOTS` names explicit local roots; browser responses receive opaque grant ids and display names, not absolute paths. Production-style approvals use an explicit native broker configured with `SOUNDBRIDGE_FILE_GRANT_BROKER_PATH`, then hosts can attach the opaque grant to a session-owned plugin instance. `useFileGrant restoreState`, `loadPreset`, and `saveStateDirectory` are implemented for the reference VST3/AU/LV2 native workers so they can load bounded worker-native preset/state files and save bounded state files without exposing local paths to browser code. `listPlugins()` advertises each plugin's `fileGrantOperations`; hosts should only show file-backed actions that the selected plugin advertises, and unadvertised operations fail closed. Other operations such as `loadSample`, cache, and license handling remain operation-specific host-adapter work; the absolute path is resolved only inside the daemon and sent only over bounded worker IPC. Browser-supplied path strings additionally require `SOUNDBRIDGE_FILE_GRANT_ALLOW_BROWSER_PATHS=1` and are intended only for development and test harnesses.

## Common Problems

`vst3.hostAvailable` is false:

```sh
export SOUNDBRIDGE_VST3_SDK_PATH=/path/to/vst3sdk
npm run build:native
```

No plugins show up:

```sh
npm run scan:vst3
npm run scan:au
npm run scan:lv2
```

A plugin shows up but you want to verify real hosting:

```sh
SOUNDBRIDGE_PROBE_FILTER="Plugin Name" npm run probe:installed
```

The installed-plugin probe starts a temporary loopback daemon with a random pairing token and explicit origin allowlist, then runs bounded create, listed-preset, VST3 program-data when exposed, VST3 event-metadata classification, advertised file-grant operation coverage, parameter, state, grant-backed preset/state/sample/cache/license/explicit-other workflows when advertised, latency, tail, MIDI timing plus VST3 note-expression value/text events, automation, render-signal classification, host transport, output-bus layout, and destroy checks against matching installed VST3, AU, and LV2 plugins. Set `SOUNDBRIDGE_PROBE_FILTER` to a plugin or vendor substring. Leave it empty only when you deliberately want to load every matching installed plugin. Use `SOUNDBRIDGE_PROBE_FORMATS=vst3,au`, `lv2`, or another comma-separated subset only when you intentionally want to narrow the run.

For a compact pass/fail and feature-coverage report without the full per-plugin JSON:

```sh
SOUNDBRIDGE_PROBE_REPORT=summary SOUNDBRIDGE_PROBE_FILTER="Plugin Name" npm run probe:installed
```

For a compact JSON artifact intended for compatibility matrix ingestion:

```sh
SOUNDBRIDGE_PROBE_REPORT=matrix SOUNDBRIDGE_PROBE_FILTER="Plugin Name" npm run --silent probe:installed
```

For GitHub plugin compatibility requests, attach a focused JSON probe report:

```sh
SOUNDBRIDGE_PROBE_REPORT=json \
SOUNDBRIDGE_PROBE_FORMATS=vst3 \
SOUNDBRIDGE_PROBE_FILTER="Plugin Name" \
npm run --silent probe:installed > soundbridge-probe-report.json
```

Do not upload plugin binaries, licenses, private presets, samples, or local filesystem paths. See [Plugin compatibility reports](docs/compatibility-reports.md).

To include the native editor broker open/close path against those installed instances:

```sh
SOUNDBRIDGE_PROBE_NATIVE_EDITOR_BROKER=1 SOUNDBRIDGE_PROBE_FILTER="Plugin Name" npm run probe:installed
```

That mode uses the repo's safe fixture broker by default. Set `SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH` and `SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS` only when testing a real platform UI broker.

Installed VST3s are scanned from:

```text
/Library/Audio/Plug-Ins/VST3
~/Library/Audio/Plug-Ins/VST3
```

Installed Audio Units are scanned from the macOS AudioComponent registry and:

```text
/Library/Audio/Plug-Ins/Components
~/Library/Audio/Plug-Ins/Components
```

Installed LV2 bundles are scanned from:

```text
/Library/Audio/Plug-Ins/LV2
~/Library/Audio/Plug-Ins/LV2
~/.lv2
/opt/homebrew/lib/lv2
/usr/local/lib/lv2
/usr/lib/lv2
```

The browser cannot connect:

- Make sure `npm run bridge` is running.
- Use `ws://127.0.0.1:47370/bridge`.
- Pair with the token printed by the bridge terminal.
- Serve your page over `http://` or `https://`, not `file://`.

## Useful Commands

```sh
npm run build:native
npm run bridge
npm run host-status
npm run scan:vst3
npm run scan:au
npm run scan:lv2
npm run probe:installed
npm run check
```

## More Docs

- [Protocol](docs/protocol.md)
- [Security](docs/security.md)
- [Native editor broker](docs/native-editor-broker.md)
- [File grant approval broker](docs/file-grant-approval-broker.md)
- [Plugin compatibility reports](docs/compatibility-reports.md)
- [Release readiness](docs/release-readiness.md)
- [Why browser plugin bridges need an open standard](docs/open-standard.md)
- [Roadmap](docs/roadmap.md)
- [Architecture](docs/architecture.md)
- [Web DAW integration](docs/daw-integration.md)

## License

MIT
