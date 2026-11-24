import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import type { Settings, VendorEstimate, Workload } from "../types";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { grafanaCloud } from "./grafana-cloud";

const base = (): Workload => structuredClone(presetById("mid")!.workload);
const preset = (id: string): Workload => structuredClone(presetById(id)!.workload);

/** What the estimate bills at the rates whose id starts with `prefix`. */
const billedAt = (estimate: VendorEstimate, prefix: string): number =>
  estimate.lines.filter((l) => l.rateId.startsWith(prefix)).reduce((sum, l) => sum + l.amount, 0);

const lineAt = (estimate: VendorEstimate, rateId: string) =>
  estimate.lines.find((l) => l.rateId === rateId);

// Rates as read on 2026-11-12: first bands on grafana.com/pricing (Pro column),
// later bands from the rate tables of the calculator on that page. A band's
// bounds are on the month's total, and the included usage is the free bottom
// of the first band:
//   platform fee              $19 a month
//   metrics, per 1,000 series $6.50 to 100k (first 10k included), $5.90 to 200k, $5.50 above
//   logs and traces, per GB, 50 GB included on each meter:
//     Process                 $0.05 to 10,000 GB, $0.046 to 25,000 GB, $0.044 above
//     Write                   $0.40 to 1,000 GB,  $0.37 to 2,500 GB,   $0.355 above
//     Retain (30 days)        $0.10 to 5,000 GB,  $0.092 to 12,500 GB, $0.088 above
//   users, per active user    $8 to 25 (first 3 included), $7.25 to 50, $6.80 above
describe("Grafana Cloud: worked examples", () => {
  it("matches Grafana's example: 500,000 billable series is $2,825", () => {
    // Billing docs, "Volume discounts", and the pricing-page calculator at 0%
    // Adaptive reduction:
    //   first 100,000 series  90,000 billable (10,000 included) x $6.50 per 1,000 = $585
    //   next 100,000 series   x $5.90 per 1,000                                  = $590
    //   next 300,000 series   x $5.50 per 1,000                                  = $1,650
    //   total                                                                      $2,825
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: 500_000, intervalSeconds: 60 };
    const estimate = estimateVendor(grafanaCloud, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(estimate.byBucket.metrics).toBeCloseTo(2825, 6);
    expect(lineAt(estimate, "metrics-1")?.amount).toBeCloseTo(585, 6);
    expect(lineAt(estimate, "metrics-2")?.amount).toBeCloseTo(590, 6);
    expect(lineAt(estimate, "metrics-3")?.amount).toBeCloseTo(1650, 6);
    // Platform: the $19 fee, plus (15 users - 3 included) x $8 = $96.
    expect(estimate.byBucket.platform).toBeCloseTo(115, 6);
    expect(estimate.monthly).toBeCloseTo(2940, 6);
    expect(estimate.complete).toBe(true);
  });

  it("bills data points per minute when series are sent faster than once a minute", () => {
    // Billing docs, "Metrics", scenario A: 50,000 series at 60 s is usage of
    // 50,000. (50,000 - 10,000 included) / 1,000 x $6.50 = $260.
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: 50_000, intervalSeconds: 60 };
    const slow = estimateVendor(grafanaCloud, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(slow.byBucket.metrics).toBeCloseTo(260, 6);

    // Scenario B: the same 50,000 series at 30 s is 100,000 data points a
    // minute against 1 included per series, so usage is 100,000.
    // (100,000 - 10,000 included) / 1,000 x $6.50 = $585.
    w.metrics.intervalSeconds = 30;
    const fast = estimateVendor(grafanaCloud, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(fast.byBucket.metrics).toBeCloseTo(585, 6);
    expect(fast.assumptions.join(" ")).toContain("50K series bill as 100K");

    // The Kubernetes preset, 250,000 series at 30 s, is 500,000 billable
    // series: the $2,825 of Grafana's example above.
    const k8s = estimateVendor(
      grafanaCloud,
      onlySignals(preset("kubernetes"), ["metrics"]),
      DEFAULT_SETTINGS,
    );
    expect(k8s.byBucket.metrics).toBeCloseTo(2825, 6);
  });

  it("matches Grafana's calculator for logs alone: 1,000 GB is $522.50", () => {
    // Pricing-page calculator, Logs, 1,000 GB, Adaptive reduction 0%: $522.50.
    //   Process  (1,000 - 50 included) x $0.05 = $47.50
    //   Write    950 x $0.40                    = $380.00
    //   Retain   950 x $0.10                    = $95.00
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 1000 / 30, retentionDays: 30 };
    const estimate = estimateVendor(grafanaCloud, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(billedAt(estimate, "logs-process")).toBeCloseTo(47.5, 6);
    expect(billedAt(estimate, "logs-write")).toBeCloseTo(380, 6);
    expect(billedAt(estimate, "logs-retain")).toBeCloseTo(95, 6);
    expect(estimate.byBucket.logs).toBeCloseTo(522.5, 6);
    expect(estimate.byBucket.metrics).toBe(0);
    expect(estimate.byBucket.traces).toBe(0);
    // With the $19 fee and 12 billed users at $8: 522.50 + 19 + 96 = $637.50.
    expect(estimate.monthly).toBeCloseTo(637.5, 6);
  });

  it("matches Grafana's calculator for traces alone: 1,296 GB is $676.42", () => {
    // 500 spans a second x 2,592,000 s x 1,000 bytes = 1,296 GB.
    // Pricing-page calculator, Traces, 1,296 GB, Adaptive reduction 0%: $676.42.
    //   Process  (1,296 - 50 included) x $0.05           = $62.30
    //   Write    950 x $0.40 + 296 x $0.37 = 380 + 109.52 = $489.52
    //   Retain   1,246 x $0.10                            = $124.60
    const w = base();
    w.traces = { ...w.traces, spansPerSecond: 500, avgSpanBytes: 1000, retentionDays: 30 };
    const estimate = estimateVendor(grafanaCloud, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    expect(billedAt(estimate, "traces-process")).toBeCloseTo(62.3, 6);
    expect(billedAt(estimate, "traces-write")).toBeCloseTo(489.52, 6);
    expect(billedAt(estimate, "traces-retain")).toBeCloseTo(124.6, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(676.42, 6);
    expect(estimate.byBucket.logs).toBe(0);
    expect(estimate.byBucket.metrics).toBe(0);
  });

  it("crosses the volume bands on each log meter: 9,900 GB", () => {
    // The mid preset's 330 GB a day is 9,900 GB a month.
    //   Process  one band:    (9,900 - 50) x $0.05                  = $492.50
    //   Write    three bands: 950 x $0.40 + 1,500 x $0.37 + 7,400 x $0.355
    //                         = 380 + 555 + 2,627                   = $3,562.00
    //   Retain   two bands:   4,950 x $0.10 + 4,900 x $0.092
    //                         = 495 + 450.80                        = $945.80
    //   total                                                         $5,000.30
    // Grafana's calculator shows $5,000.30 for the same input.
    const estimate = estimateVendor(grafanaCloud, onlySignals(base(), ["logs"]), DEFAULT_SETTINGS);
    expect(billedAt(estimate, "logs-process")).toBeCloseTo(492.5, 6);
    expect(billedAt(estimate, "logs-write")).toBeCloseTo(3562, 6);
    expect(billedAt(estimate, "logs-retain")).toBeCloseTo(945.8, 6);
    expect(estimate.byBucket.logs).toBeCloseTo(5000.3, 6);

    expect(lineAt(estimate, "logs-process-2")).toBeUndefined();
    expect(lineAt(estimate, "logs-write-1")?.quantity).toBeCloseTo(950, 6);
    expect(lineAt(estimate, "logs-write-2")?.quantity).toBeCloseTo(1500, 6);
    expect(lineAt(estimate, "logs-write-3")?.quantity).toBeCloseTo(7400, 6);
    expect(lineAt(estimate, "logs-retain-2")?.quantity).toBeCloseTo(4900, 6);
    expect(lineAt(estimate, "logs-retain-3")).toBeUndefined();
  });

  it("prices 100 GB of logs a day alone at 30-day retention: $1,574", () => {
    // 100 GB/day x 30 days = 3,000 GB, with 3 users so no seats are billed.
    //   Process  (3,000 - 50) x $0.05                                = $147.50
    //   Write    950 x $0.40 + 1,500 x $0.37 + 500 x $0.355
    //            = 380 + 555 + 177.50                                 = $1,112.50
    //   Retain   (3,000 - 50) x $0.10                                = $295.00
    //   logs                                                           $1,555.00
    //   platform fee                                                   $19.00
    //   total                                                          $1,574.00
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };
    w.users = 3;
    const estimate = estimateVendor(grafanaCloud, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(billedAt(estimate, "logs-process")).toBeCloseTo(147.5, 6);
    expect(billedAt(estimate, "logs-write")).toBeCloseTo(1112.5, 6);
    expect(billedAt(estimate, "logs-retain")).toBeCloseTo(295, 6);
    expect(estimate.byBucket.logs).toBeCloseTo(1555, 6);
    expect(estimate.monthly).toBeCloseTo(1574, 6);
    expect(estimate.shortRetention).toEqual([]);
    expect(estimate.complete).toBe(true);
  });

  it("charges only the platform fee while usage is inside the included amounts", () => {
    // 50 GB of logs, 50 GB of traces, 10,000 series and 3 users are all
    // included, so the bill is the $19 fee. The calculator shows $0.00 for
    // 50 GB of logs, for 10,000 series and for 3 users.
    const w = base();
    w.logs.gbPerDay = 50 / 30;
    // 50 GB at 1,000 bytes a span is 5e7 spans over 2,592,000 seconds.
    w.traces = { ...w.traces, spansPerSecond: 5e7 / 2_592_000, avgSpanBytes: 1000 };
    w.metrics = { ...w.metrics, activeSeries: 10_000, intervalSeconds: 60 };
    w.users = 3;
    const included = estimateVendor(grafanaCloud, w, DEFAULT_SETTINGS);
    expect(included.byBucket.logs).toBe(0);
    expect(included.byBucket.traces).toBe(0);
    expect(included.byBucket.metrics).toBe(0);
    expect(included.monthly).toBeCloseTo(19, 6);

    // One more GB of logs pays all three meters once: $0.05 + $0.40 + $0.10
    // = $0.55, the calculator's figure for 51 GB.
    w.logs.gbPerDay = 51 / 30;
    const oneOver = estimateVendor(grafanaCloud, w, DEFAULT_SETTINGS);
    expect(oneOver.byBucket.logs).toBeCloseTo(0.55, 6);
    expect(oneOver.monthly).toBeCloseTo(19.55, 6);
  });

  it("bills active users in bands above the 3 included", () => {
    // Pricing-page calculator, Grafana Visualization, 60 active users: $425.25.
    //   users 4 to 25   22 x $8.00 = $176.00
    //   users 26 to 50  25 x $7.25 = $181.25
    //   users 51 to 60  10 x $6.80 = $68.00
    const w = base();
    w.users = 60;
    const estimate = estimateVendor(grafanaCloud, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(billedAt(estimate, "users")).toBeCloseTo(425.25, 6);
    // Plus the $19 fee.
    expect(estimate.byBucket.platform).toBeCloseTo(444.25, 6);
  });

  it("prices the whole mid preset with the default settings: $9,221.75", () => {
    // Logs, 330 GB/day x 30 = 9,900 GB: $5,000.30 (worked above).
    // Traces, 2,000 spans/s x 2,592,000 s x 1,000 bytes = 5,184 GB:
    //   Process  (5,184 - 50) x $0.05                              = $256.70
    //   Write    950 x $0.40 + 1,500 x $0.37 + 2,684 x $0.355
    //            = 380 + 555 + 952.82                               = $1,887.82
    //   Retain   4,950 x $0.10 + 184 x $0.092 = 495 + 16.928        = $511.928
    //   total                                                         $2,656.448
    // Metrics, 250,000 series at 60 s (1 data point a minute, the included rate):
    //   90 x $6.50 + 100 x $5.90 + 50 x $5.50 = 585 + 590 + 275    = $1,450.00
    //   (the calculator shows $1,450.00 for 250,000 series)
    // Platform: $19 + (15 - 3) x $8                                 = $115.00
    // Total: 5,000.30 + 2,656.448 + 1,450 + 115                     = $9,221.748
    // No host fees: the 200 hosts do not appear on the bill.
    const estimate = estimateVendor(grafanaCloud, base(), DEFAULT_SETTINGS);
    expect(estimate.byBucket.logs).toBeCloseTo(5000.3, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(2656.448, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(1450, 6);
    expect(estimate.byBucket.platform).toBeCloseTo(115, 6);
    expect(estimate.monthly).toBeCloseTo(9221.748, 6);
    expect(estimate.complete).toBe(true);
    // 30 days of logs and traces and 13 months of metrics are what Pro keeps.
    expect(estimate.shortRetention).toEqual([]);

    // Grafana's docs word Retain as a charge only past the included 30 days,
    // where its calculator bills it from the first GB. The estimate says what
    // that reading would take off: the two Retain amounts above,
    // 945.80 + 511.928 = $1,457.728, shown as $1,458.
    expect(estimate.assumptions.join(" ")).toContain("$1,458 a month lower");
  });

  it("prices the small preset, which stays in the calculator's first two Write bands", () => {
    // Logs, 80 GB/day = 2,400 GB (calculator: $1,250.50):
    //   Process 2,350 x $0.05 = 117.50, Write 950 x $0.40 + 1,400 x $0.37 = 898.00,
    //   Retain 2,350 x $0.10 = 235.00.
    // Traces, 400 spans/s = 1,036.8 GB:
    //   Process 986.8 x $0.05 = 49.34, Write 950 x $0.40 + 36.8 x $0.37 = 393.616,
    //   Retain 986.8 x $0.10 = 98.68. Total 541.636.
    // Metrics, 75,000 series at 60 s: 65 x $6.50 = 422.50 (calculator: $422.50).
    // Platform: $19 + (5 - 3) x $8 = 35.00 (calculator, 5 users: $16.00).
    // Total: 1,250.50 + 541.636 + 422.50 + 35 = $2,249.636
    const estimate = estimateVendor(grafanaCloud, preset("small"), DEFAULT_SETTINGS);
    expect(estimate.byBucket.logs).toBeCloseTo(1250.5, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(541.636, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(422.5, 6);
    expect(estimate.byBucket.platform).toBeCloseTo(35, 6);
    expect(estimate.monthly).toBeCloseTo(2249.636, 6);
  });

  it("reaches the third band on every meter at the large preset", () => {
    // Logs, 2,000 GB/day = 60,000 GB:
    //   Process 9,950 x 0.05 + 15,000 x 0.046 + 35,000 x 0.044
    //           = 497.50 + 690 + 1,540                          = 2,727.50
    //   Write   950 x 0.40 + 1,500 x 0.37 + 57,500 x 0.355
    //           = 380 + 555 + 20,412.50                         = 21,347.50
    //   Retain  4,950 x 0.10 + 7,500 x 0.092 + 47,500 x 0.088
    //           = 495 + 690 + 4,180                             = 5,365.00
    //   total                                                     29,440.00
    // Traces, 15,000 spans/s x 2,592,000 s x 1,000 bytes = 38,880 GB:
    //   Process 497.50 + 690 + 13,880 x 0.044 (610.72)          = 1,798.22
    //   Write   380 + 555 + 36,380 x 0.355 (12,914.90)          = 13,849.90
    //   Retain  495 + 690 + 26,380 x 0.088 (2,321.44)           = 3,506.44
    //   total                                                     19,154.56
    // Metrics, 2,000,000 series at 60 s:
    //   585 + 590 + 1,800 x 5.50 (9,900)                        = 11,075.00
    //   (the calculator shows $11,075.00 for 2,000,000 series)
    // Platform: $19 + 22 x $8 + 25 x $7.25 = 19 + 176 + 181.25  = 376.25
    // Total: 29,440 + 19,154.56 + 11,075 + 376.25                = $60,045.81
    // The calculator shows $29,440.00 for 60,000 GB of logs.
    const estimate = estimateVendor(grafanaCloud, preset("large"), DEFAULT_SETTINGS);
    expect(estimate.byBucket.logs).toBeCloseTo(29440, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(19154.56, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(11075, 6);
    expect(estimate.byBucket.platform).toBeCloseTo(376.25, 6);
    expect(estimate.monthly).toBeCloseTo(60045.81, 6);
  });

  it("bills longer retention as extra 30-day increments of the Retain rate", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 1000 / 30, retentionDays: 90 };
    // 90 days is 3 increments: 1,000 GB x 3 = 3,000 GB on the Retain meter.
    //   Retain (3,000 - 50) x $0.10 = $295.00, Process $47.50, Write $380.00
    //   total $722.50
    const ninety = estimateVendor(grafanaCloud, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(billedAt(ninety, "logs-retain")).toBeCloseTo(295, 6);
    expect(ninety.byBucket.logs).toBeCloseTo(722.5, 6);
    expect(ninety.assumptions.join(" ")).toContain("3 30-day increments");
    // Under the docs' wording one increment fewer is billed: 2,000 GB on the
    // meter, (2,000 - 50) x $0.10 = $195, which is $100 less.
    expect(ninety.assumptions.join(" ")).toContain("$100 a month lower");

    // 45 days rounds up to 2 increments (60 days):
    //   Retain (2,000 - 50) x $0.10 = $195.00, total 47.50 + 380 + 195 = $622.50
    w.logs.retentionDays = 45;
    const fortyFive = estimateVendor(grafanaCloud, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(fortyFive.byBucket.logs).toBeCloseTo(622.5, 6);
    expect(fortyFive.assumptions.join(" ")).toContain("priced as 60 days");
    // The price buys 60 days, longer than asked: reported, not marked short.
    expect(fortyFive.shortRetention).toEqual([]);

    // 7 days is still the 30-day minimum of a paid plan: $522.50.
    w.logs.retentionDays = 7;
    const seven = estimateVendor(grafanaCloud, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(seven.byBucket.logs).toBeCloseTo(522.5, 6);
    expect(seven.assumptions.join(" ")).toContain("at least 30 days");

    // The Retain bands apply to the whole retained quantity. 9,900 GB kept 60
    // days is 19,800 GB on the meter:
    //   4,950 x $0.10 + 7,500 x $0.092 + 7,300 x $0.088 = 495 + 690 + 642.40 = $1,827.40
    const mid = base();
    mid.logs.retentionDays = 60;
    const sixty = estimateVendor(grafanaCloud, onlySignals(mid, ["logs"]), DEFAULT_SETTINGS);
    expect(billedAt(sixty, "logs-retain")).toBeCloseTo(1827.4, 6);
  });

  it("prices 13 months of metrics whatever retention is asked for", () => {
    const w = base();
    w.metrics.retentionMonths = 24;
    const longer = estimateVendor(grafanaCloud, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    // 250,000 series: $1,450, the same as at 13 months.
    expect(longer.byBucket.metrics).toBeCloseTo(1450, 6);
    // Kept 13 months, shorter than asked: reported first and marked on the row.
    expect(longer.assumptions[0]).toContain("kept 13 months, shorter than the 24 months");
    expect(longer.shortRetention).toEqual([
      { signal: "metrics", asked: 24, kept: 13, unit: "months" },
    ]);
  });

  it("charges the platform fee and seats once under split routing, and nothing for a signal sent elsewhere", () => {
    // Logs only: $5,000.30 of logs + $19 + $96 of users = $5,115.30.
    const logsOnly = estimateVendor(grafanaCloud, onlySignals(base(), ["logs"]), DEFAULT_SETTINGS);
    expect(logsOnly.byBucket.metrics).toBe(0);
    expect(logsOnly.byBucket.traces).toBe(0);
    expect(logsOnly.byBucket.platform).toBeCloseTo(115, 6);
    expect(logsOnly.monthly).toBeCloseTo(5115.3, 6);

    // Metrics and traces: $1,450 + $2,656.448 + $115 = $4,221.448.
    const rest = estimateVendor(
      grafanaCloud,
      onlySignals(base(), ["metrics", "traces"]),
      DEFAULT_SETTINGS,
    );
    expect(rest.byBucket.logs).toBe(0);
    expect(rest.byBucket.platform).toBeCloseTo(115, 6);
    expect(rest.monthly).toBeCloseTo(4221.448, 6);
  });

  it("adds no host-hour fees: the host count does not move the bill", () => {
    const w = base();
    const few = estimateVendor(grafanaCloud, w, DEFAULT_SETTINGS);
    w.infra = { ...w.infra, hosts: 5000, containersPerHost: 40, tracedHostShare: 1 };
    const many = estimateVendor(grafanaCloud, w, DEFAULT_SETTINGS);
    expect(many.monthly).toBeCloseTo(few.monthly, 6);
    expect(many.lines.some((l) => /host|container/i.test(`${l.label} ${l.unit}`))).toBe(false);
    expect(many.assumptions.join(" ")).toContain(
      "No Kubernetes Monitoring or Application Observability fees",
    );
  });

  it("gives one price for both terms and both regions", () => {
    const typical: Settings[] = [
      { term: "annual", region: "us", queryLoad: "typical" },
      { term: "monthly", region: "us", queryLoad: "typical" },
      { term: "annual", region: "eu", queryLoad: "typical" },
    ];
    for (const s of typical) {
      expect(estimateVendor(grafanaCloud, base(), s).monthly).toBeCloseTo(9221.748, 6);
    }
  });

  it("leaves query usage past the fair-use allowance unpriced", () => {
    // Metrics: 20 billion query units per 1,000 billable series, at 10 units
    // per data point read, is 2,000,000 reads per series a month. A series at
    // 60 s has 43,200 data points a month, so the allowance covers
    // 2,000,000 / 43,200 = 46.3 reads of each. The typical query load makes
    // 20 and stays inside it. The heavy load makes 100 and passes it, and the
    // rate for the excess is not published.
    const heavy: Settings = { ...DEFAULT_SETTINGS, queryLoad: "heavy" };
    const typical = estimateVendor(grafanaCloud, base(), DEFAULT_SETTINGS);
    expect(typical.complete).toBe(true);

    const over = estimateVendor(grafanaCloud, base(), heavy);
    expect(over.complete).toBe(false);
    expect(over.unpriced.map((u) => u.bucket)).toEqual(["metrics"]);
    // Nothing is guessed for the excess: the priced lines are unchanged.
    expect(over.monthly).toBeCloseTo(9221.748, 6);

    // Logs: queries are free up to 100 times the GB written, and the heavy
    // load scans 100 times, so logs alone stay complete.
    const logsOnly = estimateVendor(grafanaCloud, onlySignals(base(), ["logs"]), heavy);
    expect(logsOnly.complete).toBe(true);

    // At a 300 s export interval a series has 8,640 data points a month, the
    // allowance covers 2,000,000 / 8,640 = 231 reads of each, and the heavy
    // load fits.
    const slow = base();
    slow.metrics.intervalSeconds = 300;
    const slowHeavy = estimateVendor(grafanaCloud, onlySignals(slow, ["metrics"]), heavy);
    expect(slowHeavy.complete).toBe(true);
  });
});

describe("Grafana Cloud: profiles", () => {
  it("bills profiles on the three GB meters, less 50 GB included", () => {
    // Mid preset, profiling on: 100 profiled hosts × 40 samples/s × 2,592,000 s = 10.368B samples
    // × 100 bytes = 1,036.8 GB, less 50 included = 986.8 GB on each meter:
    //   986.8 × ($0.05 + $0.40 + $0.10) = $542.74
    // plus the $19 platform fee and 12 users above the 3 included at $8 = $96.
    const w = base();
    w.send.profiles = true;
    const estimate = estimateVendor(grafanaCloud, onlySignals(w, ["profiles"]), DEFAULT_SETTINGS);
    expect(estimate.byBucket.profiles).toBeCloseTo(542.74, 6);
    expect(estimate.byBucket.platform).toBeCloseTo(19 + 96, 6);
    expect(estimate.complete).toBe(true);
  });
});
