// Crash + low-memory-kill log. Polled opportunistically whenever kyoto connects
// (dropbox keeps only a few days, and the Mac/TV are often asleep, so no cron).
// Entries are deduped by tag+time+process; unreachable polls are recorded as gaps.

import type { AdbLike } from "./adb";

export interface CrashEvent {
  type: "event";
  tag: string; // data_app_crash | data_app_anr | data_app_native_crash | lmk_kill
  at: string; // TV-local timestamp as printed
  process: string;
}
export interface PollMarker {
  type: "poll" | "gap";
  at: string; // ISO time on the Mac
  reason?: string;
}
export type CrashLogLine = CrashEvent | PollMarker;

const DROPBOX_TAGS = ["data_app_crash", "data_app_anr", "data_app_native_crash"];

export function parseDropbox(out: string, tag: string): CrashEvent[] {
  const events: CrashEvent[] = [];
  const blocks = out.split(/^=+$/m);
  for (const b of blocks) {
    const head = b.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\S+)/m);
    if (!head || head[2] !== tag) continue;
    const proc = b.match(/^Process:\s*(\S+)/m)?.[1] ?? "unknown";
    events.push({ type: "event", tag, at: head[1]!, process: proc });
  }
  return events;
}

export function parseLmk(logcat: string, year = new Date().getFullYear()): CrashEvent[] {
  const events: CrashEvent[] = [];
  for (const line of logcat.split("\n")) {
    const m = line.match(/^(\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.\d+.*lowmemorykiller.*Kill '([^']+)'/);
    if (m) events.push({ type: "event", tag: "lmk_kill", at: `${year}-${m[1]}`, process: m[2]! });
  }
  return events;
}

const key = (e: CrashEvent) => `${e.tag}|${e.at}|${e.process}`;

export function dedupe(existing: CrashLogLine[], incoming: CrashEvent[]): CrashEvent[] {
  const seen = new Set(existing.filter((l): l is CrashEvent => l.type === "event").map(key));
  const fresh: CrashEvent[] = [];
  for (const e of incoming) {
    if (seen.has(key(e))) continue;
    seen.add(key(e));
    fresh.push(e);
  }
  return fresh;
}

export async function readLog(path: string): Promise<CrashLogLine[]> {
  const f = Bun.file(path);
  if (!(await f.exists())) return [];
  return (await f.text())
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as CrashLogLine];
      } catch {
        return []; // a torn last line from an interrupted write is skipped
      }
    });
}

async function append(path: string, lines: CrashLogLine[]): Promise<void> {
  const f = Bun.file(path);
  const prev = (await f.exists()) ? await f.text() : "";
  await Bun.write(path, prev + lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
}

export async function pollCrashes(adb: AdbLike | null, path: string, now = () => new Date()): Promise<{ added: number; gap: boolean }> {
  if (!adb) {
    await append(path, [{ type: "gap", at: now().toISOString(), reason: "TV unreachable" }]);
    return { added: 0, gap: true };
  }
  const incoming: CrashEvent[] = [];
  for (const tag of DROPBOX_TAGS) incoming.push(...parseDropbox(await adb.shell(`dumpsys dropbox --print ${tag}`), tag));
  incoming.push(...parseLmk(await adb.shell("logcat -d -b main,system"), now().getFullYear()));
  const fresh = dedupe(await readLog(path), incoming);
  await append(path, [...fresh, { type: "poll", at: now().toISOString() }]);
  return { added: fresh.length, gap: false };
}

/** Events per day of covered time (poll-to-poll spans with no gap in between). */
export function summarize(lines: CrashLogLine[]): { byTag: Record<string, number>; byProcess: Record<string, number>; polls: number; gaps: number } {
  const byTag: Record<string, number> = {};
  const byProcess: Record<string, number> = {};
  let polls = 0;
  let gaps = 0;
  for (const l of lines) {
    if (l.type === "event") {
      byTag[l.tag] = (byTag[l.tag] ?? 0) + 1;
      byProcess[l.process] = (byProcess[l.process] ?? 0) + 1;
    } else if (l.type === "poll") polls++;
    else gaps++;
  }
  return { byTag, byProcess, polls, gaps };
}
