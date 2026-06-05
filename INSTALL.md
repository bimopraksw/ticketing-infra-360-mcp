# Installing the Ticketing-Infra-360 MCP server

This guide gets the Ticketing-Infra-360 MCP server (for LinkIT360 infra tickets)
running inside your AI agent
(Claude Code, Claude Desktop, Cursor, or VS Code).

There are **two ways to install**:

- **Option A — `npx` (recommended once published):** zero clone, zero build.
- **Option B — from source:** clone the repo and build it yourself.

Pick one, then jump to [Register it with your agent](#3-register-it-with-your-agent).

---

## Quick start — Claude Desktop with `npx` (~10 min)

Non-technical, on a normal desktop/laptop. Do these five steps in order.

**1. Install Node.js 20+.** Download the **LTS** build from <https://nodejs.org>
and run the installer. Verify: open a terminal (macOS: Terminal; Windows:
PowerShell) and run `node -v` — it must print `v20.x` or higher.

**2. Log in to LinkIT360 once** (solves the reCAPTCHA, saves your session).
In the terminal, replace the email/password and run:

```bash
# macOS / Linux
LINKIT_BASE_URL=https://report.linkit360.com \
LINKIT_EMAIL=you@linkit360.com \
LINKIT_PASSWORD='your-password' \
npx -p ticketing-infra-360-mcp ticketing-infra-360-login
```
```powershell
# Windows (PowerShell) — one line
$env:LINKIT_BASE_URL="https://report.linkit360.com"; $env:LINKIT_EMAIL="you@linkit360.com"; $env:LINKIT_PASSWORD="your-password"; npx -p ticketing-infra-360-mcp ticketing-infra-360-login
```
First run downloads ~150 MB (once). A browser opens → tick **I'm not a robot** →
click **Login**. Done when the terminal prints `✓ Session saved to ~/.linkit360/session.json`.

**3. Register it in Claude Desktop.** Settings → Developer → **Edit Config**.
If the file is empty, paste this and replace the two values:

```json
{
  "mcpServers": {
    "ticketing-infra-360": {
      "command": "npx",
      "args": ["-y", "ticketing-infra-360-mcp"],
      "env": {
        "LINKIT_BASE_URL": "https://report.linkit360.com",
        "LINKIT_EMAIL": "you@linkit360.com",
        "LINKIT_PASSWORD": "your-password"
      }
    }
  }
}
```
If it already has other servers, add only the `"ticketing-infra-360": { … }`
entry inside `mcpServers`. Save the file.

**4. Restart Claude Desktop** — fully quit (macOS `Cmd+Q`; Windows: tray icon →
Quit), then reopen.

**5. Test** — ask Claude: *"List the latest infra tickets in LinkIT360."*
Live ticket rows = done. ✅

> Stuck? See [Troubleshooting](#troubleshooting). Common on macOS: `spawn npx
> ENOENT` — run `which npx` and use its output as `"command"` instead of `"npx"`.

The rest of this guide is the full reference (other clients, from-source, etc.).

---

## 0. Prerequisites

| Requirement | Why |
|---|---|
| **Node.js ≥ 20** (`node --version`) | Runs the server |
| **A graphical display** (desktop/laptop) | You solve the login reCAPTCHA in a real browser **once** |
| **A LinkIT360 account** (email + password) | The server logs in as you |
| ~250 MB free disk | Chromium is downloaded automatically on install |

> The first `install` downloads Chromium via Playwright. Behind a firewall or in
> CI, set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` to skip it (you'll need a browser
> available some other way).

---

## Option A — Install with `npx` (no clone, no build)

Once the package is published to your npm registry, **nothing to install manually** —
your agent config (below) runs it via `npx`, which fetches it and downloads
Chromium automatically on first run.

To pre-warm it / verify:
```bash
npx -y ticketing-infra-360-mcp --help   # downloads the package + Chromium, then starts
```
(Ctrl-C to stop — it's a stdio server, it just waits for a client.)

> Not published yet? Two no-registry alternatives:
> - **Tarball:** maintainer runs `npm pack` → share the `.tgz` → users run
>   `npx ./ticketing-infra-360-mcp-<version>.tgz`.
> - **Git:** `npx github:your-org/ticketing-infra-360-mcp` (installs + builds from the repo).

---

## Option B — Install from source

```bash
git clone <repo-url> ticketing-infra-360-mcp
cd ticketing-infra-360-mcp
npm install      # installs deps + downloads Chromium
npm run build    # compiles to dist/
```

Your entry point is the absolute path to `dist/index.js`.

---

## 3. Register it with your agent

**Always pass credentials in the client's `env` block** (more reliable than a
`.env` file, which depends on the working directory), and **use absolute paths**.

Required env vars:

| Variable | Example |
|---|---|
| `LINKIT_BASE_URL` | `https://report.linkit360.com` |
| `LINKIT_EMAIL` | `you@linkit360.com` |
| `LINKIT_PASSWORD` | `your-password` |

> **You do not need to set `LINKIT_SESSION_PATH`.** It defaults to
> `~/.linkit360/session.json` — an absolute path in your home directory that
> works no matter where the client launches the process. Only set it (to an
> **absolute** path) if you want the saved login stored somewhere else.

Below, use **ONE** of these `command`/`args` pairs depending on your install:

- **npx:** `"command": "npx"`, `"args": ["-y", "ticketing-infra-360-mcp"]`
- **source:** `"command": "node"`, `"args": ["/ABS/PATH/ticketing-infra-360-mcp/dist/index.js"]`

### Claude Code (CLI)

```bash
# npx install:
claude mcp add ticketing-infra-360 \
  -e LINKIT_BASE_URL=https://report.linkit360.com \
  -e LINKIT_EMAIL=you@linkit360.com \
  -e LINKIT_PASSWORD=your-password \
  -- npx -y ticketing-infra-360-mcp

# from source (replace the command after `--`):
#   -- node /ABS/PATH/ticketing-infra-360-mcp/dist/index.js
```
Check it: `claude mcp list` → should show `ticketing-infra-360`.

### Claude Desktop

Edit the config file:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ticketing-infra-360": {
      "command": "npx",
      "args": ["-y", "ticketing-infra-360-mcp"],
      "env": {
        "LINKIT_BASE_URL": "https://report.linkit360.com",
        "LINKIT_EMAIL": "you@linkit360.com",
        "LINKIT_PASSWORD": "your-password"
      }
    }
  }
}
```
Then **fully quit and reopen** Claude Desktop.

> From source, replace `"command"/"args"` with
> `"command": "node", "args": ["/ABS/PATH/ticketing-infra-360-mcp/dist/index.js"]`.

### Cursor

Create `.cursor/mcp.json` in your project (or use global Cursor settings) with the
**same shape** as the Claude Desktop JSON above. Reload Cursor.

### VS Code (Continue / MCP-capable extensions)

Add an MCP server entry pointing at the same `command`/`args`/`env`, then restart
the extension host. (Exact UI varies by extension.)

---

## 4. First use — log in once

In your agent, say:

> **"Log in to LinkIT360"**

A real browser window opens with your credentials pre-filled:

1. Solve the reCAPTCHA ("I'm not a robot").
2. Click **Login**.

The session is saved to `LINKIT_SESSION_PATH` and hot-reloaded into the running
server. **You won't need to do this again until the session expires.**

> Prefer the terminal? From source you can run `npm run login` (or
> `npx -p ticketing-infra-360-mcp ticketing-infra-360-login` with the env vars set) — same flow.

---

## 5. Verify it works

Ask your agent:

> "List the latest infra tickets in LinkIT360"

You should get live ticket rows back. ✅

Available tools: `login`, `check_session`, `logout`, `navigate`, `inspect_form`,
`get_field_options`, `get_page_content`, `screenshot`, `submit_form`,
`create_infra_ticket`, `list_tickets`, `list_services`. See the README for details.

---

## Updating

- **npx:** bump the version your config requests (or clear the npx cache:
  `npx clear-npx-cache`) — next launch fetches the new version.
- **source:** `git pull && npm install && npm run build`, then restart your agent.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Agent shows no LinkIT360 tools | Wrong path/command, or client not restarted. Verify absolute path to `dist/index.js`, then fully restart the client. |
| "Invalid environment configuration" | Missing `LINKIT_EMAIL`/`LINKIT_PASSWORD`/`LINKIT_BASE_URL` in the `env` block. |
| Login window never appears | Headless/remote machine (no display). Run on a desktop, or do `npm run login` on a machine with a display and copy the session file over. |
| "Login page is protected by reCAPTCHA…" on a tool call | Session expired — say "log in to LinkIT360" again. |
| Chromium not found | `npx playwright install chromium` (or reinstall). |
| Session not picked up after login | The default `~/.linkit360/session.json` is shared automatically. If you overrode `LINKIT_SESSION_PATH`, use the **same absolute path** in every config and make sure it's writable. |

---

## Security notes

- `LINKIT_SESSION_PATH` holds a **live login cookie** — treat it like a password.
  Each user logs in on their own machine; never share or commit it.
- Each user needs their **own** `LINKIT_EMAIL`/`LINKIT_PASSWORD`.
- Credentials live in your client's config `env` block (or `.env`, which is
  gitignored). Don't commit them.

---

## For maintainers — publishing to npm

```bash
# one-time: set the package name/registry (scope it if private)
#   "name": "@your-org/ticketing-infra-360-mcp"  + "publishConfig": { "access": "restricted" }
npm version patch            # bump version
npm publish                  # prepublishOnly runs the build automatically
```
After publishing, users install via the `npx`/`command:"npx"` configs above.
To distribute without a registry, use `npm pack` (tarball) or a git URL.
