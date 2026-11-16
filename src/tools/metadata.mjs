import { z } from "zod";
import { enc, rel, pick } from "../asc.mjs";

const PLATFORM = z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS");

export default [
  {
    name: "create_version",
    group: "metadata",
    description: "Create a new App Store version. Does not submit.",
    input: { appId: z.string(), versionString: z.string(), platform: PLATFORM, copyright: z.string().optional() },
    run: async ({ appId, versionString, platform, copyright }, { api }) => {
      const attributes = { platform, versionString, ...(copyright ? { copyright } : {}) };
      const r = await api("POST", "/v1/appStoreVersions", {
        data: { type: "appStoreVersions", attributes, relationships: { app: rel("apps", appId) } },
      });
      return { id: r.data.id, ...r.data.attributes };
    },
  },
  {
    name: "update_version",
    group: "metadata",
    description:
      "Update version attributes: versionString, copyright, releaseType, earliestReleaseDate (ISO, for SCHEDULED). releaseType AFTER_APPROVAL puts the version live automatically once Apple approves it; MANUAL waits for release_version.",
    input: {
      versionId: z.string(),
      versionString: z.string().optional(),
      copyright: z.string().optional(),
      releaseType: z.enum(["MANUAL", "AFTER_APPROVAL", "SCHEDULED"]).optional(),
      earliestReleaseDate: z.string().optional(),
    },
    run: async (a, { api }) => {
      const attributes = pick(a, ["versionString", "copyright", "releaseType", "earliestReleaseDate"]);
      const r = await api("PATCH", `/v1/appStoreVersions/${enc(a.versionId)}`, {
        data: { type: "appStoreVersions", id: a.versionId, attributes },
      });
      return {
        id: r.data.id,
        ...pick(r.data.attributes, [
          "versionString",
          "copyright",
          "releaseType",
          "earliestReleaseDate",
          "appStoreState",
        ]),
      };
    },
  },
  {
    name: "set_version_texts",
    group: "metadata",
    description:
      "Create or update version texts for one locale. Only passed fields change. Limits: description 4000, keywords 100 (comma-separated), whatsNew 4000, promotionalText 170.",
    input: {
      versionId: z.string(),
      locale: z.string().describe("e.g. en-US, ru, fr-FR"),
      description: z.string().max(4000).optional(),
      keywords: z.string().max(100).optional(),
      whatsNew: z.string().max(4000).optional(),
      promotionalText: z.string().max(170).optional(),
      marketingUrl: z.string().url().optional(),
      supportUrl: z.string().url().optional(),
    },
    run: async (a, { api, versionLocalization }) => {
      const attrs = pick(a, ["description", "keywords", "whatsNew", "promotionalText", "marketingUrl", "supportUrl"]);
      const loc = await versionLocalization(a.versionId, a.locale);
      const before = loc ? pick(loc.attributes, Object.keys(attrs)) : null;
      const r = loc
        ? await api("PATCH", `/v1/appStoreVersionLocalizations/${enc(loc.id)}`, {
            data: { type: "appStoreVersionLocalizations", id: loc.id, attributes: attrs },
          })
        : await api("POST", "/v1/appStoreVersionLocalizations", {
            data: {
              type: "appStoreVersionLocalizations",
              attributes: { locale: a.locale, ...attrs },
              relationships: { appStoreVersion: rel("appStoreVersions", a.versionId) },
            },
          });
      return {
        id: r.data.id,
        locale: a.locale,
        created: !loc,
        before,
        after: pick(r.data.attributes, Object.keys(attrs)),
      };
    },
  },
  {
    name: "set_app_info_texts",
    group: "metadata",
    description: "Create or update app name (max 30), subtitle (max 30), privacy policy URL for one locale.",
    input: {
      appId: z.string(),
      locale: z.string(),
      name: z.string().max(30).optional(),
      subtitle: z.string().max(30).optional(),
      privacyPolicyUrl: z.string().url().optional(),
    },
    run: async (a, { api, getAll, editableAppInfo }) => {
      const attrs = pick(a, ["name", "subtitle", "privacyPolicyUrl"]);
      const info = await editableAppInfo(a.appId);
      const list = await getAll(`/v1/appInfos/${enc(info.id)}/appInfoLocalizations?limit=200`);
      const loc = list.data.find((l) => l.attributes.locale === a.locale);
      const before = loc ? pick(loc.attributes, Object.keys(attrs)) : null;
      const r = loc
        ? await api("PATCH", `/v1/appInfoLocalizations/${enc(loc.id)}`, {
            data: { type: "appInfoLocalizations", id: loc.id, attributes: attrs },
          })
        : await api("POST", "/v1/appInfoLocalizations", {
            data: {
              type: "appInfoLocalizations",
              attributes: { locale: a.locale, ...attrs },
              relationships: { appInfo: rel("appInfos", info.id) },
            },
          });
      return {
        id: r.data.id,
        locale: a.locale,
        created: !loc,
        before,
        after: pick(r.data.attributes, Object.keys(attrs)),
      };
    },
  },
  {
    name: "set_categories",
    group: "metadata",
    description:
      "Set primary/secondary category and game subcategories, e.g. GAMES, GAMES_CASUAL, ENTERTAINMENT, PHOTO_AND_VIDEO.",
    input: {
      appId: z.string(),
      primary: z.string(),
      primarySub1: z.string().optional(),
      primarySub2: z.string().optional(),
      secondary: z.string().optional(),
    },
    run: async ({ appId, primary, primarySub1, primarySub2, secondary }, { api, editableAppInfo }) => {
      const info = await editableAppInfo(appId);
      const relationships = { primaryCategory: rel("appCategories", primary) };
      if (primarySub1) relationships.primarySubcategoryOne = rel("appCategories", primarySub1);
      if (primarySub2) relationships.primarySubcategoryTwo = rel("appCategories", primarySub2);
      if (secondary) relationships.secondaryCategory = rel("appCategories", secondary);
      await api("PATCH", `/v1/appInfos/${enc(info.id)}`, { data: { type: "appInfos", id: info.id, relationships } });
      return { appInfoId: info.id, primary, primarySub1, primarySub2, secondary };
    },
  },
  {
    name: "attach_build",
    group: "metadata",
    description:
      "Attach a processed build to a version. usesNonExemptEncryption (export compliance) is set only when passed and only if the build has no answer yet: Apple does not let you change it later. false = the app uses only exempt encryption such as HTTPS.",
    input: { versionId: z.string(), buildId: z.string(), usesNonExemptEncryption: z.boolean().optional() },
    run: async ({ versionId, buildId, usesNonExemptEncryption }, { api }) => {
      let encryption = "not changed";
      if (usesNonExemptEncryption !== undefined) {
        const cur = (await api("GET", `/v1/builds/${enc(buildId)}?fields[builds]=usesNonExemptEncryption`)).data
          .attributes.usesNonExemptEncryption;
        if (cur === undefined || cur === null) {
          await api("PATCH", `/v1/builds/${enc(buildId)}`, {
            data: { type: "builds", id: buildId, attributes: { usesNonExemptEncryption } },
          });
          encryption = `set to ${usesNonExemptEncryption}`;
        } else if (cur !== usesNonExemptEncryption) {
          throw new Error(
            `build ${buildId} already has usesNonExemptEncryption=${cur}; Apple does not allow changing it. Nothing attached.`,
          );
        } else encryption = `already ${cur}`;
      }
      await api("PATCH", `/v1/appStoreVersions/${enc(versionId)}/relationships/build`, rel("builds", buildId));
      return { versionId, buildId, attached: true, usesNonExemptEncryption: encryption };
    },
  },
  {
    name: "set_review_details",
    group: "metadata",
    description: "Create or update App Review info: contact, demo account, notes. The password is never returned.",
    input: {
      versionId: z.string(),
      contactFirstName: z.string().optional(),
      contactLastName: z.string().optional(),
      contactPhone: z.string().optional(),
      contactEmail: z.string().optional(),
      demoAccountRequired: z.boolean().optional(),
      demoAccountName: z.string().optional(),
      demoAccountPassword: z.string().optional(),
      notes: z.string().max(4000).optional(),
    },
    run: async (a, { api }) => {
      const attrs = pick(a, [
        "contactFirstName",
        "contactLastName",
        "contactPhone",
        "contactEmail",
        "demoAccountRequired",
        "demoAccountName",
        "demoAccountPassword",
        "notes",
      ]);
      let cur = null;
      try {
        cur = (await api("GET", `/v1/appStoreVersions/${enc(a.versionId)}/appStoreReviewDetail`)).data;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      const r = cur
        ? await api("PATCH", `/v1/appStoreReviewDetails/${enc(cur.id)}`, {
            data: { type: "appStoreReviewDetails", id: cur.id, attributes: attrs },
          })
        : await api("POST", "/v1/appStoreReviewDetails", {
            data: {
              type: "appStoreReviewDetails",
              attributes: attrs,
              relationships: { appStoreVersion: rel("appStoreVersions", a.versionId) },
            },
          });
      const { demoAccountPassword: _hidden, ...shown } = r.data.attributes;
      return { id: r.data.id, ...shown };
    },
  },
];
