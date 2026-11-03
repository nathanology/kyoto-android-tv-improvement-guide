#!/usr/bin/env bun
// kyoto: make an Android TV fast again over adb, reversibly. Mutating commands are dry-run unless --apply.
//
// Exit codes: 0 ok · 1 error or batch reverted · 2 guard refused a package · 3 needs a human at the TV

import { createInterface } from "node:readline/promises";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Adb, AdbError, BootTimeout } from "./adb";
import { type Action, type LogEntry, type Prompt, batchStates, mergeScopes, readLog, rollback, rollbackTarget, runBatch } from "./batch";
import { pollCrashes, readLog as readCrashLog, summarize } from "./crashes";
import { GuardError, UnsafeArgument, resolveHome, safeComponent, validateAllow } from "./guard";
import { APPS_DIR, KYOTO_HOME, parseAppsList } from "./launcher";
import { redact } from "./redact";
import { CompareError, DEFAULT_APPS, type Measurement, compare, measureRepeated } from "./measure";
import {
  type CatalogEntry,
  DEFAULT_CHECK_APPS,
  type DeviceProfile,
  type PackagesProfile,
  ProfileError,
  RISKS,
  type TuneProfile,
  batchPackages,
  bestMatch,
  inventory,
  markPackages,
  matchScore,
  readDeviceProps,
  readJson,
  suggest,
  validateCatalog,
  validatePackages,
  validateProfileMeta,
  validateTune,
} from "./profile";
import { type Snapshot, SnapshotCorrupt, describeChange, loadSnapshot, parsePackageList } from "./snapshot";

const ROOT = fileURLToPath(new URL("..", import.meta.url)); // ends with a separator
const STATE = `${ROOT}state`;
const PROFILES = `${ROOT}profiles`;
const CATALOG = `${ROOT}catalog/packages.json`;
const DEVICE = `${STATE}/device.json`;

/** Written by `kyoto init` for a new TV: halve UI animations. Safe on every Android TV; missing keys are skipped. */
const STARTER_TUNE: TuneProfile = {
  settings: [
    { ns: "global", key: "window_animation_scale", value: "0.5", reason: "Halve menu animations; snappier navigation" },
    { ns: "global", key: "transition_animation_scale", value: "0.5", reason: "Halve screen transitions" },
    { ns: "global", key: "animator_duration_scale", value: "0.5", reason: "Halve UI animator durations" },
  ],
  restrictBackground: [],
};

interface DeviceConfig {
  serial: string;
  profile?: string;
  adbSurvivesReboot?: boolean;
  [k: string]: unknown;
}

const USAGE = `kyoto: make your Android TV fast again, reversibly

Setup
  kyoto connect [host:port]          pin the TV (default: saved serial), check access, pick a matching profile
  kyoto doctor [--reboot-probe] [--json]
                                     connection, device info, active profile, interrupted batches
  kyoto profiles [--json]            list device profiles and which one matches this TV
  kyoto init <name> [--from <profile>]
                                     create profiles/<name>/ for this TV from its package list
  kyoto use <profile>                make <profile> the active profile

Decide
  kyoto inventory                    add newly installed packages to the active profile (as keep)
  kyoto suggest [--write] [--json]   catalog matches for this TV, by risk; --write marks the "safe" ones
  kyoto mark <pkg>... (--batch N | --keep) [--reason "..."]
                                     set decisions in the active profile's packages.json

Change (dry run unless --apply; --apply needs a person at the TV)
  kyoto debloat --batch N [--apply] [--allow pkg]... [--reboot-check] [--confirm-timeout S]
  kyoto tune [--apply] [--allow pkg]... [--confirm-timeout S]
  kyoto home set <pkg/.Activity> [--apply] [--confirm-timeout S]
                                     make another launcher HOME (disables the current one, reversibly)
  kyoto home restore [--apply] [--yes]
  kyoto home apps <file>             set Kyoto Home's app list ("package[,fallback]|Label" per line)
  kyoto rollback (--batch LABEL | --all) [--apply] [--yes]

Measure
  kyoto measure [--quick | --no-reboot] [--repeat N]
                                     fresh (reboots, ~11 min/pass, default 2 passes), as-is,
                                     or quick (~1.5 min, no reboot, noisier)
  kyoto compare <a.json> <b.json>    compare two measurements of the same variant
  kyoto crashes                      poll + summarize crashes / low-memory kills
  kyoto capture-fixtures             record real TV output into test/fixtures/ (contributors)
  kyoto reboot

Global: --profile <name> overrides the active profile for one command.
Exit codes: 0 ok, 1 error/reverted, 2 guard refused, 3 needs a human at the TV.`;

const VALUE_FLAGS = new Set(["batch", "confirm-timeout", "repeat", "profile", "from", "reason"]);

export function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const allow: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--allow") allow.push(argv[++i] ?? "");
    else if (a.startsWith("--") && VALUE_FLAGS.has(a.slice(2))) flags[a.slice(2)] = argv[++i] ?? "";
    else if (a.startsWith("--")) flags[a.slice(2)] = true;
    else pos.push(a);
  }
  return { pos, flags, allow };
}

/** Thrown when a step needs someone holding the remote. Agents should hand the command to the user. */
export class NeedsHuman extends Error {}

/**
 * --apply asks "does the remote still work?" after each change. Only a person at the TV can answer,
 * so refuse to start when nobody can type (an AI agent's shell, CI) rather than time out and revert.
 */
export function requireHuman(isTTY: boolean | undefined, argv: string[]): void {
  if (isTTY) return;
  throw new NeedsHuman(
    "This step changes the TV and then asks whether the remote still works, so it needs a person at the TV.\n" +
      "Ask the user to run it in their own terminal window, in this folder, with the remote in hand:\n\n" +
      `  bun kyoto ${argv.join(" ")}\n`,
  );
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
const yes: Prompt = async () => "y";

let quiet = false;
const log = (m: string) => {
  if (!quiet) console.log(m);
};
const emit = (data: unknown) => console.log(JSON.stringify(data, null, 2));

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

// ---- profiles ------------------------------------------------------------------------------

interface ActiveProfile {
  name: string;
  dir: string;
  meta: DeviceProfile;
}

function profileNames(): string[] {
  try {
    return readdirSync(PROFILES, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

async function loadProfileMeta(name: string): Promise<DeviceProfile> {
  const raw = await readJson<unknown>(`${PROFILES}/${name}/profile.json`);
  return raw ? validateProfileMeta(raw, name) : { name };
}

async function allProfiles(): Promise<DeviceProfile[]> {
  return Promise.all(profileNames().map(loadProfileMeta));
}

async function activeProfile(flags: Record<string, string | boolean>): Promise<ActiveProfile> {
  const device = await readJson<DeviceConfig>(DEVICE);
  const name = typeof flags.profile === "string" && flags.profile ? flags.profile : device?.profile;
  if (!name) {
    throw new ProfileError(
      "No profile selected for this TV.\n  New TV: `kyoto init <name>`. Known TV: `kyoto profiles`, then `kyoto use <name>`.",
    );
  }
  if (!profileNames().includes(name)) throw new ProfileError(`No profile "${name}" in profiles/. See \`kyoto profiles\`.`);
  return { name, dir: `${PROFILES}/${name}`, meta: await loadProfileMeta(name) };
}

async function loadCatalog(): Promise<CatalogEntry[]> {
  return validateCatalog((await readJson<unknown>(CATALOG)) ?? []);
}

const checkAppsOf = (p: ActiveProfile) => p.meta.checkApps ?? DEFAULT_CHECK_APPS;

async function readPackages(p: ActiveProfile): Promise<unknown> {
  const raw = await readJson<unknown>(`${p.dir}/packages.json`);
  if (!raw) throw new ProfileError(`No packages.json in profiles/${p.name}/. Run \`kyoto inventory\`.`);
  return raw;
}

async function writeJson(path: string, data: unknown) {
  await Bun.write(path, JSON.stringify(data, null, 2) + "\n");
}

// ---- setup ---------------------------------------------------------------------------------

async function cmdConnect(target?: string) {
  const prev = (await readJson<DeviceConfig>(DEVICE)) ?? ({} as DeviceConfig);
  const serial = target ?? prev.serial;
  if (!serial) throw new AdbError("Which TV?", "Run `kyoto connect <tv-ip>:5555`.");
  const adb = new Adb(serial);
  await adb.connect();
  const props = await readDeviceProps(adb);
  const next: DeviceConfig = { ...prev, serial };
  // A different TV than last time: forget per-TV facts.
  if (prev.serial && prev.serial !== serial) {
    delete next.adbSurvivesReboot;
    delete next.profile;
  }
  log(`✓ Connected to ${props.manufacturer} ${props.model} (Android ${props.android}, device "${props.device}") at ${serial}`);
  if (!next.profile) {
    const match = bestMatch(await allProfiles(), props);
    if (match) {
      next.profile = match.name;
      log(`✓ Using profile "${match.name}" (matches this TV). Review it with \`kyoto suggest\`.`);
    } else {
      log(`No profile matches this TV yet. Create one: kyoto init ${slug(`${props.manufacturer}-${props.device}`)}`);
    }
  } else log(`Profile: ${next.profile}`);
  await saveDevice(next);
  const c = await pollCrashes(adb, `${STATE}/crashes.jsonl`);
  if (c.added) log(`  logged ${c.added} new crash / low-memory-kill events`);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function cmdDoctor(rebootProbe: boolean, json: boolean) {
  const { adb, device } = await adbFor();
  const props = await readDeviceProps(adb);
  const fp = (await adb.shell("getprop ro.build.fingerprint")).trim();
  const home = await resolveHome(adb);
  const disabled = parsePackageList(await adb.shell("pm list packages -d"));

  const states = [...batchStates(await readLog(STATE))];
  const interrupted = states.filter(([, s]) => s === "started").map(([l]) => l);
  const committed = states.filter(([, s]) => s === "committed").map(([l]) => l);

  if (json) {
    emit({ serial: device.serial, ...props, fingerprint: fp, home, profile: device.profile ?? null, disabled, committed, interrupted, adbSurvivesReboot: device.adbSurvivesReboot ?? null });
  } else {
    log(`TV:        ${props.manufacturer} ${props.model} (device "${props.device}", Android ${props.android}, API ${props.sdk})`);
    log(`Firmware:  ${fp}`);
    log(`Home app:  ${home ?? "unknown"}`);
    log(`Profile:   ${device.profile ?? "none (run `kyoto profiles` or `kyoto init <name>`)"}`);
    log(`Disabled:  ${disabled.length} packages`);
    log(`Serial:    ${device.serial}   adb survives reboot: ${device.adbSurvivesReboot ?? "not probed"}`);
    if (committed.length) log(`Committed: ${committed.join(", ")}`);
    for (const l of interrupted) log(`⚠ Batch ${l} was interrupted mid-way. Undo it with: kyoto rollback --batch ${l} --apply`);
    if (!interrupted.length) log("✓ No interrupted batches.");
  }

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
      log("✗ adb did not come back on its own. Re-enable debugging on the TV; --reboot-check stays disabled.");
    }
    await saveDevice(device);
  }
  await pollCrashes(adb, `${STATE}/crashes.jsonl`);
}

async function cmdProfiles(json: boolean) {
  const profiles = await allProfiles();
  let props = null;
  try {
    const { adb } = await adbFor();
    props = await readDeviceProps(adb);
  } catch {
    // Listing works offline; matching just isn't shown.
  }
  const active = (await readJson<DeviceConfig>(DEVICE))?.profile ?? null;
  const rows = profiles.map((p) => ({ name: p.name, description: p.description ?? "", matchesThisTv: props ? matchScore(p, props) > 0 : null, active: p.name === active }));
  if (json) return emit({ tv: props, profiles: rows });
  if (!rows.length) return log("No profiles yet. Create one: kyoto init <name>");
  for (const r of rows) log(`${r.active ? "*" : " "} ${r.name.padEnd(28)} ${r.matchesThisTv ? "[matches this TV] " : ""}${r.description}`);
  if (!props) log("\n(TV not reachable; can't show which profile matches.)");
}

async function cmdInit(name: string | undefined, from: string | boolean | undefined) {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new ProfileError("usage: kyoto init <name>   (lowercase letters, digits and dashes, e.g. tcl-c645)");
  if (profileNames().includes(name)) throw new ProfileError(`profiles/${name}/ already exists. Use \`kyoto use ${name}\`, or \`kyoto inventory\` to refresh it.`);
  const base = typeof from === "string" && from ? await activeProfile({ profile: from }) : null;
  const { adb, device } = await adbFor();
  const props = await readDeviceProps(adb);
  const dir = `${PROFILES}/${name}`;

  const basePackages = base ? (validatePackages(await readPackages(base)).profile) : null;
  const packages = await inventory(adb, basePackages ? { ...basePackages, device: props.model } : null);
  const baseTune = base ? await readJson<unknown>(`${base.dir}/tune.json`) : null;
  const meta: DeviceProfile = {
    name,
    description: `${props.manufacturer} ${props.model} (Android ${props.android})`,
    match: { manufacturer: props.manufacturer, device: props.device },
    checkApps: base?.meta.checkApps ?? DEFAULT_CHECK_APPS,
    notes: [],
  };
  await writeJson(`${dir}/profile.json`, meta);
  await writeJson(`${dir}/packages.json`, packages);
  await writeJson(`${dir}/tune.json`, baseTune ? validateTune(baseTune) : STARTER_TUNE);
  await saveDevice({ ...device, profile: name });
  const decided = packages.packages.filter((p) => p.decision === "disable").length;
  log(`✓ Created profiles/${name}/ with ${packages.packages.length} packages${base ? ` (${decided} disable decisions copied from ${base.name})` : " (all keep)"}`);
  log(`✓ "${name}" is now the active profile.\nNext: kyoto suggest`);
}

async function cmdUse(name: string | undefined) {
  if (!name) throw new ProfileError("usage: kyoto use <profile>");
  const p = await activeProfile({ profile: name });
  const device = await loadDevice();
  await saveDevice({ ...device, profile: p.name });
  log(`✓ Active profile: ${p.name}`);
}

// ---- decide --------------------------------------------------------------------------------

async function cmdInventory(flags: Record<string, string | boolean>) {
  const p = await activeProfile(flags);
  const { adb } = await adbFor();
  const path = `${p.dir}/packages.json`;
  const existing = await readJson<PackagesProfile>(path);
  const merged = await inventory(adb, existing);
  await writeJson(path, merged);
  const added = merged.packages.length - (existing?.packages.length ?? 0);
  log(`✓ ${merged.packages.length} packages in profiles/${p.name}/packages.json (${added >= 0 ? added : 0} new, all default to keep)`);
}

async function cmdSuggest(flags: Record<string, string | boolean>) {
  const p = await activeProfile(flags);
  const path = `${p.dir}/packages.json`;
  let { profile } = validatePackages(await readPackages(p));
  const catalog = await loadCatalog();
  if (flags.write) {
    // Only flip entries nobody has decided on yet (a reason means someone chose deliberately).
    const toMark = suggest(profile, catalog).filter((s) => s.entry.risk === "safe" && s.current.decision === "keep" && !s.current.reason);
    for (const s of toMark) profile = markPackages(profile, [s.entry.pkg], { batch: s.batch }, s.entry.label);
    await writeJson(path, profile);
    log(`✓ Marked ${toMark.length} safe package(s) for batch 1 in profiles/${p.name}/packages.json`);
    if (toMark.length) log("Next: kyoto debloat --batch 1   (dry run; shows the plan)\n");
  }
  const suggestions = suggest(profile, catalog);
  if (flags.json) {
    return emit(suggestions.map((s) => ({ ...s.entry, suggestedBatch: s.batch, decision: s.current.decision, batch: s.current.batch ?? null, reason: s.current.reason ?? null })));
  }
  if (!suggestions.length) return log("No catalog entries match this TV's packages. Decide with `kyoto mark`, and consider adding what you learn to catalog/packages.json.");
  for (const risk of RISKS) {
    const group = suggestions.filter((s) => s.entry.risk === risk);
    if (!group.length) continue;
    log(`\n${risk.toUpperCase()} (suggested batch ${group[0]!.batch})${risk === "optional" ? ": apps; disable only the ones nobody watches" : risk === "caution" ? ": turns off a system feature; read each note" : ": no user-facing loss"}`);
    for (const s of group) {
      const now = s.current.decision === "disable" ? `disable, batch ${s.current.batch}` : "keep";
      log(`  ${s.entry.pkg.padEnd(44)} [${now}]  ${s.entry.label}: ${s.entry.note}`);
    }
  }
  if (!flags.write) log(`\nTo mark every SAFE entry: kyoto suggest --write\nTo mark others:          kyoto mark <pkg>... --batch N --reason "why"`);
}

async function cmdMark(pkgs: string[], flags: Record<string, string | boolean>) {
  const keep = !!flags.keep;
  if (!pkgs.length || keep === (flags.batch !== undefined)) throw new ProfileError('usage: kyoto mark <pkg>... (--batch N | --keep) [--reason "..."]');
  const p = await activeProfile(flags);
  const { profile } = validatePackages(await readPackages(p));
  const reason = typeof flags.reason === "string" && flags.reason ? flags.reason : undefined;
  const next = markPackages(profile, pkgs, keep ? "keep" : { batch: Number(flags.batch) }, reason);
  await writeJson(`${p.dir}/packages.json`, next);
  log(`✓ ${pkgs.join(", ")} → ${keep ? "keep" : `disable in batch ${flags.batch}`}`);
}

// ---- measure -------------------------------------------------------------------------------

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
    await Bun.write(`${dir}/${name}.txt`, redact(await adb.shell(cmd)));
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
  log("Identifiers (serials, MACs, android_id, device names, …) were replaced with REDACTED.");
  log("⚠ Still read the diff before committing: `git diff test/fixtures/`.");
}

async function cmdMeasure(flags: Record<string, string | boolean>) {
  const quick = !!flags.quick;
  const noReboot = !!flags["no-reboot"];
  const repeat = flags.repeat === undefined ? (quick ? 1 : 2) : Number(flags.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw new Error("--repeat takes 1 to 5");
  const apps = await activeProfile(flags).then((p) => p.meta.measureApps, () => undefined);
  const { adb } = await adbFor();
  const variant = quick ? "quick" : noReboot ? "as-is" : "fresh";
  const m = await measureRepeated(adb, { variant, log, apps: apps ?? DEFAULT_APPS, ...(quick ? { runs: 3 } : {}) }, repeat);
  const path = `${STATE}/measurements/${variant}-${stamp()}.json`;
  await writeJson(path, m);
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

// ---- change --------------------------------------------------------------------------------

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

async function cmdDebloat(flags: Record<string, string | boolean>, allow: string[]) {
  const n = Number(flags.batch);
  if (!Number.isInteger(n) || n < 1) throw new Error("usage: kyoto debloat --batch N [--apply]");
  const apply = !!flags.apply;
  const rebootCheck = !!flags["reboot-check"];
  const p = await activeProfile(flags);
  const { adb, device } = await adbFor();
  if (rebootCheck && !device.adbSurvivesReboot) throw new Error("--reboot-check needs `kyoto doctor --reboot-probe` to pass first.");
  const { profile, warnings } = validatePackages(await readPackages(p), await resolveHome(adb));
  warnings.forEach((w) => log(`⚠ ${w}`));
  // Packages uninstalled since the inventory would fail `pm disable-user` and revert the whole batch.
  const installed = new Set(parsePackageList(await adb.shell("pm list packages")));
  const wanted = batchPackages(profile, n);
  const missing = wanted.filter((x) => !installed.has(x));
  if (missing.length) log(`(not installed on this TV, skipped: ${missing.join(", ")})`);
  const actions: Action[] = wanted.filter((x) => installed.has(x)).map((pkg) => ({ kind: "disable", pkg }));
  const label = `debloat-${n}`;
  const r = await runBatch({
    adb, label, actions, apply, allow: validateAllow(allow), prompt, checkApps: checkAppsOf(p), stateDir: STATE, rebootCheck, log,
    promptTimeoutMs: confirmTimeoutMs(flags["confirm-timeout"]),
    reapplyCommand: `kyoto debloat --batch ${n} --apply${allow.map((a) => ` --allow ${a}`).join("")}`,
  });
  if (r.status === "nothing-to-do") return log(`Batch ${n} has no packages marked disable${missing.length ? " that are installed" : ""}.`);
  if (r.status === "dry-run") printPlan(label, r.plan, false);
  await pollCrashes(adb, `${STATE}/crashes.jsonl`);
  if (r.status === "failed" || r.status === "reverted") process.exitCode = 1;
}

async function cmdTune(flags: Record<string, string | boolean>, allow: string[]) {
  const p = await activeProfile(flags);
  const { adb } = await adbFor();
  const raw = await readJson<unknown>(`${p.dir}/tune.json`);
  if (!raw) throw new ProfileError(`No tune.json in profiles/${p.name}/.`);
  const t = validateTune(raw);
  const actions: Action[] = [
    ...t.settings.map((s) => ({ kind: "setting" as const, ns: s.ns, key: s.key, value: s.value })),
    ...t.restrictBackground.map((r) => ({ kind: "restrict-bg" as const, pkg: r.pkg })),
  ];
  const r = await runBatch({
    adb, label: "tune", actions, apply: !!flags.apply, allow: validateAllow(allow), prompt, checkApps: checkAppsOf(p), stateDir: STATE, log,
    promptTimeoutMs: confirmTimeoutMs(flags["confirm-timeout"]),
    reapplyCommand: `kyoto tune --apply${allow.map((a) => ` --allow ${a}`).join("")}`,
  });
  if (r.status === "nothing-to-do") return log("tune.json has no settings or background restrictions.");
  if (r.status === "dry-run") printPlan("tune", r.plan, false);
  if (r.status === "failed" || r.status === "reverted") process.exitCode = 1;
}

async function cmdHome(sub: string | undefined, component: string | undefined, flags: Record<string, string | boolean>) {
  const apply = !!flags.apply;
  if (sub === "restore") {
    const entries = await readLog(STATE);
    const started = entries.filter((e) => e.label === "home" && e.event === "started").pop();
    if (!started) return log("kyoto never changed HOME; nothing to restore.");
    return cmdRollback({ ...flags, batch: "home" });
  }
  if (sub === "apps") return cmdHomeApps(component);
  if (sub !== "set" || !component || !/^[\w.]+\/[\w.$]+$/.test(component)) {
    throw new Error("usage: kyoto home set <package/.Activity> [--apply]  |  kyoto home restore [--apply]");
  }
  const p = await activeProfile(flags).catch(() => null);
  const checkApps = p ? checkAppsOf(p) : DEFAULT_CHECK_APPS;
  const { adb } = await adbFor();
  const pkg = component.split("/")[0]!;
  const current = await resolveHome(adb);
  if (!current) throw new Error("Can't tell which app is HOME right now; not changing it.");
  if (current === pkg) return log(`${pkg} is already HOME.`);

  // 1. The new launcher must actually open before we take HOME away from the current one.
  const start = await adb.shell(`am start -W -n ${safeComponent(component)}`);
  if (!/Status:\s*ok/.test(start)) throw new Error(`${component} didn't open; not changing HOME.\n${start.trim()}`);
  log(`✓ ${component} opens`);
  if (apply) {
    // Outside the batch snapshot on purpose: a preference for a launcher is harmless once the stock one is
    // re-enabled (system HOMEs outrank preferences), and without it the TV may show a chooser instead.
    await adb.shell(`cmd package set-home-activity ${component}`);
    log(`✓ set as preferred HOME`);
  }
  // 2. Stock launchers are usually high-priority system HOMEs that outrank any preference, so disable it.
  const r = await runBatch({
    adb, label: "home", actions: [{ kind: "disable", pkg: current }], apply, allow: [current], newHome: pkg,
    prompt, checkApps, stateDir: STATE, log, promptTimeoutMs: confirmTimeoutMs(flags["confirm-timeout"]),
    reapplyCommand: `kyoto home set ${component} --apply`,
  });
  if (r.status === "dry-run") printPlan("home", [`set ${component} as HOME`, ...r.plan], false);
  if (r.status === "committed") {
    await adb.shell("input keyevent KEYCODE_HOME");
    const now = await resolveHome(adb);
    log(now === pkg ? `✓ HOME is now ${pkg}. Undo with: kyoto home restore --apply` : `⚠ HOME resolves to ${now}; another system HOME took over. See docs/GUIDE.md, "Launcher".`);
  }
  if (r.status === "failed" || r.status === "reverted") process.exitCode = 1;
}

async function cmdHomeApps(file: string | undefined) {
  if (!file) throw new Error("usage: kyoto home apps <file>   (see launcher/apps.example.txt)");
  const lines = parseAppsList(await Bun.file(file).text());
  const { adb } = await adbFor();
  if (!parsePackageList(await adb.shell(`pm list packages ${KYOTO_HOME}`)).includes(KYOTO_HOME)) {
    throw new Error("Kyoto Home isn't installed. See docs/GUIDE.md, section 8 (Launcher).");
  }
  const installed = new Set(parsePackageList(await adb.shell("pm list packages")));
  await adb.shell(`mkdir -p ${APPS_DIR}`);
  await adb.push(file, `${APPS_DIR}/apps.txt`);
  log(`✓ Kyoto Home will show ${lines.length} rows (it re-reads the list whenever it comes to the front):`);
  for (const l of lines) log(`  ${l.label.padEnd(20)} ${l.pkgs.some((p) => installed.has(p)) ? "" : "(not installed; hidden)"}`);
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

async function cmdRollback(flags: Record<string, string | boolean>) {
  const { batch, all, apply } = flags;
  const { adb } = await adbFor();
  const entries = await readLog(STATE);
  let snapshotPath: string;
  let scope;
  let label: string;
  if (all) {
    const target = await originTarget(entries);
    snapshotPath = `${STATE}/snapshots/origin-merged.json`;
    await writeJson(snapshotPath, target);
    scope = mergeScopes(entries.flatMap((e) => (e.scope ? [e.scope] : [])));
    label = "all";
  } else if (typeof batch === "string" && batch) {
    const label0 = /^\d+$/.test(batch) ? `debloat-${batch}` : batch;
    const t = rollbackTarget(entries, label0);
    if (!t?.entry.snapshot) {
      const ran = entries.some((e) => e.label === label0 && e.event === "started");
      if (ran) return log(`✓ ${label0} hasn't run since the last rollback; nothing to undo.`);
      throw new Error(`No snapshot found for batch "${label0}".`);
    }
    snapshotPath = t.entry.snapshot;
    // Later batches' settings and app restrictions are undone too, not just their packages.
    scope = mergeScopes(entries.slice(t.index).flatMap((e) => (e.scope ? [e.scope] : [])));
    label = label0;
    log(`Note: this returns the TV to how it was right before ${label0}, which also undoes any later batches.`);
  } else {
    throw new Error("usage: kyoto rollback (--batch LABEL | --all) [--apply] [--yes]");
  }
  const r = await rollback({ adb, snapshotPath, scope, apply: !!apply, prompt: flags.yes ? yes : prompt, stateDir: STATE, label: `rollback-${label}`, log });
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

// ---- dispatch ------------------------------------------------------------------------------

const VERSE = [
  0x20, 0x2b, 0x40, 0x76, 0x4b, 0x32, 0x4b, 0x68, 0x7b, 0x56, 0x2c, 0x58, 0x64, 0x1e, 0x71, 0x42, 0x61, 0x5a, 0x23, 0x4e,
  0x69, 0x03, 0x29, 0x54, 0x69, 0x5d, 0x2a, 0x59, 0x2a, 0x2c, 0x3b, 0x59, 0x63, 0x06, 0x23, 0x17, 0x4a, 0x07, 0x2e, 0x08,
  0x5b, 0x72, 0x05, 0x35, 0x13, 0x7d, 0x14, 0x31, 0x16, 0x7f, 0x15, 0x22, 0x56, 0x60, 0x0d, 0x22, 0x44, 0x61, 0x09, 0x64,
  0x57, 0x69, 0x45, 0x08, 0x66, 0x39, 0x40, 0x29, 0x4c, 0x6e, 0x52, 0x27, 0x2a, 0x1f, 0x61, 0x07, 0x3b, 0x16, 0x7f, 0x02,
  0x25, 0x50, 0x7c, 0x55, 0x34, 0x47, 0x34, 0x3b, 0x21, 0x42, 0x3e, 0x4f, 0x67, 0x61, 0x64, 0x08, 0x37, 0x59, 0x2a,
];

/** Unknown words fall through to the usage text. */
function verse(word: string): string | null {
  let h = 0x811c9dc5;
  for (const c of word) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  if (h !== 0x193977e2) return null;
  return String.fromCharCode(...VERSE.map((b, i) => b ^ word.charCodeAt(i % word.length) ^ ((i * 31 + 7) & 0x7f)));
}

export async function main(argv: string[]) {
  const { pos, flags, allow } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  quiet = !!flags.json;
  const needsHuman = (cmd === "debloat" || cmd === "tune" || (cmd === "home" && rest[0] === "set")) && !!flags.apply;
  if (needsHuman) requireHuman(process.stdin.isTTY, argv);
  if ((cmd === "rollback" || cmd === "home") && flags.apply && !flags.yes && !process.stdin.isTTY) {
    throw new NeedsHuman("Rollback asks for confirmation. Re-run with --yes to restore without asking (it only undoes kyoto's own changes).");
  }
  switch (cmd) {
    case "connect": return cmdConnect(rest[0]);
    case "doctor": return cmdDoctor(!!flags["reboot-probe"], !!flags.json);
    case "profiles": return cmdProfiles(!!flags.json);
    case "init": return cmdInit(rest[0], flags.from);
    case "use": return cmdUse(rest[0]);
    case "inventory": return cmdInventory(flags);
    case "suggest": return cmdSuggest(flags);
    case "mark": return cmdMark(rest, flags);
    case "capture-fixtures": return cmdCaptureFixtures();
    case "measure": return cmdMeasure(flags);
    case "compare": return cmdCompare(rest[0], rest[1]);
    case "debloat": return cmdDebloat(flags, allow);
    case "tune": return cmdTune(flags, allow);
    case "rollback": return cmdRollback(flags);
    case "home": return cmdHome(rest[0], rest[1], flags);
    case "crashes": return cmdCrashes();
    case "reboot": { const { adb } = await adbFor(); await adb.reboot(); return log("Reboot sent."); }
    default: {
      const v = cmd ? verse(cmd) : null;
      if (v) return console.log(`\n  ${v}\n`);
      console.log(USAGE);
      if (cmd && cmd !== "help") process.exitCode = 1;
    }
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    if (e instanceof GuardError) { console.error(e.message); process.exit(2); }
    if (e instanceof NeedsHuman) { console.error(`✋ ${e.message}`); process.exit(3); }
    if (e instanceof AdbError) { console.error(`✗ ${e.message}${e.hint ? `\n  ${e.hint}` : ""}`); process.exit(1); }
    if (e instanceof ProfileError || e instanceof SnapshotCorrupt || e instanceof CompareError || e instanceof UnsafeArgument) { console.error(`✗ ${e.message}`); process.exit(1); }
    console.error(e);
    process.exit(1);
  });
}
