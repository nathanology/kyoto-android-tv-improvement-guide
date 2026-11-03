// Device profile: which packages to disable (in numbered batches) and which settings to tune.
// Only entries explicitly marked "disable" are ever acted on; everything else defaults to keep.
//
//   profiles/<name>/profile.json   what TV this is for (match rules) + which apps to check/measure
//   profiles/<name>/packages.json  keep/disable decision per package
//   profiles/<name>/tune.json      settings + background restrictions
//   catalog/packages.json          shared knowledge: what a package is and how risky disabling it is

import type { AdbLike } from "./adb";
import { checkPackage, isPackageName, isSettingKey } from "./guard";
import { NAMESPACES, type Namespace, parsePackageList } from "./snapshot";

/** Apps launched after every batch to prove the TV still works. Missing ones are skipped. */
export const DEFAULT_CHECK_APPS = [
  "com.netflix.ninja",
  "com.google.android.youtube.tv",
  "com.disney.disneyplus",
  "com.amazon.amazonvideo.livingroom",
];

export const PROP_KEYS = ["manufacturer", "brand", "model", "device"] as const;
export type PropKey = (typeof PROP_KEYS)[number];
export type DeviceProps = Record<PropKey, string> & { android: string; sdk: number };

export interface DeviceProfile {
  name: string;
  description?: string;
  /** All given keys must equal the TV's ro.product.* value (case-insensitive) for the profile to match. */
  match?: Partial<Record<PropKey, string>>;
  checkApps?: string[];
  measureApps?: string[];
  notes?: string[];
}

export type Risk = "safe" | "optional" | "caution";
export const RISKS: Risk[] = ["safe", "optional", "caution"];
/** Default batch per risk, so each batch is one kind of change and easy to blame or undo. */
export const RISK_BATCH: Record<Risk, number> = { safe: 1, optional: 2, caution: 3 };

export interface CatalogEntry {
  pkg: string;
  label: string;
  risk: Risk;
  note: string;
  /** Profiles where this package was seen and disabled without problems. */
  seenOn?: string[];
}

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
    else if (!isPackageName(e.pkg)) errors.push(`${JSON.stringify(e.pkg)}: not a valid package name`);
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
    else if (!isSettingKey(s.key)) errors.push(`${JSON.stringify(s.key)}: not a valid setting key`);
  }
  for (const r of t.restrictBackground) if (!isPackageName(r.pkg)) errors.push(`restrictBackground: ${JSON.stringify(r.pkg)} is not a valid package name`);
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

export async function readDeviceProps(adb: AdbLike): Promise<DeviceProps> {
  const get = (p: string) => adb.shell(`getprop ${p}`).then((s) => s.trim());
  const [manufacturer, brand, model, device, android, sdk] = await Promise.all([
    get("ro.product.manufacturer"),
    get("ro.product.brand"),
    get("ro.product.model"),
    get("ro.product.device"),
    get("ro.build.version.release"),
    get("ro.build.version.sdk"),
  ]);
  return { manufacturer: manufacturer!, brand: brand!, model: model!, device: device!, android: android!, sdk: Number(sdk) || 0 };
}

export function validateProfileMeta(data: unknown, dirName: string): DeviceProfile {
  const p = data as DeviceProfile;
  const errors: string[] = [];
  if (!p || typeof p !== "object") throw new ProfileError(`profiles/${dirName}/profile.json: not an object`);
  if (p.name !== dirName) errors.push(`name must equal the folder name "${dirName}"`);
  for (const k of Object.keys(p.match ?? {})) if (!PROP_KEYS.includes(k as PropKey)) errors.push(`match.${k}: use one of ${PROP_KEYS.join(", ")}`);
  for (const k of ["checkApps", "measureApps"] as const) {
    if (p[k] !== undefined && (!Array.isArray(p[k]) || !p[k]!.every(isPackageName))) errors.push(`${k} must be a list of package names`);
  }
  if (errors.length) throw new ProfileError(`profiles/${dirName}/profile.json has problems:\n  ` + errors.join("\n  "));
  return p;
}

/** Number of matched keys, or 0 when the profile has no match rules or any rule differs. */
export function matchScore(p: DeviceProfile, props: DeviceProps): number {
  const rules = Object.entries(p.match ?? {}) as [PropKey, string][];
  if (!rules.length) return 0;
  return rules.every(([k, v]) => props[k]?.toLowerCase() === v.toLowerCase()) ? rules.length : 0;
}

export function bestMatch(profiles: DeviceProfile[], props: DeviceProps): DeviceProfile | null {
  let best: DeviceProfile | null = null;
  let score = 0;
  for (const p of profiles) {
    const s = matchScore(p, props);
    if (s > score) [best, score] = [p, s];
  }
  return best;
}

export function validateCatalog(data: unknown): CatalogEntry[] {
  if (!Array.isArray(data)) throw new ProfileError("catalog/packages.json: must be a list");
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const e of data as CatalogEntry[]) {
    if (!isPackageName(e?.pkg) || seen.has(e.pkg)) errors.push(`${JSON.stringify(e?.pkg)}: invalid, missing or listed twice`);
    seen.add(e?.pkg);
    if (!RISKS.includes(e?.risk)) errors.push(`${e?.pkg}: risk must be ${RISKS.join("|")}`);
    if (!e?.label || !e?.note) errors.push(`${e?.pkg}: needs label and note`);
    const v = checkPackage(e?.pkg ?? "", {});
    if (!v.ok && v.tier === "lifeline") errors.push(`${e.pkg}: lifeline packages can't be in the catalog`);
  }
  if (errors.length) throw new ProfileError("catalog/packages.json has problems:\n  " + errors.join("\n  "));
  return data as CatalogEntry[];
}

export interface Suggestion {
  entry: CatalogEntry;
  current: PackageEntry;
  batch: number;
}

/** Catalog entries for packages this profile lists (i.e. installed on the TV), safest first. */
export function suggest(p: PackagesProfile, catalog: CatalogEntry[]): Suggestion[] {
  const byPkg = new Map(p.packages.map((e) => [e.pkg, e]));
  return catalog
    .flatMap((entry) => {
      const current = byPkg.get(entry.pkg);
      return current ? [{ entry, current, batch: RISK_BATCH[entry.risk] }] : [];
    })
    .sort((a, b) => a.batch - b.batch || a.entry.pkg.localeCompare(b.entry.pkg));
}

/**
 * Set decisions for packages already in the profile. Unknown packages are an error, so a typo
 * can't silently do nothing. Lifeline packages are refused here, as they would be at apply time.
 */
export function markPackages(p: PackagesProfile, pkgs: string[], to: { batch: number } | "keep", reason?: string): PackagesProfile {
  const known = new Set(p.packages.map((e) => e.pkg));
  const unknown = pkgs.filter((x) => !known.has(x));
  if (unknown.length) throw new ProfileError(`Not in this profile (run \`kyoto inventory\` if it was just installed): ${unknown.join(", ")}`);
  if (to !== "keep") {
    if (!Number.isInteger(to.batch) || to.batch < 1) throw new ProfileError("--batch takes a whole number ≥ 1");
    const lifeline = pkgs.filter((x) => {
      const v = checkPackage(x, {});
      return !v.ok && v.tier === "lifeline";
    });
    if (lifeline.length) throw new ProfileError(`Refusing: lifeline package(s) can never be disabled: ${lifeline.join(", ")}`);
  }
  const want = new Set(pkgs);
  return {
    ...p,
    packages: p.packages.map((e) => {
      if (!want.has(e.pkg)) return e;
      const { batch: _b, reason: oldReason, ...rest } = e;
      // An old reason only survives if the decision doesn't flip ("Vudu (unused)" on a keep would mislead).
      const why = reason ?? (e.decision === (to === "keep" ? "keep" : "disable") ? oldReason : undefined);
      return to === "keep"
        ? { ...rest, decision: "keep" as const, ...(why ? { reason: why } : {}) }
        : { ...rest, decision: "disable" as const, batch: to.batch, ...(why ? { reason: why } : {}) };
    }),
  };
}

export async function readJson<T>(path: string): Promise<T | null> {
  const f = Bun.file(path);
  return (await f.exists()) ? ((await f.json()) as T) : null;
}
