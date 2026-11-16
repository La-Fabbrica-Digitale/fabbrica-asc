// Settings come only from environment variables in the client config. Tools cannot change them.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";

export const HOME_DIR = join(homedir(), ".fabbrica-appstoreconnect");

// `read` is always on. Dangerous groups are off by default; each call needs a double confirmation.
export const GROUPS = {
  read: { danger: false, default: true, title: "Read-only lookups" },
  metadata: { danger: false, default: true, title: "Versions, texts, categories, review info, attach build" },
  media: { danger: false, default: true, title: "Screenshots, previews, header/search images" },
  release: { danger: true, default: false, title: "Submit for review, cancel submission, release, phased release" },
  delete: {
    danger: true,
    default: false,
    title: "Delete screenshots, previews, localizations, versions, library images",
  },
  pricing: { danger: true, default: false, title: "App price schedule" },
  raw: { danger: true, default: false, title: "Generic App Store Connect API calls (asc_request)" },
};

// Empty values and unfilled .mcpb placeholders like "${user_config.x}" count as unset.
const value = (v) => {
  const s = v?.trim();
  return s && !s.startsWith("${") ? s : undefined;
};
const truthy = (v) => /^(1|true|yes|on)$/i.test(v ?? "");

export function loadConfig(env = process.env) {
  const groups = new Set(["read"]);
  const list = value(env.ASC_GROUPS);
  if (list) {
    for (const g of list
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!GROUPS[g]) throw new Error(`ASC_GROUPS: unknown group "${g}"; known: ${Object.keys(GROUPS).join(", ")}`);
      groups.add(g);
    }
  } else {
    for (const [g, d] of Object.entries(GROUPS)) if (d.default) groups.add(g);
  }
  // ASC_ENABLE_<GROUP>=true|false overrides ASC_GROUPS (the .mcpb install dialog sets these).
  for (const g of Object.keys(GROUPS)) {
    const v = value(env[`ASC_ENABLE_${g.toUpperCase()}`]);
    if (g === "read" || v === undefined) continue;
    if (truthy(v)) groups.add(g);
    else groups.delete(g);
  }
  const readonly = truthy(value(env.ASC_READONLY));
  if (readonly) for (const g of groups) if (g !== "read") groups.delete(g);

  return {
    keyId: value(env.ASC_KEY_ID),
    issuerId: value(env.ASC_ISSUER_ID),
    p8Path: value(env.ASC_P8_PATH),
    filesRoot: value(env.ASC_FILES_ROOT) ?? null,
    readonly,
    groups,
    dev: truthy(value(env.ASC_DEV)),
    auditLog: value(env.ASC_AUDIT_LOG) ?? join(HOME_DIR, "audit.log"),
    httpTimeoutSec: intIn(value(env.ASC_HTTP_TIMEOUT) ?? "60", 5, 600, "ASC_HTTP_TIMEOUT"),
    confirmTimeoutSec: intIn(value(env.ASC_CONFIRM_TIMEOUT) ?? "180", 10, 900, "ASC_CONFIRM_TIMEOUT"),
  };
}

function intIn(v, min, max, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${name} must be an integer ${min}..${max}, got "${v}"`);
  return n;
}

// Required settings, checked at server start. ASC_FILES_ROOT is required so uploads can never read arbitrary files.
export function assertConfig(cfg) {
  const missing = Object.entries({
    ASC_KEY_ID: cfg.keyId,
    ASC_ISSUER_ID: cfg.issuerId,
    ASC_P8_PATH: cfg.p8Path,
    ASC_FILES_ROOT: cfg.filesRoot,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`missing ${missing.join(", ")}; run: fabbrica-appstoreconnect init`);
  if (!/^[A-Z0-9]{10}$/.test(cfg.keyId))
    throw new Error(`ASC_KEY_ID should be 10 characters A-Z0-9, got "${cfg.keyId}"`);
  if (!/^[0-9a-f-]{36}$/i.test(cfg.issuerId)) throw new Error(`ASC_ISSUER_ID should be a UUID, got "${cfg.issuerId}"`);
  if (!existsSync(cfg.p8Path)) throw new Error(`ASC_P8_PATH not found: ${cfg.p8Path}`);
  if (!existsSync(cfg.filesRoot) || !statSync(cfg.filesRoot).isDirectory())
    throw new Error(`ASC_FILES_ROOT is not a folder: ${cfg.filesRoot}`);
}
