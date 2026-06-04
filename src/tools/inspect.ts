import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { resolveUrl } from "../config.js";
import { withRetry } from "../utils/retry.js";

/**
 * `inspect_form` is the schema-discovery tool. It loads a page and extracts a
 * structured description of every form and field — name, a stable CSS
 * selector, type, label, whether it's required, and select/radio options.
 * This is what lets us build accurate create/update tools without the user
 * hand-copying HTML.
 */
export function registerInspectTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "inspect_form",
    {
      title: "Inspect forms on a page",
      description:
        "Authenticate if needed, open a page, and return a structured " +
        "description of every <form> and its fields (name, CSS selector, type, " +
        "label, required, options for selects/radios, and the form's action/method). " +
        "Use this to discover the create/update record schema.",
      inputSchema: {
        path: z
          .string()
          .describe("Path relative to base URL (e.g. '/reports/create') or absolute URL."),
        includeHidden: z
          .boolean()
          .optional()
          .describe("Include hidden inputs (e.g. CSRF tokens). Default false."),
      },
    },
    async ({ path, includeHidden }) => {
      await ctx.auth.ensureAuthenticated();
      const url = resolveUrl(ctx.cfg.baseUrl, path);

      const result = await withRetry(
        () =>
          ctx.browser.withPage(async (page) => {
            await page.goto(url, { waitUntil: "domcontentloaded" });
            await page.waitForLoadState("networkidle").catch(() => undefined);

            const forms = await page.evaluate((opts) => {
              const includeHiddenInputs = opts.includeHidden;

              // Build a CSS selector that uniquely-ish identifies an element.
              function selectorFor(el: Element): string {
                const name = el.getAttribute("name");
                if (name) {
                  const tag = el.tagName.toLowerCase();
                  return `${tag}[name="${name}"]`;
                }
                if (el.id) return `#${CSS.escape(el.id)}`;
                const cls = (el.getAttribute("class") || "")
                  .split(/\s+/)
                  .filter(Boolean)
                  .map((c) => `.${CSS.escape(c)}`)
                  .join("");
                return `${el.tagName.toLowerCase()}${cls}`;
              }

              // Resolve a human label for a field.
              function labelFor(el: Element): string | null {
                const id = el.getAttribute("id");
                if (id) {
                  const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
                  if (lbl?.textContent) return lbl.textContent.trim().replace(/\s+/g, " ");
                }
                const parentLabel = el.closest("label");
                if (parentLabel?.textContent) {
                  return parentLabel.textContent.trim().replace(/\s+/g, " ");
                }
                const aria = el.getAttribute("aria-label");
                if (aria) return aria.trim();
                const ph = el.getAttribute("placeholder");
                if (ph) return ph.trim();
                return null;
              }

              function describeField(el: Element) {
                const tag = el.tagName.toLowerCase();
                const type =
                  tag === "select"
                    ? "select"
                    : tag === "textarea"
                      ? "textarea"
                      : (el.getAttribute("type") || "text").toLowerCase();

                const field: Record<string, unknown> = {
                  name: el.getAttribute("name") || null,
                  selector: selectorFor(el),
                  tag,
                  type,
                  label: labelFor(el),
                  required:
                    el.hasAttribute("required") ||
                    el.getAttribute("aria-required") === "true",
                  value: (el as HTMLInputElement).value || null,
                  placeholder: el.getAttribute("placeholder") || null,
                };

                if (tag === "select") {
                  field.options = Array.from((el as HTMLSelectElement).options).map((o) => ({
                    value: o.value,
                    label: o.textContent?.trim() || "",
                    selected: o.selected,
                  }));
                  field.multiple = (el as HTMLSelectElement).multiple;
                }
                return field;
              }

              const formEls = Array.from(document.querySelectorAll("form"));
              const result = formEls.map((form, idx) => {
                const fieldEls = Array.from(
                  form.querySelectorAll("input, select, textarea"),
                ).filter((el) => {
                  const type = (el.getAttribute("type") || "").toLowerCase();
                  if (!includeHiddenInputs && type === "hidden") return false;
                  return true;
                });

                // Radio groups share a name; collapse them with their options.
                const seenRadioGroups = new Set<string>();
                const fields: ReturnType<typeof describeField>[] = [];
                for (const el of fieldEls) {
                  const type = (el.getAttribute("type") || "").toLowerCase();
                  const name = el.getAttribute("name");
                  if (type === "radio" && name) {
                    if (seenRadioGroups.has(name)) continue;
                    seenRadioGroups.add(name);
                    const group = Array.from(
                      form.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`),
                    );
                    const base = describeField(el);
                    base.type = "radio";
                    base.options = group.map((g) => ({
                      value: (g as HTMLInputElement).value,
                      label: labelFor(g),
                      checked: (g as HTMLInputElement).checked,
                    }));
                    fields.push(base);
                  } else {
                    fields.push(describeField(el));
                  }
                }

                const submit = form.querySelector(
                  'button[type="submit"], input[type="submit"], button:not([type])',
                );

                return {
                  index: idx,
                  id: form.getAttribute("id") || null,
                  name: form.getAttribute("name") || null,
                  action: form.getAttribute("action") || null,
                  method: (form.getAttribute("method") || "get").toLowerCase(),
                  submitSelector: submit
                    ? submit.id
                      ? `#${CSS.escape(submit.id)}`
                      : submit.tagName.toLowerCase() +
                        ((submit.getAttribute("type") &&
                          `[type="${submit.getAttribute("type")}"]`) ||
                          "")
                    : null,
                  submitText: submit?.textContent?.trim() || null,
                  fields,
                };
              });
              return result;
            }, { includeHidden: Boolean(includeHidden) });

            return {
              url: page.url(),
              title: await page.title(),
              formCount: forms.length,
              forms,
            };
          }),
        { retries: ctx.cfg.maxRetries, label: "inspect_form" },
      );

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
