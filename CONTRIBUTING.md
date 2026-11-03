# Contributing

The most useful contributions are knowledge about TVs kyoto hasn't seen yet. Code changes are welcome too.

## Add a profile for your TV

After kyoto has worked on your TV (batches committed, apps and remote fine for a few days):

1. Your profile is in `profiles/<name>/`, created by `kyoto init`. Name it `<manufacturer>-<device>` in lowercase, where `device` is `ro.product.device` (shown by `kyoto doctor`).
2. In `profile.json`, write a `description` (model, Android version, RAM if you know it, year) and any `notes` the next owner of this TV should know: debugging quirks, a second HOME that took over, packages that turned out to matter.
3. In `packages.json`, add a `reason` to every `disable` entry. Household-specific keeps ("we watch it") are fine; they tell the next person to decide for themselves.
4. Run `bun test`. `test/profiles.test.ts` validates every profile.
5. Open a pull request using the template. Include `kyoto doctor` output with the serial removed.

**Never commit anything from `state/`.** Snapshots contain your TV's android_id, serial and MAC addresses. Measurements are fine to share once copied to `docs/case-study/<name>/`: check them for serials first (`grep -i serial`).

## Add to the catalog

`catalog/packages.json` is what `kyoto suggest` draws on. An entry:

```json
{ "pkg": "com.vendor.thing", "label": "Human name", "risk": "safe", "note": "What it does and what you lose.", "seenOn": ["your-profile"] }
```

- `safe`: nobody at home loses anything (demo/store/hotel modes, factory test apps).
- `optional`: an app that some people use. Say what it is.
- `caution`: a system feature goes away (screensaver, casting, recommendations). Say exactly what.
- Add your profile to `seenOn` for an existing entry when you've disabled it without trouble.
- Found a package that **broke** something when disabled? That's valuable too: open an issue, and we'll add it to the guard's protected list.

Keep the file sorted by risk (safe, optional, caution), then by package name; the tests check it.

## Code

```sh
bun install
bun test             # unit tests against FakeTv, no TV needed
bun run typecheck
(cd launcher && ./gradlew assembleRelease lintRelease)   # JDK 17 + Android SDK
```

- Every TV interaction goes through `AdbLike` (`cli/adb.ts`); tests use `FakeTv` (`test/fake-tv.ts`), which replays real output from `test/fixtures/`. If you add a shell command, teach FakeTv to answer it.
- Every change to the TV goes through `runBatch` (`cli/batch.ts`). Don't add mutation paths around it, and don't weaken `cli/guard.ts` without an issue explaining why.
- Live tests (`KYOTO_LIVE=1 bun test test/live --timeout 600000`) run against a real TV with a harmless canary package and leave it as they found it.
- If you capture new fixtures with `kyoto capture-fixtures`, zero out serials, android_id and MAC addresses before committing (see the existing fixtures).
- Kyoto Home has no dependencies on purpose (framework Views only) to keep its memory low. Please keep it that way.

## Open tasks

- **Clean before/after measurement on the reference TV.** Roll back everything, run `kyoto measure` (fresh, 2 passes), re-apply all batches, measure again with the same protocol. The published numbers mix protocol v1 and v2.
- **Profiles for other TVs**, especially TCL, Sony, Philips, Xiaomi, Chromecast with Google TV and Google TV Streamer.
- **Google TV launcher replacement:** confirm what happens after `home set` on Google TV devices (which fallback HOME takes over) and document a safe path.
- **Windows:** confirm the CLI works end to end.
- **Re-run after firmware updates:** a `kyoto doctor` check that spots packages an OTA re-enabled and offers to re-apply.

## Conduct

Be kind and assume good faith. Help people with less experience; the guide exists for them.
