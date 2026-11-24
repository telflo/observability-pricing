/**
 * An estimate as something to paste into a ticket or hand to procurement:
 * a Markdown summary table, and a CSV with every line item and its source.
 *
 * Both keep the page's rule that a partly priced platform is never ranked with
 * the fully priced ones: complete estimates come first, in the order given,
 * and partial ones follow under a separate heading.
 */
import { compact, duration, num, usd } from "./format";
import type { Settings, VendorEstimate, Workload } from "./types";
import { activeSignals, derive } from "./units";

/** One sentence that pins down what was priced. */
export function describeWorkload(w: Workload, s: Settings): string {
  const d = derive(w);
  const active = activeSignals(w);
  const parts: string[] = [];
  if (active.includes("logs")) {
    parts.push(`${num(w.logs.gbPerDay)} GB of logs a day kept ${duration(w.logs.retentionDays, "days")}`);
  }
  if (active.includes("metrics")) {
    parts.push(
      `${compact(d.metrics.activeSeries)} metric series every ${w.metrics.intervalSeconds} s kept ${duration(w.metrics.retentionMonths, "months")}`,
    );
  }
  if (active.includes("traces")) {
    parts.push(
      `${compact(w.traces.spansPerSecond)} spans a second kept ${duration(w.traces.retentionDays, "days")}`,
    );
  }
  if (active.includes("profiles")) {
    parts.push(
      `continuous profiling on ${num(d.profiles.profiledHosts, 0)} hosts at ${num(w.profiles.samplesPerSecondPerHost, 0)} samples a second`,
    );
  }
  parts.push(`${num(w.infra.hosts, 0)} hosts`, `${num(w.users, 0)} ${w.users === 1 ? "seat" : "seats"}`);
  const term = s.term === "annual" ? "Annual commitment" : "Pay as you go";
  return `${parts.join(", ")}. ${term}, ${s.region.toUpperCase()} region.`;
}

/** What makes an estimate not like-for-like, in words, or "" when nothing does. */
function caveat(e: VendorEstimate): string {
  const notes: string[] = [];
  if (!e.complete) {
    notes.push(`no public price for part of ${[...new Set(e.unpriced.map((u) => u.bucket))].join(", ")}`);
  }
  for (const gap of e.shortRetention) {
    notes.push(`${gap.signal} kept ${duration(gap.kept, gap.unit)}`);
  }
  return notes.join("; ");
}

const cell = (text: string) => text.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

const HEADER = [
  "| Platform | Plan priced | Logs | Metrics | Traces | Base fees and seats | Monthly | Rates checked | Source |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
];

function row(e: VendorEstimate, s: Settings): string {
  const money = (n: number) => (n > 0 ? usd(n) : "");
  const note = e.shortRetention.map((g) => `${g.signal} kept ${duration(g.kept, g.unit)}`).join(", ");
  const total = !e.complete
    ? e.monthly > 0
      ? `${usd(e.monthly)} for the priced parts`
      : "Not priced"
    : note
      ? `${usd(e.monthly)} (${note})`
      : usd(e.monthly);
  return `| ${cell(e.vendor.name)} | ${cell(e.vendor.plan(s))} | ${money(e.byBucket.logs)} | ${money(
    e.byBucket.metrics,
  )} | ${money(e.byBucket.traces)} | ${money(e.byBucket.platform)} | ${total} | ${e.vendor.checkedOn} | ${e.vendor.pricingUrl} |`;
}

export function toMarkdown(
  estimates: VendorEstimate[],
  w: Workload,
  s: Settings,
  link?: string,
): string {
  const complete = estimates.filter((e) => e.complete);
  const partial = estimates.filter((e) => !e.complete);
  return [
    `**Observability list-price estimate**: ${describeWorkload(w, s)}`,
    "",
    ...HEADER,
    ...complete.map((e) => row(e, s)),
    ...(partial.length > 0
      ? [
          "",
          "**Part of this has no public price.** These amounts cover only the parts each platform does price, so they cannot be compared with the totals above.",
          "",
          ...HEADER,
          ...partial.map((e) => row(e, s)),
        ]
      : []),
    "",
    "Estimates at public list price in US dollars. These are not quotes. Negotiated discounts and anything not modeled will change what you pay.",
    ...(link ? [`Reproduce or change the inputs: ${link}`] : []),
  ].join("\n");
}

/**
 * One CSV field. Text that a spreadsheet would run as a formula (it starts
 * with = + - @, a tab or a carriage return) gets a leading apostrophe; numbers
 * are left alone so a negative stays a number.
 */
export const csvCell = (value: string | number | null) => {
  let text = value === null ? "" : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const CSV_HEADER = [
  "backend",
  "plan_priced",
  "part_of_bill",
  "item",
  "how_quantity_was_reached",
  "quantity",
  "unit",
  "rate_usd",
  "rate_unit",
  "rate_basis",
  "monthly_usd",
  "status",
  "source_url",
  "rates_checked_on",
];

/**
 * Every line item, then one "Total" row per platform so a total never has to
 * be rebuilt in a pivot table. The first data row says what was priced.
 */
export function toCsv(estimates: VendorEstimate[], w: Workload, s: Settings): string {
  const lines: string[] = [CSV_HEADER.join(",")];
  const push = (cells: (string | number)[]) => lines.push(cells.map(csvCell).join(","));

  push(["Workload", "", "", describeWorkload(w, s), "", "", "", "", "", "", "", "", "", ""]);

  const ordered = [...estimates.filter((e) => e.complete), ...estimates.filter((e) => !e.complete)];
  for (const e of ordered) {
    const rates = new Map(e.vendor.rates.map((r) => [r.id, r]));
    const sources = new Map(e.vendor.sources.map((src) => [src.id, src]));
    const plan = e.vendor.plan(s);
    for (const line of e.lines) {
      const rate = rates.get(line.rateId);
      const source = rate ? sources.get(rate.sourceId) : undefined;
      push([
        e.vendor.name,
        plan,
        line.bucket,
        line.label,
        line.detail ?? "",
        Number(line.quantity.toPrecision(10)),
        line.unit,
        rate ? Number(rate.usd.toPrecision(10)) : "",
        rate?.unit ?? "",
        rate?.basis ?? "",
        line.amount.toFixed(2),
        "",
        source?.url ?? e.vendor.pricingUrl,
        e.vendor.checkedOn,
      ]);
    }
    for (const gap of e.unpriced) {
      push([e.vendor.name, plan, gap.bucket, "No public price", gap.reason, "", "", "", "", "", "", "", e.vendor.pricingUrl, e.vendor.checkedOn]);
    }
    push([
      e.vendor.name,
      plan,
      "total",
      "Total",
      "",
      "",
      "",
      "",
      "",
      "",
      e.monthly.toFixed(2),
      caveat(e) || "complete",
      e.vendor.pricingUrl,
      e.vendor.checkedOn,
    ]);
  }
  return lines.join("\n");
}
