# Ticketing-Infra-360 MCP Server

An MCP (Model Context Protocol) server for **LinkIT360 Ticketing-Infra** on the
LinkIT360 platform (`https://report.linkit360.com`) — create and list IT/Infra
tickets from your AI agent.

LinkIT360 exposes **no public API** — it is a Laravel web application gated
behind a login (with reCAPTCHA). This server therefore integrates via **headless
browser automation** (Playwright + Chromium): the user logs in once (solving the
captcha in a real browser), the session is persisted and reused, and the server
exposes tools to **create infra tickets**, **list/search tickets & services**,
and inspect/drive the underlying forms.

> Status: working & verified end-to-end against the live site — interactive
> login + session reuse, `create_infra_ticket` (real ticket created), and the
> list/discovery tools all confirmed. See [INSTALL.md](INSTALL.md) to set it up.

---

## How LinkIT360 works (analysis)

| Aspect | Finding |
|---|---|
| Stack | Laravel (PHP), Blade templates |
| Auth | Session-based. `POST /login` with email + password + CSRF `_token`. Form uses `input[name="email"]`, `input[name="password"]`, `button[type="submit"]`. |
| **Login CAPTCHA** | **reCAPTCHA v2 ("I'm not a robot" checkbox), sitekey `6LcbQcEeAAAA…`.** Verified live — invalid captcha is rejected server-side ("Invalid recaptcha"). |
| Public API | None. `/api` → 404, `/api/documentation` → 500 (not publicly reachable). |
| CSRF | Present (`_token` hidden input / `csrf-token` meta). Handled automatically because we submit the rendered form. |
| Integration | Headless browser automation, with a **one-time manual login** to clear the reCAPTCHA. |

Because there is no API, **the field schema of each record must be discovered
from the rendered HTML** — that's what the `inspect_form` tool is for.

### Authentication model (important)

reCAPTCHA v2 **cannot and must not be solved by automation**, so a human clears
it **once** and the session is reused after that. There are two equivalent ways
to do that one-time login:

**A. From inside your MCP client (recommended) — the `login` tool**
1. Ask Claude/Cursor to "log in to LinkIT360" (or call the `login` tool).
2. A real browser window opens on your machine with credentials pre-filled.
3. You solve the reCAPTCHA and click Login.
4. The session is saved and **hot-reloaded** into the running server — every
   later tool call just works. No terminal needed.

**B. From a terminal — `npm run login`**
   Same thing, run as a command. Useful for headless setup or first install.

After either, the session cookies live in `~/.linkit360/session.json` (the
default `LINKIT_SESSION_PATH`) and are reused for all operations until they expire. When a tool detects the session has
expired, it returns a clear message telling you to log in again (it never tries
to brute past the captcha). Both flows require a machine with a graphical
display (to show the browser window).

---

## Architecture

```
src/
├── index.ts            # Entry: builds McpServer, stdio transport, graceful shutdown
├── config.ts           # Env loading + validation (zod), URL helpers
├── logger.ts           # Leveled logger -> stderr (never stdout: protocol-safe)
├── browser.ts          # Playwright lifecycle + persistent storageState session
├── auth.ts             # Login flow (drives real form), selector auto-detect, re-login
├── context.ts          # Shared services bundle handed to tools
├── utils/retry.ts      # Exponential-backoff retry
├── tools/
│   ├── index.ts        # Registers all tools
│   ├── session.ts      # check_session, login, logout
│   ├── navigate.ts     # navigate
│   ├── inspect.ts      # inspect_form  (schema discovery)
│   ├── content.ts      # get_page_content
│   ├── screenshot.ts   # screenshot
│   └── records.ts      # submit_form   (create/update writer)
├── prompts/index.ts    # Reusable guided prompts
└── resources/index.ts  # ticketing-infra-360://info resource
tests/
├── smoke.mjs           # MCP protocol handshake + tool listing (no creds)
└── detect-login.mjs    # Live login-form detection (no creds)
```

### Reliability features
- **Persistent session** — `storageState` saved to `~/.linkit360/`; log in once, reuse.
- **Seamless re-login** — when a session expires mid-task, the server automatically opens a real browser window so you just solve the captcha and continue. No terminal, no app restart (`LINKIT_AUTO_LOGIN`, default on).
- **Self-installing browser** — if Chromium is missing it installs in the background; you just retry the request a minute later (`LINKIT_AUTO_INSTALL_BROWSER`, default on).
- **Automatic updates** — on startup the server quietly pulls the latest code from GitHub and rebuilds; the update applies on the next launch, with no manual `git pull`/`build` and no restart prompt (`LINKIT_AUTO_UPDATE`, default on).
- **Retry with backoff** — transient navigation/network errors retried (`LINKIT_MAX_RETRIES`).
- **Timeouts** — per-navigation timeout (`LINKIT_TIMEOUT_MS`).
- **Selector auto-detection** — login fields detected across common Laravel conventions, overridable via env.
- **Dry-run writes** — `submit_form` supports `dryRun` to preview before committing.
- **Protocol-safe logging** — all logs go to stderr.

---

## Tools

#### Typed, high-level tools

| Tool | Purpose |
|---|---|
| `create_infra_ticket` | **Create an Infra ticket** (`POST /ticketing-infra/request`). Fully typed: `subject`, `category`, `company`, `serviceType` (service/project), `classification` (P0–P4), `requestDetail`, `sentTo[]`, `ccEmail[]`, `country`, `project`, `operator`, `service`, `files[]`, `attachmentText`. See notes below. |
| `list_tickets` | **List/search tickets** for a module (`infra`/`creative`/`media`/`legal`). Optional global `search`; returns rows keyed by column header. |
| `list_services` | **List/search services** from `/service/list`. Optional global `search`. |
| `get_field_options` | **Propose choices to the user.** Returns the available options (value+label) for one or more `<select>` fields on any page (with optional substring filter). Use when a required dropdown isn't specified — list options, let the user pick. Essential for the option-heavy service form. |

**`create_infra_ticket` behavior (learned from the live form's JS validation):**
- **Subject** is auto-prefixed with `"LinkIT - Infra - "` (required). Pass a concise 2–3 word summary of the core purpose — e.g. `"Change env gameshop"` → `"LinkIT - Infra - Change env gameshop"`.
- **`serviceType` is required** — `service` needs operator+service (for country categories); `project` needs the project name. If the user didn't specify, **ask** — the tool won't guess.
- **Dropdowns** accept label *or* value, resolved against the live form (handles select2 widgets).
- **Recipients (`sentTo`) default to BOTH** `it.support@linkit360.com` and `infra@linkit360.com` when not specified.
- **Attachment is mandatory.** Pass `files` (JPEG/PNG/PDF/DOC/DOCX/XLS/XLSX, <10 MB), or pass `attachmentText` (an AI-polished, neat description — core details unchanged) and a **PDF is auto-generated**. Falls back to `requestDetail`.
- **`dryRun: true`** fills the form, drives submit to the confirmation dialog to *prove validation passes*, then **cancels** — no ticket created. `dryRun: false` confirms and creates.
- Submit flows through a SweetAlert **"Yes, Create it!"** confirmation, handled automatically.

#### Generic / building-block tools

| Tool | Purpose |
|---|---|
| `check_session` | Is there a valid authenticated session? (no login) |
| `login` | Reuse a valid session, or open a real browser window for the user to solve the reCAPTCHA + log in; saves & hot-reloads the session. `force` to re-login, `interactive:false` for captcha-free headless login, `timeoutSeconds` to wait. |
| `logout` | Clear the persisted session |
| `navigate` | Go to a path; returns final URL, title, HTTP status |
| `inspect_form` | **Discover schema** — dump every form's fields (name, selector, type, label, required, options, action/method) |
| `get_page_content` | Visible text + links + tables of a page (read reports/dashboards) |
| `screenshot` | PNG screenshot of a page |
| `submit_form` | **Generic create/update** — fill any form's fields by selector and submit; `dryRun` preview; validation detection. Used for modules without a typed tool yet (creative/media/legal tickets, service create, profile). |

**Prompts:** `discover_record_form`, `create_record_safely`.
**Resources:** `ticketing-infra-360://info`.

> Coverage roadmap: `create_infra_ticket` is the first typed write tool (your
> priority). Creative/Media/Legal ticket creation and the ~80-field service
> create form are reachable today via `submit_form` (+ `inspect_form` to get
> selectors) and can be promoted to typed tools the same way infra was.

---

## Setup

> **New user?** See **[INSTALL.md](INSTALL.md)** for a step-by-step install guide
> (npx or from source) with per-client configuration for Claude Code, Claude
> Desktop, Cursor, and VS Code.

Requires Node.js ≥ 20.

```bash
npm install            # also downloads Chromium via postinstall
cp .env.example .env   # then edit .env with your credentials
npm run build
```

That's the whole install. The **one-time login** happens on first use — either by
asking your MCP client to "log in to LinkIT360" (the `login` tool opens a browser),
or by running `npm run login`. After that, everything is automatic.

#### The user journey (what a new user does)

```
1. clone + npm install + set .env           (once)
2. add the server to Claude Desktop/Cursor  (once — see Client integration)
3. first action → "log in to LinkIT360"     → browser opens, solve captcha (once)
4. use any tool: "list infra tickets", "create an infra ticket for …"
   → session is reused automatically; re-login only when it expires
```

### Configure `.env`

```ini
LINKIT_BASE_URL=https://report.linkit360.com
LINKIT_EMAIL=you@example.com
LINKIT_PASSWORD=your-password
# optional overrides — see .env.example for the full list
LINKIT_HEADLESS=true
# LINKIT_SESSION_PATH defaults to ~/.linkit360/session.json (absolute); override only if needed
# LINKIT_SESSION_PATH=/Users/you/.linkit360/session.json
```

---

## Testing & verification

```bash
# 1. Protocol smoke test (no credentials) — server starts & speaks MCP
node tests/smoke.mjs

# 2. Live login-form detection (no credentials) — confirms selectors vs real site
node tests/detect-login.mjs

# 3. Live tool test (needs a session from `npm run login`) — reads + dry-run create
node tests/live-tools.mjs

# 4. MCP Inspector (interactive UI) — call tools by hand
npm run inspector
```

`live-tools.mjs` verifies `list_tickets`, `list_services`, and a `create_infra_ticket`
**dry-run** (fills the real form but does not submit), against the live site.

Both automated tests pass out of the box:
- `smoke.mjs` → advertises all 8 tools, 2 prompts, 1 resource.
- `detect-login.mjs` → detects `input[name="email"]`, `input[name="password"]`, `button[type="submit"]`; confirms `POST /login` + CSRF.

### Phase 2: discover the record schema

Once `.env` has working credentials:

```bash
npm run inspector
# In the Inspector:
#  1) call `login`
#  2) call `inspect_form` with { "path": "/<your-create-page>" }
#  3) read back the fields → that's the record schema
```

Or from a connected client (Claude Desktop/Cursor), use the
`discover_record_form` prompt. Share the `inspect_form` output and the typed
`create_record` / `update_record` wrappers will be wired on top of `submit_form`.

### Creating a record safely

```jsonc
// 1) preview (does NOT submit)
submit_form {
  "path": "/reports/create",
  "fields": [
    { "selector": "input[name=\"title\"]", "value": "June report" },
    { "selector": "select[name=\"category\"]", "value": "Monthly", "kind": "select" }
  ],
  "dryRun": true
}
// 2) commit
submit_form { ...same..., "dryRun": false, "expectSuccessUrl": "/reports" }
```

---

## Client integration

### Claude Desktop
Settings → Developer → **Edit Config**
(`~/Library/Application Support/Claude/claude_desktop_config.json`).

**Recommended: `npx` (stays up to date).** Each launch resolves the latest
version published to npm, so new releases reach you automatically. Nothing to
build, nothing to reinstall:
```json
{
  "mcpServers": {
    "ticketing-infra-360": {
      "command": "npx",
      "args": ["-y", "ticketing-infra-360-mcp"],
      "env": {
        "LINKIT_BASE_URL": "https://report.linkit360.com",
        "LINKIT_EMAIL": "you@example.com",
        "LINKIT_PASSWORD": "your-password"
      }
    }
  }
}
```

**From source (advanced).** Point `command`/`args` at your built `dist/index.js`
instead: `"command": "node"`, `"args": ["/ABSOLUTE/PATH/TO/ticketing-infra-360-mcp/dist/index.js"]`.
A git checkout also self-updates on startup.

> Using the old Claude Desktop **Extension (`.mcpb`)** bundle? It does **not**
> auto-update. It stays frozen on the version you installed, so an agent that
> only shows read-only tools (missing `create_infra_ticket`) is simply on a
> stale bundle. Switch to the `npx` config above to get current and stay current.

### Cursor
`.cursor/mcp.json` (project) or global Cursor settings — same shape as above.

### VS Code (MCP-enabled extensions / Continue)
Add an MCP server entry pointing `command`/`args` at `dist/index.js`, with the
same `env`. Restart the extension host afterwards.

> Build first (`npm run build`) so `dist/index.js` exists. Use absolute paths.

---

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `Invalid environment configuration` | Missing `.env` values. Copy `.env.example` → `.env`, fill `LINKIT_*`. |
| Login fails, "still on login page" | Wrong credentials, or non-standard form. Set `LINKIT_LOGIN_*_SELECTOR` from `detect-login.mjs` output; check the server message in the error. |
| Could not locate email/password field | Login markup differs. Run `node tests/detect-login.mjs`, then set the `LINKIT_LOGIN_*_SELECTOR` env vars. |
| Session keeps expiring | Normal — the server auto-opens a login window when needed; just solve the captcha in it. To force a fresh login, delete `~/.linkit360/session.json`. Set `LINKIT_AUTO_LOGIN=false` to disable the auto-window. |
| Timeouts | Increase `LINKIT_TIMEOUT_MS`; raise `LINKIT_MAX_RETRIES`. Set `LINKIT_HEADLESS=false` to watch the browser. |
| Rate limiting / 429 | Use the persistent session (default) to minimize logins; add delays between bulk writes. |
| `submit_form` reports `success:false` | Read the returned `errors[]` (server validation). Re-run `inspect_form` to confirm field names; required fields may be missing. |
| Chromium not found | Re-run `npx playwright install chromium`. |
| Logs corrupt the client | Don't write to stdout. This server logs only to stderr by design. |

---

## Security notes
- Credentials live in `.env` (gitignored) or the client's `env` block. Never commit them.
- The persisted session in `~/.linkit360/` is a live auth cookie — treat it as a secret. It lives outside the repo by default; if you point `LINKIT_SESSION_PATH` inside the project, make sure that path is gitignored.
- Prefer a **staging/test account** for write operations during development.
