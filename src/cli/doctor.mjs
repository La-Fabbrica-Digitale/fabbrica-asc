// Checks: Node version, key file and permissions, JWT + network to Apple, groups, dialog tool, audit log.
import { statSync, accessSync, constants, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, assertConfig, GROUPS } from "../config.mjs";
import { createClient } from "../asc.mjs";
import { cliEnv } from "./common.mjs";

const OK = "ok  ",
  BAD = "FAIL",
  WARN = "warn";

export async function doctor(_, env = cliEnv()) {
  const rows = [];
  const add = (s, what, detail = "") => rows.push([s, what, detail]);
  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20 ? OK : BAD, "Node.js", process.versions.node + (major >= 20 ? "" : " (need >= 20)"));

  let cfg;
  try {
    cfg = loadConfig(env);
    assertConfig(cfg);
    add(OK, "settings", `key ${cfg.keyId}`);
  } catch (e) {
    add(BAD, "settings", e.message);
    return print(rows);
  }

  try {
    const st = statSync(cfg.p8Path);
    const mode = (st.mode & 0o777).toString(8);
    add(
      process.platform === "win32" || (st.mode & 0o077) === 0 ? OK : WARN,
      ".p8 key file",
      `${cfg.p8Path} (mode ${mode}${st.mode & 0o077 && process.platform !== "win32" ? ", run chmod 600" : ""})`,
    );
  } catch (e) {
    add(BAD, ".p8 key file", e.message);
    return print(rows);
  }

  try {
    const c = createClient({ ...cfg, readonly: true });
    const r = await c.api("GET", "/v1/apps?fields[apps]=name&limit=200");
    add(
      OK,
      "App Store Connect API",
      `${r.data.length} apps: ${r.data
        .slice(0, 5)
        .map((a) => a.attributes.name)
        .join(", ")}${r.data.length > 5 ? ", …" : ""}`,
    );
  } catch (e) {
    add(BAD, "App Store Connect API", e.message);
  }

  add(OK, "ASC_FILES_ROOT", cfg.filesRoot);
  for (const [g, d] of Object.entries(GROUPS))
    add(
      cfg.groups.has(g) ? (d.danger ? WARN : OK) : "off ",
      `group ${g}`,
      d.title + (d.danger && cfg.groups.has(g) ? " (dangerous, double confirmation)" : ""),
    );

  const dlg = process.platform === "darwin" ? "osascript" : process.platform === "win32" ? "powershell.exe" : "zenity";
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [dlg], { stdio: "ignore" });
    add(OK, "confirmation dialog", dlg);
  } catch {
    add(
      [...cfg.groups].some((g) => GROUPS[g].danger) ? BAD : WARN,
      "confirmation dialog",
      `${dlg} not found: dangerous actions will fail`,
    );
  }

  try {
    mkdirSync(dirname(cfg.auditLog), { recursive: true, mode: 0o700 });
    accessSync(dirname(cfg.auditLog), constants.W_OK);
    add(OK, "audit log", cfg.auditLog);
  } catch (e) {
    add(BAD, "audit log", e.message);
  }
  return print(rows);
}

function print(rows) {
  for (const [s, w, d] of rows) console.log(`[${s}] ${w.padEnd(24)} ${d}`);
  const failed = rows.some(([s]) => s === BAD);
  if (failed) process.exitCode = 1;
  return !failed;
}
