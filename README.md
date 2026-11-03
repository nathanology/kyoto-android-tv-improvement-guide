# tvos

Make a Hisense Android TV fast and simple again, from a Mac, without rooting it.

Two parts:

- **`kyoto`**: a CLI (Bun + TypeScript) that talks to the TV over adb. It measures the TV, disables unused packages in reversible batches, tunes settings, swaps the home screen, and rolls any of it back.
- **Kyoto Home** (`launcher/`): a minimal Android TV launcher inspired by Dieter Rams' work for Braun. It's a text-only list of apps beside a T 3–style speaker grille and a clock, in dark (default) and light themes. Framework Views only, no dependencies, about 25–35 MB in memory versus 136–266 MB for the stock launcher.

![Kyoto Home](docs/kyoto-home-dark.png)

## Why

The target TV is a 2023 Hisense (Android TV 10, MediaTek MT5895, **2 GB RAM**). Apps appeared to crash constantly. In fact the low-memory killer was evicting them: a single YouTube launch killed 8 background processes, including Netflix. The stock launcher was the largest memory user on the device. The fix is freeing memory, not making the CPU faster. The CPU already runs at its 1.8 GHz maximum during launches, and its frequency controls are locked.

## Results

| | Before | After |
|---|---|---|
| Home screen (PSS) | 136–266 MB | 23–33 MB |
| Background apps disabled | — | ~225 MB of resident memory (Pluto TV, VIDAA, Twitch, recommendations) |
| Low-memory kills per measurement | 5–15 | 0–1 |
| Netflix / YouTube cold start | 355–406 / 527–667 ms (spikes to 1.16 s) | 390 / 558 ms |

Cold-start times are roughly unchanged, since they're bound by the SoC and the apps. The gain is that apps now stay resident, so returning to one is a hot start (~80 ms) instead of a full relaunch. The before and after runs used different protocol versions; see `TODOS.md`.

## Setup

1. On the TV: Settings → Device Preferences → About → press **Build** 7 times, then turn on **USB debugging** in Developer options. On this model that also exposes adb over Wi-Fi on port 5555.
2. On the Mac:
   ```sh
   brew install --cask android-platform-tools
   bun install
   bun cli/main.ts connect <tv-ip>:5555   # accept the prompt on the TV, tick "Always allow"
   ```

## Usage

Every mutating command is a dry run unless `--apply` is passed.

```sh
bun cli/main.ts doctor [--reboot-probe]          # connection, device info, interrupted batches
bun cli/main.ts measure --quick                  # ~80 s; or full: measure [--no-reboot] [--repeat N]
bun cli/main.ts compare <before.json> <after.json>
bun cli/main.ts inventory                        # write the TV's packages to profiles/…/packages.json
bun cli/main.ts debloat --batch 1 [--apply]      # disable packages marked for batch 1
bun cli/main.ts tune [--apply]                   # settings + background restrictions from tune.json
bun cli/main.ts home set com.kyoto.home/.HomeActivity [--apply]
bun cli/main.ts home restore --apply             # give HOME back to the stock launcher
bun cli/main.ts rollback (--batch LABEL | --all) [--apply]
bun cli/main.ts crashes                          # crash + low-memory-kill log
```

### Safety model

- **Disable, never uninstall.** Every change is reversible with `pm enable`, and a factory reset is the worst case.
- **Snapshot before every batch:** disabled packages, all three settings namespaces, and appops/standby buckets for touched apps. `rollback` diffs the live TV against a snapshot and restores the difference. Restores are idempotent.
- **Guard** (`cli/guard.ts`), checked before every mutation:
  - *Lifeline* packages are never touched, with no override: the network stack, adb shell, System UI, settings, package installer and the active HOME. Losing any of these could cut the Mac off from the TV.
  - *Protected* packages need an exact `--allow <pkg>`: Play Services, Play Store, WebView, DRM, the remote, voice, Bluetooth, tuner/HDMI and launchers.
- **Verified batches:** after applying, the tool launches the main apps and checks they reach the foreground without crashing, then asks for a manual remote check. Anything other than `y` within the timeout reverts the batch and verifies the revert.
- **No reboot inside a batch.** `pm disable-user` takes effect immediately, and a reboot is when adb is most likely to drop.

## Kyoto Home

```sh
cd launcher
./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
bun cli/main.ts home set com.kyoto.home/.HomeActivity --apply
```

- The app list and order live in `launcher/app/src/main/res/values/strings.xml` (`home_apps`, `package[,fallback]|Label`). Missing apps are skipped.
- Up/down moves through the list, and down from the last row reaches HDMI inputs, all apps, settings and the theme toggle.
- The remote's voice button opens Google voice search as usual.
- The stock launcher is a priority-2 system HOME that outranks any user preference, so `home set` disables it (reversibly) after confirming Kyoto Home opens.

Type is Inter (SIL OFL, `launcher/FONT-LICENSE-Inter.txt`).

## Repository layout

```
cli/          kyoto CLI: adb transport, guard, snapshots, batches, measurement, crash log
test/         unit tests against FakeTv (replays real TV output in test/fixtures/)
test/live/    opt-in end-to-end tests on the real TV: KYOTO_LIVE=1 bun run test:live
profiles/     per-device package decisions and tune settings
launcher/     Kyoto Home (Android, Java)
state/        measurement summaries and the picture-settings record (raw dumps are git-ignored)
```

## Tests

```sh
bun test            # 111 unit tests
bun run typecheck
bun run test:live   # needs the TV; uses a canary package and leaves the TV as it found it
```
