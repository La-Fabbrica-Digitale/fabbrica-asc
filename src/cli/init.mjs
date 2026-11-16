// Setup wizard. Interactive by default; flags allow scripted setup:
//   --key-id X --issuer-id Y --p8 PATH --files-root DIR --groups metadata,media --client desktop|code|print --yes
// Dangerous groups (release, delete, pricing, raw) can be enabled only interactively, by typing ENABLE <GROUP>.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  copyFileSync,
  chmodSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_DIR, GROUPS } from "../config.mjs";
import { SAVED_CONFIG, claudeDesktopConfigPath } from "./common.mjs";
import { doctor } from "./doctor.mjs";
import { VERSION } from "../server.mjs";

const SERVER_NAME = "fabbrica-appstoreconnect";

function flags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    f[k] = v;
  }
  return f;
}

function findP8() {
  const dl = join(homedir(), "Downloads");
  try {
    return readdirSync(dl)
      .filter((n) => /^AuthKey_[A-Z0-9]+\.p8$/.test(n))
      .map((n) => join(dl, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

// How MCP clients should launch the server.
function launchCommand() {
  const here = dirname(fileURLToPath(import.meta.url));
  const bin = resolve(here, "..", "..", "bin", "fabbrica-appstoreconnect.mjs");
  const fromNpx = /[\\/]_npx[\\/]/.test(bin);
  if (fromNpx) {
    const npx = join(dirname(process.execPath), process.platform === "win32" ? "npx.cmd" : "npx");
    return { command: existsSync(npx) ? npx : "npx", args: ["-y", `${SERVER_NAME}@${VERSION}`] };
  }
  return { command: process.execPath, args: [bin] };
}

export async function init(argv) {
  const f = flags(argv);
  const tty = stdin.isTTY && !f.yes;
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q, def) => {
    if (!tty) return def;
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def;
  };
  try {
    console.log(`\nfabbrica-appstoreconnect ${VERSION} setup\n`);
    console.log("1. App Store Connect API key");
    console.log(
      "   Create it in App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys.",
    );
    console.log("   Role: App Manager. Download the .p8 file (Apple lets you download it once).\n");

    const keyId = String((await ask("   Key ID (10 characters)", f["key-id"])) ?? "");
    if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new Error(`Key ID looks wrong: "${keyId}"`);
    const issuerId = String((await ask("   Issuer ID (UUID above the key list)", f["issuer-id"])) ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(issuerId)) throw new Error(`Issuer ID looks wrong: "${issuerId}"`);
    const p8src = resolve(String((await ask("   Path to AuthKey_XXXX.p8", f.p8 ?? findP8())) ?? ""));
    if (!existsSync(p8src)) throw new Error(`file not found: ${p8src}`);
    if (!readFileSync(p8src, "utf8").includes("BEGIN PRIVATE KEY")) throw new Error(`not a .p8 private key: ${p8src}`);

    mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
    const p8 = join(HOME_DIR, `AuthKey_${keyId}.p8`);
    if (resolve(p8src) !== p8) copyFileSync(p8src, p8);
    try {
      chmodSync(p8, 0o600);
    } catch {}
    console.log(`   Key copied to ${p8} (mode 600). You can delete ${basename(p8src)} from its old place.\n`);

    console.log("2. Files folder. The server uploads only files inside this folder.");
    const filesRoot = resolve(
      String(await ask("   Folder with screenshots and videos", f["files-root"] ?? process.cwd())),
    );
    if (!existsSync(filesRoot)) throw new Error(`folder not found: ${filesRoot}`);

    console.log("\n3. Tool groups");
    const wanted = f.groups
      ? String(f.groups)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
    for (const g of wanted ?? []) if (!GROUPS[g]) throw new Error(`unknown group ${g}`);
    const groups = [];
    for (const [g, d] of Object.entries(GROUPS)) {
      if (g === "read") continue;
      const on = wanted
        ? wanted.includes(g)
        : /^y/i.test(
            await ask(
              `   Enable ${g}${d.danger ? " (DANGEROUS)" : ""}: ${d.title}? (${d.danger ? "y/N" : "Y/n"})`,
              d.danger ? "n" : "y",
            ),
          );
      if (!on) continue;
      if (d.danger) {
        // Typed confirmation at setup, in addition to the per-call dialogs.
        if (!tty) throw new Error(`dangerous group ${g} can be enabled only interactively`);
        const phrase = `ENABLE ${g.toUpperCase()}`;
        if ((await ask(`   Each ${g} call will also need a two-step system dialog. Type "${phrase}"`, "")) !== phrase) {
          console.log(`   ${g} stays off.`);
          continue;
        }
      }
      groups.push(g);
    }
    const env = {
      ASC_KEY_ID: keyId,
      ASC_ISSUER_ID: issuerId,
      ASC_P8_PATH: p8,
      ASC_FILES_ROOT: filesRoot,
      ASC_GROUPS: ["read", ...groups].join(","),
    };
    writeFileSync(SAVED_CONFIG, JSON.stringify({ version: VERSION, env }, null, 2), { mode: 0o600 });
    console.log(`   Groups: ${env.ASC_GROUPS}. Saved to ${SAVED_CONFIG}\n`);

    console.log("4. Checking the key");
    const healthy = await doctor([], { ...process.env, ...env });
    if (!healthy) console.log("   Fix the FAIL lines above, then run init again.\n");

    console.log("\n5. Connect to your MCP client");
    const client = String(
      await ask("   Client: desktop = Claude Desktop, code = Claude Code, print = show config", f.client ?? "desktop"),
    );
    const launch = launchCommand();
    const entry = { command: launch.command, args: launch.args, env };
    if (client === "desktop") {
      const path = f["desktop-config"] ? resolve(String(f["desktop-config"])) : claudeDesktopConfigPath();
      let cfg = {};
      if (existsSync(path)) {
        cfg = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(path + ".bak", readFileSync(path));
      } else mkdirSync(dirname(path), { recursive: true });
      cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [SERVER_NAME]: entry };
      writeFileSync(path, JSON.stringify(cfg, null, 2));
      console.log(`   Written to ${path} (backup: ${basename(path)}.bak).`);
      console.log(
        '   Quit Claude Desktop (Cmd+Q / File → Exit) and open it again. Then ask: "list my apps in App Store Connect".',
      );
    } else if (client === "code") {
      const e = Object.entries(env)
        .map(([k, v]) => `-e ${k}=${JSON.stringify(v)}`)
        .join(" ");
      console.log(
        `   Run:\n   claude mcp add ${SERVER_NAME} --scope user ${e} -- ${[launch.command, ...launch.args].map((x) => JSON.stringify(x)).join(" ")}`,
      );
    } else {
      console.log(JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2));
    }
    console.log("\nDone.");
  } finally {
    rl.close();
  }
}
