// Batch runner shared by `debloat` and `tune`.
//
//  plan ──(no --apply)──▶ print plan, exit 0
//   │ --apply
//   ▼
//  guard ──lifeline──▶ refuse, exit 2 (no override)
//   │    ──protected w/o --allow──▶ refuse, exit 2
//   ▼
//  snapshot(batch)            ← taken BEFORE any mutation; covers a crash mid-batch
//   ▼
//  apply actions ──adb error──▶ restore(snapshot) → verify → "failed"
//   ▼
//  live app checks ──fail──▶ restore → verify → "reverted"
//   ▼
//  "Remote still works? [y/N]" (90s) ──n / timeout──▶ restore → verify → "reverted" + re-apply hint
//   │ y
//   ▼
//  [--reboot-check: reboot → checks ──fail──▶ restore]
//   ▼
//  committed (changes.log)
//
// No reboot happens inside a batch unless --reboot-check is passed: `pm disable-user`
// takes effect immediately, and a reboot is the moment adb is most likely to drop.

import type { AdbLike } from "./adb";
import { sleep as realSleep } from "./adb";
import { assertAllowed, resolveHome } from "./guard";
import { launchActivity, parseTotalTime } from "./measure";
import { parseDropbox } from "./crashes";
import {
  type Change,
  type Namespace,
  type Scope,
  type Snapshot,
  applyChanges,
  describeChange,
  diffSnapshots,
  loadSnapshot,
  restoreSnapshot,
  saveSnapshot,
  shellQuote,
  takeSnapshot,
} from "./snapshot";

export type Action =
  | { kind: "disable"; pkg: string }
  | { kind: "setting"; ns: Namespace; key: string; value: string }
  | { kind: "restrict-bg"; pkg: string };

export type Prompt = (question: string, timeoutMs: number) => Promise<string | null>;

export interface BatchOptions {
  adb: AdbLike;
  label: string; // e.g. "debloat-1", "tune"
  actions: Action[];
  apply: boolean;
  allow?: string[];
  prompt: Prompt;
  checkApps: string[];
  stateDir: string;
  reapplyCommand: string;
  rebootCheck?: boolean;
  promptTimeoutMs?: number;
  /**
   * Package that will be HOME after this batch. Only `kyoto home set` passes this, after it has
   * verified the new launcher opens; the guard then protects the new home instead of the old one.
   */
  newHome?: string;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export type BatchStatus = "dry-run" | "committed" | "reverted" | "failed" | "nothing-to-do";

export interface BatchResult {
  status: BatchStatus;
  plan: string[];
  reason?: string;
  snapshotPath?: string;
  restoreFailures?: string[];
}

export interface LogEntry {
  at: string;
  label: string;
  event: "started" | "committed" | "reverted" | "failed" | "rollback";
  snapshot?: string;
  scope?: Scope;
  reason?: string;
}

export function describeAction(a: Action): string {
  switch (a.kind) {
    case "disable":
      return `disable ${a.pkg}`;
    case "setting":
      return `set ${a.ns}/${a.key} = ${a.value}`;
    case "restrict-bg":
      return `stop ${a.pkg} running in the background`;
  }
}

export function scopeOf(actions: Action[]): Scope {
  return {
    settingsKeys: actions.flatMap((a) => (a.kind === "setting" ? [{ ns: a.ns, key: a.key }] : [])),
    appPkgs: actions.flatMap((a) => (a.kind === "restrict-bg" ? [a.pkg] : [])),
  };
}

export function mergeScopes(scopes: Scope[]): Scope {
  const keys = new Map<string, { ns: Namespace; key: string }>();
  const pkgs = new Set<string>();
  for (const s of scopes) {
    for (const k of s.settingsKeys) keys.set(`${k.ns}/${k.key}`, k);
    for (const p of s.appPkgs) pkgs.add(p);
  }
  return { settingsKeys: [...keys.values()], appPkgs: [...pkgs] };
}

/** Commands for an action. API < 30 has no "restricted" standby bucket, so only appops is used there. */
export function actionCommands(a: Action, apiLevel: number): string[] {
  switch (a.kind) {
    case "disable":
      return [`pm disable-user --user 0 ${a.pkg}`];
    case "setting":
      return [`settings put ${a.ns} ${a.key} ${shellQuote(a.value)}`];
    case "restrict-bg":
      return [`cmd appops set ${a.pkg} RUN_IN_BACKGROUND ignore`, ...(apiLevel >= 30 ? [`am set-standby-bucket ${a.pkg} restricted`] : [])];
  }
}

export async function appendLog(stateDir: string, e: LogEntry): Promise<void> {
  const path = `${stateDir}/changes.log`;
  const f = Bun.file(path);
  const prev = (await f.exists()) ? await f.text() : "";
  await Bun.write(path, prev + JSON.stringify(e) + "\n");
}

export async function readLog(stateDir: string): Promise<LogEntry[]> {
  const f = Bun.file(`${stateDir}/changes.log`);
  if (!(await f.exists())) return [];
  return (await f.text())
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as LogEntry];
      } catch {
        return [];
      }
    });
}

export type BatchState = "started" | "committed" | "reverted" | "failed" | "rolled-back";

/**
 * Where each batch label stands, replaying the log in order. A rollback of label X ("rollback-X")
 * returns the TV to before X, so X and every batch started after it count as rolled back;
 * "rollback-all" rolls back everything.
 */
export function batchStates(entries: LogEntry[]): Map<string, BatchState> {
  const state = new Map<string, BatchState>();
  const order: string[] = []; // labels by most recent start
  for (const e of entries) {
    if (e.event === "rollback") {
      const target = e.label.replace(/^rollback-/, "");
      const from = target === "all" ? 0 : order.indexOf(target);
      if (from >= 0) for (const l of order.slice(from)) state.set(l, "rolled-back");
      continue;
    }
    if (e.event === "started") {
      const i = order.indexOf(e.label);
      if (i >= 0) order.splice(i, 1);
      order.push(e.label);
    }
    state.set(e.label, e.event);
  }
  return state;
}

/**
 * The entry to roll back to for `label`: its first start since the last rollback, or null if it hasn't
 * run since then (already undone). Re-running a batch (e.g. after a firmware update) adds a newer
 * snapshot that already contains the batch's changes, so the newest one would undo nothing.
 */
export function rollbackTarget(entries: LogEntry[], label: string): { entry: LogEntry; index: number } | null {
  let lastRollback = -1;
  entries.forEach((e, i) => {
    if (e.event === "rollback") lastRollback = i;
  });
  const index = entries.findIndex((e, i) => i > lastRollback && e.label === label && e.event === "started");
  return index < 0 ? null : { entry: entries[index]!, index };
}

export interface CheckResult {
  ok: boolean;
  failures: string[];
  skipped: string[];
}

async function crashCount(adb: AdbLike): Promise<number> {
  return parseDropbox(await adb.shell("dumpsys dropbox --print data_app_crash"), "data_app_crash").length;
}

/** Launch each installed app and confirm it comes to the foreground without a new crash. */
export async function runChecks(adb: AdbLike, apps: string[], sleep: (ms: number) => Promise<void>): Promise<CheckResult> {
  const res: CheckResult = { ok: true, failures: [], skipped: [] };
  await adb.shell("input keyevent KEYCODE_WAKEUP"); // apps can't come to the foreground while the TV is in standby
  const crashesBefore = await crashCount(adb);
  for (const pkg of apps) {
    const act = await launchActivity(adb, pkg);
    if (!act) {
      res.skipped.push(pkg);
      continue;
    }
    await adb.shell(`am force-stop ${pkg}`);
    const t = parseTotalTime(await adb.shell(`am start -W -n ${act}`));
    await sleep(5_000);
    const resumed = await adb.shell("dumpsys activity activities | grep -E \"ResumedActivity\" || true");
    if (t === null) res.failures.push(`${pkg} didn't start`);
    else if (!resumed.includes(pkg)) res.failures.push(`${pkg} started but isn't in the foreground`);
    await adb.shell("input keyevent KEYCODE_HOME");
    await sleep(2_000);
  }
  if ((await crashCount(adb)) > crashesBefore) res.failures.push("an app crashed during the checks");
  res.ok = res.failures.length === 0;
  return res;
}

async function revert(
  adb: AdbLike,
  snap: Snapshot,
  scope: Scope,
  apps: string[],
  sleep: (ms: number) => Promise<void>,
  log: (m: string) => void,
): Promise<string[]> {
  log("Reverting this batch…");
  const r = await restoreSnapshot(adb, snap, scope);
  const failures = r.failed.map((f) => `${describeChange(f.change)}: ${f.error}`);
  const live = await takeSnapshot(adb, "verify", scope.appPkgs);
  const left = diffSnapshots(snap, live, scope);
  if (left.length) failures.push(...left.map((c: Change) => `still different: ${describeChange(c)}`));
  const checks = await runChecks(adb, apps, sleep);
  if (!checks.ok) failures.push(...checks.failures.map((f) => `after revert: ${f}`));
  log(failures.length ? `⚠ Revert finished with problems:\n  ${failures.join("\n  ")}` : "✓ Reverted and verified.");
  return failures;
}

export async function runBatch(o: BatchOptions): Promise<BatchResult> {
  const sleep = o.sleep ?? realSleep;
  const log = o.log ?? (() => {});
  const plan = o.actions.map(describeAction);
  if (!o.actions.length) return { status: "nothing-to-do", plan };

  const home = o.newHome ?? (await resolveHome(o.adb));
  const pkgs = o.actions.flatMap((a) => (a.kind === "setting" ? [] : [a.pkg]));
  assertAllowed(pkgs, { allow: o.allow, home }); // throws GuardError before anything else happens

  if (!o.apply) return { status: "dry-run", plan };

  const scope = scopeOf(o.actions);
  const snap = await takeSnapshot(o.adb, o.label, scope.appPkgs);

  // Settings that don't exist on this TV are skipped rather than created.
  const actions = o.actions.filter((a) => {
    if (a.kind === "setting" && !(a.key in snap.settings[a.ns])) {
      log(`skip ${a.ns}/${a.key}: this TV doesn't have that setting`);
      return false;
    }
    return true;
  });

  const originPath = `${o.stateDir}/snapshots/origin.json`;
  if (!(await Bun.file(originPath).exists())) await saveSnapshot(originPath, { ...snap, label: "origin" });
  const snapshotPath = `${o.stateDir}/snapshots/${o.label}-${snap.takenAt.replace(/[:.]/g, "-")}.json`;
  await saveSnapshot(snapshotPath, snap);
  await appendLog(o.stateDir, { at: new Date().toISOString(), label: o.label, event: "started", snapshot: snapshotPath, scope });

  const finish = async (status: BatchStatus, reason?: string, restoreFailures?: string[]): Promise<BatchResult> => {
    await appendLog(o.stateDir, { at: new Date().toISOString(), label: o.label, event: status === "committed" ? "committed" : status === "failed" ? "failed" : "reverted", snapshot: snapshotPath, scope, reason });
    return { status, plan, reason, snapshotPath, restoreFailures };
  };

  try {
    for (const a of actions) {
      for (const cmd of actionCommands(a, snap.apiLevel)) {
        const out = await o.adb.shell(cmd);
        if (a.kind === "disable" && !/new state:\s*disabled/.test(out)) throw new Error(`${a.pkg} didn't report disabled: ${out.trim()}`);
      }
      log(`✓ ${describeAction(a)}`);
    }
  } catch (e) {
    log(`✗ ${(e as Error).message}`);
    return finish("failed", (e as Error).message, await revert(o.adb, snap, scope, o.checkApps, sleep, log));
  }

  log("Checking your apps still open…");
  const checks = await runChecks(o.adb, o.checkApps, sleep);
  if (checks.skipped.length) log(`(not installed, skipped: ${checks.skipped.join(", ")})`);
  if (!checks.ok) {
    log(`✗ App checks failed: ${checks.failures.join("; ")}`);
    return finish("reverted", `app checks failed: ${checks.failures.join("; ")}`, await revert(o.adb, snap, scope, o.checkApps, sleep, log));
  }

  const timeout = o.promptTimeoutMs ?? 90_000;
  const answer = await o.prompt(`Does the TV remote still work (Home, arrows, OK, volume)? [y/N] (auto-revert in ${timeout / 1000}s) `, timeout);
  if (answer?.trim().toLowerCase() !== "y") {
    const why = answer === null ? "no answer before timeout" : "remote check answered no";
    log(`${why}. To try again later: ${o.reapplyCommand}`);
    return finish("reverted", why, await revert(o.adb, snap, scope, o.checkApps, sleep, log));
  }

  if (o.rebootCheck) {
    log("Rebooting to make sure everything survives a restart…");
    await o.adb.reboot();
    await o.adb.waitForBoot();
    const after = await runChecks(o.adb, o.checkApps, sleep);
    if (!after.ok) {
      log(`✗ After reboot: ${after.failures.join("; ")}`);
      return finish("reverted", `post-reboot checks failed: ${after.failures.join("; ")}`, await revert(o.adb, snap, scope, o.checkApps, sleep, log));
    }
  }

  log(`✓ ${o.label} committed.`);
  return finish("committed");
}

/** Restore to a saved snapshot, printing the diff and asking before applying. */
export async function rollback(o: {
  adb: AdbLike;
  snapshotPath: string;
  scope: Scope;
  apply: boolean;
  prompt: Prompt;
  stateDir: string;
  label: string;
  log?: (m: string) => void;
}): Promise<{ changes: Change[]; status: "dry-run" | "nothing-to-do" | "cancelled" | "restored"; failures: string[] }> {
  const log = o.log ?? (() => {});
  const target = await loadSnapshot(o.snapshotPath);
  const live = await takeSnapshot(o.adb, "live", o.scope.appPkgs);
  const changes = diffSnapshots(target, live, o.scope);
  if (!changes.length) {
    // Still record it, so `doctor` stops reporting the batch as interrupted or committed.
    if (o.apply) await appendLog(o.stateDir, { at: new Date().toISOString(), label: o.label, event: "rollback", snapshot: o.snapshotPath, scope: o.scope });
    return { changes, status: "nothing-to-do", failures: [] };
  }
  if (target.fingerprint !== live.fingerprint) log("⚠ The TV's firmware changed since this snapshot (OTA). Review the list carefully.");
  if (!o.apply) return { changes, status: "dry-run", failures: [] };
  const ans = await o.prompt(`Apply these ${changes.length} changes? [y/N] `, 120_000);
  if (ans?.trim().toLowerCase() !== "y") return { changes, status: "cancelled", failures: [] };
  const r = await applyChanges(o.adb, changes);
  const failures = r.failed.map((f) => `${describeChange(f.change)}: ${f.error}`);
  await appendLog(o.stateDir, { at: new Date().toISOString(), label: o.label, event: "rollback", snapshot: o.snapshotPath, scope: o.scope });
  return { changes, status: "restored", failures };
}
