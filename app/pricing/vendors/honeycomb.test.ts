import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import type { Settings, Workload } from "../types";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { honeycomb } from "./honeycomb";

// Mid preset: 330 GB of logs a day at 1,000 bytes a record, 2,000 spans/s,
// 250,000 series at 60 s. Each example overrides the parts it prices.
const base = (): Workload => structuredClone(presetById("mid")!.workload);

// Published on Honeycomb's pages, read 2026-11-12:
//   honeycomb.io/pricing: "Pro: Starting at $150 / 50M events (up to 750M)
//     and 250M time series data points (up to 3.75B)"
//   docs, 2026 Pro Plan Changes: "The new per-event rate is $3.00 per million
//     events", four tiers "topping out at 750M events per month"
// 250M / 50M and 3.75B / 750M are both 5 data points per event.
// The sizes of the two middle tiers are not published, so a plan size between
// 50M and 750M events is priced at the rate and flagged as missing the step
// up to its tier. The largest tier at the rate is 750 M x $3.00 = $2,250.

describe("Honeycomb: worked examples", () => {
  it("matches the pricing page: 50M events with metrics inside 250M data points is $150", () => {
    const w = base();
    // 1 GB/day x 30 days = 30 GB = 30e9 bytes / 600 bytes = 50,000,000 records.
    w.logs = { ...w.logs, gbPerDay: 1, avgRecordBytes: 600 };
    // 5,000 series x 1 point a minute x 43,200 minutes = 216,000,000 data points,
    // inside the 250M that come with the 50M-event tier.
    w.metrics = { ...w.metrics, activeSeries: 5_000, intervalSeconds: 60 };
    const estimate = estimateVendor(
      honeycomb,
      onlySignals(w, ["logs", "metrics"]),
      DEFAULT_SETTINGS,
    );
    // 50 M events x $3.00 = $150, the published price of the smallest tier.
    expect(estimate.monthly).toBeCloseTo(150, 6);
    expect(estimate.byBucket.logs).toBeCloseTo(150, 6);
    expect(estimate.byBucket.metrics).toBe(0);
    expect(estimate.byBucket.platform).toBe(0);
    expect(estimate.lines).toHaveLength(1);
    expect(estimate.unpriced).toEqual([]);
    expect(estimate.complete).toBe(true);
    expect(estimate.included.join(" ")).toContain("216M sent are inside the 250M");
  });

  it("bills the smallest tier when events are below 50M", () => {
    const w = base();
    // 1 GB/day x 30 days = 30 GB / 1,000 bytes = 30,000,000 records.
    w.logs = { ...w.logs, gbPerDay: 1, avgRecordBytes: 1000 };
    const estimate = estimateVendor(honeycomb, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // 30 M x $3.00 = $90 of usage, topped up by $60 to the $150 tier.
    expect(estimate.byBucket.logs).toBeCloseTo(90, 6);
    expect(estimate.byBucket.platform).toBeCloseTo(60, 6);
    expect(estimate.monthly).toBeCloseTo(150, 6);
    expect(estimate.lines.find((l) => l.kind === "top-up")?.rateId).toBe("pro-minimum");
    expect(estimate.complete).toBe(true);

    // Just past the tier edge: 1 GB/day x 30 = 30e9 bytes / 500 bytes = 60,000,000 records.
    w.logs = { ...w.logs, avgRecordBytes: 500 };
    const past = estimateVendor(honeycomb, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // 60 M x $3.00 = $180 at the rate. The tier that covers 60M is not published.
    expect(past.monthly).toBeCloseTo(180, 6);
    expect(past.byBucket.platform).toBe(0);
    expect(past.complete).toBe(false);
    expect(past.unpriced.map((u) => u.bucket)).toEqual(["platform"]);
    expect(past.unpriced[0].reason).toContain(
      "The invoice is between the $180.00 priced here and $2,250.00 a month",
    );
  });

  it("prices Pro even when the workload would fit the Free plan, and says so", () => {
    const w = base();
    // 0.5 GB/day x 30 days = 15 GB / 1,000 bytes = 15,000,000 records, under
    // the 20M events of the Free plan on honeycomb.io/pricing.
    w.logs = { ...w.logs, gbPerDay: 0.5, avgRecordBytes: 1000 };
    const estimate = estimateVendor(honeycomb, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // 15 M x $3.00 = $45 of usage, topped up by $105 to the $150 tier.
    expect(estimate.byBucket.logs).toBeCloseTo(45, 6);
    expect(estimate.byBucket.platform).toBeCloseTo(105, 6);
    expect(estimate.monthly).toBeCloseTo(150, 6);
    expect(estimate.assumptions.join(" ")).toContain("also fits Honeycomb's Free plan");
  });

  it("prices logs alone at the per-event rate and flags the unpublished tier", () => {
    const w = base();
    // 5 GB/day x 30 days = 150 GB = 150e9 bytes / 1,000 bytes = 150,000,000 records.
    w.logs = { ...w.logs, gbPerDay: 5, avgRecordBytes: 1000 };
    const estimate = estimateVendor(honeycomb, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // 150 M events x $3.00 = $450
    expect(estimate.byBucket.logs).toBeCloseTo(450, 6);
    expect(estimate.monthly).toBeCloseTo(450, 6);
    // 150M is past the smallest tier and short of the largest. The tier that
    // covers it is not published, so the step up is unpriced: the invoice is
    // between $450 and the largest tier's 750 M x $3.00 = $2,250.
    expect(estimate.complete).toBe(false);
    expect(estimate.unpriced.map((u) => u.bucket)).toEqual(["platform"]);
    expect(estimate.unpriced[0].reason).toContain("needs a plan of 150M events");
    expect(estimate.unpriced[0].reason).toContain(
      "between the $450.00 priced here and $2,250.00 a month",
    );
  });

  it("prices traces alone: one span is one event", () => {
    const w = base();
    // 100 spans/s x 2,592,000 s = 259,200,000 spans.
    w.traces = { ...w.traces, spansPerSecond: 100 };
    const estimate = estimateVendor(honeycomb, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    // 259.2 M events x $3.00 = $777.60
    expect(estimate.byBucket.traces).toBeCloseTo(777.6, 6);
    expect(estimate.monthly).toBeCloseTo(777.6, 6);
    expect(estimate.unpriced.map((u) => u.bucket)).toEqual(["platform"]);
    expect(estimate.unpriced[0].reason).toContain("between the $777.60 priced here");
    expect(estimate.notIncluded.join(" ")).toContain("Span events and span links");
  });

  it("prices metrics alone inside the smallest tier at its $150", () => {
    const w = base();
    // 5,000 series x 43,200 points a month = 216,000,000 data points, under 250M.
    w.metrics = { ...w.metrics, activeSeries: 5_000, intervalSeconds: 60 };
    const estimate = estimateVendor(honeycomb, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    // No events, so the whole $150 is the plan minimum.
    expect(estimate.byBucket.metrics).toBe(0);
    expect(estimate.byBucket.platform).toBeCloseTo(150, 6);
    expect(estimate.monthly).toBeCloseTo(150, 6);
    expect(estimate.complete).toBe(true);
  });

  it("prices metrics alone past the smallest tier by the plan size they need", () => {
    const w = base();
    // 20,000 series x 43,200 points a month = 864,000,000 data points.
    // At 5 data points per event that needs a plan of 172.8M events.
    w.metrics = { ...w.metrics, activeSeries: 20_000, intervalSeconds: 60 };
    const estimate = estimateVendor(honeycomb, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    // Smallest tier (50M events): $150. The other 122.8 M x $3.00 = $368.40.
    expect(estimate.byBucket.platform).toBeCloseTo(150, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(368.4, 6);
    // 172.8 M x $3.00 = $518.40
    expect(estimate.monthly).toBeCloseTo(518.4, 6);
    // 172.8M events of plan size is between the published tiers, and it rests
    // on the middle tiers carrying the same 5 data points per event.
    expect(estimate.unpriced.map((u) => u.bucket)).toEqual(["platform"]);
    expect(estimate.unpriced[0].reason).toContain(
      "If the middle tiers also include 5 data points per event, the invoice is between the $518.40 priced here",
    );
  });

  it("counts data points, not series: 30 s doubles the count of 60 s", () => {
    const w = base();
    // 10,000 series x 2 points a minute x 43,200 minutes = 864,000,000 data points,
    // the same count as 20,000 series at 60 s above.
    w.metrics = { ...w.metrics, activeSeries: 10_000, intervalSeconds: 30 };
    const estimate = estimateVendor(honeycomb, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(518.4, 6);
  });

  it("includes metrics at no charge while they fit the allotment of the plan the events buy", () => {
    const w = base();
    // Logs: 2 GB/day x 30 = 60 GB / 1,000 bytes = 60,000,000 records.
    w.logs = { ...w.logs, gbPerDay: 2, avgRecordBytes: 1000 };
    // Traces: 20 spans/s x 2,592,000 s = 51,840,000 spans.
    w.traces = { ...w.traces, spansPerSecond: 20 };
    // Metrics: 10,000 series x 43,200 = 432,000,000 data points.
    // Events: 111.84M, so the plan carries 111.84M x 5 = 559.2M data points.
    w.metrics = { ...w.metrics, activeSeries: 10_000, intervalSeconds: 60 };
    const estimate = estimateVendor(honeycomb, w, DEFAULT_SETTINGS);
    // 60 M x $3.00 = $180
    expect(estimate.byBucket.logs).toBeCloseTo(180, 6);
    // 51.84 M x $3.00 = $155.52
    expect(estimate.byBucket.traces).toBeCloseTo(155.52, 6);
    expect(estimate.byBucket.metrics).toBe(0);
    expect(estimate.byBucket.platform).toBe(0);
    // $180 + $155.52 = $335.52
    expect(estimate.monthly).toBeCloseTo(335.52, 6);
    expect(estimate.included.join(" ")).toContain("432M sent are inside the 559M");
  });

  it("charges metrics only for the plan size they add on top of the events", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 2, avgRecordBytes: 1000 }; // 60M records
    w.traces = { ...w.traces, spansPerSecond: 20 }; // 51.84M spans
    // 20,000 series x 43,200 = 864,000,000 data points, which need a plan of
    // 864M / 5 = 172.8M events. The events account for 111.84M of it.
    w.metrics = { ...w.metrics, activeSeries: 20_000, intervalSeconds: 60 };
    const estimate = estimateVendor(honeycomb, w, DEFAULT_SETTINGS);
    expect(estimate.byBucket.logs).toBeCloseTo(180, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(155.52, 6);
    // (172.8 - 111.84) = 60.96 M x $3.00 = $182.88
    expect(estimate.byBucket.metrics).toBeCloseTo(182.88, 6);
    // 172.8 M x $3.00 = $518.40
    expect(estimate.monthly).toBeCloseTo(518.4, 6);
  });

  it("prices the largest Pro tier in full and returns no price past it", () => {
    const w = base();
    // 25 GB/day x 30 = 750 GB / 1,000 bytes = 750,000,000 records: the largest tier.
    w.logs = { ...w.logs, gbPerDay: 25, avgRecordBytes: 1000 };
    const top = estimateVendor(honeycomb, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // 750 M x $3.00 = $2,250. A published tier size, so nothing is left unpriced.
    expect(top.monthly).toBeCloseTo(2250, 6);
    expect(top.unpriced).toEqual([]);
    expect(top.complete).toBe(true);

    // 26 GB/day x 30 = 780 GB = 780,000,000 records, past 750M.
    w.logs = { ...w.logs, gbPerDay: 26 };
    const over = estimateVendor(honeycomb, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(over.lines).toEqual([]);
    expect(over.monthly).toBe(0);
    expect(over.complete).toBe(false);
    expect(over.unpriced.map((u) => u.bucket)).toEqual(["logs"]);
    expect(over.unpriced[0].reason).toContain("780M events a month");
    expect(over.unpriced[0].reason).toContain("largest Pro tier takes 750M");
  });

  it("returns no price once data points pass the 3.75B of the largest tier", () => {
    const w = base();
    // 86,000 series x 43,200 = 3,715,200,000 data points, under 3.75B.
    // Plan size: 3,715.2M / 5 = 743.04M events.
    w.metrics = { ...w.metrics, activeSeries: 86_000, intervalSeconds: 60 };
    const inside = estimateVendor(honeycomb, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    // 743.04 M x $3.00 = $2,229.12
    expect(inside.monthly).toBeCloseTo(2229.12, 6);
    expect(inside.lines.length).toBeGreaterThan(0);

    // 87,000 series x 43,200 = 3,758,400,000 data points, past 3.75B.
    w.metrics = { ...w.metrics, activeSeries: 87_000 };
    // Logs alone would fit: 1 GB/day = 30M records. The account still needs Enterprise.
    w.logs = { ...w.logs, gbPerDay: 1, avgRecordBytes: 1000 };
    const over = estimateVendor(honeycomb, onlySignals(w, ["logs", "metrics"]), DEFAULT_SETTINGS);
    expect(over.lines).toEqual([]);
    expect(over.monthly).toBe(0);
    expect(over.complete).toBe(false);
    expect(over.unpriced.map((u) => u.bucket)).toEqual(["logs", "metrics"]);
    expect(over.unpriced[1].reason).toContain("3.76B metric data points a month is past the 3.75B");
    expect(over.unpriced[0].reason).toContain("Enterprise");
  });

  it("returns every signal of the mid preset as quote-only", () => {
    // Logs: 330 GB/day x 30 = 9,900 GB / 1,000 bytes = 9.9B records.
    // Spans: 2,000/s x 2,592,000 s = 5.184B. Events: 15.084B, past 750M.
    // Data points: 250,000 series x 43,200 = 10.8B, past 3.75B.
    const estimate = estimateVendor(honeycomb, base(), DEFAULT_SETTINGS);
    expect(estimate.lines).toEqual([]);
    expect(estimate.monthly).toBe(0);
    expect(estimate.complete).toBe(false);
    expect(estimate.unpriced.map((u) => u.bucket)).toEqual(["logs", "metrics", "traces"]);
    expect(estimate.unpriced[0].reason).toContain("15.1B events a month");
    expect(estimate.unpriced[1].reason).toContain("10.8B metric data points");
  });

  it("worked example (a): the mid preset with DEFAULT_SETTINGS has no public price", () => {
    // From Honeycomb's pages only (read 2026-11-12):
    //   Logs: 330 GB/day × 30 = 9,900 GB = 9.9e12 bytes ÷ 1,000 bytes = 9,900,000,000 records.
    //   Spans: 2,000/s × 2,592,000 s = 5,184,000,000 spans.
    //   Events: 9.9B + 5.184B = 15.084B a month. Pro stops at 750M ("up to 750M").
    //   Data points: 250,000 series × 43,200 minutes = 10,800,000,000, past 3.75B.
    //   Over Pro the account needs Enterprise, priced by quote: $0 priced, incomplete.
    const estimate = estimateVendor(honeycomb, base(), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBe(0);
    expect(estimate.complete).toBe(false);
    expect(estimate.unpriced.map((u) => u.bucket)).toEqual(["logs", "metrics", "traces"]);
  });

  it("worked example (b): 100 GB of logs a day at 30 days is past Pro", () => {
    // 100 GB/day × 30 = 3,000 GB = 3e12 bytes ÷ 1,000 bytes = 3,000,000,000 records,
    // 4× the 750M events of the largest Pro tier. At the $3.00 rate it would be
    // $9,000, but Pro does not sell that size, so nothing is priced.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };
    const estimate = estimateVendor(honeycomb, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBe(0);
    expect(estimate.lines).toEqual([]);
    expect(estimate.complete).toBe(false);
    expect(estimate.unpriced.map((u) => u.bucket)).toEqual(["logs"]);
    expect(estimate.unpriced[0].reason).toContain("3B events a month");
  });

  it("reports the fixed 60-day and 13-month retention as kept", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 1, avgRecordBytes: 1000, retentionDays: 30 };
    w.metrics = { ...w.metrics, activeSeries: 1_000, retentionMonths: 24 };
    const estimate = estimateVendor(honeycomb, onlySignals(w, ["logs", "metrics"]), DEFAULT_SETTINGS);
    // 30M records and 43.2M data points fit the $150 tier.
    expect(estimate.monthly).toBeCloseTo(150, 6);
    // 30 days asked, 60 kept (longer): no gap. 24 months asked, 13 kept: a gap.
    expect(estimate.shortRetention).toEqual([
      { signal: "metrics", asked: 24, kept: 13, unit: "months" },
    ]);
    expect(estimate.assumptions[0]).toContain("24 months of retention were asked for");
  });

  it("shows the one published price for both billing terms", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 5, avgRecordBytes: 1000 }; // 150M records
    const monthly: Settings = { ...DEFAULT_SETTINGS, term: "monthly" };
    const annual: Settings = { ...DEFAULT_SETTINGS, term: "annual" };
    const onMonthly = estimateVendor(honeycomb, onlySignals(w, ["logs"]), monthly);
    const onAnnual = estimateVendor(honeycomb, onlySignals(w, ["logs"]), annual);
    // 150 M x $3.00 = $450 either way: no annual price is published.
    expect(onMonthly.monthly).toBeCloseTo(450, 6);
    expect(onAnnual.monthly).toBeCloseTo(450, 6);
    expect(onAnnual.notes.join(" ")).toContain("both terms show the published price");
    expect(honeycomb.plan(annual)).toBe(honeycomb.plan(monthly));
  });

  it("says when the retention asked for is longer than the fixed 60 days", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 1, avgRecordBytes: 1000, retentionDays: 90 };
    const estimate = estimateVendor(honeycomb, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // Retention has no price on Pro, so the bill is the same $150 as for 30 days.
    expect(estimate.monthly).toBeCloseTo(150, 6);
    const assumed = estimate.assumptions.join(" ");
    expect(assumed).toContain("90 days of retention were asked for");
    expect(assumed).toContain("fixed 60 days");
  });
});
