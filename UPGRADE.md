# Upgrade to v0.9.0: automatic login, no more captcha

From v0.9.0, when your LinkIT360 session expires the server logs in by itself in a
hidden browser (about a minute), so you never have to tick the captcha. It uses
[2Captcha](https://2captcha.com) to solve it, which needs one extra setting:
`TWOCAPTCHA_KEY`. Without the key everything keeps working the old way: the login
window opens and you tick the captcha yourself.

**Get the key from your team lead.** Keep it private: don't post it in a public
channel and never commit it to git.

---

## Fastest: paste one prompt into Claude Code

Put the key on the `TWOCAPTCHA_KEY` line, then paste the whole block into Claude
Code (any folder). It upgrades both Claude Code and Claude Desktop.

```text
Upgrade the LinkIT360 ticketing MCP server "ticketing-infra-360" on this computer
to the newest version and turn on automatic login. My 2Captcha key:

TWOCAPTCHA_KEY: paste-the-key-here

Steps:
1. Claude Desktop config (macOS: ~/Library/Application Support/Claude/claude_desktop_config.json,
   Windows: %APPDATA%\Claude\claude_desktop_config.json). If it has a "ticketing-infra-360"
   entry under "mcpServers": back the file up, then set "TWOCAPTCHA_KEY" to the key above
   inside that entry's "env" (next to LINKIT_PASSWORD). Change nothing else. Check that
   the file is still valid JSON.
2. Claude Code: run `claude mcp get ticketing-infra-360`. If it exists, note its scope,
   command, args and env, run `claude mcp remove ticketing-infra-360 -s <scope>`, then add
   it back in the same scope with `claude mcp add-json -s <scope> ticketing-infra-360 '<json>'`,
   using the same command, args and env plus TWOCAPTCHA_KEY.
3. If neither Claude Desktop nor Claude Code has the server, stop and tell me to install
   it first: https://github.com/bimopraksw/ticketing-infra-360-mcp/blob/main/INSTALL.md
4. If "args" is ["-y", "ticketing-infra-360-mcp"] (an npx install), there is nothing else
   to update: it loads the newest version when it starts. If it runs from a local folder
   (a git clone), run `git pull`, `npm install` and `npm run build` in that folder.
5. Restart Claude Desktop so it loads the new version and the key.
   macOS: `osascript -e 'quit app "Claude"'; sleep 5; open -a Claude`.
   Windows: tell me to quit it from the tray icon and open it again.
   If you are running inside the Claude Desktop app, don't quit it (that would end
   this chat); tell me to do it at the end instead.
6. Never print my password or keys back to me. When done, tell me what changed. Then
   tell me to type /mcp, pick ticketing-infra-360 and choose Reconnect (if it isn't
   listed, exit Claude Code and start it again with `claude -c`), and to ask
   "check my LinkIT360 session". It should show version 0.9.0 or newer and
   automaticLogin "2captcha".
```

---

## Or do it by hand

### Claude Desktop

1. Open the config file:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`

   (or in Claude Desktop: Settings, Developer, Edit Config).
2. In the `ticketing-infra-360` entry, add `TWOCAPTCHA_KEY` inside `env`, next to
   `LINKIT_PASSWORD`. Mind the comma after the line before it:

   ```json
   "env": {
     "LINKIT_BASE_URL": "https://report.linkit360.com",
     "LINKIT_EMAIL": "you@linkit360.com",
     "LINKIT_PASSWORD": "your-password",
     "TWOCAPTCHA_KEY": "paste-the-key-here"
   }
   ```
3. Save, then quit Claude Desktop completely (macOS: Cmd+Q; Windows: right click the
   tray icon, Quit) and open it again. Closing the window is not enough.

### Claude Code

Add the server again with the key (use your own email and password):

```bash
claude mcp remove ticketing-infra-360
claude mcp add ticketing-infra-360 \
  -e LINKIT_BASE_URL=https://report.linkit360.com \
  -e LINKIT_EMAIL=you@linkit360.com \
  -e LINKIT_PASSWORD=your-password \
  -e TWOCAPTCHA_KEY=paste-the-key-here \
  -- npx -y ticketing-infra-360-mcp
```

Then type `/mcp`, pick `ticketing-infra-360` and choose **Reconnect**.

---

## Check that it works

Ask Claude: **"check my LinkIT360 session"**. You should see:

- `version` 0.9.0 or newer
- `automaticLogin`: `"2captcha"`

Next time the session expires, Claude logs in by itself in about a minute. If
2Captcha can't do it for some reason, the normal login window opens as before.

## If something is off

| What you see | Fix |
|---|---|
| `automaticLogin` is `"off"` | The key isn't in the `env` of the config Claude uses, or Claude wasn't restarted. |
| `automaticLogin` is `"nopecha-token"` | Only the old `NOPECHA_KEY` is set. Add `TWOCAPTCHA_KEY`. You can delete `NOPECHA_KEY`: NopeCHA never passed the LinkIT360 captcha. |
| `version` is older than 0.9.0 | npx used a cached copy. Run `npx clear-npx-cache`, then restart Claude. |
| Login says "2Captcha: ... Check TWOCAPTCHA_KEY" | The key is wrong or has extra spaces. Copy it again. |
| Login says the 2Captcha balance is empty | Ask your team lead to top up the 2Captcha account. |
