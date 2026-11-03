import { describe, expect, test } from "bun:test";
import { CompareError, type Measurement, compare, countLmkKills, launchFailure, measure, measureRepeated, median, mergePasses, parseDrm, parseMemAvailable, parseTotalTime, parseUptime } from "../cli/measure";
import { FakeTv, fixture } from "./fake-tv";

const noSleep = async () => {};

describe("parsers (real fixtures)", () => {
  test("MemAvailable", () => {
    expect(parseMemAvailable(fixture("meminfo"))).toBeGreaterThan(100_000);
    expect(parseMemAvailable("garbage")).toBeNull();
  });
  test("TotalTime from real am start -W output", () => {
    expect(parseTotalTime(fixture("am_start_netflix"))).toBe(78);
    expect(parseTotalTime("Error: Activity class does not exist.\n")).toBeNull();
  });
  test("uptime", () => {
    expect(parseUptime(fixture("uptime"))).toBeGreaterThan(0);
  });
  test("DRM level", () => {
    expect(parseDrm(fixture("drm"))).toBe("unknown"); // this TV prints nothing
    expect(parseDrm("Widevine plugin\n securityLevel: L1\n")).toBe("L1");
    expect(parseDrm("widevine securityLevel=L3")).toBe("L3");
  });
  test("low-memory-killer kills from real logcat", () => {
    expect(countLmkKills(fixture("logcat_lmk"))).toBeGreaterThan(0);
    expect(countLmkKills("nothing here")).toBe(0);
  });
  test("median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("measure", () => {
  test("as-is run measures without rebooting and skips missing apps", async () => {
    const t = new FakeTv({ apps: { "com.netflix.ninja": "com.netflix.ninja/.MainActivity" } });
    const m = await measure(t, { variant: "as-is", apps: ["com.netflix.ninja", "com.disney.disneyplus"], runs: 3, sleep: noSleep });
    expect(t.reboots).toBe(0);
    expect(m.variant).toBe("as-is");
    expect(m.memAvailableKb.length).toBe(3);
    expect(m.coldStartMs["com.netflix.ninja"]).toMatchObject({ runs: [412, 412, 412], median: 412 });
    expect(m.coldStartMs["com.disney.disneyplus"]).toMatchObject({ skipped: "not installed", median: null });
    expect(m.uptimeS).toBe(517821);
    expect(m.lmkKills).toBeGreaterThan(0);
  });
  test("a warm-up launch runs before the timed runs and isn't counted", async () => {
    const t = new FakeTv({ apps: { "com.netflix.ninja": "com.netflix.ninja/.MainActivity" } });
    const m = await measure(t, { variant: "as-is", apps: ["com.netflix.ninja"], runs: 3, memSamples: 1, sleep: noSleep });
    expect(t.log.filter((c) => c.startsWith("am start -W")).length).toBe(4);
    expect(m.coldStartMs["com.netflix.ninja"]!.runs.length).toBe(3);
  });

  test("warm-up absorbs a slow first launch after boot (the v1 Netflix bug)", async () => {
    const t = new FakeTv({ apps: { "com.netflix.ninja": "com.netflix.ninja/.MainActivity" } });
    t.slowFirstLaunches.set("com.netflix.ninja", 1);
    const m = await measure(t, { variant: "as-is", apps: ["com.netflix.ninja"], runs: 5, memSamples: 1, sleep: noSleep });
    expect(m.coldStartMs["com.netflix.ninja"]).toMatchObject({ runs: [412, 412, 412, 412, 412] });
    expect(m.coldStartMs["com.netflix.ninja"]!.failures).toBeUndefined();
  });

  test("runs that still fail record why", async () => {
    const t = new FakeTv({ apps: { "com.netflix.ninja": "com.netflix.ninja/.MainActivity" } });
    t.slowFirstLaunches.set("com.netflix.ninja", 3); // warm-up + 2 timed runs time out
    const m = await measure(t, { variant: "as-is", apps: ["com.netflix.ninja"], runs: 5, memSamples: 1, sleep: noSleep });
    expect(m.coldStartMs["com.netflix.ninja"]).toMatchObject({ runs: [412, 412, 412], failures: ["Status: timeout", "Status: timeout"] });
  });

  test("repeat runs N passes and pools them", async () => {
    const t = new FakeTv({ apps: { "com.netflix.ninja": "com.netflix.ninja/.MainActivity" } });
    const m = await measureRepeated(t, { variant: "fresh", apps: ["com.netflix.ninja", "com.not.installed"], runs: 2, memSamples: 2, sleep: noSleep }, 2);
    expect(t.reboots).toBe(2); // each fresh pass reboots
    expect(m.passes).toBe(2);
    expect(m.memAvailableKb.length).toBe(4);
    expect(m.coldStartMs["com.netflix.ninja"]!.runs.length).toBe(4);
    expect(m.coldStartMs["com.not.installed"]!.skipped).toBe("not installed");
    expect(m.lmkKillsPerPass!.length).toBe(2);
  });

  test("quick: no reboot, short waits", async () => {
    const t = new FakeTv({ apps: { "com.netflix.ninja": "com.netflix.ninja/.MainActivity" } });
    const waits: number[] = [];
    const m = await measure(t, { variant: "quick", apps: ["com.netflix.ninja"], runs: 3, sleep: async (ms) => void waits.push(ms) });
    expect(t.reboots).toBe(0);
    expect(m.variant).toBe("quick");
    expect(Math.max(...waits)).toBeLessThanOrEqual(9_000);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(60_000);
  });

  test("fresh run reboots first", async () => {
    const t = new FakeTv();
    await measure(t, { variant: "fresh", apps: [], memSamples: 1, sleep: noSleep });
    expect(t.reboots).toBe(1);
  });
});

const base: Measurement = {
  variant: "fresh",
  protocol: 1,
  capturedAt: "",
  fingerprint: "fp1",
  uptimeS: 300,
  memAvailableKb: [600_000],
  memAvailableMedianKb: 600_000,
  coldStartMs: { "com.netflix.ninja": { runs: [400], median: 400, min: 400, max: 400 } },
  lmkKills: 5,
  drm: "unknown",
};

test("launchFailure picks the status line", () => {
  expect(launchFailure("Starting: Intent {}\nStatus: timeout\nWaitTime: 10012\n")).toBe("Status: timeout");
  expect(launchFailure("Error: Activity not started, unable to resolve Intent\n")).toBe("Error: Activity not started, unable to resolve Intent");
});

test("mergePasses: kills are the median per pass, timings pooled", () => {
  const m = mergePasses([
    { ...base, lmkKills: 2, memAvailableKb: [1], coldStartMs: { a: { runs: [100, 300], median: 200, min: 100, max: 300 } } },
    { ...base, lmkKills: 10, memAvailableKb: [3], coldStartMs: { a: { runs: [200], median: 200, min: 200, max: 200, failures: ["Status: timeout"] } } },
    { ...base, lmkKills: 4, memAvailableKb: [2], coldStartMs: { a: { runs: [400], median: 400, min: 400, max: 400 } } },
  ]);
  expect(m.lmkKills).toBe(4);
  expect(m.lmkKillsPerPass).toEqual([2, 10, 4]);
  expect(m.memAvailableMedianKb).toBe(2);
  expect(m.coldStartMs.a).toEqual({ runs: [100, 300, 200, 400], median: 250, min: 100, max: 400, failures: ["Status: timeout"] });
});

describe("compare", () => {
  test("computes changes", () => {
    const after = { ...base, memAvailableMedianKb: 900_000, lmkKills: 0, coldStartMs: { "com.netflix.ninja": { runs: [300], median: 300, min: 300, max: 300 } } };
    const c = compare(base, after);
    expect(c.warnings).toEqual([]);
    expect(c.rows.find((r) => r.metric.startsWith("free memory"))).toMatchObject({ before: 586, after: 879, changePct: 50 });
    expect(c.rows.find((r) => r.metric.includes("netflix"))?.changePct).toBe(-25);
  });
  test("refuses different variants", () => {
    expect(() => compare(base, { ...base, variant: "as-is" })).toThrow(CompareError);
  });
  test("refuses different protocols", () => {
    expect(() => compare(base, { ...base, protocol: 2 })).toThrow(/Protocol mismatch/);
  });
  test("warns about OTA between runs", () => {
    expect(compare(base, { ...base, fingerprint: "fp2" }).warnings[0]).toContain("firmware changed");
  });
});
