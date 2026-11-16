// Preloaded with `node --import ./test/mock-fetch.mjs`: replaces global fetch with a fake App Store Connect.
// Production code has no test hooks; the fake lives only here. Controls (env):
//   FAKE_ASC_LOG       file to append "METHOD path" lines to
//   FAKE_SCENARIO      draft  = app has a READY_FOR_REVIEW submission with another item (appEvent:ev1)
//                      cancel = submission s1 (WAITING_FOR_REVIEW) has v1, submission s2 (READY_FOR_REVIEW) has v2
//   FAKE_FAIL_PUT      fail every upload PUT from the Nth (1-based) with HTTP 500
//   FAKE_500           path that always answers 500 (any method)
//   FAKE_HANG          path that never answers (until the request is aborted)
import { appendFileSync } from "node:fs";

const env = process.env;
const LOG = env.FAKE_ASC_LOG;
const db = {
  apps: { app1: { name: "My App", bundleId: "com.example.myapp", sku: "MYAPP", primaryLocale: "en-US" } },
  versions: {
    v1: {
      app: "app1",
      versionString: "1.0.2",
      platform: "IOS",
      appStoreState: "PREPARE_FOR_SUBMISSION",
      releaseType: "AFTER_APPROVAL",
      build: "b1",
    },
    v2: {
      app: "app1",
      versionString: "1.0.3",
      platform: "IOS",
      appStoreState: "PREPARE_FOR_SUBMISSION",
      releaseType: "MANUAL",
      build: "b2",
    },
  },
  builds: { b1: { usesNonExemptEncryption: null }, b2: { usesNonExemptEncryption: false } },
  locs: { l1: { version: "v1", locale: "en-US", description: "d", keywords: "k", supportUrl: "https://x.y" } },
  sets: {},
  shots: {},
  subs: {},
  items: {},
};
if (env.FAKE_SCENARIO === "draft") {
  db.subs.s0 = { app: "app1", state: "READY_FOR_REVIEW", platform: "IOS" };
  db.items.i0 = { sub: "s0", rel: "appEvent", id: "ev1" };
}
if (env.FAKE_SCENARIO === "cancel") {
  db.subs.s1 = { app: "app1", state: "WAITING_FOR_REVIEW", platform: "IOS" };
  db.subs.s2 = { app: "app1", state: "READY_FOR_REVIEW", platform: "IOS" };
  db.items.i1 = { sub: "s1", rel: "appStoreVersion", id: "v1" };
  db.items.i2 = { sub: "s2", rel: "appStoreVersion", id: "v2" };
}
let seq = 0;
let puts = 0;
const id = (p) => `${p}${++seq}`;
const res = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const noContent = () => new Response(null, { status: 204 });
const log = (line) => LOG && appendFileSync(LOG, line + "\n");
const uploadOps = (i, size) => [
  { method: "PUT", url: `https://store-upload.apple.com/fake/${i}`, offset: 0, length: size, requestHeaders: [] },
];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const m = (init.method ?? "GET").toUpperCase();
  log(`${m} ${url.pathname}${url.search}`);

  if (env.FAKE_HANG && url.pathname === env.FAKE_HANG)
    return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason)));
  if (env.FAKE_500 && url.pathname === env.FAKE_500) return res(500, { errors: [{ code: "UNEXPECTED_ERROR" }] });

  if (url.hostname === "store-upload.apple.com") {
    puts++;
    return new Response(null, { status: env.FAKE_FAIL_PUT && puts >= Number(env.FAKE_FAIL_PUT) ? 500 : 200 });
  }
  if (url.hostname !== "api.appstoreconnect.apple.com") throw new Error(`fake: unexpected host ${url.hostname}`);
  if (!String(init.headers?.Authorization ?? "").startsWith("Bearer ey"))
    return res(401, { errors: [{ code: "NOT_AUTHORIZED" }] });

  const p = url.pathname;
  const q = url.searchParams;
  const body = init.body ? JSON.parse(init.body) : null;
  let mm;

  // apps, versions, builds
  if (m === "GET" && p === "/v1/apps")
    return res(200, { data: Object.entries(db.apps).map(([i, a]) => ({ id: i, type: "apps", attributes: a })) });
  if (m === "GET" && (mm = p.match(/^\/v1\/apps\/([^/]+)$/)))
    return res(200, { data: { id: mm[1], type: "apps", attributes: db.apps[mm[1]] } });
  if (m === "GET" && (mm = p.match(/^\/v1\/appStoreVersions\/([^/]+)$/))) {
    const v = db.versions[mm[1]];
    return res(200, {
      data: {
        id: mm[1],
        type: "appStoreVersions",
        attributes: v,
        relationships: {
          app: { data: { type: "apps", id: v.app } },
          build: { data: v.build ? { type: "builds", id: v.build } : null },
        },
      },
    });
  }
  if ((mm = p.match(/^\/v1\/builds\/([^/]+)$/))) {
    if (m === "GET") return res(200, { data: { id: mm[1], type: "builds", attributes: db.builds[mm[1]] } });
    if (m === "PATCH") {
      Object.assign(db.builds[mm[1]], body.data.attributes);
      return res(200, { data: { id: mm[1], type: "builds", attributes: db.builds[mm[1]] } });
    }
  }
  if (m === "PATCH" && (mm = p.match(/^\/v1\/appStoreVersions\/([^/]+)\/relationships\/build$/))) {
    db.versions[mm[1]].build = body.data.id;
    return noContent();
  }
  if (m === "GET" && (mm = p.match(/^\/v1\/appStoreVersions\/([^/]+)\/appStoreReviewDetail$/)))
    return res(404, { errors: [{ code: "NOT_FOUND" }] });
  if (m === "POST" && p === "/v1/appStoreReviewDetails")
    return res(201, { data: { id: id("rd"), type: "appStoreReviewDetails", attributes: body.data.attributes } });

  // localizations, screenshot sets, screenshots
  if (m === "GET" && (mm = p.match(/^\/v1\/appStoreVersions\/([^/]+)\/appStoreVersionLocalizations$/)))
    return res(200, {
      data: Object.entries(db.locs)
        .filter(([, l]) => l.version === mm[1])
        .map(([i, l]) => ({ id: i, type: "appStoreVersionLocalizations", attributes: l })),
    });
  if (m === "GET" && (mm = p.match(/^\/v1\/appStoreVersionLocalizations\/([^/]+)\/appScreenshotSets$/))) {
    const t = q.get("filter[screenshotDisplayType]");
    const sets = Object.entries(db.sets).filter(([, s]) => s.loc === mm[1] && (!t || s.type === t));
    const shots = Object.entries(db.shots).filter(([, s]) => sets.some(([sid]) => sid === s.set));
    return res(200, {
      data: sets.map(([i, s]) => ({
        id: i,
        type: "appScreenshotSets",
        attributes: { screenshotDisplayType: s.type },
        relationships: {
          appScreenshots: {
            data: shots.filter(([, x]) => x.set === i).map(([sid]) => ({ type: "appScreenshots", id: sid })),
          },
        },
      })),
      included: shots.map(([sid, s]) => ({
        id: sid,
        type: "appScreenshots",
        attributes: { fileName: s.fileName, assetDeliveryState: { state: s.state } },
      })),
    });
  }
  if (m === "POST" && p === "/v1/appScreenshotSets") {
    const i = id("set");
    db.sets[i] = {
      loc: body.data.relationships.appStoreVersionLocalization.data.id,
      type: body.data.attributes.screenshotDisplayType,
    };
    return res(201, {
      data: { id: i, type: "appScreenshotSets", attributes: { screenshotDisplayType: db.sets[i].type } },
    });
  }
  // Generic upload resources: screenshots and IAP review screenshots.
  if ((mm = p.match(/^\/v1\/(appScreenshots|inAppPurchaseAppStoreReviewScreenshots)(?:\/([^/]+))?$/))) {
    const [, type, rid] = mm;
    if (m === "POST") {
      const i = id(type === "appScreenshots" ? "shot" : "iaps");
      db.shots[i] = {
        set: body.data.relationships.appScreenshotSet?.data.id,
        fileName: body.data.attributes.fileName,
        state: "AWAITING_UPLOAD",
        type,
      };
      return res(201, {
        data: {
          id: i,
          type,
          attributes: { ...body.data.attributes, uploadOperations: uploadOps(i, body.data.attributes.fileSize) },
        },
      });
    }
    if (m === "PATCH") {
      db.shots[rid].state = "COMPLETE";
      return res(200, { data: { id: rid, type, attributes: {} } });
    }
    if (m === "GET")
      return res(200, {
        data: {
          id: rid,
          type,
          attributes: { fileName: db.shots[rid].fileName, assetDeliveryState: { state: db.shots[rid].state } },
        },
      });
    if (m === "DELETE") {
      delete db.shots[rid];
      return noContent();
    }
  }

  // review submissions
  if (m === "GET" && p === "/v1/reviewSubmissions") {
    const states = (q.get("filter[state]") ?? "").split(",");
    const list = Object.entries(db.subs).filter(([, s]) => s.app === q.get("filter[app]") && states.includes(s.state));
    return res(200, {
      data: list.map(([i, s]) => ({
        id: i,
        type: "reviewSubmissions",
        attributes: { state: s.state, platform: s.platform },
      })),
    });
  }
  if (m === "GET" && (mm = p.match(/^\/v1\/reviewSubmissions\/([^/]+)\/items$/)))
    return res(200, {
      data: Object.entries(db.items)
        .filter(([, it]) => it.sub === mm[1])
        .map(([i, it]) => ({
          id: i,
          type: "reviewSubmissionItems",
          relationships: { [it.rel]: { data: { type: it.rel + "s", id: it.id } } },
        })),
    });
  if (m === "POST" && p === "/v1/reviewSubmissions") {
    const i = id("sub");
    db.subs[i] = {
      app: body.data.relationships.app.data.id,
      state: "READY_FOR_REVIEW",
      platform: body.data.attributes.platform,
    };
    return res(201, { data: { id: i, type: "reviewSubmissions", attributes: db.subs[i] } });
  }
  if (m === "POST" && p === "/v1/reviewSubmissionItems") {
    const i = id("item");
    db.items[i] = {
      sub: body.data.relationships.reviewSubmission.data.id,
      rel: "appStoreVersion",
      id: body.data.relationships.appStoreVersion.data.id,
    };
    return res(201, { data: { id: i, type: "reviewSubmissionItems", attributes: {} } });
  }
  if (m === "PATCH" && (mm = p.match(/^\/v1\/reviewSubmissions\/([^/]+)$/))) {
    const a = body.data.attributes;
    db.subs[mm[1]].state = a.canceled ? "CANCELING" : a.submitted ? "WAITING_FOR_REVIEW" : db.subs[mm[1]].state;
    return res(200, { data: { id: mm[1], type: "reviewSubmissions", attributes: db.subs[mm[1]] } });
  }

  return res(404, { errors: [{ code: "NOT_FOUND", detail: `fake has no ${m} ${p}` }] });
};
