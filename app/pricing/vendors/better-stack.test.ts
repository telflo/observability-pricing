import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import type { Settings, VendorEstimate, Workload } from "../types";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { betterStack } from "./better-stack";

// Rates read on betterstack.com/pricing on 2026-11-12.
//   Logs and traces, ingestion:  $0.15 per GB in the United States, $0.10 in Europe
//   Logs and traces, retention:  $0.08 per GB per month in the United States, $0.05 in Europe
//   Metrics, retention:          $0.75 per GB per month in the United States, $0.50 in Europe
//   Included: 3 GB of logs and 3 GB of traces a month kept 3 days, 30 GB of metrics
//   Responder license: $29 a month billed yearly, $34 billed monthly. Paid plans start at one.
const US_YEARLY: Settings = { term: "annual", region: "us", queryLoad: "typical" };
const US_MONTHLY: Settings = { ...US_YEARLY, term: "monthly" };
const EU_YEARLY: Settings = { ...US_YEARLY, region: "eu" };

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

/** Logs alone at a daily volume and a retention in days. */
const logsOnly = (gbPerDay: number, retentionDays: number): Workload => {
  const w = mid();
  w.logs = { ...w.logs, gbPerDay, retentionDays };
  return onlySignals(w, ["logs"]);
};

/** Dollars billed at one rate, whichever signals the lines belong to. */
const amountAt = (estimate: VendorEstimate, rateId: string) =>
  estimate.lines.filter((l) => l.rateId === rateId).reduce((sum, l) => sum + l.amount, 0);

const usdOf = (rateId: string) => betterStack.rates.find((r) => r.id === rateId)!.usd;

describe("Better Stack: worked examples", () => {
  it("prices the mid preset as shipped, with default settings (United States, yearly)", () => {
    // Hand-computed from betterstack.com/pricing and docs/logs/billing-for-metrics, 2026-11-12.
    // Logs: 330 GB/day × 30 days = 9,900 GB a month, kept 30 days = 9,900 GB held.
    //   ingestion  (9,900 - 3) GB × $0.15                  =  $1,484.55
    //   retention  (9,900 - 3 GB × 3 days / 30) GB × $0.08 =    $791.976
    // Traces: 2,000 spans/s × 2,592,000 s × 1,000 bytes = 5,184 GB a month, kept 30 days.
    //   ingestion  (5,184 - 3) GB × $0.15                  =    $777.15
    //   retention  (5,184 - 0.3) GB × $0.08                =    $414.696
    // Metrics: billed at $0.75 per GB held, on the size Better Stack stores. It
    //   publishes no size per data point, so the line is not priced.
    // One responder license, billed yearly                 =     $29
    // Total of the priced parts                            =  $3,497.372
    const estimate = estimateVendor(betterStack, presetById("mid")!.workload, DEFAULT_SETTINGS);
    expect(estimate.byBucket.logs).toBeCloseTo(2276.526, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(1191.846, 6);
    expect(estimate.byBucket.metrics).toBe(0);
    expect(estimate.byBucket.platform).toBeCloseTo(29, 6);
    expect(estimate.monthly).toBeCloseTo(3497.372, 6);
    expect(estimate.complete).toBe(false);
    expect(estimate.unpriced.map((u) => u.bucket)).toEqual(["metrics"]);
    expect(estimate.shortRetention).toEqual([]);
  });

  it("prices 100 GB of logs a day kept 30 days, with default settings", () => {
    // 100 GB/day × 30 days = 3,000 GB a month, kept 30 days = 3,000 GB held.
    //   ingestion  (3,000 - 3) GB × $0.15    = $449.55
    //   retention  (3,000 - 0.3) GB × $0.08  = $239.976
    //   logs                                 = $689.526
    //   one responder license, yearly        =  $29
    //   total                                = $718.526
    const estimate = estimateVendor(betterStack, logsOnly(100, 30), DEFAULT_SETTINGS);
    expect(amountAt(estimate, "ingest-us")).toBeCloseTo(449.55, 6);
    expect(amountAt(estimate, "retention-us")).toBeCloseTo(239.976, 6);
    expect(estimate.byBucket.logs).toBeCloseTo(689.526, 6);
    expect(estimate.monthly).toBeCloseTo(718.526, 6);
  });

  it("follows the vendor's log example, less the free allowance that example leaves out", () => {
    // betterstack.com/community/comparisons/better-stack-vs-grafana-cloud: "A service
    // generating 100GB/month costs $10 ingestion + $5 retention = $15 total", at the
    // Europe rates with a month of retention. The example does not take off the
    // 3 GB a month kept 3 days that the pricing page includes:
    //   ingestion  (100 - 3) GB x $0.10                        =  $9.70
    //   retention  (100 - 3 GB x 3 days / 30 days) GB x $0.05  =  $4.985
    //   logs                                                   = $14.685
    // That is the vendor's $15 less 3 GB x $0.10 and 0.3 GB x $0.05, or $0.315.
    const estimate = estimateVendor(betterStack, logsOnly(100 / 30, 30), EU_YEARLY);
    expect(amountAt(estimate, "ingest-eu")).toBeCloseTo(9.7, 6);
    expect(amountAt(estimate, "retention-eu")).toBeCloseTo(4.985, 6);
    expect(estimate.byBucket.logs).toBeCloseTo(14.685, 6);
    expect(15 - estimate.byBucket.logs).toBeCloseTo(0.315, 6);
    // Paid plans start at one responder license: $29 a month billed yearly.
    expect(estimate.byBucket.platform).toBeCloseTo(29, 6);
    expect(estimate.monthly).toBeCloseTo(43.685, 6);
  });

  it("prices logs alone: ingestion, then a month of retention", () => {
    // 330 GB/day x 30 days = 9,900 GB a month, kept 30 days = 9,900 GB held.
    //   ingestion  (9,900 - 3) GB x $0.15    = $1,484.55
    //   retention  (9,900 - 0.3) GB x $0.08  =   $791.976
    //   logs                                 = $2,276.526
    //   one responder license                =    $29
    const estimate = estimateVendor(betterStack, onlySignals(mid(), ["logs"]), US_YEARLY);
    expect(amountAt(estimate, "ingest-us")).toBeCloseTo(1484.55, 6);
    expect(amountAt(estimate, "retention-us")).toBeCloseTo(791.976, 6);
    expect(estimate.byBucket.logs).toBeCloseTo(2276.526, 6);
    expect(estimate.byBucket.traces).toBe(0);
    expect(estimate.byBucket.metrics).toBe(0);
    expect(estimate.monthly).toBeCloseTo(2305.526, 6);
    expect(estimate.complete).toBe(true);
  });

  it("prices traces alone at the same two rates", () => {
    // 2,000 spans/s x 2,592,000 s x 1,000 bytes = 5,184 GB a month, kept 30 days.
    //   ingestion  (5,184 - 3) GB x $0.15    =   $777.15
    //   retention  (5,184 - 0.3) GB x $0.08  =   $414.696
    //   traces                               = $1,191.846
    //   one responder license                =    $29
    const estimate = estimateVendor(betterStack, onlySignals(mid(), ["traces"]), US_YEARLY);
    expect(amountAt(estimate, "ingest-us")).toBeCloseTo(777.15, 6);
    expect(amountAt(estimate, "retention-us")).toBeCloseTo(414.696, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(1191.846, 6);
    expect(estimate.byBucket.logs).toBe(0);
    expect(estimate.monthly).toBeCloseTo(1220.846, 6);
  });

  it("leaves metrics unpriced, because the stored size per data point is not published", () => {
    // Better Stack bills metrics per GB held, measured as the size it stores, and
    // publishes no size per data point. Sizing them from OTLP bytes would be a guess.
    const estimate = estimateVendor(betterStack, onlySignals(mid(), ["metrics"]), US_YEARLY);
    expect(estimate.lines).toEqual([]);
    expect(estimate.monthly).toBe(0);
    expect(estimate.complete).toBe(false);
    expect(estimate.unpriced).toHaveLength(1);
    expect(estimate.unpriced[0].bucket).toBe("metrics");
    expect(estimate.unpriced[0].reason).toContain("publishes no size per data point");
    // The published rate is still quoted, built from the rates table.
    expect(estimate.unpriced[0].reason).toContain("$0.75");
  });

  it("uses the Europe price list when the data is stored in Europe", () => {
    //   logs     9,897 GB x $0.10 + 9,899.7 GB x $0.05  =  $1,484.685
    //   traces   5,181 GB x $0.10 + 5,183.7 GB x $0.05  =    $777.285
    //   metrics  not priced (no published size per data point)
    //   one responder license                           =     $29
    //   priced parts                                    =  $2,290.97
    const estimate = estimateVendor(betterStack, mid(), EU_YEARLY);
    expect(estimate.byBucket.logs).toBeCloseTo(1484.685, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(777.285, 6);
    expect(estimate.byBucket.metrics).toBe(0);
    expect(estimate.monthly).toBeCloseTo(2290.97, 6);
    expect(estimate.lines.every((l) => !l.rateId.endsWith("-us"))).toBe(true);
  });

  it("charges retention in proportion to the days kept", () => {
    // 100 GB/day = 3,000 GB a month. Ingestion is (3,000 - 3) GB x $0.15 = $449.55 either way.
    //   kept 7 days:   (100 x 7 - 0.3) GB x $0.08   =  $55.976, logs = $505.526
    //   kept 90 days:  (100 x 90 - 0.3) GB x $0.08  = $719.976, logs = $1,169.526
    const week = estimateVendor(betterStack, logsOnly(100, 7), US_YEARLY);
    expect(amountAt(week, "ingest-us")).toBeCloseTo(449.55, 6);
    expect(amountAt(week, "retention-us")).toBeCloseTo(55.976, 6);
    expect(week.byBucket.logs).toBeCloseTo(505.526, 6);

    const quarter = estimateVendor(betterStack, logsOnly(100, 90), US_YEARLY);
    expect(amountAt(quarter, "ingest-us")).toBeCloseTo(449.55, 6);
    expect(amountAt(quarter, "retention-us")).toBeCloseTo(719.976, 6);
    expect(quarter.byBucket.logs).toBeCloseTo(1169.526, 6);
  });

  it("charges nothing while everything fits the free allowances", () => {
    // Logs: 0.1 GB/day = 3 GB a month kept 3 days, exactly the allowance.
    // Traces: 1 span/s x 2,592,000 s x 1,000 bytes = 2.592 GB a month kept 3 days.
    const w = onlySignals(mid(), ["logs", "traces"]);
    w.logs = { ...w.logs, gbPerDay: 0.1, retentionDays: 3 };
    w.traces = { ...w.traces, spansPerSecond: 1, avgSpanBytes: 1000, retentionDays: 3 };
    const estimate = estimateVendor(betterStack, w, US_YEARLY);
    expect(estimate.lines).toEqual([]);
    expect(estimate.monthly).toBe(0);
    expect(estimate.complete).toBe(true);
    expect(estimate.assumptions.join(" ")).toContain("free plan");
  });

  it("starts the paid plan as soon as an allowance is crossed", () => {
    // 0.2 GB/day = 6 GB a month kept 3 days = 0.6 GB held.
    //   ingestion  (6 - 3) GB x $0.15      = $0.45
    //   retention  (0.6 - 0.3) GB x $0.08  = $0.024
    //   logs                               = $0.474
    //   one responder license              = $29
    const estimate = estimateVendor(betterStack, logsOnly(0.2, 3), US_YEARLY);
    expect(estimate.byBucket.logs).toBeCloseTo(0.474, 6);
    expect(estimate.byBucket.platform).toBeCloseTo(29, 6);
    expect(estimate.monthly).toBeCloseTo(29.474, 6);
  });

  it("bills one responder license however many signals are sent, at the price of the term", () => {
    // Priced usage: $2,276.526 logs + $1,191.846 traces = $3,468.372.
    const yearly = estimateVendor(betterStack, mid(), US_YEARLY);
    expect(yearly.byBucket.platform).toBeCloseTo(29, 6);
    expect(yearly.monthly).toBeCloseTo(3497.372, 6);

    // Monthly billing changes only the license, $34 in place of $29. The usage
    // rates have one published price: $3,468.372 + $34 = $3,502.372.
    const monthly = estimateVendor(betterStack, mid(), US_MONTHLY);
    expect(monthly.byBucket.platform).toBeCloseTo(34, 6);
    expect(monthly.byBucket.logs).toBeCloseTo(2276.526, 6);
    expect(monthly.byBucket.traces).toBeCloseTo(1191.846, 6);
    expect(monthly.monthly).toBeCloseTo(3502.372, 6);

    // Metrics routed elsewhere: $2,276.526 + $1,191.846 + $29 = $3,497.372.
    const split = estimateVendor(betterStack, onlySignals(mid(), ["logs", "traces"]), US_YEARLY);
    expect(split.byBucket.metrics).toBe(0);
    expect(split.byBucket.platform).toBeCloseTo(29, 6);
    expect(split.monthly).toBeCloseTo(3497.372, 6);
  });

  it("keeps everything searchable: the searchable share does not change the bill", () => {
    const w = mid();
    w.logs = { ...w.logs, searchableShare: 0.2 };
    const estimate = estimateVendor(betterStack, onlySignals(w, ["logs"]), US_YEARLY);
    // Same as the full-share case: $2,276.526.
    expect(estimate.byBucket.logs).toBeCloseTo(2276.526, 6);
    expect(estimate.assumptions.join(" ")).toContain("searchable share");
  });

  it("has rates that reproduce the bundle discounts printed on the pricing page", () => {
    // betterstack.com/pricing sells bundles of N GB of traces, N GB of logs and
    // N GB of metrics with 30-day log retention, and labels each with its
    // discount (Europe prices). At pay-as-you-go rates one bundle GB is a GB of
    // logs and a GB of traces, each ingested and kept a month, plus a GB of
    // metrics: 2 x ($0.10 + $0.05) + $0.50 = $0.80.
    //   Nano   40 GB = $32:   $30 monthly is 6% off,  $25 yearly is 22% off
    //   Micro 160 GB = $128: $120 monthly is 6% off, $100 yearly is 22% off
    //   Mega  340 GB = $272: $250 monthly is 8% off, $210 yearly is 23% off
    //   Tera  700 GB = $560: $500 monthly is 11% off, $420 yearly is 25% off
    const perBundleGb = 2 * (usdOf("ingest-eu") + usdOf("retention-eu")) + usdOf("metrics-eu");
    expect(perBundleGb).toBeCloseTo(0.8, 9);
    const bundles = [
      { gb: 40, monthly: 30, monthlyOff: 6, yearly: 25, yearlyOff: 22 },
      { gb: 160, monthly: 120, monthlyOff: 6, yearly: 100, yearlyOff: 22 },
      { gb: 340, monthly: 250, monthlyOff: 8, yearly: 210, yearlyOff: 23 },
      { gb: 700, monthly: 500, monthlyOff: 11, yearly: 420, yearlyOff: 25 },
    ];
    for (const b of bundles) {
      const payAsYouGo = b.gb * perBundleGb;
      expect(Math.round((1 - b.monthly / payAsYouGo) * 100)).toBe(b.monthlyOff);
      expect(Math.round((1 - b.yearly / payAsYouGo) * 100)).toBe(b.yearlyOff);
    }
  });
});
