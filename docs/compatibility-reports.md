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

JSON reports include a path-free `busProfile` for each probed plugin. Use it to call out coverage such as `effect-main`, `instrument-main`, `sidechain`, `multi-output`, and `multi-output-instrument`, plus flags for non-main-bus routing such as `sidechain-input`, `multi-input`, `multi-output`, and unusual bus indexes.

VST3 reports also include a path-free `vst3EventProfile` derived from bounded note-expression metadata. Use it to call out coverage such as `no-note-expressions`, `main-event-bus`, `non-main-event-bus`, `non-main-channel`, `text-expression`, and multi-event-bus or multi-channel fixtures without including plugin paths, preset contents, or license data.

The summary report also counts VST3 program-list metadata as `listed`, `none`, `missing`, or `skipped-format`. Use this together with `vst3ProgramData` coverage to separate plugins that expose no SDK program lists from plugins whose program-data restore path failed.

Parameter metadata coverage is reported as `listed`, `none`, `missing`, or `at-limit`. An `at-limit` result means the daemon bounded the plugin's metadata at the configured parameter cap; include it in reports because it can explain incomplete generic-editor, automation, or program-change coverage.

The summary report counts advertised `fileGrantOperations` such as `loadPreset`, `restoreState`, `saveStateDirectory`, `loadSample`, `openCacheDirectory`, `loadLicense`, and `other`. It also reports grant-backed workflow statuses for preset/state files plus sample, cache-directory, license-file, and explicit `other` vendor-preset probes when a plugin advertises those operations. Treat the advertised operation list as workflow readiness metadata and the workflow statuses as bounded probe outcomes; do not attach private preset, sample, cache, or license files to public reports.

Render-signal coverage is reported as `signal`, `silent`, or `missing`. A `silent` result means `processAudioBlock` completed and the response shape matched the negotiated layout, but the probe did not observe non-zero samples in the main channels or explicit output buses. Include it in reports when a plugin appears to load correctly but produces no audible output.

Host-transport coverage is reported as `accepted` or `missing`. An `accepted` result means the render path accepted bounded host timing context such as play state, sample position, tempo, and time signature and returned the normalized context without leaking local data. Treat it separately from automation coverage: transport can work even when there is no writable parameter lane to apply.

Matrix reports include one compact entry per probed plugin with path-redacted identity text, pass/fail status, failure phase/code, render-signal status, bus/event categories, program metadata status, automation status, host-transport status, parameter metadata status, and advertised file-grant operations. Each entry also includes a `featureStatus` object for dashboard-friendly buckets: `instantiation`, `parameters`, `presetSnapshots`, `vst3ProgramData`, `state`, `fileGrants`, `midiEvents`, `automation`, `transport`, `rendering`, `busLayouts`, `latencyTail`, and `editor`. They are meant for compatibility dashboards and triage; attach the full JSON report when maintainers need phase timings or detailed per-plugin payloads.

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
