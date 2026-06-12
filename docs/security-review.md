# SoundBridge Security Review

Reviewed: 2026-06-12. Scope: `scripts/mock-daemon.mjs` (reference daemon), `scripts/demo-server.mjs`, the native C++ host/workers under `native/bridge-daemon/`, `packages/web-client/`, and the protocol/security docs.

This file is an audit trail, not an active bug backlog. The original security findings are retained below so future readers can see what was reviewed and how the project responded. Unless an item appears in **Open Roadmap Items**, it has already been fixed.

## Status Snapshot

| Area | Status | Notes |
| --- | --- | --- |
| Original findings #1-#9 | Fixed | Remediated in the daemon (`scripts/mock-daemon.mjs`), native C++ workers, protocol schema, and docs. |
| Regression coverage | Passing | `npm run smoke:security` exercises the fixes against a live daemon. Last recorded result: 176/176 checks passing. |
| Installed-plugin compatibility probe | Passing | `npm run probe:installed` starts a temporary paired loopback daemon with an explicit origin allowlist and bounded request sizes so real VST3/AU/LV2 create/state/MIDI/render/layout and profile-aware automation checks can be repeated without weakening the production security model. `SOUNDBRIDGE_PROBE_NATIVE_EDITOR_BROKER=1` also checks native editor broker open/close behavior against those installed instances. Last recorded hostable result: 72/72 plugins passing. |
| Example render argument hardening | Fixed | Example render entry points reject unknown example plugin ids before numeric argument parsing. |
| VST3/AU opaque state | Fixed | Native state is bounded, opaque, plugin-id bound, and restored through worker processes. |
| VST3/AU latency reporting | Fixed | Native workers report plugin latency through the shared protocol, and the daemon bounds transport and reported totals. |
| VST3/AU tail-time reporting | Fixed | Native workers report bounded tail time through the shared protocol, including explicit infinite-tail metadata for VST3. |
| VST3/AU layout reporting | Fixed | Native workers report bounded negotiated channel and per-bus layout metadata through the shared protocol, and instance metadata reflects the effective channel counts. |
| Basic LV2 audio/control hosting | Fixed | The native LV2 worker loads bundle-local dynamic libraries through the LV2 C ABI, bounds TTL metadata, exposes control ports as parameters, renders audio, reports bounded standard latency output ports, reports bounded `pg:group` main bus layouts with aggregate/per-port fallback, and reports conservative tail metadata. |
| LV2 discrete control metadata | Fixed | Compatible LV2 controls marked as toggled, integer, or enumeration expose bounded step metadata and quantize normalized writes before values reach plugin ports. |
| LV2 control-port state | Fixed | Compatible basic LV2 audio/control plugins now save and restore bounded opaque worker state for known input control ports. |
| LV2 portable and file-backed extension state | Fixed | Compatible LV2 `state:interface` plugins can save and restore bounded POD+portable properties keyed by URI; file-backed state is supported only through brokered relative paths and capped embedded file bytes. |
| LV2 atom MIDI delivery | Fixed | Compatible LV2 atom/event MIDI input ports receive bounded note, CC, pitch-bend, pressure, and program events through worker-owned LV2 atom sequence buffers. |
| LV2 worker extension scheduling | Fixed | Compatible LV2 plugins that require `work:schedule` and expose `work:interface` receive bounded synchronous worker callbacks with copied request/response bodies, count caps, byte caps, `work_response`, and `end_run` delivery inside the worker process. |
| LV2 bounded block-size profiles | Fixed | Compatible LV2 plugins that require `buf-size:boundedBlockLength`, `buf-size:fixedBlockLength`, `buf-size:powerOf2BlockLength`, and `options#options` receive bounded instance options before instantiation. Fixed/power-of-two profiles are hostable only when `maxBlockSize` and each render block satisfy the declared profile; mid-block parameter automation is rejected for those restricted profiles. |
| LV2 required-feature and option gating | Fixed | The LV2 scanner detects unsupported `lv2:requiredFeature` and `opts:requiredOption` declarations and keeps those bundles discovery-only so the daemon does not launch a worker without the feature or option contract the plugin declared. |
| Public plugin class metadata | Fixed | Scanners expose bounded path-free metadata such as bundle identifiers, AudioComponent tuples, versions, LV2 URIs, and LV2 UI declaration summaries while keeping launch paths in internal diagnostics. |
| Scanner manifest integer parsing | Fixed | VST3/AU/LV2 example-manifest numeric fields use bounded non-throwing parsing so oversized bundle-provided values cannot terminate scanning. |
| Brokered VST3 factory metadata | Fixed | Installed VST3 listings can refine public `name`, `vendor`, `category`, `kind`, and `version` through a short-lived factory probe that returns bounded path-free metadata and keeps launch paths in internal diagnostics. |
| Bounded parameter automation events | Fixed | The protocol and daemon reject oversized automation batches, validate parameter ids/values/sample offsets, enforce instance ownership, and forward bounded events to native workers. |
| Bounded parameter display-text input | Fixed | `setParameterDisplayValue` caps plugin display text, rejects NUL and read-only targets before worker dispatch, preserves instance ownership, and routes VST3/AU parsing through worker-local format APIs before applying the normal bounded parameter path. |
| Bounded parameter automation curves | Fixed | `setParameterCurve` accepts bounded step/linear per-block curves, rejects oversized or ambiguous point lists, expands them under the existing worker event cap, and preserves instance ownership. |
| Bounded timeline automation lanes | Fixed | `setAutomationLane` stores strictly ordered absolute-sample lanes for known writable parameters, caps lane and point counts, applies only points inside bounded `processAudioBlock.transport.samplePosition` blocks, caps render-block expansion, and preserves instance ownership. |
| Read-only parameter write protection | Fixed | `setParameter`, `setParameterEvents`, `setParameterCurve`, and `setAutomationLane` reject read-only parameters before worker dispatch, while `setPreset` and daemon-managed `setState` snapshots skip read-only live parameters. |
| Generic editor broker sessions | Fixed | `openEditor` / `closeEditor` now provide bounded generic parameter editor sessions with per-session/global caps, TTLs, instance ownership checks, path-free plugin snapshots, and cleanup on instance/session teardown. |
| Per-plugin editor surface disclosure | Fixed | Public plugin listings now expose a bounded `editorKinds` array so hosts can show generic and native editor actions per plugin without probing private launch data. Installed hostable VST3/AU/LV2 plugins advertise `native-window`, but `openEditor` still requires a configured broker, a session-owned instance, and native-host launch data that stays out of browser responses. |
| Native editor broker contract | Fixed | Native editor sessions remain disabled by default and are advertised only when an explicit separate UI broker process is configured. The daemon spawns the broker without a shell, applies worker stdout/stderr/command/timeout limits, keeps native launch details and attached file-grant paths inside daemon-to-broker IPC, sends only grants attached to the owning instance, and tears broker sessions down with editor/session/instance cleanup. |
| Native editor UI surface policy | Fixed | Broker-reported file-dialog, clipboard, and drag/drop capabilities are denied by default and become browser-visible only when the daemon is started with explicit native-editor allow flags. The effective policy is advertised in `hello.capabilities.security`, while open/close ownership and broker IPC limits still apply. |
| Session-scoped file grant broker foundation | Fixed | `createFileGrant` / `listFileGrants` / `revokeFileGrant` stay disabled unless explicit broker roots are configured; pathless grants require an explicit native approval broker and browser-supplied path strings require explicit development opt-in. When enabled, grants validate absolute paths through `realpath`, reject outside-root paths and symlink escapes, enforce per-session/global caps and TTLs, clean up on session teardown, and return only path-free opaque grant metadata to browsers. |
| Instance-scoped file grant attachments | Fixed | `attachFileGrant` / `listInstanceFileGrants` / `detachFileGrant` let a paired host bind opaque file grants to a session-owned plugin instance without returning paths. Attachment requires ownership of both the instance and the grant, enforces optional purpose/access/kind constraints, caps attachments per instance, and removes stale revoked/expired grants from instance listings. |
| Native worker file-grant operation boundary | Fixed | `useFileGrant` lets a paired host ask a compatible worker to consume an already attached grant for an explicit known operation. The daemon validates instance ownership, grant ownership, instance attachment, operation-derived purpose/access/kind constraints, and worker support before resolving the absolute path; generic `other` operations must also supply explicit purpose/access/kind constraints. Browser responses stay path-free, and absolute paths are sent only through bounded daemon-to-worker IPC. The reference VST3/AU/LV2 workers now implement bounded `restoreState` from granted worker-native state files, bounded `loadPreset` from granted worker-native preset-state files, and bounded `saveStateDirectory` writes into granted state directories; unsupported operations still fail closed. |
| Per-plugin file-grant operation disclosure | Fixed | Public plugin listings now expose a bounded `fileGrantOperations` array for hostable native VST3/AU/LV2 plugins, currently advertising only `loadPreset`, `restoreState`, and `saveStateDirectory` where those worker paths exist. Host UIs can hide unsupported file workflows before grant creation, while the daemon still rejects unadvertised or unsupported operations at `useFileGrant`. |
| Bounded VST3 unit/program metadata and data | Fixed | VST3 parameters expose capped SDK unit metadata where `IUnitInfo` provides it; program-change parameters are marked; associated and plugin-level program-list names are exposed only as capped display metadata, with selection still routed through validated `setParameter` calls. Supported SDK program data is exported and restored only for daemon-listed program ids/indexes, remains opaque base64, is plugin-id bound through a SoundBridge envelope, and is capped before it reaches the host or worker. |
| LV2 UI declaration metadata | Fixed | The LV2 scanner exposes only bounded, path-free UI declaration metadata such as UI type labels and counts. Native LV2 UI code is still not loaded or hosted. |
| Bounded preset snapshot application | Fixed | `setPreset` applies only daemon-listed bounded parameter snapshots by preset id, skips unknown live parameters, enforces instance ownership, and does not accept browser-supplied preset files or arbitrary parameter maps. |
| Bounded richer MIDI events | Fixed | The protocol and daemon reject oversized MIDI batches and validate note, CC, pitch-bend, pressure, program, channel, and timing fields before worker dispatch; native workers keep per-format MIDI behavior bounded. |
| Bounded VST3 note-expression values/text | Fixed | VST3 workers expose capped `INoteExpressionController` metadata and accept bounded value-style and text-style note-expression events with explicit note ids; the daemon rejects malformed values/text, caps text bytes, and rejects note-expression events for non-VST3 workers. |
| VST3 bus-aware audio blocks | Fixed | The protocol accepts bounded indexed input bus buffers, the VST3 worker routes them into active SDK buses, and responses include bounded indexed output bus buffers. |
| VST3 per-bus speaker arrangement negotiation | Fixed | The VST3 worker attempts bounded SDK speaker-arrangement negotiation for every reported audio bus, reads back bounded accepted bus channel counts, and falls back to main-bus negotiation for plugins that reject full per-bus setup. |
| Explicit input-bus validation | Fixed | `processAudioBlock.inputBuses` rejects non-arrays, oversized lists, non-object bus blocks, duplicate indexes, and non-integer/out-of-range indexes before routing data reaches workers. |
| Native worker input-bus framing | Fixed | VST3, AU, and LV2 worker line-protocol parsers now reject malformed input-bus framing, duplicate bus indexes, and out-of-range bus indexes instead of silently skipping bad bus records. |
| AU/LV2 main bus buffers | Fixed | Installed AU and LV2 workers now consume explicit bounded bus-0 input buffers and return bus-0 `outputBuses` that mirror `channels`, so hosts see the same main-bus response shape across VST3/AU/LV2. |
| AU input/output-element routing | Fixed | The AU worker parses bounded indexed input-bus payloads, installs render callbacks for active CoreAudio input elements where setup succeeds, routes callback `busNumber` to the matching explicit bus buffer, and returns active CoreAudio output elements as indexed output buses. |
| LV2 port-group/per-port bus routing | Fixed | The LV2 worker parses bounded indexed input-bus payloads, honors bounded `pg:group` main input/output metadata where present, keeps aggregate/per-port routing as the fallback for older metadata, and returns bus-indexed output buffers from the same bounded bus map. |
| Bounded host transport context | Fixed | `processAudioBlock.transport` accepts bounded optional play state, tempo, time-signature, musical-position, cycle, and sample-position fields; the daemon rejects malformed values, VST3 workers re-validate before mapping to SDK `ProcessContext`, AU workers re-validate before exposing CoreAudio host callbacks, and LV2 workers re-validate before emitting atom `time:Position` events. |
| Native worker IPC startup/command/line limits | Fixed | Native workers must report ready within a bounded timeout, worker command lines plus in-flight worker command count and bytes are capped before stdin writes, worker commands must complete within bounded timeouts, native/example worker stdout response lines are capped before JSON parsing, stderr diagnostic lines are capped before logging, cumulative stderr diagnostics are budgeted per worker, and worker termination escalates to SIGKILL after a bounded grace period; oversized-command and pending-command floods reject new commands, while missing or invalid ready handshakes, timed-out commands, oversized, unterminated, malformed, or unsolicited responses, oversized diagnostic lines, and diagnostic floods reject pending commands and terminate the worker instead of stranding requests, desynchronizing IPC, or growing daemon memory/logs. |
| Worker diagnostic log sanitization | Fixed | Plugin-controlled worker stderr remains byte-budgeted and is escaped before daemon logging, and the advertised display cap prevents long diagnostic lines from forging log structure or affecting operator terminals. |
| AU realtime host-profile gating | Fixed | AU entries are classified with bounded `audioUnitHostProfile` metadata. Realtime main-bus units plus bounded realtime Apple utility profiles for format conversion, multi-source merger, and multi-output splitter are hostable through the current worker, while AU offline effects and incompatible Apple system AUAudioMix/AUMultiSplitter entries stay visible as discovery-only plugins with bounded display reasons instead of spawning incompatible workers. |
| Full plugin-hosting surface | Open roadmap | AU offline/splitter/format-converter profiles, remaining VST3 bus/program-data/note-expression edge cases, LV2 UI hosting and advanced extension support, plugin UI, and broader file access need feature-specific controls as they are implemented. |
| Third-party worker sandboxing | Last-stage hardening | Worker processes isolate crashes today, but OS-level sandboxing for malicious third-party plugin code is intentionally tracked after the core host features. |

## Open Roadmap Items

### Full VST3/AU/LV2 Hosting Surface

Full plugin hosting should be tracked as security-sensitive roadmap work, not just compatibility work. These controls apply to browser apps and local apps because both are crossing into third-party native plugin code.

| Feature | Security concern | Roadmap control |
| --- | --- | --- |
| Parameter enumeration and automation | Plugin-controlled names, units, ids, display strings, and dense automation bursts can break JSON, UI, logs, or automation paths. | Cap counts and string lengths, escape text, normalize values, bound event lists, per-block curves, stored timeline lanes, render-block lane expansion, and verify instance ownership. |
| LV2 extension support | UI and remaining extension features introduce untrusted binary callbacks, host-provided feature data, and filesystem access. | Keep unsupported LV2 extensions disabled until each one has explicit feature structs, bounds, ownership checks, file-broker rules where needed, and worker-process containment. Basic LV2 control-port state, portable POD extension state, file-backed state, atom MIDI, bounded block-size profiles, synchronous worker scheduling, and path-free UI declaration discovery are handled separately as bounded worker-owned or scanner-owned data. |
| Advanced bus routing | Bad channel, block-size, sample-rate, sidechain, or multi-output negotiation can cause large allocations or crashes. | VST3 now uses explicit bounded bus buffers and bounded per-bus SDK speaker arrangement negotiation for active buses; AU routes active input elements and active output elements through bounded indexed buses; LV2 uses bounded `pg:group` main buses with aggregate/per-audio-port fallback for ungrouped metadata. Keep the same daemon and worker limits while expanding AU utility/offline profiles and remaining format-specific bus edge cases. |
| AU offline and utility profiles | Offline effects, format converters, and splitter/mixer utilities can require different render lifecycles or multiple source/destination buses. | Supported realtime AU utility profiles are advertised explicitly, and unsupported AU profiles stay discovery-only until the daemon has bounded offline-render, advanced format-converter, splitter, or mixer profiles for each class. |
| Plugin editor/UI hosting | Native editor code exposes windowing, focus, clipboard, drag/drop, file-grant, and file-dialog surfaces. | Generic parameter editor sessions, per-plugin editor-kind disclosure, explicit broker UI-surface policy, and the opt-in broker IPC contract are bounded today, including daemon-to-broker delivery of instance-attached grants. Remaining work is the platform-specific UI broker implementation for VST3/AU/LV2 editors; keep native UI code outside the daemon and broker UI actions explicitly. |
| Preset files, samples, caches, licensing | Plugins often expect filesystem and sometimes network access. | Keep `setPreset` limited to bounded listed parameter snapshots. The daemon now has an opt-in root-limited file grant foundation, a native approval broker contract, path-free browser responses, instance-scoped file grant attachments, native-editor-broker delivery of attached grants, a bounded native-worker `useFileGrant` operation boundary, per-plugin operation disclosure, and grant-backed state restore/save plus worker-native preset-state load support in the reference VST3/AU/LV2 workers. Remaining work is arbitrary vendor preset formats plus sample/cache/license operations in each native worker and platform UI broker, while still avoiding ambient filesystem access and denying network access where the OS sandbox permits it. |

### OS-level Worker Sandboxing

SoundBridge should add an operating-system sandbox around third-party plugin worker processes as the final hardening layer after the core host features are working. On macOS, the host should evaluate App Sandbox and seatbelt-profile options, with workers receiving only the brokered audio, MIDI, parameter, and state access they need.

This is separate from the fixed findings below. The current worker-process boundary contains plugin crashes and narrows daemon blast radius, but it does not fully contain a malicious plugin.

## Resolved Findings

All findings in this section have been fixed. They remain here as the security-review audit trail.

| # | Status | Original Severity | Issue | Location |
|---|--------|-------------------|-------|----------|
| 1 | Fixed | High | Unbounded audio sizing causing daemon memory-exhaustion DoS | `mock-daemon.mjs` `createInstance` / `processAudioBlock` |
| 2 | Fixed | Medium | Missing DNS-rebinding / `Host`-header defense; origin allowlist empty by default | `mock-daemon.mjs` HTTP + upgrade handlers |
| 3 | Fixed | Medium | Pairing token compare was non-constant-time and unthrottled | `mock-daemon.mjs` `pair` |
| 4 | Fixed | Low | Native arg parsing (`stoul`/`stod`) was unguarded and could terminate the process | `main.cpp`, `ExampleInstrumentBundleMain.cpp` |
| 5 | Fixed | Low | `jsonEscape` omitted control chars `< 0x20`, producing invalid JSON from scanner output | `NativePlugin.cpp` |
| 6 | Fixed | Low | Predictable `instanceId` values (`inst-1`, `inst-2`, ...) | `mock-daemon.mjs` |
| 7 | Fixed | Low | Missing daemon-wide session cap; only per-origin cap existed | `mock-daemon.mjs` `pair` |
| 8 | Fixed | Low | Missing normative payload schema; per-field validation was ad hoc | protocol + daemon |
| 9 | Fixed | Info | Security docs did not mandate resource limits / input validation | `docs/protocol.md`, `docs/security.md` |

---

## Resolved Finding Details

The sections below preserve the original review notes and the fixes that were applied.

### Finding 1 (Fixed, High): Unbounded audio sizing crashed the daemon

`createInstance` copies client-supplied sizing fields through `Number(...)` with no bounds:

```js
sampleRate:    Number(payload.sampleRate ?? 48000),
maxBlockSize:  Number(payload.maxBlockSize ?? 128),
inputChannels: Number(payload.inputChannels ?? plugin.inputs ?? 2),
outputChannels:Number(payload.outputChannels ?? plugin.outputs ?? 2),
```

`processAudioBlock` then derives `frames` from attacker input with no ceiling (`frames = Math.max(1, channels[0]?.length ?? Number(payload.frames ?? instance.maxBlockSize ?? 128))`), and the `mock.gain` effect path pads output with an unbounded loop:

```js
while (output.length < instance.outputChannels) {
  output.push(new Array(output[0]?.length ?? 128).fill(0));
}
```

`synthesizeInstrumentBlock` has the same shape (`Array.from({ length: instance.outputChannels }, () => new Array(frames).fill(0))`).

**Impact.** A *paired* origin (i.e. anyone holding the pairing token, or XSS / a malicious script on an allow-listed origin) sets `outputChannels: 1e9` (or a huge `frames`) and sends one `processAudioBlock`. The loop allocates until the **daemon process** OOMs and dies, taking every other tab's plugin instances with it. This path is `mock.gain`, which is always hostable with **no native build required**. The existing per-session/total *instance-count* quotas don't help — the abuse is per-instance sizing, not instance count. This contradicts the documented goal "one browser host tries to exhaust local plugin worker resources."

The native VST3/AU workers are more defensive (they `std::clamp(frames, 1, maxBlockSize_)`), but `maxBlockSize_`, `inputChannels`, and `outputChannels` themselves arrive unvalidated as CLI args, so a worker can still be driven to `bad_alloc`. That crash is contained to the per-instance worker process, so it's lower impact than the in-process JS path — but it's the same root cause.

**Verified.** Replaying the exact `createInstance` + `processAudioBlock` logic, `outputChannels: 1e9 / maxBlockSize: 5e8 / sampleRate: -1` passed through unclamped and the padding loop exhausted the heap and core-dumped before any safety cap.

**Fix applied.** Validate and clamp at the trust boundary, rejecting out-of-range values instead of coercing:

```js
function uintInRange(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < min || n > max) {
    throw protocolError("invalid_argument", `value must be ${min}..${max}`);
  }
  return n;
}
// createInstance:
sampleRate:    uintInRange(payload.sampleRate ?? 48000, 8000, 384000),
maxBlockSize:  uintInRange(payload.maxBlockSize ?? 128, 1, 8192),
inputChannels: uintInRange(payload.inputChannels ?? plugin.inputs ?? 2, 0, 32),
outputChannels:uintInRange(payload.outputChannels ?? plugin.outputs ?? 2, 1, 32),
```

In `processAudioBlock`, reject `frames > instance.maxBlockSize` and `channels.length > instance.inputChannels` rather than padding to an attacker-chosen size. Apply the same bounds in the native workers before allocating. The standard should state these limits normatively (see #9).

### Finding 2 (Fixed, Medium): Missing DNS-rebinding defense; default-open origin allowlist

The HTTP server and the `upgrade` handler build a URL from `request.headers.host` but never validate it, and `ALLOWED_ORIGINS` is empty by default (so `originAllowlist: false`). "Bind to loopback" is necessary but not sufficient: a public site `evil.example` can use **DNS rebinding** (rebind its name to `127.0.0.1`) so the victim's browser opens `ws://evil.example:47370/bridge` against the local daemon. The browser still sends the true `Origin: http://evil.example`, but with no default allowlist the *only* barrier left is the pairing token. For a localhost companion app this is the classic break, and the documented "malicious website tries to scan installed plugins" threat is exactly this actor.

**Fix applied.** Reject any HTTP request or WS upgrade whose `Host` header isn't `127.0.0.1`, `localhost`, or `[::1]` (optionally with the expected port) — cheap and stops rebinding cold:

```js
function hostAllowed(h) {
  const host = String(h ?? "").replace(/:\d+$/, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}
// in upgrade handler and the http handler:
if (!hostAllowed(request.headers.host)) { socket.destroy(); return; }
```

Also make the spec say production daemons MUST ship a non-empty origin allowlist and/or the native per-origin approval prompt; the reference should warn loudly when the allowlist is empty.

### Finding 3 (Fixed, Medium): Pairing token compare was timing-unsafe and unthrottled

`if (payload.pairingToken !== PAIRING_TOKEN)` is a short-circuiting compare, and there's no limit on `pair` attempts per connection/origin. The default token is 144 bits of `randomBytes`, so brute force is impractical *today* — but (a) an open standard will be re-implemented by people who pick weaker/static tokens, and (b) `SOUNDBRIDGE_PAIRING_TOKEN` explicitly allows a fixed token. Make the reference exemplary:

```js
import { timingSafeEqual } from "node:crypto";
function tokenEquals(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
```

Add a small per-connection failed-`pair` counter that closes the socket after N (e.g. 5) misses, and rate-limit new connections. The spec should require constant-time comparison and attempt throttling.

### Finding 4 (Fixed, Low): Unguarded `stoul`/`stod` in native arg parsing

In `main.cpp` (`--render-example-block`) and `ExampleInstrumentBundleMain.cpp`, `std::stoul`/`std::stod` run without try/catch. Malformed or out-of-range input throws `std::invalid_argument` / `std::out_of_range`, which is uncaught and calls `std::terminate`. Arguments are daemon-generated today (so not directly web-reachable), but a standard shouldn't specify a parser that aborts on bad input. Wrap conversions, clamp the results, and fail the one render rather than the process.

### Finding 5 (Fixed, Low): `jsonEscape` left control characters unescaped

`jsonEscape` (`NativePlugin.cpp`) handles `\ " \n \r \t` but emits other bytes `< 0x20` verbatim, producing invalid JSON. Plugin names/paths/vendor strings come from third-party bundles on disk; a crafted name with an embedded control byte makes the scanner's JSON unparseable, breaking `JSON.parse` of `--scan-installed` output in the daemon (a denial of *scanning*). Escape all `< 0x20` as `\u00XX` (and ideally `U+2028`/`U+2029`).

### Finding 6 (Fixed, Low): Predictable instance IDs

`instanceId = \`inst-${++instanceSeq}\`` is a global monotonic counter, so IDs are guessable across sessions. Cross-session access is correctly denied in `getInstance` via `ownerSessionToken`, so this isn't exploitable on its own — but random IDs (`crypto.randomUUID()`) are cheap defense-in-depth so a future slip in an ownership check can't be combined with ID guessing.

### Finding 7 (Fixed, Low): Missing daemon-wide session ceiling

`MAX_SESSIONS_PER_ORIGIN` caps per origin, but nothing caps total sessions. With the default empty allowlist, many distinct origins (or subdomains) can accumulate sessions and memory. Add a global session cap alongside the per-origin one.

### Finding 8 (Fixed, Low): Missing normative payload schema

Validation is ad hoc per command (`Number(...)`, `Array.isArray(...)`). It mostly holds, and `setState` notably avoids prototype-pollution (it only reads known parameter ids via `Object.hasOwn`), but the protocol doc defines no normative schema, so each implementation will validate differently. Define a JSON Schema per command (types, required fields, numeric ranges) in `packages/protocol/schema` and validate every inbound envelope against it before dispatch.

### Finding 9 (Fixed, Info): Spec did not mandate resource limits and input validation

`docs/security.md` covers origin/session/instance controls but not input hardening. Add a normative "Resource limits & input validation" section: max channels, max block size, sample-rate range, max frames per block, max in-flight blocks per instance, constant-time token compare, `Host`-header validation, and attempt throttling. That turns findings #1–#3 into requirements every conforming daemon must meet.

---

## What's already good

Worth keeping as-is: loopback-only bind enforced with an explicit, loud opt-out; sessions bound to both the connection and the `Origin`; instance ownership enforced with `instance_access_denied`; session-owned workers destroyed on disconnect; per-session and total instance quotas; WebSocket message-size cap applied *before* pairing; `hello` minimized before pairing. The demo server's static handler is well hardened (`realpath` + served-prefix allowlist + dotfile rejection). All native subprocesses are launched with argument arrays (`execFileSync`/`spawn`), so there's no shell-injection surface. `setState` avoids prototype pollution. The web client takes its origin from `location.origin` (unforgeable in-browser) and doesn't persist the token, and the demo ships `COOP`/`COEP`.

## Resolution Order Used

This is the order the resolved findings were addressed in:

1. Clamp/validate audio sizing in `createInstance` + `processAudioBlock` and mirror it in the native workers (#1).
2. Add `Host`-header validation and warn on empty allowlist (#2).
3. Constant-time token compare plus `pair` throttling (#3).
4. Harden native parsing and `jsonEscape`; add random instance IDs and a global session cap (#4-#7).
5. Publish a normative schema plus resource-limits section so the standard carries the controls (#8, #9).
