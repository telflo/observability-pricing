import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import { usdRate } from "../format";
import type { Settings, VendorEstimate, Workload } from "../types";
import { SECONDS_PER_MONTH, derive } from "../units";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { googleCloud } from "./google-cloud";

const base = (): Workload => structuredClone(presetById("mid")!.workload);

/** Decimal GB a day that add up to the given GiB over the 30-day month. */
const gbPerDayForGib = (gibPerMonth: number) => (gibPerMonth * 2 ** 30) / 1e9 / 30;

const allText = (e: VendorEstimate) => [
  ...e.assumptions,
  ...e.included,
  ...e.notIncluded,
  ...e.notes,
];

describe("Google Cloud Observability: rates", () => {
  it("carries the prices on Google's pricing page as read on 2026-11-12", () => {
    // cloud.google.com/products/observability/pricing, the three summary tables.
    const usd = Object.fromEntries(googleCloud.rates.map((rate) => [rate.id, rate.usd]));
    expect(usd).toEqual({
      // Cloud Logging, storage row: $0.50/GiB, a one-time charge that includes
      // up to 30 days of storage. Free allotment: first 50 GiB per project a month.
      "log-storage": 0.5,
      // Cloud Logging, retention row: $0.01 per GiB per month past 30 days.
      "log-retention": 0.01,
      // Cloud Monitoring, Managed Service for Prometheus row, per million samples:
      // $0.06 for 0-50 billion, $0.048 for 50-250 billion, $0.036 for 250-500
      // billion, $0.024 over 500 billion. No free allotment.
      "metric-samples-first-50b": 0.06,
      "metric-samples-50b-250b": 0.048,
      "metric-samples-250b-500b": 0.036,
      "metric-samples-over-500b": 0.024,
      // Cloud Trace, ingestion row: $0.20/million spans. Free allotment: first
      // 2.5 million spans per billing account.
      "trace-spans": 0.2,
      // Cloud Monitoring, API calls row: reads at $0.50/million time series
      // returned. Used only to quote the price in text, never billed here.
      "monitoring-api-reads": 0.5,
    });
    for (const rate of googleCloud.rates) {
      expect(rate.basis).toBe("list");
      expect(rate.sourceId).toBe("pricing");
    }
  });
});

describe("Google Cloud Observability: worked by hand from the pricing page", () => {
  // (a) The mid-size preset with the default settings.
  //
  // Logs: 330 GB/day x 30 days = 9,900 GB = 9.9 x 10^12 bytes.
  //   Google bills GiB: 9.9 x 10^12 / 2^30 = 9,220.0935 GiB.
  //   The first 50 GiB per project are free: 9,170.0935 GiB x $0.50 = $4,585.0467.
  //   Kept 30 days, which the storage price includes: no retention charge.
  // Metrics: 250,000 series x one sample a minute x 43,200 minutes
  //   = 10,800 million samples, all inside the first 50,000 million.
  //   10,800 x $0.06 = $648.00. Samples have no free allotment.
  // Traces: 2,000 spans/s x 2,592,000 s = 5,184 million spans.
  //   The first 2.5 million are free: 5,181.5 x $0.20 = $1,036.30.
  // Total: $4,585.0467 + $648.00 + $1,036.30 = $6,269.3467 a month.
  it("prices the mid-size preset line by line", () => {
    const estimate = estimateVendor(googleCloud, base(), DEFAULT_SETTINGS);

    const logGib = (330 * 30 * 1e9) / 2 ** 30;
    expect(logGib).toBeCloseTo(9220.0935, 4);

    expect(estimate.lines.map((line) => [line.bucket, line.rateId])).toEqual([
      ["logs", "log-storage"],
      ["metrics", "metric-samples-first-50b"],
      ["traces", "trace-spans"],
    ]);
    const [logs, metrics, traces] = estimate.lines;
    expect(logs.quantity).toBeCloseTo(logGib - 50, 9);
    expect(logs.amount).toBeCloseTo(4585.0467, 3);
    expect(metrics.quantity).toBeCloseTo(10_800, 9);
    expect(metrics.amount).toBeCloseTo(648, 6);
    expect(traces.quantity).toBeCloseTo(5_181.5, 9);
    expect(traces.amount).toBeCloseTo(1036.3, 6);

    expect(estimate.byBucket.logs).toBeCloseTo(4585.0467, 3);
    expect(estimate.byBucket.metrics).toBeCloseTo(648, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(1036.3, 6);
    expect(estimate.byBucket.platform).toBe(0);
    expect(estimate.monthly).toBeCloseTo(6269.3467, 3);
    expect(estimate.complete).toBe(true);

    // Retention asked: logs 30 days, traces 30 days, metrics 13 months.
    // Cloud Logging and Cloud Trace keep 30 days, matching the ask. Cloud
    // Monitoring keeps OTLP metrics 24 months at no charge, so kept reports
    // 24 (longer than asked, so no short-retention mark).
    expect(estimate.shortRetention).toEqual([]);
    const out = googleCloud.price({ w: base(), d: derive(base()), s: DEFAULT_SETTINGS });
    expect(out.kept).toEqual({ metricsMonths: 24 });
    // All 250,000 series are billed, the 62,500 host series included.
    expect(out.assumptions.join(" ")).toContain("including the 62.5K host, container and Kubernetes series");
  });

  // (b) 100 GB of logs a day and nothing else, kept 30 days.
  //
  // 100 GB/day x 30 days = 3,000 GB = 3 x 10^12 bytes / 2^30 = 2,793.9677 GiB.
  // Less the free 50 GiB: 2,743.9677 GiB x $0.50 = $1,371.9839.
  // 30 days is included, so there is no retention line.
  it("prices 100 GB of logs a day alone at 30 days", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };
    const estimate = estimateVendor(googleCloud, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);

    expect(estimate.lines).toHaveLength(1);
    expect(estimate.lines[0].rateId).toBe("log-storage");
    expect(estimate.lines[0].quantity).toBeCloseTo((3_000 * 1e9) / 2 ** 30 - 50, 9);
    expect(estimate.lines[0].quantity).toBeCloseTo(2743.9677, 3);
    expect(estimate.byBucket.logs).toBeCloseTo(1371.9839, 3);
    expect(estimate.byBucket.metrics).toBe(0);
    expect(estimate.byBucket.traces).toBe(0);
    expect(estimate.monthly).toBeCloseTo(1371.9839, 3);
    expect(estimate.complete).toBe(true);

    // The storage charge is one-time and covers up to 30 days, so 7 days of
    // retention is the same $1,371.9839.
    w.logs = { ...w.logs, retentionDays: 7 };
    const short = estimateVendor(googleCloud, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(short.monthly).toBeCloseTo(1371.9839, 3);
    expect(short.assumptions.join(" ")).toContain("costs the same");
    // The price buys 30 days, longer than the 7 asked: kept says 30, no mark.
    const logsOnly = onlySignals(w, ["logs"]);
    expect(googleCloud.price({ w: logsOnly, d: derive(logsOnly), s: DEFAULT_SETTINGS }).kept).toEqual({
      logsDays: 30,
    });
    expect(short.shortRetention).toEqual([]);
  });
});

describe("Google Cloud Observability: Google's examples", () => {
  // cloud.google.com/stackdriver/observability-pricing-examples, "Metric data
  // charged by samples ingested". Google's examples use a 730-hour month and
  // this calculator uses 30 days, so each case reaches Google's sample count
  // with a 27 s interval, where one series writes 2,592,000 s / 27 s = 96,000
  // samples a month.
  it.each([
    {
      // Scenario 1, variant B: 4,380 million x $0.06 = $262.80
      // 45,625 series x 96,000 = 4,380,000,000 samples
      name: "scenario 1B, one tier",
      series: 45_625,
      millions: 4_380,
      tiers: [262.8],
      total: 262.8,
    },
    {
      // Scenario 2, variant A: 175,200 million samples
      // 50,000 x $0.06 = $3,000.00, then 125,200 x $0.048 = $6,009.60
      // 1,825,000 series x 96,000 = 175,200,000,000 samples
      name: "scenario 2A, two tiers",
      series: 1_825_000,
      millions: 175_200,
      tiers: [3_000, 6_009.6],
      total: 9_009.6,
    },
    {
      // Scenario 3, variant B: 337,260 million samples
      // $3,000.00, then 200,000 x $0.048 = $9,600.00, then 87,260 x $0.036 = $3,141.36
      // 3,513,125 series x 96,000 = 337,260,000,000 samples
      name: "scenario 3B, three tiers",
      series: 3_513_125,
      millions: 337_260,
      tiers: [3_000, 9_600, 3_141.36],
      total: 15_741.36,
    },
    {
      // Scenario 4, variant B: 27,156,000 million samples
      // $3,000.00 + $9,600.00, then 250,000 x $0.036 = $9,000.00,
      // then 26,656,000 x $0.024 = $639,744.00
      // 282,875,000 series x 96,000 = 27,156,000,000,000 samples
      name: "scenario 4B, all four tiers",
      series: 282_875_000,
      millions: 27_156_000,
      tiers: [3_000, 9_600, 9_000, 639_744],
      total: 661_344,
    },
  ])("matches the samples example: $name", ({ series, millions, tiers, total }) => {
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: series, intervalSeconds: 27 };
    const estimate = estimateVendor(googleCloud, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);

    const samples = estimate.lines.reduce((sum, line) => sum + line.quantity, 0);
    expect(samples).toBeCloseTo(millions, 4);
    expect(estimate.lines.map((line) => line.bucket)).toEqual(tiers.map(() => "metrics"));
    estimate.lines.forEach((line, i) => expect(line.amount).toBeCloseTo(tiers[i], 4));
    expect(estimate.byBucket.metrics).toBeCloseTo(total, 4);
    expect(estimate.monthly).toBeCloseTo(total, 4);
  });

  it("prices scenario 3A by the stacked ranges, not by the remainder the page prints", () => {
    // Scenario 3, variant A is 1,349,040 million samples. The page charges a
    // remainder of 749,040 million at the last rate and totals $39,576.96,
    // but 1,349,040 - 500,000 = 849,040 million, so the page is 100,000 million
    // samples short. By its range table:
    // $3,000.00 + $9,600.00 + $9,000.00 + 849,040 x $0.024 ($20,376.96) = $41,976.96
    // 14,052,500 series x 96,000 = 1,349,040,000,000 samples
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: 14_052_500, intervalSeconds: 27 };
    const estimate = estimateVendor(googleCloud, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(estimate.lines).toHaveLength(4);
    expect(estimate.lines[3].quantity).toBeCloseTo(849_040, 4);
    expect(estimate.monthly).toBeCloseTo(41_976.96, 4);
  });

  // Same page, "Cloud Trace pricing examples". The first 2.5 million spans a
  // month are free and the rest cost $0.20 per million.
  it.each([
    // 2 million spans: inside the free 2.5 million, so $0
    { name: "2 million spans", spans: 2_000_000, total: 0 },
    // 14 million spans: (14 - 2.5) x $0.20 = 11.5 x $0.20 = $2.30
    { name: "14 million spans", spans: 14_000_000, total: 2.3 },
    // 1 billion spans: (1,000 - 2.5) x $0.20 = 997.5 x $0.20 = $199.50
    { name: "1 billion spans", spans: 1_000_000_000, total: 199.5 },
  ])("matches the Cloud Trace example: $name", ({ spans, total }) => {
    const w = base();
    w.traces = { ...w.traces, spansPerSecond: spans / SECONDS_PER_MONTH };
    const estimate = estimateVendor(googleCloud, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    expect(estimate.byBucket.traces).toBeCloseTo(total, 6);
    expect(estimate.monthly).toBeCloseTo(total, 6);
    expect(estimate.complete).toBe(true);
  });

  // docs.cloud.google.com/bigtable/docs/audit-log-estimate-costs is a worked
  // example Google publishes of log storage with retention. It prints a table
  // of monthly Cloud Logging cost by request rate and days kept. Its method:
  // requests a second x 2,628,000 s x 1 KB = GB a month, x .93 = GiB,
  // less 50 GiB free, x $0.50. Kept past 30 days, each month past the first
  // adds the monthly GiB x $0.01, so 90 days adds two. The table rounds to
  // the dollar.
  const logsLikeGoogle = (requestsPerSecond: number, days: number) => {
    const gib = ((requestsPerSecond * 2_628_000) / 1e6) * 0.93;
    const w = base();
    w.logs = { ...w.logs, gbPerDay: gbPerDayForGib(gib), retentionDays: days };
    return estimateVendor(googleCloud, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
  };

  it.each([
    // 1,000 req/s: 2,628 GB x .93 = 2,444.04 GiB. (2,444.04 - 50) x $0.50 = $1,197.02
    { rps: 1_000, days: 30, published: 1_197 },
    // plus 2 x 2,444.04 GiB x $0.01 = $48.88: $1,245.90
    { rps: 1_000, days: 90, published: 1_246 },
    // 10,000 req/s: 24,440.4 GiB. (24,440.4 - 50) x $0.50 = $12,195.20
    { rps: 10_000, days: 30, published: 12_195 },
    // plus 2 x 24,440.4 GiB x $0.01 = $488.81: $12,684.01
    { rps: 10_000, days: 90, published: 12_684 },
    // 100,000 req/s: 244,404 GiB. (244,404 - 50) x $0.50 = $122,177.00
    { rps: 100_000, days: 30, published: 122_177 },
  ])(
    "matches the log cost table: $rps requests a second kept $days days",
    ({ rps, days, published }) => {
      expect(Math.round(logsLikeGoogle(rps, days).monthly)).toBe(published);
    },
  );

  it("prices the table's last row by the method the page states, not the figure it prints", () => {
    // 100,000 requests a second kept 90 days. By the page's method:
    // $122,177.00 + 2 x 244,404 GiB x $0.01 ($4,888.08) = $127,065.08.
    // The page prints $124,621, which adds one month of retention ($2,444.04)
    // where its other 90-day rows and its detailed example add two.
    const estimate = logsLikeGoogle(100_000, 90);
    expect(estimate.lines).toHaveLength(2);
    expect(estimate.lines[1].quantity).toBeCloseTo(2 * 244_404, 4);
    expect(estimate.monthly).toBeCloseTo(127_065.08, 2);
  });

  it("lands within a dollar of the detailed log example", () => {
    // Same page, the detailed example: 5,000 requests a second kept 90 days.
    // 13,140 GB x .93 = 12,220 GiB, less 50 = 12,170 GiB x $0.50 = $6,085, then
    // $122 for each of the two months past the first, about $6,329 a month.
    // Here: (12,220.2 - 50) x $0.50 = $6,085.10, plus 2 x 12,220.2 x $0.01
    // = $244.40, so $6,329.50. The 50 cents is the page rounding 12,220.2 down
    // and taking the free 50 GiB off the retained volume, which its table does not.
    const estimate = logsLikeGoogle(5_000, 90);
    expect(estimate.lines[0].amount).toBeCloseTo(6_085.1, 4);
    expect(estimate.lines[1].amount).toBeCloseTo(244.404, 4);
    expect(Math.abs(estimate.monthly - 6_329)).toBeLessThan(1);
  });
});

describe("Google Cloud Observability: billing rules", () => {
  it("charges nothing for logs inside the free 50 GiB, and $0.50 for each GiB past it", () => {
    const small = base();
    small.logs = { ...small.logs, gbPerDay: 1, retentionDays: 30 };
    // 1 GB/day x 30 days = 30 GB = 27.94 GiB, under the free 50 GiB: $0
    const free = estimateVendor(googleCloud, onlySignals(small, ["logs"]), DEFAULT_SETTINGS);
    expect(free.monthly).toBe(0);
    expect(free.assumptions.join(" ")).toContain("free allotment");

    const edge = base();
    edge.logs = { ...edge.logs, gbPerDay: gbPerDayForGib(50), retentionDays: 30 };
    // Exactly 50 GiB in the month: still $0
    const atEdge = estimateVendor(googleCloud, onlySignals(edge, ["logs"]), DEFAULT_SETTINGS);
    expect(atEdge.monthly).toBeCloseTo(0, 6);

    const past = base();
    past.logs = { ...past.logs, gbPerDay: gbPerDayForGib(1_050), retentionDays: 30 };
    // 1,050 GiB in the month: (1,050 - 50) x $0.50 = $500.00
    const billed = estimateVendor(googleCloud, onlySignals(past, ["logs"]), DEFAULT_SETTINGS);
    expect(billed.monthly).toBeCloseTo(500, 6);
  });

  it("adds $0.01 per GiB a month for logs kept past the included 30 days", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 90 };
    const estimate = estimateVendor(googleCloud, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // Storage, as in (b): $1,371.9839
    // Retention: 100 GB/day x (90 - 30) days = 6,000 GB = 5,587.9354 GiB held,
    // which is two months of the 2,793.9677 GiB sent. The free 50 GiB is a
    // storage allotment and does not come off the retained volume.
    // 5,587.9354 x $0.01 = $55.8794
    // Total: $1,371.9839 + $55.8794 = $1,427.8632
    expect(estimate.lines.map((line) => line.rateId)).toEqual(["log-storage", "log-retention"]);
    expect(estimate.lines[1].quantity).toBeCloseTo(2 * ((3_000 * 1e9) / 2 ** 30), 9);
    expect(estimate.lines[1].quantity).toBeCloseTo(5587.9354, 3);
    expect(estimate.lines[1].amount).toBeCloseTo(55.8794, 3);
    expect(estimate.monthly).toBeCloseTo(1427.8632, 3);
    expect(estimate.assumptions.join(" ")).toContain("a full 90 days of logs in storage");
  });

  it("prices log retention up to the 3,650-day limit and says so past it", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 4_000 };
    const estimate = estimateVendor(googleCloud, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // Storage: $1,371.9839
    // Retention at the 3,650-day limit: 100 GB/day x (3,650 - 30) days = 362,000 GB
    // = 337,138.7720 GiB held x $0.01 = $3,371.3877
    // Total: $4,743.3716
    expect(estimate.monthly).toBeCloseTo(4743.3716, 3);
    expect(estimate.assumptions[0]).toContain("at most 3,650 days");
    expect(estimate.shortRetention).toEqual([
      { signal: "logs", asked: 4_000, kept: 3_650, unit: "days" },
    ]);
  });

  it("crosses the 50 billion sample edge on the metrics-heavy preset", () => {
    const w = structuredClone(presetById("metrics-heavy")!.workload);
    const estimate = estimateVendor(googleCloud, w, DEFAULT_SETTINGS);
    // 1,000,000 series at 15 s: 4 points a minute x 43,200 minutes = 172,800 million samples
    // First 50,000 million x $0.06 = $3,000.00
    // Next 122,800 million x $0.048 = $5,894.40
    // Total: $8,894.40. The preset sends no logs or traces.
    expect(estimate.lines.map((line) => line.quantity)).toEqual([50_000, 122_800]);
    expect(estimate.byBucket.metrics).toBeCloseTo(8894.4, 6);
    expect(estimate.monthly).toBeCloseTo(8894.4, 6);
  });

  it("gives the same price for every term, region and query load", () => {
    const settings: Settings[] = [
      { term: "annual", region: "us", queryLoad: "typical" },
      { term: "monthly", region: "us", queryLoad: "light" },
      { term: "annual", region: "eu", queryLoad: "heavy" },
      { term: "monthly", region: "eu", queryLoad: "typical" },
    ];
    // One global pay-as-you-go list and no query charge: the mid-size total, $6,269.3467
    for (const s of settings) {
      expect(estimateVendor(googleCloud, base(), s).monthly).toBeCloseTo(6269.3467, 3);
    }
  });

  it("prices the retention Google offers when more is asked for, and says so", () => {
    const w = base();
    w.traces = { ...w.traces, retentionDays: 90 };
    w.metrics = { ...w.metrics, retentionMonths: 36 };
    const estimate = estimateVendor(googleCloud, w, DEFAULT_SETTINGS);
    // Spans are kept 30 days and metrics 24 months with no longer option, so
    // the bill is the mid-size total again: $6,269.3467
    expect(estimate.monthly).toBeCloseTo(6269.3467, 3);
    // The shorter retention leads the assumptions and is reported as data.
    const firstTwo = estimate.assumptions.slice(0, 2).join(" ");
    expect(firstTwo).toContain("The 90 days asked for is priced as 30.");
    expect(firstTwo).toContain("The 36 months asked for is priced as 24.");
    expect(estimate.shortRetention).toEqual(
      expect.arrayContaining([
        { signal: "metrics", asked: 36, kept: 24, unit: "months" },
        { signal: "traces", asked: 90, kept: 30, unit: "days" },
      ]),
    );
    expect(estimate.shortRetention).toHaveLength(2);
  });

  it("uses the multiplication sign in line details", () => {
    for (const line of estimateVendor(googleCloud, base(), DEFAULT_SETTINGS).lines) {
      expect(line.detail ?? "").not.toMatch(/ x /);
      expect(line.detail ?? "").toContain("×");
    }
  });

  it("ignores the searchable share, and says so only when it is below 1", () => {
    const w = base();
    const full = estimateVendor(googleCloud, w, DEFAULT_SETTINGS);
    expect(full.assumptions.join(" ")).not.toContain("searchable share");

    w.logs = { ...w.logs, searchableShare: 0.2 };
    w.traces = { ...w.traces, searchableShare: 0.1 };
    const partial = estimateVendor(googleCloud, w, DEFAULT_SETTINGS);
    // One storage tier for logs and one for spans: the mid-size total, $6,269.3467
    expect(partial.monthly).toBeCloseTo(6269.3467, 3);
    const text = partial.assumptions.join(" ");
    expect(text).toContain("Cloud Logging has one storage tier.");
    expect(text).toContain("Cloud Trace has one storage tier.");
  });
});

describe("Google Cloud Observability: text", () => {
  const routes: { name: string; estimate: VendorEstimate }[] = [
    { name: "everything", estimate: estimateVendor(googleCloud, base(), DEFAULT_SETTINGS) },
    ...(["logs", "metrics", "traces"] as const).map((signal) => ({
      name: `${signal} only`,
      estimate: estimateVendor(googleCloud, onlySignals(base(), [signal]), DEFAULT_SETTINGS),
    })),
  ];

  it("talks only about the signals being sent", () => {
    const text = (name: string) => allText(routes.find((r) => r.name === name)!.estimate).join(" ");
    expect(text("logs only")).not.toMatch(/metric|sample|span|trace/i);
    expect(text("metrics only")).not.toMatch(/\blogs?\b|span|trace/i);
    expect(text("traces only")).not.toMatch(/\blogs?\b|metric|sample/i);
  });

  it("quotes prices only from the rates table, with no em dashes or semicolons", () => {
    const listed = new Set(googleCloud.rates.map((rate) => usdRate(rate.usd)));
    for (const { name, estimate } of routes) {
      for (const text of allText(estimate)) {
        expect(text, `${name}: "${text}"`).not.toMatch(/[—;]/);
        for (const price of text.match(/\$[\d,]+(?:\.\d+)?/g) ?? []) {
          expect(listed, `${name}: ${price} is a listed rate`).toContain(price);
        }
      }
    }
  });
});
