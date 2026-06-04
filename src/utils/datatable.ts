import type { Page } from "playwright";

export interface DataTableResult {
  headers: string[];
  rows: Record<string, string>[];
  totalRowsOnPage: number;
  note?: string;
}

/**
 * Extracts rows from a (jQuery) DataTable on the current page.
 *
 * Optionally types into the DataTable global search box (which, for
 * server-side tables, triggers a filtered reload) and raises the page length.
 * Returns rows as objects keyed by column header.
 */
export async function extractDataTable(
  page: Page,
  opts: { search?: string; maxRows?: number } = {},
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

  // Raise page length if a length selector exists (pick the largest option).
  const lengthSel = page.locator("select[name$='_length'], .dataTables_length select").first();
  if ((await lengthSel.count()) > 0) {
    const values = await lengthSel
      .locator("option")
      .evaluateAll((els) => els.map((o) => Number((o as HTMLOptionElement).value)).filter((n) => !Number.isNaN(n)));
    if (values.length) {
      const best = Math.max(...values);
      await lengthSel.selectOption(String(best)).catch(() => undefined);
      await page.waitForTimeout(800);
    }
  }

  if (opts.search) {
    const searchBox = page
      .locator("input[type='search'], .dataTables_filter input")
      .first();
    if ((await searchBox.count()) > 0) {
      await searchBox.fill(opts.search);
      // Server-side reload after typing.
      await page.waitForTimeout(1200);
    }
  }

  // Wait for any post-filter reload to settle.
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
