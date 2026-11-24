import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import type { Settings, Workload } from "../types";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { azureMonitor } from "./azure-monitor";

const base = (): Workload => structuredClone(presetById("mid")!.workload);

/** DEFAULT_SETTINGS is the one-year term, East US, typical query load. */
const MONTH_TO_MONTH: Settings = { ...DEFAULT_SETTINGS, term: "monthly" };
const WEST_EUROPE: Settings = { ...DEFAULT_SETTINGS, region: "eu" };

/*
 * Numbers used below, read from Microsoft's Retail Prices API
 * (prices.azure.com) on 2026-11-12, East US unless a case says West Europe:
 *   Analytics Logs Data Ingestion     $2.30 per GB, first 5 GB a month free
 *   100 GB Commitment Tier            $196 per day  ($1.96 per GB)
 *   200 GB Commitment Tier            $368 per day  ($1.84 per GB)
 *   300 GB Commitment Tier            $540 per day  ($1.80 per GB)
 *   400 GB Commitment Tier            $704 per day  ($1.76 per GB)
 *   500 GB Commitment Tier            $865 per day  ($1.73 per GB)
 *   Analytics Logs Data Retention     $0.10 per GB per month after 31 days
 *   Metric Samples Ingested           $0.11 per 10 million
 *   Metric Samples Processed          $0.05 per 10 million
 *   Prometheus Metrics Queries        $0.001 per 10 million
 * Rules from learn.microsoft.com/azure/azure-monitor/logs/cost-logs: a GB is
 * 10^9 bytes; a day above the commitment bills as a fraction of a day of the
 * same tier; tiers bill daily with a 31-day commitment. The same page says the
 * billed size is around 25 percent less than the incoming data on average, so
 * logs and traces bill at 0.75 of the GB sent, for ingestion and retention.
 * Every "billed" figure below is GB sent x 0.75. Metrics carry no factor.
 */

describe("Azure Monitor: worked examples", () => {
  it("prices the mid preset with DEFAULT_SETTINGS at $20,557.80", () => {
    // Logs: 330 GB/day sent x 0.75 = 247.5 GB/day billed.
    // Traces: 2,000 spans/s x 2,592,000 s x 1,000 bytes = 5,184 GB a month
    //   = 172.8 GB/day sent x 0.75 = 129.6 GB/day billed.
    // Together 377.1 GB/day billed (11,313 GB a month) in one workspace. Options a day:
    //   pay-as-you-go (11,313 - 5) x $2.30 / 30 = $866.95
    //   100 tier 3.771 x $196 = $739.116   200 tier 1.8855 x $368 = $693.864
    //   300 tier 1.257 x $540 = $678.78    400 tier (minimum one day) $704
    // The 300 GB/day tier costs least: $678.78 x 30 = $20,363.40.
    //   logs   247.5 / 300 x 30 = 24.75 tier-days x $540 = $13,365.00
    //   traces 129.6 / 300 x 30 = 12.96 tier-days x $540 = $6,998.40
    // Retention: 30 days asked, 31 included, no charge; 31 days are kept.
    // Metrics: 250,000 x 43,200 = 10.8 billion samples = 1,080 x 10 million.
    //   1,080 x $0.11 = $118.80, 1,080 x $0.05 = $54.00,
    //   typical reads 20x: 21,600 x $0.001 = $21.60. Metrics $194.40.
    // Total $20,557.80.
    const estimate = estimateVendor(azureMonitor, base(), DEFAULT_SETTINGS);
    expect(estimate.byBucket.logs).toBeCloseTo(13_365, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(6_998.4, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(194.4, 6);
    expect(estimate.byBucket.platform).toBeCloseTo(0, 9);
    expect(estimate.monthly).toBeCloseTo(20_557.8, 6);
    expect(estimate.complete).toBe(true);
    expect(estimate.assumptions.join(" ")).toContain("300 GB/day commitment tier");
    expect(estimate.assumptions.join(" ")).toContain("75 percent of the bytes sent");
    // 18 months of metrics is longer than the 13 asked, 31 days longer than 30.
    expect(estimate.shortRetention).toEqual([]);

    // A commitment tier runs 31 days, so the month-to-month term prices the same.
    const monthly = estimateVendor(azureMonitor, base(), MONTH_TO_MONTH);
    expect(monthly.monthly).toBeCloseTo(20_557.8, 6);
  });

  it("prices 100 GB of logs a day at 30-day retention at $5,163.50", () => {
    // 100 GB/day sent x 0.75 = 75 GB/day billed, x 30 = 2,250 GB a month.
    // Pay-as-you-go: (2,250 - 5) x $2.30 = $5,163.50. Lower.
    // 100 GB/day tier: minimum one tier-day a day, 30 x $196 = $5,880.
    // Retention: 30 days asked, inside the 31 included.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };
    for (const s of [DEFAULT_SETTINGS, MONTH_TO_MONTH]) {
      const estimate = estimateVendor(azureMonitor, onlySignals(w, ["logs"]), s);
      expect(estimate.monthly).toBeCloseTo(5_163.5, 6);
      expect(estimate.byBucket.platform).toBeCloseTo(0, 9);
      expect(estimate.shortRetention).toEqual([]);
    }
  });

  it("lands 300 GB billed a day on the 300 GB/day tier at $540 a day", () => {
    // 400 GB/day sent x 0.75 = 300 GB/day billed.
    // Microsoft's example in cost-logs: 300 GB in a day on the 200 GB/day
    // tier is 1.5 units: 1.5 x $368 = $552. The 300 tier at $540 costs less,
    // and the 100 tier is 3 x $196 = $588. 30 x $540 = $16,200.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 400, retentionDays: 30 };
    const estimate = estimateVendor(azureMonitor, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(16_200, 6);
    expect(estimate.assumptions.join(" ")).toContain("300 GB/day commitment tier");
  });

  it("bills usage above a commitment as a fraction of a day on that tier", () => {
    // 320 GB/day sent x 0.75 = 240 GB/day billed.
    // 240 GB/day on the 200 GB/day tier is 1.2 units: 1.2 x $368 = $441.60 a day,
    // x 30 = $13,248. Others: 100 tier 2.4 x $196 = $470.40 a day, 300 tier $540,
    // pay-as-you-go (7,200 - 5) x $2.30 = $16,548.50 a month.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 320, retentionDays: 30 };
    const estimate = estimateVendor(azureMonitor, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(13_248, 6);
    expect(estimate.byBucket.platform).toBeCloseTo(0, 9);
  });

  it("crosses into the 100 GB/day tier once the full commitment costs less", () => {
    // 112 GB/day sent x 0.75 = 84 GB/day billed = 2,520 GB:
    // pay-as-you-go (2,520 - 5) x $2.30 = $5,784.50, under the 100 GB/day
    // tier's 30 x $196 = $5,880.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 112, retentionDays: 30 };
    const below = estimateVendor(azureMonitor, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(below.monthly).toBeCloseTo(5_784.5, 6);

    // 120 GB/day sent x 0.75 = 90 GB/day billed = 2,700 GB:
    // pay-as-you-go (2,700 - 5) x $2.30 = $6,198.50.
    // The tier at $5,880 costs less with 10 GB/day unused.
    // Logs 90 / 100 x 30 = 27 tier-days x $196 = $5,292; unused 3 x $196 = $588.
    w.logs = { ...w.logs, gbPerDay: 120 };
    const above = estimateVendor(azureMonitor, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(above.byBucket.logs).toBeCloseTo(5_292, 6);
    expect(above.byBucket.platform).toBeCloseTo(588, 6);
    expect(above.monthly).toBeCloseTo(5_880, 6);
  });

  it("takes the 5 GB monthly allowance off pay-as-you-go", () => {
    // 7.5 GB/day x 30 = 225 GB sent x 0.75 = 168.75 GB billed,
    // less 5 GB free = 163.75 GB x $2.30 = $376.625.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 7.5, retentionDays: 30 };
    const estimate = estimateVendor(azureMonitor, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(376.625, 6);

    // 0.2 GB/day x 30 = 6 GB sent x 0.75 = 4.5 GB billed, inside the 5 GB free.
    w.logs = { ...w.logs, gbPerDay: 0.2 };
    const tiny = estimateVendor(azureMonitor, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(tiny.monthly).toBe(0);
    expect(tiny.complete).toBe(true);
  });

  it("prices metrics alone, per sample, with the query load", () => {
    // No billed-size factor on metrics.
    // 100,000 series x 43,200 minutes = 4.32 billion samples = 432 x 10 million.
    // Ingested 432 x $0.11 = $47.52, processed 432 x $0.05 = $21.60,
    // typical reads 20x: 8,640 x $0.001 = $8.64. Total $77.76.
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: 100_000, intervalSeconds: 60 };
    const metricsOnly = onlySignals(w, ["metrics"]);
    expect(estimateVendor(azureMonitor, metricsOnly, DEFAULT_SETTINGS).monthly).toBeCloseTo(77.76, 6);
    // Light reads 5x: $2.16, total $71.28. Heavy reads 100x: $43.20, total $112.32.
    expect(
      estimateVendor(azureMonitor, metricsOnly, { ...DEFAULT_SETTINGS, queryLoad: "light" }).monthly,
    ).toBeCloseTo(71.28, 6);
    expect(
      estimateVendor(azureMonitor, metricsOnly, { ...DEFAULT_SETTINGS, queryLoad: "heavy" }).monthly,
    ).toBeCloseTo(112.32, 6);
    // Same price in West Europe and on either term.
    expect(
      estimateVendor(azureMonitor, metricsOnly, { ...MONTH_TO_MONTH, region: "eu" }).monthly,
    ).toBeCloseTo(77.76, 6);
  });

  it("prices traces alone as log rows, per GB", () => {
    // 750 spans/s x 2,592,000 s x 1,000 bytes = 1,944 GB sent x 0.75 = 1,458 GB billed
    // (48.6 GB/day). (1,458 - 5) x $2.30 = $3,341.90, under the 100 GB/day tier's $5,880.
    const w = base();
    w.traces = { ...w.traces, spansPerSecond: 750, avgSpanBytes: 1_000, retentionDays: 30 };
    const estimate = estimateVendor(azureMonitor, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    expect(estimate.byBucket.traces).toBeCloseTo(3_341.9, 6);
    expect(estimate.monthly).toBeCloseTo(3_341.9, 6);
  });

  it("charges analytics retention past the 31 included days", () => {
    // 75 GB/day sent x 0.75 = 56.25 GB/day billed = 1,687.5 GB a month.
    // (1,687.5 - 5) x $2.30 = $3,869.75 (the 100 tier is $5,880).
    // Retention: (90 - 31) x 56.25 GB = 3,318.75 GB held x $0.10 = $331.875.
    // Total $4,201.625.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 75, retentionDays: 90 };
    const estimate = estimateVendor(azureMonitor, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(4_201.625, 6);
    expect(estimate.shortRetention).toEqual([]);

    w.logs = { ...w.logs, retentionDays: 31 };
    const included = estimateVendor(azureMonitor, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(included.monthly).toBeCloseTo(3_869.75, 6);
  });

  it("stops searchable retention at 730 days and reports it as kept", () => {
    // 7.5 GB/day sent = 5.625 GB/day billed: $376.625 ingestion. Retention priced
    // as 730 days: (730 - 31) x 5.625 = 3,931.875 GB held x $0.10 = $393.1875.
    // Total $769.8125.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 7.5, retentionDays: 1_000 };
    const estimate = estimateVendor(azureMonitor, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(769.8125, 6);
    expect(estimate.shortRetention).toEqual([{ signal: "logs", asked: 1_000, kept: 730, unit: "days" }]);
    expect(estimate.assumptions[0]).toContain("730");
  });

  it("includes 31 days for OTLP traces and says why it is not 90", () => {
    // 1,944 GB sent = 1,458 GB billed (48.6 GB/day): $3,341.90 ingestion.
    // Retention: (90 - 31) x 48.6 = 2,867.4 GB held x $0.10 = $286.74. Total $3,628.64.
    const w = base();
    w.traces = { ...w.traces, spansPerSecond: 750, avgSpanBytes: 1_000, retentionDays: 90 };
    const estimate = estimateVendor(azureMonitor, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(3_628.64, 6);
    expect(estimate.assumptions.join(" ")).toContain("Application Insights");
  });

  it("keeps metrics 18 months and reports a longer ask as kept shorter", () => {
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: 100_000, intervalSeconds: 60, retentionMonths: 24 };
    const estimate = estimateVendor(azureMonitor, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(77.76, 6);
    expect(estimate.shortRetention).toEqual([{ signal: "metrics", asked: 24, kept: 18, unit: "months" }]);
    expect(estimate.assumptions[0]).toContain("18 months");
  });

  it("uses West Europe prices for the eu region", () => {
    // 400 GB/day sent = 300 GB/day billed. West Europe 300 GB/day tier
    // $696.60 a day: x 30 = $20,898.
    // (200 tier 1.5 x $474.72 = $712.08, 100 tier 3 x $252.84 = $758.52.)
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 400, retentionDays: 30 };
    expect(estimateVendor(azureMonitor, onlySignals(w, ["logs"]), WEST_EUROPE).monthly).toBeCloseTo(20_898, 6);

    // Pay-as-you-go $2.99: 7.5 GB/day sent = 225 GB x 0.75 = 168.75 GB billed,
    // less 5 = 163.75 x $2.99 = $489.6125.
    // Retention $0.13: (60 - 31) x 5.625 = 163.125 GB held x $0.13 = $21.20625.
    // Total $510.81875.
    w.logs = { ...w.logs, gbPerDay: 7.5, retentionDays: 60 };
    expect(estimateVendor(azureMonitor, onlySignals(w, ["logs"]), WEST_EUROPE).monthly).toBeCloseTo(510.81875, 6);
  });

  it("puts logs alone on a separate tier when traces go elsewhere", () => {
    // 330 GB/day sent = 247.5 GB/day billed: 200 tier 1.2375 x $368 = $455.40 a day;
    // 100 tier 2.475 x $196 = $485.10; 300 tier $540. 30 x $455.40 = $13,662.
    const logsOnly = estimateVendor(azureMonitor, onlySignals(base(), ["logs"]), DEFAULT_SETTINGS);
    expect(logsOnly.monthly).toBeCloseTo(13_662, 6);
  });
});
