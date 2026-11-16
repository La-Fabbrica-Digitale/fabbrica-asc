// Dangerous group "raw": any App Store Connect API call.
// GET calls run without a dialog. POST/PATCH/DELETE open a double confirmation dialog.
// Always blocked: deleting apps, user management, signing assets (certificates, profiles, bundle ids, devices).
import { z } from "zod";
import { apiUrl } from "../asc.mjs";

/** @type {[RegExp, string][]} */
const BLOCK = [
  [/^DELETE \/v1\/apps\//, "deleting apps is blocked"],
  [/^(POST|PATCH|DELETE) \/v1\/(users|userInvitations)\b/, "user management is blocked"],
  [
    /^(POST|PATCH|DELETE) \/v1\/(certificates|profiles|bundleIds|bundleIdCapabilities|devices)\b/,
    "signing assets are blocked",
  ],
];
// Checks the path exactly as it will be sent: apiUrl() rejects "..", "%2e", "//" and anything URL parsing would rewrite.
function guard(method, path) {
  const pathname = new URL(apiUrl(path)).pathname;
  for (const [re, why] of BLOCK) if (re.test(`${method} ${pathname}`)) throw new Error(why);
  return pathname;
}

export default [
  {
    name: "asc_request",
    group: "raw",
    description:
      "Any App Store Connect API call (IAP and subscriptions, custom product pages, PPO, TestFlight, age rating, availability, app events…). path starts with /v1/, /v2/ or /v3/ and may have a query string; body is a JSON:API document. GET runs directly (allPages follows links.next). POST/PATCH/DELETE open a confirmation dialog with the method, path and body. Blocked: deleting apps, users, signing assets.",
    input: {
      method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
      path: z.string(),
      body: z.any().optional(),
      allPages: z.boolean().default(false),
    },
    isWrite: ({ method }) => method !== "GET",
    // Returning null skips the dialog (GET).
    confirm: async ({ method, path, body }) => {
      const pathname = guard(method, path);
      if (method === "GET") return null;
      const b = body ? JSON.stringify(body, null, 1) : "(no body)";
      return {
        action: `${method} request`,
        summary: [`${method} ${path}`, "", b.length > 1200 ? b.slice(0, 1200) + "\n…" : b],
        phrase: `${method} ${pathname}`,
      };
    },
    run: async ({ method, path, body, allPages }, { api, getAll }) => {
      guard(method, path);
      if (method === "GET" && allPages) return getAll(path);
      return api(method, path, body);
    },
  },
];
