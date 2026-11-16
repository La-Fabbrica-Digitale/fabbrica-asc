import { z } from "zod";
import { readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, extname, basename } from "node:path";
import { enc, rel, sleep, checkScreenshot, SCREENSHOT_EXT, PREVIEW_EXT, SCREENSHOT_SIZES } from "../asc.mjs";

// Screenshots and previews differ only in resource names, limits and file types.
const KINDS = {
  screenshots: {
    set: "appScreenshotSets",
    item: "appScreenshots",
    typeAttr: "screenshotDisplayType",
    max: 10,
    ext: SCREENSHOT_EXT,
    waitSec: 180,
    attrs: () => ({}),
  },
  previews: {
    set: "appPreviewSets",
    item: "appPreviews",
    typeAttr: "previewType",
    max: 3,
    ext: PREVIEW_EXT,
    waitSec: 300,
    attrs: (p) => ({ mimeType: extname(p).toLowerCase() === ".mov" ? "video/quicktime" : "video/mp4" }),
  },
};
// Upload resources reachable only through upload_file.
const UPLOAD_TYPES = [
  "inAppPurchaseAppStoreReviewScreenshots",
  "subscriptionAppStoreReviewScreenshots",
  "inAppPurchaseImages",
  "subscriptionImages",
  "promotedPurchaseImages",
  "appStoreReviewAttachments",
  "appEventScreenshots",
  "appEventVideoClips",
  "routingAppCoverages",
  "gameCenterAchievementImages",
  "gameCenterLeaderboardImages",
  "gameCenterLeaderboardSetImages",
];
const UPLOAD_EXT = [...SCREENSHOT_EXT, ...PREVIEW_EXT, ".pdf", ".geojson", ".zip", ".txt"];
const kindOf = (slot) => (slot.startsWith("APP_") ? "screenshots" : "previews");

async function findSet(ctx, k, locId, slot) {
  const r = await ctx.api(
    "GET",
    `/v1/appStoreVersionLocalizations/${enc(locId)}/${k.set}?filter[${k.typeAttr}]=${enc(slot)}&include=${k.item}`,
  );
  const s = r.data[0];
  return s ? { id: s.id, existing: (s.relationships?.[k.item]?.data ?? []).map((x) => x.id) } : null;
}

// Keeps the slot filled: new files are uploaded and processed before old ones are deleted.
// Apple caps a slot at k.max items, so when old + new exceed it, only the overflow of old items goes first.
// On any upload or processing failure the new items are removed and the remaining old items stay.
async function uploadSlot(ctx, { kind, locId, slot, paths, replace, wait }) {
  const k = KINDS[kind];
  let set = await findSet(ctx, k, locId, slot);
  if (!set) {
    const r = await ctx.api("POST", `/v1/${k.set}`, {
      data: {
        type: k.set,
        attributes: { [k.typeAttr]: slot },
        relationships: { appStoreVersionLocalization: rel("appStoreVersionLocalizations", locId) },
      },
    });
    set = { id: r.data.id, existing: [] };
  }
  if (!replace && set.existing.length + paths.length > k.max)
    throw new Error(`${slot}: ${set.existing.length} existing + ${paths.length} new > ${k.max}; use replace=true`);

  const old = replace ? set.existing : [];
  const overflow = Math.max(0, old.length + paths.length - k.max);
  const removeFirst = old.slice(0, overflow);
  const removeAfter = old.slice(overflow);
  for (const id of removeFirst) await ctx.api("DELETE", `/v1/${k.item}/${enc(id)}`);

  const uploaded = [];
  let states = {};
  try {
    for (const p of paths)
      uploaded.push(await ctx.uploadAsset(k.item, p, { [k.set.slice(0, -1)]: rel(k.set, set.id) }, k.attrs(p)));
    if (wait || replace)
      states = await ctx.waitDelivered(
        k.item,
        uploaded.map((u) => u.id),
        k.waitSec,
      );
    const bad = uploaded.filter((u) => states[u.id] && states[u.id].state !== "COMPLETE");
    if (replace && bad.length)
      throw new Error(
        `${bad.length} new file(s) not COMPLETE: ${bad.map((u) => `${u.fileName}=${states[u.id].state}`).join(", ")}`,
      );
  } catch (e) {
    for (const u of uploaded) await ctx.tryDelete(k.item, u.id);
    throw new Error(
      `${slot}: ${e.message}. New files removed; ${removeAfter.length + (replace ? 0 : set.existing.length)} old file(s) kept${removeFirst.length ? `, ${removeFirst.length} removed earlier to fit the ${k.max} limit` : ""}.`,
    );
  }
  const notRemoved = [];
  for (const id of removeAfter) if (!(await ctx.tryDelete(k.item, id))) notRemoved.push(id);
  return {
    setId: set.id,
    slot,
    removed: old.length - notRemoved.length,
    ...(notRemoved.length ? { notRemoved } : {}),
    uploaded: uploaded.map((u) => ({ ...u, ...states[u.id] })),
  };
}

function validate(ctx, kind, slot, paths) {
  const k = KINDS[kind];
  const errors = [],
    warnings = [],
    files = [];
  if (!paths.length) errors.push("no files");
  if (paths.length > k.max) errors.push(`${paths.length} files > max ${k.max}`);
  if (kind === "screenshots" && !SCREENSHOT_SIZES[slot]) warnings.push(`unknown display type ${slot}`);
  for (const p of paths) {
    const name = basename(p);
    try {
      ctx.checkFile(p, k.ext);
    } catch (e) {
      errors.push(e.message);
      files.push({ file: name });
      continue;
    }
    if (kind === "previews") {
      files.push({ file: name, bytes: statSync(p).size });
      continue;
    }
    const c = checkScreenshot(p, slot);
    for (const i of c.issues) (i.startsWith("warning") ? warnings : errors).push(`${name}: ${i}`);
    files.push({ file: name, size: c.size });
  }
  return { files, errors, warnings };
}

// <root>/<locale>/<slot>/<files>; slot APP_* = screenshot display type, otherwise preview type.
function scanTree(ctx, root, locales) {
  const dir = ctx.checkDir(root);
  const entries = (p) =>
    readdirSync(p)
      .filter((n) => !n.startsWith("."))
      .sort()
      .map((n) => join(p, n));
  const dirs = (p) => entries(p).filter((f) => statSync(f).isDirectory());
  const out = [];
  for (const locDir of dirs(dir)) {
    const locale = basename(locDir);
    if (locales?.length && !locales.includes(locale)) continue;
    for (const slotDir of dirs(locDir)) {
      const slot = basename(slotDir);
      const kind = kindOf(slot);
      const files = entries(slotDir).filter((f) => statSync(f).isFile());
      const paths = files.filter((f) => KINDS[kind].ext.includes(extname(f).toLowerCase()));
      const ignored = files.filter((f) => !paths.includes(f)).map((f) => basename(f));
      out.push({ locale, slot, kind, paths, ignored });
    }
  }
  return out;
}

async function libraryImage(ctx, appId, path) {
  const lib = (await ctx.api("GET", `/v1/apps/${enc(appId)}/assetLibrary`)).data.id;
  const u = await ctx.uploadAsset(
    "appAssetLibraryImages",
    path,
    { assetLibrary: rel("appAssetLibraries", lib) },
    { category: "CREATIVE_ASSETS" },
  );
  for (let i = 0; i < 36; i++) {
    const state = (await ctx.api("GET", `/v1/appAssetLibraryImages/${enc(u.id)}`)).data.attributes.state;
    if (state === "PREPARE_FOR_SUBMISSION") return { ...u, state };
    if (!["AWAITING_UPLOAD", "UPLOAD_COMPLETE"].includes(state))
      throw new Error(`image ${u.id} failed: state=${state}`);
    await sleep(5000);
  }
  throw new Error(`image ${u.id} still processing after 180 s; check library_images`);
}

// Creates the new placement first and removes the old one after, so the slot is never empty.
// If Apple refuses two placements of one type (409), it falls back to delete-then-create.
async function placeImage(ctx, locId, placementType, imageId) {
  const cur = await ctx.api("GET", `/v1/appStoreVersionLocalizations/${enc(locId)}/placements`);
  const old = (cur.data ?? []).filter((p) => p.attributes?.placementType === placementType).map((p) => p.id);
  const replaced = old.length;
  const create = () =>
    ctx.api("POST", "/v1/appAssetLibraryPlacements", {
      data: {
        type: "appAssetLibraryPlacements",
        attributes: { placementType, placementGroup: "DEFAULT_PROFILE" },
        relationships: {
          appStoreVersionLocalization: rel("appStoreVersionLocalizations", locId),
          image: rel("appAssetLibraryImages", imageId),
        },
      },
    });
  let r;
  try {
    r = await create();
  } catch (e) {
    if (e.status !== 409 || !old.length) throw e;
    for (const id of old) await ctx.api("DELETE", `/v1/appAssetLibraryPlacements/${enc(id)}`);
    old.length = 0;
    r = await create();
  }
  for (const id of old) await ctx.tryDelete("appAssetLibraryPlacements", id);
  return { placementType, id: r.data.id, state: r.data.attributes?.state, replaced };
}

async function requireLocalization(ctx, versionId, locale) {
  const loc = await ctx.versionLocalization(versionId, locale);
  if (!loc) throw new Error(`no localization ${locale} on this version; create it with set_version_texts`);
  return loc;
}

export default [
  {
    name: "validate_assets",
    group: "read",
    description:
      "Local check of a folder tree <root>/<locale>/<slot>/files, no network. Slot = screenshot display type (APP_IPHONE_67, APP_IPAD_PRO_3GEN_129, …) or preview type (IPHONE_67, …). Reports sizes, counts, errors.",
    input: { root: z.string(), locales: z.array(z.string()).optional() },
    run: async ({ root, locales }, ctx) => {
      const items = scanTree(ctx, root, locales).map((it) => {
        const v = validate(ctx, it.kind, it.slot, it.paths);
        if (it.ignored.length) v.warnings.push(`ignored: ${it.ignored.join(", ")}`);
        return { locale: it.locale, slot: it.slot, kind: it.kind, ...v };
      });
      return { root, slots: items.length, errors: items.reduce((n, i) => n + i.errors.length, 0), items };
    },
  },
  {
    name: "upload_tree",
    group: "media",
    description:
      "Upload a folder tree <root>/<locale>/<slot>/files to a version. dryRun=true (default) returns the plan, validation and a planId. After the user approves, call again with dryRun=false and that planId. Uploads nothing if any slot has errors. Waits for Apple processing.",
    input: {
      versionId: z.string(),
      root: z.string(),
      locales: z.array(z.string()).optional().describe("only these locale folders"),
      dryRun: z.boolean().default(true),
      replace: z.boolean().default(false).describe("replace existing assets in each target slot"),
      planId: z.string().optional().describe("planId from the dry run; required when dryRun=false"),
      wait: z.boolean().default(true),
    },
    run: async ({ versionId, root, locales, dryRun, replace, planId, wait }, ctx) => {
      const items = scanTree(ctx, root, locales);
      if (!items.length) throw new Error(`no <locale>/<slot>/ folders under ${root}`);
      const locs = new Map();
      const plan = [];
      for (const it of items) {
        const v = validate(ctx, it.kind, it.slot, it.paths);
        if (it.ignored.length) v.warnings.push(`ignored: ${it.ignored.join(", ")}`);
        if (!locs.has(it.locale)) locs.set(it.locale, await ctx.versionLocalization(versionId, it.locale));
        const loc = locs.get(it.locale);
        if (!loc) v.errors.push(`no localization ${it.locale} on this version; create it with set_version_texts`);
        const existingIds = loc ? ((await findSet(ctx, KINDS[it.kind], loc.id, it.slot))?.existing ?? []) : [];
        plan.push({ ...it, locId: loc?.id, existing: existingIds.length, existingIds, ...v });
      }
      const view = plan.map((p) => ({
        locale: p.locale,
        slot: p.slot,
        kind: p.kind,
        upload: p.files,
        replaceExisting: replace ? p.existing : 0,
        keepExisting: replace ? 0 : p.existing,
        errors: p.errors,
        warnings: p.warnings,
      }));
      const totals = {
        slots: plan.length,
        files: plan.reduce((n, p) => n + p.files.length, 0),
        toRemove: replace ? plan.reduce((n, p) => n + p.existing, 0) : 0,
        errors: plan.reduce((n, p) => n + p.errors.length, 0),
      };
      // Hash of everything the run would touch: any change to files, remote slots or options invalidates it.
      const id = createHash("sha256")
        .update(
          JSON.stringify({
            versionId,
            replace,
            slots: plan.map((p) => [
              p.locale,
              p.slot,
              p.existingIds,
              p.paths.map((f) => [f, statSync(f).size, statSync(f).mtimeMs]),
            ]),
          }),
        )
        .digest("hex")
        .slice(0, 16);
      if (dryRun) return { dryRun: true, planId: id, totals, plan: view };
      if (totals.errors)
        return { dryRun: false, executed: false, reason: "validation errors, nothing uploaded", totals, plan: view };
      if (planId !== id)
        return {
          dryRun: false,
          executed: false,
          reason: planId
            ? "plan changed since the dry run; run the dry run again"
            : "planId missing; run the dry run first and pass its planId",
          totals,
        };

      const results = [];
      for (const p of plan) {
        try {
          const r = await uploadSlot(ctx, {
            kind: p.kind,
            locId: p.locId,
            slot: p.slot,
            paths: p.paths,
            replace,
            wait,
          });
          results.push({ locale: p.locale, ok: r.uploaded.every((u) => !u.state || u.state === "COMPLETE"), ...r });
        } catch (e) {
          results.push({ locale: p.locale, slot: p.slot, ok: false, error: e.message });
        }
      }
      return {
        dryRun: false,
        totals,
        ok: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      };
    },
  },
  {
    name: "upload_screenshots",
    group: "media",
    description:
      "Upload PNG/JPG screenshots in order to one version + locale + display type. Checks sizes first. replace=true swaps the slot contents: new files are uploaded and processed before old ones are removed. Max 10.",
    input: {
      versionId: z.string(),
      locale: z.string(),
      displayType: z.string(),
      files: z.array(z.string()).min(1).max(KINDS.screenshots.max).describe("absolute paths, in display order"),
      replace: z.boolean().default(false),
      wait: z.boolean().default(true),
    },
    run: async ({ versionId, locale, displayType, files, replace, wait }, ctx) => {
      const v = validate(ctx, "screenshots", displayType, files);
      if (v.errors.length) throw new Error(v.errors.join("\n"));
      const loc = await requireLocalization(ctx, versionId, locale);
      return uploadSlot(ctx, {
        kind: "screenshots",
        locId: loc.id,
        slot: displayType,
        paths: files.map((f) => ctx.checkFile(f)),
        replace,
        wait,
      });
    },
  },
  {
    name: "upload_previews",
    group: "media",
    description:
      "Upload up to 3 preview videos (.mp4/.mov) in order to one version + locale + preview type (IPHONE_67, IPHONE_65, IPAD_PRO_3GEN_129, …). replace=true swaps them after the new ones are processed.",
    input: {
      versionId: z.string(),
      locale: z.string(),
      previewType: z.string(),
      files: z.array(z.string()).min(1).max(KINDS.previews.max),
      replace: z.boolean().default(false),
      posterFrameTimeCode: z.string().optional().describe("e.g. 00:00:05:00"),
      wait: z.boolean().default(true),
    },
    run: async ({ versionId, locale, previewType, files, replace, posterFrameTimeCode, wait }, ctx) => {
      const paths = files.map((f) => ctx.checkFile(f, PREVIEW_EXT));
      const loc = await requireLocalization(ctx, versionId, locale);
      const r = await uploadSlot(ctx, { kind: "previews", locId: loc.id, slot: previewType, paths, replace, wait });
      if (posterFrameTimeCode)
        for (const u of r.uploaded)
          await ctx.api("PATCH", `/v1/appPreviews/${enc(u.id)}`, {
            data: { type: "appPreviews", id: u.id, attributes: { previewFrameTimeCode: posterFrameTimeCode } },
          });
      return r;
    },
  },
  {
    name: "upload_header_search",
    group: "media",
    description:
      "Upload the product page header image (21:9, 3840x1646) and/or the search results image (3:2, up to 3840x2560), or one 16:9 image for both, to a version + locale via the App Store Asset Library. Replaces existing placements of the same type.",
    input: {
      appId: z.string(),
      versionId: z.string(),
      locale: z.string(),
      headerFile: z.string().optional(),
      searchFile: z.string().optional(),
      universalFile: z.string().optional(),
    },
    run: async ({ appId, versionId, locale, headerFile, searchFile, universalFile }, ctx) => {
      const IMG = [".png", ".jpg", ".jpeg"];
      const jobs = universalFile
        ? [[universalFile, ["PRODUCT_PAGE_HEADER_ASSET", "APP_STORE_SEARCH_RESULTS_ASSET"]]]
        : [
            [headerFile, ["PRODUCT_PAGE_HEADER_ASSET"]],
            [searchFile, ["APP_STORE_SEARCH_RESULTS_ASSET"]],
          ].filter(([f]) => f);
      if (!jobs.length) throw new Error("pass headerFile, searchFile or universalFile");
      const paths = jobs.map(([f]) => ctx.checkFile(f, IMG));
      const loc = await requireLocalization(ctx, versionId, locale);
      const out = [];
      for (const [i, [, placements]] of jobs.entries()) {
        const image = await libraryImage(ctx, appId, paths[i]);
        const placed = [];
        for (const t of placements) placed.push(await placeImage(ctx, loc.id, t, image.id));
        out.push({ image, placements: placed });
      }
      return out;
    },
  },
  {
    name: "upload_file",
    group: "media",
    description:
      'Upload a file to an Apple upload resource that has no dedicated tool: IAP and subscription review screenshots, review attachments, app event media, Game Center images. relationships is the JSON:API relationships object of the create call, e.g. { inAppPurchaseV2: { data: { type: "inAppPurchases", id } } }. Waits for processing.',
    input: {
      type: z.enum(UPLOAD_TYPES),
      file: z.string(),
      relationships: z.record(z.string(), z.any()),
      attributes: z
        .record(z.string(), z.any())
        .optional()
        .describe('extra create attributes, e.g. { mimeType: "video/mp4" }'),
      waitSec: z.number().int().min(0).max(300).default(120),
    },
    run: async ({ type, file, relationships, attributes, waitSec }, ctx) => {
      const u = await ctx.uploadAsset(type, ctx.checkFile(file, UPLOAD_EXT), relationships, attributes);
      const states = waitSec ? await ctx.waitDelivered(type, [u.id], waitSec) : {};
      return { type, ...u, ...states[u.id] };
    },
  },
];
