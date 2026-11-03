# The kyoto guide: make a slow Android TV fast again

This guide takes you from a sluggish TV to a fast one in about an hour, most of it waiting for measurements. Every step is reversible. If you would rather have an AI coding agent drive, point it at [AGENTS.md](../AGENTS.md); it follows the same steps and asks you at each decision.

1. [Understand the problem](#1-understand-the-problem)
2. [Set up your computer and TV](#2-set-up-your-computer-and-tv)
3. [Connect and pick a profile](#3-connect-and-pick-a-profile)
4. [Measure](#4-measure)
5. [Decide what to disable](#5-decide-what-to-disable)
6. [Debloat in batches](#6-debloat-in-batches)
7. [Tune settings](#7-tune-settings)
8. [Launcher](#8-launcher)
9. [Measure again](#9-measure-again)
10. [Undo anything](#10-undo-anything)
11. [Troubleshooting](#11-troubleshooting)
12. [Things kyoto doesn't do](#12-things-kyoto-doesnt-do)

## 1. Understand the problem

Android TVs ship with little memory (1.5–2 GB is common) and a lot of software that runs all the time: the stock launcher with its preview rows, recommendation services, free-channel apps that register live-TV inputs, store-demo and hotel modes. When you open Netflix, Android's **low-memory killer** (LMK) makes room by killing other processes. Then:

- switching back to an app you just used is a full cold start (seconds), not a resume (~80 ms);
- apps look like they "crash" when they were in fact evicted;
- the stock launcher itself is evicted and redraws slowly when you press Home.

A faster CPU wouldn't help, and you can't change the CPU anyway. On the reference TV the CPU already ran at its 1.8 GHz maximum during launches and its frequency controls are locked. What you *can* do without rooting is stop software from running: disable packages you don't use, restrict background apps, and replace the stock launcher with a light one.

kyoto's job is to do that safely: measure, change a little, verify, and undo automatically if anything breaks.

## 2. Set up your computer and TV

### On your computer

| Tool | Why | Install |
|---|---|---|
| [Bun](https://bun.sh) ≥ 1.1 | runs the kyoto CLI | macOS/Linux: `curl -fsSL https://bun.sh/install \| bash` · Windows: see bun.sh |
| adb (platform-tools) | talks to the TV | macOS: `brew install --cask android-platform-tools` · Debian/Ubuntu: `sudo apt install adb` · Windows: `winget install Google.PlatformTools` |
| git | gets the code | usually preinstalled |

```sh
git clone https://github.com/nathanology/tvos-diy-improvement-guide kyoto
cd kyoto
bun install
bun test        # optional: 120+ unit tests, no TV needed
```

Run every `bun kyoto …` command from this folder.

### On the TV

**Turn on Developer options.**

- *Android TV:* Settings → Device Preferences → About → select **Build** 7 times.
- *Google TV:* Settings → System → About → select **Android TV OS build** 7 times.

**Turn on debugging.** In the new Developer options menu (under Device Preferences or System):

- Turn on **USB debugging**. On most TVs this also opens adb over the network on port 5555.
- If your TV instead has **Wireless debugging** (common on newer Google TV devices): turn it on, choose *Pair device with pairing code*, and on your computer run `adb pair <tv-ip>:<pairing-port>` and type the code. Use the IP and port shown under Wireless debugging (not 5555) in the next step. This port can change after a reboot.

**Find the TV's IP address:** Settings → Network & Internet → your network.

## 3. Connect and pick a profile

```sh
bun kyoto connect 192.168.1.50:5555
```

The TV shows *Allow USB debugging?* Tick **Always allow from this computer** and accept. Run the command again if it timed out.

kyoto now knows your TV's manufacturer, model and device codename. It looks for a **profile** in `profiles/` that matches:

- **A profile matches:** kyoto selects it. Read its `profile.json` notes. Its keep/disable decisions are someone else's household's, so review them in step 5.
- **No profile matches:** create one. kyoto prints a suggested name.

  ```sh
  bun kyoto init my-tv                                     # every package starts as "keep"
  bun kyoto init my-tv --from hisense-huangshan            # or copy decisions from a similar TV
  ```

  This writes `profiles/<name>/` with three files:

  | File | Contents |
  |---|---|
  | `profile.json` | which TV it's for (`match`), which apps to test after each change (`checkApps`) and to time in measurements (`measureApps`) |
  | `packages.json` | every package on the TV with a `keep` or `disable` decision and a batch number |
  | `tune.json` | settings to change and apps to restrict in the background |

Check everything with:

```sh
bun kyoto doctor
```

## 4. Measure

Measure before changing anything, so you know whether the changes helped.

```sh
bun kyoto measure --quick      # ~1.5 min, no reboot. Good enough to see the problem.
bun kyoto measure              # ~25 min: reboots, settles 5 min, two passes. For numbers you'll publish.
```

A measurement records free memory (`MemAvailable`) three times, launches your `measureApps` (default Netflix and YouTube) several times from cold, and counts low-memory kills during the run. Results go to `state/measurements/`.

How to read them:

- **Low-memory kills > 0 during a quick run** means you have memory pressure, which is what kyoto fixes.
- **Free memory** below about 400 MB on a 2 GB TV means apps will be evicted as soon as you open something large.
- Cold-start times mostly reflect the chip and will not move much. What improves is how often you *get* a cold start.

You can also keep a running log of crashes and kills; kyoto polls it whenever it connects:

```sh
bun kyoto crashes
```

## 5. Decide what to disable

```sh
bun kyoto suggest
```

`suggest` matches the packages on your TV against the shared [catalog](../catalog/packages.json) and groups them by risk:

| Risk | What it is | Batch | Default |
|---|---|---|---|
| **safe** | No user-facing loss: retail demo, store mode, hotel mode, Play Games hub | 1 | disable |
| **optional** | Preinstalled apps: free-channel apps, music, sports, other streaming | 2 | disable only the ones nobody in the house uses |
| **caution** | System features: recommendation rows, Ambient Mode screensaver, Chromecast built-in | 3 | read the note, then decide |

Mark your decisions:

```sh
bun kyoto suggest --write                                          # every "safe" entry → batch 1
bun kyoto mark tv.pluto.android com.xumo.xumo.tv --batch 2 --reason "nobody watches"
bun kyoto mark com.google.android.apps.mediashell --batch 3 --reason "we never cast"
bun kyoto mark com.tubitv --keep --reason "kids watch it"
```

You can also edit `profiles/<name>/packages.json` by hand. Rules of thumb:

- Big background users are the ones worth disabling. Free-channel apps (Pluto TV, Xumo, VIDAA Channels) are the worst offenders, because they register live-TV inputs that the system starts at boot. On the reference TV, Pluto TV alone held ~91 MB.
- If you don't know what a package is, leave it as keep. Look it up first.
- kyoto will refuse anything on its lifeline or protected lists at apply time (see [REFERENCE.md](REFERENCE.md#guard)), so a mistake here can't break networking or the remote.

## 6. Debloat in batches

Small batches make problems easy to find: if a batch breaks something, kyoto reverts it and you know the culprit is in that batch.

```sh
bun kyoto debloat --batch 1             # dry run: prints the plan, changes nothing
bun kyoto debloat --batch 1 --apply
```

With `--apply`, kyoto:

1. checks every package against the guard and refuses lifeline/protected ones;
2. snapshots the TV's state;
3. disables the packages (`pm disable-user`, immediate, no reboot);
4. launches your `checkApps` and confirms each reaches the screen without crashing;
5. asks: **Does the TV remote still work?** Try Home, the arrows, OK and volume, then type `y`. Anything else, or no answer within 90 s, reverts the batch.

Then batch 2, then batch 3. Use the TV normally for a while between batches.

Options:

- `--confirm-timeout 300` gives you 5 minutes to answer.
- `--reboot-check` also reboots and re-checks before committing. First confirm adb survives a reboot on your TV with `bun kyoto doctor --reboot-probe`.

## 7. Tune settings

```sh
bun kyoto tune
bun kyoto tune --apply
```

The default `tune.json` halves Android's three animation scales, which makes menus feel noticeably snappier. Settings your TV doesn't have are skipped, never created.

`restrictBackground` in `tune.json` stops an app running in the background without disabling it (it still works when you open it):

```json
{ "pkg": "com.example.app", "reason": "only opened occasionally" }
```

This doesn't work for apps that provide a live-TV input: the TV input framework restarts them anyway. Disable those instead.

**Picture settings** aren't changed by kyoto. Most of them don't affect speed, but motion smoothing ("Motion Enhancement", "MEMC", "TruMotion") adds input lag and the soap-opera look. Filmmaker Mode, where available, turns off most processing in one step. The reference TV's before/after picture settings are in [the case study](case-study/hisense-huangshan/picture-settings.md).

## 8. Launcher

The stock launcher is often the biggest memory user on the TV (136–266 MB on the reference TV). Kyoto Home is a replacement that uses ~25–35 MB: a list of your apps, HDMI inputs, all apps, settings, and a clock. The remote's voice button still opens Google voice search.

### Install

Download `kyoto-home.apk` from the [latest release](https://github.com/nathanology/tvos-diy-improvement-guide/releases/latest), or build it yourself (JDK 17 and the Android SDK, `ANDROID_HOME` set):

```sh
cd launcher && ./gradlew assembleRelease && cd ..
# → launcher/app/build/outputs/apk/release/app-release.apk
```

```sh
adb install -r kyoto-home.apk
```

> Release APKs are signed with a CI key. If you built one yourself before, `adb uninstall com.kyoto.home` first (signatures differ).

### Choose your apps

Copy `launcher/apps.example.txt`, edit it (one `package|Label` per line, top to bottom, at most 10), and push it:

```sh
cp launcher/apps.example.txt state/apps.txt
adb shell pm list packages -3                 # package names of installed apps
bun kyoto home apps state/apps.txt
```

### Make it the home screen

```sh
bun kyoto home set com.kyoto.home/.HomeActivity          # dry run
bun kyoto home set com.kyoto.home/.HomeActivity --apply
```

kyoto first checks Kyoto Home opens, sets it as the preferred HOME, then disables the current stock launcher, because stock launchers are high-priority system HOMEs that override your preference. The change goes through the same snapshot, check and confirm steps as a batch.

**If kyoto warns that another system HOME took over:** some TVs have a second fallback HOME (on Google TV devices, often the setup app `com.google.android.tungsten.setupwraith`). kyoto won't disable it for you, because it's on the protected list. Your options are to keep the stock launcher (`bun kyoto home restore --apply`) or, at your own risk, add that package to a batch and run it with `--allow <pkg>`. It's still reversible with `rollback`. Please report what you find in an issue.

Using it: up/down moves through the list; down from the last row reaches HDMI inputs, all apps, settings, and the light/dark toggle.

Undo: `bun kyoto home restore --apply`.

## 9. Measure again

```sh
bun kyoto measure --quick
bun kyoto compare state/measurements/quick-<before>.json state/measurements/quick-<after>.json
```

Only compare runs of the same kind; kyoto refuses to compare `quick` with `fresh`. The numbers to watch are low-memory kills (should drop to 0–1) and free memory (should rise by hundreds of MB).

## 10. Undo anything

```sh
bun kyoto rollback --batch 2              # dry run: what undoing batch 2 would restore
bun kyoto rollback --batch 2 --apply      # undoes batch 2 and anything after it
bun kyoto rollback --batch tune --apply
bun kyoto home restore --apply
bun kyoto rollback --all --apply          # the TV as it was before kyoto's first change
```

Rollback restores from snapshots in `state/snapshots/`. It only touches what kyoto changed and is safe to run twice. Keep `state/` if you might want to undo later. Without it you can still re-enable any package by hand with `adb shell pm enable <pkg>`.

If all else fails, a **factory reset** re-enables every disabled package and resets every setting. kyoto never removes anything that a reset can't restore.

## 11. Troubleshooting

**`unauthorized`:** accept the debugging prompt on the TV with *Always allow* ticked. If it never appears, toggle USB debugging off and on.

**`Can't reach the TV`:** the TV must be fully on, not in standby. Check the IP hasn't changed (consider a DHCP reservation on your router). With Wireless debugging, the port changes after reboots; reconnect with the new one.

**A batch reverted because an app check failed:** one of the batch's packages was needed. Split the batch (`kyoto mark <pkgs> --batch 4` for half of it) and apply the halves separately until you find the culprit. Mark it `--keep`, and please add what you learned to the catalog.

**A batch reverted because of the remote check:** same approach. Remote, voice and Bluetooth packages are protected by default, so this points to a vendor-specific helper. Report it.

**Something came back after a firmware update:** OTA updates can re-enable packages or reset HOME. Run `bun kyoto doctor`, then re-run each batch; they're idempotent.

**Netflix or another app says the device isn't supported / plays in SD:** DRM packages are protected, so kyoto shouldn't cause this. `bun kyoto measure` records the Widevine level; compare before and after. Roll back the last batch and report it.

**`doctor` says a batch was interrupted:** the computer or network dropped mid-batch. The snapshot was taken before any change: `bun kyoto rollback --batch <label> --apply`.

## 12. Things kyoto doesn't do

- **Root, flash or unlock anything.** Everything uses the standard debugging interface.
- **Uninstall.** Disabled packages stay on the system partition and come back with a factory reset.
- **Speed up the CPU or GPU.** On a locked TV you can't change their clocks, and you don't need to.
- **Block ads inside apps.** Use your router's DNS for that.
- **Phone home.** kyoto talks only to your TV. Nothing leaves your network.
