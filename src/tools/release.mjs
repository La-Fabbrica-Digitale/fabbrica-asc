// @ts-check
// Dangerous group "release". Every call opens a double confirmation dialog on the user's computer.
import { z } from "zod";
import { enc, rel } from "../asc.mjs";

const PLATFORM = z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS");
const OPEN = ["READY_FOR_REVIEW", "WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES"];
const ITEM_RELS = [
  "appStoreVersion",
  "appCustomProductPageVersion",
  "appStoreVersionExperiment",
  "appStoreVersionExperimentV2",
  "appEvent",
  "backgroundAssetVersion",
  "gameCenterAchievementVersion",
  "gameCenterLeaderboardVersion",
  "gameCenterLeaderboardSetVersion",
  "gameCenterChallengeVersion",
  "gameCenterActivityVersion",
];

const RELEASE = {
  MANUAL: "manual: stays approved until you release it",
  AFTER_APPROVAL: "AUTOMATIC: goes live as soon as Apple approves",
  SCHEDULED: "scheduled",
};
/** @param {any} v */
const facts = (v) => [
  `App: ${v.appName} (${v.appId})`,
  `Version: ${v.versionString} ${v.platform}`,
  `Current state: ${v.state}`,
  `Build: ${v.buildId ?? "none"}`,
  `Release after approval: ${RELEASE[v.releaseType] ?? v.releaseType ?? "not set"}${v.releaseType === "SCHEDULED" ? ` (${v.earliestReleaseDate})` : ""}`,
];

/** Items of a review submission as "relationship:id" keys, e.g. "appStoreVersion:123". */
async function submissionItems(api, getAll, submissionId) {
  const r = await getAll(
    `/v1/reviewSubmissions/${enc(submissionId)}/items?include=${ITEM_RELS.slice(0, 5).join(",")}&limit=50`,
  );
  return r.data.map((item) => {
    const relName = ITEM_RELS.find((k) => item.relationships?.[k]?.data);
    return relName ? `${relName}:${item.relationships[relName].data.id}` : `item:${item.id}`;
  });
}

async function openSubmissions(api, getAll, appId, states) {
  const r = await getAll(`/v1/reviewSubmissions?filter[app]=${enc(appId)}&filter[state]=${states.join(",")}&limit=50`);
  const out = [];
  for (const s of r.data)
    out.push({
      id: s.id,
      state: s.attributes.state,
      platform: s.attributes.platform,
      items: await submissionItems(api, getAll, s.id),
    });
  return out;
}

export default [
  {
    name: "submit_for_review",
    group: "release",
    description:
      "Submit an App Store version to App Review. Run readiness_check first. If the app already has a draft submission, its other items are shown in the dialog and go to review together. Phrase: SUBMIT <app name> <version>.",
    input: { versionId: z.string(), platform: PLATFORM },
    confirm: async ({ versionId, platform }, { api, getAll, versionSummary }) => {
      const v = await versionSummary(versionId);
      if (!v.buildId) throw new Error("no build attached to this version");
      const draft =
        (await openSubmissions(api, getAll, v.appId, ["READY_FOR_REVIEW"])).find((s) => s.platform === platform) ??
        null;
      const others = draft ? draft.items.filter((k) => k !== `appStoreVersion:${versionId}`) : [];
      return {
        action: "Submit for review",
        summary: [
          "Submit to App Review:",
          ...facts(v),
          ...(draft ? [`Draft submission ${draft.id} will be used.`] : []),
          ...(others.length
            ? [
                `It also contains ${others.length} other item(s), they go to review too:`,
                ...others.map((k) => `• ${k}`),
              ]
            : []),
        ],
        phrase: `SUBMIT ${v.appName} ${v.versionString}`,
        draftId: draft?.id ?? null,
        draftItems: draft?.items ?? [],
      };
    },
    run: async ({ versionId, platform }, { api, getAll, versionSummary }, plan) => {
      const v = await versionSummary(versionId);
      let subId = plan.draftId;
      if (subId) {
        const now = await submissionItems(api, getAll, subId);
        if (JSON.stringify(now) !== JSON.stringify(plan.draftItems))
          throw new Error(`draft submission ${subId} changed after confirmation; nothing submitted, ask again`);
      } else {
        subId = (
          await api("POST", "/v1/reviewSubmissions", {
            data: { type: "reviewSubmissions", attributes: { platform }, relationships: { app: rel("apps", v.appId) } },
          })
        ).data.id;
      }
      const key = `appStoreVersion:${versionId}`;
      if (!plan.draftItems.includes(key)) {
        try {
          await api("POST", "/v1/reviewSubmissionItems", {
            data: {
              type: "reviewSubmissionItems",
              relationships: {
                reviewSubmission: rel("reviewSubmissions", subId),
                appStoreVersion: rel("appStoreVersions", versionId),
              },
            },
          });
        } catch (e) {
          // 409 is also "version not ready"; accept it only if the version is in the submission now.
          if (e.status !== 409 || !(await submissionItems(api, getAll, subId)).includes(key)) throw e;
        }
      }
      const r = await api("PATCH", `/v1/reviewSubmissions/${enc(subId)}`, {
        data: { type: "reviewSubmissions", id: subId, attributes: { submitted: true } },
      });
      return {
        reviewSubmissionId: subId,
        state: r.data.attributes.state,
        app: v.appName,
        version: v.versionString,
        releaseType: v.releaseType,
      };
    },
  },
  {
    name: "cancel_review_submission",
    group: "release",
    description:
      "Cancel the open review submission that contains this version. Other items in the same submission are cancelled too and listed in the dialog. Phrase: CANCEL <app name> <version>.",
    input: { versionId: z.string() },
    confirm: async ({ versionId }, { api, getAll, versionSummary }) => {
      const v = await versionSummary(versionId);
      const subs = (await openSubmissions(api, getAll, v.appId, OPEN)).filter((s) =>
        s.items.includes(`appStoreVersion:${versionId}`),
      );
      if (!subs.length) throw new Error(`no open review submission contains version ${v.versionString}`);
      return {
        action: "Cancel review submission",
        summary: [
          "Cancel App Review submission:",
          ...facts(v),
          ...subs.flatMap((s) => [`Submission ${s.id} (${s.state}), items:`, ...s.items.map((k) => `• ${k}`)]),
        ],
        phrase: `CANCEL ${v.appName} ${v.versionString}`,
        submissionIds: subs.map((s) => s.id),
      };
    },
    run: async (_, { api }, plan) => {
      const out = [];
      for (const id of plan.submissionIds) {
        const r = await api("PATCH", `/v1/reviewSubmissions/${enc(id)}`, {
          data: { type: "reviewSubmissions", id, attributes: { canceled: true } },
        });
        out.push({ reviewSubmissionId: id, state: r.data.attributes.state });
      }
      return out;
    },
  },
  {
    name: "release_version",
    group: "release",
    description:
      "Release an approved version that waits for manual release (PENDING_DEVELOPER_RELEASE). Phrase: RELEASE <app name> <version>.",
    input: { versionId: z.string() },
    confirm: async ({ versionId }, { versionSummary }) => {
      const v = await versionSummary(versionId);
      if (v.state !== "PENDING_DEVELOPER_RELEASE")
        throw new Error(`version is ${v.state}, not PENDING_DEVELOPER_RELEASE`);
      return {
        action: "Release to App Store",
        summary: ["Release to the App Store now:", ...facts(v)],
        phrase: `RELEASE ${v.appName} ${v.versionString}`,
      };
    },
    run: async ({ versionId }, { api }) => {
      const r = await api("POST", "/v1/appStoreVersionReleaseRequests", {
        data: {
          type: "appStoreVersionReleaseRequests",
          relationships: { appStoreVersion: rel("appStoreVersions", versionId) },
        },
      });
      return { releaseRequestId: r.data.id, versionId };
    },
  },
  {
    name: "phased_release",
    group: "release",
    description:
      "Phased release (7-day rollout): enable (before release), pause, resume, complete (release to everyone now), disable (before release). Phrase: PHASED <ACTION> <app name> <version>.",
    input: { versionId: z.string(), action: z.enum(["enable", "pause", "resume", "complete", "disable"]) },
    confirm: async ({ versionId, action }, { versionSummary }) => {
      const v = await versionSummary(versionId);
      return {
        action: `Phased release: ${action}`,
        summary: [`Phased release → ${action}:`, ...facts(v)],
        phrase: `PHASED ${action.toUpperCase()} ${v.appName} ${v.versionString}`,
      };
    },
    run: async ({ versionId, action }, { api }) => {
      let cur = null;
      try {
        cur = (await api("GET", `/v1/appStoreVersions/${enc(versionId)}/appStoreVersionPhasedRelease`)).data;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      if (action === "enable") {
        if (cur) return { id: cur.id, state: cur.attributes.phasedReleaseState, note: "already enabled" };
        const r = await api("POST", "/v1/appStoreVersionPhasedReleases", {
          data: {
            type: "appStoreVersionPhasedReleases",
            attributes: { phasedReleaseState: "INACTIVE" },
            relationships: { appStoreVersion: rel("appStoreVersions", versionId) },
          },
        });
        return { id: r.data.id, state: r.data.attributes.phasedReleaseState };
      }
      if (!cur) throw new Error("phased release is not enabled for this version");
      if (action === "disable") {
        await api("DELETE", `/v1/appStoreVersionPhasedReleases/${enc(cur.id)}`);
        return { id: cur.id, disabled: true };
      }
      const state = { pause: "PAUSED", resume: "ACTIVE", complete: "COMPLETE" }[action];
      const r = await api("PATCH", `/v1/appStoreVersionPhasedReleases/${enc(cur.id)}`, {
        data: { type: "appStoreVersionPhasedReleases", id: cur.id, attributes: { phasedReleaseState: state } },
      });
      return {
        id: cur.id,
        state: r.data.attributes.phasedReleaseState,
        currentDayNumber: r.data.attributes.currentDayNumber,
      };
    },
  },
];
