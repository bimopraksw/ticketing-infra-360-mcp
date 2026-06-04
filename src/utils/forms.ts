import type { Page } from "playwright";

export interface OptionInfo {
  value: string;
  label: string;
}

/** Reads all <option>s of a <select> as {value,label}. */
export async function readOptions(page: Page, selector: string): Promise<OptionInfo[]> {
  return page.locator(`${selector} option`).evaluateAll((els) =>
    els.map((o) => ({
      value: (o as HTMLOptionElement).value,
      label: ((o as HTMLOptionElement).textContent || "").trim(),
    })),
  );
}

/**
 * Resolves a user-provided input (which may be an option value OR a human
 * label) to the concrete option value. Matching order: exact value, exact
 * label (case-insensitive), then label contains. Throws with the closest
 * candidates if nothing matches.
 */
export function resolveOption(options: OptionInfo[], input: string): string {
  const trimmed = input.trim();
  const byValue = options.find((o) => o.value === trimmed);
  if (byValue) return byValue.value;

  const lc = trimmed.toLowerCase();
  const byLabelExact = options.find((o) => o.label.toLowerCase() === lc);
  if (byLabelExact) return byLabelExact.value;

  const byLabelContains = options.filter(
    (o) => o.label.toLowerCase().includes(lc) && o.value !== "",
  );
  if (byLabelContains.length === 1) return byLabelContains[0].value;
  if (byLabelContains.length > 1) {
    throw new Error(
      `Ambiguous option "${input}" — matches ${byLabelContains
        .slice(0, 8)
        .map((o) => `${o.label} (${o.value})`)
        .join(", ")}. Be more specific or pass the exact value.`,
    );
  }

  const sample = options
    .filter((o) => o.value !== "")
    .slice(0, 10)
    .map((o) => o.label)
    .join(", ");
  throw new Error(
    `No option matching "${input}". Examples: ${sample}${options.length > 10 ? ", …" : ""}`,
  );
}

/**
 * Sets a <select>'s value(s) by option value and fires input/change events so
 * select2 (and other JS widgets) sync their display. Works even when the
 * native select is visually hidden behind a widget.
 */
export async function setSelect(
  page: Page,
  selector: string,
  values: string[],
): Promise<void> {
  await page.locator(selector).first().waitFor({ state: "attached" });
  await page.evaluate(
    ({ selector, values }) => {
      const el = document.querySelector(selector) as HTMLSelectElement | null;
      if (!el) throw new Error(`select not found: ${selector}`);

      // Preferred path: when jQuery is present these selects are select2
      // widgets. `$(el).val(values).trigger('change')` updates BOTH the native
      // select and select2's internal model (which it reads on submit).
      const w = window as unknown as {
        jQuery?: (e: Element) => { val: (v: string[]) => { trigger: (s: string) => void } };
      };
      if (typeof w.jQuery === "function") {
        try {
          w.jQuery(el).val(values).trigger("change");
          return;
        } catch {
          /* fall through to native */
        }
      }

      const opts = Array.from(el.options);
      opts.forEach((o) => (o.selected = false));
      for (const v of values) {
        const opt = opts.find((o) => o.value === v);
        if (opt) opt.selected = true;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { selector, values },
  );
}

/** Resolve a label/value against a select and set it. Returns resolved value. */
export async function selectByLabelOrValue(
  page: Page,
  selector: string,
  input: string,
): Promise<string> {
  const opts = await readOptions(page, selector);
  const value = resolveOption(opts, input);
  await setSelect(page, selector, [value]);
  return value;
}

/** Resolve & set multiple values on a multi-select. Returns resolved values. */
export async function multiSelectByLabelOrValue(
  page: Page,
  selector: string,
  inputs: string[],
): Promise<string[]> {
  const opts = await readOptions(page, selector);
  const values = inputs.map((i) => resolveOption(opts, i));
  await setSelect(page, selector, values);
  return values;
}

/**
 * Selects a radio button by its value within a named group.
 *
 * Many of these forms use custom-styled radios (the native input is hidden
 * behind a label) and attach onclick handlers like `toggleFields()` that show
 * dependent sections. A real DOM `.click()` works on hidden elements AND fires
 * those handlers, so we use it instead of Playwright's actionability-gated
 * check().
 */
export async function setRadio(page: Page, name: string, value: string): Promise<void> {
  const found = await page.evaluate(
    ({ name, value }) => {
      const radios = Array.from(
        document.querySelectorAll(`input[type="radio"][name="${name}"]`),
      ) as HTMLInputElement[];
      const target = radios.find((r) => r.value === value);
      if (!target) return false;
      target.click(); // sets checked + fires onclick handler (e.g. toggleFields)
      if (!target.checked) target.checked = true;
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    { name, value },
  );
  if (!found) {
    const available = await page
      .locator(`input[type="radio"][name="${name}"]`)
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    throw new Error(
      `radio ${name} has no option with value "${value}". Available: ${available.join(", ")}`,
    );
  }
}
