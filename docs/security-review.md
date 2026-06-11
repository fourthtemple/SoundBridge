# SoundBridge Security Review

Reviewed: 2026-06-11. Scope: `scripts/mock-daemon.mjs` (reference daemon), `scripts/demo-server.mjs`, the native C++ host/workers under `native/bridge-daemon/`, `packages/web-client/`, and the protocol/security docs.

This file is an audit trail, not an active bug backlog. The original security findings are retained below so future readers can see what was reviewed and how the project responded. Unless an item appears in **Open Roadmap Items**, it has already been fixed.

## Status Snapshot

| Area | Status | Notes |
| --- | --- | --- |
| Original findings #1-#9 | Fixed | Remediated in the daemon (`scripts/mock-daemon.mjs`), native C++ workers, protocol schema, and docs. |
| Regression coverage | Passing | `npm run smoke:security` exercises the fixes against a live daemon. Last recorded result: 21/21 checks passing. |
| Example render argument hardening | Fixed | Example render entry points reject unknown example plugin ids before numeric argument parsing. |
| Full plugin-hosting surface | Open roadmap | MIDI, parameters, state, latency, bus negotiation, plugin UI, and file access need feature-specific controls as they are implemented. |
| Third-party worker sandboxing | Open roadmap | Worker processes isolate crashes today, but OS-level sandboxing for malicious third-party plugin code is not complete. |

## Open Roadmap Items

### OS-level Worker Sandboxing

SoundBridge should add an operating-system sandbox around third-party plugin worker processes before it is presented as a hardened general-purpose plugin host. On macOS, the host should evaluate App Sandbox and seatbelt-profile options, with workers receiving only the brokered audio, MIDI, parameter, and state access they need.

This is separate from the fixed findings below. The current worker-process boundary contains plugin crashes and narrows daemon blast radius, but it does not fully contain a malicious plugin.

### Full VST3/AU/LV2 Hosting Surface

Full plugin hosting should be tracked as security-sensitive roadmap work, not just compatibility work. These controls apply to browser apps and local apps because both are crossing into third-party native plugin code.

| Feature | Security concern | Roadmap control |
| --- | --- | --- |
| MIDI event lists | Malformed or oversized event batches can stress workers or adapter code. | Validate event count, byte size, timing offsets, channel/note ranges, and reject malformed events before worker dispatch. |
| Parameter enumeration and automation | Plugin-controlled names, units, ids, and display strings can break JSON, UI, logs, or automation paths. | Cap counts and string lengths, escape text, normalize values, rate-limit automation bursts, and verify instance ownership. |
| State save/restore | State blobs are opaque plugin-controlled data and can be huge or maliciously malformed. | Enforce blob-size limits, keep blobs opaque, bind state to the producing instance/session, and never interpret state as a path or command. |
| Latency reporting | Invalid or extreme latency can break scheduling and monitoring. | Clamp to sane numeric ranges and reject negative, NaN, or extreme values. |
| Bus negotiation | Bad channel, block-size, or sample-rate negotiation can cause large allocations or crashes. | Apply hard resource limits at the daemon boundary and inside every worker before allocation. |
| Plugin editor/UI hosting | Native editor code exposes windowing, focus, clipboard, drag/drop, and file-dialog surfaces. | Host editors in a separate UI worker or broker process, never in the daemon, and broker UI actions explicitly. |
| Presets, samples, caches, licensing | Plugins often expect filesystem and sometimes network access. | Broker narrow user-approved file access, avoid ambient filesystem access, and deny network access where the OS sandbox permits it. |

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
