// Strips device identifiers from captured TV output before it can be committed as a test fixture.
// Covers `getprop` ("[key]: [value]") and `settings list` ("key=value", values may span lines).

/** Keys whose values identify one physical TV, its owner or their home. */
const SENSITIVE = /serial|android_id|_address$|mac$|_mac|esn|devicecode|device_?id(?![a-z])|deviceprefix|program_id|qrimg|device_name|bluetooth_name|bt\.name|ssid|account|email|token|imei|uuid/i;
const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/;

export const REDACTED = "REDACTED";

export function redact(text: string): string {
  const out: string[] = [];
  let skippingBlob = false;
  for (const line of text.split("\n")) {
    // Continuation lines of a redacted multi-line value (e.g. a base64 QR image).
    if (skippingBlob && BASE64_LINE.test(line)) continue;
    skippingBlob = false;
    const prop = line.match(/^\[([^\]]+)\]: \[(.*)\]$/);
    if (prop) {
      out.push(SENSITIVE.test(prop[1]!) && prop[2] ? `[${prop[1]}]: [${REDACTED}]` : line);
      continue;
    }
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq) : "";
    if (key && /^[\w.\-]+$/.test(key) && SENSITIVE.test(key) && line.slice(eq + 1)) {
      out.push(`${key}=${REDACTED}`);
      skippingBlob = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
