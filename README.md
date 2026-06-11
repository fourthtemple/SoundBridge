# SoundBridge

Host installed VST (VST3) and Audio Unit plugins from a website.

SoundBridge runs a small local bridge daemon on the user's machine. Your browser app talks to that daemon over localhost WebSocket, and the daemon loads the native plugin.

## Quick Start: Host VST/AU In A Web Page

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

You want to see `hostAvailable: true` for `vst3` and/or `au`.

List installed plugins:

```sh
npm run scan:vst3
npm run scan:au
```

Start the local bridge daemon:

```sh
npm run bridge
```

The daemon prints an ephemeral pairing token. Your page needs that token before it can scan or instantiate local plugins.

## Use It From Your Website

Serve these two files from your site:

```text
packages/web-client/dist/soundbridge-client.js
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
    url: "ws://127.0.0.1:47370/bridge"
  });

  await client.connect();
  const pairingToken = window.prompt("SoundBridge pairing token")?.trim();
  if (!pairingToken) {
    throw new Error("SoundBridge pairing token is required.");
  }
  await client.pair(pairingToken);

  const { plugins } = await client.scanPlugins({
    formats: ["vst3", "au"]
  });

  const plugin = plugins.find((candidate) =>
    candidate.hostable !== false &&
    candidate.kind !== "instrument"
  );

  if (!plugin) {
    throw new Error("No hostable VST3 or AU effect found.");
  }

  const inputChannels = plugin.inputs || 2;
  const outputChannels = plugin.outputs || 2;
  const { instanceId } = await client.createInstance({
    pluginId: plugin.pluginId,
    format: plugin.format,
    sampleRate: audioContext.sampleRate,
    maxBlockSize: 128,
    inputChannels,
    outputChannels
  });

  const pluginNode = await SoundBridgeAudioNode.create(audioContext, client, {
    instanceId,
    inputChannels,
    outputChannels,
    workletUrl: "/soundbridge/soundbridge-worklet.js"
  });

  const oscillator = new OscillatorNode(audioContext, { frequency: 110 });
  oscillator.connect(pluginNode.node);
  pluginNode.connect(audioContext.destination);
  oscillator.start();

  await audioContext.resume();
</script>
```

That is the core integration: scan, create an instance, connect `SoundBridgeAudioNode`.

## Try The Demo

With `npm run bridge` running in one terminal:

```sh
npm run demo
```

Open <http://127.0.0.1:5173>. The demo can select installed VST3/AU plugins, create an instance, and process microphone or file input through the local bridge.

## What Works Now

- VST3: installed audio effects through the Steinberg VST3 SDK host worker, including parameter metadata, parameter writes, MIDI note events, rendering, bounded latency/tail reporting, and opaque state save/restore.
- AU: installed macOS Audio Units through the CoreAudio host worker, including parameter metadata, parameter writes, rendering, MIDI note events where supported, bounded latency/tail reporting, and opaque state save/restore.
- LV2: scanning and example bundles only; installed LV2 hosting is not wired yet.
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
```

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
npm run check
```

## More Docs

- [Protocol](docs/protocol.md)
- [Security](docs/security.md)
- [Why browser plugin bridges need an open standard](docs/open-standard.md)
- [Architecture](docs/architecture.md)
- [Web DAW integration](docs/daw-integration.md)

## License

MIT
