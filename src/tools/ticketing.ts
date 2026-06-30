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

/**
 * Static country → company fallback, captured from the live
 * /ticketing-infra/company-operator data (e.g. LinkIT.SEA covers Cambodia,
 * Laos, Myanmar, Philippines, Vietnam and shares Thailand with LinkIT.Asia).
 *
 * The live lookup below is still the source of truth (companies/countries can
 * change), but this guarantees a KNOWN country never dead-ends with "no company
 * found" when the live AJAX call hiccups — which is exactly the "Cambodia is
 * obviously in LinkIT.SEA, just find it" case. Values are company LABELS as
 * they appear in the company dropdown.
 */
const COUNTRY_COMPANY_FALLBACK: Record<string, string[]> = {
  // LinkIT.SEA
  cambodia: ["LinkIT.SEA"],
  laos: ["LinkIT.SEA"],
  myanmar: ["LinkIT.SEA"],
  philippines: ["LinkIT.SEA"],
  vietnam: ["LinkIT.SEA"],
  thailand: ["LinkIT.SEA", "LinkIT.Asia"], // shared region
  // LinkIT.Asia
  bangladesh: ["LinkIT.Asia"],
  haiti: ["LinkIT.Asia"],
  malaysia: ["LinkIT.Asia"],
  pakistan: ["LinkIT.Asia"],
  "sri lanka": ["LinkIT.Asia"],
  "timor leste": ["LinkIT.Asia"],
  // Indonesia is operated by two entities — keep both so we still ask.
  indonesia: ["LinkIT.ID", "LinkIT.7Star"],
};

/** Common country aliases / codes → the canonical name used in the maps. */
const COUNTRY_ALIASES: Record<string, string> = {
  "viet nam": "vietnam",
  vn: "vietnam",
  kampuchea: "cambodia",
  khmer: "cambodia",
  kh: "cambodia",
  lao: "laos",
  "lao pdr": "laos",
  la: "laos",
  burma: "myanmar",
  mm: "myanmar",
  ph: "philippines",
  pilipinas: "philippines",
  th: "thailand",
  id: "indonesia",
  "republic of indonesia": "indonesia",
  "east timor": "timor leste",
  "timor-leste": "timor leste",
};

/** Lowercase, collapse whitespace, and resolve known aliases to a canonical name. */
function normalizeCountry(raw: string): string {
  const k = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return COUNTRY_ALIASES[k] ?? k;
}

/**
 * Some companies are SaaS/product entities (LinkIT.SaaS.Airpay, ...Airgift,
 * GetWellsoon, LinkIT.OTT) that "operate" a country only incidentally — they are
 * NOT the country's regional operator. When a real regional company (e.g.
 * LinkIT.SEA for Cambodia) is also available, we prefer it. This is what makes
 * "Cambodia → LinkIT.SEA" resolve automatically even though the raw data lists
 * Cambodia under both LinkIT.SaaS.Airgift and LinkIT.SEA.
 */
const NON_REGIONAL_COMPANY_RE = /saas|airgift|airpay|getwellsoon|\.ott\b/i;

/**
 * Given the candidate companies that operate a country, pick the single right
 * one when we confidently can, else return null so the caller asks the user.
 * Preference order:
 *   1) exactly one candidate → use it;
 *   2) the country's known regional company (static map) intersected with the
 *      live candidates narrows to exactly one → use it (Cambodia → LinkIT.SEA);
 *   3) dropping SaaS/product companies leaves exactly one real operator → use it;
 *   otherwise → null (genuinely shared, e.g. Indonesia → LinkIT.ID vs LinkIT.7Star).
 */
function preferCompany(country: string, candidates: string[]): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const norm = normalizeCountry(country);
  const known = COUNTRY_COMPANY_FALLBACK[norm] ?? COUNTRY_COMPANY_FALLBACK[country.trim().toLowerCase()] ?? [];
  const knownInLive = candidates.filter((c) => known.includes(c));
  if (knownInLive.length === 1) return knownInLive[0];

  const regional = candidates.filter((c) => !NON_REGIONAL_COMPANY_RE.test(c));
  if (regional.length === 1) return regional[0];

  return null;
}

/**
 * Country → company lookup, built from POST /ticketing-infra/company-operator
 * (which returns a company's countries as [{country, country_code, ...}]).
 * A country can belong to several companies (e.g. Indonesia → LinkIT.ID and
 * LinkIT.7Star, Thailand → LinkIT.SEA and LinkIT.Asia), so we keep all
 * candidates and let the caller pick. Cached per server process.
 */
// country (name or code) -> companies that operate it, in company-dropdown order.
let companyByCountry: Map<string, string[]> | null = null;

async function buildCompanyByCountry(page: Page): Promise<Map<string, string[]>> {
  if (companyByCountry) return companyByCountry;
  const csrf = await page.evaluate(
    () => document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "",
  );
  const companies = (await readOptions(page, 'select[name="company"]')).filter((o) => o.value);
  const url = new URL("/ticketing-infra/company-operator", new URL(page.url())).toString();
  const req = page.context().request;

  // Fetch in parallel (fast), but keep results in company order for determinism.
  const perCompany = await Promise.all(
    companies.map(async (c) => {
      try {
        const r = await req.post(url, {
          headers: {
            "X-CSRF-TOKEN": csrf,
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          data: `id=${encodeURIComponent(c.value)}`,
        });
        if (!r.ok()) return { label: c.label, keys: [] as string[], ok: false };
        const arr = (await r.json()) as Array<{ country?: string; country_code?: string }>;
        const keys = Array.isArray(arr)
          ? arr.flatMap((row) => {
              const out: string[] = [];
              const name = String(row.country ?? "").trim().toLowerCase();
              const code = String(row.country_code ?? "").trim().toLowerCase();
              if (name) out.push(name);
              if (code) out.push(`code:${code}`);
              return out;
            })
          : [];
        return { label: c.label, keys, ok: true };
      } catch {
        return { label: c.label, keys: [] as string[], ok: false };
      }
    }),
  );

  const map = new Map<string, string[]>();
  for (const { label, keys } of perCompany) {
    for (const key of keys) {
      const arr = map.get(key) ?? [];
      if (!arr.includes(label)) arr.push(label);
      map.set(key, arr);
    }
  }
  // Only cache when EVERY company answered. A partial map could drop the regional
  // company for a shared country (e.g. Cambodia under both LinkIT.SaaS.Airgift and
  // LinkIT.SEA) and silently mis-route tickets for the rest of the process, so we
  // leave it uncached and let the next call rebuild it.
  if (perCompany.every((p) => p.ok)) companyByCountry = map;
  return map;
}

/** Companies that own a given country (by name or ISO code), dropdown order. */
async function resolveCompaniesByCountry(page: Page, country: string): Promise<string[]> {
  const raw = country.trim().toLowerCase();
  const norm = normalizeCountry(country);

  // Live lookup is authoritative — try normalized name, raw name, then ISO code.
  let map: Map<string, string[]>;
  try {
    map = await buildCompanyByCountry(page);
  } catch {
    map = new Map();
  }
  const live =
    map.get(norm) ??
    map.get(raw) ??
    map.get(`code:${norm}`) ??
    map.get(`code:${raw}`) ??
    [];

  // Always union the curated static mapping for KNOWN countries. This guards the
  // shared-country case: if a partial/hiccuping live fetch dropped the regional
  // company (e.g. Cambodia lost LinkIT.SEA, leaving only LinkIT.SaaS.Airgift),
  // we re-add it so preferCompany can still choose the regional operator instead
  // of silently picking the SaaS entity. The chosen label is resolved against the
  // full live company dropdown later, so a company that truly isn't there still
  // surfaces a clear error rather than a wrong submit.
  const known = COUNTRY_COMPANY_FALLBACK[norm] ?? COUNTRY_COMPANY_FALLBACK[raw] ?? [];
  return Array.from(new Set([...live, ...known]));
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
        "THE tool for creating a LinkIT360 infra ticket (POST /ticketing-infra/request). " +
        "ALWAYS use this — do NOT use submit_form for infra tickets. " +
        "IMPORTANT: the attachment is handled FOR YOU — this tool generates a neat PDF " +
        "from requestDetail automatically. Do NOT generate a PDF yourself and do NOT ask " +
        "the user to upload a file; only pass `files` if the user explicitly provided a " +
        "real file path. Recipients also default automatically (it.support@ + infra@), so " +
        "don't ask for recipients either. " +
        "Dropdown inputs accept the visible label or the raw value, resolved against the " +
        "live form. The subject is auto-prefixed with 'LinkIT - Infra - '. " +
        "`serviceType` is REQUIRED — if the user didn't say 'service' or 'project', ASK; " +
        "do not guess. `company` is optional and auto-resolved from `country` (e.g. " +
        "Cambodia/Laos/Myanmar/Philippines/Vietnam → LinkIT.SEA); if a country is operated " +
        "by several companies the tool returns the candidates — ASK the user which company " +
        "(don't fall back to another tool). " +
        "CLASSIFICATION defaults to P3 — leave it unset unless the user explicitly asks for " +
        "higher priority. P0/P1/P2 trigger the approval workflow: pass an `approver` (ask " +
        "the user who approves and why) — the tool CCs them and records it, and the ticket " +
        "enters 'Waiting Approval' until approved. Run dryRun=true first, then dryRun=false " +
        "to actually submit.",
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
        company: z
          .string()
          .optional()
          .describe(
            "Company label (e.g. 'LinkIT.MENA') or value. OPTIONAL — if omitted, it is " +
              "auto-resolved from `country` WHEN that country maps to a single company " +
              "(e.g. Egypt→LinkIT.MENA). If the country is operated by several companies " +
              "(e.g. Indonesia), the tool returns the candidate list and asks you to pick " +
              "one. Provide either `company` or `country`.",
          ),
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
          .optional()
          .describe(
            "Priority classification (P0 highest). OPTIONAL — defaults to P3. " +
              "Only set P0, P1, or P2 when the user EXPLICITLY asks for higher " +
              "priority; those trigger the approval workflow and require an `approver`.",
          ),
        approver: z
          .string()
          .optional()
          .describe(
            "Who will approve this ticket. REQUIRED when classification is P0/P1/P2 " +
              "(the new approval workflow). Pass the approver's name as it appears in " +
              "the recipient list; they are CC'd and recorded in the request. Ignored " +
              "for P3/P4 (no approval needed). If the user asked for high priority but " +
              "didn't name an approver, ASK them first.",
          ),
        approvalReason: z
          .string()
          .optional()
          .describe(
            "Short justification for why P0/P1/P2 priority is warranted. Recorded in " +
              "the ticket so the approver has context. Optional.",
          ),
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

      // Classification defaults to P3 (no approval). P0/P1/P2 enter the approval
      // workflow and need a named approver — fail fast and tell the agent to ask
      // the user, rather than silently creating a high-priority ticket.
      const classification = input.classification ?? ctx.cfg.defaultClassification;
      const needsApproval = ["P0", "P1", "P2"].includes(classification);
      if (needsApproval && !input.approver?.trim()) {
        throw new Error(
          `Classification ${classification} requires approval under the new ticketing ` +
            `workflow. Before creating it, ask the user WHO should approve this ticket ` +
            `(the approver's name as it appears in the recipient list) and WHY ` +
            `${classification} priority is needed, then re-run with \`approver\` set ` +
            `(and optionally \`approvalReason\`). If high priority isn't truly required, ` +
            `set classification to P3 or P4 (no approval needed).`,
        );
      }
      const approver = input.approver?.trim();
      const approvalNote = needsApproval
        ? `\n\n----------------------------------------\n` +
          `PRIORITY: ${classification} (high — approval expected)\n` +
          `Requested approver: ${approver}\n` +
          `Justification: ${input.approvalReason?.trim() || "(not provided)"}\n` +
          `This is a high-priority request; under the approval workflow it is expected to ` +
          `require approval before the infra team acts.`
        : "";
      const approvalSummary = needsApproval
        ? {
            classification,
            approver,
            // Worded conditionally: whether a ticket actually lands in "Waiting
            // Approval" is decided by the backend/reviewer, not by this tool. We
            // record the requested approver and flag that approval is expected.
            status: "High priority — approval expected before infra acts",
            note:
              "The approver has been recorded (and CC'd when possible). Under the ticketing " +
              "approval workflow a high-priority ticket typically enters 'Waiting Approval' and " +
              "must be approved in the ticket review panel before the infra team acts. Track its " +
              "status in the ticket list.",
          }
        : undefined;

      // Deterministic input-validation errors (ambiguous company, unknown country,
      // missing otherCategory) are NOT transient — don't burn retries reopening the
      // page; surface them immediately so the agent can ask the user.
      const isDeterministicInputError = (e: unknown): boolean =>
        /is operated by \d+ companies|Could not find a company|is not available for company|otherCategory is required|Provide either `company`/i.test(
          e instanceof Error ? e.message : String(e),
        );

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

            // Resolve the company: use it as given, or auto-derive it from the
            // country (each country belongs to exactly one company).
            let companyToSelect = input.company;
            if (!companyToSelect) {
              if (!input.country) {
                throw new Error(
                  "Provide either `company` or `country` — the company is auto-resolved from country.",
                );
              }
              const candidates = await resolveCompaniesByCountry(page, input.country);
              if (candidates.length === 0) {
                throw new Error(
                  `Could not find a company that operates country "${input.country}". ` +
                    "Check the spelling, or pass an explicit `company`.",
                );
              }
              // Prefer the regional operator when a country is also listed under a
              // SaaS/product company (e.g. Cambodia → LinkIT.SEA, not the SaaS one).
              const picked = preferCompany(input.country, candidates);
              if (!picked) {
                // Genuinely shared between real operators (e.g. Indonesia) — don't
                // guess (wrong company on a real ticket is bad). Ask the caller.
                throw new Error(
                  `Country "${input.country}" is operated by ${candidates.length} companies: ` +
                    `${candidates.join(", ")}. Re-run with an explicit \`company\` set to one of these.`,
                );
              }
              companyToSelect = picked;
              applied.companyAutoResolved = companyToSelect;
              if (candidates.length > 1) applied.companyCandidates = candidates;
            }

            // company (select)
            applied.company = await selectByLabelOrValue(
              page,
              'select[name="company"]',
              companyToSelect,
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
                // are company-scoped, so a raw value would be wrong). Try the name
                // as given first, then the normalized alias — so "Viet Nam",
                // "Burma", "East Timor", etc. still match the dropdown's canonical
                // label ("Vietnam", "Myanmar", "Timor Leste").
                const tries = Array.from(new Set([input.country, normalizeCountry(input.country)]));
                let countryErr: unknown;
                let set = false;
                for (const candidate of tries) {
                  try {
                    applied.country = await selectByLabelOrValue(page, COUNTRY_SEL, candidate);
                    set = true;
                    break;
                  } catch (e) {
                    countryErr = e;
                  }
                }
                if (!set) throw countryErr ?? new Error("country not matched");
              } catch {
                const opts = await readOptions(page, COUNTRY_SEL);
                const available = opts
                  .filter((o) => o.value)
                  .map((o) => o.label)
                  .join(", ");
                throw new Error(
                  `Country "${input.country}" is not available for company "${companyToSelect}". ` +
                    `The country list is filtered by company — available for "${companyToSelect}": ` +
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
            const ccInputs = [...(input.ccEmail ?? [])];
            if (ccInputs.length) {
              applied.ccEmail = await multiSelectByLabelOrValue(
                page,
                'select[name="cc_email[]"]',
                ccInputs,
              );
            }
            // Notify the approver by CC'ing them too (best-effort: if their name
            // isn't a selectable recipient we keep going — they're still recorded
            // in the request detail below).
            if (needsApproval && approver) {
              try {
                applied.ccEmail = await multiSelectByLabelOrValue(
                  page,
                  'select[name="cc_email[]"]',
                  [...ccInputs, approver],
                );
                applied.approverCc = approver;
              } catch (e) {
                applied.approverCcWarning =
                  `Could not CC approver "${approver}" (not in the recipient list); ` +
                  `it is still documented in the request detail. ${(e as Error).message}`;
              }
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
              CLASSIFICATION[classification],
            );
            applied.classification = classification;
            if (input.classification == null) applied.classificationDefaulted = true;
            const effectiveDetail = input.requestDetail + approvalNote;
            await page.fill('textarea[name="request_detail"]', effectiveDetail);
            applied.requestDetail = effectiveDetail.slice(0, 80) + "…";

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
              const pdfText = (input.attachmentText?.trim() || input.requestDetail) + approvalNote;
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
                ...(approvalSummary ? { approval: approvalSummary } : {}),
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
              ...(approvalSummary ? { approval: approvalSummary } : {}),
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
        {
          retries: ctx.cfg.maxRetries,
          label: "create_infra_ticket",
          shouldRetry: (e) => !isDeterministicInputError(e),
        },
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // -------------------------------------------------------------------------
  // get_ticket_detail  — reply + activity scraper
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_ticket_detail",
    {
      title: "Get ticket detail (reply + activity)",
      description:
        "Open a ticket detail page and return the full reply from the infra team " +
        "plus the complete Activity Ticket log. Use this after `list_tickets` to read " +
        "the answer/credentials that infra posted in reply to a ticket. " +
        "Pass either `ticketId` (numeric, e.g. 42) or a full `path` " +
        "(e.g. '/ticketing-infra/detail/42'). `module` defaults to 'infra'.",
      inputSchema: {
        ticketId: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Numeric ticket ID (e.g. 42). Use this OR `path`."),
        path: z
          .string()
          .optional()
          .describe(
            "Full path to the ticket detail page, e.g. '/ticketing-infra/detail/42'. " +
              "Use this OR `ticketId`.",
          ),
        module: z
          .enum(MODULES)
          .default("infra")
          .describe("Ticketing module (default 'infra')."),
      },
    },
    async ({ ticketId, path: inputPath, module }) => {
      await ctx.auth.ensureAuthenticated();
      const mod = (module ?? "infra") as Module;

      if (!ticketId && !inputPath) {
        throw new Error("Provide either `ticketId` or `path`.");
      }

      const detailPath = inputPath ?? `/ticketing-${mod}/detail/${ticketId}`;
      const url = resolveUrl(ctx.cfg.baseUrl, detailPath);

      const result = await withRetry(
        () =>
          ctx.browser.withPage(async (page) => {
            await page.goto(url, { waitUntil: "networkidle" });

            const data = await page.evaluate(() => {
              // ---- Reply sections ----
              // The page may have one or more reply blocks. Each block has a
              // header row ("Reply By : <email>" on the left, datetime on the
              // right) and a body row with the reply text.
              const replies: Array<{
                replyBy: string;
                datetime: string;
                text: string;
              }> = [];

              // Strategy 1: look for elements whose text starts with "Reply By"
              // (covers both table-cell and div layouts).
              const replyByEls = Array.from(document.querySelectorAll("*")).filter((el) => {
                if (el.children.length > 5) return false; // skip containers
                const t = (el.textContent || "").trim();
                return t.startsWith("Reply By");
              });

              for (const header of replyByEls) {
                // Extract replier email
                const headerText = (header.textContent || "").trim();
                const emailMatch = headerText.match(/Reply By\s*[:\-]?\s*(.+)/i);
                const replyBy = emailMatch ? emailMatch[1].trim() : "";

                // Datetime: look in the same row/sibling
                let datetime = "";
                const parent = header.parentElement;
                if (parent) {
                  // Check siblings and children for a date pattern
                  const dateEl = Array.from(parent.querySelectorAll("*")).find(
                    (el) =>
                      el !== header &&
                      /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(el.textContent || ""),
                  );
                  if (dateEl) {
                    const m = (dateEl.textContent || "").match(
                      /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/,
                    );
                    datetime = m ? m[0] : "";
                  }
                }

                // Reply body: next sibling row / next sibling element
                let bodyText = "";
                const row = header.closest("tr");
                if (row) {
                  const nextRow = row.nextElementSibling;
                  if (nextRow) bodyText = (nextRow.textContent || "").trim().replace(/\s+/g, " ");
                } else if (parent) {
                  const nextEl = parent.nextElementSibling;
                  if (nextEl) bodyText = (nextEl.textContent || "").trim().replace(/\s+/g, " ");
                }

                if (replyBy || bodyText) {
                  replies.push({ replyBy, datetime, text: bodyText });
                }
              }

              // ---- Activity Ticket table ----
              const activities: Array<Record<string, string>> = [];

              // Find the "Activity Ticket" section header, then grab the table.
              const allEls = Array.from(document.querySelectorAll("*"));
              const activityHeader = allEls.find((el) => {
                if (el.children.length > 3) return false;
                return /activity\s+ticket/i.test((el.textContent || "").trim());
              });

              let activityTable: Element | null = null;
              if (activityHeader) {
                // Walk up to a section/card then search downward for a table.
                let cursor: Element | null = activityHeader;
                for (let i = 0; i < 6 && cursor; i++) {
                  const tbl = cursor.querySelector("table");
                  if (tbl) {
                    activityTable = tbl;
                    break;
                  }
                  cursor = cursor.parentElement;
                }
              }

              if (!activityTable) {
                // Fallback: find the table that has "Activity" in its header row.
                for (const tbl of Array.from(document.querySelectorAll("table"))) {
                  const hdr = tbl.querySelector("thead");
                  if (hdr && /activity/i.test(hdr.textContent || "")) {
                    activityTable = tbl;
                    break;
                  }
                }
              }

              if (activityTable) {
                const headers = Array.from(
                  activityTable.querySelectorAll("thead th, thead td"),
                ).map((h) => (h.textContent || "").trim().replace(/\s+/g, " "));

                const rows = Array.from(activityTable.querySelectorAll("tbody tr"));
                for (const row of rows) {
                  const cells = Array.from(row.querySelectorAll("td")).map((td) =>
                    (td.textContent || "").trim().replace(/\s+/g, " "),
                  );
                  if (cells.every((c) => !c)) continue; // skip empty rows
                  const obj: Record<string, string> = {};
                  headers.forEach((h, i) => {
                    obj[h || `col${i}`] = cells[i] ?? "";
                  });
                  activities.push(obj);
                }
              }

              // ---- Basic ticket meta (title, status, etc.) ----
              const title = document.title;
              const pageText = (document.body?.innerText || "")
                .replace(/\n{3,}/g, "\n\n")
                .slice(0, 3000);

              return { title, pageText, replies, activities };
            });

            logger.info("get_ticket_detail", {
              url: page.url(),
              repliesFound: data.replies.length,
              activitiesFound: data.activities.length,
            });

            return {
              url: page.url(),
              title: data.title,
              replies: data.replies,
              activities: data.activities,
              rawText: data.pageText,
            };
          }),
        { retries: ctx.cfg.maxRetries, label: "get_ticket_detail" },
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
