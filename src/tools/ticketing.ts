import { z } from "zod";
import type { Page } from "playwright";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { resolveUrl } from "../config.js";
import { withRetry } from "../utils/retry.js";
import { logger } from "../logger.js";
import {
  selectByLabelOrValue,
  multiSelectByLabelOrValue,
  setRadio,
  readOptions,
} from "../utils/forms.js";
import { extractDataTable } from "../utils/datatable.js";
import { makeTextPdf } from "../utils/pdf.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Ticketing modules share the same UI structure. */
const MODULES = ["infra", "creative", "media", "legal"] as const;
type Module = (typeof MODULES)[number];

/** Required subject prefix enforced by the infra form's validation. */
const INFRA_SUBJECT_PREFIX = "LinkIT - Infra - ";

const CLASSIFICATION: Record<string, string> = {
  P0: "1",
  P1: "2",
  P2: "3",
  P3: "4",
  P4: "5",
};

const INFRA_CATEGORY: Record<string, string> = {
  "Item / Hardware": "1",
  Email: "2",
  Server: "3",
  "Domain/Pointing IP/Website": "4",
  Other: "5",
};

async function collectMessages(page: Page): Promise<{ errors: string[]; notices: string[] }> {
  return page.evaluate(() => {
    // Only collect VISIBLE messages. These forms keep hidden template error
    // spans (class "gu-hide" / display:none) in the DOM, e.g.
    // <span class="text-danger gu-hide">Please select at least one recipient.</span>.
    // Reading those produces false positives, so we filter by visibility.
    const isVisible = (el: Element): boolean => {
      const he = el as HTMLElement;
      if (he.classList.contains("gu-hide")) return false;
      if (he.offsetParent === null && getComputedStyle(he).position !== "fixed") return false;
      const style = getComputedStyle(he);
      return style.display !== "none" && style.visibility !== "hidden" && he.offsetHeight > 0;
    };
    const grab = (sels: string[]) => {
      const out: string[] = [];
      for (const s of sels)
        document.querySelectorAll(s).forEach((el) => {
          if (!isVisible(el)) return;
          const t = (el.textContent || "").trim().replace(/\s+/g, " ");
          if (t) out.push(t.slice(0, 300));
        });
      return Array.from(new Set(out));
    };
    return {
      errors: grab([".alert-danger", ".invalid-feedback", ".text-danger", ".is-invalid ~ .invalid-feedback"]),
      notices: grab([".alert-success", ".alert-info", ".toast-success", '[role="status"]']),
    };
  });
}

export function registerTicketingTools(server: McpServer, ctx: AppContext): void {
  // -------------------------------------------------------------------------
  // create_infra_ticket  (PRIORITY — fully typed)
  // -------------------------------------------------------------------------
  server.registerTool(
    "create_infra_ticket",
    {
      title: "Create an Infra ticket",
      description:
        "Create a new IT/Infrastructure ticket (POST /ticketing-infra/request). " +
        "Dropdown inputs accept either the visible label (e.g. company 'LinkIT.MENA', " +
        "a country name) or the raw option value; they are resolved against the live " +
        "form. The subject is auto-prefixed with 'LinkIT - Infra - ' (required by the " +
        "form). `serviceType` is REQUIRED — if the user hasn't said whether the ticket " +
        "is for a 'service' or a 'project', ASK them; do not guess. At least one " +
        "attachment is required: pass `files`, or pass `attachmentText` (or rely on " +
        "requestDetail) and a neat PDF is generated automatically. Use dryRun=true first.",
      inputSchema: {
        subject: z
          .string()
          .min(1)
          .describe("Ticket subject/title (auto-prefixed with 'LinkIT - Infra - ')."),
        category: z
          .enum(["Item / Hardware", "Email", "Server", "Domain/Pointing IP/Website", "Other"])
          .describe("Ticket category."),
        otherCategory: z
          .string()
          .optional()
          .describe("Free-text category, required when category is 'Other'."),
        company: z.string().describe("Company label (e.g. 'LinkIT.MENA') or value."),
        serviceType: z
          .enum(["service", "project"])
          .describe(
            "REQUIRED. Whether this ticket is for a 'service' or a 'project'. If the " +
              "user did not specify, ask them — do not default. When 'service', operator " +
              "and service are required (if the category needs a country); when 'project', " +
              "the project name is required.",
          ),
        classification: z
          .enum(["P0", "P1", "P2", "P3", "P4"])
          .describe("Priority classification (P0 highest)."),
        requestDetail: z.string().min(1).describe("Detailed description of the request."),
        sentTo: z
          .array(z.string())
          .default(["it.support@linkit360.com", "infra@linkit360.com"])
          .describe(
            "Recipient emails (or names) to send the ticket to. Defaults to BOTH " +
              "it.support@linkit360.com and infra@linkit360.com.",
          ),
        ccEmail: z.array(z.string()).optional().describe("CC recipient emails/names."),
        country: z.string().optional().describe("Country label or value."),
        project: z.string().optional().describe("Project name (required when serviceType='project')."),
        operator: z
          .string()
          .optional()
          .describe("Operator label/value (populated after country; required when serviceType='service' for country categories)."),
        service: z
          .string()
          .optional()
          .describe("Service label/value (populated after operator; required when serviceType='service' for country categories)."),
        files: z
          .array(z.string())
          .optional()
          .describe(
            "Absolute paths of attachment files (JPEG/PNG/PDF/DOC/DOCX/XLS/XLSX, <10MB total). " +
              "If omitted, a PDF is generated from attachmentText/requestDetail.",
          ),
        attachmentText: z
          .string()
          .optional()
          .describe(
            "When no `files` are given, generate a PDF attachment from this text. " +
              "Provide an AI-polished, neat version of the request here WITHOUT changing " +
              "the core details. Falls back to requestDetail if omitted.",
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe("Fill the form but DO NOT submit. Strongly recommended first."),
      },
    },
    async (input) => {
      await ctx.auth.ensureAuthenticated();
      const url = resolveUrl(ctx.cfg.baseUrl, "/ticketing-infra/create");

      const result = await withRetry(
        () =>
          ctx.browser.withPage(async (page) => {
            await page.goto(url, { waitUntil: "networkidle" });

            const applied: Record<string, unknown> = {};

            // category — changing it fires AJAX that sets categoryCheckCountry
            // and may re-render dependent fields, so wait for it to settle.
            await selectByLabelOrValue(
              page,
              'select[name="category"]',
              INFRA_CATEGORY[input.category] ?? input.category,
            );
            applied.category = input.category;
            await page.waitForTimeout(1200);
            if (input.category === "Other") {
              if (!input.otherCategory)
                throw new Error("otherCategory is required when category is 'Other'.");
              await page.fill('input[name="other_category"]', input.otherCategory);
              applied.otherCategory = input.otherCategory;
            }

            // Selecting the company fires AJAX that REPLACES the country list:
            // it starts as a long unfiltered list (~194 countries) and is
            // narrowed to the company's own countries (e.g. LinkIT.ID → only
            // Indonesia). Capture the pre-selection signature so we can wait for
            // that replacement to finish before touching country — picking too
            // early grabs a stale value that the reload then wipes, which left
            // country unset and silently blocked submit (worse on slow hosts).
            const COUNTRY_SEL = 'select[name="country"]';
            const countrySigBefore = input.country
              ? (await readOptions(page, COUNTRY_SEL)).map((o) => o.value).join("|")
              : "";

            // company (select)
            applied.company = await selectByLabelOrValue(
              page,
              'select[name="company"]',
              input.company,
            );

            // service_type (radio)
            await setRadio(page, "service_type", input.serviceType);
            applied.serviceType = input.serviceType;

            // country (optional) → also drives operator/service population.
            if (input.country) {
              // Wait until the company's AJAX has actually swapped the country
              // list (its option set differs from before). If a company happens
              // not to change it, this times out and we proceed anyway.
              await page
                .waitForFunction(
                  ({ sel, before }) => {
                    const s = document.querySelector(sel) as HTMLSelectElement | null;
                    if (!s) return false;
                    return (
                      Array.from(s.options)
                        .map((o) => o.value)
                        .join("|") !== before
                    );
                  },
                  { sel: COUNTRY_SEL, before: countrySigBefore },
                  { timeout: 10000 },
                )
                .catch(() => undefined);
              await page.waitForTimeout(300); // brief settle after the swap
              try {
                // Resolve by LABEL against the now company-specific list (values
                // are company-scoped, so a raw value would be wrong).
                applied.country = await selectByLabelOrValue(page, COUNTRY_SEL, input.country);
              } catch {
                const opts = await readOptions(page, COUNTRY_SEL);
                const available = opts
                  .filter((o) => o.value)
                  .map((o) => o.label)
                  .join(", ");
                throw new Error(
                  `Country "${input.country}" is not available for company "${input.company}". ` +
                    `The country list is filtered by company — available for "${input.company}": ` +
                    `${available || "(none loaded)"}. Use one of those, or pick the company that owns "${input.country}".`,
                );
              }
              await page.waitForTimeout(1200); // allow operator/service to load
            }
            if (input.project) {
              await page.fill('input[name="project"]', input.project);
              applied.project = input.project;
            }
            if (input.operator) {
              try {
                applied.operator = await selectByLabelOrValue(
                  page,
                  'select[name="operator"]',
                  input.operator,
                );
                await page.waitForTimeout(800);
              } catch (e) {
                applied.operatorWarning = `Could not set operator: ${(e as Error).message}`;
              }
            }
            if (input.service) {
              try {
                applied.service = await selectByLabelOrValue(
                  page,
                  'select[name="service"]',
                  input.service,
                );
              } catch (e) {
                applied.serviceWarning = `Could not set service: ${(e as Error).message}`;
              }
            }

            // sent_to[] (multi), cc_email[] (multi)
            applied.sentTo = await multiSelectByLabelOrValue(
              page,
              'select[name="sent_to[]"]',
              input.sentTo,
            );
            if (input.ccEmail?.length) {
              applied.ccEmail = await multiSelectByLabelOrValue(
                page,
                'select[name="cc_email[]"]',
                input.ccEmail,
              );
            }

            // subject — the form requires the "LinkIT - Infra - " prefix. The
            // caller passes a concise 2-3 word summary of the core purpose
            // (e.g. "Change env gameshop"); we prepend the prefix if absent.
            const fullSubject = input.subject.startsWith(INFRA_SUBJECT_PREFIX.trim())
              ? input.subject
              : `${INFRA_SUBJECT_PREFIX}${input.subject.replace(/^LinkIT\s*-\s*Infra\s*-\s*/i, "")}`;
            await page.fill('input[name="subject"]', fullSubject);
            applied.subject = fullSubject;
            await selectByLabelOrValue(
              page,
              'select[name="classification"]',
              CLASSIFICATION[input.classification],
            );
            applied.classification = input.classification;
            await page.fill('textarea[name="request_detail"]', input.requestDetail);
            applied.requestDetail = input.requestDetail.slice(0, 80) + "…";

            // files — at least one attachment is required by the form. If the
            // caller provided file paths, upload them. Otherwise auto-generate a
            // neat PDF from attachmentText (preferred, AI-polished) or
            // requestDetail. setInputFiles fires onchange=handleFiles(), which
            // validates type (JPEG/PNG/PDF/DOC/DOCX/XLS/XLSX) and fills the
            // uploadedFiles[] array the submit handler checks.
            const fileInput = page.locator('input[name="files[]"]').first();
            if (input.files?.length) {
              await fileInput.setInputFiles(input.files);
              applied.files = input.files;
            } else {
              const pdfText = input.attachmentText?.trim() || input.requestDetail;
              const pdf = makeTextPdf(pdfText, fullSubject);
              // Write to a real, stable path (not just an in-memory buffer) so
              // the file can be inspected or reused by a manual submit_form call.
              const dir = join(tmpdir(), "ticketing-infra-360");
              mkdirSync(dir, { recursive: true });
              const safe = fullSubject.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
              const pdfPath = join(dir, `${safe || "request-details"}.pdf`);
              writeFileSync(pdfPath, pdf);
              await fileInput.setInputFiles(pdfPath);
              applied.files = [pdfPath];
              applied.generatedPdfPath = pdfPath;
            }
            await page.waitForTimeout(1000); // let handleFiles() process

            const urlBefore = page.url();

            // Click submit. The form's onsubmit (infraRequestSubmit) validates
            // and, when valid, opens a SweetAlert "Are you sure? — Yes, Create
            // it!" confirmation. If validation fails, no dialog appears and the
            // failing field's error span is shown instead.
            await page.locator('button[type="submit"]').first().click();

            const confirmBtn = page.locator(".swal2-confirm");
            await Promise.race([
              confirmBtn.waitFor({ state: "visible", timeout: 10000 }).catch(() => undefined),
              page.waitForTimeout(10000),
            ]);
            const dialogAppeared =
              (await confirmBtn.count()) > 0 && (await confirmBtn.isVisible());

            // dryRun: the dialog appearing proves the form accepted all input.
            // Cancel it so NO ticket is created.
            if (input.dryRun) {
              if (dialogAppeared) {
                await page.locator(".swal2-cancel").click().catch(() => undefined);
              }
              const msgs = await collectMessages(page);
              logger.info("create_infra_ticket dry-run", { applied, validationPassed: dialogAppeared });
              return {
                dryRun: true,
                validationPassed: dialogAppeared,
                wouldCreate: dialogAppeared,
                applied,
                errors: msgs.errors,
                note: dialogAppeared
                  ? "Validation PASSED (confirmation dialog reached, then cancelled). No ticket created. Re-run with dryRun:false to submit."
                  : "Validation did NOT pass — see errors. Fix inputs before submitting.",
              };
            }

            // Real submit: confirm the dialog.
            let confirmed = false;
            if (dialogAppeared) {
              confirmed = true;
              await confirmBtn.click();
              await Promise.race([
                page
                  .waitForURL((u) => !u.toString().includes("/ticketing-infra/create"), {
                    timeout: 20000,
                  })
                  .catch(() => undefined),
                page
                  .locator(".swal2-success, .swal2-icon-success")
                  .waitFor({ state: "visible", timeout: 20000 })
                  .catch(() => undefined),
              ]);
              await page.waitForLoadState("networkidle").catch(() => undefined);
            }

            const finalUrl = page.url();
            const messages = await collectMessages(page);
            const navigatedAway = !finalUrl.includes("/ticketing-infra/create");
            const success = messages.errors.length === 0 && confirmed && navigatedAway;

            return {
              dryRun: false,
              submitted: true,
              confirmed,
              success,
              urlBefore,
              finalUrl,
              applied,
              errors: messages.errors,
              notices: Array.from(new Set(messages.notices)),
              ...(confirmed
                ? {}
                : {
                    hint:
                      "No confirmation dialog appeared — the form's JS validation likely " +
                      "blocked submit. Most common cause: a required COUNTRY was not set " +
                      "(categories like 'Server' and 'Domain/Pointing IP/Website' require it, " +
                      "and the country list is filtered by company). Also verify serviceType " +
                      "matches its required fields (project→project; service→operator+service)." +
                      (input.country ? "" : " You did not pass a country — try adding one."),
                  }),
            };
          }),
        { retries: ctx.cfg.maxRetries, label: "create_infra_ticket" },
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // -------------------------------------------------------------------------
  // list_tickets  (infra/creative/media/legal)
  // -------------------------------------------------------------------------
  server.registerTool(
    "list_tickets",
    {
      title: "List / search tickets",
      description:
        "List tickets from a ticketing module's DataTable (infra, creative, media, " +
        "or legal). The table is server-side, so this queries the DataTables endpoint " +
        "directly: results default to NEWEST FIRST (sorted by created_at desc), " +
        "`maxRows` is honoured as the real page size, and `page` gives true pagination. " +
        "Optional global `search` filters across columns (subject, ticket number, " +
        "company, country, status, creator email, …). Returns rows keyed by column " +
        "header plus recordsTotal/recordsFiltered/totalPages for paging.",
      inputSchema: {
        module: z
          .enum(MODULES)
          .default("infra")
          .describe("Ticketing module to list."),
        search: z
          .string()
          .optional()
          .describe(
            "Global search string (server-side, across all columns). Pass a creator " +
              "email e.g. 'bimo.prakoso@linkit360.com' to list a person's tickets.",
          ),
        maxRows: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Page size — max rows per page, truly honoured (default 25, max 500)."),
        page: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based page number for pagination (default 1). Page 1 = newest."),
        sortBy: z
          .string()
          .optional()
          .describe(
            "Column to sort by (column `data` name, e.g. 'created_at', 'ticket_number', " +
              "'subject'). Default 'created_at'.",
          ),
        sortOrder: z
          .enum(["asc", "desc"])
          .optional()
          .describe("Sort direction. Default 'desc' (newest/highest first)."),
        filters: z
          .record(z.string())
          .optional()
          .describe(
            "Advanced: extra server-side filter fields appended to the request " +
              "(e.g. { status: '...', daterange: '...', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', company: '...' }).",
          ),
      },
    },
    async ({ module, search, maxRows, page: pageNum, sortBy, sortOrder, filters }) => {
      await ctx.auth.ensureAuthenticated();
      const mod = (module ?? "infra") as Module;
      const url = resolveUrl(ctx.cfg.baseUrl, `/ticketing-${mod}/list`);

      const result = await withRetry(
        () =>
          ctx.browser.withPage(async (page) => {
            await page.goto(url, { waitUntil: "networkidle" });
            const table = await extractDataTable(page, {
              search,
              maxRows,
              page: pageNum,
              sortBy,
              sortOrder,
              filters,
            });
            return { module: mod, url: page.url(), ...table };
          }),
        { retries: ctx.cfg.maxRetries, label: "list_tickets" },
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
