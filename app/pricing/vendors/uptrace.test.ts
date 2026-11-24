import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import type { Workload } from "../types";
import { derive } from "../units";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { uptrace } from "./uptrace";

const base = (): Workload => structuredClone(presetById("mid")!.workload);

// Rates used below, all read on uptrace.dev/pricing on 2026-11-12:
//   $0.10 per GB of spans and logs (starting rate), $0.025 per 1M data points
//   (starting rate), cold storage $0.01 per GB-month and $0.20 per 1,000
//   timeseries-months past 28 days, free 50 GB and 5,000 timeseries a month.

describe("Uptrace Cloud: worked examples", () => {
  it("prices the mid preset with default settings: $2,381.39", () => {
    // Logs: 330 GB/day x 30 = 9,900 GB, less 50 GB free = 9,850 GB x $0.10 = 985.00
    //   kept 30 days: 330 GB/day x 2 days = 660 GB-months x $0.01 = 6.60
    //   logs total 991.60
    // Traces: 2,000 spans/s x 2,592,000 s x 1,000 bytes = 5,184 GB (free GB already used) x $0.10 = 518.40
    //   kept 30 days: 172.8 GB/day x 2 days = 345.6 GB-months x $0.01 = 3.456
    //   traces total 521.856
    // Metrics: 250,000 series x 43,200 = 10,800M points, less 5,000 x 43,200 = 216M free
    //   = 10,584M x $0.025 = 264.60
    //   kept 13 months = 390 days, 362 days past 28 = 12.0667 months:
    //   250,000 x 12.0667 / 1,000 = 3,016.667 x $0.20 = 603.333
    //   metrics total 867.933
    // Total: 991.60 + 521.856 + 867.933 = 2,381.389
    const estimate = estimateVendor(uptrace, base(), DEFAULT_SETTINGS);
    expect(estimate.byBucket.logs).toBeCloseTo(991.6, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(521.856, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(867.9333, 3);
    expect(estimate.byBucket.platform).toBe(0);
    expect(estimate.monthly).toBeCloseTo(2381.3893, 3);
    expect(estimate.complete).toBe(true);
    expect(estimate.shortRetention).toEqual([]);
  });

  it("prices 100 GB of logs a day at 30-day retention: $297.00", () => {
    // 100 GB/day x 30 = 3,000 GB, less 50 GB free = 2,950 GB x $0.10 = 295.00
    // Kept past 28 days: 100 GB/day x 2 days = 200 GB-months x $0.01 = 2.00
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };
    const estimate = estimateVendor(uptrace, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(297, 6);
    expect(estimate.lines.map((l) => l.rateId)).toEqual(["ingest-gb", "cold-gb"]);
  });

  it("matches the FAQ's cold storage example: 1,000 GB kept beyond 4 weeks costs $10/month", () => {
    // 50 GB/day of spans kept 48 days: 50 x 20 days = 1,000 GB held x $0.01 = 10.00
    // Ingestion: 1,500 GB, less 50 GB free = 1,450 x $0.10 = 145.00
    const w = base();
    w.traces = {
      ...w.traces,
      spansPerSecond: 50e9 / 1000 / 86_400,
      avgSpanBytes: 1000,
      retentionDays: 48,
    };
    const estimate = estimateVendor(uptrace, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    const cold = estimate.lines.find((l) => l.rateId === "cold-gb");
    expect(cold?.amount).toBeCloseTo(10, 6);
    expect(estimate.monthly).toBeCloseTo(155, 6);
  });

  it("charges nothing inside the free allowance", () => {
    // 1 GB/day of logs = 30 GB, under 50 GB. 5,000 series, all free. 28 days kept.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 1, retentionDays: 28 };
    w.metrics = { ...w.metrics, activeSeries: 5_000, retentionMonths: 28 / 30 };
    const estimate = estimateVendor(uptrace, onlySignals(w, ["logs", "metrics"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBe(0);
  });

  it("gives traces the free allowance when logs are not sent", () => {
    // Mid traces alone: 5,184 GB, less 50 free = 5,134 x $0.10 = 513.40, plus 3.456 cold
    const estimate = estimateVendor(uptrace, onlySignals(base(), ["traces"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(516.856, 6);
  });

  it("caps retention at 100 weeks and reports it as kept", () => {
    // 10,000 series at 60 s = 432M points, less 216M free = 216M x $0.025 = 5.40
    // 36 months asked, 700 days kept: 672 days past 28 = 22.4 months
    // 10,000 x 22.4 / 1,000 = 224 x $0.20 = 44.80
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: 10_000, intervalSeconds: 60, retentionMonths: 36 };
    const only = onlySignals(w, ["metrics"]);
    const estimate = estimateVendor(uptrace, only, DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(50.2, 6);
    expect(estimate.assumptions[0]).toContain("100 weeks");
    const out = uptrace.price({ w: only, d: derive(only), s: DEFAULT_SETTINGS });
    expect(out.kept?.metricsMonths).toBeCloseTo(700 / 30, 6);
  });

  it("prices a short ask as the 28 days included, and reports the longer retention", () => {
    // 7 days asked: 28 days are included, so no cold storage is billed.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 7 };
    const only = onlySignals(w, ["logs"]);
    const estimate = estimateVendor(uptrace, only, DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(295, 6);
    const out = uptrace.price({ w: only, d: derive(only), s: DEFAULT_SETTINGS });
    expect(out.kept?.logsDays).toBe(28);
  });

  it("gives the same price for both terms and both regions", () => {
    const annualUs = estimateVendor(uptrace, base(), DEFAULT_SETTINGS);
    const monthlyEu = estimateVendor(uptrace, base(), {
      term: "monthly",
      region: "eu",
      queryLoad: "heavy",
    });
    expect(monthlyEu.monthly).toBe(annualUs.monthly);
  });
});
