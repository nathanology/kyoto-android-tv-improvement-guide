// Package guard. Checked before EVERY mutating adb call.
//
//   lifeline  → never touched, no override. Disabling these can cut the Mac off from the TV
//               (network, adb shell, system UI, settings, active HOME).
//   protected → refused unless the exact package name is passed via --allow.
//   anything else → allowed.

import type { AdbLike } from "./adb";

export type Tier = "lifeline" | "protected";

const LIFELINE: string[] = [
  "android",
  "com.android.shell",
  "com.android.systemui",
  "com.android.packageinstaller",
  "com.google.android.packageinstaller",
  "com.android.permissioncontroller",
  "com.google.android.permissioncontroller",
  "com.android.settings",
  "com.android.tv.settings",
];

// Matched against whole dot-separated name segments, so "com.mediatek.network" and
// "com.android.networkstack" hit but "com.bamnetworks.mobile" (MLB) doesn't.
const LIFELINE_SEGMENT = /(^|\.)(providers?|wifi|network|connectivity|netd|ethernet|dhcp|tethering)/i;

const PROTECTED: string[] = [
  "com.google.android.gms*",
  "com.google.android.gsf*",
  "com.android.vending",
  "*webview*",
  "*widevine*",
  "*drm*",
  "*remote*",
  "*inputmethod*",
  "*katniss*", // voice search / assistant
  "*bluetooth*",
  "*setupwraith*",
  "*tvinput*",
  "*tv.input*",
  "*tvcenter*",
  "*tuner*",
  "*hdmi*",
  "*cec*",
  "*launcher*",
];

function toRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}
const LIFELINE_RE = LIFELINE.map((g) => [g, toRegex(g)] as const);
const PROTECTED_RE = PROTECTED.map((g) => [g, toRegex(g)] as const);

export type Verdict = { ok: true } | { ok: false; tier: Tier; reason: string };

export interface GuardOptions {
  /** Exact package names the user explicitly allowed (protected tier only). */
  allow?: Iterable<string>;
  /** Package currently handling HOME; always lifeline. */
  home?: string | null;
}

export function checkPackage(pkg: string, opts: GuardOptions = {}): Verdict {
  if (opts.home && pkg === opts.home) {
    return { ok: false, tier: "lifeline", reason: "it is the active home screen" };
  }
  for (const [g, re] of LIFELINE_RE) {
    if (re.test(pkg)) return { ok: false, tier: "lifeline", reason: `matches lifeline rule ${g}` };
  }
  const seg = pkg.match(LIFELINE_SEGMENT);
  if (seg) return { ok: false, tier: "lifeline", reason: `network/system-provider package (".${seg[2]}")` };
  const allow = new Set(opts.allow ?? []);
  for (const [g, re] of PROTECTED_RE) {
    if (re.test(pkg)) {
      if (allow.has(pkg)) return { ok: true };
      return { ok: false, tier: "protected", reason: `matches protected rule ${g} (pass --allow ${pkg} to override)` };
    }
  }
  return { ok: true };
}

// Profiles and the catalog are community-contributed, and their strings end up in `adb shell` command
// lines on the TV. Only plain identifiers may get there, so a malicious entry like "a.b; reboot" can't.
const PACKAGE_NAME = /^[a-zA-Z][\w]*(\.[\w]+)*$/; // "android" itself has no dot
const SETTING_KEY = /^[\w.\-]+$/;
const COMPONENT = /^[a-zA-Z][\w]*(\.[\w]+)+\/[\w.$]+$/;

export const isPackageName = (s: unknown): s is string => typeof s === "string" && PACKAGE_NAME.test(s);
export const isSettingKey = (s: unknown): s is string => typeof s === "string" && SETTING_KEY.test(s);
export const isComponent = (s: unknown): s is string => typeof s === "string" && COMPONENT.test(s);

export class UnsafeArgument extends Error {}

/** Last line of defence before a value is interpolated into a shell command. */
export function safePkg(s: string): string {
  if (!isPackageName(s)) throw new UnsafeArgument(`Refusing to use "${s}" in a TV command: not a package name.`);
  return s;
}
export function safeKey(s: string): string {
  if (!isSettingKey(s)) throw new UnsafeArgument(`Refusing to use "${s}" in a TV command: not a setting key.`);
  return s;
}
export function safeComponent(s: string): string {
  if (!isComponent(s)) throw new UnsafeArgument(`Refusing to use "${s}" in a TV command: not an activity name.`);
  return s;
}

/** --allow takes exact package names only; patterns would defeat the point. */
export function validateAllow(values: string[]): string[] {
  for (const v of values) {
    // Stricter than isPackageName: a bare word like "katniss" is a fragment, not an exact package.
    if (!isPackageName(v) || !v.includes(".")) {
      throw new Error(`--allow needs an exact package name, got "${v}" (no wildcards)`);
    }
  }
  return values;
}

export function parseHome(resolveOutput: string): string | null {
  const last = resolveOutput.trim().split("\n").pop()?.trim() ?? "";
  const m = last.match(/^([\w.]+)\//);
  return m?.[1] ?? null;
}

export async function resolveHome(adb: AdbLike): Promise<string | null> {
  const out = await adb.shell(
    "cmd package resolve-activity --brief -c android.intent.category.HOME -a android.intent.action.MAIN",
  );
  return parseHome(out);
}

export class GuardError extends Error {
  constructor(readonly refusals: { pkg: string; tier: Tier; reason: string }[]) {
    super(
      "Refusing to touch protected packages:\n" +
        refusals.map((r) => `  ✗ ${r.pkg} [${r.tier}] ${r.reason}`).join("\n"),
    );
    this.name = "GuardError";
  }
}

export function assertAllowed(pkgs: string[], opts: GuardOptions): void {
  const refusals = pkgs.flatMap((pkg) => {
    const v = checkPackage(pkg, opts);
    return v.ok ? [] : [{ pkg, tier: v.tier, reason: v.reason }];
  });
  if (refusals.length) throw new GuardError(refusals);
}
