// Live E2E against the real TV. Skipped unless KYOTO_LIVE=1 (`bun run test:live`).
// Uses one harmless canary package and a throwaway state dir; every test must leave
// the TV exactly as it found it (asserted against a snapshot taken at the start).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adb } from "../../cli/adb";
import { readLog, rollback, runBatch } from "../../cli/batch";
import { measure } from "../../cli/measure";
import { type Snapshot, diffSnapshots, takeSnapshot } from "../../cli/snapshot";

const LIVE = process.env.KYOTO_LIVE === "1";
const CANARY = process.env.KYOTO_CANARY ?? "com.google.android.videos"; // Google Play Movies, discontinued
const CHECK_APPS = ["com.netflix.ninja", "com.google.android.youtube.tv"];
const answer = (a: string | null) => async () => a;

function serial(): string {
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL;
  const d = JSON.parse(readFileSync(new URL("../../state/device.json", import.meta.url), "utf8"));
  return d.serial;
}

describe.skipIf(!LIVE)("live TV", () => {
  let adb: Adb;
  let dir: string;
  let start: Snapshot;
  const none = { settingsKeys: [], appPkgs: [] };

  beforeAll(async () => {
    adb = new Adb(serial());
    dir = mkdtempSync(join(tmpdir(), "kyoto-live-"));
    start = await takeSnapshot(adb, "live-start");
    expect(start.disabled).not.toContain(CANARY);
  });

  afterAll(async () => {
    // Belt and braces: whatever happened, make sure the canary is enabled again.
    await adb.shell(`pm enable ${CANARY}`).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  const assertUnchanged = async () => {
    const now = await takeSnapshot(adb, "live-now");
    expect(diffSnapshots(start, now, none)).toEqual([]);
  };

  test("dry run changes nothing", async () => {
    const r = await runBatch({ adb, label: "live-dry", actions: [{ kind: "disable", pkg: CANARY }], apply: false, prompt: answer("y"), checkApps: CHECK_APPS, stateDir: dir, reapplyCommand: "-" });
    expect(r.status).toBe("dry-run");
    await assertUnchanged();
  });

  test("canary batch → 'n' → restored and verified", async () => {
    const r = await runBatch({ adb, label: "live-n", actions: [{ kind: "disable", pkg: CANARY }], apply: true, prompt: answer("n"), checkApps: CHECK_APPS, stateDir: dir, reapplyCommand: "-", log: console.log });
    expect(r.status).toBe("reverted");
    expect(r.restoreFailures).toEqual([]);
    await assertUnchanged();
  });

  test("as-is measurement produces a valid record", async () => {
    const m = await measure(adb, { variant: "as-is", apps: ["com.netflix.ninja"], runs: 1, memSamples: 1 });
    expect(m.memAvailableMedianKb).toBeGreaterThan(0);
    expect(m.coldStartMs["com.netflix.ninja"]?.runs.length).toBe(1);
    expect(m.fingerprint).toContain("Hisense");
  });

  test("committed canary batch → rollback → TV matches the starting snapshot", async () => {
    const r = await runBatch({ adb, label: "live-y", actions: [{ kind: "disable", pkg: CANARY }], apply: true, prompt: answer("y"), checkApps: CHECK_APPS, stateDir: dir, reapplyCommand: "-" });
    expect(r.status).toBe("committed");
    expect((await takeSnapshot(adb, "mid")).disabled).toContain(CANARY);
    const entry = (await readLog(dir)).find((e) => e.label === "live-y" && e.event === "started")!;
    const rb = await rollback({ adb, snapshotPath: entry.snapshot!, scope: entry.scope!, apply: true, prompt: answer("y"), stateDir: dir, label: "rollback-live-y" });
    expect(rb).toMatchObject({ status: "restored", failures: [] });
    await assertUnchanged();
  });
});
