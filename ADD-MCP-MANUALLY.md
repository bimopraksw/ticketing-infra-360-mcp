# Add the Ticketing-Infra-360 MCP server manually

This is a **client-by-client, copy-paste** reference for registering the
Ticketing-Infra-360 MCP server **by hand** — by editing each app's JSON config
file directly, rather than through a CLI helper.

> New here? Read [INSTALL.md](INSTALL.md) first to **install** the server
> (`npx` or from source) and to log in once. This file only covers **wiring it
> into a client's config file**.

---

## TL;DR — the one config block everything reuses

Every MCP client wants the same three things: a **command**, its **args**, and an
**env** block. For this server the block is:

```json
{
  "command": "npx",
  "args": ["-y", "ticketing-infra-360-mcp"],
  "env": {
    "LINKIT_BASE_URL": "https://report.linkit360.com",
    "LINKIT_EMAIL": "you@linkit360.com",
    "LINKIT_PASSWORD": "your-password"
  }
}
```

> `LINKIT_SESSION_PATH` is **optional** — leave it out and the server stores
> your login at `~/.linkit360/session.json`. Only add it if you want a
> different (absolute) location.

**Installed from source instead of npx?** Swap the first two lines for an
absolute path to the built entry point:

```json
  "command": "node",
  "args": ["/ABS/PATH/ticketing-infra-360-mcp/dist/index.js"],
```

Everything below is just *where each client wants this block pasted*.

---

## Environment variables

| Variable | Required | Example / default |
|---|---|---|
| `LINKIT_BASE_URL` | ✅ | `https://report.linkit360.com` |
| `LINKIT_EMAIL` | ✅ | `you@linkit360.com` |
| `LINKIT_PASSWORD` | ✅ | `your-password` |
| `LINKIT_SESSION_PATH` | optional | defaults to `~/.linkit360/session.json`; override with an **absolute** path |
| `LINKIT_LOGIN_PATH` | optional | default `/login` |
| `LINKIT_HEADLESS` | optional | default `true` (the **login** flow always shows a window so you can solve the reCAPTCHA) |
| `LINKIT_TIMEOUT_MS` | optional | default `30000` |
| `LINKIT_MAX_RETRIES` | optional | default `2` |
| `LINKIT_LOCALE` | optional | default `en-US` |
| `LINKIT_LOG_LEVEL` | optional | `error` \| `warn` \| `info` \| `debug` (default `info`) |

> **Always use absolute paths** (if you override `LINKIT_SESSION_PATH`, and for
> `dist/index.js`). Clients launch the server from unpredictable working
> directories, so relative paths silently break. The built-in default
> (`~/.linkit360/session.json`) is already absolute, so leaving it unset is safe.

---

## Claude Desktop

1. Open the config file (create it if missing):
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
   - **Linux:** `~/.config/Claude/claude_desktop_config.json`

   > Shortcut: in the app, **Settings → Developer → Edit Config** opens this file.

2. Add the server under `mcpServers` (merge if the file already has entries):

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

3. **Fully quit and reopen** Claude Desktop (not just close the window — quit it
   completely, then relaunch).

4. Confirm: the 🔌 / tools icon should list `ticketing-infra-360` tools.

> **Windows + npx gotcha:** if the server won't start, set
> `"command": "cmd"` and
> `"args": ["/c", "npx", "-y", "ticketing-infra-360-mcp"]`.

---

## Claude Code (CLI)

Claude Code stores MCP servers in `.mcp.json` (project) or `~/.claude.json`
(global). You can write it by hand:

`.mcp.json` in your project root:

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

Then run `claude mcp list` to verify. (Prefer the CLI? `claude mcp add … -- npx -y
ticketing-infra-360-mcp` — see [INSTALL.md](INSTALL.md).)

---

## Cursor

1. Create **`.cursor/mcp.json`** in your project (project-scoped), or
   `~/.cursor/mcp.json` (global, all projects).
2. Paste the **same `mcpServers` shape** as Claude Desktop above.
3. **Cursor → Settings → MCP** → toggle the server on / hit **Refresh**.

---

## VS Code (Copilot / agent mode, ≥ 1.102)

VS Code reads MCP servers from **`.vscode/mcp.json`** (note: top-level key is
`servers`, not `mcpServers`):

```json
{
  "servers": {
    "ticketing-infra-360": {
      "type": "stdio",
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

Open the file and click **Start** above the server entry, or run **MCP: List
Servers** from the Command Palette.

> Want to avoid hard-coding the password? VS Code supports `"inputs"` prompts —
> see the VS Code MCP docs. The plain `env` block above is the simplest start.

---

## Windsurf / Codeium

Edit `~/.codeium/windsurf/mcp_config.json` and use the **same `mcpServers`
shape** as Claude Desktop. Then **Windsurf Settings → Cascade → MCP → Refresh**.

---

## Continue (`.continue` extension)

In `~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: ticketing-infra-360
    command: npx
    args: ["-y", "ticketing-infra-360-mcp"]
    env:
      LINKIT_BASE_URL: https://report.linkit360.com
      LINKIT_EMAIL: you@linkit360.com
      LINKIT_PASSWORD: your-password
```

---

## Zed

In `settings.json` (`Cmd/Ctrl ,`):

```json
{
  "context_servers": {
    "ticketing-infra-360": {
      "command": {
        "path": "npx",
        "args": ["-y", "ticketing-infra-360-mcp"],
        "env": {
          "LINKIT_BASE_URL": "https://report.linkit360.com",
          "LINKIT_EMAIL": "you@linkit360.com",
          "LINKIT_PASSWORD": "your-password"
        }
      }
    }
  }
}
```

---

## Any other MCP client

This is a standard **stdio** MCP server. Any compliant client works — give it:

- **Transport:** `stdio`
- **Command:** `npx`  ·  **Args:** `["-y", "ticketing-infra-360-mcp"]`
  *(or `node` + `["/ABS/PATH/.../dist/index.js"]` from source)*
- **Env:** the `LINKIT_*` variables above

---

## After editing any config

1. **Restart the client** (Claude Desktop must be *fully quit*, not just closed).
2. The first time, tell the agent **"Log in to LinkIT360"** — a browser opens so
   you can solve the reCAPTCHA once; the session is saved to
   `LINKIT_SESSION_PATH`. (See [INSTALL.md §4](INSTALL.md).)
3. Verify with **"List the latest infra tickets in LinkIT360."**

**Available tools:** `login`, `check_session`, `logout`, `navigate`,
`inspect_form`, `get_field_options`, `get_page_content`, `screenshot`,
`submit_form`, `create_infra_ticket`, `list_tickets`, `list_services`.

---

## Quick troubleshooting

| Symptom | Fix |
|---|---|
| No LinkIT360 tools appear | Wrong key (`servers` vs `mcpServers` vs `context_servers`), bad JSON, or client not fully restarted. Validate the JSON, restart the client. |
| `"Invalid environment configuration"` | A required `LINKIT_*` var is missing from the `env` block. |
| Server won't launch on Windows | Use `"command": "cmd", "args": ["/c", "npx", "-y", "ticketing-infra-360-mcp"]`. |
| Login window never opens | Headless/remote box with no display — run on a desktop, or `npm run login` elsewhere and copy `session.json` over. |
| "protected by reCAPTCHA" on a tool call | Session expired — say "log in to LinkIT360" again. |
| Session ignored after login | The default `~/.linkit360/session.json` is shared across clients automatically. If you overrode `LINKIT_SESSION_PATH`, use the **same absolute** path everywhere and ensure it's writable. |

See [INSTALL.md](INSTALL.md) for the full install + login walkthrough and
maintainer/publishing notes.

---

## Security

`LINKIT_SESSION_PATH` holds a **live login cookie** — treat it like a password.
Each user logs in with their **own** `LINKIT_EMAIL`/`LINKIT_PASSWORD` on their
own machine. Never commit credentials or the session file.
