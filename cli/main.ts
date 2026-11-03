#!/usr/bin/env bun
// kyoto: tune a Hisense Android TV from the Mac over adb. Mutating commands are dry-run unless --apply.

import { createInterface } from "node:readline/promises";
import { Adb, AdbError, BootTimeout } from "./adb";
import { type Action, type LogEntry, type Prompt, mergeScopes, readLog, rollback, runBatch } from "./batch";
import { pollCrashes, readLog as readCrashLog, summarize } from "./crashes";
import { GuardError, resolveHome, validateAllow } from "./guard";
import { CompareError, type Measurement, compare, measureRepeated } from "./measure";
import { type PackagesProfile, ProfileError, batchPackages, inventory, readJson, validatePackages, validateTune } from "./profile";
import { type Snapshot, SnapshotCorrupt, describeChange, loadSnapshot } from "./snapshot";

const ROOT = new URL("..", import.meta.url).pathname;
const STATE = `${ROOT}state`;
const PROFILE_DIR = `${ROOT}profiles/hisense-android-tv`;
const DEVICE = `${STATE}/device.json`;
const CHECK_APPS = ["com.netflix.ninja", "com.google.android.youtube.tv", "com.disney.disneyplus"];

interface DeviceConfig {
  serial: string;
  adbSurvivesReboot?: boolean;
  [k: string]: unknown;
}

const USAGE = `kyoto: make your Hisense TV faster, reversibly

  kyoto connect [host:port]          pin the TV (default: saved serial) and check access
  kyoto doctor [--reboot-probe]      connection, device info, interrupted batches
  kyoto inventory                    write the TV's packages into profiles/.../packages.json (all keep)
  kyoto capture-fixtures             record real TV output into test/fixtures/
  kyoto measure [--quick | --no-reboot] [--repeat N]
                                     fresh (reboots, ~11 min/pass, default 2 passes), as-is,
                                     or quick (~1.5 min, no reboot, noisier)
  kyoto compare <a.json> <b.json>    compare two measurements of the same variant
  kyoto debloat --batch N [--apply] [--allow pkg]... [--reboot-check] [--confirm-timeout S]
  kyoto tune [--apply] [--allow pkg]... [--confirm-timeout S]
  kyoto rollback (--batch LABEL | --all) [--apply]
  kyoto home set <pkg/.Activity> [--apply] [--confirm-timeout S]
                                     make another launcher HOME (disables the stock one, reversibly)
  kyoto home restore [--apply]       give HOME back to the stock launcher
  kyoto crashes                      poll + summarize crashes / low-memory kills
  kyoto reboot

Without --apply, mutating commands only print what they would do.`;

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const allow: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--allow") allow.push(argv[++i] ?? "");
    else if (a === "--batch") flags.batch = argv[++i] ?? "";
    else if (a === "--confirm-timeout") flags["confirm-timeout"] = argv[++i] ?? "";
    else if (a === "--repeat") flags.repeat = argv[++i] ?? "";
    else if (a.startsWith("--")) flags[a.slice(2)] = true;
    else pos.push(a);
  }
  return { pos, flags, allow };
}

const prompt: Prompt = async (question, timeoutMs) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    process.stdout.write("\n");
    return null;
  } finally {
    rl.close();
  }
};

const log = (m: string) => console.log(m);

async function loadDevice(): Promise<DeviceConfig> {
  const d = await readJson<DeviceConfig>(DEVICE);
  const serial = process.env.ANDROID_SERIAL ?? d?.serial;
  if (!serial) throw new AdbError("No TV pinned yet.", "Run `kyoto connect <tv-ip>:5555` first.");
  return { ...(d ?? {}), serial };
}

async function saveDevice(d: DeviceConfig) {
  await Bun.write(DEVICE, JSON.stringify(d, null, 2) + "\n");
}

async function adbFor(): Promise<{ adb: Adb; device: DeviceConfig }> {
  const device = await loadDevice();
  return { adb: new Adb(device.serial), device };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function cmdConnect(target?: string) {
  const prev = (await readJson<DeviceConfig>(DEVICE)) ?? ({} as DeviceConfig);
  const serial = target ?? prev.serial;
  if (!serial) throw new AdbError("Which TV?", "Run `kyoto connect <tv-ip>:5555`.");
  const adb = new Adb(serial);
  await adb.connect();
  const model = (await adb.shell("getprop ro.product.model")).trim();
  const android = (await adb.shell("getprop ro.build.version.release")).trim();
  await saveDevice({ ...prev, serial });
  log(`✓ Connected to ${model} (Android ${android}) at ${serial}`);
  const c = await pollCrashes(adb, `${STATE}/crashes.jsonl`);
  if (c.added) log(`  logged ${c.added} new crash / low-memory-kill events`);
}

async function cmdDoctor(rebootProbe: boolean) {
  const { adb, device } = await adbFor();
  const [model, android, sdk, fp] = await Promise.all(
    ["ro.product.model", "ro.build.version.release", "ro.build.version.sdk", "ro.build.fingerprint"].map((p) => adb.shell(`getprop ${p}`)),
  );
  const home = await resolveHome(adb);
  const disabled = (await adb.shell("pm list packages -d")).split("\n").filter((l) => l.startsWith("package:")).length;
  log(`TV:        ${model!.trim()} (Android ${android!.trim()}, API ${sdk!.trim()})`);
  log(`Firmware:  ${fp!.trim()}`);
  log(`Home app:  ${home ?? "unknown"}`);
  log(`Disabled:  ${disabled} packages`);
  log(`Serial:    ${device.serial}   adb survives reboot: ${device.adbSurvivesReboot ?? "not probed"}`);

  const entries = await readLog(STATE);
  const lastBySnap = new Map<string, LogEntry>();
  for (const e of entries) if (e.snapshot) lastBySnap.set(e.snapshot, e);
  const interrupted = [...lastBySnap.values()].filter((e) => e.event === "started");
  for (const e of interrupted) log(`⚠ Batch ${e.label} was interrupted mid-way. Undo it with: kyoto rollback --batch ${e.label} --apply`);
  if (!interrupted.length) log("✓ No interrupted batches.");

  if (rebootProbe) {
    log("Rebooting once to see whether adb comes back by itself…");
    await adb.reboot();
    try {
      await adb.waitForBoot();
      device.adbSurvivesReboot = true;
      log("✓ adb came back after reboot; --reboot-check is available.");
    } catch (e) {
      if (!(e instanceof BootTimeout)) throw e;
      device.adbSurvivesReboot = false;
      log("✗ adb did not come back on its own. Re-enable USB debugging on the TV; --reboot-check stays disabled.");
    }
    await saveDevice(device);
  }
  await pollCrashes(adb, `${STATE}/crashes.jsonl`);
}

async function cmdInventory() {
  const { adb } = await adbFor();
  const path = `${PROFILE_DIR}/packages.json`;
  const existing = await readJson<PackagesProfile>(path);
  const merged = await inventory(adb, existing);
  await Bun.write(path, JSON.stringify(merged, null, 2) + "\n");
  const added = merged.packages.length - (existing?.packages.length ?? 0);
  log(`✓ ${merged.packages.length} packages in ${path} (${added} new, all default to keep)`);
}

const FIXTURES: Record<string, string> = {
  getprop: "getprop",
  meminfo: "cat /proc/meminfo",
  uptime: "cat /proc/uptime",
  pkgs_system: "pm list packages -s",
  pkgs_user: "pm list packages -3",
  pkgs_disabled: "pm list packages -d",
  settings_global: "settings list global",
  settings_secure: "settings list secure",
  settings_system: "settings list system",
  resolve_home: "cmd package resolve-activity --brief -c android.intent.category.HOME -a android.intent.action.MAIN",
  resolve_netflix: "cmd package resolve-activity --brief -c android.intent.category.LEANBACK_LAUNCHER -a android.intent.action.MAIN com.netflix.ninja",
  resolve_missing: "cmd package resolve-activity --brief -c android.intent.category.LEANBACK_LAUNCHER -a android.intent.action.MAIN com.kyoto.not.installed",
  appops_netflix: "cmd appops get com.netflix.ninja RUN_IN_BACKGROUND",
  bucket_netflix: "am get-standby-bucket com.netflix.ninja",
  dropbox_crash: "dumpsys dropbox --print data_app_crash",
  drm: "dumpsys media.drm",
  resumed: "dumpsys activity activities | grep -E \"ResumedActivity\" || true",
};

async function cmdCaptureFixtures() {
  const { adb } = await adbFor();
  const dir = `${ROOT}test/fixtures`;
  for (const [name, cmd] of Object.entries(FIXTURES)) {
    await Bun.write(`${dir}/${name}.txt`, await adb.shell(cmd));
  }
  // Failure strings, captured raw (harmless: the packages don't exist).
  for (const [name, args] of Object.entries({
    pm_enable_unknown: ["pm", "enable", "com.kyoto.not.installed"],
    pm_disable_unknown: ["pm", "disable-user", "--user", "0", "com.kyoto.not.installed"],
  })) {
    const p = Bun.spawn(["adb", "-s", adb.serial, "shell", ...args], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    await Bun.write(`${dir}/${name}.txt`, out.replace(/\r/g, ""));
  }
  const start = await adb.shell("am start -W -n com.netflix.ninja/.MainActivity");
  await Bun.write(`${dir}/am_start_netflix.txt`, start);
  await adb.shell("input keyevent KEYCODE_HOME");
  const lmk = await adb.shell("logcat -d -b main,system | grep lowmemorykiller | tail -20; true");
  await Bun.write(`${dir}/logcat_lmk.txt`, lmk);
  log(`✓ Captured ${Object.keys(FIXTURES).length + 4} fixtures into test/fixtures/`);
}

async function cmdMeasure(noReboot: boolean, quick: boolean, repeatArg: string | boolean | undefined) {
  const repeat = repeatArg === undefined ? (quick ? 1 : 2) : Number(repeatArg);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw new Error("--repeat takes 1 to 5");
  const { adb } = await adbFor();
  const variant = quick ? "quick" : noReboot ? "as-is" : "fresh";
  const m = await measureRepeated(adb, { variant, log, ...(quick ? { runs: 3 } : {}) }, repeat);
  const path = `${STATE}/measurements/${variant}-${stamp()}.json`;
  await Bun.write(path, JSON.stringify(m, null, 2) + "\n");
  log(`✓ Saved ${path}`);
}

async function cmdCompare(a?: string, b?: string) {
  if (!a || !b) throw new Error("usage: kyoto compare <before.json> <after.json>");
  const before = (await Bun.file(a).json()) as Measurement;
  const after = (await Bun.file(b).json()) as Measurement;
  const c = compare(before, after);
  for (const w of c.warnings) log(w);
  for (const r of c.rows) {
    const ch = r.changePct === null ? "" : ` (${r.changePct > 0 ? "+" : ""}${r.changePct}%)`;
    log(`${r.metric.padEnd(44)} ${String(r.before ?? "n/a").padStart(7)} → ${String(r.after ?? "n/a").padStart(7)}${ch}`);
  }
}

function printPlan(label: string, plan: string[], apply: boolean) {
  log(`${apply ? "Applying" : "Plan for"} ${label}:`);
  for (const p of plan) log(`  • ${p}`);
  if (!apply) log("\nDry run: nothing changed. Re-run with --apply to do it.");
}

function confirmTimeoutMs(v: string | boolean | undefined): number | undefined {
  if (v === undefined) return undefined;
  const s = Number(v);
  if (!Number.isFinite(s) || s < 10 || s > 3600) throw new Error("--confirm-timeout takes seconds between 10 and 3600");
  return s * 1000;
}

async function cmdDebloat(batchArg: string | boolean | undefined, apply: boolean, allow: string[], rebootCheck: boolean, promptTimeoutMs?: number) {
  const n = Number(batchArg);
  if (!Number.isInteger(n) || n < 1) throw new Error("usage: kyoto debloat --batch N [--apply]");
  const { adb, device } = await adbFor();
  if (rebootCheck && !device.adbSurvivesReboot) throw new Error("--reboot-check needs `kyoto doctor --reboot-probe` to pass first.");
  const raw = await readJson<unknown>(`${PROFILE_DIR}/packages.json`);
  if (!raw) throw new ProfileError("No packages.json yet. Run `kyoto inventory`, then mark entries disable with a batch number.");
  const { profile, warnings } = validatePackages(raw, await resolveHome(adb));
  warnings.forEach((w) => log(`⚠ ${w}`));
  const actions: Action[] = batchPackages(profile, n).map((pkg) => ({ kind: "disable", pkg }));
  const label = `debloat-${n}`;
  const r = await runBatch({
    adb, label, actions, apply, allow: validateAllow(allow), prompt, checkApps: CHECK_APPS, stateDir: STATE, rebootCheck, log, promptTimeoutMs,
    reapplyCommand: `kyoto debloat --batch ${n} --apply${allow.map((a) => ` --allow ${a}`).join("")}`,
  });
  if (r.status === "nothing-to-do") return log(`Batch ${n} has no packages marked disable.`);
  if (r.status === "dry-run") printPlan(label, r.plan, false);
  await pollCrashes(adb, `${STATE}/crashes.jsonl`);
  if (r.status === "failed" || r.status === "reverted") process.exitCode = 1;
}

async function cmdTune(apply: boolean, allow: string[], promptTimeoutMs?: number) {
  const { adb } = await adbFor();
  const raw = await readJson<unknown>(`${PROFILE_DIR}/tune.json`);
  if (!raw) throw new ProfileError("No tune.json in profiles/hisense-android-tv/.");
  const t = validateTune(raw);
  const actions: Action[] = [
    ...t.settings.map((s) => ({ kind: "setting" as const, ns: s.ns, key: s.key, value: s.value })),
    ...t.restrictBackground.map((r) => ({ kind: "restrict-bg" as const, pkg: r.pkg })),
  ];
  const r = await runBatch({
    adb, label: "tune", actions, apply, allow: validateAllow(allow), prompt, checkApps: CHECK_APPS, stateDir: STATE, log, promptTimeoutMs,
    reapplyCommand: `kyoto tune --apply${allow.map((a) => ` --allow ${a}`).join("")}`,
  });
  if (r.status === "dry-run") printPlan("tune", r.plan, false);
  if (r.status === "failed" || r.status === "reverted") process.exitCode = 1;
}

const STOCK_HOME = "com.google.android.tvlauncher";

async function cmdHome(sub: string | undefined, component: string | undefined, apply: boolean, promptTimeoutMs?: number) {
  const { adb } = await adbFor();
  if (sub === "restore") {
    const entries = await readLog(STATE);
    const started = entries.filter((e) => e.label === "home" && e.event === "started").pop();
    if (!started) return log("kyoto never changed HOME; nothing to restore.");
    return cmdRollback("home", false, apply);
  }
  if (sub !== "set" || !component || !/^[\w.]+\/[\w.$]+$/.test(component)) {
    throw new Error("usage: kyoto home set <package/.Activity> [--apply]  |  kyoto home restore [--apply]");
  }
  const pkg = component.split("/")[0]!;
  if (pkg === STOCK_HOME) return cmdHome("restore", undefined, apply);

  // 1. The new launcher must actually open before we take HOME away from the stock one.
  const start = await adb.shell(`am start -W -n ${component}`);
  if (!/Status:\s*ok/.test(start)) throw new Error(`${component} didn't open; not changing HOME.\n${start.trim()}`);
  log(`✓ ${component} opens`);
  if (apply) {
    await adb.shell(`cmd package set-home-activity ${component}`);
    log(`✓ set as preferred HOME`);
  }
  // 2. The stock launcher is a priority-2 system HOME and outranks any preference, so it must be disabled.
  const r = await runBatch({
    adb, label: "home", actions: [{ kind: "disable", pkg: STOCK_HOME }], apply, allow: [STOCK_HOME], newHome: pkg,
    prompt, checkApps: CHECK_APPS, stateDir: STATE, log, promptTimeoutMs,
    reapplyCommand: `kyoto home set ${component} --apply`,
  });
  if (r.status === "dry-run") printPlan("home", [`set ${component} as HOME`, ...r.plan], false);
  if (r.status === "committed") {
    await adb.shell("input keyevent KEYCODE_HOME");
    const now = await resolveHome(adb);
    log(now === pkg ? `✓ HOME is now ${pkg}. Undo with: kyoto home restore --apply` : `⚠ HOME resolves to ${now}; check the TV.`);
  }
  if (r.status === "failed" || r.status === "reverted") process.exitCode = 1;
}

/** For --all: origin snapshot, with per-app state filled from the earliest snapshot that recorded it. */
async function originTarget(entries: LogEntry[]): Promise<Snapshot> {
  const origin = await loadSnapshot(`${STATE}/snapshots/origin.json`);
  const apps = { ...origin.apps };
  for (const e of entries) {
    if (e.event !== "started" || !e.snapshot) continue;
    const s = await loadSnapshot(e.snapshot).catch(() => null);
    for (const [pkg, st] of Object.entries(s?.apps ?? {})) if (!apps[pkg]) apps[pkg] = st;
  }
  return { ...origin, apps };
}

async function cmdRollback(batch: string | boolean | undefined, all: boolean, apply: boolean) {
  const { adb } = await adbFor();
  const entries = await readLog(STATE);
  let snapshotPath: string;
  let scope;
  let label: string;
  if (all) {
    const target = await originTarget(entries);
    snapshotPath = `${STATE}/snapshots/origin-merged.json`;
    await Bun.write(snapshotPath, JSON.stringify(target, null, 2) + "\n");
    scope = mergeScopes(entries.flatMap((e) => (e.scope ? [e.scope] : [])));
    label = "all";
  } else if (typeof batch === "string" && batch) {
    const label0 = /^\d+$/.test(batch) ? `debloat-${batch}` : batch;
    const started = entries.filter((e) => e.label === label0 && e.event === "started").pop();
    if (!started?.snapshot) throw new Error(`No snapshot found for batch "${label0}".`);
    snapshotPath = started.snapshot;
    scope = started.scope ?? { settingsKeys: [], appPkgs: [] };
    label = label0;
    log(`Note: this returns the TV to how it was right before ${label0}, which also undoes any later batches.`);
  } else {
    throw new Error("usage: kyoto rollback (--batch LABEL | --all) [--apply]");
  }
  const r = await rollback({ adb, snapshotPath, scope, apply, prompt, stateDir: STATE, label: `rollback-${label}`, log });
  if (r.status === "nothing-to-do") return log("✓ Already matches the snapshot; nothing to undo.");
  log(`${r.changes.length} change(s) to restore:`);
  for (const c of r.changes) log(`  • ${describeChange(c)}`);
  if (r.status === "dry-run") log("\nDry run: nothing changed. Re-run with --apply to restore.");
  if (r.status === "cancelled") log("Cancelled; nothing changed.");
  if (r.status === "restored") {
    if (r.failures.length) {
      log(`⚠ ${r.failures.length} change(s) failed:\n  ${r.failures.join("\n  ")}`);
      process.exitCode = 1;
    } else log("✓ Restored.");
  }
}

async function cmdCrashes() {
  let adb: Adb | null = null;
  try {
    adb = (await adbFor()).adb;
    await adb.shell("true");
  } catch {
    adb = null;
  }
  const r = await pollCrashes(adb, `${STATE}/crashes.jsonl`);
  if (r.gap) log("⚠ TV unreachable; recorded a gap.");
  const s = summarize(await readCrashLog(`${STATE}/crashes.jsonl`));
  log(`Polls: ${s.polls}, gaps: ${s.gaps}`);
  for (const [tag, n] of Object.entries(s.byTag)) log(`  ${tag.padEnd(24)} ${n}`);
  const top = Object.entries(s.byProcess).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (top.length) log("Most affected:\n" + top.map(([p, n]) => `  ${String(n).padStart(4)}  ${p}`).join("\n"));
}

async function main(argv: string[]) {
  const { pos, flags, allow } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  switch (cmd) {
    case "connect": return cmdConnect(rest[0]);
    case "doctor": return cmdDoctor(!!flags["reboot-probe"]);
    case "inventory": return cmdInventory();
    case "capture-fixtures": return cmdCaptureFixtures();
    case "measure": return cmdMeasure(!!flags["no-reboot"], !!flags.quick, flags.repeat);
    case "compare": return cmdCompare(rest[0], rest[1]);
    case "debloat": return cmdDebloat(flags.batch, !!flags.apply, allow, !!flags["reboot-check"], confirmTimeoutMs(flags["confirm-timeout"]));
    case "tune": return cmdTune(!!flags.apply, allow, confirmTimeoutMs(flags["confirm-timeout"]));
    case "rollback": return cmdRollback(flags.batch, !!flags.all, !!flags.apply);
    case "home": return cmdHome(rest[0], rest[1], !!flags.apply, confirmTimeoutMs(flags["confirm-timeout"]));
    case "crashes": return cmdCrashes();
    case "reboot": { const { adb } = await adbFor(); await adb.reboot(); return log("Reboot sent."); }
    default: log(USAGE); if (cmd && cmd !== "help") process.exitCode = 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    if (e instanceof GuardError) { console.error(e.message); process.exit(2); }
    if (e instanceof AdbError) { console.error(`✗ ${e.message}${e.hint ? `\n  ${e.hint}` : ""}`); process.exit(1); }
    if (e instanceof ProfileError || e instanceof SnapshotCorrupt || e instanceof CompareError) { console.error(`✗ ${e.message}`); process.exit(1); }
    console.error(e);
    process.exit(1);
  });
}
