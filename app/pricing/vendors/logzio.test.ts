import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import type { Settings, VendorEstimate, Workload } from "../types";
import { derive } from "../units";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { logzio } from "./logzio";

/** Mid preset: 330 GB of logs a day, 250,000 series, 2,000 spans a second. */
const base = (): Workload => structuredClone(presetById("mid")!.workload);

const line = (estimate: VendorEstimate, rateId: string) =>
  estimate.lines.find((l) => l.rateId === rateId);

const rate = (id: string) => logzio.rates.find((r) => r.id === id);

describe("Logz.io: rates table", () => {
  it("carries the consumption prices as published", () => {
    // logz.io/pricing, Consumption tab, and the unit price table in
    // docs.logz.io/docs/user-guide/admin/plans/consumption, read 2026-11-12.
    expect(rate("log-ingest")?.usd).toBe(0.1);
    expect(rate("log-index")?.usd).toBe(0.82);
    expect(rate("log-hot-day")?.usd).toBe(0.03);
    expect(rate("metric-series-day")?.usd).toBe(0.2);
    expect(rate("trace-gb")?.usd).toBe(0.3);
    // Ingestion plus indexing is the pricing page's $0.92 for a GB kept 7 days.
    expect((rate("log-ingest")?.usd ?? 0) + (rate("log-index")?.usd ?? 0)).toBeCloseTo(0.92, 10);
  });

  it("marks the prices shown beside a struck-through price as promotional", () => {
    // The Consumption tab prints $0.20 beside a struck-through $0.40 (50% off)
    // and $0.30 beside a struck-through $0.92 (68% off).
    expect(rate("metric-series-day")?.basis).toBe("promotional");
    expect(rate("trace-gb")?.basis).toBe("promotional");
    expect(rate("metric-series-day-earlier")?.usd).toBe(0.4);
    expect(rate("trace-gb-earlier")?.usd).toBe(0.92);
    for (const id of ["log-ingest", "log-index", "log-hot-day"]) {
      expect(rate(id)?.basis).toBe("list");
    }
  });

  it("bills only from the five consumption rates, never the ones kept for the notes", () => {
    const billed = ["log-ingest", "log-index", "log-hot-day", "metric-series-day", "trace-gb"];
    const annual = estimateVendor(logzio, base(), DEFAULT_SETTINGS);
    expect(annual.lines.map((l) => l.rateId).sort()).toEqual([...billed].sort());
    const monthly = estimateVendor(logzio, base(), { ...DEFAULT_SETTINGS, term: "monthly" });
    expect(monthly.lines.map((l) => l.rateId).sort()).toEqual(billed.map((id) => `${id}-monthly`).sort());
  });

  it("derives the monthly rates as 1.2 times the annual ones", () => {
    // logz.io/pricing: "Billed annually (or monthly for 1.2x the cost)."
    expect(rate("log-ingest-monthly")?.usd).toBe(0.12);
    expect(rate("log-index-monthly")?.usd).toBe(0.984);
    expect(rate("log-hot-day-monthly")?.usd).toBe(0.036);
    expect(rate("metric-series-day-monthly")?.usd).toBe(0.24);
    expect(rate("trace-gb-monthly")?.usd).toBe(0.36);
  });
});

describe("Logz.io: reviewer's hand-computed bills", () => {
  // Every figure from the docs unit price table
  // (docs.logz.io/docs/user-guide/admin/plans/consumption, read 2026-11-13):
  // ingestion $0.10, index + 7 days hot $0.82, hot extension $0.03 per GB per
  // day, metrics $0.20 per 1,000 UTM per day, traces $0.30 per GB per day.
  it("bills the mid preset at default settings (annual, US East)", () => {
    // Logs 330 GB/day x 30 = 9,900 GB, 30 days asked, 23 past the included 7.
    //   9,900 x $0.10 = $990.00; 9,900 x $0.82 = $8,118.00;
    //   9,900 x 23 x $0.03 = $6,831.00. Logs = $15,939.00 (9,900 x $1.61).
    // Metrics 250,000 series: 250 x 30 = 7,500 x $0.20 = $1,500.00.
    // Traces 2,000/s x 2,592,000 s x 1,000 B = 5,184 GB x $0.30 = $1,555.20.
    // Total $18,994.20. Traces kept 10 days of the 30 asked.
    const estimate = estimateVendor(logzio, base(), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(18_994.2, 6);
    expect(estimate.complete).toBe(true);
    expect(estimate.shortRetention).toEqual([{ signal: "traces", asked: 30, kept: 10, unit: "days" }]);
  });

  it("bills 100 GB of logs a day alone at 30 days", () => {
    // 100 x 30 = 3,000 GB. 3,000 x $0.10 = $300.00; 3,000 x $0.82 = $2,460.00;
    // 3,000 x 23 x $0.03 = $2,070.00. Total $4,830.00 (3,000 x $1.61).
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30, searchableShare: 1 };
    const estimate = estimateVendor(logzio, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(line(estimate, "log-ingest")?.amount).toBeCloseTo(300, 6);
    expect(line(estimate, "log-index")?.amount).toBeCloseTo(2460, 6);
    expect(line(estimate, "log-hot-day")?.amount).toBeCloseTo(2070, 6);
    expect(estimate.monthly).toBeCloseTo(4830, 6);
    expect(estimate.shortRetention).toEqual([]);
  });
});

describe("Logz.io: worked examples", () => {
  it("matches the docs example: 3 GB a day kept 30 days hot is $4.83 a day", () => {
    // docs.logz.io/docs/user-guide/admin/plans/consumption:
    // $0.10 + $0.82 + ($0.03 x 23) = $1.61 per GB, and 3 GB x $1.61 = $4.83 a day.
    // A 30-day month: 90 GB.
    //   ingestion  90 GB x $0.10               =  $9.00
    //   indexing   90 GB x $0.82               = $73.80
    //   hot days   90 GB x 23 days x $0.03     = $62.10
    //   total                                  = $144.90  (= $4.83 x 30)
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 3, retentionDays: 30, searchableShare: 1 };
    const estimate = estimateVendor(logzio, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(line(estimate, "log-ingest")?.quantity).toBeCloseTo(90, 6);
    expect(line(estimate, "log-ingest")?.amount).toBeCloseTo(9, 6);
    expect(line(estimate, "log-index")?.amount).toBeCloseTo(73.8, 6);
    expect(line(estimate, "log-hot-day")?.quantity).toBeCloseTo(2070, 6);
    expect(line(estimate, "log-hot-day")?.amount).toBeCloseTo(62.1, 6);
    expect(estimate.byBucket.logs).toBeCloseTo(144.9, 6);
    expect(estimate.monthly).toBeCloseTo(144.9, 6);
    expect(estimate.complete).toBe(true);
  });

  it("matches the docs example at the included retention: 2 GB a day kept 7 days is $1.84 a day", () => {
    // Same docs page: 2 GB x $0.92 = $1.84 a day. $0.92 is $0.10 + $0.82.
    // A 30-day month: 60 GB x $0.92 = $55.20 (= $1.84 x 30). No extra days.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 2, retentionDays: 7, searchableShare: 1 };
    const estimate = estimateVendor(logzio, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(line(estimate, "log-hot-day")).toBeUndefined();
    expect(estimate.lines).toHaveLength(2);
    expect(estimate.monthly).toBeCloseTo(55.2, 6);
  });

  it("matches the consumption FAQ: a GB kept 14 days hot costs $1.13", () => {
    // logz.io/consumption-based-pricing-aws-faq: $0.10 to ingest, $0.82 to
    // index with 7 days, $0.21 for 7 more days, $1.13 in all.
    // 1 GB a day is 30 GB a month: 30 x $1.13 = $33.90.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 1, retentionDays: 14, searchableShare: 1 };
    const estimate = estimateVendor(logzio, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // 30 GB x 7 extra days x $0.03 = $6.30 (= 30 x $0.21)
    expect(line(estimate, "log-hot-day")?.amount).toBeCloseTo(6.3, 6);
    expect(estimate.monthly).toBeCloseTo(33.9, 6);
  });

  it("prices 1,000 series at $6 a month and matches the docs metrics example", () => {
    // Docs unit price table: $0.20 per 1,000 UTM per day.
    // 1 thousand x $0.20 x 30 days = $6.00.
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: 1_000, intervalSeconds: 60 };
    const small = estimateVendor(logzio, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(small.byBucket.metrics).toBeCloseTo(6, 6);
    expect(small.monthly).toBeCloseTo(6, 6);

    // Series are billed by count, so a 15 s export interval costs the same.
    w.metrics = { ...w.metrics, intervalSeconds: 15 };
    const faster = estimateVendor(logzio, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(faster.monthly).toBeCloseTo(6, 6);

    // Docs consumption example: 7,000 series x $0.20 per 1,000 = $1.40 a day.
    // A 30-day month: 7 x 30 = 210 thousand-series-days x $0.20 = $42.00.
    w.metrics = { ...w.metrics, activeSeries: 7_000 };
    const docs = estimateVendor(logzio, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(line(docs, "metric-series-day")?.quantity).toBeCloseTo(210, 6);
    expect(docs.monthly).toBeCloseTo(42, 6);
  });

  it("matches the docs example for traces: 4 GB a day is $1.20 a day", () => {
    // Docs consumption example: 4 GB x $0.30 = $1.20 a day.
    // 4 GB a day at 1,000 bytes a span is 4,000,000 spans a day, or
    // 4,000,000 / 86,400 = 46.296 spans a second.
    // A 30-day month: 120 GB x $0.30 = $36.00 (= $1.20 x 30).
    const w = base();
    w.traces = { ...w.traces, spansPerSecond: 4_000_000 / 86_400, avgSpanBytes: 1000 };
    const estimate = estimateVendor(logzio, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    expect(line(estimate, "trace-gb")?.quantity).toBeCloseTo(120, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(36, 6);
    expect(estimate.monthly).toBeCloseTo(36, 6);
  });

  it("prices each signal of the mid preset alone, and all three together", () => {
    // Logs: 330 GB/day x 30 = 9,900 GB, kept 30 days.
    //   ingestion  9,900 x $0.10                 =    $990.00
    //   indexing   9,900 x $0.82                 =  $8,118.00
    //   hot days   9,900 x 23 = 227,700 x $0.03  =  $6,831.00
    //   total      (9,900 x $1.61)               = $15,939.00
    const logs = estimateVendor(logzio, onlySignals(base(), ["logs"]), DEFAULT_SETTINGS);
    expect(line(logs, "log-ingest")?.amount).toBeCloseTo(990, 6);
    expect(line(logs, "log-index")?.amount).toBeCloseTo(8118, 6);
    expect(line(logs, "log-hot-day")?.quantity).toBeCloseTo(227_700, 6);
    expect(line(logs, "log-hot-day")?.amount).toBeCloseTo(6831, 6);
    expect(logs.monthly).toBeCloseTo(15_939, 6);

    // Metrics: 250,000 series = 250 thousand x 30 days = 7,500 x $0.20 = $1,500.00
    const metrics = estimateVendor(logzio, onlySignals(base(), ["metrics"]), DEFAULT_SETTINGS);
    expect(line(metrics, "metric-series-day")?.quantity).toBeCloseTo(7500, 6);
    expect(metrics.monthly).toBeCloseTo(1500, 6);

    // Traces: 2,000 spans/s x 2,592,000 s = 5,184,000,000 spans x 1,000 bytes
    // = 5,184 GB x $0.30 = $1,555.20
    const traces = estimateVendor(logzio, onlySignals(base(), ["traces"]), DEFAULT_SETTINGS);
    expect(line(traces, "trace-gb")?.quantity).toBeCloseTo(5184, 6);
    expect(traces.monthly).toBeCloseTo(1555.2, 6);

    // Together: $15,939.00 + $1,500.00 + $1,555.20 = $18,994.20. No base fee or seats.
    const all = estimateVendor(logzio, base(), DEFAULT_SETTINGS);
    expect(all.byBucket.logs).toBeCloseTo(15_939, 6);
    expect(all.byBucket.metrics).toBeCloseTo(1500, 6);
    expect(all.byBucket.traces).toBeCloseTo(1555.2, 6);
    expect(all.byBucket.platform).toBe(0);
    expect(all.monthly).toBeCloseTo(18_994.2, 6);
    expect(all.complete).toBe(true);

    // The notes price the same two lines at the struck-through rates:
    // 7,500 x $0.40 = $3,000 and 5,184 GB x $0.92 = $4,769.28.
    expect(all.notes.join(" ")).toContain("$3,000 and $4,769 a month");
  });

  it("bills ingestion on every GB and indexing only on the searchable share", () => {
    // 9,900 GB sent, 40% searchable = 3,960 GB indexed, kept 30 days.
    //   ingestion  9,900 x $0.10                =   $990.00
    //   indexing   3,960 x $0.82                = $3,247.20
    //   hot days   3,960 x 23 = 91,080 x $0.03  = $2,732.40
    //   total                                   = $6,969.60
    const w = base();
    w.logs = { ...w.logs, searchableShare: 0.4 };
    const logs = estimateVendor(logzio, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(line(logs, "log-ingest")?.quantity).toBeCloseTo(9900, 6);
    expect(line(logs, "log-index")?.quantity).toBeCloseTo(3960, 6);
    expect(line(logs, "log-index")?.amount).toBeCloseTo(3247.2, 6);
    expect(line(logs, "log-hot-day")?.quantity).toBeCloseTo(91_080, 6);
    expect(line(logs, "log-hot-day")?.amount).toBeCloseTo(2732.4, 6);
    expect(logs.monthly).toBeCloseTo(6969.6, 6);
    expect(logs.assumptions.join(" ")).toContain("40% of logs is indexed");

    // Traces have one price, so a lower share leaves 5,184 GB x $0.30 = $1,555.20.
    w.traces = { ...w.traces, searchableShare: 0.4 };
    const traces = estimateVendor(logzio, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    expect(traces.monthly).toBeCloseTo(1555.2, 6);
    expect(traces.assumptions.join(" ")).toContain("one trace price");
  });

  it("adds nothing for retention until it passes the 7 included days", () => {
    // 7 days: 9,900 GB x ($0.10 + $0.82) = 9,900 x $0.92 = $9,108.00, no extension line.
    const w = base();
    w.logs = { ...w.logs, retentionDays: 7 };
    const week = estimateVendor(logzio, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(line(week, "log-hot-day")).toBeUndefined();
    expect(week.monthly).toBeCloseTo(9108, 6);

    // 15 days: 8 extra days. 9,900 x 8 = 79,200 GB-days x $0.03 = $2,376.00.
    // $9,108.00 + $2,376.00 = $11,484.00 (9,900 x $1.16).
    w.logs = { ...w.logs, retentionDays: 15 };
    const longer = estimateVendor(logzio, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(line(longer, "log-hot-day")?.quantity).toBeCloseTo(79_200, 6);
    expect(line(longer, "log-hot-day")?.amount).toBeCloseTo(2376, 6);
    expect(longer.monthly).toBeCloseTo(11_484, 6);

    // 3 days asked for: indexing still comes with 7, so the price is the
    // 7-day $9,108.00 and the estimate says why.
    w.logs = { ...w.logs, retentionDays: 3 };
    const shorter = estimateVendor(logzio, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(shorter.monthly).toBeCloseTo(9108, 6);
    expect(shorter.assumptions.join(" ")).toContain("Indexing comes with 7 days");
  });

  it("prices the fixed trace and metric retention and says when the ask is longer", () => {
    // The mid preset asks for 30 days of traces. Logz.io keeps spans 10 days.
    const asked30 = estimateVendor(logzio, onlySignals(base(), ["traces"]), DEFAULT_SETTINGS);
    expect(asked30.assumptions[0]).toContain("Traces are kept 10 days, shorter than the 30 days");
    expect(asked30.shortRetention).toHaveLength(1);
    expect(asked30.monthly).toBeCloseTo(1555.2, 6);

    const w = base();
    w.traces = { ...w.traces, retentionDays: 7 };
    const asked7 = estimateVendor(logzio, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    expect(asked7.assumptions.join(" ")).not.toContain("shorter");
    expect(asked7.shortRetention).toEqual([]);
    expect(asked7.monthly).toBeCloseTo(1555.2, 6);

    // 13 months of metrics fits inside the fixed 18. 24 does not, and the
    // price stays 7,500 x $0.20 = $1,500.00.
    const asked13 = estimateVendor(logzio, onlySignals(base(), ["metrics"]), DEFAULT_SETTINGS);
    expect(asked13.assumptions.join(" ")).not.toContain("shorter");
    expect(asked13.assumptions.join(" ")).toContain("Metrics are kept 18 months");
    w.metrics = { ...w.metrics, retentionMonths: 24 };
    const asked24 = estimateVendor(logzio, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(asked24.assumptions[0]).toContain("Metrics are kept 18 months, shorter than the 24 months");
    expect(asked24.monthly).toBeCloseTo(1500, 6);
  });

  it("bills monthly at 1.2 times the annual price", () => {
    // Mid preset, monthly billing, every rate x 1.2:
    //   logs     9,900 x ($0.12 + $0.984) + 227,700 x $0.036
    //            = $1,188.00 + $9,741.60 + $8,197.20 = $19,126.80
    //   metrics  7,500 x $0.24  = $1,800.00
    //   traces   5,184 x $0.36  = $1,866.24
    //   total    $22,793.04 (= $18,994.20 x 1.2)
    const monthly: Settings = { ...DEFAULT_SETTINGS, term: "monthly" };
    const estimate = estimateVendor(logzio, base(), monthly);
    expect(estimate.byBucket.logs).toBeCloseTo(19_126.8, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(1800, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(1866.24, 6);
    expect(estimate.monthly).toBeCloseTo(22_793.04, 6);
    expect(estimate.notes[0]).toContain("1.2 times the annual price");
    expect(logzio.plan(monthly)).toContain("billed monthly");
  });

  it("reports the retention the price buys in kept", () => {
    // Mid preset asks 30 days of logs, 30 of traces, 13 months of metrics.
    // Logs are priced to 30 days; traces are fixed at 10 (shorter), metrics at 18 (longer).
    const mid = estimateVendor(logzio, base(), DEFAULT_SETTINGS);
    expect(mid.shortRetention).toEqual([{ signal: "traces", asked: 30, kept: 10, unit: "days" }]);
    expect(mid.assumptions[0]).toContain("Traces are kept 10 days, shorter than the 30 days");
    const out = logzio.price({
      w: base(),
      d: derive(base()),
      s: DEFAULT_SETTINGS,
    });
    expect(out.kept).toEqual({ tracesDays: 10, metricsMonths: 18 });

    // 3 days of logs asked: indexing keeps 7, which is longer, so kept says 7 and no gap is marked.
    const w = base();
    w.logs = { ...w.logs, retentionDays: 3 };
    const short = logzio.price({ w, d: derive(w), s: DEFAULT_SETTINGS });
    expect(short.kept?.logsDays).toBe(7);

    // 24 months of metrics asked: kept 18, a gap the engine marks.
    w.metrics = { ...w.metrics, retentionMonths: 24 };
    const long = estimateVendor(logzio, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(long.shortRetention).toEqual([{ signal: "metrics", asked: 24, kept: 18, unit: "months" }]);
    expect(long.assumptions[0]).toContain("Metrics are kept 18 months, shorter");
  });

  it("leaves an EU region unpriced: prices are published for AWS US East only", () => {
    const eu: Settings = { ...DEFAULT_SETTINGS, region: "eu" };
    const all = estimateVendor(logzio, base(), eu);
    expect(all.lines).toEqual([]);
    expect(all.monthly).toBe(0);
    expect(all.complete).toBe(false);
    expect(all.unpriced.map((u) => u.bucket)).toEqual(["logs", "metrics", "traces"]);

    const logsOnly = estimateVendor(logzio, onlySignals(base(), ["logs"]), eu);
    expect(logsOnly.unpriced.map((u) => u.bucket)).toEqual(["logs"]);
  });

  it("leaves metrics unpriced past 6 data points a minute per series", () => {
    // A 10 s interval is 6 data points a minute, the most the price covers.
    const w = base();
    w.metrics = { ...w.metrics, intervalSeconds: 10 };
    const atLimit = estimateVendor(logzio, w, DEFAULT_SETTINGS);
    expect(atLimit.complete).toBe(true);
    expect(atLimit.byBucket.metrics).toBeCloseTo(1500, 6);

    // A 5 s interval is 12 a minute: no public price. Logs and traces still
    // come to $15,939.00 + $1,555.20 = $17,494.20.
    w.metrics = { ...w.metrics, intervalSeconds: 5 };
    const tooFast = estimateVendor(logzio, w, DEFAULT_SETTINGS);
    expect(tooFast.complete).toBe(false);
    expect(tooFast.unpriced.map((u) => u.bucket)).toEqual(["metrics"]);
    expect(tooFast.byBucket.metrics).toBe(0);
    expect(tooFast.monthly).toBeCloseTo(17_494.2, 6);
  });
});
