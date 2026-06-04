import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { resolveUrl } from "../config.js";
import { withRetry } from "../utils/retry.js";

export function registerContentTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_page_content",
    {
      title: "Get page content",
      description:
        "Authenticate if needed, open a page, and return its visible text, " +
        "links, and any data tables. Useful for reading dashboards/reports and " +
        "for discovering navigation paths to record pages.",
      inputSchema: {
        path: z
          .string()
          .describe("Path relative to base URL or absolute URL."),
        maxChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Truncate visible text to this many characters (default 8000)."),
      },
    },
    async ({ path, maxChars }) => {
      await ctx.auth.ensureAuthenticated();
      const url = resolveUrl(ctx.cfg.baseUrl, path);
      const limit = maxChars ?? 8000;

      const result = await withRetry(
        () =>
          ctx.browser.withPage(async (page) => {
            await page.goto(url, { waitUntil: "domcontentloaded" });
            await page.waitForLoadState("networkidle").catch(() => undefined);

            const data = await page.evaluate(() => {
              const text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n");
              const links = Array.from(document.querySelectorAll("a[href]"))
                .map((a) => ({
                  text: (a.textContent || "").trim().replace(/\s+/g, " "),
                  href: (a as HTMLAnchorElement).getAttribute("href") || "",
                }))
                .filter((l) => l.href && !l.href.startsWith("javascript:"))
                .slice(0, 200);

              const tables = Array.from(document.querySelectorAll("table"))
                .slice(0, 10)
                .map((t) => {
                  const headers = Array.from(t.querySelectorAll("thead th, tr:first-child th")).map(
                    (h) => (h.textContent || "").trim(),
                  );
                  const rows = Array.from(t.querySelectorAll("tbody tr"))
                    .slice(0, 50)
                    .map((tr) =>
                      Array.from(tr.querySelectorAll("td")).map((td) =>
                        (td.textContent || "").trim().replace(/\s+/g, " "),
                      ),
                    );
                  return { headers, rows };
                });

              return { text, links, tables };
            });

            return {
              url: page.url(),
              title: await page.title(),
              text: data.text.slice(0, limit),
              truncated: data.text.length > limit,
              links: data.links,
              tables: data.tables,
            };
          }),
        { retries: ctx.cfg.maxRetries, label: "get_page_content" },
      );

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
