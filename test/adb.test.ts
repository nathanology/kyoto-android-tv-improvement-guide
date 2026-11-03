import { describe, expect, test } from "bun:test";
import { Adb, BootTimeout, CommandFailed, DeviceOffline, MultipleDevices, Unauthorized, classify, type ExecResult } from "../cli/adb";
import { fixture } from "./fake-tv";

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0 });
const noWait = async () => {};

/** Runner that replays a scripted list of results and records the args it saw. */
function scripted(results: ExecResult[]) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return results.shift() ?? ok("");
  };
  return { run, calls };
}

describe("classify", () => {
  test("clean output is not an error", () => {
    expect(classify("pm list packages -d", ok("package:a\n"))).toBeNull();
  });
  test("non-zero exit is CommandFailed", () => {
    expect(classify("x", { stdout: "", stderr: "boom", code: 1 })).toBeInstanceOf(CommandFailed);
  });
  test("exit 0 with the real pm exception text is CommandFailed", () => {
    expect(classify("pm enable x", ok(fixture("pm_enable_unknown")))).toBeInstanceOf(CommandFailed);
  });
  test("exit 0 with Failure [...] is CommandFailed", () => {
    expect(classify("pm x", ok("Failure [not installed for 0]\n"))).toBeInstanceOf(CommandFailed);
  });
  test("unauthorized", () => {
    const e = classify("x", { stdout: "", stderr: "error: device unauthorized.", code: 1 });
    expect(e).toBeInstanceOf(Unauthorized);
    expect(e?.hint).toContain("Allow USB debugging");
  });
  test("offline", () => {
    expect(classify("x", { stdout: "", stderr: "error: device offline", code: 1 })).toBeInstanceOf(DeviceOffline);
    expect(classify("x", { stdout: "", stderr: "failed to connect to '1.2.3.4:5555': No route to host", code: 1 })).toBeInstanceOf(DeviceOffline);
  });
  test("multiple devices", () => {
    expect(classify("x", { stdout: "", stderr: "error: more than one device/emulator", code: 1 })).toBeInstanceOf(MultipleDevices);
  });
});

describe("Adb", () => {
  test("pins the serial and strips \\r", async () => {
    const s = scripted([ok("SmartTV 4K FFM\r\n")]);
    const adb = new Adb("10.0.0.5:5555", s.run, noWait);
    expect(await adb.shell("getprop ro.product.model")).toBe("SmartTV 4K FFM\n");
    expect(s.calls[0]).toEqual(["-s", "10.0.0.5:5555", "shell", "getprop ro.product.model"]);
  });

  test("reconnects once when offline, then succeeds", async () => {
    const s = scripted([{ stdout: "", stderr: "error: device offline", code: 1 }, ok("connected to 10.0.0.5:5555"), ok("1\n")]);
    const adb = new Adb("10.0.0.5:5555", s.run, noWait);
    expect(await adb.shell("getprop sys.boot_completed")).toBe("1\n");
    expect(s.calls[1]).toEqual(["connect", "10.0.0.5:5555"]);
  });

  test("gives up after one reconnect", async () => {
    const off = { stdout: "", stderr: "error: device offline", code: 1 };
    const s = scripted([off, ok("failed"), off]);
    const adb = new Adb("10.0.0.5:5555", s.run, noWait);
    await expect(adb.shell("true")).rejects.toBeInstanceOf(DeviceOffline);
    expect(s.calls.length).toBe(3);
  });

  test("does not reconnect on unauthorized", async () => {
    const s = scripted([{ stdout: "", stderr: "error: device unauthorized.", code: 1 }]);
    await expect(new Adb("x:5555", s.run, noWait).shell("true")).rejects.toBeInstanceOf(Unauthorized);
    expect(s.calls.length).toBe(1);
  });

  test("waitForBoot returns once sys.boot_completed=1", async () => {
    const s = scripted([ok(""), ok("\n"), ok(""), ok("1\n")]);
    await new Adb("x:5555", s.run, noWait).waitForBoot(60_000);
    expect(s.calls.filter((c) => c[0] === "connect").length).toBe(2);
  });

  test("waitForBoot times out", async () => {
    const run = async () => ok("");
    await expect(new Adb("x:5555", run, noWait).waitForBoot(0)).rejects.toBeInstanceOf(BootTimeout);
  });
});
