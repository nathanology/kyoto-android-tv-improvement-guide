// Snapshots are the undo mechanism. One is taken BEFORE any batch mutates the TV,
// so a crash or Wi-Fi drop mid-batch still leaves a complete restore point.
//
//   take() ──▶ { disabled pkgs, settings[global|secure|system], appops/bucket per pkg }
//   diff(target, live, scope) ──▶ Change[]        (only managed settings keys + scoped pkgs)
//   restore(adb, target, scope) = diff + apply     (idempotent: 2nd run finds no changes)

import type { AdbLike } from "./adb";
import { CommandFailed } from "./adb";

export const NAMESPACES = ["global", "secure", "system"] as const;
export type Namespace = (typeof NAMESPACES)[number];

export interface AppState {
  runInBackground: string; // allow | ignore | deny | default
  bucket: string | null; // active | working_set | frequent | rare | restricted | null (unknown)
}

export interface Snapshot {
  version: 1;
  takenAt: string;
  label: string;
  fingerprint: string;
  apiLevel: number;
  disabled: string[];
  settings: Record<Namespace, Record<string, string>>;
  apps: Record<string, AppState>;
}

export type Change =
  | { kind: "pkg"; pkg: string; to: "enabled" | "disabled" }
  | { kind: "setting"; ns: Namespace; key: string; to: string | null }
  | { kind: "appop"; pkg: string; to: string }
  | { kind: "bucket"; pkg: string; to: string };

export interface Scope {
  /** Settings keys kyoto manages; other keys (boot_count etc.) are never restored. */
  settingsKeys: { ns: Namespace; key: string }[];
  /** Packages whose appops/bucket kyoto manages. */
  appPkgs: string[];
}

const BUCKETS: Record<string, string> = { "10": "active", "20": "working_set", "30": "frequent", "40": "rare", "45": "restricted" };

export function parsePackageList(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("package:"))
    .map((l) => l.slice("package:".length))
    .sort();
}

export function parseSettingsList(out: string): Record<string, string> {
  const res: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    res[line.slice(0, i)] = line.slice(i + 1);
  }
  return res;
}

export function parseAppop(out: string): string {
  const m = out.match(/RUN_IN_BACKGROUND:\s*(\w+)/);
  return m?.[1] ?? "default";
}

export function parseBucket(out: string): string | null {
  const v = out.trim();
  if (BUCKETS[v]) return BUCKETS[v]!;
  if (Object.values(BUCKETS).includes(v)) return v;
  return null; // exempted (5), never (50), or unsupported
}

export async function takeSnapshot(adb: AdbLike, label: string, appPkgs: string[] = []): Promise<Snapshot> {
  const [fingerprint, sdk, disabledOut] = await Promise.all([
    adb.shell("getprop ro.build.fingerprint"),
    adb.shell("getprop ro.build.version.sdk"),
    adb.shell("pm list packages -d"),
  ]);
  const settings = {} as Snapshot["settings"];
  for (const ns of NAMESPACES) settings[ns] = parseSettingsList(await adb.shell(`settings list ${ns}`));
  const apps: Record<string, AppState> = {};
  for (const pkg of appPkgs) {
    apps[pkg] = {
      runInBackground: parseAppop(await adb.shell(`cmd appops get ${pkg} RUN_IN_BACKGROUND`)),
      bucket: parseBucket(await adb.shell(`am get-standby-bucket ${pkg}`)),
    };
  }
  return {
    version: 1,
    takenAt: new Date().toISOString(),
    label,
    fingerprint: fingerprint.trim(),
    apiLevel: Number(sdk.trim()) || 0,
    disabled: parsePackageList(disabledOut),
    settings,
    apps,
  };
}

/** Changes needed to turn `live` back into `target`, limited to what kyoto manages. */
export function diffSnapshots(target: Snapshot, live: Snapshot, scope: Scope): Change[] {
  const changes: Change[] = [];
  const want = new Set(target.disabled);
  const have = new Set(live.disabled);
  for (const pkg of live.disabled) if (!want.has(pkg)) changes.push({ kind: "pkg", pkg, to: "enabled" });
  for (const pkg of target.disabled) if (!have.has(pkg)) changes.push({ kind: "pkg", pkg, to: "disabled" });

  for (const { ns, key } of scope.settingsKeys) {
    const t = target.settings[ns][key] ?? null;
    const l = live.settings[ns][key] ?? null;
    if (t !== l) changes.push({ kind: "setting", ns, key, to: t });
  }
  for (const pkg of scope.appPkgs) {
    const t = target.apps[pkg];
    const l = live.apps[pkg];
    if (!t || !l) continue;
    if (t.runInBackground !== l.runInBackground) changes.push({ kind: "appop", pkg, to: t.runInBackground });
    if (t.bucket && t.bucket !== l.bucket) changes.push({ kind: "bucket", pkg, to: t.bucket });
  }
  return changes;
}

export function changeToCommand(c: Change): string {
  switch (c.kind) {
    case "pkg":
      return c.to === "enabled" ? `pm enable ${c.pkg}` : `pm disable-user --user 0 ${c.pkg}`;
    case "setting":
      return c.to === null ? `settings delete ${c.ns} ${c.key}` : `settings put ${c.ns} ${c.key} ${shellQuote(c.to)}`;
    case "appop":
      return `cmd appops set ${c.pkg} RUN_IN_BACKGROUND ${c.to}`;
    case "bucket":
      return `am set-standby-bucket ${c.pkg} ${c.to}`;
  }
}

export function describeChange(c: Change): string {
  switch (c.kind) {
    case "pkg":
      return `${c.to === "enabled" ? "enable " : "disable"} ${c.pkg}`;
    case "setting":
      return `setting ${c.ns}/${c.key} → ${c.to ?? "(delete)"}`;
    case "appop":
      return `background ${c.pkg} → ${c.to}`;
    case "bucket":
      return `standby bucket ${c.pkg} → ${c.to}`;
  }
}

export function shellQuote(v: string): string {
  return /^[\w.,:/@%+-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

export interface RestoreResult {
  applied: Change[];
  failed: { change: Change; error: string }[];
}

export async function applyChanges(adb: AdbLike, changes: Change[]): Promise<RestoreResult> {
  const res: RestoreResult = { applied: [], failed: [] };
  for (const c of changes) {
    try {
      await adb.shell(changeToCommand(c));
      res.applied.push(c);
    } catch (e) {
      if (!(e instanceof CommandFailed)) throw e; // connection problems abort the restore
      res.failed.push({ change: c, error: e.message });
    }
  }
  return res;
}

export async function restoreSnapshot(adb: AdbLike, target: Snapshot, scope: Scope): Promise<RestoreResult> {
  const live = await takeSnapshot(adb, "live", scope.appPkgs);
  return applyChanges(adb, diffSnapshots(target, live, scope));
}

export class SnapshotCorrupt extends Error {}

export async function saveSnapshot(path: string, s: Snapshot): Promise<void> {
  await Bun.write(path, JSON.stringify(s, null, 2) + "\n");
}

export async function loadSnapshot(path: string): Promise<Snapshot> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new SnapshotCorrupt(`Snapshot not found: ${path}`);
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new SnapshotCorrupt(`Snapshot ${path} is truncated or not valid JSON; refusing to restore from it.`);
  }
  const s = data as Partial<Snapshot>;
  if (s.version !== 1 || !Array.isArray(s.disabled) || !s.settings || !s.apps || NAMESPACES.some((ns) => !s.settings![ns])) {
    throw new SnapshotCorrupt(`Snapshot ${path} is missing required fields; refusing to restore from it.`);
  }
  return s as Snapshot;
}
