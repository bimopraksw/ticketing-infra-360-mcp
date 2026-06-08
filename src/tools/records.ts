import { z } from "zod";
import type { Page } from "playwright";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { resolveUrl } from "../config.js";
import { withRetry } from "../utils/retry.js";
import { logger } from "../logger.js";
import { selectByLabelOrValue, multiSelectByLabelOrValue, setRadio } from "../utils/forms.js";

/**
 * Generic, fully-functional form writer used for create AND update.
 *
 * It is intentionally schema-agnostic: the caller supplies a list of field
 * operations keyed by CSS selector (as discovered via `inspect_form`). Once
 * the concrete LinkIT360 record form is confirmed, a thin typed
 * `create_record` / `update_record` wrapper can call this with a fixed field
 * map. Nothing here is a placeholder — it drives the real form.
 */

const FieldOp = z.object({
  selector: z
    .string()
    .describe('CSS selector for the field, e.g. \'input[name="title"]\' (from inspect_form).'),
  value: z
    .string()
    .describe(
      "Value to set. For checkboxes use 'true'/'false'. For selects, the option " +
        "value or visible label. For radios, the option value.",
    ),
  kind: z
    .enum(["text", "select", "checkbox", "radio", "file"])
    .optional()
    .describe("Field kind. Defaults to 'text'. Use 'select'/'checkbox'/'radio' as appropriate."),
});

async function applyField(page: Page, op: z.infer<typeof FieldOp>): Promise<void> {
  const locator = page.locator(op.selector).first();
  await locator.waitFor({ state: "attached" });

  // Inspect the real element so we can route correctly even when the caller
  // didn't pass `kind` (e.g. a <select> mistakenly left as the default "text").
  const meta = await locator.evaluate((el) => ({
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute("type") || "").toLowerCase(),
    name: el.getAttribute("name") || "",
    multiple: (el as HTMLSelectElement).multiple === true,
  }));

  let kind = op.kind;
  if (!kind) {
    if (meta.tag === "select") kind = "select";
    else if (meta.type === "checkbox") kind = "checkbox";
    else if (meta.type === "radio") kind = "radio";
    else kind = "text";
  }

  switch (kind) {
    case "select": {
      // Use the select2-aware setter (jQuery val + trigger('change'), native
      // fallback) so custom widgets like Select2 actually sync — Playwright's
      // raw selectOption does not update the widget's internal model.
      if (meta.multiple) {
        await multiSelectByLabelOrValue(
          page,
          op.selector,
          op.value.split(",").map((v) => v.trim()).filter(Boolean),
        );
      } else {
        await selectByLabelOrValue(page, op.selector, op.value);
      }
      break;
    }
    case "checkbox": {
      const checked = /^(true|1|yes|on)$/i.test(op.value);
      await locator.setChecked(checked);
      break;
    }
    case "radio": {
      // setRadio fires the element's onclick handler (toggleFields, etc.) which
      // a plain .check() can miss on custom-styled radios.
      if (meta.name) {
        await setRadio(page, meta.name, op.value);
      } else {
        const exact = page.locator(`${op.selector}[value="${op.value}"]`).first();
        if ((await exact.count()) > 0) await exact.check();
        else await locator.check();
      }
      break;
    }
    case "file": {
      await locator.setInputFiles(op.value);
      break;
    }
    case "text":
    default: {
      await locator.fill(op.value);
      break;
    }
  }
}

/** Pull validation / success / error messages off the page after submit. */
async function collectMessages(page: Page): Promise<{
  errors: string[];
  notices: string[];
}> {
  return page.evaluate(() => {
    const grab = (selectors: string[]) => {
      const out: string[] = [];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          const t = (el.textContent || "").trim().replace(/\s+/g, " ");
          if (t) out.push(t.slice(0, 300));
        });
      }
      return Array.from(new Set(out));
    };
    return {
      errors: grab([".alert-danger", ".invalid-feedback", ".text-danger", ".is-invalid + *"]),
      notices: grab([".alert-success", ".alert-info", ".toast", '[role="status"]']),
    };
  });
}

export function registerRecordTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "submit_form",
    {
      title: "Fill and submit a form (create/update)",
      description:
        "Authenticate, open a page containing a form, fill the provided fields, " +
        "and submit it. Works for both creating and updating records — point it " +
        "at the create page or an edit page. Field selectors come from " +
        "`inspect_form`. Returns the final URL plus any success/validation " +
        "messages so you can confirm the write succeeded.",
      inputSchema: {
        path: z
          .string()
          .describe("Path/URL of the page with the form (create or edit page)."),
        fields: z.array(FieldOp).describe("Fields to set before submitting."),
        submitSelector: z
          .string()
          .optional()
          .describe(
            'CSS selector for the submit control (from inspect_form). ' +
              'Defaults to button[type="submit"], input[type="submit"].',
          ),
        expectSuccessUrl: z
          .string()
          .optional()
          .describe(
            "Substring expected in the URL after a successful submit (e.g. the " +
              "list page). If provided, success requires the URL to contain it.",
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "If true, fill the fields but DO NOT submit — returns the filled " +
              "state for review. Strongly recommended for the first attempt.",
          ),
      },
    },
    async ({ path, fields, submitSelector, expectSuccessUrl, dryRun }) => {
      await ctx.auth.ensureAuthenticated();
      const url = resolveUrl(ctx.cfg.baseUrl, path);

      const result = await withRetry(
        () =>
          ctx.browser.withPage(async (page) => {
            await page.goto(url, { waitUntil: "domcontentloaded" });
            await page.waitForLoadState("networkidle").catch(() => undefined);

            const applied: string[] = [];
            for (const field of fields) {
              await applyField(page, field);
              applied.push(field.selector);
            }

            if (dryRun) {
              logger.info("submit_form dry-run — not submitting", { applied });
              return {
                dryRun: true,
                url: page.url(),
                appliedFields: applied,
                note: "Fields filled but form not submitted. Set dryRun=false to submit.",
              };
            }

            const submitSel =
              submitSelector || 'button[type="submit"], input[type="submit"]';

            const urlBefore = page.url();
            await Promise.all([
              page.waitForLoadState("networkidle").catch(() => undefined),
              page.locator(submitSel).first().click(),
            ]);
            // Give redirects/AJAX a moment to settle.
            await page.waitForLoadState("networkidle").catch(() => undefined);

            const finalUrl = page.url();
            const messages = await collectMessages(page);
            const navigated = finalUrl !== urlBefore;

            const success = expectSuccessUrl
              ? finalUrl.includes(expectSuccessUrl)
              : messages.errors.length === 0 && (navigated || messages.notices.length > 0);

            return {
              dryRun: false,
              submitted: true,
              urlBefore,
              finalUrl,
              navigated,
              appliedFields: applied,
              success,
              errors: messages.errors,
              notices: messages.notices,
            };
          }),
        { retries: ctx.cfg.maxRetries, label: "submit_form" },
      );

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
