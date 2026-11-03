# kyoto reference

Commands, files, exit codes and internals. For a walkthrough, read [GUIDE.md](GUIDE.md).

## Commands

Run as `bun kyoto <command>` from the repository root. `--profile <name>` overrides the active profile for any command that uses one.

| Command | Changes the TV? | What it does |
|---|---|---|
| `connect [host:port]` | no | Pins the TV in `state/device.json`, checks access, selects a matching profile if none is active |
| `doctor [--reboot-probe] [--json]` | no (`--reboot-probe` reboots) | Device info, firmware, HOME, active profile, committed and interrupted batches |
| `profiles [--json]` | no | Lists profiles, the active one, and which match this TV |
| `init <name> [--from <profile>]` | no | Creates `profiles/<name>/` from the TV's package list and makes it active |
| `use <profile>` | no | Sets the active profile |
| `inventory` | no | Adds newly installed packages to the active profile as `keep` |
| `suggest [--write] [--json]` | no | Catalog entries for this TV's packages, grouped by risk. `--write` marks undecided `safe` entries for batch 1 |
| `mark <pkg>... (--batch N \| --keep) [--reason "…"]` | no | Sets decisions in `packages.json` |
| `debloat --batch N [--apply] [--allow pkg]... [--reboot-check] [--confirm-timeout S]` | with `--apply` | Disables batch N's packages as one verified batch |
| `tune [--apply] [--allow pkg]... [--confirm-timeout S]` | with `--apply` | Applies `tune.json` as one verified batch |
| `home set <pkg/.Activity> [--apply] [--confirm-timeout S]` | with `--apply` (the dry run opens the new launcher once to check it works) | Makes another launcher HOME; disables the current one |
| `home restore [--apply] [--yes]` | with `--apply` | `rollback --batch home`: also undoes batches applied after `home set` |
| `home apps <file>` | pushes a file | Sets Kyoto Home's app list |
| `rollback (--batch LABEL \| --all) [--apply] [--yes]` | with `--apply` | Returns the TV to just before batch LABEL (a number such as `2` → `debloat-2`, or `tune`, `home`), undoing it and every later batch. Uses the batch's first run since the last rollback |
| `measure [--quick \| --no-reboot] [--repeat N]` | reboots unless `--quick`/`--no-reboot` | Saves a measurement to `state/measurements/` |
| `compare <a.json> <b.json>` | no | Compares two measurements of the same variant and protocol |
| `crashes` | no | Polls and summarizes crashes, ANRs and low-memory kills |
| `capture-fixtures` | launches Netflix once | Records real TV output into `test/fixtures/` (contributors) |
| `reboot` | reboots | |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (including dry runs) |
| 1 | Error, or the batch failed/reverted |
| 2 | The guard refused a package |
| 3 | Needs a human: `--apply` without a terminal, or a rollback without `--yes` and without a terminal |

## The batch lifecycle

```
guard ──lifeline──▶ refuse, exit 2 (no override; dry runs too)
 │    ──protected w/o --allow──▶ refuse, exit 2
 ▼
plan ──(no --apply)──▶ print plan, exit 0
 │ --apply
 ▼
snapshot                  ← taken BEFORE any change; a crash mid-batch is recoverable
 ▼
apply ──adb error──▶ restore → verify → "failed"
 ▼
launch checkApps ──fail──▶ restore → verify → "reverted"
 ▼
"Remote still works? [y/N]" (90 s) ──n / timeout──▶ restore → verify → "reverted"
 │ y
 ▼
[--reboot-check: reboot → checks ──fail──▶ restore]
 ▼
committed (state/changes.log)
```

## Guard

Checked before every mutation (`cli/guard.ts`).

**Lifeline: never touched, no override.** `android`, `com.android.shell`, `com.android.systemui`, the package installers and permission controllers, `com.android.settings`, `com.android.tv.settings`, the active HOME, and any package with a name segment starting with `provider(s)`, `wifi`, `network`, `connectivity`, `netd`, `ethernet`, `dhcp` or `tethering`.

**Protected: needs `--allow <exact.package>`.** Play Services (`com.google.android.gms*`, `gsf*`), Play Store, and anything matching `*webview*`, `*widevine*`, `*drm*`, `*remote*`, `*inputmethod*`, `*katniss*` (voice), `*bluetooth*`, `*setupwraith*`, `*tvinput*`, `*tv.input*`, `*tvcenter*`, `*tuner*`, `*hdmi*`, `*cec*`, `*launcher*`.

## Files

### `profiles/<name>/profile.json`

```json
{
  "name": "hisense-huangshan",
  "description": "2023 Hisense Android TV …",
  "match": { "manufacturer": "Hisense", "device": "huangshan" },
  "checkApps": ["com.netflix.ninja", "com.google.android.youtube.tv"],
  "measureApps": ["com.netflix.ninja", "com.google.android.youtube.tv"],
  "notes": ["Anything a new owner of this TV should know."]
}
```

- `name` must equal the folder name.
- `match` keys: `manufacturer`, `brand`, `model`, `device` (the TV's `ro.product.*` properties, compared case-insensitively). Every key must match; the profile matching the most keys wins.
- `checkApps` defaults to Netflix, YouTube, Disney+ and Prime Video. Apps that aren't installed are skipped.
- `measureApps` defaults to Netflix and YouTube.

### `profiles/<name>/packages.json`

```json
{
  "device": "SmartTV 4K FFM",
  "packages": [
    { "pkg": "com.demo", "decision": "disable", "batch": 1, "system": true, "reason": "Retail demo content" },
    { "pkg": "com.netflix.ninja", "decision": "keep", "system": true, "reason": "we watch it" }
  ]
}
```

Only entries with `"decision": "disable"` are acted on, and they need an integer `batch` ≥ 1. A `reason` on a `keep` entry marks it as a deliberate decision, so `suggest --write` leaves it alone.

### `profiles/<name>/tune.json`

```json
{
  "settings": [{ "ns": "global", "key": "window_animation_scale", "value": "0.5", "reason": "…" }],
  "restrictBackground": [{ "pkg": "com.example.app", "reason": "…" }]
}
```

- `ns` is `global`, `secure` or `system`. Settings missing on the TV are skipped, never created.
- `restrictBackground` sets the app's `RUN_IN_BACKGROUND` app-op to `ignore`, and on Android 11+ (API 30) its standby bucket to `restricted`.

### `catalog/packages.json`

```json
[{ "pkg": "tv.pluto.android", "label": "Pluto TV", "risk": "optional", "note": "…", "seenOn": ["hisense-huangshan"] }]
```

- `risk`: `safe` (no user-facing loss, suggested batch 1), `optional` (an app someone may use, batch 2), `caution` (a system feature, batch 3).
- Sorted by risk, then package. Lifeline packages are rejected.

### `state/` (git-ignored, per machine)

| Path | Contents |
|---|---|
| `device.json` | Pinned serial, active profile, whether adb survives reboots |
| `snapshots/origin.json` | The TV before kyoto's first change |
| `snapshots/<label>-<time>.json` | The TV before each batch |
| `changes.log` | JSONL: started / committed / reverted / failed / rollback per batch |
| `crashes.jsonl` | Crash, ANR and low-memory-kill events, plus poll markers and gaps |
| `measurements/*.json` | Measurement results |

Snapshots contain the TV's `android_id`, serial and MAC addresses. Don't publish them.

### `launcher/apps.example.txt` and `kyoto home apps`

```
# comment
package[,fallback...]|Label
```

The first installed and enabled package on a line wins; lines where none is installed are hidden. kyoto pushes the file to `/sdcard/Android/data/com.kyoto.home/files/apps.txt`; Kyoto Home re-reads it every time it comes to the front. Without the file it uses the list in `launcher/app/src/main/res/values/strings.xml`.

## Measurement protocol (v2)

| Variant | Procedure |
|---|---|
| `fresh` (default) | reboot → wait for `sys.boot_completed` → settle 5 min → 3× `MemAvailable` 60 s apart → per app: 1 warm-up launch, then 5× (force-stop, `am start -W`, 10 s, HOME) → count LMK kills. 2 passes |
| `as-is` (`--no-reboot`) | Same, without the reboot; records uptime |
| `quick` | No reboot, 1 pass, 3 memory samples 5 s apart, warm-up + 3 runs per app, short waits (~1.5 min) |

Only runs of the same variant and protocol version are comparable; `compare` refuses otherwise and warns when the firmware changed in between.

## Environment variables

| Variable | Effect |
|---|---|
| `ANDROID_SERIAL` | Overrides the pinned serial |
| `KYOTO_LIVE=1` | Enables `test/live` (needs a TV) |
| `KYOTO_CANARY` | Package the live tests toggle (default `com.google.android.videos`) |
