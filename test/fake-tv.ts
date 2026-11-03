// FakeTv: an in-memory Android TV that answers the shell commands kyoto sends,
// using real output captured from the Hisense (test/fixtures/) wherever the format matters.
//
//   state: installed pkgs, disabled set, settings[ns], appops, buckets, launchable apps
//   shell(cmd) ──regex dispatch──▶ mutate state / return fixture-shaped output
//   failNext / offline / crashOnLaunch hooks simulate the failure modes we care about.

import { CommandFailed, DeviceOffline, type AdbLike } from "../cli/adb";
import type { Namespace } from "../cli/snapshot";

const FIX = new URL("./fixtures/", import.meta.url).pathname;
export const fixture = (name: string) => require("node:fs").readFileSync(`${FIX}${name}.txt`, "utf8") as string;

export class FakeTv implements AdbLike {
  installed = new Set<string>();
  disabled = new Set<string>();
  settings: Record<Namespace, Map<string, string>> = { global: new Map(), secure: new Map(), system: new Map() };
  appops = new Map<string, string>();
  buckets = new Map<string, string>();
  launchable = new Map<string, string>(); // pkg → activity
  apiLevel = 29;
  home = "com.google.android.tvlauncher";
  fingerprint = "Hisense/huangshan/huangshan:10/QTG3.200902.001/00.00.00.101:user/release-keys";
  crashes: { at: string; process: string }[] = [];
  log: string[] = [];
  /** Commands matching this regex throw CommandFailed once. */
  failOnce: RegExp | null = null;
  /** Commands matching this regex throw DeviceOffline (simulating Wi-Fi drop). */
  offlineOn: RegExp | null = null;
  /** When true, the first offlineOn match takes the connection down for every later command too. */
  offlineSticky = false;
  private dead = false;
  /** Launching this package produces a crash entry and no foreground activity. */
  crashOnLaunch: string | null = null;
  /** If any of these packages are disabled, every app launch fails (a broken dependency). */
  launchDependsOn: string[] = [];
  resumed = "com.google.android.tvlauncher/.MainActivity";
  /** The next N launches of a package return no TotalTime (Netflix's first-run-after-boot behavior). */
  slowFirstLaunches = new Map<string, number>();
  reboots = 0;

  constructor(init: Partial<{ installed: string[]; apps: Record<string, string>; settings: Partial<Record<Namespace, Record<string, string>>> }> = {}) {
    for (const p of init.installed ?? []) this.installed.add(p);
    for (const [p, act] of Object.entries(init.apps ?? {})) {
      this.installed.add(p);
      this.launchable.set(p, act);
    }
    for (const [ns, kv] of Object.entries(init.settings ?? {})) for (const [k, v] of Object.entries(kv)) this.settings[ns as Namespace].set(k, v);
    this.installed.add(this.home);
  }

  /** Bring a sticky-offline TV back. */
  reconnect() {
    this.dead = false;
    this.offlineOn = null;
  }

  mutations(): string[] {
    return this.log.filter((c) => /^(pm (enable|disable)|settings (put|delete)|cmd appops set|am set-standby-bucket)/.test(c));
  }

  async reboot() {
    this.reboots++;
  }
  async waitForBoot() {}

  async shell(cmd: string): Promise<string> {
    this.log.push(cmd);
    if (this.dead || this.offlineOn?.test(cmd)) {
      if (this.offlineSticky) this.dead = true;
      throw new DeviceOffline("Can't reach the TV.");
    }
    if (this.failOnce?.test(cmd)) {
      this.failOnce = null;
      throw new CommandFailed(cmd, fixture("pm_enable_unknown"));
    }
    let m: RegExpMatchArray | null;
    if (cmd === "getprop ro.build.fingerprint") return this.fingerprint + "\n";
    if (cmd === "getprop ro.build.version.sdk") return `${this.apiLevel}\n`;
    if (cmd === "getprop ro.product.model") return "SmartTV 4K FFM\n";
    if (cmd === "getprop ro.build.version.release") return "10\n";
    if (cmd === "pm list packages -d") return [...this.disabled].map((p) => `package:${p}`).join("\n") + "\n";
    if (cmd === "pm list packages -s") return [...this.installed].map((p) => `package:${p}`).join("\n") + "\n";
    if (cmd === "pm list packages -3") return "";
    if ((m = cmd.match(/^settings list (\w+)$/))) return [...this.settings[m[1] as Namespace]].map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    if ((m = cmd.match(/^settings put (\w+) (\S+) (.+)$/))) {
      this.settings[m[1] as Namespace].set(m[2]!, m[3]!.replace(/^'(.*)'$/, "$1"));
      return "";
    }
    if ((m = cmd.match(/^settings delete (\w+) (\S+)$/))) {
      this.settings[m[1] as Namespace].delete(m[2]!);
      return "Deleted 1 rows\n";
    }
    if ((m = cmd.match(/^pm disable-user --user 0 (\S+)$/))) return this.setEnabled(cmd, m[1]!, false);
    if ((m = cmd.match(/^pm enable (\S+)$/))) return this.setEnabled(cmd, m[1]!, true);
    if ((m = cmd.match(/^cmd appops get (\S+) RUN_IN_BACKGROUND$/))) {
      const v = this.appops.get(m[1]!);
      return v ? `RUN_IN_BACKGROUND: ${v}\n` : fixture("appops_netflix");
    }
    if ((m = cmd.match(/^cmd appops set (\S+) RUN_IN_BACKGROUND (\w+)$/))) {
      if (m[2] === "default") this.appops.delete(m[1]!);
      else this.appops.set(m[1]!, m[2]!);
      return "";
    }
    if ((m = cmd.match(/^am get-standby-bucket (\S+)$/))) return `${this.buckets.get(m[1]!) ?? "10"}\n`;
    if ((m = cmd.match(/^am set-standby-bucket (\S+) (\w+)$/))) {
      if (m[2] === "restricted" && this.apiLevel < 30) throw new CommandFailed(cmd, "Error: unknown bucket: restricted");
      const num = { active: "10", working_set: "20", frequent: "30", rare: "40", restricted: "45" }[m[2]!] ?? m[2]!;
      this.buckets.set(m[1]!, num);
      return "";
    }
    if (cmd.startsWith("cmd package resolve-activity") && cmd.includes("category.HOME")) {
      return `priority=2 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\n${this.home}/.MainActivity\n`;
    }
    if ((m = cmd.match(/^cmd package resolve-activity .*LEANBACK_LAUNCHER .* (\S+)$/))) {
      const act = this.launchable.get(m[1]!);
      if (!act || this.disabled.has(m[1]!)) return "No activity found\n";
      return `priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n${act}\n`;
    }
    if ((m = cmd.match(/^am force-stop (\S+)$/))) return "";
    if ((m = cmd.match(/^am start -W -n (\S+)$/))) {
      const act = m[1]!;
      const pkg = act.split("/")[0]!;
      const pending = this.slowFirstLaunches.get(pkg) ?? 0;
      if (pending > 0) {
        this.slowFirstLaunches.set(pkg, pending - 1);
        return `Starting: Intent { cmp=${act} }\nStatus: timeout\nLaunchState: UNKNOWN (-1)\nActivity: ${act}\nWaitTime: 10012\nComplete\n`;
      }
      const broken = this.launchDependsOn.some((d) => this.disabled.has(d));
      if (pkg === this.crashOnLaunch || broken) {
        this.crashes.push({ at: `2026-11-01 0${this.crashes.length}:00:00`, process: pkg });
        return `Starting: Intent { cmp=${act} }\nStatus: ok\nLaunchState: COLD\nActivity: ${act}\nTotalTime: 300\nWaitTime: 305\nComplete\n`;
      }
      this.resumed = act;
      return `Starting: Intent { cmp=${act} }\nStatus: ok\nLaunchState: COLD\nActivity: ${act}\nTotalTime: 412\nWaitTime: 415\nComplete\n`;
    }
    if (cmd.startsWith("dumpsys activity activities")) {
      return `  ResumedActivity: ActivityRecord{f65db82 u0 ${this.resumed} t12449}\n`;
    }
    if (cmd === "input keyevent KEYCODE_HOME") {
      this.resumed = `${this.home}/.MainActivity`;
      return "";
    }
    if (cmd.startsWith("input keyevent")) return "";
    if (cmd.startsWith("dumpsys dropbox --print data_app_crash")) {
      if (!this.crashes.length) return fixture("dropbox_crash");
      return this.crashes
        .map((c) => `========================================\n${c.at} data_app_crash (text, 812 bytes)\nProcess: ${c.process}\nPID: 1234\n`)
        .join("");
    }
    if (cmd.startsWith("dumpsys dropbox --print")) return "(No entries found.)\n";
    if (cmd.startsWith("logcat")) return cmd.includes("-d") ? fixture("logcat_lmk") : "";
    if (cmd === "cat /proc/meminfo") return fixture("meminfo");
    if (cmd === "cat /proc/uptime") return "517821.04 1815408.91\n";
    if (cmd.startsWith("ps -A")) return "0\n";
    if (cmd === "dumpsys media.drm") return "";
    if (cmd === "true") return "";
    throw new Error(`FakeTv: unhandled command: ${cmd}`);
  }

  private setEnabled(cmd: string, pkg: string, enabled: boolean): string {
    if (!this.installed.has(pkg)) throw new CommandFailed(cmd, fixture("pm_enable_unknown"));
    if (enabled) this.disabled.delete(pkg);
    else this.disabled.add(pkg);
    return `Package ${pkg} new state: ${enabled ? "enabled" : "disabled-user"}\n`;
  }
}
