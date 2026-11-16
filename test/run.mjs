// End-to-end tests against a fake App Store Connect (test/mock-fetch.mjs) and a fake dialog (zenity stub).
// Run: npm test   (Linux/macOS; uses the zenity code path via PATH stub on Linux)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generateKeyPairSync } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  symlinkSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "fac-test-"));
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const p8 = join(tmp, "AuthKey_TEST123456.p8");
writeFileSync(p8, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

// PNG header + IHDR is enough for size checks.
function png(path, w, h, colorType = 2) {
  mkdirSync(dirname(path), { recursive: true });
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = colorType;
  writeFileSync(path, b);
}
const files = join(tmp, "assets");
png(join(files, "good/en-US/APP_IPHONE_67/01.png"), 1320, 2868);
png(join(files, "good/en-US/APP_IPHONE_67/02.png"), 2868, 1320);
png(join(files, "bad/en-US/APP_IPHONE_67/01.png"), 1000, 1000);
png(join(files, "bad/en-US/APP_IPHONE_67/02.png"), 1320, 2868, 6);
png(join(tmp, "outside.png"), 1320, 2868);

// zenity stub: --question exits FAKE_Q (0 continue / 1 cancel); --entry prints FAKE_TEXT.
const fakeBin = join(tmp, "bin");
mkdirSync(fakeBin);
writeFileSync(
  join(fakeBin, "zenity"),
  `#!/bin/sh\necho "$@" >> "${tmp}/dialogs.log"\ncase "$1" in --question) exit \${FAKE_Q:-1};; --entry) printf '%s' "$FAKE_TEXT"; exit 0;; esac\nexit 1\n`,
);
chmodSync(join(fakeBin, "zenity"), 0o755);

const baseEnv = {
  PATH: `${fakeBin}:${process.env.PATH}`,
  HOME: tmp,
  ASC_KEY_ID: "TEST123456",
  ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000000",
  ASC_P8_PATH: p8,
  ASC_FILES_ROOT: files,
  ASC_AUDIT_LOG: join(tmp, "audit.log"),
  FAKE_ASC_LOG: join(tmp, "asc.log"),
};

async function start(env = {}, root = pkg) {
  const t = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", join(pkg, "test/mock-fetch.mjs"), join(root, "bin/fabbrica-appstoreconnect.mjs")],
    env: { ...baseEnv, ...env },
    stderr: "pipe",
  });
  const c = new Client({ name: "test", version: "1" });
  await c.connect(t);
  return c;
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  const text = r.content?.[0]?.text ?? "";
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { isError: Boolean(r.isError), text, data };
};
const ascLog = () => (existsSync(baseEnv.FAKE_ASC_LOG) ? readFileSync(baseEnv.FAKE_ASC_LOG, "utf8") : "");
const resetLog = () => writeFileSync(baseEnv.FAKE_ASC_LOG, "");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack?.split("\n").slice(0, 3).join("\n     ")}`);
    process.exitCode = 1;
  }
}

let c = await start();
const names = (await c.listTools()).tools.map((t) => t.name);

await test("default groups: safe tools on, dangerous off", async () => {
  for (const n of ["server_status", "list_apps", "upload_tree", "set_version_texts"]) assert.ok(names.includes(n), n);
  for (const n of ["submit_for_review", "delete_screenshots", "set_app_price", "asc_request"])
    assert.ok(!names.includes(n), n);
});
await test("list_apps", async () => {
  const r = await call(c, "list_apps");
  assert.equal(r.data[0].name, "My App");
});
await test("validate_assets reports bad sizes and alpha", async () => {
  const r = await call(c, "validate_assets", { root: join(files, "bad") });
  assert.equal(r.data.errors, 1);
  assert.match(JSON.stringify(r.data.items), /1000x1000 not accepted/);
  assert.match(JSON.stringify(r.data.items), /alpha channel/);
});
await test("upload_tree dry run uploads nothing", async () => {
  resetLog();
  const r = await call(c, "upload_tree", { versionId: "v1", root: join(files, "good") });
  assert.equal(r.data.dryRun, true);
  assert.equal(r.data.totals.files, 2);
  assert.doesNotMatch(ascLog(), /^(POST|PATCH|DELETE|PUT)/m);
});
const plan = async (root, extra = {}) =>
  (await call(c, "upload_tree", { versionId: "v1", root, ...extra })).data.planId;

await test("upload_tree with errors uploads nothing", async () => {
  resetLog();
  const r = await call(c, "upload_tree", { versionId: "v1", root: join(files, "bad"), dryRun: false });
  assert.equal(r.data.executed, false);
  assert.doesNotMatch(ascLog(), /^(POST|PATCH|DELETE|PUT)/m);
});
await test("upload_tree without planId or with a stale planId uploads nothing", async () => {
  resetLog();
  const a = await call(c, "upload_tree", { versionId: "v1", root: join(files, "good"), dryRun: false });
  const b = await call(c, "upload_tree", {
    versionId: "v1",
    root: join(files, "good"),
    dryRun: false,
    planId: "0000000000000000",
  });
  assert.equal(a.data.executed, false);
  assert.match(a.data.reason, /planId missing/);
  assert.equal(b.data.executed, false);
  assert.match(b.data.reason, /plan changed/);
  assert.doesNotMatch(ascLog(), /^(POST|PATCH|DELETE|PUT)/m);
});
await test("upload_tree uploads and waits for COMPLETE", async () => {
  resetLog();
  const r = await call(c, "upload_tree", {
    versionId: "v1",
    root: join(files, "good"),
    dryRun: false,
    planId: await plan(join(files, "good")),
  });
  assert.equal(r.data.ok, 1, r.text);
  assert.deepEqual(
    r.data.results[0].uploaded.map((u) => u.state),
    ["COMPLETE", "COMPLETE"],
  );
  assert.match(ascLog(), /^PUT \/fake\//m);
});
await test("upload_tree again replaces the 2 existing screenshots", async () => {
  const d = await call(c, "upload_tree", { versionId: "v1", root: join(files, "good"), replace: true });
  assert.equal(d.data.plan[0].replaceExisting, 2);
  const r = await call(c, "upload_tree", {
    versionId: "v1",
    root: join(files, "good"),
    dryRun: false,
    replace: true,
    planId: d.data.planId,
  });
  assert.equal(r.data.results[0].removed, 2);
  const l = await call(c, "list_screenshots", { versionId: "v1", locale: "en-US" });
  assert.equal(l.data[0].screenshots.length, 2);
});
await test("file outside ASC_FILES_ROOT is refused", async () => {
  const r = await call(c, "upload_screenshots", {
    versionId: "v1",
    locale: "en-US",
    displayType: "APP_IPHONE_67",
    files: [join(tmp, "outside.png")],
  });
  assert.ok(r.isError);
  assert.match(r.text, /outside ASC_FILES_ROOT/);
});
await test("upload_file: IAP review screenshot", async () => {
  const r = await call(c, "upload_file", {
    type: "inAppPurchaseAppStoreReviewScreenshots",
    file: join(files, "good/en-US/APP_IPHONE_67/01.png"),
    relationships: { inAppPurchaseV2: { data: { type: "inAppPurchases", id: "iap1" } } },
  });
  assert.ok(!r.isError, r.text);
  assert.equal(r.data.state, "COMPLETE");
});
await test("upload_file: unknown resource type is rejected", async () => {
  const r = await call(c, "upload_file", {
    type: "apps",
    file: join(files, "good/en-US/APP_IPHONE_67/01.png"),
    relationships: {},
  });
  assert.ok(r.isError);
});
await test("audit log has write calls", async () => {
  const lines = readFileSync(baseEnv.ASC_AUDIT_LOG, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.tool === "upload_tree"));
});
await c.close();

await test("submit: correct phrase in dialog submits", async () => {
  resetLog();
  const s = await start({ ASC_GROUPS: "metadata,media,release", FAKE_Q: "0", FAKE_TEXT: "SUBMIT My App 1.0.2" });
  const r = await call(s, "submit_for_review", { versionId: "v1" });
  await s.close();
  assert.ok(!r.isError, r.text);
  assert.equal(r.data.state, "WAITING_FOR_REVIEW");
  const last = readFileSync(baseEnv.ASC_AUDIT_LOG, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .pop();
  assert.equal(last.confirmation.confirmed, true);
});
await test("submit: wrong phrase does not submit", async () => {
  resetLog();
  const s = await start({ ASC_GROUPS: "release", FAKE_Q: "0", FAKE_TEXT: "SUBMIT" });
  const r = await call(s, "submit_for_review", { versionId: "v1" });
  await s.close();
  assert.ok(r.isError);
  assert.match(r.text, /did not match/);
  assert.doesNotMatch(ascLog(), /^POST \/v1\/reviewSubmissions/m);
});
await test("submit: cancel on step 1 does not submit", async () => {
  resetLog();
  const s = await start({ ASC_GROUPS: "release", FAKE_Q: "1", FAKE_TEXT: "SUBMIT My App 1.0.2" });
  const r = await call(s, "submit_for_review", { versionId: "v1" });
  await s.close();
  assert.ok(r.isError);
  assert.match(r.text, /cancelled on step 1/);
  assert.doesNotMatch(ascLog(), /^POST \/v1\/reviewSubmissions/m);
});
await test("ASC_READONLY=1 exposes only read tools", async () => {
  const s = await start({ ASC_READONLY: "1", ASC_GROUPS: "metadata,media,release,raw" });
  const t = (await s.listTools()).tools;
  await s.close();
  assert.ok(
    t.every((x) => x.annotations?.readOnlyHint),
    t
      .filter((x) => !x.annotations?.readOnlyHint)
      .map((x) => x.name)
      .join(","),
  );
});
await test("raw: deleting an app is blocked before any dialog", async () => {
  writeFileSync(join(tmp, "dialogs.log"), "");
  const s = await start({ ASC_GROUPS: "raw", FAKE_Q: "0", FAKE_TEXT: "DELETE apps" });
  const r = await call(s, "asc_request", { method: "DELETE", path: "/v1/apps/app1" });
  await s.close();
  assert.ok(r.isError);
  assert.match(r.text, /deleting apps is blocked/);
  assert.equal(readFileSync(join(tmp, "dialogs.log"), "utf8"), "");
});
// ---------- review fixes ----------
const dialogs = () => (existsSync(join(tmp, "dialogs.log")) ? readFileSync(join(tmp, "dialogs.log"), "utf8") : "");
const posts = (path) =>
  ascLog()
    .split("\n")
    .filter((l) => l === `POST ${path}`).length;

await test("raw: '..' and '%2e' cannot reach blocked endpoints", async () => {
  writeFileSync(join(tmp, "dialogs.log"), "");
  const s = await start({ ASC_GROUPS: "raw", FAKE_Q: "0", FAKE_TEXT: "x" });
  const bad = [
    "/v1/apps/../users/123",
    "/v1/apps/%2e%2e/users/1",
    "/v1/apps/%2E%2E/certificates/1",
    "/v1//users/1",
    "/v1/apps/x%2f..%2fusers",
  ];
  const out = [];
  for (const path of bad) out.push(await call(s, "asc_request", { method: "DELETE", path }));
  await s.close();
  for (const [i, r] of out.entries()) assert.ok(r.isError && /refusing path/.test(r.text), `${bad[i]}: ${r.text}`);
  assert.equal(dialogs(), "");
});
await test("raw: dialog phrase names method and full path", async () => {
  writeFileSync(join(tmp, "dialogs.log"), "");
  const s = await start({ ASC_GROUPS: "raw", FAKE_Q: "1" });
  await call(s, "asc_request", { method: "POST", path: "/v1/inAppPurchases", body: { data: {} } });
  await s.close();
  assert.match(dialogs(), /--no-markup/);
});
await test("replace keeps old screenshots when an upload fails", async () => {
  resetLog();
  const s = await start({ FAKE_FAIL_PUT: "4" });
  const p1 = (await call(s, "upload_tree", { versionId: "v1", root: join(files, "good") })).data.planId;
  await call(s, "upload_tree", { versionId: "v1", root: join(files, "good"), dryRun: false, planId: p1 });
  const before = (await call(s, "list_screenshots", { versionId: "v1", locale: "en-US" })).data[0].screenshots.map(
    (x) => x.id,
  );
  const p2 = (await call(s, "upload_tree", { versionId: "v1", root: join(files, "good"), replace: true })).data.planId;
  const r = await call(s, "upload_tree", {
    versionId: "v1",
    root: join(files, "good"),
    dryRun: false,
    replace: true,
    planId: p2,
  });
  const after = (await call(s, "list_screenshots", { versionId: "v1", locale: "en-US" })).data[0].screenshots.map(
    (x) => x.id,
  );
  await s.close();
  assert.equal(r.data.failed, 1, r.text);
  assert.match(r.data.results[0].error, /New files removed; 2 old file\(s\) kept/);
  assert.deepEqual(after, before);
});
await test("POST is not retried on 5xx; GET is", async () => {
  resetLog();
  const s = await start({ FAKE_500: "/v1/appStoreVersions" });
  const r = await call(s, "create_version", { appId: "app1", versionString: "9.9" });
  await s.close();
  assert.ok(r.isError);
  assert.equal(posts("/v1/appStoreVersions"), 1);
  resetLog();
  const g = await start({ FAKE_500: "/v1/apps" });
  const l = await call(g, "list_apps");
  await g.close();
  assert.ok(l.isError);
  assert.equal(
    ascLog()
      .split("\n")
      .filter((x) => x.startsWith("GET /v1/apps?")).length,
    4,
  );
});
await test("a hanging request fails after ASC_HTTP_TIMEOUT", async () => {
  const s = await start({ ASC_HTTP_TIMEOUT: "5", FAKE_HANG: "/v1/appStoreVersions" });
  const t = Date.now();
  const r = await call(s, "create_version", { appId: "app1", versionString: "9.9" });
  await s.close();
  assert.ok(r.isError);
  assert.match(r.text, /no response in 5 s/);
  assert.ok(Date.now() - t < 15000);
});
await test("submit: dialog lists other draft items and the release type", async () => {
  writeFileSync(join(tmp, "dialogs.log"), "");
  const s = await start({
    ASC_GROUPS: "release",
    FAKE_SCENARIO: "draft",
    FAKE_Q: "0",
    FAKE_TEXT: "SUBMIT My App 1.0.2",
  });
  const r = await call(s, "submit_for_review", { versionId: "v1" });
  await s.close();
  assert.ok(!r.isError, r.text);
  assert.equal(r.data.reviewSubmissionId, "s0");
  assert.match(dialogs(), /appEvent:ev1/);
  assert.match(dialogs(), /AUTOMATIC: goes live as soon as Apple approves/);
});
await test("cancel: only the submission that contains this version", async () => {
  resetLog();
  writeFileSync(join(tmp, "dialogs.log"), "");
  const s = await start({
    ASC_GROUPS: "release",
    FAKE_SCENARIO: "cancel",
    FAKE_Q: "0",
    FAKE_TEXT: "CANCEL My App 1.0.2",
  });
  const r = await call(s, "cancel_review_submission", { versionId: "v1" });
  await s.close();
  assert.ok(!r.isError, r.text);
  assert.deepEqual(
    r.data.map((x) => x.reviewSubmissionId),
    ["s1"],
  );
  assert.doesNotMatch(ascLog(), /PATCH \/v1\/reviewSubmissions\/s2/);
});
await test("attach_build: export compliance is set once, never overwritten", async () => {
  const s = await start();
  const a = await call(s, "attach_build", { versionId: "v1", buildId: "b1", usesNonExemptEncryption: false });
  const b = await call(s, "attach_build", { versionId: "v2", buildId: "b2", usesNonExemptEncryption: true });
  await s.close();
  assert.equal(a.data.usesNonExemptEncryption, "set to false");
  assert.ok(b.isError);
  assert.match(b.text, /does not allow changing it/);
});
await test("set_review_details: 5xx on read is an error, not a new record", async () => {
  resetLog();
  const s = await start({ FAKE_500: "/v1/appStoreVersions/v1/appStoreReviewDetail" });
  const r = await call(s, "set_review_details", { versionId: "v1", notes: "x" });
  await s.close();
  assert.ok(r.isError);
  assert.equal(posts("/v1/appStoreReviewDetails"), 0);
});
await test("config: bad timeout and missing ASC_FILES_ROOT stop the server", async () => {
  await assert.rejects(start({ ASC_CONFIRM_TIMEOUT: "abc" }));
  await assert.rejects(start({ ASC_FILES_ROOT: "" }));
});
await test("ASC_DEV=1 hot reload picks up a new tool file without restart", async () => {
  const copy = join(tmp, "pkgcopy");
  cpSync(join(pkg, "src"), join(copy, "src"), { recursive: true });
  cpSync(join(pkg, "bin"), join(copy, "bin"), { recursive: true });
  cpSync(join(pkg, "package.json"), join(copy, "package.json"));
  symlinkSync(join(pkg, "node_modules"), join(copy, "node_modules"));
  const s = await start({ ASC_DEV: "1" }, copy);
  assert.ok(!(await s.listTools()).tools.some((t) => t.name === "ping"));
  writeFileSync(
    join(copy, "src/tools/zz_ping.mjs"),
    `export default [{ name: "ping", group: "read", description: "ping", input: {}, run: async () => "pong" }];`,
  );
  await call(s, "list_apps");
  const has = (await s.listTools()).tools.some((t) => t.name === "ping");
  const r = has ? await call(s, "ping") : null;
  await s.close();
  assert.ok(has, "ping not registered");
  assert.equal(r.data, "pong");
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
