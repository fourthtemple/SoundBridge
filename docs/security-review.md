# SoundBridge Security Review

Reviewed: 2026-06-11. Scope: `scripts/mock-daemon.mjs` (reference daemon), `scripts/demo-server.mjs`, the native C++ host/workers under `native/bridge-daemon/`, `packages/web-client/`, and the protocol/security docs.

The architecture and stated threat model are sound, and several controls are already implemented well (see *What's already good*). The findings below are the gaps between the documented model and the reference code, ordered by severity. Because this is intended to become an auditable open standard, I flag both exploitable bugs and places where the *spec* should mandate a control so downstream implementers don't reinvent it weakly.

> **Status: all findings below have been remediated** in the daemon (`scripts/mock-daemon.mjs`), the native C++ workers, the protocol schema, and the docs. A regression test (`scripts/security-smoke.mjs`, `npm run smoke:security`) exercises the fixes against a live daemon — 21/21 checks pass, including the previously fatal DoS now returning in ~0 ms with bounded output. The original findings are retained below for the audit trail.

## Summary

| # | Severity | Issue | Location |
|---|----------|-------|----------|
| 1 | High | Unbounded audio sizing → daemon memory-exhaustion DoS | `mock-daemon.mjs` `createInstance` / `processAudioBlock` |
| 2 | Medium | No DNS-rebinding / `Host`-header defense; origin allowlist empty by default | `mock-daemon.mjs` HTTP + upgrade handlers |
| 3 | Medium | Pairing token: non-constant-time compare, no rate limit / lockout | `mock-daemon.mjs` `pair` |
| 4 | Low | Native arg parsing (`stoul`/`stod`) unguarded → uncaught exception / `terminate` | `main.cpp`, `ExampleInstrumentBundleMain.cpp` |
| 5 | Low | `jsonEscape` omits control chars `< 0x20` → invalid JSON from scanner | `NativePlugin.cpp` |
| 6 | Low | Predictable `instanceId` (`inst-1`, `inst-2`, …) | `mock-daemon.mjs` |
| 7 | Low | No daemon-wide session cap (only per-origin) | `mock-daemon.mjs` `pair` |
| 8 | Low | No normative payload schema; per-field validation is ad hoc | protocol + daemon |
| 9 | Info | Spec doesn't mandate resource limits / input validation | `docs/protocol.md`, `docs/security.md` |

---

## 1. High — Unbounded audio sizing crashes the daemon

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

**Fix.** Validate and clamp at the trust boundary, rejecting out-of-range values instead of coercing:

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

## 2. Medium — No DNS-rebinding defense; default-open origin allowlist

The HTTP server and the `upgrade` handler build a URL from `request.headers.host` but never validate it, and `ALLOWED_ORIGINS` is empty by default (so `originAllowlist: false`). "Bind to loopback" is necessary but not sufficient: a public site `evil.example` can use **DNS rebinding** (rebind its name to `127.0.0.1`) so the victim's browser opens `ws://evil.example:47370/bridge` against the local daemon. The browser still sends the true `Origin: http://evil.example`, but with no default allowlist the *only* barrier left is the pairing token. For a localhost companion app this is the classic break, and the documented "malicious website tries to scan installed plugins" threat is exactly this actor.

**Fix.** Reject any HTTP request or WS upgrade whose `Host` header isn't `127.0.0.1`, `localhost`, or `[::1]` (optionally with the expected port) — cheap and stops rebinding cold:

```js
function hostAllowed(h) {
  const host = String(h ?? "").replace(/:\d+$/, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}
// in upgrade handler and the http handler:
if (!hostAllowed(request.headers.host)) { socket.destroy(); return; }
```

Also make the spec say production daemons MUST ship a non-empty origin allowlist and/or the native per-origin approval prompt; the reference should warn loudly when the allowlist is empty.

## 3. Medium — Pairing token compare is timing-unsafe and unthrottled

`if (payload.pairingToken !== PAIRING_TOKEN)` is a short-circuiting compare, and there's no limit on `pair` attempts per connection/origin. The default token is 144 bits of `randomBytes`, so brute force is impractical *today* — but (a) an open standard will be re-implemented by people who pick weaker/static tokens, and (b) `SOUNDBRIDGE_PAIRING_TOKEN` explicitly allows a fixed token. Make the reference exemplary:

```js
import { timingSafeEqual } from "node:crypto";
function tokenEquals(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
```

Add a small per-connection failed-`pair` counter that closes the socket after N (e.g. 5) misses, and rate-limit new connections. The spec should require constant-time comparison and attempt throttling.

## 4. Low — Unguarded `stoul`/`stod` in native arg parsing

In `main.cpp` (`--render-example-block`) and `ExampleInstrumentBundleMain.cpp`, `std::stoul`/`std::stod` run without try/catch. Malformed or out-of-range input throws `std::invalid_argument` / `std::out_of_range`, which is uncaught and calls `std::terminate`. Arguments are daemon-generated today (so not directly web-reachable), but a standard shouldn't specify a parser that aborts on bad input. Wrap conversions, clamp the results, and fail the one render rather than the process.

## 5. Low — `jsonEscape` leaves control characters unescaped

`jsonEscape` (`NativePlugin.cpp`) handles `\ " \n \r \t` but emits other bytes `< 0x20` verbatim, producing invalid JSON. Plugin names/paths/vendor strings come from third-party bundles on disk; a crafted name with an embedded control byte makes the scanner's JSON unparseable, breaking `JSON.parse` of `--scan-installed` output in the daemon (a denial of *scanning*). Escape all `< 0x20` as `\u00XX` (and ideally `U+2028`/`U+2029`).

## 6. Low — Predictable instance IDs

`instanceId = \`inst-${++instanceSeq}\`` is a global monotonic counter, so IDs are guessable across sessions. Cross-session access is correctly denied in `getInstance` via `ownerSessionToken`, so this isn't exploitable on its own — but random IDs (`crypto.randomUUID()`) are cheap defense-in-depth so a future slip in an ownership check can't be combined with ID guessing.

## 7. Low — No daemon-wide session ceiling

`MAX_SESSIONS_PER_ORIGIN` caps per origin, but nothing caps total sessions. With the default empty allowlist, many distinct origins (or subdomains) can accumulate sessions and memory. Add a global session cap alongside the per-origin one.

## 8. Low — No normative payload schema

Validation is ad hoc per command (`Number(...)`, `Array.isArray(...)`). It mostly holds, and `setState` notably avoids prototype-pollution (it only reads known parameter ids via `Object.hasOwn`), but the protocol doc defines no normative schema, so each implementation will validate differently. Define a JSON Schema per command (types, required fields, numeric ranges) in `packages/protocol/schema` and validate every inbound envelope against it before dispatch.

## 9. Info — Spec should mandate resource limits and input validation

`docs/security.md` covers origin/session/instance controls but not input hardening. Add a normative "Resource limits & input validation" section: max channels, max block size, sample-rate range, max frames per block, max in-flight blocks per instance, constant-time token compare, `Host`-header validation, and attempt throttling. That turns findings #1–#3 into requirements every conforming daemon must meet.

---

## What's already good

Worth keeping as-is: loopback-only bind enforced with an explicit, loud opt-out; sessions bound to both the connection and the `Origin`; instance ownership enforced with `instance_access_denied`; session-owned workers destroyed on disconnect; per-session and total instance quotas; WebSocket message-size cap applied *before* pairing; `hello` minimized before pairing. The demo server's static handler is well hardened (`realpath` + served-prefix allowlist + dotfile rejection). All native subprocesses are launched with argument arrays (`execFileSync`/`spawn`), so there's no shell-injection surface. `setState` avoids prototype pollution. The web client takes its origin from `location.origin` (unforgeable in-browser) and doesn't persist the token, and the demo ships `COOP`/`COEP`.

## Suggested fix order

1. Clamp/validate audio sizing in `createInstance` + `processAudioBlock` and mirror it in the native workers (#1).
2. Add `Host`-header validation and warn on empty allowlist (#2).
3. Constant-time token compare + `pair` throttling (#3).
4. Harden native parsing and `jsonEscape`; random instance IDs; global session cap (#4–#7).
5. Publish a normative schema + resource-limits section so the standard carries the controls (#8, #9).
