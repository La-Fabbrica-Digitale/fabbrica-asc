// App Store Connect client. Network goes only to API_HOST and https upload URLs on *.apple.com.
import { createPrivateKey, sign, createHash } from "node:crypto";
import { readFileSync, statSync, realpathSync, openSync, readSync, closeSync } from "node:fs";
import { resolve, sep, extname, basename } from "node:path";

export const API_HOST = "api.appstoreconnect.apple.com";
const UPLOAD_TIMEOUT_MS = 300_000;

// Builds the request URL and refuses paths that URL parsing would rewrite
// ("..", "%2e", "//", "\\"), so a checked path is exactly the path that is called.
export function apiUrl(path) {
  if (typeof path !== "string" || !/^\/v[123]\//.test(path)) throw new Error(`bad API path: ${path}`);
  const [pathname] = path.split("?");
  if (/\.\.|%2e|%2f|%5c|\/\/|\\/i.test(pathname))
    throw new Error(`refusing path with dot segments or encoded separators: ${path}`);
  const url = new URL(`https://${API_HOST}${path}`);
  if (url.hostname !== API_HOST || url.pathname !== pathname)
    throw new Error(`refusing path that normalizes differently: ${path}`);
  return url.href;
}

export const enc = encodeURIComponent;
export const rel = (type, id) => ({ data: { type, id } });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

const md5 = (buf) => createHash("md5").update(buf).digest("hex");
const b64u = (b) => Buffer.from(b).toString("base64url");
const isAppleHost = (h) => h === "apple.com" || h.endsWith(".apple.com");

export function createClient(cfg) {
  const API_TIMEOUT_MS = (cfg.httpTimeoutSec ?? 60) * 1000;
  let key = null;
  let token = { value: null, exp: 0 };

  function jwt() {
    const now = Math.floor(Date.now() / 1000);
    if (token.value && token.exp - 60 > now) return token.value;
    key ??= createPrivateKey(readFileSync(cfg.p8Path, "utf8"));
    const exp = now + 15 * 60; // Apple allows at most 20 min
    const head = b64u(JSON.stringify({ alg: "ES256", kid: cfg.keyId, typ: "JWT" }));
    const body = b64u(JSON.stringify({ iss: cfg.issuerId, iat: now, exp, aud: "appstoreconnect-v1" }));
    const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
    token = { value: `${head}.${body}.${b64u(sig)}`, exp };
    return token.value;
  }

  // Retries: 429 for any method (Apple did not process it), 5xx and network errors for GET only.
  async function api(method, path, body) {
    if (cfg.readonly && method !== "GET") throw new Error("ASC_READONLY=1: write blocked");
    const url = apiUrl(path);
    let err;
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${jwt()}`, "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        });
      } catch (e) {
        err = new Error(
          `ASC ${method} ${path}: ${e.name === "TimeoutError" ? `no response in ${API_TIMEOUT_MS / 1000} s` : e.message}`,
        );
        if (method !== "GET") throw err;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 204) return null;
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      if (res.ok) return json;
      const detail = json?.errors?.map((e) => `${e.code}: ${e.detail ?? e.title}`).join("; ") ?? text.slice(0, 500);
      err = Object.assign(new Error(`ASC ${res.status} ${method} ${path}: ${detail}`), {
        status: res.status,
        errors: json?.errors ?? [],
      });
      const retry = res.status === 429 || (res.status >= 500 && method === "GET");
      if (!retry) throw err;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
    }
    throw err;
  }

  async function getAll(path, maxPages = 50) {
    let r = await api("GET", path);
    const data = [...(r?.data ?? [])],
      included = [...(r?.included ?? [])];
    let pages = 1;
    for (; r?.links?.next && pages < maxPages; pages++) {
      const u = new URL(r.links.next);
      if (u.hostname !== API_HOST) throw new Error(`refusing pagination to ${u.hostname}`);
      r = await api("GET", u.pathname + u.search);
      data.push(...(r?.data ?? []));
      included.push(...(r?.included ?? []));
    }
    return { data, included, pages, truncated: Boolean(r?.links?.next) };
  }

  // Resolves symlinks, then requires the path to be inside ASC_FILES_ROOT (if set).
  function insideRoot(p) {
    const real = realpathSync(resolve(p));
    if (!cfg.filesRoot) return real;
    const root = realpathSync(resolve(cfg.filesRoot));
    if (real !== root && !real.startsWith(root + sep)) throw new Error(`outside ASC_FILES_ROOT: ${p}`);
    return real;
  }
  function checkFile(p, exts) {
    const real = insideRoot(p);
    if (!statSync(real).isFile()) throw new Error(`not a file: ${p}`);
    if (exts && !exts.includes(extname(real).toLowerCase()))
      throw new Error(`unsupported file type ${extname(real)}: ${p}`);
    return real;
  }
  function checkDir(p) {
    const real = insideRoot(p);
    if (!statSync(real).isDirectory()) throw new Error(`not a folder: ${p}`);
    return real;
  }

  async function putChunks(ops, buf, label) {
    for (const op of ops ?? []) {
      const url = new URL(op.url);
      if (url.protocol !== "https:" || !isAppleHost(url.hostname))
        throw new Error(`refusing upload to non-Apple host: ${url.hostname}`);
      const headers = Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value]));
      let last;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(op.url, {
            method: op.method,
            headers,
            body: buf.subarray(op.offset, op.offset + op.length),
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          });
          if (res.ok) {
            last = null;
            break;
          }
          last = `HTTP ${res.status}`;
        } catch (e) {
          last = e.message;
        }
        await sleep(1000 * 2 ** attempt);
      }
      if (last) throw new Error(`upload chunk failed (${last}) for ${label}`);
    }
  }

  // Apple upload protocol: reserve → PUT chunks → commit with MD5.
  async function uploadAsset(type, path, relationships, attrs = {}) {
    const buf = readFileSync(path);
    const fileName = basename(path);
    const r = await api("POST", `/v1/${type}`, {
      data: { type, attributes: { fileName, fileSize: buf.length, ...attrs }, relationships },
    });
    const id = r.data.id;
    try {
      await putChunks(r.data.attributes.uploadOperations, buf, fileName);
      const commit = (attributes) => api("PATCH", `/v1/${type}/${enc(id)}`, { data: { type, id, attributes } });
      try {
        await commit({ uploaded: true, sourceFileChecksum: md5(buf) });
      } catch (e) {
        // Asset Library images may reject sourceFileChecksum; only they get a commit without it.
        if (type !== "appAssetLibraryImages" || !(e.status >= 400 && e.status < 500)) throw e;
        await commit({ uploaded: true });
      }
    } catch (e) {
      await tryDelete(type, id); // don't leave a reserved, empty asset in the slot
      throw e;
    }
    return { id, fileName };
  }

  // Polls assetDeliveryState until every id is COMPLETE or FAILED, or the timeout passes.
  async function waitDelivered(type, ids, timeoutSec) {
    const done = (s) => s === "COMPLETE" || s === "FAILED";
    const out = Object.fromEntries(ids.map((id) => [id, { state: null }]));
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      for (const id of ids) {
        if (done(out[id].state)) continue;
        const ds = (await api("GET", `/v1/${type}/${enc(id)}`)).data.attributes.assetDeliveryState ?? {};
        out[id] = ds.errors?.length ? { state: ds.state, errors: ds.errors } : { state: ds.state ?? null };
      }
      if (ids.every((id) => done(out[id].state)) || Date.now() > deadline) return out;
      await sleep(4000);
    }
  }

  async function versionLocalization(versionId, locale) {
    const r = await getAll(`/v1/appStoreVersions/${enc(versionId)}/appStoreVersionLocalizations?limit=200`);
    return r.data.find((l) => l.attributes.locale === locale) ?? null;
  }

  // The appInfo that is not live yet, else the only one.
  async function editableAppInfo(appId) {
    const r = await api("GET", `/v1/apps/${enc(appId)}/appInfos`);
    const live = new Set(["READY_FOR_DISTRIBUTION", "READY_FOR_SALE", "ACCEPTED", "REPLACED_WITH_NEW_INFO"]);
    const info = r.data.find((i) => !live.has(i.attributes.state ?? i.attributes.appStoreState)) ?? r.data[0];
    if (!info) throw new Error(`app ${appId} has no appInfo`);
    return info;
  }

  // Facts shown in confirmation dialogs.
  async function versionSummary(versionId) {
    const v = (await api("GET", `/v1/appStoreVersions/${enc(versionId)}`)).data;
    const appId = v.relationships.app.data.id;
    const appName = (await api("GET", `/v1/apps/${enc(appId)}?fields[apps]=name`)).data.attributes.name;
    return {
      versionId,
      appId,
      appName,
      versionString: v.attributes.versionString,
      platform: v.attributes.platform,
      state: v.attributes.appStoreState ?? v.attributes.appVersionState,
      releaseType: v.attributes.releaseType ?? null,
      earliestReleaseDate: v.attributes.earliestReleaseDate ?? null,
      buildId: v.relationships?.build?.data?.id ?? null,
    };
  }

  // For cleanup paths: a failed DELETE must not hide the original error.
  async function tryDelete(type, id) {
    try {
      await api("DELETE", `/v1/${type}/${enc(id)}`);
      return true;
    } catch {
      return false;
    }
  }

  return {
    api,
    getAll,
    tryDelete,
    checkFile,
    checkDir,
    uploadAsset,
    waitDelivered,
    versionLocalization,
    editableAppInfo,
    versionSummary,
  };
}

// Width, height and alpha of a PNG or JPEG, read from the header.
export function imageSize(path) {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(32);
    readSync(fd, head, 0, 32, 0);
    if (head.readUInt32BE(0) === 0x89504e47) {
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), alpha: head[25] === 4 || head[25] === 6 };
    }
    if (head[0] === 0xff && head[1] === 0xd8) {
      const buf = Buffer.alloc(Math.min(statSync(path).size, 1 << 20));
      readSync(fd, buf, 0, buf.length, 0);
      for (let i = 2; i < buf.length - 9;) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), alpha: false };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

// Portrait sizes per display type; landscape is the same pair swapped.
// Not verified against Apple's current spec: a mismatch fails locally, an unknown type only warns.
export const SCREENSHOT_SIZES = {
  APP_IPHONE_67: [
    [1320, 2868],
    [1290, 2796],
    [1260, 2736],
  ],
  APP_IPHONE_65: [
    [1242, 2688],
    [1284, 2778],
  ],
  APP_IPHONE_61: [
    [1206, 2622],
    [1179, 2556],
    [1170, 2532],
  ],
  APP_IPHONE_58: [
    [1125, 2436],
    [1080, 2340],
    [1170, 2532],
  ],
  APP_IPHONE_55: [[1242, 2208]],
  APP_IPHONE_47: [[750, 1334]],
  APP_IPAD_PRO_3GEN_129: [
    [2064, 2752],
    [2048, 2732],
  ],
  APP_IPAD_PRO_129: [[2048, 2732]],
  APP_IPAD_PRO_3GEN_11: [
    [1668, 2420],
    [1668, 2388],
    [1640, 2360],
    [1488, 2266],
  ],
  APP_IPAD_105: [[1668, 2224]],
  APP_IPAD_97: [[1536, 2048]],
};
export const SCREENSHOT_EXT = [".png", ".jpg", ".jpeg"];
export const PREVIEW_EXT = [".mp4", ".mov", ".m4v"];

export function checkScreenshot(path, displayType) {
  const s = imageSize(path);
  if (!s) return { ok: false, issues: ["cannot read image size"] };
  const size = `${s.width}x${s.height}`;
  const sizes = SCREENSHOT_SIZES[displayType];
  const issues = [];
  if (!sizes) issues.push(`warning: no size table for ${displayType}`);
  else if (!sizes.some(([w, h]) => (s.width === w && s.height === h) || (s.width === h && s.height === w)))
    return {
      ok: false,
      size,
      issues: [
        `${size} not accepted for ${displayType}; expected ${sizes.map(([w, h]) => `${w}x${h}`).join(" / ")} or landscape`,
      ],
    };
  if (s.alpha) issues.push("warning: PNG has an alpha channel; App Store may reject it");
  return { ok: true, size, issues };
}
