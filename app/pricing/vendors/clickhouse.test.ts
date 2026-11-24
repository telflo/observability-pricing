import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import type { Settings, VendorEstimate, Workload } from "../types";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { clickhouse } from "./clickhouse";

// The worked examples (the vendor's $650 and $1,000 figures, each signal alone,
// the mid preset) are the `examples` in clickhouse.ts. These tests cover what
// is particular to ClickHouse: the beta prices kept beside the list prices, the
// one retention sold, and the wording rules its text follows.

const base = (): Workload => structuredClone(presetById("mid")!.workload);

const rate = (id: string) => {
  const found = clickhouse.rates.find((r) => r.id === id);
  if (!found) throw new Error(`No rate ${id}`);
  return found;
};

// Rates as read on clickhouse.com/pricing/observability, Scale plan:
//   logs, traces and session replay  $0.20 per uncompressed GB list ($0.10 in beta)
//   metrics                          $0.10 per 1M data points list  ($0.05 in beta)
// 30 days of retention included, no monthly minimum, no volume tiers.
describe("ClickHouse Observability: list and beta prices", () => {
  it("carries the four rates as the pricing page shows them", () => {
    // Scale plan card, plan comparison table and the "What happens to pricing
    // after beta?" answer, read on 2026-11-12. The page shows the beta price
    // with the list price struck through beside it ("$0.20 at GA").
    expect(rate("logs-traces-gb")).toMatchObject({ usd: 0.2, basis: "list", sourceId: "pricing" });
    expect(rate("metrics-1m")).toMatchObject({ usd: 0.1, basis: "list", sourceId: "pricing" });
    expect(rate("logs-traces-gb-beta")).toMatchObject({
      usd: 0.1,
      basis: "promotional",
      sourceId: "pricing",
    });
    expect(rate("metrics-1m-beta")).toMatchObject({
      usd: 0.05,
      basis: "promotional",
      sourceId: "pricing",
    });
    expect(clickhouse.rates).toHaveLength(4);
    expect(clickhouse.sources.find((s) => s.id === "pricing")?.url).toBe(
      "https://clickhouse.com/pricing/observability",
    );
  });

  it("keeps the beta prices in the table and prices nothing with them", () => {
    const gbBeta = rate("logs-traces-gb-beta");
    const metricBeta = rate("metrics-1m-beta");
    // The vendor's $325 beta example, rebuilt from the promotional entries:
    //   2,000 x $0.10 + 1,000 x $0.10 + 500 x $0.05 = 200 + 100 + 25 = $325.
    expect(2000 * gbBeta.usd + 1000 * gbBeta.usd + 500 * metricBeta.usd).toBeCloseTo(325, 6);

    const estimate = estimateVendor(clickhouse, base(), DEFAULT_SETTINGS);
    expect(estimate.lines.length).toBe(3);
    for (const line of estimate.lines) expect(rate(line.rateId).basis).toBe("list");

    // The notes quote one discount for both meters, worked out from the GB
    // entries: 1 - 0.10 / 0.20 = 50%. The metric entries must give the same
    // figure (1 - 0.05 / 0.10), or that sentence is wrong for metrics.
    expect(1 - metricBeta.usd / rate("metrics-1m").usd).toBeCloseTo(
      1 - gbBeta.usd / rate("logs-traces-gb").usd,
      9,
    );
    // The note states the discount as a literal, so it must stay at this figure.
    expect(1 - gbBeta.usd / rate("logs-traces-gb").usd).toBeCloseTo(0.5, 9);
    const notes = estimate.notes.join(" ");
    expect(notes).toContain("50% less");
    expect(notes).toContain("$0.10 per GB");
    expect(notes).toContain("$0.05 per million data points");
  });

  it("bills a beta customer half of the mid preset's list total", () => {
    // List, from the spec's example: 9,900 GB and 5,184 GB x $0.20 + 10,800M x $0.10 = $4,096.80.
    // Beta, from the promotional entries: 9,900 x $0.10 + 5,184 x $0.10 + 10,800 x $0.05
    //   = 990 + 518.40 + 540 = $2,048.40. The vendor's estimator shows the same
    // $990.00 and $518.40 for those volumes of logs and traces.
    const estimate = estimateVendor(clickhouse, base(), DEFAULT_SETTINGS);
    const beta =
      (9900 + 5184) * rate("logs-traces-gb-beta").usd + 10800 * rate("metrics-1m-beta").usd;
    expect(beta).toBeCloseTo(2048.4, 6);
    expect(estimate.monthly).toBeCloseTo(2 * beta, 6);
  });

  it("gives one price for every term, region and query load", () => {
    const variants: Settings[] = [
      { term: "monthly", region: "us", queryLoad: "typical" },
      { term: "annual", region: "eu", queryLoad: "heavy" },
      { term: "monthly", region: "eu", queryLoad: "light" },
    ];
    // One published usage rate, no regional prices, no query charge.
    for (const s of variants) {
      const estimate = estimateVendor(clickhouse, base(), s);
      expect(estimate.monthly).toBeCloseTo(4096.8, 6);
      expect(estimate.notes.join(" ")).toContain(
        "the billing term and the region do not change this estimate",
      );
    }
  });
});

describe("ClickHouse Observability: the one retention sold", () => {
  it("keeps 30 days on every signal, and reports a longer ask as shorter", () => {
    // The presets ask for 13 months of metrics and 30 days of logs and traces.
    const preset = estimateVendor(clickhouse, base(), DEFAULT_SETTINGS);
    expect(preset.shortRetention).toEqual([
      { signal: "metrics", asked: 13, kept: 1, unit: "months" },
    ]);

    // Still 3,000 GB x $0.20: 30 days is the only retention sold today.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 90 };
    const logsOnly = estimateVendor(clickhouse, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(logsOnly.monthly).toBeCloseTo(600, 6);
    expect(logsOnly.complete).toBe(true);
    expect(logsOnly.shortRetention).toEqual([
      { signal: "logs", asked: 90, kept: 30, unit: "days" },
    ]);
  });
});

describe("ClickHouse Observability: text", () => {
  const textOf = (e: VendorEstimate): string[] => [
    ...e.assumptions,
    ...e.included,
    ...e.notIncluded,
    ...e.notes,
    ...e.lines.flatMap((line) => [line.label, line.detail ?? ""]),
  ];

  /** Estimates that between them produce every sentence the spec can write. */
  const samples = (): VendorEstimate[] => {
    const odd = base();
    odd.logs = { ...odd.logs, retentionDays: 90, searchableShare: 0.2 };
    odd.traces = { ...odd.traces, retentionDays: 7 };
    return [
      estimateVendor(clickhouse, base(), DEFAULT_SETTINGS),
      estimateVendor(clickhouse, odd, { term: "monthly", region: "eu", queryLoad: "heavy" }),
      estimateVendor(clickhouse, onlySignals(base(), ["logs"]), DEFAULT_SETTINGS),
    ];
  };

  const everyText = (): string[] => [
    clickhouse.plan(DEFAULT_SETTINGS),
    ...clickhouse.rates.flatMap((r) => [r.label, r.unit, r.note ?? ""]),
    ...clickhouse.sources.map((s) => s.label),
    ...samples().flatMap(textOf),
  ];

  it("uses no em dash, en dash or semicolon", () => {
    // U+2014 and U+2013, written as code points so this file stays ASCII.
    const banned = new RegExp(`[${String.fromCharCode(0x2014, 0x2013)};]`);
    for (const text of everyText()) expect(text).not.toMatch(banned);
  });

  it("leaves the closing period off rate notes, because the page adds one", () => {
    for (const r of clickhouse.rates) expect(r.note ?? "").not.toMatch(/\.$/);
  });

  it("explains metric billing only when metrics are sent", () => {
    const all = estimateVendor(clickhouse, base(), DEFAULT_SETTINGS);
    const logsOnly = estimateVendor(clickhouse, onlySignals(base(), ["logs"]), DEFAULT_SETTINGS);
    expect(all.notes.join(" ")).toContain("Metrics bill per data point");
    expect(logsOnly.notes.join(" ")).not.toContain("Metrics bill per data point");
    // The price basis and the beta discount are said either way, and first.
    for (const estimate of [all, logsOnly]) {
      expect(estimate.notes[0]).toContain("list price");
      expect(estimate.notes[0]).toContain("public beta");
    }
  });
});
