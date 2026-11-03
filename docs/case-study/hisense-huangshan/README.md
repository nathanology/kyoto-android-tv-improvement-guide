# Case study: 2023 Hisense Android TV (huangshan)

The TV kyoto was built on. This page records what was wrong, what was changed and what it achieved, with the raw measurements alongside.

## The TV

| | |
|---|---|
| Model | Hisense "SmartTV 4K FFM", codename `huangshan` |
| Android | 10 (API 29), firmware `QTG3.200902.001` |
| SoC | MediaTek MT5895, 4× Cortex-A73, 32-bit userspace |
| Memory | 2 GB (1.9 GB usable) + 800 MB swap |
| Stock HOME | `com.google.android.tvlauncher` (Android TV launcher) |

## Symptom

Apps "crashed" constantly: you opened Netflix, went to YouTube, came back, and Netflix started from scratch. Menus stuttered.

## Diagnosis

The crash log (`kyoto crashes`) showed few real crashes and many **low-memory kills**. A single YouTube launch killed 8 background processes, Netflix among them. The top memory users on an idle TV ([`asis-20261031-212231.json`](measurements/asis-20261031-212231.json)) were:

| Process | Memory (PSS) |
|---|---|
| `com.google.android.tvlauncher` (stock home screen) | 266 MB |
| `system` | 127 MB |
| `com.google.android.gms` (Play Services) | 108 MB |
| `com.google.android.katniss` (voice search) | 103 MB |
| `tv.pluto.android` + its live-TV input | 92 MB |
| `com.android.tv.settings` | 66 MB |

The CPU wasn't the bottleneck. It already ran at its 1.8 GHz maximum during app launches, and its frequency governor is locked on retail firmware.

## Changes

| Batch | What | Why |
|---|---|---|
| debloat-1 | retail demo, store mode, hotel mode, B2B mode, Play Games, Play Movies, TV recommendations, Xumo, VIDAA Channels ×2 | No use at home; VIDAA Channels alone held ~88 MB |
| debloat-2 | 16 unused preinstalled apps (music, sports, other streaming services) | Several ran in the background (Twitch ~23 MB) |
| debloat-3 | Pluto TV | Background restriction didn't stop it: the TV input framework restarts its live-TV service at boot (~91 MB) |
| tune | halve the three animation scales | Snappier menus |
| home | Kyoto Home replaces the stock launcher | 266 MB → ~30 MB |

Picture settings were changed by hand; see [picture-settings.md](picture-settings.md).

The full decisions are in [`profiles/hisense-huangshan/packages.json`](../../../profiles/hisense-huangshan/packages.json). They reflect one household's viewing.

## Results

| | Before | After |
|---|---|---|
| Home screen (PSS) | 136–266 MB | 23–33 MB |
| Background memory freed by debloat | — | ~225 MB resident |
| Low-memory kills per measurement | 5–15 | 0–1 |
| Netflix / YouTube cold start (median) | 355–406 / 527–667 ms, spikes to 1.16 s | 390 / 558 ms |

**Caveat:** the "before" runs used measurement protocol v1 and the "after" runs used v2 `quick`. The memory and kill numbers are large enough that the difference is real, but cold-start times are only indicative. A clean before/after with one protocol is an open task ([CONTRIBUTING.md](../../../CONTRIBUTING.md#open-tasks)).

## Data

| File | Variant | Protocol | Notes |
|---|---|---|---|
| [asis-20261031-212231.json](measurements/asis-20261031-212231.json) | as-is | v1 | Hand-captured summary; top PSS per process |
| [fresh-20261031-213605.json](measurements/fresh-20261031-213605.json) | fresh | v1 | Hand-captured summary |
| [fresh-baseline-20261031.json](measurements/fresh-baseline-20261031.json) | fresh | v1 | Before any change |
| [fresh-2026-11-01T02-21-29.json](measurements/fresh-2026-11-01T02-21-29.json) | fresh | v1 | Mid-way; Netflix produced 1/5 usable samples (fixed by v2's warm-up launch) |
| [quick-2026-11-01T04-26-31.json](measurements/quick-2026-11-01T04-26-31.json) | quick | v2 | After debloat 1–2 + tune |
| [quick-2026-11-01T04-47-46.json](measurements/quick-2026-11-01T04-47-46.json) | quick | v2 | After all changes |
