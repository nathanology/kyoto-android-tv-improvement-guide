# AGENTS.md: playbook for AI coding agents

You are helping a person speed up their Android TV or Google TV with `kyoto`. This file tells you exactly what to run, what to ask them, and what never to do. Humans should read [docs/GUIDE.md](docs/GUIDE.md) instead; it covers the same steps in prose.

The person is technical but may not know Android internals. Explain each change in one plain sentence before proposing it.

## Rules (non-negotiable)

1. **Never run a command with `--apply` for `debloat`, `tune` or `home set` yourself.** After the change, kyoto asks whether the TV remote still works, and only the person holding the remote can answer. kyoto exits with code 3 if you try from a non-interactive shell. Show the dry run, then give the exact `--apply` command to the person to run in their own terminal window, and wait for them to report back.
2. **Never uninstall anything** (`pm uninstall`, `adb uninstall`) and never run raw `pm disable*`, `settings put` or `appops` commands over adb. Every change goes through kyoto, which snapshots first and can roll back.
3. **Never edit `cli/guard.ts` or pass `--allow` to get past a refusal** unless the person explicitly asks for that specific package after you explain the risk. A guard refusal (exit code 2) is the tool working as designed.
4. **Ask before disabling any app the household might use.** Only catalog entries with risk `safe` may be marked without asking. `optional` entries are apps: list them and ask which ones anyone in the household watches. `caution` entries switch off a system feature: explain the note and ask.
5. **One batch at a time.** Do not start the next batch until the person confirms the previous one committed and the TV behaves normally.
6. **Never commit or share `state/`.** It holds the TV's serial, android_id and MAC addresses. Do not open pull requests or push anything to the upstream repo without the person's explicit consent.
7. If anything is unclear or unexpected, stop and ask. Do not guess with someone's TV.

## Exit codes

| Code | Meaning | What you do |
|---|---|---|
| 0 | OK | Continue |
| 1 | Error, or a batch was reverted | Read the message. A reverted batch is safe; see Troubleshooting |
| 2 | Guard refused a package | Remove that package from the batch (`kyoto mark <pkg> --keep`), then re-run the dry run |
| 3 | Needs a human | Hand the printed command to the person |

## Playbook

Run all commands from the repository root. `bun kyoto <command>` runs the CLI. Commands marked **[human]** need the person.

### 0. Get the code and tools

```sh
git clone https://github.com/nathanology/tvos-diy-improvement-guide kyoto && cd kyoto
bun --version     # need ≥ 1.1. Install: curl -fsSL https://bun.sh/install | bash   (Windows: see https://bun.sh)
adb version       # Install: macOS `brew install --cask android-platform-tools`
                  #          Debian/Ubuntu `sudo apt install adb`   Windows `winget install Google.PlatformTools`
bun install
```

### 1. Enable debugging on the TV **[human]**

Give the person these steps:

- **Android TV:** Settings → Device Preferences → About → select **Build** 7 times. Then Settings → Device Preferences → Developer options → turn on **USB debugging**.
- **Google TV:** Settings → System → About → select **Android TV OS build** 7 times. Then Settings → System → Developer options → turn on **USB debugging**.
- Find the TV's IP address: Settings → Network & Internet → (your network).

On most TVs USB debugging also opens adb over the network on port 5555. Some newer Google TV devices (Android 12+) use **Wireless debugging** instead: the person turns it on in Developer options, chooses "Pair device with pairing code", and you run `adb pair <ip>:<pairing-port>` with the code shown on screen. Then connect to the IP and port shown under Wireless debugging (not 5555).

### 2. Connect

```sh
bun kyoto connect <tv-ip>:5555
```

- "The TV hasn't authorized this Mac": **[human]** accept *Allow USB debugging?* on the TV and tick *Always allow from this computer*, then re-run.
- "Can't reach the TV": TV must be on (not standby) and on the same network. Check the IP.
- On success, kyoto prints the model and either selects a matching profile or suggests `kyoto init <name>`.

```sh
bun kyoto doctor --json
```

Note `manufacturer`, `model`, `device`, `android`, `home`, `profile` and `interrupted`. If `interrupted` is non-empty, a previous batch was cut off: tell the person and offer `bun kyoto rollback --batch <label>` (dry run first).

### 3. Pick or create a profile

```sh
bun kyoto profiles --json
```

- If a profile has `matchesThisTv: true`, it is already active. Read its `profile.json` notes to the person.
- Otherwise create one. Use `<manufacturer>-<device>` in lowercase as the name (kyoto prints a suggestion):

```sh
bun kyoto init <name>                    # e.g. tcl-sabrina; all packages start as "keep"
bun kyoto init <name> --from <profile>   # copy decisions from a similar TV's profile
```

### 4. Measure first (recommended)

```sh
bun kyoto measure --quick   # ~1.5 minutes, no reboot; saves state/measurements/quick-<time>.json
```

Tell the person the free memory and the number of low-memory kills. More than a handful of kills during the run means memory pressure, which is the problem kyoto fixes. For publishable numbers use `bun kyoto measure` (reboots, ~25 minutes).

### 5. Decide what to disable

```sh
bun kyoto suggest --json
```

Each entry has `pkg`, `label`, `risk`, `note`, `suggestedBatch`, and the current `decision`. Present them to the person in three groups:

- **safe** (batch 1): demo/store/hotel modes and similar. Recommend all of them.
- **optional** (batch 2): preinstalled apps. Ask: "Which of these does anyone in your household use?" Disable only the ones they say nobody uses.
- **caution** (batch 3): system features (recommendations, screensaver, Chromecast built-in). Read each note and ask.

Then write the decisions:

```sh
bun kyoto suggest --write                                    # marks every "safe" entry for batch 1
bun kyoto mark <pkg> <pkg>... --batch 2 --reason "unused"    # the optional apps they chose
bun kyoto mark <pkg> --batch 3 --reason "no casting"         # caution items they agreed to
bun kyoto mark <pkg> --keep --reason "we watch it"           # record deliberate keeps too
```

Packages that are not in the catalog stay "keep". If the person wants to disable something else, look up what it is first and explain it. Never mark a package because its name looks unfamiliar.

### 6. Apply batch by batch

For N = 1, 2, 3 (skip batches with nothing marked):

```sh
bun kyoto debloat --batch N            # dry run: show the plan to the person
```

Then hand over **[human]**:

> In your own terminal, in the kyoto folder, with the TV remote in hand, run:
> `bun kyoto debloat --batch N --apply`
> When it asks whether the remote still works, try Home, the arrows, OK and volume, then answer `y` or `n`. Tell me what it printed at the end.

After they report back:

```sh
bun kyoto doctor --json    # "committed" should now include debloat-N; "interrupted" should be empty
```

If the batch was reverted, see Troubleshooting before retrying.

### 7. Tune settings

```sh
bun kyoto tune             # dry run. The default tune.json halves UI animation speeds
```

Hand over **[human]** `bun kyoto tune --apply`, as in step 6.

To stop an app running in the background without disabling it, add it to `restrictBackground` in the profile's `tune.json`. This does not stop apps that provide a live-TV input (Pluto TV is the known case); disable those instead.

### 8. Optional: Kyoto Home launcher

Explain that this replaces the home screen with a minimal list of apps and saves 100–200 MB of memory, and that it is reversible with `kyoto home restore`. Ask whether they want it.

Get the APK: download `kyoto-home.apk` from the repo's latest GitHub release, or build it (needs JDK 17 and the Android SDK, with `ANDROID_HOME` set):

```sh
(cd launcher && ./gradlew assembleRelease)    # → launcher/app/build/outputs/apk/release/app-release.apk
adb -s <serial> install -r <path-to-apk>
```

Set the app list (ask which apps they want, in order; at most 10 fit on screen):

```sh
cp launcher/apps.example.txt state/apps.txt   # edit state/apps.txt; find package names with `adb shell pm list packages -3`
bun kyoto home apps state/apps.txt
bun kyoto home set com.kyoto.home/.HomeActivity   # dry run
```

Hand over **[human]** `bun kyoto home set com.kyoto.home/.HomeActivity --apply`.

If kyoto then warns that another system HOME took over, read "Launcher" in [docs/GUIDE.md](docs/GUIDE.md) with the person. Do not disable more system packages on your own.

### 9. Measure again and report

```sh
bun kyoto measure --quick
bun kyoto compare state/measurements/<before>.json state/measurements/<after>.json
```

Only compare runs of the same variant (`quick` with `quick`). Summarize: free memory before/after, low-memory kills before/after, and the app launch times.

### 10. Offer to share (only with consent)

If this TV had no profile before, offer to help the person contribute `profiles/<name>/` and any new catalog knowledge upstream (see [CONTRIBUTING.md](CONTRIBUTING.md)). Before opening a PR, make sure no file under `state/` is included and that measurement JSON copied into `docs/case-study/` contains no serial numbers.

## Undo

```sh
bun kyoto rollback --batch N            # dry run: what undoing batch N would restore
bun kyoto rollback --batch N --apply --yes
bun kyoto rollback --all --apply --yes  # back to how the TV was before kyoto's first change
bun kyoto home restore --apply --yes    # stock launcher back
```

Rollback only undoes kyoto's own changes, so you may run it with `--yes` once the person has asked to undo. Rolling back batch N also undoes any later batches.

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `unauthorized` | TV hasn't accepted this computer | **[human]** accept the prompt on the TV; re-run |
| `Can't reach the TV` | TV asleep, IP changed, or debugging switched off | Wake the TV; check IP; `bun kyoto connect <ip>:<port>` |
| `more than one device` | Several adb devices | `bun kyoto connect <ip>:<port>` pins one; or set `ANDROID_SERIAL` |
| Batch reverted: "app checks failed" | A disabled package was needed by an app | Disable the batch's packages in smaller groups (split with `kyoto mark --batch`) to find it; mark that one `--keep` and add the finding to the catalog |
| Batch reverted: "no answer before timeout" | Nobody answered within 90 s | Re-run; `--confirm-timeout 300` gives more time |
| Batch reverted: "remote check answered no" | Remote/voice/Bluetooth broke | Same as app checks: bisect the batch |
| Exit 2 / "Refusing to touch protected packages" | Guard | `kyoto mark <pkg> --keep`; do not use `--allow` without the person's informed request |
| Settings skipped: "this TV doesn't have that setting" | Key absent on this firmware | Harmless; kyoto never creates settings |
| After a firmware update things came back | OTA re-enabled packages or reset HOME | `bun kyoto doctor`, then re-run each batch (idempotent) |
| TV unusable and adb lost | Should not happen (lifeline guard) | Factory reset from the TV's recovery menu restores everything kyoto changed |

## Working on the code

If the person asks you to change kyoto itself:

```sh
bun test              # unit tests against FakeTv (no TV needed)
bun run typecheck
KYOTO_LIVE=1 bun test test/live --timeout 600000   # optional, needs a TV; uses a harmless canary package
```

- Every TV interaction goes through `AdbLike` (`cli/adb.ts`), so tests swap in `FakeTv` (`test/fake-tv.ts`). Add FakeTv handlers for any new shell command.
- Every mutation goes through `runBatch` (`cli/batch.ts`): guard → snapshot → apply → verify → confirm → commit or revert. Do not add mutation paths that skip it.
- `profiles/*` and `catalog/packages.json` are validated by `test/profiles.test.ts`; keep it passing.
- Command reference, file formats and exit codes: [docs/REFERENCE.md](docs/REFERENCE.md).
