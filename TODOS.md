# TODOS

## Clean before/after measurement
- **What:** Roll back all changes, take a `fresh` measurement (2 passes), re-apply debloat batches 1–3, `tune` and `home set`, then measure again with the same protocol.
- **Why:** The current before/after numbers were captured with different protocol versions (v1 baseline, v2/quick afterwards), so speed comparisons are indicative only.
- **Depends on:** Someone at the TV to confirm the remote after each batch (~1 hour).

## Package descriptions from UAD-NG
- **What:** Count how many Universal Android Debloater (UAD-NG) list entries match `kyoto inventory` output. If they cover at least 25% of system packages, add an advisory join that pre-fills descriptions in `packages.json`.
- **Why:** Saves research time when curating the debloat profile.
- **Note:** UAD-NG's lists are phone-focused and likely cover few Hisense/MediaTek TV packages, which is why this was left out.

## Re-run after firmware updates
- **What:** After a Hisense OTA, run `kyoto doctor` and `kyoto debloat --batch N` (idempotent) in case the update re-enabled packages or reset HOME.
