# Roadmap

This roadmap tracks what still needs to be completed for SoundBridge to become a dependable open standard and reference implementation for hosting local VST3, Audio Unit, and LV2 plugins from browser or desktop hosts.

The current priority is core hosting compatibility first, with VST3 as the primary near-term target. The core goal is an auditable bridge boundary: normally installed plugins should be able to run much as they do in desktop DAWs, while websites and local hosts only receive the bounded SoundBridge protocol instead of arbitrary access to the user's machine. OS-level sandboxing is a real but extended hardening profile, not the definition of project completion, because many commercial plugins expect existing license files, cache folders, sample libraries, helper services, and vendor authorization workflows in the normal user environment.

## Current Baseline

SoundBridge already has the core security and host shape in place:

- loopback daemon with pairing, origin checks, session ownership, and bounded request envelopes
- installed VST3 hosting through the Steinberg VST3 SDK worker when the SDK is available
- installed macOS Audio Unit hosting through the CoreAudio worker for realtime-compatible profiles
- installed compatible LV2 audio/control hosting through the native LV2 C ABI worker
- bounded plugin scanning metadata for VST3, AU, and LV2 without exposing launch paths to browsers
- bounded parameters, automation events, automation curves, timeline lanes, MIDI events, transport context, latency, tail, state, bus layouts, and file-grant operations
- binary WebSocket audio frames for main-bus and bus-indexed `processAudioBlock` buffers used by the web client and live effect rack
- live-performance defaults for Web Audio graph effects and host-owned DJ/effects block processing, including binary audio, rack-owned parameter, automation, preset, and MIDI control helpers, bounded in-flight work, SDK-edge block-size and sample normalization, inspectable rack, chain, frame-batch, and AudioNode scheduling policy/calibration recommendations, bounded rolling rack, chain, frame-batch, and AudioNode health calibration windows for soundcheck measurements, host-applied policy, rack/chain/frame-batch timing-policy, runtime scheduler timing-policy, and latency recommendations, bounded rack, rack-scheduler, chain-scheduler, and frame-batch-scheduler adaptive-latency control for sustained jitter/deadline/dry-pressure, bounded live block scheduling helpers with deadline/process-pressure snapshots, optional rack, chain, and frame-batch dry skips for pressured scheduled blocks plus batch-wide stale-frame skips that keep pressure snapshots on dry responses, bounded serial rack chains and shared-frame batches with block-based live presets, bounded end-to-end processing budgets, bounded audio request timeouts, shared-memory-capable transfer, adaptive latency limits, shared-ring pressure recovery, response-jitter pressure recovery, bounded live stats cadence, block-time input freshness and processing deadlines, bounded host-side wet/dry mix, wet/dry transition fades, host-readable rack, chain, and frame-batch timing snapshots, scheduler compensation from rack health, rack calibration, chain health, chain calibration, and shared-frame batch calibration, deadline lead/jitter health and deadline-miss events for racks, chains, frame batches, and AudioNodes, dry-output counters, dry-output reasons, dedicated rack and AudioNode budget-trip, timeout, timeout-trip, and recreate events, bounded default and explicit latency-compensated live transport helpers, plugin/transport/reported latency health in samples and milliseconds with render-response plugin latency updates, bounded process-pressure/render-pressure recovery and manual pressure retry, and one bounded process-timeout recreation attempt
- host-owned serial rack chains and shared-frame batches expose bounded duration, process-budget misses, aggregate deadline lead/jitter, aggregate timeout pressure, timeout stage and target attribution, reported-latency-aware shared-frame compensation, timeout-aware calibration warnings and timeout-headroom recommendations, repeated-miss trip status, health snapshots, chain and frame-batch deadline-miss events, frame-batch dry-output reason events, budget/timeout/retry/recovery/exhaustion events, wet/dry transition fades, and optional capped dry-cooldown process-pressure and timeout recovery so DJ/live hosts can see when the combined rack or deck/send/master batch misses its block deadline even if each individual stage appears healthy
- optional browser worker transport that owns WebSocket, JSON, and binary audio frame encode/decode, with direct `AudioWorklet` audio ports, initial `SharedArrayBuffer` audio rings sized from live in-flight, output-queue, and latency bounds, atomic wakeups where available, bounded shared-path in-flight audio requests and timeouts, newest-input/output overwrite under shared ring pressure, recycled worklet and transport-worker buffers, host-tunable adaptive output latency and recovery, controlled safety blocks for miss/shared-output/deadline-pressure latency raises, measured render-duration, response deadline/jitter, timeout-trip events, shared-worker in-flight saturation warnings, current/peak shared-ring queue health, shared buffer allocation/reuse health, and shared-buffer calibration recommendations, and transferred binary output buffers for live processing
- generic parameter editor sessions
- opt-in file grant broker foundation with path-free browser responses
- native worker IPC limits for command size, pending commands, stdout/stderr lines, diagnostics, startup, timeout, termination, live per-render deadlines, bounded `render_timeout` deadline-budget diagnostics, and fail-fast `render_quarantined` responses until instance recreation
- source-size guardrails: source, schema, config, and documentation files must stay below 800 lines (799 lines maximum), with a 750-line near-limit threshold and zero reviewed exceptions

## Near-Term Core Hosting Work

These are the next things that matter for musicians actually loading plugins.

The compatibility strategy is intentionally practical:

- VST3 gets the first deep compatibility push because it has the broadest musician-facing payoff and a more uniform host API.
- AU follows as the macOS-native path, but unsupported or unusual AU profiles should stay discovery-only until concrete examples justify a bounded host profile.
- LV2 grows by declared extension and option support, not by one-off per-plugin hacks.
- Community probe reports are expected to drive a large part of prioritization because no single developer can own enough commercial and open-source plugin test cases.

### VST3

- Expand installed-plugin compatibility testing across more vendors, instruments, effects, multi-output instruments, sidechain effects, and plugins with unusual bus layouts.
- Exercise more VST3 event-bus and channel cases, especially instruments that use multiple event buses or note-expression behavior beyond the current happy path.
- Harden remaining edge cases around SDK program lists and program data where plugins advertise support but return partial, empty, or format-specific data.
- Add focused regression fixtures for VST3 multi-bus rendering, program-data restore, note-expression text, and MIDI-controller parameter mapping.
- Keep all new VST3 work behind the existing bounds for parameter counts, program data bytes, note-expression text, bus counts, block size, and worker IPC.

### Audio Unit

- Add explicit host profiles for AU offline render effects instead of keeping them discovery-only.
- Add dedicated profiles for AU units that need advanced splitter, mixer, or format-converter lifecycles beyond the currently supported realtime utility profiles.
- Expand AU MIDI and transport compatibility against more instrument and effect units.
- Add AU-specific fixtures for multi-input, multi-output, offline render, preset/state restore, and host-callback behavior.
- Keep unsupported AU profiles discovery-only until each profile has a bounded lifecycle, layout contract, and smoke coverage.

### LV2

- Add LV2 UI hosting through a separate native UI broker, not inside the daemon.
- Decide which additional LV2 extensions become core support and implement them one at a time with explicit feature structs, byte caps, and compatibility tests.
- Improve Turtle parsing coverage without adding GPL dependencies to the core.
- Add fixtures for more LV2 extension combinations, including plugins with richer atom data, unusual port groups, and stricter block-size requirements.
- Keep unsupported `lv2:requiredFeature` and `opts:requiredOption` declarations discovery-only until the matching host contract exists.

## Native Editor And File Workflows

Generic parameter editors work today. Native plugin UI is intentionally still a controlled roadmap item.

- Implement the real platform UI broker for VST3, AU, and LV2 editor windows.
- Keep native editor windows out of the daemon process.
- Preserve explicit opt-in flags for file dialogs, clipboard, drag/drop, and any UI surface that can move data between plugin code and the host.
- Add browser-visible capability reporting for native editor features only after the broker enforces the policy.
- Expand file-grant operations beyond `loadPreset`, `restoreState`, and `saveStateDirectory` only as operation-specific adapter work.
- Add grant-backed `loadSample`, cache access, and license-file workflows only with explicit purpose/access/kind constraints and path-free browser responses.
- Treat vendor preset formats as plugin-specific file workflows, not generic browser-provided paths.

## Browser And Transport Work

The current worker-owned WebSocket audio path is good for correctness and demos. It now avoids the page thread, uses initial `SharedArrayBuffer` rings sized from the live in-flight, output-queue, and latency bounds where browser isolation allows them, wakes the transport worker with `Atomics.waitAsync`/`notify` where supported, uses a 1 ms timer poll fallback where atomic waits are unavailable, pauses shared pumps while disconnected, bounds browser audio requests at the configured in-flight limit and timeout, applies the same request timeout to page-fallback processing, suppresses stale worker responses after request deadlines, overwrites the oldest shared input/output blocks with newest live audio under shared ring pressure, recycles worklet input/output buffers and transport-worker shared-input copy buffers, avoids extra binary-output cloning, reports fresh shared transport status on render diagnostics and audio error/timeout paths, reports native render duration plus response deadline lead/jitter in render blocks and samples, updates plugin latency from render diagnostics into live rack and AudioNode health, maps daemon-side `render_timeout` and `render_quarantined` errors into the live timeout policy and Web Audio `process-timeout` health/events, blocks same-node AudioNode retries against quarantined native instances, exposes a bounded host-provided AudioNode recreate controller for timeout cooldowns, proactively raises bounded output latency under sustained deadline pressure, inserts controlled safety blocks when latency grows after misses, shared-output pressure, or host retargeting, and adapts plus recovers output latency within host-configured bounded blocks, but it is not the final low-latency transport.

- Tune the `SharedArrayBuffer` ring path for sustained live sets, including measured ring-depth policy, underrun recovery, fallback timer behavior, and jitter thresholds that feed the rack and AudioNode calibration helpers.
- Refine daemon/native worker render quarantine beyond first-cut per-render deadline termination and one rack-level auto-recreate attempt, especially host policy for plugins that are usable after occasional misses but should not respawn indefinitely.
- Extend latency compensation from host-readable sample and millisecond health into more scheduling examples and monitoring UIs.
- Keep the protocol transport abstraction open for WebRTC data channels, shared-memory helpers, or desktop-host transports.
- Keep the same pairing, origin, session, instance, and resource-limit model across browser and local desktop hosts.

## Remote Collaboration Profile

Remote collaboration is a promising future use case, especially when two people are working from different machines and only one machine has a licensed local plugin installed. It must be treated as a separate profile from the default loopback daemon. The current daemon must not be exposed directly to a LAN or the public internet.

A future remote profile should support:

- short-lived invite links or pairing codes that identify both the requesting app origin and the remote collaborator
- TLS or an authenticated relay instead of raw public WebSocket exposure
- per-collaborator roles, such as listen-only, parameter control, MIDI input, or render/export permission
- explicit local approval prompts before any remote collaborator can scan, instantiate, control, hear, or render through local plugins
- path-free metadata, state, preset, and file-grant responses, with file grants remaining local and owner-approved
- clear license posture: plugins execute only on the machine where they are installed and authorized; SoundBridge does not transmit plugin binaries or local license material to collaborators
- revocation, auditing, quotas, and rate limits suitable for long-lived collaborative sessions
- WebRTC or another jitter-aware media path for collaborator monitoring, separate from the bounded plugin-control protocol

## Desktop And Cross-Platform Work

The reference implementation is macOS-first today.

- Package and sign the macOS bridge daemon.
- Add a production first-run approval UX instead of the development token prompt.
- Notarize the macOS build and document installation/update behavior.
- Add Windows VST3 hosting support.
- Add Linux VST3 and LV2 hosting support.
- Keep Audio Unit support macOS-only.
- Define how JUCE-based desktop hosts can talk to the same worker boundary instead of loading third-party plugins directly into the app process.

## Compatibility And Release Testing

- Maintain an installed-plugin compatibility matrix by format, vendor, plugin type, and feature coverage.
- Keep `npm run probe:installed` as the repeatable local compatibility harness.
- Make community-submitted probe reports the primary way to discover real-world compatibility gaps, especially for paid VST3/AU plugins that cannot be committed as fixtures.
- Use [Plugin compatibility reports](compatibility-reports.md) as the GitHub request format for plugin-specific support work.
- Never require contributors to upload commercial plugin binaries, licenses, local filesystem paths, or private preset/sample data.
- Add more native fixtures for edge cases that cannot run in CI with commercial plugins.
- Track pass/fail separately for scanning, instantiation, parameters, preset snapshots, program data, state, file grants, MIDI, transport, rendering, bus layouts, latency, tail, and editor behavior.
- Convert repeated community failures into small synthetic fixtures whenever the failing behavior can be reproduced without proprietary plugin code.
- Keep CI focused on source-size guardrails, security smoke tests, worker IPC limits, and broker contracts.

## Documentation And Standardization

- Keep README focused on quick-start hosting from a website.
- Keep protocol docs normative about payload shapes, limits, ownership, and per-format behavior.
- Keep security docs explicit about the trust boundary crossed by browser and desktop hosts.
- Keep [release readiness](release-readiness.md) explicit about compatibility terms, matrix evidence, and protocol evolution.
- Document why applications should use an auditable open bridge instead of opaque localhost helpers.
- Publish the native editor broker, file grant broker, and worker IPC contracts clearly enough for independent implementations.

## Extended Sandboxed Worker Profile

OS-level plugin sandboxing is a serious future endeavor, but it is an extended security profile beyond the core compatibility target. A sandbox can improve containment for malicious or untrusted plugins, enterprise deployments, public machines, and stricter app-distribution environments, but it may also break ordinary commercial plugin behavior that depends on license managers, caches, sample libraries, helper services, or vendor authorization state already present in the user's account.

SoundBridge should describe these as explicit capability levels rather than a single universal endpoint:

- `compatibility-worker`: plugin DSP runs in a separate worker process under the normal user environment, similar to current desktop DAWs; the browser still sees only the bounded SoundBridge protocol.
- `brokered-files`: user-visible file workflows use explicit grants and path-free browser responses, while plugin-internal license/cache behavior may continue to use the normal user environment.
- `native-editor-broker`: native UI is isolated from the daemon behind a separate broker with explicit policy for file dialogs, clipboard, drag/drop, focus, and attached grants.
- `sandboxed-worker`: plugin workers run under an OS containment policy that narrows filesystem and process access where the platform can enforce it.
- `network-restricted-worker`: sandboxed workers also restrict outbound network access where the platform supports it.

Future sandboxing work should evaluate:

- macOS App Sandbox and seatbelt profiles for worker processes.
- Windows AppContainer, job objects, restricted tokens, and filesystem/network policy options.
- Linux namespaces, seccomp, Landlock, Bubblewrap, or Flatpak-style isolation.
- How to keep plugin crashes isolated to the worker process in every profile.
- How web apps and JUCE-based local hosts can select the same worker-boundary profiles without changing the protocol semantics.

## Done Criteria

SoundBridge is ready to call production-grade for the core compatibility profile when:

- a normal developer can install the bridge, pair a site, scan plugins, create VST3/AU/LV2 instances, and process audio without reading internal docs
- common commercial and open-source VST3/AU/LV2 plugins work through the compatibility probe, including render-duration and render-budget evidence
- live Web Audio and host-owned rack paths fail dry after bounded render-budget misses, sustained transport pressure, or audio/render failures and expose health plus budget-trip/timeout events for host retry policy
- native editor and file workflows are brokered, opt-in, and path-free from the browser perspective
- all host adapters have smoke coverage for malformed input, oversized payloads, ownership violations, and worker failure
- the build ships with platform packaging, update, signing, and first-run approval UX
- sandboxed-worker and network-restricted-worker modes are documented as extended profiles that do not block the core compatibility release, but remain real future work for stricter deployments
