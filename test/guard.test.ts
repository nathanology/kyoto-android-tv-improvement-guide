import { describe, expect, test } from "bun:test";
import { GuardError, assertAllowed, checkPackage, parseHome, validateAllow } from "../cli/guard";
import { fixture } from "./fake-tv";

describe("lifeline tier", () => {
  for (const pkg of [
    "android",
    "com.android.shell",
    "com.android.systemui",
    "com.android.tv.settings",
    "com.android.providers.tv",
    "com.mediatek.wifi.helper",
    "com.hisense.network.service",
    "com.android.networkstack",
  ]) {
    test(`refuses ${pkg} even with --allow`, () => {
      const v = checkPackage(pkg, { allow: [pkg] });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.tier).toBe("lifeline");
    });
  }
  test("the active home screen is lifeline", () => {
    const v = checkPackage("com.example.home", { home: "com.example.home", allow: ["com.example.home"] });
    expect(v).toMatchObject({ ok: false, tier: "lifeline" });
  });
});

describe("protected tier", () => {
  for (const pkg of [
    "com.google.android.gms",
    "com.android.vending",
    "com.google.android.webview",
    "com.mediatek.drm.widevine",
    "com.google.android.tv.remote.service",
    "com.google.android.katniss",
    "com.android.bluetooth",
    "com.google.android.tungsten.setupwraith",
    "com.mediatek.wwtv.tvcenter",
    "com.hisense.tv.customerlauncher",
  ]) {
    test(`refuses ${pkg} without --allow, allows with exact --allow`, () => {
      expect(checkPackage(pkg)).toMatchObject({ ok: false, tier: "protected" });
      expect(checkPackage(pkg, { allow: [pkg] })).toEqual({ ok: true });
    });
  }
});

test("ordinary packages are allowed", () => {
  expect(checkPackage("tv.pluto.android")).toEqual({ ok: true });
  expect(checkPackage("com.netflix.ninja")).toEqual({ ok: true }); // "net" alone must not match lifeline rules
  expect(checkPackage("com.google.android.tvrecommendations")).toEqual({ ok: true });
  expect(checkPackage("com.bamnetworks.mobile.android.gameday.atbat")).toEqual({ ok: true }); // MLB: "networks" mid-word
});

test("segment rule catches real network/provider packages (and errs on the side of caution)", () => {
  for (const p of ["com.android.networkstack.inprocess", "com.mediatek.network", "com.android.providers.settings", "com.hisense.wifi", "com.android.connectivity.resources", "com.wifiplayer.app"]) {
    expect(checkPackage(p)).toMatchObject({ ok: false, tier: "lifeline" });
  }
});

test("--allow rejects patterns and junk", () => {
  expect(() => validateAllow(["com.google.*"])).toThrow(/exact package name/);
  expect(() => validateAllow(["katniss"])).toThrow();
  expect(validateAllow(["com.google.android.katniss"])).toEqual(["com.google.android.katniss"]);
});

test("parseHome reads the real resolve-activity output", () => {
  expect(parseHome(fixture("resolve_home"))).toBe("com.google.android.tvlauncher");
  expect(parseHome("No activity found\n")).toBeNull();
});

test("assertAllowed lists every refusal", () => {
  try {
    assertAllowed(["tv.pluto.android", "com.android.shell", "com.android.vending"], {});
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(GuardError);
    expect((e as GuardError).refusals.map((r) => r.pkg)).toEqual(["com.android.shell", "com.android.vending"]);
  }
});
