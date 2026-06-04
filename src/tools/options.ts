import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { resolveUrl } from "../config.js";
import { withRetry } from "../utils/retry.js";
import { readOptions } from "../utils/forms.js";

/**
 * Returns the available options of one or more <select> fields on a page.
 *
 * This is the "propose choices to the user" tool: when a form has many
 * dropdowns with lots of options (e.g. the ~80-field service create form, or
 * country/company/recipient pickers), the model can call this to list the real
 * choices and ask the user to pick, instead of guessing a value.
 */
export function registerOptionsTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_field_options",
    {
      title: "Get a form field's options",
      description:
        "Authenticate, open a page, and return the available options (value + " +
        "label) for the given <select> field name(s). Use this to PROPOSE choices " +
        "to the user when a required dropdown value isn't specified — list the " +
        "options and let the user pick. Supports optional client-side filtering.",
      inputSchema: {
        path: z
          .string()
          .describe("Path/URL of the page with the form (e.g. /service/create, /ticketing-infra/create)."),
        fields: z
          .array(z.string())
          .min(1)
          .describe('Select field name(s), e.g. ["company","country","account_manager"].'),
        filter: z
          .string()
          .optional()
          .describe("Case-insensitive substring to filter option labels (helps with large lists)."),
        maxOptions: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max options to return per field (default 50). The total count is always reported."),
      },
    },
    async ({ path, fields, filter, maxOptions }) => {
      await ctx.auth.ensureAuthenticated();
      const url = resolveUrl(ctx.cfg.baseUrl, path);
      const limit = maxOptions ?? 50;
      const lc = filter?.toLowerCase();

      const result = await withRetry(
        () =>
          ctx.browser.withPage(async (page) => {
            await page.goto(url, { waitUntil: "networkidle" });
            const out: Record<string, unknown> = {};
            for (const name of fields) {
              // Resolve a single concrete selector (plain or array name).
              let selector: string | null = null;
              for (const cand of [`select[name="${name}"]`, `select[name="${name}[]"]`]) {
                if ((await page.locator(cand).count()) > 0) {
                  selector = cand;
                  break;
                }
              }
              if (!selector) {
                out[name] = {
                  error:
                    "select field not found. It may be a radio/text field, or populated " +
                    "by AJAX after another field (e.g. operator/service depend on country).",
                };
                continue;
              }
              const all = await readOptions(page, selector);
              const nonEmpty = all.filter((o) => o.value !== "");
              const filtered = lc
                ? nonEmpty.filter((o) => o.label.toLowerCase().includes(lc))
                : nonEmpty;
              out[name] = {
                totalOptions: nonEmpty.length,
                matched: filtered.length,
                options: filtered.slice(0, limit),
                truncated: filtered.length > limit,
              };
            }
            return { url: page.url(), fields: out };
          }),
        { retries: ctx.cfg.maxRetries, label: "get_field_options" },
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
