import type { Page } from "playwright";

export interface DataTableResult {
  headers: string[];
  rows: Record<string, string>[];
  /** Rows returned in THIS response (== rows.length). */
  totalRowsOnPage: number;
  /** Total rows in the table before filtering (server-side only). */
  recordsTotal?: number;
  /** Total rows matching the current search/filter (server-side only). */
  recordsFiltered?: number;
  /** 1-based page index that was fetched (server-side only). */
  page?: number;
  /** Page size used (server-side only). */
  pageSize?: number;
  /** Total number of pages for the current filter (server-side only). */
  totalPages?: number;
  note?: string;
}

export interface DataTableOptions {
  search?: string;
  /** Max rows to return (page size / DataTables `length`). Default 25. */
  maxRows?: number;
  /** 1-based page to fetch. Default 1. */
  page?: number;
  /** Column `data` name to sort by. Default "created_at" (falls back gracefully). */
  sortBy?: string;
  /** Sort direction. Default "desc" (newest first). */
  sortOrder?: "asc" | "desc";
  /** Extra filter fields appended to the server-side request (e.g. status, daterange, from, to, company). */
  filters?: Record<string, string>;
}

/** Strip HTML tags/entities a server-side renderer may wrap a cell in. */
function stripHtml(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

interface DtMeta {
  isServerSide: boolean;
  ajaxUrl: string | null;
  csrf: string | null;
  headers: string[];
  /** Per-column { data, searchable, orderable } in column order. */
  columns: { data: string; searchable: boolean; orderable: boolean }[];
}

/** Read the DataTables configuration straight off the live page (jQuery DataTable). */
async function readDtMeta(page: Page): Promise<DtMeta> {
  return page.evaluate(() => {
    const result: DtMeta = {
      isServerSide: false,
      ajaxUrl: null,
      csrf: null,
      headers: [],
      columns: [],
    };
    const meta = document.querySelector('meta[name="csrf-token"]');
    result.csrf = meta ? meta.getAttribute("content") : null;

    const table =
      (document.querySelector("table.dataTable") as HTMLTableElement | null) ||
      (document.querySelector("table") as HTMLTableElement | null);
    if (!table) return result;

    result.headers = Array.from(table.querySelectorAll("thead th")).map((h) =>
      (h.textContent || "").trim(),
    );

    // Derive the AJAX endpoint from the current path: `/x/list` -> `/x/datatable`.
    const derived = location.pathname.replace(/\/list\/?$/, "/datatable");
    result.ajaxUrl = derived !== location.pathname ? derived : null;

    const $ = (window as unknown as { jQuery?: unknown; $?: unknown }).jQuery as
      | undefined
      | (((t: Element) => { DataTable: () => { settings: () => unknown[] } }) & {
          fn: { dataTable: { isDataTable: (t: Element) => boolean } };
        });
    try {
      if ($ && $.fn?.dataTable?.isDataTable(table)) {
        const s = ($(table).DataTable().settings() as Array<Record<string, unknown>>)[0];
        result.isServerSide = !!(s.oFeatures as { bServerSide?: boolean })?.bServerSide;
        const ajax = s.ajax as string | { url?: string } | undefined;
        if (typeof ajax === "string") result.ajaxUrl = ajax || result.ajaxUrl;
        else if (ajax && typeof ajax.url === "string") result.ajaxUrl = ajax.url;
        const aoColumns = (s.aoColumns as Array<Record<string, unknown>>) || [];
        result.columns = aoColumns.map((c) => ({
          data: (c.mData as string) ?? (c.sName as string) ?? "",
          searchable: (c.bSearchable as boolean) ?? true,
          orderable: (c.bSortable as boolean) ?? true,
        }));
      }
    } catch {
      /* fall through to DOM scrape */
    }
    return result;
  });
}

/**
 * Fetch rows by calling the server-side DataTables endpoint directly. This is
 * the reliable path: it honours page size (`length`), supports real pagination
 * (`start`), sorts server-side (default `created_at` DESC = newest first), and
 * returns accurate `recordsTotal` / `recordsFiltered`.
 */
async function fetchServerSide(
  page: Page,
  meta: DtMeta,
  opts: DataTableOptions,
): Promise<DataTableResult | null> {
  if (!meta.ajaxUrl || meta.columns.length === 0) return null;

  const pageSize = opts.maxRows ?? 25;
  const pageIdx = Math.max(1, opts.page ?? 1);
  const start = (pageIdx - 1) * pageSize;
  const sortBy = opts.sortBy ?? "created_at";
  const sortOrder = opts.sortOrder ?? "desc";

  // Pick the order column: requested sortBy, else created_at, else first orderable.
  let orderCol = meta.columns.findIndex((c) => c.data === sortBy);
  if (orderCol < 0) orderCol = meta.columns.findIndex((c) => c.data === "created_at");
  if (orderCol < 0) orderCol = meta.columns.findIndex((c) => c.orderable);

  const form = new URLSearchParams();
  form.set("draw", "1");
  meta.columns.forEach((c, i) => {
    form.set(`columns[${i}][data]`, c.data);
    form.set(`columns[${i}][name]`, c.data);
    form.set(`columns[${i}][searchable]`, String(c.searchable));
    form.set(`columns[${i}][orderable]`, String(c.orderable));
    form.set(`columns[${i}][search][value]`, "");
    form.set(`columns[${i}][search][regex]`, "false");
  });
  if (orderCol >= 0) {
    form.set("order[0][column]", String(orderCol));
    form.set("order[0][dir]", sortOrder);
  }
  form.set("start", String(start));
  form.set("length", String(pageSize));
  form.set("search[value]", opts.search ?? "");
  form.set("search[regex]", "false");
  for (const [k, v] of Object.entries(opts.filters ?? {})) form.set(k, v);

  const base = new URL(page.url());
  const ajaxUrl = new URL(meta.ajaxUrl, base).toString();
  const resp = await page.context().request.post(ajaxUrl, {
    headers: {
      "X-CSRF-TOKEN": meta.csrf ?? "",
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    data: form.toString(),
  });
  if (!resp.ok()) return null;

  let json: {
    data?: Array<Record<string, unknown>>;
    recordsTotal?: number;
    recordsFiltered?: number;
  };
  try {
    json = await resp.json();
  } catch {
    return null;
  }
  if (!Array.isArray(json.data)) return null;

  // Map each row object to header->value using the column `data` order, so the
  // output matches what the table visually shows (HTML stripped).
  const colData = meta.columns.map((c) => c.data);
  const rows = json.data.map((r) => {
    const obj: Record<string, string> = {};
    meta.headers.forEach((h, i) => {
      const key = colData[i];
      obj[h || `col${i}`] = stripHtml(key ? r[key] : "");
    });
    return obj;
  });

  const recordsFiltered = json.recordsFiltered ?? rows.length;
  const totalPages = Math.max(1, Math.ceil(recordsFiltered / pageSize));
  return {
    headers: meta.headers,
    rows,
    totalRowsOnPage: rows.length,
    recordsTotal: json.recordsTotal,
    recordsFiltered,
    page: pageIdx,
    pageSize,
    totalPages,
    note:
      pageIdx < totalPages
        ? `Page ${pageIdx}/${totalPages} (${recordsFiltered} match). Pass page:${pageIdx + 1} for older rows, or raise maxRows.`
        : undefined,
  };
}

/**
 * Extract rows from a (jQuery) DataTable on the current page.
 *
 * Prefers the server-side AJAX endpoint (reliable sort/pagination/length).
 * Falls back to scraping the rendered DOM for client-side tables.
 */
export async function extractDataTable(
  page: Page,
  opts: DataTableOptions = {},
): Promise<DataTableResult> {
  const maxRows = opts.maxRows ?? 25;

  // Wait for a populated table body (server-side tables load via XHR).
  await page
    .waitForFunction(
      () => {
        const tb = document.querySelector("table.dataTable tbody, table tbody");
        return !!tb && tb.querySelectorAll("tr").length > 0;
      },
      { timeout: 15000 },
    )
    .catch(() => undefined);

  // Preferred path: query the server-side endpoint directly.
  const meta = await readDtMeta(page);
  if (meta.isServerSide || (meta.ajaxUrl && meta.columns.length > 0)) {
    const ss = await fetchServerSide(page, meta, opts);
    if (ss) return ss;
  }

  // ---- Fallback: scrape the rendered DOM (client-side tables) ----
  const lengthSel = page.locator("select[name$='_length'], .dataTables_length select").first();
  if ((await lengthSel.count()) > 0) {
    const values = await lengthSel
      .locator("option")
      .evaluateAll((els) =>
        els.map((o) => Number((o as HTMLOptionElement).value)).filter((n) => !Number.isNaN(n)),
      );
    if (values.length) {
      await lengthSel.selectOption(String(Math.max(...values))).catch(() => undefined);
      await page.waitForTimeout(800);
    }
  }
  if (opts.search) {
    const searchBox = page.locator("input[type='search'], .dataTables_filter input").first();
    if ((await searchBox.count()) > 0) {
      await searchBox.fill(opts.search);
      await page.waitForTimeout(1200);
    }
  }
  await page.waitForLoadState("networkidle").catch(() => undefined);

  const data = await page.evaluate(() => {
    const table =
      document.querySelector("table.dataTable") || document.querySelector("table");
    if (!table) return { headers: [] as string[], rows: [] as string[][] };
    const headers = Array.from(table.querySelectorAll("thead th")).map((h) =>
      (h.textContent || "").trim(),
    );
    const rows = Array.from(table.querySelectorAll("tbody tr"))
      .map((tr) =>
        Array.from(tr.querySelectorAll("td")).map((td) =>
          (td.textContent || "").trim().replace(/\s+/g, " "),
        ),
      )
      .filter((r) => r.length > 1);
    return { headers, rows };
  });

  const rows = data.rows.slice(0, maxRows).map((cells) => {
    const obj: Record<string, string> = {};
    data.headers.forEach((h, i) => {
      obj[h || `col${i}`] = cells[i] ?? "";
    });
    return obj;
  });

  return {
    headers: data.headers,
    rows,
    totalRowsOnPage: data.rows.length,
    note:
      data.rows.length > maxRows
        ? `Showing ${maxRows} of ${data.rows.length} rows on this page; raise maxRows or use search to narrow.`
        : undefined,
  };
}
