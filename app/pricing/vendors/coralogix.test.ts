import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import type { Settings, Workload } from "../types";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { coralogix } from "./coralogix";

/** Mid preset: 330 GB/day of logs, 2,000 spans/s at 1,000 bytes, 250,000 series, all searchable. */
const base = (): Workload => structuredClone(presetById("mid")!.workload);

/**
 * Figures read on coralogix.com on 2026-11-12:
 *   - 1 unit = $1.50 (pricing page FAQ, usage pricing docs)
 *   - units per GB sent (usage pricing docs):
 *       logs    High 0.75, Medium 0.32
 *       traces  High 0.5,  Medium 0.25
 *   - metrics $0.06 per GB, "1GB = 750 active time series" (pricing page),
 *     read as 750 series = 1 GB a day
 * Coralogix has no tiers, free allowance or minimum, so there is no tier edge
 * to cross. The nearest thing is the split between pipelines, tested below.
 */
describe("Coralogix: worked examples", () => {
  it("is within rounding of the pricing page FAQ: 1.3 GB in Frequent Search is one unit", () => {
    // coralogix.com/pricing FAQ: "1.3GB of logs in frequent search ($1.15/GB)
    // is equivalent to 1 unit." The docs table says 0.75 units per GB, so one
    // unit is 1.333 GB and the FAQ rounds it to 1.3.
    // 1.3 GB/day x 30 days = 39 GB x 0.75 = 29.25 units x $1.50 = $43.875.
    // The FAQ's "1 unit" a day would be 30 units x $1.50 = $45.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 1.3, searchableShare: 1 };
    const estimate = estimateVendor(coralogix, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(43.875, 6);
    expect(Math.abs(estimate.monthly - 45) / 45).toBeLessThan(0.03);
  });

  it("is within rounding of the pricing page FAQ: 3 GB in Monitoring is one unit", () => {
    // Same FAQ: "3GB of logs in the monitoring pipeline ($0.50/GB) is also
    // equivalent to 1 unit." The docs table says 0.32 units per GB, so one
    // unit is 3.125 GB and the FAQ rounds it to 3.
    // 3 GB/day x 30 days = 90 GB x 0.32 = 28.8 units x $1.50 = $43.20.
    // The FAQ's "1 unit" a day would be $45.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 3, searchableShare: 0 };
    const estimate = estimateVendor(coralogix, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(43.2, 6);
    expect(Math.abs(estimate.monthly - 45) / 45).toBeLessThan(0.05);
    expect(estimate.lines.map((l) => l.rateId)).toEqual(["logs-medium"]);
  });

  it("prices logs alone in Frequent Search when all of them are searchable", () => {
    // 330 GB/day x 30 days = 9,900 GB x 0.75 = 7,425 units x $1.50 = $11,137.50
    const estimate = estimateVendor(coralogix, onlySignals(base(), ["logs"]), DEFAULT_SETTINGS);
    expect(estimate.lines).toHaveLength(1);
    expect(estimate.lines[0].rateId).toBe("logs-high");
    expect(estimate.lines[0].quantity).toBeCloseTo(7425, 6);
    expect(estimate.byBucket.logs).toBeCloseTo(11137.5, 6);
    expect(estimate.monthly).toBeCloseTo(11137.5, 6);
    expect(estimate.complete).toBe(true);
  });

  it("prices traces alone in Frequent Search when all of them are searchable", () => {
    // 2,000 spans/s x 2,592,000 s = 5.184B spans x 1,000 bytes = 5,184 GB
    // 5,184 GB x 0.5 = 2,592 units x $1.50 = $3,888
    const estimate = estimateVendor(coralogix, onlySignals(base(), ["traces"]), DEFAULT_SETTINGS);
    expect(estimate.lines).toHaveLength(1);
    expect(estimate.lines[0].rateId).toBe("traces-high");
    expect(estimate.lines[0].quantity).toBeCloseTo(2592, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(3888, 6);
    expect(estimate.monthly).toBeCloseTo(3888, 6);
  });

  it("prices metrics alone by active series: 750 series are 1 GB a day", () => {
    // Pricing page: $0.06 per GB, 1 GB = 750 active time series.
    // 250,000 series / 750 = 333.33 GB a day x 30 days = 10,000 GB x $0.06 = $600
    const estimate = estimateVendor(coralogix, onlySignals(base(), ["metrics"]), DEFAULT_SETTINGS);
    expect(estimate.lines).toHaveLength(1);
    expect(estimate.lines[0].quantity).toBeCloseTo(10_000, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(600, 6);
    expect(estimate.monthly).toBeCloseTo(600, 6);

    // 750 series = 1 GB a day x 30 days = 30 GB x $0.06 = $1.80
    const small = base();
    small.metrics = { ...small.metrics, activeSeries: 750 };
    expect(
      estimateVendor(coralogix, onlySignals(small, ["metrics"]), DEFAULT_SETTINGS).monthly,
    ).toBeCloseTo(1.8, 6);
  });

  it("does not charge more for a shorter export interval", () => {
    // Pricing page FAQ: "A series sent every 15 seconds and a series sent
    // every 60 seconds are both one series."
    // 1,000,000 series / 750 = 1,333.33 GB a day x $0.06 = $80 a day
    // $80 x 30 days = $2,400 (40,000 GB x $0.06)
    for (const intervalSeconds of [15, 60]) {
      const w = base();
      w.metrics = { ...w.metrics, activeSeries: 1_000_000, intervalSeconds };
      const estimate = estimateVendor(coralogix, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
      expect(estimate.monthly).toBeCloseTo(2400, 6);
    }
  });

  it("says where the pricing page rule and the vendor's metrics post differ", () => {
    // coralogix.com/blog/introducing-the-new-coralogix-metrics-engine prices
    // 1,000,000 daily active series at "$45 / 30 units" a day after an assumed
    // 25% routing saving ($60 before it). The pricing page rule gives $80 a
    // day for the same series (see the test above). The adapter follows the
    // pricing page and prints both figures, so the gap is visible.
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: 1_000_000 };
    const estimate = estimateVendor(coralogix, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(estimate.monthly / 30).toBeCloseTo(80, 6);
    const notes = estimate.notes.join(" ");
    expect(notes).toContain("1,000,000 active series at 30 units a day ($45.00)");
    expect(notes).toContain("$80.00 a day");
  });

  it("splits logs between Frequent Search and Monitoring by the searchable share", () => {
    // 100 GB/day x 30 days = 3,000 GB, 40% searchable
    // Frequent Search: 1,200 GB x 0.75 = 900 units x $1.50 = $1,350
    // Monitoring:      1,800 GB x 0.32 = 576 units x $1.50 = $864
    // Total: 1,476 units, $2,214
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, searchableShare: 0.4 };
    const estimate = estimateVendor(coralogix, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    const high = estimate.lines.find((l) => l.rateId === "logs-high");
    const medium = estimate.lines.find((l) => l.rateId === "logs-medium");
    expect(high?.quantity).toBeCloseTo(900, 6);
    expect(high?.amount).toBeCloseTo(1350, 6);
    expect(medium?.quantity).toBeCloseTo(576, 6);
    expect(medium?.amount).toBeCloseTo(864, 6);
    expect(estimate.monthly).toBeCloseTo(2214, 6);
    expect(estimate.assumptions.join(" ")).toContain("Medium priority (Monitoring)");
  });

  it("splits traces between Frequent Search and Monitoring by the searchable share", () => {
    // 1,000 spans/s x 2,592,000 s x 1,000 bytes = 2,592 GB, 25% searchable
    // Frequent Search:   648 GB x 0.5  = 324 units x $1.50 = $486
    // Monitoring:      1,944 GB x 0.25 = 486 units x $1.50 = $729
    // Total: $1,215
    const w = base();
    w.traces = { ...w.traces, spansPerSecond: 1000, avgSpanBytes: 1000, searchableShare: 0.25 };
    const estimate = estimateVendor(coralogix, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    const high = estimate.lines.find((l) => l.rateId === "traces-high");
    const medium = estimate.lines.find((l) => l.rateId === "traces-medium");
    expect(high?.quantity).toBeCloseTo(324, 6);
    expect(medium?.quantity).toBeCloseTo(486, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(1215, 6);
    expect(estimate.monthly).toBeCloseTo(1215, 6);
  });

  it("adds the three signals up with no platform fee, seats or host fees", () => {
    // Logs $11,137.50 + traces $3,888 + metrics $600 = $15,625.50
    const estimate = estimateVendor(coralogix, base(), DEFAULT_SETTINGS);
    expect(estimate.byBucket.platform).toBe(0);
    expect(estimate.monthly).toBeCloseTo(15625.5, 6);
    expect(estimate.complete).toBe(true);

    // 200 hosts and 15 users in the preset. More of either changes nothing.
    const bigger = base();
    bigger.infra = { ...bigger.infra, hosts: 2000 };
    bigger.users = 500;
    expect(estimateVendor(coralogix, bigger, DEFAULT_SETTINGS).monthly).toBeCloseTo(15625.5, 6);
  });

  it("gives the same price for both terms, either region and any query load", () => {
    // One published unit price, no regional prices, no query charge: $15,625.50
    const settings: Settings[] = [
      { term: "monthly", region: "us", queryLoad: "typical" },
      { term: "annual", region: "eu", queryLoad: "heavy" },
      { term: "monthly", region: "eu", queryLoad: "light" },
    ];
    for (const s of settings) {
      expect(estimateVendor(coralogix, base(), s).monthly).toBeCloseTo(15625.5, 6);
    }
  });

  it("explains the gap to the pricing page headline and the pay-as-you-go overage rate", () => {
    // Pricing page headline: logs $0.42 per GB, traces $0.16 per GB. Neither
    // is a pipeline rate: Medium is 0.32 x $1.50 = $0.48 for logs and
    // 0.25 x $1.50 = $0.375 for traces.
    // Pay-as-you-go docs: 25% above the plan rate, so $1.50 x 1.25 = $1.875.
    const notes = estimateVendor(coralogix, base(), DEFAULT_SETTINGS).notes.join(" ");
    expect(notes).toContain("$0.42 per GB for logs and $0.16 per GB for traces");
    expect(notes).toContain("($0.48 and $0.375 per GB)");
    expect(notes).toContain("25% above the plan rate, which is $1.875 a unit");
  });

  it("does not change the price with retention, and says where long retention is met", () => {
    // Unit rates do not depend on retention: still 7,425 units, $11,137.50
    const w = base();
    w.logs = { ...w.logs, retentionDays: 365 };
    const estimate = estimateVendor(coralogix, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(11137.5, 6);
    expect(estimate.assumptions.join(" ")).toContain("365 days for logs");
    expect(estimate.assumptions.join(" ")).toContain("archive in your bucket");
  });
});

describe("Coralogix: hand-computed bills (pages read 2026-11-12)", () => {
  it("mid preset with default settings is $15,625.50 a month", () => {
    // Logs:    330 GB/day × 30 = 9,900 GB, all searchable, Frequent Search
    //          9,900 × 0.75 units = 7,425 units × $1.50 = $11,137.50
    // Traces:  2,000 spans/s × 2,592,000 s × 1,000 bytes = 5,184 GB, Frequent Search
    //          5,184 × 0.5 units = 2,592 units × $1.50 = $3,888
    // Metrics: 250,000 series / 750 per GB = 333.33 GB a day × 30 = 10,000 GB
    //          10,000 GB × $0.06 = $600 (interval and host/custom split do not matter)
    // No seats, host fees, query charges or minimum.
    // Total: 11,137.50 + 3,888 + 600 = $15,625.50
    const estimate = estimateVendor(coralogix, base(), DEFAULT_SETTINGS);
    expect(estimate.byBucket.logs).toBeCloseTo(11137.5, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(3888, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(600, 6);
    expect(estimate.byBucket.platform).toBe(0);
    expect(estimate.monthly).toBeCloseTo(15625.5, 6);
    expect(estimate.complete).toBe(true);
    expect(estimate.shortRetention).toEqual([]);
  });

  it("100 GB of logs a day alone at 30-day retention is $3,375 a month", () => {
    // 100 GB/day × 30 = 3,000 GB, all searchable, Frequent Search
    // 3,000 × 0.75 units = 2,250 units × $1.50 = $3,375
    // Retention is met from the archive in the customer's bucket, at no unit charge.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };
    const estimate = estimateVendor(coralogix, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(estimate.lines).toHaveLength(1);
    expect(estimate.lines[0].quantity).toBeCloseTo(2250, 6);
    expect(estimate.monthly).toBeCloseTo(3375, 6);
    expect(estimate.lines[0].detail).toContain("100 GB/day × 30 days");
  });
});

describe("Coralogix: text", () => {
  it("uses no em dashes or semicolons in anything a buyer reads", () => {
    const split = base();
    split.logs = { ...split.logs, searchableShare: 0.3 };
    split.traces = { ...split.traces, searchableShare: 0.1 };
    const text: string[] = [
      coralogix.plan(DEFAULT_SETTINGS),
      ...coralogix.sources.map((s) => s.label),
      ...coralogix.rates.flatMap((r) => [r.label, r.unit, r.note ?? ""]),
    ];
    for (const w of [base(), split, onlySignals(base(), ["metrics"])]) {
      const estimate = estimateVendor(coralogix, w, DEFAULT_SETTINGS);
      text.push(
        ...estimate.assumptions,
        ...estimate.included,
        ...estimate.notIncluded,
        ...estimate.notes,
        ...estimate.lines.flatMap((l) => [l.label, l.unit, l.detail ?? ""]),
      );
    }
    for (const t of text) expect(t).not.toMatch(/[—–;]/);
  });
});
