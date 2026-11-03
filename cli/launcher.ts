// Kyoto Home's app list. The launcher reads apps.txt from its external files dir on every resume,
// so `kyoto home apps <file>` changes the list without rebuilding the APK.

export const KYOTO_HOME = "com.kyoto.home";
export const KYOTO_HOME_ACTIVITY = `${KYOTO_HOME}/.HomeActivity`;
export const APPS_DIR = `/sdcard/Android/data/${KYOTO_HOME}/files`;

export interface AppsLine {
  pkgs: string[];
  label: string;
}

const PKG = /^[a-zA-Z][\w]*(\.[\w]+)+$/;

/** Parse "pkg[,fallback...]|Label" lines; blank lines and # comments are ignored. Throws listing every bad line. */
export function parseAppsList(text: string): AppsLine[] {
  const out: AppsLine[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const bar = line.indexOf("|");
    const pkgs = (bar < 0 ? "" : line.slice(0, bar)).split(",").map((p) => p.trim());
    const label = bar < 0 ? "" : line.slice(bar + 1).trim();
    if (bar < 0 || !label || pkgs.some((p) => !PKG.test(p))) errors.push(`line ${i + 1}: expected "package[,fallback]|Label", got "${line}"`);
    else out.push({ pkgs, label });
  });
  if (errors.length) throw new Error("apps list has problems:\n  " + errors.join("\n  "));
  if (!out.length) throw new Error("apps list is empty");
  return out;
}
