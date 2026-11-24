import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import { derive } from "../units";
import type { Settings, VendorEstimate, Workload } from "../types";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { dash0 } from "./dash0";

// Rates read on dash0.com/pricing on 2026-11-12, each per million:
//   log records            $0.06 ingestion + $0.54 storage, 30-day retention
//   spans and span events  $0.06 ingestion + $0.54 storage, 30-day retention
//   metric data points     $0.02 ingestion + $0.18 storage, 13-month retention
// Ingestion applies to everything sent, storage to what is kept. Storage is
// discounted past 15B units a month per signal, at rates the page does not give;
// Dash0's 15-second example bills past 15B at the list rate, and so do we.
// No base fee, minimum, free allowance, seat fee or query fee.
//
// The figures Dash0 publishes itself (its worked example, its sampling example,
// its small bill, its 15-second example) are the `examples` in dash0.ts. These
// tests cover what a total alone does not show: the split between the two fees,
// the discount point and the one retention sold.

/** The mid-size preset, with every number these examples depend on written out. */
const mid = (): Workload => {
  const w = structuredClone(presetById("mid")!.workload);
  w.logs = { ...w.logs, gbPerDay: 330, avgRecordBytes: 1000, retentionDays: 30, searchableShare: 1 };
  w.metrics = { ...w.metrics, activeSeries: 250_000, intervalSeconds: 60, retentionMonths: 13 };
  w.traces = { ...w.traces, spansPerSecond: 2000, retentionDays: 30, searchableShare: 1 };
  return w;
};

/** Logs alone. At 1,000 bytes a record, 1 GB is 1M records. */
const logsOnly = (gbPerDay: number, change: Partial<Workload["logs"]> = {}): Workload => {
  const w = mid();
  w.logs = { ...w.logs, gbPerDay, ...change };
  return onlySignals(w, ["logs"]);
};

/** Metrics alone. At 60 s a series makes 43,200 points in a 30-day month. */
const metricsOnly = (activeSeries: number, intervalSeconds = 60, retentionMonths = 13): Workload => {
  const w = mid();
  w.metrics = { ...w.metrics, activeSeries, intervalSeconds, retentionMonths };
  return onlySignals(w, ["metrics"]);
};

/** Traces alone, from a monthly span count (a 30-day month is 2,592,000 s). */
const tracesOnly = (spansPerMonth: number, change: Partial<Workload["traces"]> = {}): Workload => {
  const w = mid();
  w.traces = { ...w.traces, spansPerSecond: spansPerMonth / 2_592_000, ...change };
  return onlySignals(w, ["traces"]);
};

const amountAt = (estimate: VendorEstimate, rateId: string) =>
  estimate.lines.filter((l) => l.rateId === rateId).reduce((sum, l) => sum + l.amount, 0);

describe("Dash0: the two fees", () => {
  it("splits the sampling example: ingestion on all 3B spans, storage on the 10% kept", () => {
    // dash0.com/comparisons/datadog-pricing: "3,000M x $0.06 + 300M x $0.54 = $342".
    const estimate = estimateVendor(
      dash0,
      tracesOnly(3e9, { searchableShare: 0.1 }),
      DEFAULT_SETTINGS,
    );
    expect(amountAt(estimate, "traces-ingestion")).toBeCloseTo(180, 6);
    expect(amountAt(estimate, "traces-storage")).toBeCloseTo(162, 6);
    // What happens to the other 90% is Dash0's own mechanism, and the estimate names it.
    const said = estimate.assumptions.join(" ");
    expect(said).toContain("10% of spans are kept");
    expect(said).toContain("sampled out by SignalControl");
  });

  it("prices logs alone: 330 GB a day is $5,940", () => {
    // 330 GB/day x 30 = 9,900 GB = 9,900M records at 1,000 bytes.
    // Ingestion 9,900 x $0.06 = $594. Storage 9,900 x $0.54 = $5,346.
    const estimate = estimateVendor(dash0, onlySignals(mid(), ["logs"]), DEFAULT_SETTINGS);
    expect(amountAt(estimate, "logs-ingestion")).toBeCloseTo(594, 6);
    expect(amountAt(estimate, "logs-storage")).toBeCloseTo(5346, 6);
    expect(estimate.lines.map((l) => l.rateId)).toEqual(["logs-ingestion", "logs-storage"]);
    expect(estimate.lines.map((l) => l.label)).toEqual([
      "Log record ingestion",
      "Log record storage, 30-day retention",
    ]);
    expect(estimate.lines[1].detail).toBe("All 9.9B log records kept");
    expect(estimate.monthly).toBeCloseTo(5940, 6);
    expect(estimate.complete).toBe(true);
  });

  it("prices traces alone: 2,000 spans a second is $3,110.40", () => {
    // 2,000 x 2,592,000 s = 5,184M spans.
    // Ingestion 5,184 x $0.06 = $311.04. Storage 5,184 x $0.54 = $2,799.36.
    const estimate = estimateVendor(dash0, onlySignals(mid(), ["traces"]), DEFAULT_SETTINGS);
    expect(amountAt(estimate, "traces-ingestion")).toBeCloseTo(311.04, 6);
    expect(amountAt(estimate, "traces-storage")).toBeCloseTo(2799.36, 6);
    expect(estimate.lines.map((l) => l.rateId)).toEqual(["traces-ingestion", "traces-storage"]);
    expect(estimate.monthly).toBeCloseTo(3110.4, 6);
    expect(estimate.complete).toBe(true);
  });

  it("prices metrics alone: 250,000 series at 60 s is $2,160", () => {
    // 250,000 x 43,200 = 10,800M data points.
    // Ingestion 10,800 x $0.02 = $216. Storage 10,800 x $0.18 = $1,944.
    const estimate = estimateVendor(dash0, onlySignals(mid(), ["metrics"]), DEFAULT_SETTINGS);
    expect(amountAt(estimate, "metrics-ingestion")).toBeCloseTo(216, 6);
    expect(amountAt(estimate, "metrics-storage")).toBeCloseTo(1944, 6);
    expect(estimate.lines.map((l) => l.rateId)).toEqual(["metrics-ingestion", "metrics-storage"]);
    expect(estimate.monthly).toBeCloseTo(2160, 6);
    expect(estimate.complete).toBe(true);
  });

  it("adds the three signals with no platform fee, whatever the term or region", () => {
    // 5,940 + 3,110.40 + 2,160 = $11,210.40. One rate card: no annual or regional price.
    const elsewhere: Settings = { term: "monthly", region: "eu", queryLoad: "heavy" };
    for (const s of [DEFAULT_SETTINGS, elsewhere]) {
      const estimate = estimateVendor(dash0, mid(), s);
      expect(estimate.byBucket.platform).toBe(0);
      expect(estimate.monthly).toBeCloseTo(11210.4, 6);
      expect(estimate.complete).toBe(true);
    }
  });

  it("counts log records, not bytes: the same GB in smaller records costs more", () => {
    // 100 GB/day x 30 = 3,000 GB. At 500 bytes a record that is 6,000M records.
    // 6,000 x ($0.06 + $0.54) = $3,600, against $1,800 at 1,000 bytes.
    const estimate = estimateVendor(dash0, logsOnly(100, { avgRecordBytes: 500 }), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(3600, 6);
  });

  it("doubles the metrics bill when the export interval halves", () => {
    // 125,000 series at 30 s: 125,000 x 86,400 = 10,800M x ($0.02 + $0.18) = $2,160,
    // twice the $1,080 the same series cost at 60 s.
    const estimate = estimateVendor(dash0, metricsOnly(125_000, 30), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(2160, 6);
  });
});

describe("Dash0: storage past 15B units a month", () => {
  it("bills Dash0's 15-second example at the list rate and calls it an upper bound", () => {
    // 125,000 series x 172,800 points = 21,600M, past 15B.
    //   ingestion 21,600 x $0.02 = $432; storage 21,600 x $0.18 = $3,888
    const estimate = estimateVendor(dash0, metricsOnly(125_000, 15), DEFAULT_SETTINGS);
    expect(amountAt(estimate, "metrics-ingestion")).toBeCloseTo(432, 6);
    expect(amountAt(estimate, "metrics-storage")).toBeCloseTo(3888, 6);
    expect(estimate.assumptions.join(" ")).toContain("upper bound");
  });

  it("prices 30B log records at the list rate and calls it an upper bound", () => {
    // 1,000 GB/day x 30 = 30,000M records, all kept.
    // 30,000 x $0.06 = $1,800 ingestion, 30,000 x $0.54 = $16,200 storage.
    const estimate = estimateVendor(dash0, logsOnly(1000), DEFAULT_SETTINGS);
    expect(amountAt(estimate, "logs-ingestion")).toBeCloseTo(1800, 6);
    expect(amountAt(estimate, "logs-storage")).toBeCloseTo(16200, 6);
    expect(estimate.monthly).toBeCloseTo(18000, 6);
    expect(estimate.complete).toBe(true);
    expect(estimate.assumptions.join(" ")).toContain("15B log records");
  });

  it("does not flag the 15B point when only the sent volume passes it", () => {
    // 2,000 GB/day x 30 = 60,000M records sent, 20% kept = 12,000M stored.
    // Ingestion 60,000 x $0.06 = $3,600. Storage 12,000 x $0.54 = $6,480.
    const estimate = estimateVendor(
      dash0,
      logsOnly(2000, { searchableShare: 0.2 }),
      DEFAULT_SETTINGS,
    );
    expect(amountAt(estimate, "logs-ingestion")).toBeCloseTo(3600, 6);
    expect(amountAt(estimate, "logs-storage")).toBeCloseTo(6480, 6);
    expect(estimate.monthly).toBeCloseTo(10080, 6);
    const said = estimate.assumptions.join(" ");
    expect(said).toContain("20% of log records are kept");
    expect(said).toContain("filtered out by SignalControl");
    expect(said).not.toContain("upper bound");
  });
});

describe("Dash0: retention", () => {
  it("prices the one retention Dash0 sells and reports it as kept", () => {
    // 30 days for logs and spans, 13 months for metrics, whatever is asked:
    // 3,000M records x $0.60 = $1,800.
    const asked = estimateVendor(dash0, logsOnly(100), DEFAULT_SETTINGS);
    expect(asked.monthly).toBeCloseTo(1800, 6);
    expect(asked.shortRetention).toEqual([]);
    expect(asked.assumptions.join(" ")).not.toContain("of retention");

    const longer = estimateVendor(dash0, logsOnly(100, { retentionDays: 90 }), DEFAULT_SETTINGS);
    expect(longer.monthly).toBeCloseTo(1800, 6);
    expect(longer.shortRetention).toEqual([{ signal: "logs", asked: 90, kept: 30, unit: "days" }]);

    // A shorter ask is priced at the 30 days sold, and kept says so.
    const shorter = tracesOnly(3e9, { retentionDays: 7 });
    expect(estimateVendor(dash0, shorter, DEFAULT_SETTINGS).monthly).toBeCloseTo(1800, 6);
    expect(estimateVendor(dash0, shorter, DEFAULT_SETTINGS).shortRetention).toEqual([]);
    expect(dash0.price({ w: shorter, d: derive(shorter), s: DEFAULT_SETTINGS }).kept).toEqual({
      tracesDays: 30,
    });

    // 125,000 series at 60 s is $1,080 at 13 months, the only metric retention listed.
    const metrics = estimateVendor(dash0, metricsOnly(125_000, 60, 24), DEFAULT_SETTINGS);
    expect(metrics.monthly).toBeCloseTo(1080, 6);
    expect(metrics.shortRetention).toEqual([{ signal: "metrics", asked: 24, kept: 13, unit: "months" }]);
  });
});

describe("Dash0: profiling samples", () => {
  it("bills profiling samples per million, ingestion plus storage", () => {
    // 100 profiled hosts × 40 samples/s × 2,592,000 s = 10,368M samples.
    //   ingestion  10,368 × $0.06 = $622.08
    //   storage    10,368 × $0.54 = $5,598.72
    const w = mid();
    w.send.profiles = true;
    w.infra = { ...w.infra, hosts: 200 };
    w.profiles = { profiledHostShare: 0.5, samplesPerSecondPerHost: 40, bytesPerSample: 100 };
    const estimate = estimateVendor(dash0, onlySignals(w, ["profiles"]), DEFAULT_SETTINGS);
    expect(estimate.byBucket.profiles).toBeCloseTo(6_220.8, 6);
    expect(estimate.monthly).toBeCloseTo(6_220.8, 6);
    expect(estimate.lines.map((l) => l.label)).toEqual([
      "Profiling sample ingestion",
      "Profiling sample storage, 30-day retention",
    ]);
    // The sample rate the bill rests on is said, and so is the retention.
    expect(estimate.assumptions.join(" ")).toContain("40 a second per profiled host");
    expect(estimate.included).toContain("30 days of retention for profiling samples");
    // Halving the sample rate halves the bill.
    w.profiles.samplesPerSecondPerHost = 20;
    expect(estimateVendor(dash0, onlySignals(w, ["profiles"]), DEFAULT_SETTINGS).monthly).toBeCloseTo(3_110.4, 6);
  });
});
