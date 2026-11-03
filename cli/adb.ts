// adb transport. Every TV interaction goes through AdbLike so tests can swap in FakeAdb.
//
//   command ──▶ Adb.shell(cmd) ──▶ runner(["-s", serial, "shell", cmd])
//                   │                     │
//                   │          classify(stdout, stderr, code)
//                   │            ├─ offline / no route ──▶ reconnect once ──▶ retry
//                   │            ├─ unauthorized ────────▶ Unauthorized
//                   │            ├─ more than one device ▶ MultipleDevices
//                   │            └─ exit 0 but "Failure"/"Error:"/"Exception" ▶ CommandFailed
//                   ▼
//                stdout (\r stripped)

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type Runner = (args: string[]) => Promise<ExecResult>;

export interface AdbLike {
  /** Run a shell command on the TV and return stdout. Throws AdbError subclasses. */
  shell(cmd: string): Promise<string>;
  reboot(): Promise<void>;
  /** Poll sys.boot_completed until 1 or timeout. */
  waitForBoot(timeoutMs?: number): Promise<void>;
}

export class AdbError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class DeviceOffline extends AdbError {}
export class Unauthorized extends AdbError {}
export class MultipleDevices extends AdbError {}
export class CommandFailed extends AdbError {
  constructor(readonly cmd: string, readonly output: string) {
    super(`TV rejected command: ${cmd}\n  ${output.trim().split("\n")[0]}`);
  }
}
export class BootTimeout extends AdbError {}

// pm / settings / cmd frequently exit 0 while printing a failure.
const SOFT_FAILURE = /^(Failure\b|Error:|Exception occurred|java\.lang\.\w+Exception|Unknown package|Security exception)/m;

export function classify(cmd: string, r: ExecResult): AdbError | null {
  const all = `${r.stdout}\n${r.stderr}`;
  if (/unauthorized/i.test(all)) {
    return new Unauthorized(
      "The TV hasn't authorized this Mac.",
      'On the TV, accept "Allow USB debugging?" and tick "Always allow from this computer".',
    );
  }
  if (/more than one device/i.test(all)) {
    return new MultipleDevices("More than one device is connected.", "Run `kyoto connect <host:port>` to pin one.");
  }
  if (/device offline|device '.*' not found|no devices\/emulators found|No route to host|Connection refused|failed to connect|closed/i.test(all) && r.code !== 0) {
    return new DeviceOffline(
      "Can't reach the TV.",
      "Check the TV is on (not standby), on the same Wi-Fi, and USB debugging is still enabled.",
    );
  }
  if (r.code !== 0) return new CommandFailed(cmd, all);
  if (SOFT_FAILURE.test(r.stdout) || SOFT_FAILURE.test(r.stderr)) return new CommandFailed(cmd, all);
  return null;
}

export const bunRunner: Runner = async (args) => {
  const p = Bun.spawn(["adb", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { stdout, stderr, code };
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Adb implements AdbLike {
  constructor(
    readonly serial: string,
    private readonly run: Runner = bunRunner,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  async shell(cmd: string): Promise<string> {
    return this.withReconnect(cmd, ["-s", this.serial, "shell", cmd]);
  }

  async reboot(): Promise<void> {
    // The connection drops mid-command during a reboot; that's expected.
    await this.run(["-s", this.serial, "reboot"]);
  }

  async waitForBoot(timeoutMs = 180_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await this.wait(5_000);
    while (Date.now() < deadline) {
      await this.run(["connect", this.serial]);
      const r = await this.run(["-s", this.serial, "shell", "getprop sys.boot_completed"]);
      if (r.code === 0 && r.stdout.trim() === "1") return;
      await this.wait(5_000);
    }
    throw new BootTimeout(`TV didn't finish booting within ${timeoutMs / 1000}s.`, "Run `kyoto doctor` once it's back.");
  }

  /** `adb connect` to the pinned serial. Returns true when the device answers. */
  async connect(): Promise<boolean> {
    const r = await this.run(["connect", this.serial]);
    return /connected to|already connected/.test(r.stdout);
  }

  private async withReconnect(cmd: string, args: string[]): Promise<string> {
    let r = await this.run(args);
    let err = classify(cmd, r);
    if (err instanceof DeviceOffline) {
      await this.connect();
      r = await this.run(args);
      err = classify(cmd, r);
    }
    if (err) throw err;
    return r.stdout.replace(/\r/g, "");
  }
}
