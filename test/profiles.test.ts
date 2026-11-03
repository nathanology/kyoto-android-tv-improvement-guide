// Checks every shipped profile and the catalog, so a bad contribution fails CI instead of a user's TV.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  type DeviceProps,
  ProfileError,
  RISK_BATCH,
  bestMatch,
  markPackages,
  matchScore,
  readDeviceProps,
  suggest,
  validateCatalog,
  validatePackages,
  validateProfileMeta,
  validateTune,
} from "../cli/profile";
import { FakeTv } from "./fake-tv";

const ROOT = new URL("../", import.meta.url).pathname;
const json = (p: string) => JSON.parse(readFileSync(`${ROOT}${p}`, "utf8"));
const names = readdirSync(`${ROOT}profiles`, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

describe("shipped profiles", () => {
  test("there is at least one", () => expect(names.length).toBeGreaterThan(0));
  for (const name of names) {
    test(`${name} is valid`, () => {
      const meta = validateProfileMeta(json(`profiles/${name}/profile.json`), name);
      expect(Object.keys(meta.match ?? {}).length).toBeGreaterThan(0);
      const { warnings } = validatePackages(json(`profiles/${name}/packages.json`));
      expect(warnings).toEqual([]);
      validateTune(json(`profiles/${name}/tune.json`));
    });
  }
});

describe("catalog", () => {
  const catalog = validateCatalog(json("catalog/packages.json"));
  test("is valid and sorted by risk then package", () => {
    const order = catalog.map((e) => `${RISK_BATCH[e.risk]}:${e.pkg}`);
    expect(order).toEqual([...order].sort());
  });
  test("rejects lifeline packages and bad risk", () => {
    expect(() => validateCatalog([{ pkg: "com.android.systemui", label: "x", risk: "safe", note: "x" }])).toThrow(/lifeline/);
    expect(() => validateCatalog([{ pkg: "a.b", label: "x", risk: "yolo", note: "x" }])).toThrow(/risk/);
  });
});

const props: DeviceProps = { manufacturer: "Hisense", brand: "Hisense", model: "SmartTV 4K FFM", device: "huangshan", android: "10", sdk: 29 };

describe("profile matching", () => {
  test("all rules must match, case-insensitively; more rules win", () => {
    const loose = { name: "hisense-any", match: { manufacturer: "hisense" } };
    const exact = { name: "hisense-huangshan", match: { manufacturer: "Hisense", device: "huangshan" } };
    const other = { name: "tcl", match: { manufacturer: "TCL" } };
    expect(matchScore(loose, props)).toBe(1);
    expect(matchScore(other, props)).toBe(0);
    expect(matchScore({ name: "none" }, props)).toBe(0);
    expect(bestMatch([loose, other, exact], props)?.name).toBe("hisense-huangshan");
    expect(bestMatch([other], props)).toBeNull();
  });
  test("profile.json name must equal its folder", () => {
    expect(() => validateProfileMeta({ name: "x" }, "y")).toThrow(ProfileError);
    expect(() => validateProfileMeta({ name: "y", match: { colour: "red" } }, "y")).toThrow(/match.colour/);
  });
  test("reads props from the TV", async () => {
    expect(await readDeviceProps(new FakeTv())).toMatchObject({ manufacturer: "Hisense", device: "huangshan", sdk: 29 });
  });
});

const pkgs = () => ({
  device: "TV",
  packages: [
    { pkg: "com.demo", decision: "keep" as const, system: true },
    { pkg: "tv.pluto.android", decision: "keep" as const, reason: "we watch it" },
    { pkg: "com.netflix.ninja", decision: "keep" as const },
  ],
});

describe("suggest", () => {
  const catalog = [
    { pkg: "tv.pluto.android", label: "Pluto TV", risk: "optional" as const, note: "n" },
    { pkg: "com.demo", label: "Demo", risk: "safe" as const, note: "n" },
    { pkg: "not.installed", label: "X", risk: "safe" as const, note: "n" },
  ];
  test("only packages on this TV, safest first, with the risk's batch", () => {
    const s = suggest(pkgs(), catalog);
    expect(s.map((x) => [x.entry.pkg, x.batch])).toEqual([["com.demo", 1], ["tv.pluto.android", 2]]);
  });
});

describe("markPackages", () => {
  test("disable with batch and reason, then back to keep drops the stale reason", () => {
    let p = markPackages(pkgs(), ["com.demo"], { batch: 1 }, "Retail demo");
    expect(p.packages[0]).toEqual({ pkg: "com.demo", decision: "disable", system: true, batch: 1, reason: "Retail demo" });
    p = markPackages(p, ["com.demo"], "keep");
    expect(p.packages[0]).toEqual({ pkg: "com.demo", decision: "keep", system: true });
  });
  test("keeps the reason when the decision doesn't change", () => {
    const p = markPackages(pkgs(), ["tv.pluto.android"], "keep");
    expect(p.packages[1]!.reason).toBe("we watch it");
  });
  test("unknown package, lifeline package and bad batch are errors", () => {
    expect(() => markPackages(pkgs(), ["com.typo"], { batch: 1 })).toThrow(/Not in this profile/);
    const withUi = { device: "TV", packages: [{ pkg: "com.android.systemui", decision: "keep" as const }] };
    expect(() => markPackages(withUi, ["com.android.systemui"], { batch: 1 })).toThrow(/lifeline/);
    expect(() => markPackages(pkgs(), ["com.demo"], { batch: 0 })).toThrow(/batch/);
  });
});
