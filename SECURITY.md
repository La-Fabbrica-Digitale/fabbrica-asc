# Security

## Model

| Risk | Control |
|---|---|
| The AI does something you didn't ask for | Dangerous groups are off by default. When on, every call opens two native OS dialogs: a summary (Cancel is the default button), then a typed phrase. The AI receives only the result. The action runs on exactly what the dialog showed. |
| Prompt injection from texts, files or web pages | Same as above. Safe groups (`metadata`, `media`) can change texts and swap screenshots; they cannot submit, release, delete versions or change prices. |
| Data leaves to a third party | Requests go only to `https://api.appstoreconnect.apple.com` and upload URLs on `*.apple.com`. Pagination links are checked too. |
| Path tricks in `asc_request` | API paths with `..`, `%2e`, encoded separators or `//` are refused; the block list is checked against the path exactly as sent. |
| The AI reads or uploads arbitrary local files | Uploads only from `ASC_FILES_ROOT` (required; symlinks resolved), only allowed extensions. |
| Over-privileged key | Docs ask for the App Manager role. Users, certificates, profiles, bundle IDs, devices and app deletion are blocked in code. |
| Supply chain | 2 runtime dependencies, pinned versions, lockfile. Releases will carry a SHA-256 file for the `.mcpb`; npm publishing with provenance is planned, not done yet. |
| No trace | Every write and every refused dangerous call goes to `~/.fabbrica-appstoreconnect/audit.log` (mode 600, passwords masked). |

Settings (groups, read-only, files root) come only from environment variables in the client config. No tool can change them.

## Limits

- **Agents with a shell.** The dialogs protect against model mistakes and prompt injection in a chat client. They do not protect against an agent that can run commands on your computer (for example Claude Code or any client with a shell tool): such an agent can click the dialog through macOS System Events or UI scripting, read the `.p8` key from disk, or edit the client config. If you use the server next to a shell-capable agent, keep dangerous groups off and keep the key outside folders that agent can read.
- Anyone who can edit your client config or run code as your user can bypass all of this.
- On Linux without a desktop session, dangerous tools fail (no dialog).
- `replace=true` in `media` tools swaps slot contents: old files are deleted after the new ones are processed.

## Reporting

Email hello@fabbrica.tech or open a private GitHub security advisory. Don't open public issues for vulnerabilities. Support is best effort.
