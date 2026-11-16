import { z } from "zod";
import { enc } from "../asc.mjs";
import { GROUPS } from "../config.mjs";

// List result; when Apple has more pages than getAll reads, say so instead of cutting silently.
const rows = (r, map) =>
  r.truncated ? { truncated: true, note: "more items exist than were read", items: r.data.map(map) } : r.data.map(map);

export default [
  {
    name: "server_status",
    group: "read",
    description:
      "Server version, enabled groups, read-only flag, files root, last audit log entries. Call first if unsure what is allowed.",
    input: { auditEntries: z.number().int().min(0).max(100).default(10) },
    run: async ({ auditEntries }, { cfg, audit, version }) => ({
      version,
      readonly: cfg.readonly,
      filesRoot: cfg.filesRoot,
      groups: Object.fromEntries(
        Object.entries(GROUPS).map(([g, d]) => [
          g,
          { enabled: cfg.groups.has(g), dangerous: d.danger, title: d.title },
        ]),
      ),
      auditLog: cfg.auditLog,
      lastAudit: audit.tail(auditEntries),
    }),
  },
  {
    name: "list_apps",
    group: "read",
    description: "List apps (id, name, bundleId, sku, primaryLocale).",
    input: {},
    run: async (_, { getAll }) => {
      const r = await getAll("/v1/apps?fields[apps]=name,bundleId,sku,primaryLocale&limit=200");
      return rows(r, (a) => ({ id: a.id, ...a.attributes }));
    },
  },
  {
    name: "list_versions",
    group: "read",
    description: "List App Store versions of an app (id, versionString, platform, state).",
    input: { appId: z.string() },
    run: async ({ appId }, { getAll }) => {
      const r = await getAll(
        `/v1/apps/${enc(appId)}/appStoreVersions?fields[appStoreVersions]=versionString,platform,appStoreState,appVersionState,releaseType,createdDate&limit=200`,
      );
      return rows(r, (v) => ({ id: v.id, ...v.attributes }));
    },
  },
  {
    name: "get_version_texts",
    group: "read",
    description:
      "Per-locale version texts: description, keywords, whatsNew, promotionalText, marketingUrl, supportUrl.",
    input: { versionId: z.string() },
    run: async ({ versionId }, { getAll }) => {
      const r = await getAll(`/v1/appStoreVersions/${enc(versionId)}/appStoreVersionLocalizations?limit=200`);
      return rows(r, (l) => ({ id: l.id, ...l.attributes }));
    },
  },
  {
    name: "get_app_info_texts",
    group: "read",
    description: "Per-locale app name, subtitle, privacy policy URL from the editable appInfo.",
    input: { appId: z.string() },
    run: async ({ appId }, { editableAppInfo, getAll }) => {
      const info = await editableAppInfo(appId);
      const r = await getAll(`/v1/appInfos/${enc(info.id)}/appInfoLocalizations?limit=200`);
      return {
        appInfoId: info.id,
        state: info.attributes.state,
        localizations: r.data.map((l) => ({ id: l.id, ...l.attributes })),
      };
    },
  },
  {
    name: "list_screenshots",
    group: "read",
    description: "Screenshot sets and screenshots (id, fileName, delivery state, errors) for a version + locale.",
    input: { versionId: z.string(), locale: z.string() },
    run: async ({ versionId, locale }, { api, versionLocalization }) => {
      const loc = await versionLocalization(versionId, locale);
      if (!loc) throw new Error(`no localization ${locale}`);
      const r = await api(
        "GET",
        `/v1/appStoreVersionLocalizations/${enc(loc.id)}/appScreenshotSets?include=appScreenshots&limit=50`,
      );
      const shots = new Map((r.included ?? []).map((s) => [s.id, s.attributes]));
      return r.data.map((s) => ({
        setId: s.id,
        displayType: s.attributes.screenshotDisplayType,
        screenshots: (s.relationships?.appScreenshots?.data ?? []).map(({ id }) => ({
          id,
          fileName: shots.get(id)?.fileName,
          state: shots.get(id)?.assetDeliveryState?.state,
          errors: shots.get(id)?.assetDeliveryState?.errors ?? undefined,
        })),
      }));
    },
  },
  {
    name: "list_previews",
    group: "read",
    description: "App preview video sets and previews for a version + locale.",
    input: { versionId: z.string(), locale: z.string() },
    run: async ({ versionId, locale }, { api, versionLocalization }) => {
      const loc = await versionLocalization(versionId, locale);
      if (!loc) throw new Error(`no localization ${locale}`);
      const r = await api(
        "GET",
        `/v1/appStoreVersionLocalizations/${enc(loc.id)}/appPreviewSets?include=appPreviews&limit=50`,
      );
      const pv = new Map((r.included ?? []).map((s) => [s.id, s.attributes]));
      return r.data.map((s) => ({
        setId: s.id,
        previewType: s.attributes.previewType,
        previews: (s.relationships?.appPreviews?.data ?? []).map(({ id }) => ({
          id,
          fileName: pv.get(id)?.fileName,
          state: pv.get(id)?.assetDeliveryState?.state,
        })),
      }));
    },
  },
  {
    name: "list_header_search",
    group: "read",
    description: "Header and search-results image placements (App Store Asset Library) for a version + locale.",
    input: { versionId: z.string(), locale: z.string() },
    run: async ({ versionId, locale }, { api, versionLocalization }) => {
      const loc = await versionLocalization(versionId, locale);
      if (!loc) throw new Error(`no localization ${locale}`);
      const r = await api("GET", `/v1/appStoreVersionLocalizations/${enc(loc.id)}/placements`);
      return (r.data ?? []).map((p) => ({ id: p.id, ...p.attributes }));
    },
  },
  {
    name: "library_images",
    group: "read",
    description: "Images in the app's Asset Library with processing state.",
    input: { appId: z.string() },
    run: async ({ appId }, { api, getAll }) => {
      const lib = (await api("GET", `/v1/apps/${enc(appId)}/assetLibrary`)).data.id;
      const r = await getAll(`/v1/appAssetLibraries/${enc(lib)}/images?limit=200`);
      return rows(r, (i) => ({
        id: i.id,
        fileName: i.attributes.fileName,
        state: i.attributes.state,
        details: i.attributes.stateDetails ?? null,
      }));
    },
  },
  {
    name: "list_builds",
    group: "read",
    description: "Recent builds of an app (id, build number, version, processing state, upload date).",
    input: { appId: z.string(), limit: z.number().int().min(1).max(200).default(20) },
    run: async ({ appId, limit }, { api }) => {
      const r = await api(
        "GET",
        `/v1/builds?filter[app]=${enc(appId)}&sort=-uploadedDate&limit=${limit}&include=preReleaseVersion`,
      );
      const pre = new Map((r.included ?? []).map((i) => [i.id, i.attributes.version]));
      return r.data.map((b) => ({
        id: b.id,
        build: b.attributes.version,
        version: pre.get(b.relationships?.preReleaseVersion?.data?.id),
        state: b.attributes.processingState,
        uploaded: b.attributes.uploadedDate,
        expired: b.attributes.expired,
      }));
    },
  },
  {
    name: "list_price_points",
    group: "read",
    description: "App price points for a territory (id, customerPrice, proceeds). Use the id with set_app_price.",
    input: {
      appId: z.string(),
      territory: z.string().default("USA"),
      limit: z.number().int().min(1).max(200).default(50),
    },
    run: async ({ appId, territory, limit }, { api }) => {
      const r = await api(
        "GET",
        `/v1/apps/${enc(appId)}/appPricePoints?filter[territory]=${enc(territory)}&limit=${limit}`,
      );
      return r.data.map((p) => ({ id: p.id, ...p.attributes }));
    },
  },
  {
    name: "readiness_check",
    group: "read",
    description:
      "What is missing before submitting a version: build, copyright, texts per locale, screenshots per device and their processing state, review details, category, privacy URL.",
    input: { appId: z.string(), versionId: z.string() },
    run: async ({ appId, versionId }, { api, getAll, editableAppInfo }) => {
      const out = { problems: [], ok: [] };
      const v = (await api("GET", `/v1/appStoreVersions/${enc(versionId)}?include=build`)).data;
      out.version = {
        string: v.attributes.versionString,
        state: v.attributes.appStoreState,
        copyright: v.attributes.copyright ?? null,
        releaseType: v.attributes.releaseType,
      };
      if (!v.attributes.copyright) out.problems.push("copyright empty");
      if (!v.relationships?.build?.data) out.problems.push("no build attached");
      else out.ok.push("build attached");
      const locs = (await getAll(`/v1/appStoreVersions/${enc(versionId)}/appStoreVersionLocalizations?limit=200`)).data;
      for (const l of locs) {
        const a = l.attributes,
          tag = a.locale;
        for (const f of ["description", "keywords", "supportUrl"]) if (!a[f]) out.problems.push(`${tag}: ${f} empty`);
        const sets = await api(
          "GET",
          `/v1/appStoreVersionLocalizations/${enc(l.id)}/appScreenshotSets?include=appScreenshots&limit=50`,
        );
        const st = new Map((sets.included ?? []).map((s) => [s.id, s.attributes.assetDeliveryState?.state]));
        for (const s of sets.data) {
          const ids = (s.relationships?.appScreenshots?.data ?? []).map((x) => x.id);
          const bad = ids.filter((id) => st.get(id) !== "COMPLETE").length;
          (ids.length && !bad ? out.ok : out.problems).push(
            `${tag}: ${s.attributes.screenshotDisplayType} ${ids.length} shots${bad ? `, ${bad} not processed` : ""}`,
          );
        }
        if (!sets.data.some((s) => /IPHONE_67|IPHONE_65/.test(s.attributes.screenshotDisplayType)))
          out.problems.push(`${tag}: no 6.9"/6.5" iPhone screenshots`);
      }
      try {
        const rd = (await api("GET", `/v1/appStoreVersions/${enc(versionId)}/appStoreReviewDetail`)).data;
        if (!rd?.attributes?.contactEmail) out.problems.push("review contact email empty");
        else out.ok.push("review details set");
      } catch {
        out.problems.push("review details not created");
      }
      const info = await editableAppInfo(appId);
      const full = await api("GET", `/v1/appInfos/${enc(info.id)}?include=primaryCategory`);
      if (!full.data.relationships?.primaryCategory?.data) out.problems.push("primary category not set");
      else out.ok.push(`category ${full.data.relationships.primaryCategory.data.id}`);
      const il = (await getAll(`/v1/appInfos/${enc(info.id)}/appInfoLocalizations?limit=200`)).data;
      for (const l of il)
        if (!l.attributes.privacyPolicyUrl) out.problems.push(`${l.attributes.locale}: privacy policy URL empty`);
      out.notChecked = ["App Privacy labels (not in public API)", "age rating answers", "pricing and availability"];
      return out;
    },
  },
];
