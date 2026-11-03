// Measurement protocol v2. Two variants, never compared with each other:
//   as-is : measure the TV as it is right now (records uptime)
//   fresh : reboot → sys.boot_completed → settle 5 min → measure
//
// per pass: 3× MemAvailable (60s apart)
//           → per app: 1 untimed warm-up launch, then 5× (force-stop, am start -W, 10s, HOME)
//           → low-memory-killer kills seen during the pass
// quick  : no reboot, 1 pass, 3 memory samples 5s apart, warm-up + 3 runs per app, short waits
//          (~1.5 min). Noisier; its own variant so it's only ever compared with other quick runs.
// --repeat N runs N full passes (each fresh pass reboots) and reports medians across all of them.
//
// v2 vs v1: the warm-up launch. On v1, Netflix's first launches after a reboot returned no
// TotalTime (first-run work), leaving 1/5 usable samples. v1 and v2 runs are not comparable.

import type { AdbLike } from "./adb";
import { sleep as realSleep } from "./adb";
import { safeComponent, safePkg } from "./guard";

export const PROTOCOL = 2;
export type Variant = "as-is" | "fresh" | "quick";

export const DEFAULT_APPS = ["com.netflix.ninja", "com.google.android.youtube.tv"];

export interface AppTiming {
  runs: number[];
  median: number | null;
  min: number | null;
  max: number | null;
  skipped?: string;
  /** Why runs produced no time (first line of am start's status), so gaps are explainable. */
  failures?: string[];
}

export interface Measurement {
  variant: Variant;
  protocol: number;
  capturedAt: string;
  fingerprint: string;
  uptimeS: number;
  memAvailableKb: number[];
  memAvailableMedianKb: number | null;
  coldStartMs: Record<string, AppTiming>;
  lmkKills: number;
  /** Kills per pass when --repeat > 1; lmkKills is their median. */
  lmkKillsPerPass?: number[];
  passes?: number;
  drm: DrmLevel;
}

export type DrmLevel = "L1" | "L3" | "unknown";

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function parseMemAvailable(meminfo: string): number | null {
  const m = meminfo.match(/MemAvailable:\s+(\d+)\s*kB/);
  return m ? Number(m[1]) : null;
}

export function parseTotalTime(amStartOutput: string): number | null {
  if (!/Status:\s*ok/.test(amStartOutput)) return null;
  const m = amStartOutput.match(/TotalTime:\s+(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Short reason an am start produced no usable time. */
export function launchFailure(amStartOutput: string): string {
  const line = amStartOutput.split("\n").find((l) => /^(Status|Error|Warning):/.test(l.trim()));
  return line?.trim() ?? (amStartOutput.trim().split("\n")[0] ?? "no output");
}

export function parseUptime(out: string): number {
  return Math.floor(Number(out.trim().split(/\s+/)[0]) || 0);
}

export function parseDrm(dumpsysDrm: string): DrmLevel {
  if (/securityLevel\W+L1|security level\W+L1|\bL1\b.*widevine|widevine.*\bL1\b/i.test(dumpsysDrm)) return "L1";
  if (/securityLevel\W+L3|security level\W+L3|\bL3\b.*widevine|widevine.*\bL3\b/i.test(dumpsysDrm)) return "L3";
  return "unknown";
}

export function countLmkKills(logcat: string): number {
  return (logcat.match(/lowmemorykiller.*Kill '/g) ?? []).length;
}

export async function launchActivity(adb: AdbLike, pkg: string): Promise<string | null> {
  const out = await adb.shell(
    `cmd package resolve-activity --brief -c android.intent.category.LEANBACK_LAUNCHER -a android.intent.action.MAIN ${safePkg(pkg)}`,
  );
  const last = out.trim().split("\n").pop()?.trim() ?? "";
  return last.includes("/") ? safeComponent(last) : null;
}

export interface MeasureOptions {
  variant: Variant;
  apps?: string[];
  runs?: number;
  memSamples?: number;
  settleS?: number;
  /** Gap between memory samples. */
  memIntervalMs?: number;
  /** Time an app stays open after launch before going HOME. */
  dwellMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export async function measure(adb: AdbLike, opts: MeasureOptions): Promise<Measurement> {
  const sleep = opts.sleep ?? realSleep;
  const log = opts.log ?? (() => {});
  const apps = opts.apps ?? DEFAULT_APPS;
  const runs = opts.runs ?? 5;
  const memSamples = opts.memSamples ?? 3;
  const settleS = opts.settleS ?? 300;
  const quick = opts.variant === "quick";
  const memIntervalMs = opts.memIntervalMs ?? (quick ? 5_000 : 60_000);
  const dwellMs = opts.dwellMs ?? (quick ? 4_000 : 10_000);
  const pause = quick ? 1_000 : 2_000;

  if (opts.variant === "fresh") {
    log("Rebooting the TV for a fresh measurement…");
    await adb.reboot();
    await adb.waitForBoot();
    const up = parseUptime(await adb.shell("cat /proc/uptime"));
    if (up < settleS) {
      log(`Letting it settle for ${settleS - up}s…`);
      await sleep((settleS - up) * 1000);
    }
  }
  // dex2oat runs while apps install/update/optimize, which skews timings.
  const compiling = await adb.shell("ps -A -o NAME | grep -c dex2oat || true");
  if (Number(compiling.trim()) > 0) log("⚠ An app install/update is in progress; numbers can be noisy.");

  await adb.shell("input keyevent KEYCODE_WAKEUP");
  await adb.shell("logcat -c -b main,system,events");
  const uptimeS = parseUptime(await adb.shell("cat /proc/uptime"));
  const fingerprint = (await adb.shell("getprop ro.build.fingerprint")).trim();

  const memAvailableKb: number[] = [];
  for (let i = 0; i < memSamples; i++) {
    const v = parseMemAvailable(await adb.shell("cat /proc/meminfo"));
    if (v !== null) memAvailableKb.push(v);
    if (i < memSamples - 1) await sleep(memIntervalMs);
  }
  log(`Free memory: ${memAvailableKb.map((k) => Math.round(k / 1024)).join(", ")} MB`);

  const coldStartMs: Record<string, AppTiming> = {};
  for (const pkg of apps) {
    const act = await launchActivity(adb, pkg);
    if (!act) {
      coldStartMs[pkg] = { runs: [], median: null, min: null, max: null, skipped: "not installed" };
      log(`${pkg}: not installed, skipped`);
      continue;
    }
    // Warm-up: absorbs first-launch-after-boot work so the timed runs are comparable.
    await adb.shell(`am force-stop ${pkg}`);
    await adb.shell(`am start -W -n ${act}`);
    await sleep(dwellMs + 5_000);
    await adb.shell("input keyevent KEYCODE_HOME");
    await sleep(pause);

    const times: number[] = [];
    const failures: string[] = [];
    for (let i = 0; i < runs; i++) {
      await adb.shell(`am force-stop ${pkg}`);
      await sleep(pause);
      const out = await adb.shell(`am start -W -n ${act}`);
      const t = parseTotalTime(out);
      if (t !== null) times.push(t);
      else failures.push(launchFailure(out));
      await sleep(dwellMs);
      await adb.shell("input keyevent KEYCODE_HOME");
      await sleep(pause);
    }
    coldStartMs[pkg] = timing(times, failures);
    log(`${pkg}: median ${coldStartMs[pkg]!.median ?? "n/a"} ms over ${times.length}/${runs} runs${failures.length ? ` (failed: ${[...new Set(failures)].join("; ")})` : ""}`);
  }

  const lmkKills = countLmkKills(await adb.shell("logcat -d -b main,system"));
  const drm = parseDrm(await adb.shell("dumpsys media.drm"));
  return {
    variant: opts.variant,
    protocol: PROTOCOL,
    capturedAt: new Date().toISOString(),
    fingerprint,
    uptimeS,
    memAvailableKb,
    memAvailableMedianKb: median(memAvailableKb),
    coldStartMs,
    lmkKills,
    drm,
  };
}

function timing(times: number[], failures: string[] = []): AppTiming {
  return {
    runs: times,
    median: median(times),
    min: times.length ? Math.min(...times) : null,
    max: times.length ? Math.max(...times) : null,
    ...(failures.length ? { failures } : {}),
  };
}

/** Run `repeat` full passes and merge them: all samples pooled, kills = median per pass. */
export async function measureRepeated(adb: AdbLike, opts: MeasureOptions, repeat: number): Promise<Measurement> {
  const log = opts.log ?? (() => {});
  const passes: Measurement[] = [];
  for (let i = 0; i < repeat; i++) {
    if (repeat > 1) log(`— pass ${i + 1} of ${repeat} —`);
    passes.push(await measure(adb, opts));
  }
  return mergePasses(passes);
}

export function mergePasses(passes: Measurement[]): Measurement {
  const first = passes[0];
  if (!first) throw new Error("no passes to merge");
  if (passes.length === 1) return { ...first, passes: 1, lmkKillsPerPass: [first.lmkKills] };
  const mem = passes.flatMap((p) => p.memAvailableKb);
  const coldStartMs: Record<string, AppTiming> = {};
  for (const pkg of new Set(passes.flatMap((p) => Object.keys(p.coldStartMs)))) {
    const ts = passes.map((p) => p.coldStartMs[pkg]).filter((t): t is AppTiming => !!t);
    if (ts.every((t) => t.skipped)) {
      coldStartMs[pkg] = ts[0]!;
      continue;
    }
    coldStartMs[pkg] = timing(ts.flatMap((t) => t.runs), ts.flatMap((t) => t.failures ?? []));
  }
  const kills = passes.map((p) => p.lmkKills);
  const last = passes[passes.length - 1]!;
  return {
    ...last,
    capturedAt: first.capturedAt,
    memAvailableKb: mem,
    memAvailableMedianKb: median(mem),
    coldStartMs,
    lmkKills: median(kills) ?? 0,
    lmkKillsPerPass: kills,
    passes: passes.length,
  };
}

export interface Comparison {
  warnings: string[];
  rows: { metric: string; before: number | null; after: number | null; changePct: number | null }[];
}

export class CompareError extends Error {}

const pct = (a: number | null, b: number | null) => (a && b !== null ? Math.round(((b - a) / a) * 1000) / 10 : null);

export function compare(before: Measurement, after: Measurement): Comparison {
  if (before.variant !== after.variant) {
    throw new CompareError(`Can't compare a "${before.variant}" run with a "${after.variant}" run; measure the same variant.`);
  }
  if (before.protocol !== after.protocol) {
    throw new CompareError(`Protocol mismatch (v${before.protocol} vs v${after.protocol}); re-measure with the current protocol.`);
  }
  const warnings: string[] = [];
  if (before.fingerprint !== after.fingerprint) warnings.push("⚠ The TV's firmware changed between these runs (OTA update); differences may not be from kyoto.");
  const rows: Comparison["rows"] = [
    { metric: "free memory (MB)", before: kbToMb(before.memAvailableMedianKb), after: kbToMb(after.memAvailableMedianKb), changePct: pct(before.memAvailableMedianKb, after.memAvailableMedianKb) },
    { metric: "low-memory kills", before: before.lmkKills, after: after.lmkKills, changePct: pct(before.lmkKills, after.lmkKills) },
  ];
  for (const pkg of new Set([...Object.keys(before.coldStartMs), ...Object.keys(after.coldStartMs)])) {
    const b = before.coldStartMs[pkg]?.median ?? null;
    const a = after.coldStartMs[pkg]?.median ?? null;
    rows.push({ metric: `${pkg} open (ms)`, before: b, after: a, changePct: pct(b, a) });
  }
  return { warnings, rows };
}

const kbToMb = (kb: number | null) => (kb === null ? null : Math.round(kb / 1024));
