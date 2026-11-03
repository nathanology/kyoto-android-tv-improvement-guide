import { describe, expect, test } from "bun:test";
import { parseAppsList } from "../cli/launcher";
import { NeedsHuman, parseArgs, requireHuman } from "../cli/main";

describe("parseArgs", () => {
  test("value flags take the next word; --allow repeats; the rest are booleans", () => {
    const r = parseArgs(["mark", "a.b", "c.d", "--batch", "2", "--reason", "not used", "--allow", "x.y", "--allow", "z.w", "--apply", "--profile", "p"]);
    expect(r.pos).toEqual(["mark", "a.b", "c.d"]);
    expect(r.flags).toEqual({ batch: "2", reason: "not used", apply: true, profile: "p" });
    expect(r.allow).toEqual(["x.y", "z.w"]);
  });
});

describe("requireHuman", () => {
  test("passes on a terminal, refuses without one and prints the command to hand over", () => {
    expect(() => requireHuman(true, ["debloat", "--batch", "1", "--apply"])).not.toThrow();
    expect(() => requireHuman(undefined, ["debloat", "--batch", "1", "--apply"])).toThrow(NeedsHuman);
    expect(() => requireHuman(false, ["debloat", "--batch", "1", "--apply"])).toThrow(/bun kyoto debloat --batch 1 --apply/);
  });
});

describe("parseAppsList", () => {
  test("parses rows with fallbacks and skips comments", () => {
    expect(parseAppsList("# hi\n\ncom.netflix.ninja|Netflix\ncom.wbd.stream, com.hbo.hbonow|Max\n")).toEqual([
      { pkgs: ["com.netflix.ninja"], label: "Netflix" },
      { pkgs: ["com.wbd.stream", "com.hbo.hbonow"], label: "Max" },
    ]);
  });
  test("reports every bad line", () => {
    expect(() => parseAppsList("Netflix\ncom.ok.app|\nnot a pkg|X")).toThrow(/line 1[\s\S]*line 2[\s\S]*line 3/);
    expect(() => parseAppsList("# only comments")).toThrow(/empty/);
  });
  test("the shipped example is valid", async () => {
    const text = await Bun.file(new URL("../launcher/apps.example.txt", import.meta.url).pathname).text();
    expect(parseAppsList(text).length).toBeLessThanOrEqual(10);
  });
});
