import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { logger } from "../logger.js";
import { COMPUTER_NAME } from "../utils/requester-guard.js";

export function registerSessionTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "check_session",
    {
      title: "Check session",
      description:
        "Check whether the MCP server currently has a valid authenticated " +
        "session with LinkIT360, and WHICH account it is logged in as. Does not log in. " +
        "Returns authenticated, loggedInAs, configuredAccount (LINKIT_EMAIL), accountMatches, " +
        "and the name of the computer this MCP runs on (tickets are filed under that computer's account), " +
        "plus this MCP's version, the latest released version, and how to update if it's behind. " +
        "Use it when the user asks which version they run or whether an update is available.",
      inputSchema: {},
    },
    async () => {
      const authenticated = await ctx.auth.isAuthenticated();
      const loggedInAs = authenticated ? await ctx.auth.sessionAccount() : null;
      const configuredAccount = ctx.cfg.email;
      const accountMatches =
        loggedInAs === null ? null : loggedInAs.toLowerCase() === configuredAccount.trim().toLowerCase();
      const v = ctx.version.getStatus();
      const version = {
        ...v,
        howToUpdate: v.updateAvailable || v.belowMinimum ? ctx.version.howToUpdate() : undefined,
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                authenticated,
                loggedInAs,
                configuredAccount,
                accountMatches,
                computer: COMPUTER_NAME,
                writesCheckRequester: ctx.cfg.checkRequester,
                baseUrl: ctx.cfg.baseUrl,
                version,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "login",
    {
      title: "Log in",
      description:
        "Authenticate with LinkIT360. If a valid saved session exists it is reused " +
        "(unless force=true). Otherwise it logs in automatically: a hidden browser solves " +
        "the reCAPTCHA with the NopeCHA solver (takes up to about a minute, nothing for the " +
        "user to do). Only if that fails does it open a REAL browser window with credentials " +
        "pre-filled, where the user solves the captcha; then tell the user to complete the " +
        "login in that window. The session is saved and reused for all future calls.",
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .describe("Force a fresh login even if a valid session exists."),
        interactive: z
          .boolean()
          .optional()
          .describe(
            "true: skip the automatic attempt and open the visible browser for manual captcha " +
              "solving right away. Leave unset normally (automatic first, window as fallback). " +
              "false: no window at all (automatic attempt, then a headless form login).",
          ),
        timeoutSeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How long to wait for the user to finish manual login (default 180)."),
      },
    },
    async ({ force, interactive, timeoutSeconds }) => {
      // Reuse a valid session unless forced.
      if (!force && (await ctx.auth.isAuthenticatedAsConfiguredAccount())) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { success: true, reused: true, message: "Existing session is valid." },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Automatic first (hidden browser + captcha solver), unless the caller
      // explicitly asked for the manual window.
      let automaticLoginError: string | undefined;
      if (interactive !== true && ctx.auth.solverAvailable()) {
        try {
          const result = await ctx.auth.solverLogin();
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
          automaticLoginError = e instanceof Error ? e.message : String(e);
        }
      }

      const automaticLogin = automaticLoginError
        ? `failed: ${automaticLoginError}`
        : ctx.auth.solverAvailable()
          ? undefined
          : "off: add NOPECHA_KEY (ask your team lead, or get one at https://nopecha.com) to the MCP env config to skip the captcha";
      const useInteractive = interactive ?? true;
      let result;
      try {
        result = useInteractive
          ? await ctx.auth.interactiveLogin((timeoutSeconds ?? 180) * 1000)
          : await ctx.auth.login(Boolean(force));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(automaticLogin ? `${msg} (Automatic login ${automaticLogin})` : msg);
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ ...result, automaticLogin }, null, 2) }],
      };
    },
  );

  server.registerTool(
    "logout",
    {
      title: "Log out",
      description:
        "Clear the persisted LinkIT360 session (cookies). The next operation " +
        "will require a fresh login.",
      inputSchema: {},
    },
    async () => {
      await ctx.browser.clearSession();
      logger.info("Session cleared via logout tool");
      return {
        content: [{ type: "text", text: "Session cleared." }],
      };
    },
  );
}
