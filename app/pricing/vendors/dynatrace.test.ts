import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import type { Settings, VendorEstimate, Workload } from "../types";
import { derive } from "../units";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { dynatrace } from "./dynatrace";

const base = (): Workload => structuredClone(presetById("mid")!.workload);

/** Decimal GB in one binary GiB (2^30 / 10^9 = 1.073741824), to write inputs in the unit Dynatrace bills. */
const GB_PER_GIB = 2 ** 30 / 1e9;

const HEAVY: Settings = { ...DEFAULT_SETTINGS, queryLoad: "heavy" };

/** The summed amount of the lines billed at one rate (0 when there is none). */
const amountAt = (estimate: VendorEstimate, rateId: string): number =>
  estimate.lines.filter((l) => l.rateId === rateId).reduce((sum, l) => sum + l.amount, 0);

/** Logs and nothing else: 100 GiB a day unless another volume is given. */
function logsOnly(retentionDays: number, gibPerDay = 100): Workload {
  const w = base();
  w.logs = { ...w.logs, gbPerDay: gibPerDay * GB_PER_GIB, retentionDays };
  return onlySignals(w, ["logs"]);
}

/** 1,000 spans a second of 2^30 / 10^6 bytes each: 2,592 GiB a month, 86.4 GiB a day. */
function tracesOnly(retentionDays: number): Workload {
  const w = base();
  w.traces = { ...w.traces, spansPerSecond: 1000, avgSpanBytes: 1000 * GB_PER_GIB, retentionDays };
  return onlySignals(w, ["traces"]);
}

describe("Dynatrace: worked examples", () => {
  it("matches the vendor's metrics example: 55M data points a day is $2,475", () => {
    // docs.dynatrace.com, metrics billing docs, "Estimate your Ingest & Process cost":
    //   55 million data points/day × 30 days = 1.65 billion data points/month
    //   1.65 billion / 100,000 × $0.15 = $2,475 per month
    // 55M a day is 55,000,000 / 1,440 = 38,194.44 series reporting once a minute.
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: 55_000_000 / 1440, intervalSeconds: 60, retentionMonths: 15 };
    const estimate = estimateVendor(dynatrace, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(amountAt(estimate, "metrics-ingest")).toBeCloseTo(2475, 6);
    expect(amountAt(estimate, "metrics-retain")).toBe(0);
    expect(estimate.monthly).toBeCloseTo(2475, 6);
  });

  it("matches the vendor's retention example: five years of those metrics adds $884", () => {
    // Same page, "Estimate your Retain cost". Each data point adds about 600 bytes:
    //   55M × 600 bytes = 33 GB = 30.73 GiB a day
    //   1,832 - 462 days = 1,370 billable retention days
    //   30.73 GiB/day × 1,370 days = 42,100.1 GiB retained at full retention
    //   42,100.1 GiB × 30 days = 1,263,003 GiB-days per month
    //   1,263,003 × $0.0007 = $884.10 per month
    // Dynatrace rounds the daily volume to 30.73 GiB before multiplying. Unrounded
    // (33 × 10^9 / 2^30 = 30.7336 GiB) the same sum is $884.21.
    const w = base();
    w.metrics = {
      ...w.metrics,
      activeSeries: 55_000_000 / 1440,
      intervalSeconds: 60,
      retentionMonths: 1832 / 30,
    };
    const estimate = estimateVendor(dynatrace, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    const retain = amountAt(estimate, "metrics-retain");
    expect(retain).toBeCloseTo(884.21, 2);
    expect(Math.abs(retain - 884.1)).toBeLessThan(0.15);
    expect(estimate.monthly).toBeCloseTo(2475 + 884.21, 2);
  });

  it("bills one data point a minute per series, however often it reports", () => {
    // Metrics billing docs: metrics collected more often than once a minute are
    // aggregated into one-minute buckets, and only stored data points are counted.
    // 1,000,000 series × 43,200 minutes = 43.2B data points = 432,000 × 100k
    // 432,000 × $0.15 = $64,800, whether the series report every 15 s or every 60 s.
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: 1_000_000, intervalSeconds: 15, retentionMonths: 13 };
    const every15s = estimateVendor(dynatrace, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(every15s.monthly).toBeCloseTo(64_800, 6);
    expect(every15s.assumptions.join(" ")).toContain("one-minute buckets");

    w.metrics.intervalSeconds = 60;
    const every60s = estimateVendor(dynatrace, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(every60s.monthly).toBeCloseTo(64_800, 6);

    // Every 120 s is half a data point a minute: 21.6B data points, 216,000 × $0.15 = $32,400.
    w.metrics.intervalSeconds = 120;
    const every120s = estimateVendor(dynatrace, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(every120s.monthly).toBeCloseTo(32_400, 6);
  });

  it("starts charging metric retention only past the 462 days included", () => {
    // 100,000 series × 43,200 minutes = 4.32B data points = 43,200 × 100k × $0.15 = $6,480
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: 100_000, intervalSeconds: 60, retentionMonths: 15 };
    const included = estimateVendor(dynatrace, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    // 15 months × 30 days = 450 days, inside the 462 included.
    expect(included.monthly).toBeCloseTo(6480, 6);

    // 16 months × 30 days = 480 days, 18 past the 462 included.
    // 144M data points/day × 600 bytes = 86.4 GB = 80.47 GiB a day
    // 80.47 GiB/day × 18 days = 1,448.39 GiB held; × 30 days = 43,451.79 GiB-days
    // 43,451.79 × $0.0007 = $30.42
    w.metrics.retentionMonths = 16;
    const extended = estimateVendor(dynatrace, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    const gibPerDay = (144e6 * 600) / 2 ** 30;
    expect(amountAt(extended, "metrics-ingest")).toBeCloseTo(6480, 6);
    expect(amountAt(extended, "metrics-retain")).toBeCloseTo(gibPerDay * 18 * 30 * 0.0007, 6);
    expect(amountAt(extended, "metrics-retain")).toBeCloseTo(30.42, 1);
  });

  it("prices logs alone: ingest, retention and queries", () => {
    // 100 GiB a day (107.37 GB), kept 30 days, typical query load (20x).
    // Retained and scanned logs are billed at the size sent: the docs' "factor of 2 or more"
    // after processing is a caution with no fixed factor, so it is not applied.
    // Ingest: 100 GiB/day × 30 days = 3,000 GiB × $0.20 = $600
    // Retain: 100 GiB/day × 30 days kept = 3,000 GiB held
    //         3,000 GiB × 30 days = 90,000 GiB-days × $0.0007 = $63
    // Query:  3,000 GiB × 20 = 60,000 GiB scanned × $0.0035 = $210
    const estimate = estimateVendor(dynatrace, logsOnly(30), DEFAULT_SETTINGS);
    expect(amountAt(estimate, "logs-ingest")).toBeCloseTo(600, 6);
    expect(amountAt(estimate, "logs-retain")).toBeCloseTo(63, 6);
    expect(amountAt(estimate, "logs-query")).toBeCloseTo(210, 6);
    expect(amountAt(estimate, "logs-retain-with-queries")).toBe(0);
    expect(estimate.byBucket.logs).toBeCloseTo(873, 6);
    expect(estimate.monthly).toBeCloseTo(873, 6);
    expect(estimate.shortRetention).toEqual([]);

    // A light query load scans the month 5 times over: 3,000 × 5 = 15,000 GiB × $0.0035 = $52.50.
    const light = estimateVendor(dynatrace, logsOnly(30), { ...DEFAULT_SETTINGS, queryLoad: "light" });
    expect(amountAt(light, "logs-query")).toBeCloseTo(52.5, 6);
    expect(light.monthly).toBeCloseTo(600 + 63 + 52.5, 6);
  });

  it("follows the vendor's retention arithmetic: 9 GiB a day kept 35 days is $6.62", () => {
    // The metrics billing docs' "Estimate your Retain cost" uses GiB/day × days kept × 30
    // days × $0.0007, the same GiB-day arithmetic and price as the log Retain meter:
    //   9 GiB/day × 35 days = 315 GiB retained at full retention
    //   315 GiB × 30 days = 9,450 GiB-days per month
    //   9,450 GiB-days × $0.0007 = $6.615 per month
    const estimate = estimateVendor(dynatrace, logsOnly(35, 9), DEFAULT_SETTINGS);
    expect(amountAt(estimate, "logs-retain")).toBeCloseTo(6.615, 6);
  });

  it("worked example: 100 GB of logs a day kept 30 days is $813.04", () => {
    // From the rate card only, typical query load (20x), annual, US.
    // 100 GB/day × 30 days = 3,000 GB = 3,000 × 10^9 / 2^30 = 2,793.9677 GiB
    // Ingest: 2,793.9677 GiB × $0.20                                     = $558.7935
    // Retain: 2,793.9677 GiB held × 30 days = 83,819.03 GiB-days × $0.0007 = $58.6733
    // Query:  2,793.9677 GiB × 20 = 55,879.35 GiB scanned × $0.0035     = $195.5777
    // Retain with Included Queries would be 83,819.03 × $0.02 = $1,676.38, so it is not used.
    // Total: $558.7935 + $58.6733 + $195.5777 = $813.0446
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };
    const estimate = estimateVendor(dynatrace, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(amountAt(estimate, "logs-ingest")).toBeCloseTo(558.7935, 3);
    expect(amountAt(estimate, "logs-retain")).toBeCloseTo(58.6733, 3);
    expect(amountAt(estimate, "logs-query")).toBeCloseTo(195.5777, 3);
    expect(amountAt(estimate, "logs-retain-with-queries")).toBe(0);
    expect(estimate.monthly).toBeCloseTo(813.0446, 3);
    expect(estimate.monthly).toBeCloseTo(873 / GB_PER_GIB, 6);
  });

  it("worked example: the mid preset at default settings is $20,254.19", () => {
    // mid: 330 GB/day of logs kept 30 days, 250,000 series every 60 s kept 13 months,
    // 2,000 spans/s × 1,000 bytes kept 30 days. Annual, US, typical query load (20x).
    // Logs:    330 GB × 30 = 9,900 GB = 9,220.0935 GiB
    //          ingest 9,220.0935 × $0.20                                        = $1,844.0187
    //          retain 9,220.0935 GiB held × 30 = 276,602.80 GiB-days × $0.0007  = $193.6220
    //          query  9,220.0935 × 20 = 184,401.87 GiB × $0.0035                = $645.4065
    //          logs total                                                      = $2,683.0472
    // Metrics: 250,000 × 43,200 minutes = 10.8B data points = 108,000 × 100k × $0.15 = $16,200
    //          13 months (390 days) is inside the 462 included days: no retain line.
    //          All 250,000 series are billed (62,500 host series included): no host fee or
    //          host allowance on the OTLP-only path.
    // Traces:  2,000 × 2,592,000 s × 1,000 bytes = 5,184 GB = 4,827.9764 GiB
    //          ingest 4,827.9764 × $0.20                                        = $965.5953
    //          retain 160.9325 GiB/day × 20 days past 10 = 3,218.65 GiB × 30 = 96,559.53
    //                 GiB-days × $0.0007                                       = $67.5917
    //          query  4,827.9764 × 20 = 96,559.53 GiB × $0.0035                 = $337.9583
    //          traces total                                                    = $1,371.1453
    // Total: $2,683.0472 + $16,200 + $1,371.1453 = $20,254.1925
    const estimate = estimateVendor(dynatrace, base(), DEFAULT_SETTINGS);
    expect(estimate.byBucket.logs).toBeCloseTo(2683.0472, 3);
    expect(estimate.byBucket.metrics).toBeCloseTo(16_200, 6);
    expect(amountAt(estimate, "metrics-retain")).toBe(0);
    expect(estimate.byBucket.traces).toBeCloseTo(1371.1453, 3);
    expect(estimate.byBucket.platform).toBe(0);
    expect(estimate.monthly).toBeCloseTo(20_254.1925, 3);
    expect(estimate.complete).toBe(true);
    expect(estimate.shortRetention).toEqual([]);
  });

  it("switches logs to Retain with Included Queries when that costs less", () => {
    // Heavy query load (100x), 100 GiB a day. Ingest is $600 either way.
    // Separate meters, 18 days: 100 × 18 = 1,800 GiB held × 30 = 54,000 GiB-days
    //   54,000 × $0.0007 = $37.80, plus 3,000 × 100 = 300,000 GiB scanned × $0.0035 = $1,050
    //   = $1,087.80
    // Included queries, 18 days: 54,000 GiB-days × $0.02 = $1,080, which is less.
    // The allowance holds: 100 scans a month ≤ 15 a day × 18 days.
    const at18 = estimateVendor(dynatrace, logsOnly(18), HEAVY);
    expect(amountAt(at18, "logs-retain-with-queries")).toBeCloseTo(1080, 6);
    expect(amountAt(at18, "logs-retain")).toBe(0);
    expect(amountAt(at18, "logs-query")).toBe(0);
    expect(at18.monthly).toBeCloseTo(600 + 1080, 6);
    expect(at18.assumptions.join(" ")).toContain("Retain with Included Queries");

    // 19 days: 57,000 GiB-days. Separate: $39.90 + $1,050 = $1,089.90.
    // Included queries: 57,000 × $0.02 = $1,140, which is more.
    const at19 = estimateVendor(dynatrace, logsOnly(19), HEAVY);
    expect(amountAt(at19, "logs-retain")).toBeCloseTo(39.9, 6);
    expect(amountAt(at19, "logs-query")).toBeCloseTo(1050, 6);
    expect(amountAt(at19, "logs-retain-with-queries")).toBe(0);
    expect(at19.monthly).toBeCloseTo(600 + 39.9 + 1050, 6);
  });

  it("prices the 10-day minimum window when included queries cover a shorter ask", () => {
    // Heavy query load, 7 days asked. Separate: 100 × 7 = 700 GiB held × 30 = 21,000
    //   GiB-days × $0.0007 = $14.70, plus $1,050 of queries = $1,064.70.
    // Included queries need a window of at least 10 days: 100 × 10 = 1,000 GiB held
    //   × 30 = 30,000 GiB-days × $0.02 = $600, which is less.
    const w = logsOnly(7);
    const estimate = estimateVendor(dynatrace, w, HEAVY);
    expect(amountAt(estimate, "logs-retain-with-queries")).toBeCloseTo(600, 6);
    expect(estimate.monthly).toBeCloseTo(600 + 600, 6);
    expect(estimate.assumptions.join(" ")).toContain("at least 10 days");
    // The price buys 10 days for the 7 asked: reported in kept, and not a shortfall.
    expect(dynatrace.price({ w, d: derive(w), s: HEAVY }).kept?.logsDays).toBe(10);
    expect(estimate.shortRetention).toEqual([]);

    // Past the 35-day window the separate meters apply. 60 days, heavy:
    //   100 × 60 = 6,000 GiB held × 30 = 180,000 GiB-days × $0.0007 = $126, plus $1,050.
    const at60 = estimateVendor(dynatrace, logsOnly(60), HEAVY);
    expect(amountAt(at60, "logs-retain-with-queries")).toBe(0);
    expect(at60.monthly).toBeCloseTo(600 + 126 + 1050, 6);
  });

  it("reports retention past 10 years as kept for 10 years", () => {
    const estimate = estimateVendor(dynatrace, logsOnly(4000), DEFAULT_SETTINGS);
    expect(estimate.shortRetention).toEqual([{ signal: "logs", asked: 4000, kept: 3650, unit: "days" }]);
    expect(estimate.assumptions[0]).toContain("10 years");
  });

  it("reports the included metric and trace retention when less is asked", () => {
    const w = base();
    w.traces.retentionDays = 7;
    const out = dynatrace.price({ w, d: derive(w), s: DEFAULT_SETTINGS });
    expect(out.kept?.metricsMonths).toBe(15);
    expect(out.kept?.tracesDays).toBe(10);
  });

  it("prices traces alone, with 10 days of retention included", () => {
    // 1,000 spans/s × 2,592,000 s = 2.592B spans × 1,073.74 bytes = 2,592 GiB (86.4 GiB a day)
    // Ingest: 2,592 GiB × $0.20 = $518.40
    // Retain: 30 days asked, 10 included, 20 billable. 86.4 GiB/day × 20 days = 1,728 GiB held
    //         1,728 GiB × 30 days = 51,840 GiB-days × $0.0007 = $36.288
    // Query:  2,592 GiB × 20 = 51,840 GiB scanned × $0.0035 = $181.44
    const estimate = estimateVendor(dynatrace, tracesOnly(30), DEFAULT_SETTINGS);
    expect(amountAt(estimate, "traces-ingest")).toBeCloseTo(518.4, 6);
    expect(amountAt(estimate, "traces-retain")).toBeCloseTo(36.288, 6);
    expect(amountAt(estimate, "traces-query")).toBeCloseTo(181.44, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(736.128, 6);
    expect(estimate.monthly).toBeCloseTo(736.128, 6);
  });

  it("starts charging trace retention on day 11", () => {
    // 10 days asked: all of it is included, so only ingest and queries are billed.
    const at10 = estimateVendor(dynatrace, tracesOnly(10), DEFAULT_SETTINGS);
    expect(amountAt(at10, "traces-retain")).toBe(0);
    expect(at10.monthly).toBeCloseTo(518.4 + 181.44, 6);

    // 11 days asked: one billable day. 86.4 GiB held × 30 days = 2,592 GiB-days × $0.0007 = $1.8144
    const at11 = estimateVendor(dynatrace, tracesOnly(11), DEFAULT_SETTINGS);
    expect(amountAt(at11, "traces-retain")).toBeCloseTo(1.8144, 6);
    expect(at11.monthly).toBeCloseTo(518.4 + 1.8144 + 181.44, 6);
  });

  it("charges no host, seat or platform fee on the OTLP path", () => {
    const w = base();
    const few = estimateVendor(dynatrace, w, DEFAULT_SETTINGS);
    const many = estimateVendor(
      dynatrace,
      { ...w, infra: { ...w.infra, hosts: 5000, memoryGibPerHost: 256 }, users: 500 },
      DEFAULT_SETTINGS,
    );
    expect(many.monthly).toBeCloseTo(few.monthly, 6);
    expect(few.byBucket.platform).toBe(0);
    expect(few.complete).toBe(true);
  });

  it("gives one rate-card price for both billing terms and both regions", () => {
    const w = base();
    const annual = estimateVendor(dynatrace, w, DEFAULT_SETTINGS);
    const monthly = estimateVendor(dynatrace, w, { ...DEFAULT_SETTINGS, term: "monthly" });
    const eu = estimateVendor(dynatrace, w, { ...DEFAULT_SETTINGS, region: "eu" });
    expect(monthly.monthly).toBeCloseTo(annual.monthly, 6);
    expect(eu.monthly).toBeCloseTo(annual.monthly, 6);
  });
});
