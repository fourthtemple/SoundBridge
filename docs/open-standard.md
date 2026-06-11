# Why Browser Plugin Bridges Need An Open Standard

Browser DAWs are starting to load local desktop plugins through native companion apps. Audiotool documents VST Bridge as a native app that connects its web DAW to local VST3 plugins. Amped Studio documents VST Remote as a bridge app that connects installed VST/VST3 plugins to its browser studio.

That product direction is useful. It is also powerful enough that the safety model should not be hidden inside proprietary bridge behavior. A browser-to-native plugin bridge is a local native execution surface exposed to web origins. It can scan installed plugins, instantiate third-party binaries, route audio and MIDI, persist plugin state, and sometimes open native plugin editors.

SoundBridge should help make this category auditable by documenting a small open protocol and the security properties any compatible bridge should satisfy.

## The Trust Boundary

The browser security model assumes websites are sandboxed. A plugin bridge deliberately crosses that sandbox by giving a website a controlled path to native code on the user's machine.

The risky part is not Web Audio. The risky part is the local companion daemon:

- it knows which plugins are installed
- it may know private filesystem paths
- it can load third-party native binaries
- it may process microphone, file, or project audio
- it can consume CPU, memory, realtime audio threads, and plugin licenses
- it may persist opaque plugin state into cloud-synced projects

The daemon must therefore act as a permission broker, not as a transparent localhost API.

## Why A Shared Standard Helps

An open standard gives users, browser DAWs, plugin vendors, and security researchers something concrete to inspect.

- Users can understand what local permission they are granting.
- Web DAWs can integrate one bridge protocol instead of many opaque helpers.
- Plugin vendors can reason about how their plugins are loaded from browser sessions.
- Security reviewers can test origin binding, pairing, quotas, and crash isolation.
- Bridge implementers can compete on UX and performance without hiding the safety rules.

Without a shared standard, every bridge has to be trusted as a black box. That is especially uncomfortable when the bridge loads arbitrary installed plugins.

## Baseline Security Requirements

A conforming browser plugin bridge should, at minimum:

- bind to loopback only by default
- reject pairing without a browser `Origin` header
- require explicit local user approval before plugin scanning or instantiation
- bind session tokens to the exact origin and connection that paired
- prevent one origin or tab from controlling another origin's plugin instances
- keep unpaired discovery responses minimal
- avoid static default secrets
- keep plugin inventory and filesystem paths private until approved
- expose diagnostics only through an explicit user-controlled mode
- enforce per-origin, per-session, and daemon-wide resource quotas
- cap message sizes before pairing
- treat plugin state as opaque untrusted data
- isolate plugin DSP in worker processes where practical
- survive plugin crashes without killing the daemon or other sessions
- document signing, notarization, installation, auto-update, and background-service behavior

These rules are intentionally boring. Boring is good here.

## Protocol Requirements

The protocol should be small and testable:

- every privileged command requires a valid session
- every response has a stable error code
- `hello` reports only safe pre-pairing capability metadata
- `pair` records origin, connection, expiry, and approval details
- `scanPlugins` and `listPlugins` never expose private paths by default
- `createInstance` returns an instance owned by one session
- parameter, state, MIDI, audio, latency, tail-time, and editor commands all verify instance ownership
- binary transports negotiate capabilities rather than assuming browser features
- version negotiation is explicit and backward-compatible additions are optional

SoundBridge's current protocol is still early, but this is the direction it should hold itself to.

## Audit Artifacts

An auditable implementation should publish:

- the protocol schema
- the threat model
- a conformance test suite
- sample malicious-origin tests
- installer and update behavior
- OS service or LaunchAgent configuration
- socket binding behavior
- origin-approval UX
- crash and worker-isolation behavior
- privacy rules for plugin inventory, paths, diagnostics, and project state

The goal is not to make every product open source. The goal is to make the contract inspectable enough that users are not asked to blindly trust a native bridge that any website might try to reach.

## SoundBridge Position

SoundBridge should be open about this risk because the whole project exists at that boundary.

We should avoid claiming "secure VSTs in the browser" as a slogan. The accurate claim is narrower:

SoundBridge is designing an auditable browser-to-native audio plugin bridge where local approval, origin binding, session ownership, loopback transport, worker isolation, and protocol conformance are first-class parts of the product.

That is the standard this project should invite other browser DAWs and bridge applications to adopt.

## References

- [Audiotool VST Bridge](https://help.audiotool.com/manuals/vst-bridge.html)
- [Amped Studio VST Remote](https://ampedstudio.com/vstremote/)
- [Amped Studio VST Remote Manual](https://ampedstudio.com/manual/vst-remote/)
