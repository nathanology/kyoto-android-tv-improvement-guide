import { describe, expect, test } from "bun:test";
import { ProfileError, batchPackages, inventory, mergeInventory, validatePackages, validateTune } from "../cli/profile";
import { FakeTv } from "./fake-tv";

describe("inventory", () => {
  test("every new package defaults to keep", async () => {
    const p = await inventory(new FakeTv({ installed: ["tv.pluto.android", "com.netflix.ninja"] }), null);
    expect(p.device).toBe("SmartTV 4K FFM");
    expect(p.packages.every((e) => e.decision === "keep")).toBe(true);
    expect(p.packages.map((e) => e.pkg)).toContain("tv.pluto.android");
  });
  test("re-running keeps existing decisions and adds new packages as keep", () => {
    const existing = { device: "TV", packages: [{ pkg: "tv.pluto.android", decision: "disable" as const, batch: 1, reason: "bg memory" }] };
    const merged = mergeInventory(existing, ["tv.pluto.android", "com.new.app"], [], "TV");
    expect(merged.packages).toEqual([
      { pkg: "com.new.app", decision: "keep", system: true },
      { pkg: "tv.pluto.android", decision: "disable", batch: 1, reason: "bg memory" },
    ]);
  });
});

describe("validatePackages", () => {
  test("accepts a good profile and selects batches", () => {
    const { profile } = validatePackages({
      device: "TV",
      packages: [
        { pkg: "tv.pluto.android", decision: "disable", batch: 1 },
        { pkg: "com.xumo.xumo.tv", decision: "disable", batch: 2 },
        { pkg: "com.netflix.ninja", decision: "keep" },
      ],
    });
    expect(batchPackages(profile, 1)).toEqual(["tv.pluto.android"]);
    expect(batchPackages(profile, 3)).toEqual([]);
  });
  test("reports problems with the package name", () => {
    expect(() =>
      validatePackages({
        packages: [
          { pkg: "a.b", decision: "remove" },
          { pkg: "c.d", decision: "disable" },
          { pkg: "a.b", decision: "keep" },
        ],
      }),
    ).toThrow(/a\.b: decision must be[\s\S]*c\.d: disable entries need a batch[\s\S]*a\.b: listed twice/);
  });
  test("missing packages array", () => {
    expect(() => validatePackages({})).toThrow(ProfileError);
  });
  test("warns when a lifeline package is marked disable", () => {
    const { warnings } = validatePackages({ packages: [{ pkg: "com.android.systemui", decision: "disable", batch: 1 }] });
    expect(warnings[0]).toContain("lifeline");
  });
  test("warns when the home screen is marked disable", () => {
    const { warnings } = validatePackages({ packages: [{ pkg: "com.google.android.tvlauncher", decision: "disable", batch: 1 }] }, "com.google.android.tvlauncher");
    expect(warnings[0]).toContain("home screen");
  });
});

describe("validateTune", () => {
  test("accepts valid", () => {
    expect(validateTune({ settings: [{ ns: "global", key: "window_animation_scale", value: "0.5" }], restrictBackground: [{ pkg: "tv.pluto.android" }] }).settings.length).toBe(1);
  });
  test("rejects bad namespace and non-string values", () => {
    expect(() => validateTune({ settings: [{ ns: "vendor", key: "x", value: 1 }], restrictBackground: [] })).toThrow(/ns must be[\s\S]*string value/);
  });
});
