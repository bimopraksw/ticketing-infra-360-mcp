import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { resolveUrl } from "../config.js";
import { withRetry } from "../utils/retry.js";

export function registerNavigateTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "navigate",
    {
      title: "Navigate",
      description:
        "Authenticate if needed, then navigate to a path or absolute URL on " +
        "LinkIT360. Returns the final URL, page title, and HTTP status. Useful " +
        "for confirming a page exists before inspecting or operating on it.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Path relative to the base URL (e.g. '/dashboard') or an absolute URL.",
          ),
      },
    },
    async ({ path }) => {
      await ctx.auth.ensureAuthenticated();
      const url = resolveUrl(ctx.cfg.baseUrl, path);
      const result = await withRetry(
        () =>
          ctx.browser.withPage(async (page) => {
            const response = await page.goto(url, { waitUntil: "domcontentloaded" });
            await page.waitForLoadState("networkidle").catch(() => undefined);
            return {
              requestedUrl: url,
              finalUrl: page.url(),
              title: await page.title(),
              status: response?.status() ?? null,
            };
          }),
        { retries: ctx.cfg.maxRetries, label: "navigate" },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
