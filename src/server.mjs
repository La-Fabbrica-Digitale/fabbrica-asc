import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, assertConfig } from "./config.mjs";
import { createClient } from "./asc.mjs";
import { createAudit } from "./audit.mjs";
import { registerAll } from "./registry.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;

export async function buildServer(env = process.env) {
  const cfg = loadConfig(env);
  assertConfig(cfg);
  const client = createClient(cfg);
  const audit = createAudit(cfg.auditLog);
  const ctx = { ...client, cfg, audit, version: VERSION };
  const server = new McpServer(
    { name: "fabbrica-appstoreconnect", version: VERSION },
    {
      instructions:
        "App Store Connect tools. Start with server_status and list_apps. For many screenshots use upload_tree with dryRun=true, show the plan to the user, then run with dryRun=false. Tools marked DANGEROUS open a confirmation dialog on the user's computer: call them once, wait, and never retry a cancelled call on your own.",
    },
  );
  await registerAll(server, ctx, join(here, "tools"));
  return { server, cfg, ctx };
}

export async function startServer() {
  const { server, cfg } = await buildServer();
  await server.connect(new StdioServerTransport());
  console.error(
    `fabbrica-appstoreconnect ${VERSION} ready. groups: ${[...cfg.groups].join(",")}${cfg.readonly ? " (read-only)" : ""}`,
  );
}
