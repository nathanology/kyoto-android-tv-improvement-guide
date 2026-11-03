// Device profile: which packages to disable (in numbered batches) and which settings to tune.
// Only entries explicitly marked "disable" are ever acted on; everything else defaults to keep.

import type { AdbLike } from "./adb";
import { checkPackage } from "./guard";
import { NAMESPACES, type Namespace, parsePackageList } from "./snapshot";

export interface PackageEntry {
  pkg: string;
  decision: "keep" | "disable";
  batch?: number;
  system?: boolean;
  reason?: string;
}

export interface PackagesProfile {
  device: string;
  packages: PackageEntry[];
}

export interface TuneProfile {
  settings: { ns: Namespace; key: string; value: string; reason?: string }[];
  /** Packages to stop running in the background (appops + standby bucket on API 30+). */
  restrictBackground: { pkg: string; reason?: string }[];
}

export class ProfileError extends Error {}

export function validatePackages(data: unknown, home: string | null = null): { profile: PackagesProfile; warnings: string[] } {
  const p = data as PackagesProfile;
  if (!p || typeof p !== "object" || !Array.isArray(p.packages)) throw new ProfileError("packages.json: missing `packages` array");
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const [i, e] of p.packages.entries()) {
    const at = e?.pkg ? e.pkg : `entry #${i}`;
    if (!e || typeof e.pkg !== "string" || !e.pkg) errors.push(`${at}: missing pkg`);
    else if (seen.has(e.pkg)) errors.push(`${at}: listed twice`);
    else seen.add(e.pkg);
    if (e?.decision !== "keep" && e?.decision !== "disable") errors.push(`${at}: decision must be "keep" or "disable"`);
    if (e?.decision === "disable") {
      if (!Number.isInteger(e.batch) || (e.batch as number) < 1) errors.push(`${at}: disable entries need a batch number ≥ 1`);
      const v = checkPackage(e.pkg, { home });
      if (!v.ok && v.tier === "lifeline") warnings.push(`${e.pkg}: marked disable but is lifeline (${v.reason}); it will always be refused`);
    }
  }
  if (errors.length) throw new ProfileError("packages.json has problems:\n  " + errors.join("\n  "));
  return { profile: p, warnings };
}

export function validateTune(data: unknown): TuneProfile {
  const t = data as TuneProfile;
  const errors: string[] = [];
  if (!t || !Array.isArray(t.settings) || !Array.isArray(t.restrictBackground)) throw new ProfileError("tune.json: needs `settings` and `restrictBackground` arrays");
  for (const s of t.settings) {
    if (!NAMESPACES.includes(s.ns)) errors.push(`${s.key ?? "?"}: ns must be global|secure|system`);
    if (!s.key || typeof s.value !== "string") errors.push(`${s.key ?? "?"}: needs key and string value`);
  }
  for (const r of t.restrictBackground) if (!r.pkg) errors.push("restrictBackground entry missing pkg");
  if (errors.length) throw new ProfileError("tune.json has problems:\n  " + errors.join("\n  "));
  return t;
}

export function batchPackages(p: PackagesProfile, batch: number): string[] {
  return p.packages.filter((e) => e.decision === "disable" && e.batch === batch).map((e) => e.pkg);
}

/** Merge the TV's live package list into the profile. Existing decisions are kept; new packages default to keep. */
export function mergeInventory(existing: PackagesProfile | null, system: string[], user: string[], device: string): PackagesProfile {
  const byPkg = new Map((existing?.packages ?? []).map((e) => [e.pkg, e]));
  const sys = new Set(system);
  const all = [...new Set([...system, ...user])].sort();
  return {
    device: existing?.device ?? device,
    packages: all.map((pkg) => byPkg.get(pkg) ?? { pkg, decision: "keep", system: sys.has(pkg) }),
  };
}

export async function inventory(adb: AdbLike, existing: PackagesProfile | null): Promise<PackagesProfile> {
  const [system, user, model] = await Promise.all([
    adb.shell("pm list packages -s"),
    adb.shell("pm list packages -3"),
    adb.shell("getprop ro.product.model"),
  ]);
  return mergeInventory(existing, parsePackageList(system), parsePackageList(user), model.trim());
}

export async function readJson<T>(path: string): Promise<T | null> {
  const f = Bun.file(path);
  return (await f.exists()) ? ((await f.json()) as T) : null;
}
