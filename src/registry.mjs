// Loads src/tools/*.mjs, registers tools of enabled groups, and wraps each call with
// the read-only check, double confirmation for dangerous groups, and the audit log.
// With ASC_DEV=1, changed or new tool files are reloaded on the next call.
import { readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { GROUPS } from "./config.mjs";
import { doubleConfirm } from "./confirm.mjs";

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (text) => ({ isError: true, content: [{ type: "text", text }] });
const clip = (v) => {
  const s = JSON.stringify(v) ?? "";
  return s.length > 4000 ? `${s.slice(0, 4000)}…` : v;
};

export async function registerAll(server, ctx, toolsDir) {
  const { cfg, audit } = ctx;
  const defs = new Map();
  const registered = new Map();
  const mtimes = new Map();

  const files = () =>
    readdirSync(toolsDir)
      .filter((f) => f.endsWith(".mjs"))
      .sort()
      .map((f) => join(toolsDir, f));

  async function load() {
    const all = [];
    for (const file of files()) {
      const mtime = statSync(file).mtimeMs;
      const mod = await import(`${pathToFileURL(file).href}?v=${mtime}`);
      mtimes.set(file, mtime);
      all.push(...mod.default);
    }
    const seen = new Set();
    for (const d of all) {
      if (seen.has(d.name)) throw new Error(`duplicate tool ${d.name}`);
      if (!GROUPS[d.group]) throw new Error(`tool ${d.name}: unknown group ${d.group}`);
      if (GROUPS[d.group].danger && !d.confirm) throw new Error(`tool ${d.name}: dangerous group needs confirm()`);
      seen.add(d.name);
    }
    for (const [name, reg] of registered) {
      if (all.some((d) => d.name === name && cfg.groups.has(d.group))) continue;
      reg.remove();
      registered.delete(name);
      defs.delete(name);
    }
    for (const d of all.filter((d) => cfg.groups.has(d.group))) {
      defs.set(d.name, d);
      const danger = GROUPS[d.group].danger;
      const meta = {
        description:
          d.description + (danger ? " [DANGEROUS: opens a confirmation dialog for the user; call once and wait]" : ""),
        annotations: { readOnlyHint: d.group === "read", destructiveHint: danger, openWorldHint: true },
      };
      if (registered.has(d.name)) registered.get(d.name).update({ ...meta, paramsSchema: d.input });
      else
        registered.set(
          d.name,
          server.registerTool(d.name, { ...meta, inputSchema: d.input }, (args) => handle(d.name, args)),
        );
    }
  }

  let reloading = null;
  async function reloadIfChanged() {
    const now = files();
    if (now.length === mtimes.size && now.every((f) => statSync(f).mtimeMs === mtimes.get(f))) return;
    reloading ??= load()
      .catch((e) => console.error(`hot reload failed: ${e.message}`))
      .finally(() => {
        reloading = null;
      });
    await reloading;
  }

  async function handle(name, args) {
    if (cfg.dev) await reloadIfChanged();
    const d = defs.get(name);
    if (!d) return fail(`tool ${name} is no longer available`);
    const write = d.isWrite ? d.isWrite(args) : d.group !== "read";
    const log = (entry) => write && audit.write({ tool: name, group: d.group, args, ...entry });
    try {
      let confirmation;
      const plan = GROUPS[d.group].danger ? await d.confirm(args, ctx) : null;
      if (plan) {
        const res = await doubleConfirm({
          action: plan.action,
          summary: plan.summary,
          phrase: plan.phrase,
          timeoutSec: cfg.confirmTimeoutSec,
        });
        confirmation = { phrase: plan.phrase, ...res };
        if (!res.confirmed) {
          log({ confirmation, result: "not executed" });
          return fail(`Not executed: ${res.reason}. Tell the user; do not retry unless the user asks again.`);
        }
      }
      // run() gets the confirmed plan, so it acts on what the user saw.
      const result = await d.run(args, ctx, plan ?? undefined);
      log({ confirmation, result: clip(result) });
      return ok(result);
    } catch (e) {
      log({ error: e.message });
      return fail(e.message);
    }
  }

  await load();
  if (cfg.dev) {
    watch(toolsDir, () => {
      reloadIfChanged();
    });
    console.error("fabbrica-appstoreconnect: ASC_DEV=1, hot reload on");
  }
}
