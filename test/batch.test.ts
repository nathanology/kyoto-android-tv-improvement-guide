import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Action, type LogEntry, actionCommands, batchStates, mergeScopes, readLog, rollback, rollbackTarget, runBatch } from "../cli/batch";
import { GuardError } from "../cli/guard";
import { FakeTv } from "./fake-tv";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kyoto-batch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const APPS = { "com.netflix.ninja": "com.netflix.ninja/.MainActivity", "com.google.android.youtube.tv": "com.google.android.youtube.tv/.Shell" };
const noSleep = async () => {};
const answer = (a: string | null) => async () => a;

function tv() {
  return new FakeTv({
    installed: ["tv.pluto.android", "com.google.android.tvrecommendations", "com.android.vending"],
    apps: APPS,
    settings: { global: { window_animation_scale: "1.0" }, secure: {}, system: {} },
  });
}

const disable = (...pkgs: string[]): Action[] => pkgs.map((pkg) => ({ kind: "disable", pkg }));

function opts(t: FakeTv, actions: Action[], extra: Partial<Parameters<typeof runBatch>[0]> = {}) {
  return {
    adb: t,
    label: "debloat-1",
    actions,
    apply: true,
    prompt: answer("y"),
    checkApps: [...Object.keys(APPS), "com.disney.disneyplus"],
    stateDir: dir,
    reapplyCommand: "kyoto debloat --batch 1 --apply",
    sleep: noSleep,
    ...extra,
  };
}

describe("runBatch", () => {
  test("dry run makes zero mutating calls", async () => {
    const t = tv();
    const r = await runBatch(opts(t, disable("tv.pluto.android"), { apply: false }));
    expect(r.status).toBe("dry-run");
    expect(r.plan).toEqual(["disable tv.pluto.android"]);
    expect(t.mutations()).toEqual([]);
  });

  test("guard refuses before snapshot or any mutation", async () => {
    const t = tv();
    await expect(runBatch(opts(t, disable("tv.pluto.android", "com.android.vending")))).rejects.toBeInstanceOf(GuardError);
    expect(t.mutations()).toEqual([]);
    expect(await readLog(dir)).toEqual([]);
  });

  test("the active home screen can't be disabled", async () => {
    const t = tv();
    await expect(runBatch(opts(t, disable("com.google.android.tvlauncher"), { allow: ["com.google.android.tvlauncher"] }))).rejects.toThrow(/active home screen/);
  });

  test("swapping HOME: stock launcher can be disabled only when a verified new home is named", async () => {
    const t = tv();
    t.installed.add("com.kyoto.home");
    await expect(runBatch(opts(t, disable("com.google.android.tvlauncher"), { allow: ["com.google.android.tvlauncher"] }))).rejects.toThrow(/active home screen/);
    const r = await runBatch(opts(t, disable("com.google.android.tvlauncher"), { allow: ["com.google.android.tvlauncher"], newHome: "com.kyoto.home", label: "home" }));
    expect(r.status).toBe("committed");
    expect(t.disabled.has("com.google.android.tvlauncher")).toBe(true);
    // ...and the new home is now the protected one
    await expect(runBatch(opts(t, disable("com.kyoto.home"), { allow: ["com.kyoto.home"], newHome: "com.kyoto.home" }))).rejects.toThrow(/active home screen/);
  });

  test("protected package goes through with exact --allow", async () => {
    const t = tv();
    const r = await runBatch(opts(t, disable("com.android.vending"), { allow: ["com.android.vending"] }));
    expect(r.status).toBe("committed");
  });

  test("'y' commits; snapshot + origin saved; log has started → committed", async () => {
    const t = tv();
    const r = await runBatch(opts(t, disable("tv.pluto.android", "com.google.android.tvrecommendations")));
    expect(r.status).toBe("committed");
    expect([...t.disabled].sort()).toEqual(["com.google.android.tvrecommendations", "tv.pluto.android"]);
    expect(await Bun.file(`${dir}/snapshots/origin.json`).exists()).toBe(true);
    expect(await Bun.file(r.snapshotPath!).exists()).toBe(true);
    expect((await readLog(dir)).map((e) => e.event)).toEqual(["started", "committed"]);
    expect(t.reboots).toBe(0); // no reboot inside a batch
  });

  test("'n' restores and verifies", async () => {
    const t = tv();
    const r = await runBatch(opts(t, disable("tv.pluto.android"), { prompt: answer("n") }));
    expect(r).toMatchObject({ status: "reverted", reason: "remote check answered no", restoreFailures: [] });
    expect(t.disabled.size).toBe(0);
  });

  test("timeout restores and prints the re-apply command", async () => {
    const t = tv();
    const lines: string[] = [];
    const r = await runBatch(opts(t, disable("tv.pluto.android"), { prompt: answer(null), log: (m) => lines.push(m) }));
    expect(r.status).toBe("reverted");
    expect(r.reason).toContain("timeout");
    expect(lines.join("\n")).toContain("kyoto debloat --batch 1 --apply");
    expect(t.disabled.size).toBe(0);
  });

  test("a broken dependency fails the app checks and auto-reverts", async () => {
    const t = tv();
    t.launchDependsOn = ["com.google.android.tvrecommendations"];
    const r = await runBatch(opts(t, disable("tv.pluto.android", "com.google.android.tvrecommendations")));
    expect(r.status).toBe("reverted");
    expect(r.reason).toContain("app checks failed");
    expect(t.disabled.size).toBe(0);
    expect(r.restoreFailures).toEqual([]); // after revert, checks pass again
  });

  test("a crash during checks reverts", async () => {
    const t = tv();
    t.crashOnLaunch = "com.netflix.ninja";
    const r = await runBatch(opts(t, disable("tv.pluto.android")));
    expect(r.status).toBe("reverted");
    expect(r.reason).toMatch(/isn't in the foreground|crashed/);
  });

  test("a brief connection blip mid-apply is reverted in the same run", async () => {
    const t = tv();
    t.offlineOn = /disable-user --user 0 com\.google\.android\.tvrecommendations/;
    const r = await runBatch(opts(t, disable("tv.pluto.android", "com.google.android.tvrecommendations")));
    expect(r.status).toBe("failed");
    expect(t.disabled.size).toBe(0);
  });

  test("an adb error mid-apply restores the part that was applied", async () => {
    const t = tv();
    t.failOnce = /disable-user --user 0 com\.google\.android\.tvrecommendations/;
    const r = await runBatch(opts(t, disable("tv.pluto.android", "com.google.android.tvrecommendations")));
    expect(r.status).toBe("failed");
    expect(t.disabled.size).toBe(0);
    expect((await readLog(dir)).map((e) => e.event)).toEqual(["started", "failed"]);
  });

  test("Wi-Fi drop mid-apply leaves a 'started' entry with a snapshot to roll back to", async () => {
    const t = tv();
    t.offlineOn = /disable-user --user 0 com\.google\.android\.tvrecommendations/;
    t.offlineSticky = true;
    // first disable lands, then the connection drops for good (including the revert)
    await expect(runBatch(opts(t, disable("tv.pluto.android", "com.google.android.tvrecommendations")))).rejects.toThrow("Can't reach the TV");
    const log = await readLog(dir);
    expect(log.map((e) => e.event)).toEqual(["started"]);
    expect(t.disabled.has("tv.pluto.android")).toBe(true);
    // connection comes back → rollback to the batch snapshot
    t.reconnect();
    const rb = await rollback({ adb: t, snapshotPath: log[0]!.snapshot!, scope: log[0]!.scope!, apply: true, prompt: answer("y"), stateDir: dir, label: "rollback-debloat-1" });
    expect(rb.status).toBe("restored");
    expect(t.disabled.size).toBe(0);
  });

  test("tune: settings and background restriction, then revert puts both back", async () => {
    const t = tv();
    const actions: Action[] = [
      { kind: "setting", ns: "global", key: "window_animation_scale", value: "0.5" },
      { kind: "setting", ns: "global", key: "not_on_this_tv", value: "1" },
      { kind: "restrict-bg", pkg: "tv.pluto.android" },
    ];
    const lines: string[] = [];
    const r = await runBatch(opts(t, actions, { label: "tune", prompt: answer("n"), log: (m) => lines.push(m) }));
    expect(lines.join("\n")).toContain("skip global/not_on_this_tv");
    expect(t.log).toContain("settings put global window_animation_scale 0.5");
    expect(t.log).toContain("cmd appops set tv.pluto.android RUN_IN_BACKGROUND ignore");
    expect(r.status).toBe("reverted");
    expect(t.settings.global.get("window_animation_scale")).toBe("1.0");
    expect(t.settings.global.has("not_on_this_tv")).toBe(false);
    expect(t.appops.has("tv.pluto.android")).toBe(false);
  });

  test("API < 30 never uses the restricted standby bucket", () => {
    expect(actionCommands({ kind: "restrict-bg", pkg: "p.q" }, 29)).toEqual(["cmd appops set p.q RUN_IN_BACKGROUND ignore"]);
    expect(actionCommands({ kind: "restrict-bg", pkg: "p.q" }, 30)).toContain("am set-standby-bucket p.q restricted");
  });

  test("--reboot-check reboots after 'y' and keeps the batch when checks pass", async () => {
    const t = tv();
    const r = await runBatch(opts(t, disable("tv.pluto.android"), { rebootCheck: true }));
    expect(t.reboots).toBe(1);
    expect(r.status).toBe("committed");
  });

  test("empty batch is nothing-to-do", async () => {
    expect((await runBatch(opts(tv(), []))).status).toBe("nothing-to-do");
  });
});

describe("rollback", () => {
  test("dry run lists changes without applying; cancel applies nothing", async () => {
    const t = tv();
    const r = await runBatch(opts(t, disable("tv.pluto.android")));
    const scope = { settingsKeys: [], appPkgs: [] };
    const dry = await rollback({ adb: t, snapshotPath: r.snapshotPath!, scope, apply: false, prompt: answer("y"), stateDir: dir, label: "rb" });
    expect(dry).toMatchObject({ status: "dry-run", changes: [{ kind: "pkg", pkg: "tv.pluto.android", to: "enabled" }] });
    expect(t.disabled.size).toBe(1);
    const cancelled = await rollback({ adb: t, snapshotPath: r.snapshotPath!, scope, apply: true, prompt: answer("n"), stateDir: dir, label: "rb" });
    expect(cancelled.status).toBe("cancelled");
    expect(t.disabled.size).toBe(1);
  });

  test("full rollback after debloat + tune returns packages, settings and appops to origin", async () => {
    const t = tv();
    await runBatch(opts(t, disable("tv.pluto.android")));
    await runBatch(opts(t, [{ kind: "setting", ns: "global", key: "window_animation_scale", value: "0.5" }, { kind: "restrict-bg", pkg: "com.netflix.ninja" }], { label: "tune" }));
    expect(t.appops.get("com.netflix.ninja")).toBe("ignore");
    const log = await readLog(dir);
    const scope = mergeScopes(log.flatMap((e) => (e.scope ? [e.scope] : [])));
    // origin was taken before tune, so per-app state comes from the tune snapshot (as `kyoto rollback --all` does)
    const origin = await Bun.file(`${dir}/snapshots/origin.json`).json();
    const tuneSnap = await Bun.file(log.find((e) => e.label === "tune")!.snapshot!).json();
    await Bun.write(`${dir}/merged.json`, JSON.stringify({ ...origin, apps: { ...tuneSnap.apps, ...origin.apps } }));
    const r = await rollback({ adb: t, snapshotPath: `${dir}/merged.json`, scope, apply: true, prompt: answer("y"), stateDir: dir, label: "rollback-all" });
    expect(r.status).toBe("restored");
    expect(t.disabled.size).toBe(0);
    expect(t.settings.global.get("window_animation_scale")).toBe("1.0");
    expect(t.appops.has("com.netflix.ninja")).toBe(false);
    const again = await rollback({ adb: t, snapshotPath: `${dir}/merged.json`, scope, apply: true, prompt: answer("y"), stateDir: dir, label: "rollback-all" });
    expect(again.status).toBe("nothing-to-do");
  });
});

describe("batch log", () => {
  const e = (label: string, event: LogEntry["event"], snapshot = `${label}.json`): LogEntry => ({ at: "t", label, event, snapshot });

  test("states: committed, interrupted, and rollback covers later batches", () => {
    const log = [e("debloat-1", "started"), e("debloat-1", "committed"), e("tune", "started"), e("tune", "committed"), e("debloat-2", "started")];
    expect(Object.fromEntries(batchStates(log))).toEqual({ "debloat-1": "committed", tune: "committed", "debloat-2": "started" });
    const rolled = batchStates([...log, e("rollback-tune", "rollback")]);
    expect(Object.fromEntries(rolled)).toEqual({ "debloat-1": "committed", tune: "rolled-back", "debloat-2": "rolled-back" });
    expect([...batchStates([...log, e("rollback-all", "rollback")]).values()].every((s) => s === "rolled-back")).toBe(true);
  });

  test("rollback target is the first start since the last rollback, not a re-run's newer snapshot", () => {
    const log = [e("debloat-1", "started", "a.json"), e("debloat-1", "committed", "a.json"), e("debloat-1", "started", "b.json"), e("debloat-1", "committed", "b.json")];
    expect(rollbackTarget(log, "debloat-1")).toEqual({ entry: log[0]!, index: 0 });
    const after = [...log, e("rollback-debloat-1", "rollback", "a.json"), e("debloat-1", "started", "c.json")];
    expect(rollbackTarget(after, "debloat-1")?.entry.snapshot).toBe("c.json");
    // Nothing since the rollback: already undone, and an older or newer snapshot could re-apply changes.
    expect(rollbackTarget(log.concat(e("rollback-all", "rollback")), "debloat-1")).toBeNull();
    expect(rollbackTarget(log, "tune")).toBeNull();
  });
});
