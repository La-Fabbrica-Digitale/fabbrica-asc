# fabbrica-appstoreconnect

An App Store Connect MCP server. Claude, or any other MCP client, can use it to edit texts and keywords, upload whole screenshot folders, set up in-app purchases, attach builds and submit to App Review, so you don't have to click through the App Store Connect website.

Fabbrica Digitale built it for our own apps, and we publish it for other indie developers.

- It runs on your computer over stdio and talks only to `api.appstoreconnect.apple.com` and Apple upload hosts (`*.apple.com`).
- It uploads only files inside the folder you choose (`ASC_FILES_ROOT`, required).
- Submit/release, delete, pricing and raw API calls are **off by default**. When you turn one on, every call opens **two system dialogs**: a summary with Cancel/Continue, then a field where you type an exact phrase, such as `SUBMIT My App 1.0.2`. The AI only sees the result.
- Every write goes to `~/.fabbrica-appstoreconnect/audit.log`.
- It has two runtime dependencies, pinned: `@modelcontextprotocol/sdk` and `zod`.

**Support is best effort.** We fix bugs we hit ourselves and read issues when we can, but we promise no response time. The license is MIT: download it, fork it and change it however you like.

Not affiliated with Apple. App Store Connect is a trademark of Apple Inc.

---

## Contents

1. [Requirements](#1-requirements)
2. [Create an App Store Connect API key](#2-create-an-app-store-connect-api-key)
3. [Install](#3-install)
4. [Check the install](#4-check-the-install)
5. [Upload screenshots](#5-upload-screenshots)
6. [Texts and keywords](#6-texts-and-keywords)
7. [In-app purchases and subscriptions](#7-in-app-purchases-and-subscriptions)
8. [Build, review info, readiness](#8-build-review-info-readiness)
9. [Submit for review](#9-submit-for-review)
10. [Reference](#10-reference)
11. [Troubleshooting](#11-troubleshooting)
12. [Remove](#12-remove)
13. [Development](#13-development)

---

## 1. Requirements

| | |
|---|---|
| MCP client | Claude Desktop (macOS, Windows), Claude Code, Cursor, VS Code or any client that runs local stdio servers. claude.ai on the web and in the mobile apps can't run local servers. |
| Node.js | ≥ 20 for a source install. The `.mcpb` bundle uses the Node.js runtime built into Claude Desktop. |
| Apple | An App Store Connect account that can create API keys (Account Holder or Admin). |
| Dangerous groups | A desktop session for the dialogs: macOS (`osascript`, built in), Windows (PowerShell, built in), Linux (`zenity`). |

## 2. Create an App Store Connect API key

1. Open [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api).
2. If this is your first key, click **Request Access** and accept the terms.
3. Open the **Team Keys** tab and click **+**.
4. Name it `fabbrica-appstoreconnect`. For access, pick **App Manager**. Admin isn't needed.
5. Click **Download**. Apple lets you download the `.p8` file **only once**.
6. From the same page, note the **Key ID** (10 characters, in the key row) and the **Issuer ID** (the UUID above the table).

Keep the `.p8` file private. If it leaks, revoke the key on the same page.

## 3. Install

The package isn't on npm yet. You can install it in two ways.

### A. Claude Desktop bundle (`.mcpb`)

1. Get `fabbrica-appstoreconnect-<version>.mcpb`:
   - from [Releases](https://github.com/La-Fabbrica-Digitale/fabbrica-asc/releases), if the version has one, and check it against its `.sha256` file: `shasum -a 256 -c fabbrica-appstoreconnect-<version>.mcpb.sha256`;
   - or build it yourself: `git clone https://github.com/La-Fabbrica-Digitale/fabbrica-asc.git && cd fabbrica-asc && npm ci && npm run pack:mcpb`. The bundle appears in `dist/`.
2. Double-click the file. Claude Desktop opens an install dialog.
3. Fill in **Key ID**, **Issuer ID**, **Private key (.p8)** and **Files folder**. Keep every switch marked **DANGEROUS** off for the first run.
4. Click **Install**.

You can change settings later in Claude Desktop → Settings → Extensions → App Store Connect (Fabbrica).

### B. From source: Claude Desktop, Claude Code, others

```bash
git clone https://github.com/La-Fabbrica-Digitale/fabbrica-asc.git
cd fabbrica-asc
npm ci --omit=dev
node bin/fabbrica-appstoreconnect.mjs init
```

The wizard does this:
1. Asks for the Key ID, Issuer ID and `.p8` path. It looks for `~/Downloads/AuthKey_*.p8` on its own.
2. Copies the key to `~/.fabbrica-appstoreconnect/AuthKey_<KEYID>.p8` with mode `600`.
3. Asks for the files folder.
4. Asks which groups to turn on. To turn on a dangerous group, you type `ENABLE <GROUP>`.
5. Checks the key against Apple (the same check as `doctor`).
6. Connects your client:
   - `desktop` writes `claude_desktop_config.json` and keeps a `.bak` copy. Then quit Claude Desktop fully (Cmd+Q) and open it again.
   - `code` prints a `claude mcp add …` command.
   - `print` prints JSON for other clients.

The client config it writes calls `node` and the script by absolute path, so it doesn't depend on your `PATH`.

Manual config, for `claude_desktop_config.json` or `mcp.json`:

```json
{
  "mcpServers": {
    "fabbrica-appstoreconnect": {
      "command": "/usr/local/bin/node",
      "args": ["/path/to/fabbrica-asc/bin/fabbrica-appstoreconnect.mjs"],
      "env": {
        "ASC_KEY_ID": "2X9R4HXF34",
        "ASC_ISSUER_ID": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "ASC_P8_PATH": "/Users/you/.fabbrica-appstoreconnect/AuthKey_2X9R4HXF34.p8",
        "ASC_FILES_ROOT": "/Users/you/AppAssets",
        "ASC_GROUPS": "metadata,media"
      }
    }
  }
}
```

## 4. Check the install

```bash
node bin/fabbrica-appstoreconnect.mjs doctor        # key, Apple API, groups, dialog tool, audit log
node bin/fabbrica-appstoreconnect.mjs test-dialog   # shows both confirmation dialogs; type TEST 123
```

Then in Claude:

> Show the App Store Connect server status and list my apps.

## 5. Upload screenshots

Lay the files out like this inside `ASC_FILES_ROOT`. Files within a folder upload in name order.

```
AppAssets/my-app/1.0.2/
├── en-US/
│   ├── APP_IPHONE_67/            ← screenshot display type
│   │   ├── 01.png
│   │   └── 02.png
│   ├── APP_IPAD_PRO_3GEN_129/
│   │   └── 01.png
│   └── IPHONE_67/                ← app preview type (video)
│       └── preview.mp4
└── fr-FR/
    └── APP_IPHONE_67/
        └── 01.png
```

| Folder | Device | Sizes checked locally (portrait; landscape also accepted) |
|---|---|---|
| `APP_IPHONE_67` | iPhone 6.9" / 6.7" | 1320×2868, 1290×2796, 1260×2736 |
| `APP_IPHONE_65` | iPhone 6.5" | 1242×2688, 1284×2778 |
| `APP_IPHONE_61` | iPhone 6.1" | 1206×2622, 1179×2556, 1170×2532 |
| `APP_IPHONE_55` | iPhone 5.5" | 1242×2208 |
| `APP_IPAD_PRO_3GEN_129` | iPad 13" | 2064×2752, 2048×2732 |
| `APP_IPAD_PRO_3GEN_11` | iPad 11" | 1668×2420, 1668×2388, 1640×2360, 1488×2266 |
| `IPHONE_67`, `IPHONE_65`, `IPAD_PRO_3GEN_129` | previews | .mp4 / .mov, up to 3 per slot (not checked locally) |

Each slot holds at most 10 screenshots and 3 previews. We haven't checked the size table against Apple's current spec, and Apple's own check is final.

Ask Claude:

> Upload screenshots from AppAssets/my-app/1.0.2 to My App version 1.0.2, replacing what's there.

Here is what happens:
1. `upload_tree` runs as a dry run. Claude shows you the plan: what goes into which slot, how many existing files get replaced, and any errors. It also gets a `planId`. Nothing goes to Apple yet.
2. You approve.
3. `upload_tree` runs with `dryRun=false` and that `planId`. If a file, a slot or an option changed since the dry run, the run is refused and you have to repeat the dry run.
4. New files upload and Apple processes them. Old files are deleted only after that, so a slot never ends up empty. If an upload fails, the new files are removed and the old ones stay.

If any slot has a validation error, nothing is uploaded. The locale must already exist on the version (step 6 creates it). `replace` is off by default.

## 6. Texts and keywords

> For My App 1.0.2 set en-US and fr-FR: description …, keywords …, promo text …, what's new ….

- `set_version_texts`: description (4000), keywords (100), whatsNew (4000), promotionalText (170), URLs.
- `set_app_info_texts`: name (30), subtitle (30), privacy URL.

Each result shows `before` and `after`.

## 7. In-app purchases and subscriptions

Turn on the `raw` group (see [Groups](#groups)).
- Products and subscriptions are created with `asc_request`: the `/v2/inAppPurchases`, `/v1/subscriptionGroups` and `/v1/subscriptions` endpoints with their localizations and prices. Every POST or PATCH asks for confirmation.
- Review screenshots for products and subscriptions are uploaded with `upload_file` (group `media`): `inAppPurchaseAppStoreReviewScreenshots` and `subscriptionAppStoreReviewScreenshots`.

## 8. Build, review info, readiness

> List builds of My App, attach the latest processed one to 1.0.2, set the review contact …, then run the readiness check.

Tools: `list_builds`, `attach_build`, `set_review_details`, `set_categories`, `update_version`, `readiness_check`.

- `attach_build` sets export compliance (`usesNonExemptEncryption`) only when you pass it, and only if the build has no answer yet. Apple doesn't let you change it later.
- `update_version` with `releaseType=AFTER_APPROVAL` makes the version go live as soon as Apple approves it. The submit dialog shows the release type.
- `readiness_check` lists what is still missing. App Privacy labels and age rating answers aren't in Apple's public API, so check those on the website.

## 9. Submit for review

1. Turn on the `release` group:
   - for the `.mcpb`, the **DANGEROUS: submit and release** switch;
   - for a source install, run `init` again and type `ENABLE RELEASE`.
2. Ask Claude:
   > Submit My App 1.0.2 for review.
3. Dialog 1 lists the app, version, state, build and release type, plus everything else in the app's draft submission, which goes to review together with the version. Click **Continue** or **Cancel**.
4. Dialog 2 asks you to type `SUBMIT My App 1.0.2` and click **Confirm**.
5. Claude gets back `WAITING_FOR_REVIEW`. If you cancel, type the wrong phrase, or the draft submission changes between the dialog and the call, nothing is sent. The attempt is logged either way.

Dialogs time out after 180 s (`ASC_CONFIRM_TIMEOUT`). Turn the group off again when you don't need it.

The `release` group has more tools:
- `cancel_review_submission`: cancels only the submission that contains this version.
- `release_version`: manual release after approval.
- `phased_release`.

## 10. Reference

### Groups

| Group | Default | Dialog | Tools |
|---|---|---|---|
| `read` | always on | no | `server_status`, `list_apps`, `list_versions`, `get_version_texts`, `get_app_info_texts`, `list_screenshots`, `list_previews`, `list_header_search`, `library_images`, `list_builds`, `list_price_points`, `readiness_check`, `validate_assets` |
| `metadata` | on | no | `create_version`, `update_version`, `set_version_texts`, `set_app_info_texts`, `set_categories`, `attach_build`, `set_review_details` |
| `media` | on | no | `upload_tree`, `upload_screenshots`, `upload_previews`, `upload_header_search`, `upload_file` |
| `release` | off | 2 steps | `submit_for_review`, `cancel_review_submission`, `release_version`, `phased_release` |
| `delete` | off | 2 steps | `delete_screenshots`, `delete_previews`, `delete_library_images`, `delete_localizations`, `delete_version` |
| `pricing` | off | 2 steps | `set_app_price` |
| `raw` | off | 2 steps for writes | `asc_request` (any endpoint; GET runs without a dialog) |

- `upload_file` accepts these resource types: IAP and subscription review screenshots and images, review attachments, app event media, routing coverage, and Game Center images.
- Some calls are always blocked, even in `raw`: deleting apps, user management, certificates, profiles, bundle IDs and devices. Paths are checked after URL normalization, and paths that contain `..`, `%2e` or `//` are refused.

### Settings

| Variable | Meaning |
|---|---|
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_P8_PATH` | The API key. Required. |
| `ASC_FILES_ROOT` | The only folder files are uploaded from. Required. |
| `ASC_GROUPS` | Comma list, for example `metadata,media,release`. Default `metadata,media`. `read` alone means read-only tools. |
| `ASC_ENABLE_<GROUP>` | `true`/`false` per group. The `.mcpb` dialog uses these. Overrides `ASC_GROUPS`. |
| `ASC_READONLY` | `1`: only `read` tools are registered. |
| `ASC_CONFIRM_TIMEOUT` | Dialog timeout in seconds, 10–900. Default 180. |
| `ASC_HTTP_TIMEOUT` | Apple API timeout in seconds, 5–600. Default 60. Uploads have their own 300 s limit per chunk. |
| `ASC_AUDIT_LOG` | Log path. Default `~/.fabbrica-appstoreconnect/audit.log`. |
| `ASC_DEV` | `1` hot-reloads `src/tools/*.mjs`. For development. |

Invalid values stop the server at start with a message.

### Network behaviour

- GET requests are retried on 5xx and network errors, up to 4 attempts.
- All requests are retried on 429.
- POST, PATCH and DELETE are not retried on 5xx, so a request is never sent twice.
- If a list has more pages than the server reads (50), the result says `truncated: true`.

### Audit log

The log is JSON Lines, one entry per write call or refused dangerous call: `ts`, `tool`, `group`, `args` (passwords masked), `confirmation`, `result` or `error`. The log isn't rotated yet.

```bash
tail -n 5 ~/.fabbrica-appstoreconnect/audit.log
```

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Tools don't appear in Claude Desktop | Quit it fully (Cmd+Q) and reopen. Logs on macOS: `~/Library/Logs/Claude/mcp-server-fabbrica-appstoreconnect.log`. |
| `missing ASC_FILES_ROOT` and similar at start | A required setting is empty or wrong. Run `init` or fix the config. |
| `ASC 401 NOT_AUTHORIZED` | The Key ID and Issuer ID don't match, the key was revoked, or the `.p8` file is wrong. Run `doctor`. |
| `ASC 403 FORBIDDEN_ERROR` | The key's role is too low. Use App Manager. |
| `outside ASC_FILES_ROOT` | Move the files into that folder or change the setting. |
| `no localization xx-XX` | Create the locale first with `set_version_texts`. |
| `plan changed since the dry run` | Files or the slot changed. Run the dry run again. |
| `confirmation dialog failed` | Run `test-dialog` from a terminal. On macOS, allow the prompt if one appears. On Linux, install `zenity`. |

## 12. Remove

1. Remove the extension in Claude Desktop → Settings → Extensions, or delete the `fabbrica-appstoreconnect` entry from your client config.
2. Run `rm -rf ~/.fabbrica-appstoreconnect`. This deletes the key copy, the saved config and the audit log.
3. Revoke the key in App Store Connect → Users and Access → Integrations.

## 13. Development

```bash
npm ci
npm run check      # prettier, eslint, tsc (JSDoc), end-to-end tests on a fake App Store Connect, no network
npm test           # tests only
ASC_DEV=1 node bin/fabbrica-appstoreconnect.mjs   # hot reload of src/tools/*.mjs
npm run pack:mcpb  # dist/fabbrica-appstoreconnect-<version>.mcpb + .sha256
```

```
bin/fabbrica-appstoreconnect.mjs   CLI: serve | init | doctor | tools | call | test-dialog
src/server.mjs                     MCP server
src/config.mjs                     env → validated settings and groups
src/asc.mjs                        JWT, API client (timeouts, retries, path checks), uploads, file and size checks
src/registry.mjs                   tool loading, group filter, confirmation, audit, hot reload
src/confirm.mjs                    native two-step dialogs (macOS / Windows / Linux)
src/audit.mjs                      JSONL audit log
src/tools/*.mjs                    tools by group
test/                              fake API (preloaded with --import) and tests
```

A tool is an object in a `src/tools/*.mjs` default export:

```js
{ name, group, description, input: { /* zod shape */ },
  confirm: async (args, ctx) => ({ action, summary: [..], phrase, ...plan }),  // required for dangerous groups
  run: async (args, ctx, plan) => result }                                      // plan = what the user confirmed
```

With `ASC_DEV=1`, edits to tool files and new tool files take effect on the next tool call. Changes to `src/*.mjs` outside `tools/` still need a client restart.

Not built yet: an npm package, video checks for previews (duration, resolution), audit log rotation.

License: MIT.
