// Dangerous group "delete". Every call opens a double confirmation dialog on the user's computer.
// Deleting apps is not possible: the App Store Connect API has no such endpoint, and asc_request blocks it.
import { z } from "zod";
import { enc } from "../asc.mjs";

const ids = z.array(z.string()).min(1).max(50);

function simpleDelete({ name, type, label, phraseWord, description }) {
  return {
    name,
    group: "delete",
    description,
    input: { ids },
    confirm: async ({ ids }, { api }) => {
      const rows = [];
      for (const id of ids) {
        try {
          const a = (await api("GET", `/v1/${type}/${enc(id)}`)).data.attributes;
          rows.push(`• ${id} ${a.fileName ?? a.locale ?? ""}`);
        } catch (e) {
          throw new Error(`${label} ${id}: ${e.message}`);
        }
      }
      return {
        action: `Delete ${label}`,
        summary: [
          `Delete ${ids.length} ${label}:`,
          ...rows.slice(0, 15),
          ...(rows.length > 15 ? [`… and ${rows.length - 15} more`] : []),
        ],
        phrase: `DELETE ${ids.length} ${phraseWord}`,
      };
    },
    run: async ({ ids }, { api }) => {
      const out = [];
      for (const id of ids) {
        await api("DELETE", `/v1/${type}/${enc(id)}`);
        out.push(id);
      }
      return { deleted: out };
    },
  };
}

export default [
  simpleDelete({
    name: "delete_screenshots",
    type: "appScreenshots",
    label: "screenshots",
    phraseWord: "SCREENSHOTS",
    description: "Delete screenshots by id (see list_screenshots). Phrase: DELETE <n> SCREENSHOTS.",
  }),
  simpleDelete({
    name: "delete_previews",
    type: "appPreviews",
    label: "previews",
    phraseWord: "PREVIEWS",
    description: "Delete app preview videos by id (see list_previews). Phrase: DELETE <n> PREVIEWS.",
  }),
  simpleDelete({
    name: "delete_library_images",
    type: "appAssetLibraryImages",
    label: "library images",
    phraseWord: "IMAGES",
    description: "Delete Asset Library images by id (see library_images). Phrase: DELETE <n> IMAGES.",
  }),
  simpleDelete({
    name: "delete_localizations",
    type: "appStoreVersionLocalizations",
    label: "version localizations",
    phraseWord: "LOCALIZATIONS",
    description:
      "Delete version localizations by id (texts, screenshots and previews of that locale go with them). Phrase: DELETE <n> LOCALIZATIONS.",
  }),
  {
    name: "delete_version",
    group: "delete",
    description:
      "Delete an App Store version that was never submitted (PREPARE_FOR_SUBMISSION). Phrase: DELETE VERSION <app name> <version>.",
    input: { versionId: z.string() },
    confirm: async ({ versionId }, { versionSummary }) => {
      const v = await versionSummary(versionId);
      return {
        action: "Delete version",
        summary: [
          "Delete App Store version:",
          `App: ${v.appName}`,
          `Version: ${v.versionString} ${v.platform}`,
          `State: ${v.state}`,
        ],
        phrase: `DELETE VERSION ${v.appName} ${v.versionString}`,
      };
    },
    run: async ({ versionId }, { api }) => {
      await api("DELETE", `/v1/appStoreVersions/${enc(versionId)}`);
      return { deleted: versionId };
    },
  },
];
