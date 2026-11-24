import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import type { PriceInput, Settings, VendorEstimate, Workload } from "../types";
import { derive } from "../units";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { openobserve } from "./openobserve";

// Rates read on openobserve.ai on 2026-11-12: $0.50 per GB ingested on an annual
// commitment (pricing page), $0.70 pay as you go (two blog posts), $0.01 per GB
// queried, $0.02 per GB for each additional 30 days of log and trace retention.
// Query loads scan 5 (light), 20 (typical) or 100 (heavy) GB per GB ingested.
//
// The bills worked by hand (the mid preset, 100 GB of logs a day, the vendor's
// 1,300 GB example on both terms, 90-day retention, the 20 GB month) are the
// `examples` in openobserve.ts. These tests cover what a total alone does not
// show: the vendor's ingestion-only tables, each rate on its own, and how the
// retention charge grows by the day.
const ANNUAL: Settings = { term: "annual", region: "us", queryLoad: "typical" };
const PAY_AS_YOU_GO: Settings = { ...ANNUAL, term: "monthly" };
const LIGHT: Settings = { ...ANNUAL, queryLoad: "light" };
const HEAVY: Settings = { ...ANNUAL, queryLoad: "heavy" };

/** The mid-size preset, with every number these examples depend on written out. */
const mid = (): Workload => {
  const w = structuredClone(presetById("mid")!.workload);
  w.logs = { ...w.logs, gbPerDay: 330, retentionDays: 30, searchableShare: 1 };
  w.metrics = {
    ...w.metrics,
    activeSeries: 250_000,
    intervalSeconds: 60,
    bytesPerDataPoint: 150,
    retentionMonths: 13,
  };
  w.traces = {
    ...w.traces,
    spansPerSecond: 2000,
    avgSpanBytes: 1000,
    retentionDays: 30,
    searchableShare: 1,
  };
  return w;
};

/** Logs alone at a daily volume. 100 GB a day is 3,000 GB a month. */
const logsOnly = (gbPerDay: number, retentionDays = 30): Workload => {
  const w = mid();
  w.logs = { ...w.logs, gbPerDay, retentionDays };
  return onlySignals(w, ["logs"]);
};

/** Traces alone: 1,000 spans/s x 2,592,000 s x 1,000 bytes = 2,592 GB a month. */
const tracesOnly = (retentionDays = 30): Workload => {
  const w = mid();
  w.traces = { ...w.traces, spansPerSecond: 1000, avgSpanBytes: 1000, retentionDays };
  return onlySignals(w, ["traces"]);
};

/** Metrics alone: 100,000 series x 43,200 points a month x 150 bytes = 648 GB a month. */
const metricsOnly = (retentionMonths = 13, bytesPerDataPoint = 150): Workload => {
  const w = mid();
  w.metrics = {
    ...w.metrics,
    activeSeries: 100_000,
    intervalSeconds: 60,
    bytesPerDataPoint,
    retentionMonths,
  };
  return onlySignals(w, ["metrics"]);
};

/** The adapter's input, to read what it returns in `kept`. */
const priceInput = (w: Workload, s: Settings): PriceInput => ({ w, d: derive(w), s });

/** Dollars billed at one rate, whichever signals the lines belong to. */
const amountAt = (estimate: VendorEstimate, rateId: string) =>
  estimate.lines.filter((l) => l.rateId === rateId).reduce((sum, l) => sum + l.amount, 0);

const hasLineAt = (estimate: VendorEstimate, rateId: string) =>
  estimate.lines.some((l) => l.rateId === rateId);

describe("OpenObserve Cloud: the vendor's ingestion figures", () => {
  it("matches the vendor's cost table for logs at 10, 100 and 1,000 GB a day", () => {
    // openobserve.ai/blog/self-hosted-vs-saas-vs-byoc-observability, ingestion only:
    // annual contract $150 / $1,500 / $15,000, pay as you go $210 / $2,100 / $21,000.
    const table = [
      { gbPerDay: 10, annual: 150, payAsYouGo: 210 }, // 300 GB x 0.50, x 0.70
      { gbPerDay: 100, annual: 1500, payAsYouGo: 2100 }, // 3,000 GB
      { gbPerDay: 1000, annual: 15_000, payAsYouGo: 21_000 }, // 30,000 GB
    ];
    for (const row of table) {
      const logs = logsOnly(row.gbPerDay);
      expect(amountAt(estimateVendor(openobserve, logs, ANNUAL), "ingest-annual")).toBeCloseTo(
        row.annual,
        6,
      );
      expect(amountAt(estimateVendor(openobserve, logs, PAY_AS_YOU_GO), "ingest-payg")).toBeCloseTo(
        row.payAsYouGo,
        6,
      );
    }
  });

  it("matches the pricing page estimator: 1 GB a day is $15 of ingestion", () => {
    // openobserve.ai/pricing: "{volume} GB/day × 30 days × $0.50/GB", flat from 1 to
    // 2,000 GB a day. At the top of the slider: 2,000 x 30 x $0.50 = $30,000.
    expect(
      amountAt(estimateVendor(openobserve, logsOnly(1), ANNUAL), "ingest-annual"),
    ).toBeCloseTo(15, 6);
    expect(
      amountAt(estimateVendor(openobserve, logsOnly(2000), ANNUAL), "ingest-annual"),
    ).toBeCloseTo(30_000, 6);
  });

  it("splits the vendor's 1,300 GB example into ingestion and queries on both terms", () => {
    // openobserve.ai/blog/observability-pricing-models: 900 GB logs, 300 GB traces and
    // 100 GB metrics a month. Annual: "1,300 × 0.50 = $650". Pay as you go:
    // "1,300 × 0.70 + 50 = $960", of which $910 is ingestion. The vendor's example
    // scans 5,000 GB ($50). The light query load here scans 5 GB per GB ingested:
    // 6,500 GB x $0.01 = $65, and the query price does not change with the term.
    const w = mid();
    w.logs = { ...w.logs, gbPerDay: 30 };
    w.traces = { ...w.traces, spansPerSecond: 300e9 / 2_592_000 / 1000, avgSpanBytes: 1000 };
    w.metrics = { ...w.metrics, activeSeries: 100e9 / (43_200 * 150) };

    const annual = estimateVendor(openobserve, w, LIGHT);
    expect(amountAt(annual, "ingest-annual")).toBeCloseTo(650, 6);
    expect(amountAt(annual, "query")).toBeCloseTo(65, 6);

    const payAsYouGo = estimateVendor(openobserve, w, { ...LIGHT, term: "monthly" });
    expect(amountAt(payAsYouGo, "ingest-payg")).toBeCloseTo(910, 6);
    expect(hasLineAt(payAsYouGo, "ingest-annual")).toBe(false);
    expect(amountAt(payAsYouGo, "query")).toBeCloseTo(65, 6);
  });
});

describe("OpenObserve Cloud: each meter", () => {
  it("prices traces alone by GB", () => {
    const estimate = estimateVendor(openobserve, tracesOnly(), ANNUAL);
    // 2,592 GB x $0.50 = $1,296, plus 2,592 x 20 = 51,840 GB scanned x $0.01 = $518.40
    expect(estimate.byBucket.traces).toBeCloseTo(1814.4, 6);
    expect(estimate.byBucket.logs).toBe(0);
    expect(estimate.byBucket.metrics).toBe(0);
    expect(estimate.byBucket.platform).toBe(0);
    expect(estimate.monthly).toBeCloseTo(1814.4, 6);
  });

  it("prices metrics alone by GB of data points", () => {
    const estimate = estimateVendor(openobserve, metricsOnly(), ANNUAL);
    // 648 GB x $0.50 = $324, plus 648 x 20 = 12,960 GB scanned x $0.01 = $129.60
    expect(estimate.byBucket.metrics).toBeCloseTo(453.6, 6);
    expect(estimate.byBucket.logs).toBe(0);
    expect(estimate.byBucket.traces).toBe(0);
    expect(estimate.byBucket.platform).toBe(0);
    expect(estimate.monthly).toBeCloseTo(453.6, 6);

    // Half the bytes per point is half the GB: 324 GB x $0.50 + 6,480 GB scanned x $0.01 = $226.80
    const smaller = estimateVendor(openobserve, metricsOnly(13, 75), ANNUAL);
    expect(smaller.monthly).toBeCloseTo(226.8, 6);

    // Hosts and series counts never appear as a billing unit
    expect(estimate.lines.map((l) => l.unit)).toEqual(["GB", "GB"]);
  });

  it("uses the pay-as-you-go rate for the monthly term, on ingestion only", () => {
    // mid preset: 16,704 GB x $0.70 = $11,692.80, plus the same $3,340.80 of queries
    const payAsYouGo = estimateVendor(openobserve, mid(), PAY_AS_YOU_GO);
    expect(amountAt(payAsYouGo, "ingest-payg")).toBeCloseTo(11_692.8, 6);
    expect(amountAt(payAsYouGo, "query")).toBeCloseTo(3340.8, 6);
    expect(payAsYouGo.monthly).toBeCloseTo(15_033.6, 6);
    expect(openobserve.plan(PAY_AS_YOU_GO)).toContain("pay as you go");
    expect(openobserve.plan(ANNUAL)).toContain("annual");
  });

  it("scales the query charge with the query load", () => {
    // 3,000 GB ingested: 5x = 15,000 GB = $150; 20x = 60,000 GB = $600; 100x = 300,000 GB = $3,000
    expect(amountAt(estimateVendor(openobserve, logsOnly(100), LIGHT), "query")).toBeCloseTo(150, 6);
    expect(amountAt(estimateVendor(openobserve, logsOnly(100), ANNUAL), "query")).toBeCloseTo(600, 6);
    expect(amountAt(estimateVendor(openobserve, logsOnly(100), HEAVY), "query")).toBeCloseTo(3000, 6);
    // Heavy total: $1,500 of ingestion + $3,000 of queries
    expect(estimateVendor(openobserve, logsOnly(100), HEAVY).monthly).toBeCloseTo(4500, 6);
  });

  it("ignores region, hosts, users and the searchable share", () => {
    const MID_ANNUAL_TYPICAL = 11_692.8;
    expect(estimateVendor(openobserve, mid(), { ...ANNUAL, region: "eu" }).monthly).toBeCloseTo(
      MID_ANNUAL_TYPICAL,
      6,
    );

    const bigger = mid();
    bigger.infra = { ...bigger.infra, hosts: bigger.infra.hosts * 10 };
    bigger.users = bigger.users * 10;
    expect(estimateVendor(openobserve, bigger, ANNUAL).monthly).toBeCloseTo(MID_ANNUAL_TYPICAL, 6);

    const partlySearchable = mid();
    partlySearchable.logs = { ...partlySearchable.logs, searchableShare: 0.2 };
    expect(estimateVendor(openobserve, partlySearchable, ANNUAL).monthly).toBeCloseTo(
      MID_ANNUAL_TYPICAL,
      6,
    );
  });
});

describe("OpenObserve Cloud: retention", () => {
  it("charges extra retention only past the included 30 days, pro rata by the day", () => {
    // 30 days is included: $1,500 of ingestion + $150 of light queries, no retention line
    const included = estimateVendor(openobserve, logsOnly(100, 30), LIGHT);
    expect(hasLineAt(included, "extra-retention")).toBe(false);
    expect(included.monthly).toBeCloseTo(1650, 6);

    // 7 days costs the same as the included 30
    const short = estimateVendor(openobserve, logsOnly(100, 7), LIGHT);
    expect(hasLineAt(short, "extra-retention")).toBe(false);
    expect(short.monthly).toBeCloseTo(1650, 6);
    // The price buys 30 days, longer than the 7 asked: reported in kept, not as a gap
    expect(openobserve.price(priceInput(logsOnly(100, 7), LIGHT)).kept).toEqual({ logsDays: 30 });
    expect(short.shortRetention).toEqual([]);

    // 90 days: 100 GB/day x 60 days past the included 30 = 6,000 GB held x $0.02 = $120.
    // Ingestion plus retention is $1,620 on 3,000 GB, the $0.54 a GB ("$0.50 plus two
    // $0.02 extensions") in openobserve.ai/blog/openobserve-vs-signoz.
    const ninety = estimateVendor(openobserve, logsOnly(100, 90), LIGHT);
    expect(amountAt(ninety, "extra-retention")).toBeCloseTo(120, 6);
    expect(amountAt(ninety, "ingest-annual") + amountAt(ninety, "extra-retention")).toBeCloseTo(
      1620,
      6,
    );
    const line = ninety.lines.find((l) => l.rateId === "extra-retention")!;
    expect(line).toMatchObject({ bucket: "logs", unit: "GB held" });
    expect(line.quantity).toBeCloseTo(6000, 6);
    // Retention is bought as asked, so nothing is reported as kept apart from the ask
    expect(ninety.shortRetention).toEqual([]);

    // 180 days: 100 GB/day x 150 days = 15,000 GB held x $0.02 = $300 (five 30-day periods)
    const halfYear = estimateVendor(openobserve, logsOnly(100, 180), LIGHT);
    expect(amountAt(halfYear, "extra-retention")).toBeCloseTo(300, 6);

    // 365 days: 100 GB/day x 335 days = 33,500 GB held x $0.02 = $670. The Data Retention
    // meter is in GB-hours (openobserve.ai/docs/user-guide/account-administration/cloud-usage),
    // so the 5 days past eleven whole periods are charged as 5 days, not as a twelfth period.
    const year = estimateVendor(openobserve, logsOnly(100, 365), LIGHT);
    expect(amountAt(year, "extra-retention")).toBeCloseTo(670, 6);
    expect(year.monthly).toBeCloseTo(1650 + 670, 6);

    // One day over: 100 GB held x $0.02 = $2
    const oneDayOver = estimateVendor(openobserve, logsOnly(100, 31), LIGHT);
    expect(amountAt(oneDayOver, "extra-retention")).toBeCloseTo(2, 6);
    expect(oneDayOver.monthly).toBeCloseTo(1652, 6);

    // Whenever extra retention is charged, the assumptions say how and on which plan
    const said = year.assumptions.join(" ");
    expect(said).toContain("GB-hour");
    expect(said).toContain("Enterprise");
    expect(included.assumptions.join(" ")).not.toContain("GB-hour");
  });

  it("extends trace retention at the same rate and never charges for metric retention", () => {
    // 90 days, the longest trace retention the page offers: 86.4 GB/day x 60 days =
    // 5,184 GB held x $0.02 = $103.68
    expect(
      amountAt(estimateVendor(openobserve, tracesOnly(90), ANNUAL), "extra-retention"),
    ).toBeCloseTo(103.68, 6);

    // 13 months of metrics is inside the 15 included: 15 are kept, more than asked
    const thirteen = estimateVendor(openobserve, metricsOnly(13), ANNUAL);
    expect(hasLineAt(thirteen, "extra-retention")).toBe(false);
    expect(openobserve.price(priceInput(metricsOnly(13), ANNUAL)).kept).toEqual({ metricsMonths: 15 });
    expect(thirteen.shortRetention).toEqual([]);

    // 24 months of metrics is past the 15 included and has no public price:
    // the bill stays at $453.60 and the shorter retention is reported.
    const metrics = estimateVendor(openobserve, metricsOnly(24), ANNUAL);
    expect(hasLineAt(metrics, "extra-retention")).toBe(false);
    expect(metrics.monthly).toBeCloseTo(453.6, 6);
    expect(metrics.shortRetention).toEqual([
      { signal: "metrics", asked: 24, kept: 15, unit: "months" },
    ]);
    expect(metrics.complete).toBe(true);
  });
});

describe("OpenObserve Cloud: text", () => {
  it("writes every price in its text from the rates table", () => {
    const estimate = estimateVendor(openobserve, logsOnly(100, 90), ANNUAL);
    const text = [
      ...estimate.assumptions,
      ...estimate.included,
      ...estimate.notIncluded,
      ...estimate.notes,
    ].join(" ");
    const printed = new Set(text.match(/\$\d[\d,]*(?:\.\d+)?/g) ?? []);
    expect([...printed].sort()).toEqual(["$0.01", "$0.02", "$0.50", "$0.70"]);
    expect(text).not.toMatch(/[—;]/);
  });
});
