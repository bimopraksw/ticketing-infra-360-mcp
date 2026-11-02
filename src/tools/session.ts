import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { logger } from "../logger.js";

export function registerSessionTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "check_session",
    {
      title: "Check session",
      description:
        "Check whether the MCP server currently has a valid authenticated " +
        "session with LinkIT360, and WHICH account it is logged in as. Does not log in. " +
        "Returns authenticated, loggedInAs, configuredAccount (LINKIT_EMAIL) and accountMatches, " +
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
              { authenticated, loggedInAs, configuredAccount, accountMatches, baseUrl: ctx.cfg.baseUrl, version },
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
        "(unless force=true). Otherwise, because the login page uses reCAPTCHA, this " +
        "opens a REAL browser window on the user's machine with credentials pre-filled " +
        "— the user solves the captcha and clicks Login, then the session is saved and " +
        "reused for all future calls. Tell the user to complete the login in the window " +
        "that appears. Requires a graphical display on the server machine.",
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .describe("Force a fresh login even if a valid session exists."),
        interactive: z
          .boolean()
          .optional()
          .describe(
            "Open a visible browser for manual captcha solving (default true). " +
              "Set false only for captcha-free sites to attempt a headless form login.",
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

      const useInteractive = interactive ?? true;
      const result = useInteractive
        ? await ctx.auth.interactiveLogin((timeoutSeconds ?? 180) * 1000)
        : await ctx.auth.login(Boolean(force));

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
