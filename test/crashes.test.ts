import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupe, parseDropbox, parseLmk, pollCrashes, readLog, summarize } from "../cli/crashes";
import { FakeTv, fixture } from "./fake-tv";

const tmp = mkdtempSync(join(tmpdir(), "kyoto-crash-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const DROPBOX = `Drop box contents: 3 entries
========================================
2026-10-31 20:01:02 data_app_crash (text, 812 bytes)
Process: com.hulu.livingroomplus
PID: 25165
========================================
2026-10-31 20:05:00 data_app_crash (text, 400 bytes)
Process: com.netflix.ninja
PID: 1
`;

describe("parsers", () => {
  test("dropbox entries", () => {
    expect(parseDropbox(DROPBOX, "data_app_crash")).toEqual([
      { type: "event", tag: "data_app_crash", at: "2026-10-31 20:01:02", process: "com.hulu.livingroomplus" },
      { type: "event", tag: "data_app_crash", at: "2026-10-31 20:05:00", process: "com.netflix.ninja" },
    ]);
    expect(parseDropbox(fixture("dropbox_crash"), "data_app_crash")).toEqual([]); // real "(No entries found.)"
  });
  test("low-memory kills from real logcat", () => {
    const ev = parseLmk(fixture("logcat_lmk"), 2026);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev[0]!.at).toMatch(/^2026-\d{2}-\d{2} /);
  });
});

describe("dedupe + polling", () => {
  test("dedupes across polls", () => {
    const a = parseDropbox(DROPBOX, "data_app_crash");
    expect(dedupe(a, a)).toEqual([]);
    expect(dedupe([a[0]!], a)).toEqual([a[1]!]);
  });

  test("poll twice: second adds nothing new", async () => {
    const path = join(tmp, "c1.jsonl");
    const t = new FakeTv();
    const first = await pollCrashes(t, path);
    const second = await pollCrashes(t, path);
    expect(first.added).toBeGreaterThan(0);
    expect(second.added).toBe(0);
    expect(summarize(await readLog(path)).polls).toBe(2);
  });

  test("empty dropbox and logcat → zero events, still a poll", async () => {
    const path = join(tmp, "c2.jsonl");
    const t = new FakeTv();
    t.shell = async (cmd: string) => (cmd.startsWith("dumpsys dropbox") ? "(No entries found.)\n" : "");
    expect((await pollCrashes(t, path)).added).toBe(0);
    expect(summarize(await readLog(path))).toMatchObject({ polls: 1, gaps: 0, byTag: {} });
  });

  test("unreachable TV records a gap", async () => {
    const path = join(tmp, "c3.jsonl");
    expect(await pollCrashes(null, path)).toEqual({ added: 0, gap: true });
    expect(summarize(await readLog(path)).gaps).toBe(1);
  });

  test("a torn last line is skipped", async () => {
    const path = join(tmp, "c4.jsonl");
    await Bun.write(path, '{"type":"poll","at":"x"}\n{"type":"ev');
    expect((await readLog(path)).length).toBe(1);
  });
});
