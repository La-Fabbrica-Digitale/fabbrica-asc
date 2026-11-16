// Build dist/fabbrica-appstoreconnect-<version>.mcpb with production dependencies only, plus its SHA-256.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version)
  throw new Error(`manifest.json version ${manifest.version} != package.json ${pkg.version}`);

const build = join(root, "dist", "build");
rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
for (const f of [
  "bin",
  "src",
  "manifest.json",
  "package.json",
  "package-lock.json",
  "README.md",
  "SECURITY.md",
  "LICENSE",
])
  cpSync(join(root, f), join(build, f), { recursive: true });
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: build,
  stdio: "inherit",
});

const out = join(root, "dist", `fabbrica-appstoreconnect-${pkg.version}.mcpb`);
execFileSync("npx", ["--no-install", "mcpb", "validate", join(build, "manifest.json")], {
  cwd: root,
  stdio: "inherit",
});
execFileSync("npx", ["--no-install", "mcpb", "pack", build, out], { cwd: root, stdio: "inherit" });
const sha = createHash("sha256").update(readFileSync(out)).digest("hex");
writeFileSync(out + ".sha256", `${sha}  ${out.split("/").pop()}\n`);
console.log(`\n${out}\nsha256 ${sha}`);
