import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals, scaleWorkload } from "../engine";
import type { Settings, VendorEstimate, Workload } from "../types";
import { DEFAULT_SETTINGS, PRESETS, presetById } from "../workloads";
import { elastic } from "./elastic";

const base = (): Workload => structuredClone(presetById("mid")!.workload);
const EU: Settings = { ...DEFAULT_SETTINGS, region: "eu" };

/** How far a figure is from the one the vendor publishes, as a fraction. */
const off = (ours: number, theirs: number) => Math.abs(ours - theirs) / theirs;

/** The sum of the lines whose label contains `text`. */
const sumOf = (estimate: VendorEstimate, text: string) =>
  estimate.lines.filter((l) => l.label.includes(text)).reduce((sum, l) => sum + l.amount, 0);

/**
 * Elastic's estimator works on a 365/12-day month. Scaling a workload by this
 * factor gives the 30-day adapter the volumes the estimator bills for the
 * unscaled inputs, so its output can be compared to the cent.
 */
const ESTIMATOR_MONTH = 365 / 12 / 30;
const atEstimatorMonth = (w: Workload) => scaleWorkload(w, ESTIMATOR_MONTH);
const cents = (n: number) => n.toFixed(2);

/**
 * Rates used below are the Observability Complete tiers for AWS us-east-1 on
 * cloud.elastic.co/cloud-pricing-table (read 2026-11-12):
 *   ingest, logs and traces    $0.50 to 1,500 GB, $0.325 to 3,000, $0.225 to 6,000,
 *                              $0.15 to 15,000, $0.105 to 30,000, $0.10 to 60,000,
 *                              $0.095 to 150,000, $0.0925 above
 *   retention, logs and traces $0.04 to 10,000 GB, $0.032 to 20,000, $0.03 to 50,000,
 *                              $0.028 to 100,000, $0.026 to 250,000, $0.022 to 1,000,000
 *   ingest, metrics            $0.125 to 1,500 GB, $0.0813 to 3,000, $0.0563 to 6,000,
 *                              $0.0375 to 15,000, $0.0263 to 30,000, $0.025 to 60,000
 *   retention, metrics         $0.01 to 10,000 GB, $0.008 to 20,000, $0.0075 to 50,000,
 *                              $0.007 to 100,000, $0.0065 to 250,000, $0.0055 to 1,000,000
 * Elastic's estimator (cloud.elastic.co/pricing/serverless?s=observability) says
 * "Billing meters the enriched, indexed size, about 1.66x" raw log volume and
 * "Metrics and traces are metered 1:1". It uses a 365/12-day month, so for the
 * same inputs it counts 1.4% more volume than this calculator's 30 days.
 */
describe("Elastic Cloud Serverless: worked examples", () => {
  it("prices 100 GB of logs a day, kept 30 days, from the pricing table", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };
    const estimate = estimateVendor(elastic, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);

    // Billed: 100 GB/day x 30 days x 1.66 = 4,980 GB.
    // Ingest: 1,500 x $0.50 + 1,500 x $0.325 + 1,980 x $0.225
    //       = 750 + 487.50 + 445.50 = $1,683.00
    // Retention: 4,980 GB held x $0.04 = $199.20
    expect(sumOf(estimate, "Log ingestion")).toBeCloseTo(1683, 6);
    expect(sumOf(estimate, "Log retention")).toBeCloseTo(199.2, 6);
    expect(estimate.byBucket.logs).toBeCloseTo(1882.2, 6);
    expect(estimate.monthly).toBeCloseTo(1882.2, 6);

    // Estimator, Complete, us-east-1, Limited support, 1 month retention:
    // "100 GB/day raw = 166.00 GB/day metered", ingest $1,698.56,
    // "5,049 GB/month retained" $201.97, total $1,900.53 on its longer month.
    expect(off(estimate.monthly, 1900.53)).toBeLessThan(0.015);

    // The ingest crosses two tier edges: one line per tier reached.
    const ingest = estimate.lines.filter((l) => l.label.startsWith("Log ingestion"));
    expect(ingest.map((l) => l.rateId)).toEqual(["ingest-us-1", "ingest-us-2", "ingest-us-3"]);
    expect(ingest[0].quantity).toBeCloseTo(1500, 6);
    expect(ingest[1].quantity).toBeCloseTo(1500, 6);
    expect(ingest[2].quantity).toBeCloseTo(1980, 6);
    const retention = estimate.lines.filter((l) => l.label.startsWith("Log retention"));
    expect(retention.map((l) => l.rateId)).toEqual(["retention-us-1"]);
    expect(retention[0].quantity).toBeCloseTo(4980, 6);
  });

  it("reproduces Elastic's estimator to the cent at the estimator's month length", () => {
    // Each figure below was read off the estimator on 2026-11-12 (Complete,
    // Limited support). The workload is scaled to its 365/12-day month.
    const logs = base();
    logs.logs = { ...logs.logs, gbPerDay: 100, retentionDays: 30 };

    // 100 GB/day of logs, 1 month: 166 x 365/12 = 5,049.17 GB metered.
    // Ingest 750 + 487.50 + 2,049.17 x $0.225 = $1,698.56. Retention x $0.04 = $201.97.
    const one = estimateVendor(elastic, atEstimatorMonth(onlySignals(logs, ["logs"])), DEFAULT_SETTINGS);
    expect(cents(sumOf(one, "ingestion"))).toBe("1698.56");
    expect(cents(sumOf(one, "retention"))).toBe("201.97");
    expect(cents(one.monthly)).toBe("1900.53");

    // The same in eu-west-1: ingest $1,868.42 + retention $222.16 = $2,090.58.
    const eu = estimateVendor(elastic, atEstimatorMonth(onlySignals(logs, ["logs"])), EU);
    expect(cents(sumOf(eu, "ingestion"))).toBe("1868.42");
    expect(cents(sumOf(eu, "retention"))).toBe("222.16");
    expect(cents(eu.monthly)).toBe("2090.58");

    // Kept 3 months: "15,148 GB/month retained", $564.72. Total $2,263.28.
    const longer = structuredClone(logs);
    longer.logs.retentionDays = 90;
    const three = estimateVendor(elastic, atEstimatorMonth(onlySignals(longer, ["logs"])), DEFAULT_SETTINGS);
    expect(cents(sumOf(three, "retention"))).toBe("564.72");
    expect(cents(three.monthly)).toBe("2263.28");

    // 1,000 traces a minute: "32.832 GB/day raw = 32.83 GB/day metered",
    // $499.32 + $39.95 = $539.27. 380 spans/s of 1,000 bytes is 32.832 GB/day.
    const traced = structuredClone(logs);
    traced.traces = { ...traced.traces, spansPerSecond: 380, avgSpanBytes: 1000, retentionDays: 30 };
    const traces = estimateVendor(elastic, atEstimatorMonth(onlySignals(traced, ["traces"])), DEFAULT_SETTINGS);
    expect(cents(sumOf(traces, "ingestion"))).toBe("499.32");
    expect(cents(traces.monthly)).toBe("539.27");

    // Logs and traces together: "132.832 GB/day raw = 198.83 GB/day metered",
    // ingest $1,919.67 + retention $241.91 = $2,161.58. One ladder for both.
    const both = estimateVendor(
      elastic,
      atEstimatorMonth(onlySignals(traced, ["logs", "traces"])),
      DEFAULT_SETTINGS,
    );
    expect(cents(sumOf(both, "ingestion"))).toBe("1919.67");
    expect(cents(sumOf(both, "retention"))).toBe("241.91");
    expect(cents(both.monthly)).toBe("2161.58");

    // The mid-size preset. Estimator inputs: 330 GB/day of logs for 1 month,
    // 162 GB/day of metrics for 13 months (250,000 series x 1,440 points a day
    // x 450 bytes) and 5,263 traces a minute for 1 month (172.795 GB/day, the
    // closest it allows to the preset's 172.8). It shows "664.795 GB/day raw =
    // 882.59 GB/day metered", ingest $4,406.87, "85,976 GB/month retained"
    // $1,280.95, total $5,687.81.
    const mid = base();
    mid.traces.spansPerSecond = (5263 * 380) / 1000;
    const preset = estimateVendor(elastic, atEstimatorMonth(mid), DEFAULT_SETTINGS);
    expect(cents(sumOf(preset, "ingestion"))).toBe("4406.87");
    expect(cents(sumOf(preset, "retention"))).toBe("1280.95");
    expect(cents(preset.monthly)).toBe("5687.81");
  });

  it("prices traces alone at the size sent, as the estimator does", () => {
    // Estimator: 1,000 traces a minute at 100% sampling is shown as
    // "32.832 GB/day raw = 32.83 GB/day metered", $499.32 ingest + $39.95
    // retention = $539.27 on its 365/12-day month. 380 spans/s of 1,000 bytes
    // is the same 32.832 GB/day.
    const w = base();
    w.traces = { ...w.traces, spansPerSecond: 380, avgSpanBytes: 1000, retentionDays: 30 };
    const estimate = estimateVendor(elastic, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);

    // 380 x 2,592,000 s x 1,000 bytes = 984.96 GB, all in the first tier.
    // Ingest: 984.96 x $0.50 = $492.48. Retention: 984.96 x $0.04 = $39.3984.
    expect(estimate.byBucket.traces).toBeCloseTo(531.8784, 6);
    expect(estimate.monthly).toBeCloseTo(531.8784, 6);
    // One tier, so the estimator's figure scales with the days in the month.
    expect(estimate.monthly).toBeCloseTo((539.27 * 30) / (365 / 12), 1);
    expect(estimate.assumptions.join(" ")).toContain("metered 1:1");
  });

  it("matches the metrics examples in Elastic's pricing post", () => {
    // elastic.co/blog/metrics-pricing, example 1: 300 hosts x 500 series at a
    // 15 s interval, "~450 bytes per datapoint", 15 months kept:
    // "Ingest $693.22 + retention $1,240.10 = $1,933.32 subtotal".
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: 150_000, intervalSeconds: 15, retentionMonths: 15 };
    const one = estimateVendor(elastic, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);

    // 150,000 series x 4 points a minute x 43,200 minutes = 25.92B points
    // x 450 bytes = 11,664 GB.
    // Ingest: 1,500 x $0.125 + 1,500 x $0.0813 + 3,000 x $0.0563 + 5,664 x $0.0375
    //       = 187.50 + 121.95 + 168.90 + 212.40 = $690.75
    // Held: 11,664 x 15 months = 174,960 GB.
    // Retention: 10,000 x $0.01 + 10,000 x $0.008 + 30,000 x $0.0075
    //          + 50,000 x $0.007 + 74,960 x $0.0065
    //          = 100 + 80 + 225 + 350 + 487.24 = $1,242.24
    expect(one.byBucket.metrics).toBeCloseTo(1932.99, 6);
    expect(one.monthly).toBeCloseTo(1932.99, 6);
    expect(off(one.monthly, 1933.32)).toBeLessThan(0.005);

    // Example 2: 200 nodes x 1,000 series, same interval and retention:
    // "Ingest $835.21 + retention $1,618.47 = $2,453.67 subtotal".
    w.metrics = { ...w.metrics, activeSeries: 200_000 };
    const two = estimateVendor(elastic, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    // 200,000 x 4 x 43,200 x 450 bytes = 15,552 GB.
    // Ingest: 187.50 + 121.95 + 168.90 + 9,000 x $0.0375 + 552 x $0.0263
    //       = 478.35 + 337.50 + 14.5176 = $830.3676
    // Held: 15,552 x 15 = 233,280 GB.
    // Retention: 100 + 80 + 225 + 350 + 133,280 x $0.0065 = 755 + 866.32 = $1,621.32
    expect(two.monthly).toBeCloseTo(2451.6876, 6);
    expect(off(two.monthly, 2453.67)).toBeLessThan(0.005);
  });

  it("sizes a data point at Elastic's 450 bytes, whatever the workload says", () => {
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: 100_000, intervalSeconds: 60, retentionMonths: 13 };
    const estimate = estimateVendor(elastic, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);

    // 100,000 series x 43,200 points = 4.32B points x 450 bytes = 1,944 GB.
    // Ingest: 1,500 x $0.125 + 444 x $0.0813 = 187.50 + 36.0972 = $223.5972
    // Held: 1,944 x 13 months = 25,272 GB.
    // Retention: 10,000 x $0.01 + 10,000 x $0.008 + 5,272 x $0.0075
    //          = 100 + 80 + 39.54 = $219.54
    expect(estimate.monthly).toBeCloseTo(443.1372, 6);

    w.metrics = { ...w.metrics, bytesPerDataPoint: 40 };
    const smaller = estimateVendor(elastic, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(smaller.monthly).toBeCloseTo(443.1372, 6);
    expect(smaller.assumptions.join(" ")).toContain("450 bytes");
    expect(smaller.assumptions.join(" ")).toContain("in place of the 40 bytes");

    // Estimator: 162 GB/day of metrics kept 13 months is $417.97 ingest +
    // $503.40 retention = $921.37. 250,000 series at 60 s x 450 bytes is 162 GB/day.
    const mid = estimateVendor(
      elastic,
      atEstimatorMonth(onlySignals(base(), ["metrics"])),
      DEFAULT_SETTINGS,
    );
    expect(cents(sumOf(mid, "ingestion"))).toBe("417.97");
    expect(cents(sumOf(mid, "retention"))).toBe("503.40");
    expect(cents(mid.monthly)).toBe("921.37");
  });

  it("fills one tier ladder with logs and traces together and splits each tier by volume", () => {
    // Estimator with both: "132.832 GB/day raw = 198.83 GB/day metered",
    // ingest $1,919.67 + retention $241.91 = $2,161.58 (365/12-day month).
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };
    w.traces = { ...w.traces, spansPerSecond: 380, avgSpanBytes: 1000, retentionDays: 30 };
    const both = estimateVendor(elastic, onlySignals(w, ["logs", "traces"]), DEFAULT_SETTINGS);

    // Billed: 4,980 GB of logs + 984.96 GB of traces = 5,964.96 GB.
    // Ingest: 1,500 x $0.50 + 1,500 x $0.325 + 2,964.96 x $0.225
    //       = 750 + 487.50 + 667.116 = $1,904.616
    // Retention: 5,964.96 x $0.04 = $238.5984
    // Total $2,143.2144, of which logs carry 4,980 / 5,964.96 = 83.49%.
    expect(both.monthly).toBeCloseTo(2143.2144, 6);
    expect(off(both.monthly, 2161.58)).toBeLessThan(0.015);
    expect(both.byBucket.logs).toBeCloseTo((2143.2144 * 4980) / 5964.96, 6);
    expect(both.byBucket.traces).toBeCloseTo((2143.2144 * 984.96) / 5964.96, 6);

    // Each signal has a line in each of the three ingest tiers reached.
    const logIngest = both.lines.filter((l) => l.label.startsWith("Log ingestion"));
    expect(logIngest.map((l) => l.rateId)).toEqual(["ingest-us-1", "ingest-us-2", "ingest-us-3"]);
    expect(logIngest[0].quantity).toBeCloseTo((1500 * 4980) / 5964.96, 6);

    // Priced apart, each starts at the top of the ladder: $1,882.20 + $531.8784.
    const logs = estimateVendor(elastic, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    const traces = estimateVendor(elastic, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    expect(logs.monthly + traces.monthly).toBeCloseTo(2414.0784, 6);
    expect(both.monthly).toBeLessThan(logs.monthly + traces.monthly);
  });

  it("bills longer retention per GB held, across the retention tiers", () => {
    // Estimator at 3 months: "15,148 GB/month retained", $564.72.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 90 };
    const estimate = estimateVendor(elastic, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);

    // Held: 100 GB/day x 90 days x 1.66 = 14,940 GB.
    // Retention: 10,000 x $0.04 + 4,940 x $0.032 = 400 + 158.08 = $558.08
    // Ingest is unchanged at $1,683.00.
    expect(estimate.monthly).toBeCloseTo(2241.08, 6);
    const retention = estimate.lines.filter((l) => l.label.startsWith("Log retention"));
    expect(retention.map((l) => l.rateId)).toEqual(["retention-us-1", "retention-us-2"]);
    expect(off(retention.reduce((sum, l) => sum + l.amount, 0), 564.72)).toBeLessThan(0.015);

    // Traces kept a week hold 7/30 of a month's volume.
    const short = base();
    short.traces = { ...short.traces, spansPerSecond: 380, avgSpanBytes: 1000, retentionDays: 7 };
    const week = estimateVendor(elastic, onlySignals(short, ["traces"]), DEFAULT_SETTINGS);
    // Ingest 984.96 x $0.50 = $492.48. Held 984.96 x 7 / 30 = 229.824 GB x $0.04 = $9.19296.
    expect(week.monthly).toBeCloseTo(501.67296, 6);
  });

  it("uses the Ireland rate card for the EU", () => {
    // AWS eu-west-1: ingest $0.55, $0.3575, $0.2475; retention $0.044.
    // Estimator with eu-west-1 and 100 GB of logs a day: ingest $1,868.42 +
    // retention $222.16 = $2,090.58 (365/12-day month).
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };
    const estimate = estimateVendor(elastic, onlySignals(w, ["logs"]), EU);

    // Ingest: 1,500 x $0.55 + 1,500 x $0.3575 + 1,980 x $0.2475
    //       = 825 + 536.25 + 490.05 = $1,851.30
    // Retention: 4,980 x $0.044 = $219.12
    expect(estimate.monthly).toBeCloseTo(2070.42, 6);
    expect(off(estimate.monthly, 2090.58)).toBeLessThan(0.015);
    expect(elastic.plan(EU)).toContain("eu-west-1");
    expect(elastic.plan(DEFAULT_SETTINGS)).toContain("us-east-1");

    // The mid-size preset on all four eu-west-1 ladders (same volumes as the
    // us-east-1 example below: 21,618 GB of logs and traces, 4,860 GB of metrics).
    // Ingest: 1,500 x $0.55 + 1,500 x $0.3575 + 3,000 x $0.2475 + 9,000 x $0.165
    //       + 6,618 x $0.1155 = 825 + 536.25 + 742.50 + 1,485 + 764.379 = $4,353.129
    // Retention: 10,000 x $0.044 + 10,000 x $0.0352 + 1,618 x $0.033
    //          = 440 + 352 + 53.394 = $845.394
    // Metric ingest: 1,500 x $0.1375 + 1,500 x $0.0894 + 1,860 x $0.0619
    //              = 206.25 + 134.10 + 115.134 = $455.484
    // Metric retention: 10,000 x $0.011 + 10,000 x $0.0088 + 30,000 x $0.0083
    //                 + 13,180 x $0.0077 = 110 + 88 + 249 + 101.486 = $548.486
    const mid = estimateVendor(elastic, base(), EU);
    expect(sumOf(mid, "Log ingestion") + sumOf(mid, "Trace ingestion")).toBeCloseTo(4353.129, 6);
    expect(sumOf(mid, "Log retention") + sumOf(mid, "Trace retention")).toBeCloseTo(845.394, 6);
    expect(sumOf(mid, "Metric ingestion")).toBeCloseTo(455.484, 6);
    expect(sumOf(mid, "Metric retention")).toBeCloseTo(548.486, 6);
    expect(mid.monthly).toBeCloseTo(6202.493, 6);
  });

  it("prices the mid-size preset with all three signals", () => {
    const estimate = estimateVendor(elastic, base(), DEFAULT_SETTINGS);

    // Logs: 330 GB/day x 30 x 1.66 = 16,434 GB. Traces: 2,000 spans/s x 2,592,000 s
    // x 1,000 bytes = 5,184 GB. Together 21,618 GB, kept 30 days.
    // Ingest: 750 + 487.50 + 3,000 x $0.225 + 9,000 x $0.15 + 6,618 x $0.105
    //       = 750 + 487.50 + 675 + 1,350 + 694.89 = $3,957.39
    // Retention: 10,000 x $0.04 + 10,000 x $0.032 + 1,618 x $0.03
    //          = 400 + 320 + 48.54 = $768.54
    // Logs and traces: $4,725.93, split 16,434 : 5,184.
    expect(sumOf(estimate, "Log ingestion") + sumOf(estimate, "Trace ingestion")).toBeCloseTo(3957.39, 6);
    expect(sumOf(estimate, "Log retention") + sumOf(estimate, "Trace retention")).toBeCloseTo(768.54, 6);
    expect(estimate.byBucket.logs).toBeCloseTo((4725.93 * 16434) / 21618, 6);
    expect(estimate.byBucket.traces).toBeCloseTo((4725.93 * 5184) / 21618, 6);

    // The two signals' slices of a tier add up to the tier: 1,500 GB in the
    // first, 6,618 GB in the fifth, and 1,618 GB in the third retention tier.
    const inTier = (rateId: string) =>
      estimate.lines.filter((l) => l.rateId === rateId).reduce((sum, l) => sum + l.quantity, 0);
    expect(inTier("ingest-us-1")).toBeCloseTo(1500, 6);
    expect(inTier("ingest-us-4")).toBeCloseTo(9000, 6);
    expect(inTier("ingest-us-5")).toBeCloseTo(6618, 6);
    expect(inTier("retention-us-3")).toBeCloseTo(1618, 6);
    expect(estimate.lines.some((l) => l.rateId === "ingest-us-6")).toBe(false);

    // Metrics: 250,000 series x 43,200 points x 450 bytes = 4,860 GB.
    // Ingest: 187.50 + 121.95 + 1,860 x $0.0563 = 187.50 + 121.95 + 104.718 = $414.168
    // Held: 4,860 x 13 months = 63,180 GB.
    // Retention: 100 + 80 + 225 + 13,180 x $0.007 = 405 + 92.26 = $497.26
    expect(sumOf(estimate, "Metric ingestion")).toBeCloseTo(414.168, 6);
    expect(sumOf(estimate, "Metric retention")).toBeCloseTo(497.26, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(911.428, 6);

    expect(estimate.byBucket.platform).toBe(0);
    expect(estimate.monthly).toBeCloseTo(5637.358, 6);
    expect(estimate.complete).toBe(true);
    // Elastic's estimator shows $5,687.81 for the same inputs on its longer month.
    expect(off(estimate.monthly, 5687.81)).toBeLessThan(0.015);
  });

  it("starts each signal at the top of its ladder when it is routed to Elastic alone", () => {
    const w = base();

    // Logs alone: 16,434 GB.
    // Ingest: 750 + 487.50 + 675 + 1,350 + 1,434 x $0.105 = 3,262.50 + 150.57 = $3,413.07
    // Retention: 10,000 x $0.04 + 6,434 x $0.032 = 400 + 205.888 = $605.888
    const logs = estimateVendor(elastic, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(logs.monthly).toBeCloseTo(4018.958, 6);
    expect(logs.byBucket.logs).toBeCloseTo(4018.958, 6);

    // Traces alone: 5,184 GB.
    // Ingest: 750 + 487.50 + 2,184 x $0.225 = 1,237.50 + 491.40 = $1,728.90
    // Retention: 5,184 x $0.04 = $207.36
    const traces = estimateVendor(elastic, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    expect(traces.monthly).toBeCloseTo(1936.26, 6);
    expect(traces.byBucket.traces).toBeCloseTo(1936.26, 6);

    // Metrics have separate ladders either way: $414.168 + $497.26.
    const metrics = estimateVendor(elastic, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(metrics.monthly).toBeCloseTo(911.428, 6);

    // Together, logs and traces share one ladder and cost $4,725.93, not $5,955.218.
    const together = estimateVendor(elastic, onlySignals(w, ["logs", "traces"]), DEFAULT_SETTINGS);
    expect(together.monthly).toBeCloseTo(4725.93, 6);
    expect(logs.monthly + traces.monthly).toBeCloseTo(5955.218, 6);
  });

  it("walks the upper tiers for the large preset", () => {
    const estimate = estimateVendor(elastic, presetById("large")!.workload, DEFAULT_SETTINGS);

    // Logs: 2,000 GB/day x 30 x 1.66 = 99,600 GB. Traces: 15,000 spans/s x
    // 2,592,000 s x 1,000 bytes = 38,880 GB. Together 138,480 GB, kept 30 days.
    // Ingest: 750 + 487.50 + 675 + 1,350 + 15,000 x $0.105 + 30,000 x $0.10
    //       + 78,480 x $0.095 = 3,262.50 + 1,575 + 3,000 + 7,455.60 = $15,293.10
    // Retention: 400 + 320 + 30,000 x $0.03 + 50,000 x $0.028 + 38,480 x $0.026
    //          = 720 + 900 + 1,400 + 1,000.48 = $4,020.48
    expect(sumOf(estimate, "Log ingestion") + sumOf(estimate, "Trace ingestion")).toBeCloseTo(15293.1, 6);
    expect(sumOf(estimate, "Log retention") + sumOf(estimate, "Trace retention")).toBeCloseTo(4020.48, 6);

    // Metrics: 2,000,000 series x 43,200 points x 450 bytes = 38,880 GB.
    // Ingest: 187.50 + 121.95 + 168.90 + 9,000 x $0.0375 + 15,000 x $0.0263
    //       + 8,880 x $0.025 = 478.35 + 337.50 + 394.50 + 222 = $1,432.35
    // Held: 38,880 x 13 months = 505,440 GB.
    // Retention: 100 + 80 + 225 + 350 + 150,000 x $0.0065 + 255,440 x $0.0055
    //          = 755 + 975 + 1,404.92 = $3,134.92
    expect(sumOf(estimate, "Metric ingestion")).toBeCloseTo(1432.35, 6);
    expect(sumOf(estimate, "Metric retention")).toBeCloseTo(3134.92, 6);
    expect(estimate.monthly).toBeCloseTo(23880.85, 6);
  });

  it("reaches the last ingest tier only past 150,000 GB a month", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 10_000, retentionDays: 30 };
    const estimate = estimateVendor(elastic, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);

    // Billed: 10,000 GB/day x 30 x 1.66 = 498,000 GB.
    // Ingest: 750 + 487.50 + 675 + 1,350 + 1,575 + 3,000 + 90,000 x $0.095
    //       + 348,000 x $0.0925 = 7,837.50 + 8,550 + 32,190 = $48,577.50
    // Retention: 400 + 320 + 900 + 1,400 + 150,000 x $0.026 + 248,000 x $0.022
    //          = 3,020 + 3,900 + 5,456 = $12,376
    expect(sumOf(estimate, "Log ingestion")).toBeCloseTo(48577.5, 6);
    expect(sumOf(estimate, "Log retention")).toBeCloseTo(12376, 6);
    const last = estimate.lines.find((l) => l.rateId === "ingest-us-8");
    expect(last?.quantity).toBeCloseTo(348_000, 6);
    expect(last?.label).toBe("Log ingestion, above 150,000 GB");
  });

  it("has one published price whatever the term or query load", () => {
    const w = base();
    const annual = estimateVendor(elastic, w, DEFAULT_SETTINGS);
    const monthly = estimateVendor(elastic, w, { ...DEFAULT_SETTINGS, term: "monthly" });
    const heavy = estimateVendor(elastic, w, { ...DEFAULT_SETTINGS, queryLoad: "heavy" });
    expect(monthly.monthly).toBe(annual.monthly);
    expect(heavy.monthly).toBe(annual.monthly);
    expect(annual.notes.join(" ")).toContain("annual prepaid");
  });

  it("quotes prices in its text from the rates table and keeps the text plain", () => {
    const usd = (id: string) => elastic.rates.find((r) => r.id === id)!.usd;
    const mid = estimateVendor(elastic, base(), DEFAULT_SETTINGS);

    // Pricing page: support is 5%, 10% or 15% of the charge; egress is
    // "50 GB free, then $0.05".
    expect([usd("support-base"), usd("support-enhanced"), usd("support-premium")]).toEqual([0.05, 0.1, 0.15]);
    expect(usd("egress")).toBe(0.05);
    expect(mid.notIncluded.join(" ")).toContain("5%, 10% and 15%");
    expect(mid.notIncluded.join(" ")).toContain("past the free 50 GB a month, at $0.05 per GB");
    expect(mid.notes[0]).toContain("$0.50 a GB");
    expect(mid.notes[0]).toContain("$0.0925");
    expect(estimateVendor(elastic, base(), EU).notes[0]).toContain("$0.55 a GB");

    // The metrics Elastic derives from traces are flagged only when traces are sent.
    expect(mid.notIncluded.join(" ")).toContain("builds from traces");
    const noTraces = estimateVendor(elastic, onlySignals(base(), ["logs", "metrics"]), DEFAULT_SETTINGS);
    expect(noTraces.notIncluded.join(" ")).not.toContain("builds from traces");

    // The Logs Essentials tier is mentioned only for a logs-only project.
    const logsOnly = estimateVendor(elastic, onlySignals(base(), ["logs"]), DEFAULT_SETTINGS);
    expect(logsOnly.notes.join(" ")).toContain("Logs Essentials");
    expect(mid.notes.join(" ")).not.toContain("Logs Essentials");

    // No em dashes, en dashes or semicolons anywhere a buyer reads.
    const dashOrSemicolon = /[—–;]/;
    const settings: Settings[] = [DEFAULT_SETTINGS, EU, { ...DEFAULT_SETTINGS, term: "monthly" }];
    for (const preset of PRESETS) {
      for (const s of settings) {
        const e = estimateVendor(elastic, preset.workload, s);
        const texts = [
          elastic.plan(s),
          ...e.assumptions,
          ...e.included,
          ...e.notIncluded,
          ...e.notes,
          ...e.lines.flatMap((l) => [l.label, l.detail ?? ""]),
        ];
        for (const text of texts) expect(text).not.toMatch(dashOrSemicolon);
        // Line details multiply with the sign ×, never the letter x.
        for (const line of e.lines) expect(line.detail ?? "").not.toMatch(/\dx|\sx\s/);
      }
    }
    for (const rate of elastic.rates) {
      expect(`${rate.label} ${rate.note ?? ""}`).not.toMatch(dashOrSemicolon);
    }
  });
});
