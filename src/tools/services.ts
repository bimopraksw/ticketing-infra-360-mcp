import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { resolveUrl } from "../config.js";
import { withRetry } from "../utils/retry.js";
import { extractDataTable } from "../utils/datatable.js";

export function registerServiceTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "list_services",
    {
      title: "List / search services",
      description:
        "List services from /service/list (DataTable). Optional global `search` " +
        "filters across columns. Returns rows keyed by column header.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Global search string (server-side filter)."),
        maxRows: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum rows to return (default 25)."),
      },
    },
    async ({ search, maxRows }) => {
      await ctx.auth.ensureAuthenticated();
      const url = resolveUrl(ctx.cfg.baseUrl, "/service/list");

      const result = await withRetry(
        () =>
          ctx.browser.withPage(async (page) => {
            await page.goto(url, { waitUntil: "networkidle" });
            const table = await extractDataTable(page, { search, maxRows });
            return { url: page.url(), ...table };
          }),
        { retries: ctx.cfg.maxRetries, label: "list_services" },
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
