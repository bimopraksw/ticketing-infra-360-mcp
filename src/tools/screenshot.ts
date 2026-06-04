import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { resolveUrl } from "../config.js";
import { withRetry } from "../utils/retry.js";

export function registerScreenshotTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "screenshot",
    {
      title: "Screenshot a page",
      description:
        "Authenticate if needed, open a page, and return a PNG screenshot as an " +
        "image. Useful for visually confirming a form or verifying the result of " +
        "a create/update operation.",
      inputSchema: {
        path: z.string().describe("Path relative to base URL or absolute URL."),
        fullPage: z
          .boolean()
          .optional()
          .describe("Capture the full scrollable page (default true)."),
      },
    },
    async ({ path, fullPage }) => {
      await ctx.auth.ensureAuthenticated();
      const url = resolveUrl(ctx.cfg.baseUrl, path);

      const png = await withRetry(
        () =>
          ctx.browser.withPage(async (page) => {
            await page.goto(url, { waitUntil: "domcontentloaded" });
            await page.waitForLoadState("networkidle").catch(() => undefined);
            return page.screenshot({
              type: "png",
              fullPage: fullPage ?? true,
            });
          }),
        { retries: ctx.cfg.maxRetries, label: "screenshot" },
      );

      return {
        content: [
          {
            type: "image",
            data: png.toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    },
  );
}
