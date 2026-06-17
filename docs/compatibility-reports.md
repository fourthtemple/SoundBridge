# Plugin Compatibility Reports

SoundBridge compatibility work depends on reports from people who own real VST3, Audio Unit, and LV2 plugins. Do not upload commercial plugin binaries, licenses, private presets, samples, or local filesystem paths. For plugin-specific support requests, submit a probe report instead.

## When To File One

Open a plugin compatibility issue when:

- a plugin scans but cannot be instantiated
- a plugin renders silence, crashes, or times out
- parameters, presets, program data, state, MIDI, transport, bus layouts, latency, tail, file grants, or editor behavior do not work
- a plugin is discovery-only and you think SoundBridge should support its host profile or LV2 extension contract

For general feature ideas, open a normal feature request. For "please support this plugin" or "this plugin fails," include a probe report.

## Generate A JSON Report

Use the narrowest format and name filter that reproduces the issue:

```sh
SOUNDBRIDGE_PROBE_REPORT=json \
SOUNDBRIDGE_PROBE_FORMATS=vst3 \
SOUNDBRIDGE_PROBE_FILTER="Plugin Name" \
npm run --silent probe:installed > soundbridge-probe-report.json
```

For Audio Units:

```sh
SOUNDBRIDGE_PROBE_REPORT=json \
SOUNDBRIDGE_PROBE_FORMATS=au \
SOUNDBRIDGE_PROBE_FILTER="Plugin Name" \
npm run --silent probe:installed > soundbridge-probe-report.json
```

For LV2:

```sh
SOUNDBRIDGE_PROBE_REPORT=json \
SOUNDBRIDGE_PROBE_FORMATS=lv2 \
SOUNDBRIDGE_PROBE_FILTER="Plugin Name" \
npm run --silent probe:installed > soundbridge-probe-report.json
```

Use `--silent` so npm does not print a banner before the JSON. If the report is too large to paste into an issue, attach the file.

## Optional Summary

For a quick local pass/fail view:

```sh
SOUNDBRIDGE_PROBE_REPORT=summary \
SOUNDBRIDGE_PROBE_FORMATS=vst3 \
SOUNDBRIDGE_PROBE_FILTER="Plugin Name" \
npm run --silent probe:installed
```

For a compact path-free JSON artifact that can feed a compatibility matrix without the full per-phase result payload:

```sh
SOUNDBRIDGE_PROBE_REPORT=matrix \
SOUNDBRIDGE_PROBE_FORMATS=vst3 \
SOUNDBRIDGE_PROBE_FILTER="Plugin Name" \
npm run --silent probe:installed > soundbridge-probe-matrix.json
```

## What To Include

In the GitHub issue, include:

- OS version
- CPU architecture
- SoundBridge commit or version
- plugin name, vendor, and version
- plugin format: VST3, AU, or LV2
- exact probe command used
- whether scanning, instantiation, rendering, parameters, presets, state, MIDI, bus layouts, editor, or file grants failed
- the JSON probe report or the relevant sanitized failure section

JSON reports include a path-free `busProfile` for each probed plugin. Use it to call out coverage such as `effect-main`, `instrument-main`, `sidechain`, `multi-output`, and `multi-output-instrument`, plus flags for non-main-bus routing such as `sidechain-input`, `multi-input`, `multi-output`, inactive input/output buses, generated bus-name fallbacks, bus metadata at the report cap, nonsequential or duplicate bus indexes, active empty buses, and unusual bus types. The profile includes bounded bus/channel counts, active and inactive bus indexes, generated-name fallback counts, and compact anomaly counts so reports can describe unusual layouts without exposing plugin launch paths.

VST3 reports also include a path-free `vst3EventProfile` derived from bounded note-expression metadata. Use it to call out coverage such as `failed`, `no-note-expressions`, `invalid-metadata`, `main-event-bus`, `non-main-event-bus`, `non-main-channel`, `text-expression`, `value-expression`, generated name fallbacks, and multi-event-bus or multi-channel fixtures without including plugin paths, preset contents, or license data. Matrix entries include bounded note-expression counts, text/value/invalid counts, invalid and defaulted route counts, associated-parameter counts, no-associated-parameter sentinel counts, generated-name fallback counts, type IDs, event-bus indexes, channels, and an explicit metadata-at-limit flag so reports can describe unusual event routing or capped partial SDK metadata without the full plugin metadata payload.

VST3 MIDI-controller and program-change event coverage is reported as `accepted`, `failed`, `missing`, or `skipped-format`. An `accepted` controller result means the bounded control-change, pitch-bend, and channel-pressure probe batch was accepted by the worker path; it does not prove that a specific plugin exposes controller-to-parameter mapping targets. Matrix entries include path-free flags plus bounded controller family counts, controller event families, CC controller numbers, channels, event-bus indexes, and defaulted or invalid number/route counts used by the probe, including multi-family and non-main bus/channel breadcrumbs when exercised. MIDI timing coverage is reported as `block-boundary`, `scheduled-offsets`, `single-offset`, `invalid-time`, `no-midi-events`, `unprofiled`, `failed`, or `missing`. Parameter profiles separately count bounded VST3 MIDI-controller mapping breadcrumbs exposed by the SDK, including mapped parameter counts, assignment counts, CC/aftertouch/pitch-bend assignment counts, duplicate assignments, invalid mapping metadata that was ignored, controller numbers, event buses, and channels.

The summary report also counts VST3 program-list metadata as `listed`, `none`, `failed`, `missing`, or `skipped-format`. VST3 program-data workflow coverage is reported as `restored`, `skipped`, `skipped-format`, `failed`, `export-failed`, `restore-failed`, or `missing`. VST3 program-data target coverage is reported as `targeted`, `unsupported`, `no-valid-programs`, `none`, `failed`, `missing`, or `skipped-format`, with path-free flags such as `program-data-unsupported`, `empty-program-list`, `invalid-program-index`, `duplicate-program-list-id`, `duplicate-program-index`, `ambiguous-program-index`, `consistent-duplicate-program-index`, `program-list-name-fallback`, `program-name-fallback`, `program-list-metadata-at-limit`, `program-metadata-at-limit`, and `bounded-target`. Matrix entries include bounded counts for unsupported, undisclosed, empty, missing-program, invalid-list, invalid-index, duplicate-list-id, duplicate-index, ambiguous duplicate-index groups, consistent duplicate-index groups, generated program-list/program-name fallbacks, and valid candidate program-data targets, plus explicit metadata-at-limit booleans and VST3 program-data byte size when export succeeds; `0` bytes can be a valid empty SDK stream. Duplicate list IDs and duplicate program indexes with missing or conflicting normalized values are ambiguous restore targets and should be treated as unsupported unless another bounded target exists. Duplicate program indexes that all resolve to the same bounded normalized value are still flagged, but the probe may use them as bounded program-data targets. Use this together with `vst3ProgramData` coverage to separate plugins that expose no SDK program lists, plugins whose program lists cannot produce bounded program data, plugins whose SDK program metadata reached report caps or required generated names, plugins that failed before program-data probing, plugins whose program-data export failed, and plugins whose program-data restore path failed.

Parameter metadata coverage is reported as `listed`, `none`, `failed`, `missing`, or `at-limit`. An `at-limit` result means the daemon bounded the plugin's metadata at the configured parameter cap; include it in reports because it can explain incomplete generic-editor, automation, or program-change coverage. Parameter profiles add path-free counts for writable, automatable, read-only, generated-name fallback, display-value, unit, program-change, VST3 MIDI mapping, and VST3 unit metadata, including generated VST3 unit-name fallbacks and VST3 unit-to-program-list links when present, with categories such as `writable`, `automation-only`, `read-only`, `listed`, `none`, `failed`, and `missing`.

Automation lane coverage is reported as `applied`, `failed`, `missing`, or a bounded `skipped-*` reason. Matrix entries include only bounded lane point counts, not parameter values.

State profiles report the native state shape without exposing state contents. VST3 state is classified as `component-controller`, `component-only`, `controller-only`, `empty`, `generic-state`, `format-mismatch`, `invalid`, `failed`, or `missing`; AU/LV2 state is classified as `single-state`, `empty`, `generic-state`, `format-mismatch`, `invalid`, `failed`, or `missing`. Matrix entries include bounded decoded byte counts for the native state parts only, so reports can distinguish split VST3 state from single-blob AU/LV2 state without attaching private presets, cache paths, samples, or license data.

The summary report counts advertised `fileGrantOperations` such as `loadPreset`, `restoreState`, `saveStateDirectory`, `loadSample`, `openCacheDirectory`, `loadLicense`, and `other`. It also reports grant-backed workflow statuses for preset/state files plus sample, cache-directory, license-file, and explicit `other` vendor-preset probes when a plugin advertises those operations. Treat the advertised operation list as workflow readiness metadata and the workflow statuses as bounded probe outcomes; `featureStatus.fileGrants` distinguishes `passed`, `advertised`, `unadvertised`, `unknown`, `skipped`, `missing`, and `failed` readiness. Do not attach private preset, sample, cache, or license files to public reports.

Render-signal coverage is reported as `signal`, `silent`, `failed`, or `missing`. A `silent` result means `processAudioBlock` completed and the response shape matched the negotiated layout, but the probe did not observe non-zero samples in the main channels or explicit output buses. Include it in reports when a plugin appears to load correctly but produces no audible output.

Output-bus signal coverage is reported as `main-signal`, `aux-signal`, `main-aux-signal`, `silent`, `failed`, `unprofiled`, or `missing`. Matrix entries include bounded signal, silent, missing, and extra output-bus counts and indexes, including which extra buses carried signal, which helps separate "the plugin renders only on an aux output" from "all negotiated output buses were silent," "a negotiated output bus was absent," or "the worker surfaced non-negotiated output buses" without exposing audio samples.

Host-transport coverage is reported as `accepted`, `failed`, or `missing`. An `accepted` result means the render path accepted bounded host timing context such as play state, sample position, tempo, and time signature and returned the normalized context without leaking local data. Treat it separately from automation coverage: transport can work even when there is no writable parameter lane to apply.

Latency/tail coverage is reported as `zero`, `latency`, `tail`, `latency-tail`, `infinite-tail`, `partial`, `failed`, or `missing`. Matrix entries include bounded plugin, transport, and reported latency sample counts plus bounded tail samples and an explicit infinite-tail flag so hosts can identify plugins that need delay compensation, release-tail handling, or conservative offline bounce windows.

Native-editor coverage is reported as `not-requested`, `opened`, `missing`, or `failed`. `not-requested` means the probe did not run with `SOUNDBRIDGE_PROBE_NATIVE_EDITOR_BROKER=1`; `opened` means the separate broker open/close path succeeded.

Matrix reports include one compact entry per probed plugin with path-redacted identity text, pass/fail status, failure phase/code, render-signal and output-bus signal status, bus/event categories, bounded bus counts/indexes, VST3 note-expression counts/indexes, VST3 MIDI-controller and program-change event status, program metadata and program-data target status, parameter and state profile status, automation status, host-transport status, latency/tail status, native-editor status, parameter metadata status, and advertised file-grant operations. Each entry also includes a `featureStatus` object for dashboard-friendly buckets: `instantiation`, `parameters`, `presetSnapshots`, `vst3ProgramData`, `state`, `fileGrants`, `midiEvents`, `automation`, `transport`, `rendering`, `busLayouts`, `latencyTail`, and `editor`. They are meant for compatibility dashboards and triage; attach the full JSON report when maintainers need phase timings or detailed per-plugin payloads.

Several matrix counters are intentionally small breadcrumbs: listed-preset parameter count, automation lane point count, MIDI/controller/program-change event counts, rendered channel count, and VST3 program-data byte size. They help group compatibility reports without exposing parameter values, audio samples, preset contents, or raw program-data bytes.

## Privacy And Safety

Before posting, remove anything private that may appear in local output. Do not include:

- commercial plugin binaries
- license files or serial numbers
- private presets, samples, sessions, cache folders, or user documents
- absolute local filesystem paths
- pairing tokens or local daemon ports if you consider them sensitive

The probe is designed to report bounded public plugin metadata, phase names, feature coverage, and failure codes. Probe error summaries redact common local path forms as `[local-path]`, including plugin bundle paths, file URLs, and Windows drive paths. If a report still contains private information, redact it before submitting.

## How Reports Are Used

Maintainers should use probe reports to:

- identify which phase failed
- group failures by format, vendor, plugin type, host profile, or LV2 extension
- decide whether the fix belongs in VST3 compatibility, AU host profiles, LV2 extension support, native editor brokering, file grants, or transport behavior
- turn repeated failures into synthetic fixtures where possible

The goal is to avoid one-off per-plugin hacks. VST3 should improve through broader SDK-host compatibility, AU through explicit host profiles, and LV2 through declared extension and option support.
