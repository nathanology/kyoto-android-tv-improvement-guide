## What

<!-- New profile? Catalog entries? Code change? -->

## Checklist

- [ ] `bun test` and `bun run typecheck` pass
- [ ] Nothing from `state/` is included; no serials, android_id or MAC addresses anywhere
- [ ] New profile: `description` and `notes` filled in, every `disable` entry has a `reason`
- [ ] New catalog entries: `note` says what you lose; file stays sorted
- [ ] Code change touching the TV: goes through `runBatch`, FakeTv handles any new command, tests added
