import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { REDACTED, redact } from "../cli/redact";

describe("redact", () => {
  test("getprop identifiers", () => {
    const out = redact("[ro.serialno]: [ABC123]\n[ro.product.model]: [TV]\n[persist.sys.devicecode]: [xyz]\n[ro.boot.serialno]: []");
    expect(out).toBe(`[ro.serialno]: [${REDACTED}]\n[ro.product.model]: [TV]\n[persist.sys.devicecode]: [${REDACTED}]\n[ro.boot.serialno]: []`);
  });
  test("settings identifiers, including multi-line base64 values", () => {
    const out = redact("android_id=5f3a\ndevice_name=Jo's TV\nregisterQrImg=iVBORw0K\nAAAAQmCC\nAAAA==\nnext_key=1\ndevice_idle_constants=a=1");
    expect(out).toBe(`android_id=${REDACTED}\ndevice_name=${REDACTED}\nregisterQrImg=${REDACTED}\nnext_key=1\ndevice_idle_constants=a=1`);
  });
  test("every committed fixture is already redacted", () => {
    const dir = new URL("./fixtures/", import.meta.url).pathname;
    for (const f of readdirSync(dir)) expect(redact(readFileSync(`${dir}${f}`, "utf8"))).toBe(readFileSync(`${dir}${f}`, "utf8"));
  });
});
