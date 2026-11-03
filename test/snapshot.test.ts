import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SnapshotCorrupt,
  diffSnapshots,
  loadSnapshot,
  parseAppop,
  parseBucket,
  parsePackageList,
  parseSettingsList,
  restoreSnapshot,
  saveSnapshot,
  takeSnapshot,
} from "../cli/snapshot";
import { FakeTv, fixture } from "./fake-tv";

const tmp = mkdtempSync(join(tmpdir(), "kyoto-snap-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function tv() {
  return new FakeTv({
    installed: ["tv.pluto.android", "com.google.android.tvrecommendations", "com.netflix.ninja"],
    settings: { global: { window_animation_scale: "1.0", boot_count: "127" }, secure: {}, system: {} },
  });
}

describe("parsers (real fixtures)", () => {
  test("package lists", () => {
    const sys = parsePackageList(fixture("pkgs_system"));
    expect(sys.length).toBeGreaterThan(100);
    expect(sys).toContain("com.google.android.tvlauncher");
    expect(parsePackageList(fixture("pkgs_disabled"))).toEqual([]);
  });
  test("settings list", () => {
    const g = parseSettingsList(fixture("settings_global"));
    expect(g.boot_count).toBeDefined();
    expect(g.Phenotype_flags).toContain("zram_enabled"); // values containing ':' and '=' survive
  });
  test("appops: 'No operations' means default", () => {
    expect(parseAppop(fixture("appops_netflix"))).toBe("default");
    expect(parseAppop("RUN_IN_BACKGROUND: ignore; time=+1d\n")).toBe("ignore");
  });
  test("standby buckets", () => {
    expect(parseBucket(fixture("bucket_netflix"))).toBeNull(); // 5 = exempted, never restored
    expect(parseBucket("10\n")).toBe("active");
    expect(parseBucket("45")).toBe("restricted");
  });
});

describe("take / diff / restore", () => {
  test("snapshot captures packages, all 3 namespaces and per-app state", async () => {
    const t = tv();
    t.disabled.add("tv.pluto.android");
    t.appops.set("com.netflix.ninja", "ignore");
    const s = await takeSnapshot(t, "x", ["com.netflix.ninja"]);
    expect(s.disabled).toEqual(["tv.pluto.android"]);
    expect(s.settings.global.window_animation_scale).toBe("1.0");
    expect(Object.keys(s.settings)).toEqual(["global", "secure", "system"]);
    expect(s.apps["com.netflix.ninja"]).toEqual({ runInBackground: "ignore", bucket: "active" });
    expect(s.apiLevel).toBe(29);
  });

  test("diff finds package, setting and appop changes, ignoring unmanaged settings", async () => {
    const t = tv();
    const before = await takeSnapshot(t, "b", ["com.netflix.ninja"]);
    t.disabled.add("tv.pluto.android");
    t.settings.global.set("window_animation_scale", "0.5");
    t.settings.global.set("boot_count", "128"); // unmanaged: must not be restored
    t.appops.set("com.netflix.ninja", "ignore");
    const live = await takeSnapshot(t, "l", ["com.netflix.ninja"]);
    const changes = diffSnapshots(before, live, { settingsKeys: [{ ns: "global", key: "window_animation_scale" }], appPkgs: ["com.netflix.ninja"] });
    expect(changes).toEqual([
      { kind: "pkg", pkg: "tv.pluto.android", to: "enabled" },
      { kind: "setting", ns: "global", key: "window_animation_scale", to: "1.0" },
      { kind: "appop", pkg: "com.netflix.ninja", to: "default" },
    ]);
  });

  test("restoring a setting that didn't exist deletes it", async () => {
    const t = tv();
    const before = await takeSnapshot(t, "b");
    t.settings.secure.set("new_key", "1");
    const r = await restoreSnapshot(t, before, { settingsKeys: [{ ns: "secure", key: "new_key" }], appPkgs: [] });
    expect(r.applied).toEqual([{ kind: "setting", ns: "secure", key: "new_key", to: null }]);
    expect(t.settings.secure.has("new_key")).toBe(false);
  });

  test("restore is idempotent: a second run changes nothing", async () => {
    const t = tv();
    const before = await takeSnapshot(t, "b");
    t.disabled.add("tv.pluto.android");
    t.disabled.add("com.google.android.tvrecommendations");
    const scope = { settingsKeys: [], appPkgs: [] };
    expect((await restoreSnapshot(t, before, scope)).applied.length).toBe(2);
    const n = t.mutations().length;
    expect((await restoreSnapshot(t, before, scope)).applied.length).toBe(0);
    expect(t.mutations().length).toBe(n);
  });

  test("an uninstalled package is reported, the rest still restore", async () => {
    const t = tv();
    const before = await takeSnapshot(t, "b");
    t.disabled.add("tv.pluto.android");
    t.disabled.add("com.gone.app");
    const r = await restoreSnapshot(t, before, { settingsKeys: [], appPkgs: [] });
    expect(r.applied).toEqual([{ kind: "pkg", pkg: "tv.pluto.android", to: "enabled" }]);
    expect(r.failed.map((f) => (f.change as { pkg: string }).pkg)).toEqual(["com.gone.app"]);
  });

  test("connection loss aborts restore instead of being swallowed", async () => {
    const t = tv();
    const before = await takeSnapshot(t, "b");
    t.disabled.add("tv.pluto.android");
    t.offlineOn = /^pm enable/;
    await expect(restoreSnapshot(t, before, { settingsKeys: [], appPkgs: [] })).rejects.toThrow("Can't reach the TV");
  });
});

describe("persistence", () => {
  test("round trip", async () => {
    const s = await takeSnapshot(tv(), "rt");
    const p = join(tmp, "rt.json");
    await saveSnapshot(p, s);
    expect(await loadSnapshot(p)).toEqual(s);
  });
  test("truncated file is refused", async () => {
    const p = join(tmp, "trunc.json");
    writeFileSync(p, '{"version":1,"disabled":["a"');
    await expect(loadSnapshot(p)).rejects.toBeInstanceOf(SnapshotCorrupt);
  });
  test("missing fields are refused", async () => {
    const p = join(tmp, "partial.json");
    writeFileSync(p, JSON.stringify({ version: 1, disabled: [], settings: { global: {} }, apps: {} }));
    await expect(loadSnapshot(p)).rejects.toThrow(/missing required fields/);
  });
  test("missing file is refused", async () => {
    await expect(loadSnapshot(join(tmp, "nope.json"))).rejects.toBeInstanceOf(SnapshotCorrupt);
  });
});
