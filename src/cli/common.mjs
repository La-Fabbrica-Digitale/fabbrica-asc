import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME_DIR } from "../config.mjs";

export const SAVED_CONFIG = join(HOME_DIR, "config.json");

// CLI commands (doctor, tools, call) use env vars if set, otherwise the env saved by `init`.
export function cliEnv() {
  let saved = {};
  if (existsSync(SAVED_CONFIG)) {
    try {
      saved = JSON.parse(readFileSync(SAVED_CONFIG, "utf8")).env ?? {};
    } catch {}
  }
  const env = { ...saved };
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("ASC_")) env[k] = v;
  return { ...process.env, ...env };
}

export function claudeDesktopConfigPath() {
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32")
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}
