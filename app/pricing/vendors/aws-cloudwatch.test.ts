import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import type { Bucket, Settings, VendorEstimate, Workload } from "../types";
import { derive } from "../units";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { awsCloudwatch } from "./aws-cloudwatch";

const base = (): Workload => structuredClone(presetById("mid")!.workload);

/**
 * AWS's GB for logs and spans is binary (its examples use 1,024 GB to a TB
 * and 1,048,576 KB to a GB). One of them is this many of the calculator's GB.
 */
const GIB = 2 ** 30 / 1e9;
const SECONDS_PER_MONTH = 2_592_000;

/** Sum of the lines in a bucket whose rate id starts with the given prefix. */
function charged(estimate: VendorEstimate, bucket: Bucket, ratePrefix: string): number {
  return estimate.lines
    .filter((l) => l.bucket === bucket && l.rateId.startsWith(ratePrefix))
    .reduce((sum, l) => sum + l.amount, 0);
}

const light: Settings = { ...DEFAULT_SETTINGS, queryLoad: "light" };

describe("Amazon CloudWatch: worked examples", () => {
  it("matches AWS's OpenTelemetry metrics example: 5,000 series at 500 bytes is $54.00", () => {
    // aws.amazon.com/cloudwatch/pricing, "Publishing OpenTelemetry Custom Metrics":
    // 100 instances x 50 metrics = 5,000 data points/min x 500 bytes = 2.5 MB/min
    // 2.5 MB x 60 x 24 x 30 = 108 GB/month, and 108 GB x $0.50 = $54.00
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: 5_000, intervalSeconds: 60, bytesPerDataPoint: 500 };
    const estimate = estimateVendor(awsCloudwatch, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(estimate.byBucket.metrics).toBeCloseTo(54, 6);
    expect(estimate.monthly).toBeCloseTo(54, 6);
    expect(estimate.complete).toBe(true);
  });

  it("matches AWS's span example: 72 TB crosses both tier edges", () => {
    // aws.amazon.com/cloudwatch/pricing, Application Signals and Transaction Search example:
    //   0 to 10 TB   10 x 1,024 x $0.35 = $3,584.00
    //   10 to 30 TB  20 x 1,024 x $0.20 = $4,096.00
    //   30 to 72 TB  42 x 1,024 x $0.15 = $6,451.20      ingestion $14,131.20
    //   "1 span = ~1kB", so 72B spans. 2% indexed is 1.44B, the first 1% (720M) is free:
    //   720M x $0.75 per million = $540.00
    // 72 TB in AWS's units is 72 x 2^40 bytes, so each of the 72B spans is 2^40 / 10^9 bytes.
    const w = base();
    w.traces = {
      spansPerSecond: 72e9 / SECONDS_PER_MONTH,
      avgSpanBytes: 2 ** 40 / 1e9,
      retentionDays: 30,
      searchableShare: 0.02,
    };
    const estimate = estimateVendor(awsCloudwatch, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    expect(charged(estimate, "traces", "spans-")).toBeCloseTo(14_131.2, 4);
    // AWS's example opts into 2% indexing. The estimate keeps the default 1%,
    // which is free, so there is no indexing line; the rate still matches.
    expect(charged(estimate, "traces", "span-indexing")).toBe(0);
    expect(720 * awsCloudwatch.rates.find((r) => r.id === "span-indexing")!.usd).toBeCloseTo(540, 6);
    // AWS's example stops there. Keeping the spans 30 days adds storage:
    // 73,728 GB x 0.15 compression = 11,059.2 GB, less 5 GB free = 11,054.2 x $0.03 = $331.626
    expect(charged(estimate, "traces", "log-storage")).toBeCloseTo(331.626, 4);
    expect(estimate.monthly).toBeCloseTo(14_131.2 + 331.626, 4);
  });

  it("follows the free-tier arithmetic of AWS's log example: 1 GB a day is $12.50 of ingestion", () => {
    // aws.amazon.com/cloudwatch/pricing, Example 2 (data protection) counts
    //   1 GB x 30 days = 30 GB, 0 to 5 GB free, then bills 25 GB ($0.25 x 25 = $6.25).
    // That example is on the Infrequent Access class ($0.25). At the Standard OTLP rate
    // the same 25 GB is $0.50 x 25 = $12.50.
    // The example assumes compression to 6 GB and bills 1 GB of storage ($0.03), so the
    // 5 GB storage allowance is separate from the ingestion one. With the Omni factor
    // 0.15: 30 x 0.15 = 4.5 GB, inside the 5 GB free tier.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 1 * GIB, retentionDays: 30 };
    const estimate = estimateVendor(awsCloudwatch, onlySignals(w, ["logs"]), light);
    expect(charged(estimate, "logs", "log-ingest-us")).toBeCloseTo(12.5, 6);
    expect(charged(estimate, "logs", "log-storage")).toBe(0);
    // Light query load scans 5 x 30 = 150 GB, less 5 GB free: 145 x $0.005 = $0.725
    expect(charged(estimate, "logs", "log-scan-us")).toBeCloseTo(0.725, 6);
    expect(estimate.monthly).toBeCloseTo(12.5 + 0.725, 6);
  });

  it("matches the ingest and storage lines of AWS's Omni pricing example, less the free tier", () => {
    // aws.amazon.com/cloudwatch/omni/pricing, Example 3 (1 TB of spans, 0.6 TB of logs, 1 month):
    //   Spans: 1,000 GB x $0.35 = $350      Logs: 600 GB x $0.50 = $300
    //   Storage: 1,600 GB x 0.15 x $0.03 = $7.20
    // The example leaves out the free tier, which takes 5 GB off log ingestion ($2.50)
    // and 5 GB off storage ($0.15): logs $297.50, storage $7.05.
    // Its query line is not compared: it uses Omni's query allowance, and this
    // adapter prices Logs Insights.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 20 * GIB, retentionDays: 30 };
    w.traces = {
      spansPerSecond: 1_000,
      avgSpanBytes: (1_000 * 2 ** 30) / (1_000 * SECONDS_PER_MONTH),
      retentionDays: 30,
      searchableShare: 0.01,
    };
    const estimate = estimateVendor(awsCloudwatch, onlySignals(w, ["logs", "traces"]), light);
    expect(charged(estimate, "logs", "log-ingest-us")).toBeCloseTo(297.5, 6);
    expect(charged(estimate, "traces", "spans-")).toBeCloseTo(350, 6);
    // Logs: 600 x 0.15 = 90 GB, less 5 free = 85 x $0.03 = $2.55. Spans: 1,000 x 0.15 = 150 x $0.03 = $4.50
    expect(charged(estimate, "logs", "log-storage")).toBeCloseTo(2.55, 6);
    expect(charged(estimate, "traces", "log-storage")).toBeCloseTo(4.5, 6);
    // 1% indexed is the free share.
    expect(charged(estimate, "traces", "span-indexing")).toBe(0);
  });

  it("worked example (b): 100 GB of logs a day alone, 30 days, default settings", () => {
    // From the vendor's pages only (us-east-1, Standard class, OTLP):
    //   100 GB/day x 30 = 3,000 GB of 10^9 bytes = 3,000 / 1.073741824 = 2,793.9677 GiB
    //   ingestion  (2,793.9677 - 5 free) x $0.50                       = $1,394.4839
    //   storage    2,793.9677 x 0.15 = 419.0952, less 5 free = 414.0952 x $0.03 = $12.4229
    //   scans      2,793.9677 x 20 (typical) = 55,879.35, less 5 free x $0.005 = $279.3718
    //   total                                                          = $1,686.2785
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };
    const estimate = estimateVendor(awsCloudwatch, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(charged(estimate, "logs", "log-ingest-us")).toBeCloseTo(1_394.4839, 3);
    expect(charged(estimate, "logs", "log-storage")).toBeCloseTo(12.4229, 3);
    expect(charged(estimate, "logs", "log-scan-us")).toBeCloseTo(279.3718, 3);
    expect(estimate.monthly).toBeCloseTo(1_686.2785, 3);
    expect(estimate.shortRetention).toEqual([]);
  });

  it("reports the retention it prices when that differs from the ask", () => {
    // Metrics: 13 months asked, the per-GB price includes 15. Longer, so no row mark.
    const mid = estimateVendor(awsCloudwatch, base(), DEFAULT_SETTINGS);
    expect(mid.shortRetention).toEqual([]);
    const out = awsCloudwatch.price({ w: base(), d: derive(base()), s: DEFAULT_SETTINGS });
    expect(out.kept).toEqual({ metricsMonths: 15 });

    // 24 months asked: kept at 15, shorter, and said in the first assumption.
    const w = base();
    w.metrics.retentionMonths = 24;
    const long = estimateVendor(awsCloudwatch, w, DEFAULT_SETTINGS);
    expect(long.shortRetention).toEqual([{ signal: "metrics", asked: 24, kept: 15, unit: "months" }]);
    expect(long.assumptions[0]).toContain("at most 15 months");

    // 45 days of logs is priced as the 60-day setting.
    const w45 = base();
    w45.logs.retentionDays = 45;
    const out45 = awsCloudwatch.price({ w: w45, d: derive(w45), s: DEFAULT_SETTINGS });
    expect(out45.kept?.logsDays).toBe(60);
  });

  it("prices logs alone: ingestion, storage and scans", () => {
    // 100 of AWS's GB a day is 3,000 a month.
    //   ingestion  (3,000 - 5 free) x $0.50                    = $1,497.50
    //   storage    3,000 x 0.15 = 450, less 5 free = 445 x $0.03 = $13.35
    //   scans      20 x 3,000 = 60,000, less 5 free x $0.005     = $299.975
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100 * GIB, retentionDays: 30 };
    const estimate = estimateVendor(awsCloudwatch, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(charged(estimate, "logs", "log-ingest-us")).toBeCloseTo(1_497.5, 6);
    expect(charged(estimate, "logs", "log-storage")).toBeCloseTo(13.35, 6);
    expect(charged(estimate, "logs", "log-scan-us")).toBeCloseTo(299.975, 6);
    expect(estimate.monthly).toBeCloseTo(1_810.825, 6);
    expect(estimate.byBucket.metrics + estimate.byBucket.traces + estimate.byBucket.platform).toBe(0);
  });

  it("prices metrics alone, by payload bytes", () => {
    // 250,000 series x 43,200 points a month = 10.8B data points x 150 bytes = 1,620 GB x $0.50
    const estimate = estimateVendor(awsCloudwatch, onlySignals(base(), ["metrics"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(810, 6);
    expect(estimate.lines).toHaveLength(1);
  });

  it("prices traces alone: ingestion and storage, whatever the searchable share", () => {
    // 1,000 spans/s is 2.592B spans a month. At 2^30 / 10^6 bytes each that is 2,592 of AWS's GB.
    //   ingestion  2,592 x $0.35                                         = $907.20
    //   storage    2,592 x 0.15 = 388.8, less 5 free = 383.8 x $0.03       = $11.514
    // Every span is searchable in Transaction Search; indexing stays at the free 1%.
    const w = base();
    w.traces = {
      spansPerSecond: 1_000,
      avgSpanBytes: 2 ** 30 / 1e6,
      retentionDays: 30,
      searchableShare: 1,
    };
    const all = estimateVendor(awsCloudwatch, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    expect(charged(all, "traces", "spans-")).toBeCloseTo(907.2, 6);
    expect(charged(all, "traces", "span-indexing")).toBe(0);
    expect(charged(all, "traces", "log-storage")).toBeCloseTo(11.514, 6);
    expect(all.monthly).toBeCloseTo(907.2 + 11.514, 6);

    // A lower searchable share changes nothing.
    w.traces.searchableShare = 0.01;
    const onePercent = estimateVendor(awsCloudwatch, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    expect(charged(onePercent, "traces", "span-indexing")).toBe(0);
    expect(onePercent.monthly).toBeCloseTo(907.2 + 11.514, 6);
  });

  it("uses the Ireland rates for the EU, where logs and scans cost more", () => {
    // 3,000 of AWS's GB a month, heavy query load (100x):
    //   ingestion  (3,000 - 5) x $0.57        = $1,707.15
    //   storage    445 x $0.03 (same as US)   = $13.35
    //   scans      (300,000 - 5) x $0.0057    = $1,709.9715
    const eu: Settings = { term: "monthly", region: "eu", queryLoad: "heavy" };
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100 * GIB, retentionDays: 30 };
    const estimate = estimateVendor(awsCloudwatch, onlySignals(w, ["logs"]), eu);
    expect(charged(estimate, "logs", "log-ingest-eu")).toBeCloseTo(1_707.15, 6);
    expect(charged(estimate, "logs", "log-storage")).toBeCloseTo(13.35, 6);
    expect(charged(estimate, "logs", "log-scan-eu")).toBeCloseTo(1_709.9715, 6);
    expect(estimate.monthly).toBeCloseTo(3_430.4715, 6);

    // Metrics cost the same in both Regions: the mid preset is still 1,620 GB x $0.50.
    const metrics = estimateVendor(awsCloudwatch, onlySignals(base(), ["metrics"]), eu);
    expect(metrics.monthly).toBeCloseTo(810, 6);
  });

  it("rounds retention up to the next log group setting", () => {
    // 45 days is not a setting; 60 is. 100 GB/day x 60 days = 6,000 GB held
    // x 0.15 = 900, less 5 free = 895 x $0.03 = $26.85
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100 * GIB, retentionDays: 45 };
    const estimate = estimateVendor(awsCloudwatch, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(charged(estimate, "logs", "log-storage")).toBeCloseTo(26.85, 6);
    expect(estimate.assumptions.join(" ")).toContain("60 days");
  });

  it("shares the one 5 GB storage allowance between logs and spans", () => {
    // Logs: 30 GB a month x 0.15 = 4.5 GB stored, all free, leaving 0.5 GB of the allowance.
    // Spans: 1,000 GB a month x 0.15 = 150 GB stored, less 0.5 = 149.5 x $0.03 = $4.485
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 1 * GIB, retentionDays: 30 };
    w.traces = {
      spansPerSecond: 1_000,
      avgSpanBytes: (1_000 * 2 ** 30) / (1_000 * SECONDS_PER_MONTH),
      retentionDays: 30,
      searchableShare: 0.01,
    };
    const estimate = estimateVendor(awsCloudwatch, onlySignals(w, ["logs", "traces"]), light);
    expect(charged(estimate, "logs", "log-storage")).toBe(0);
    expect(charged(estimate, "traces", "log-storage")).toBeCloseTo(4.485, 6);
  });

  it("prices 15 months of metrics when more is asked for, and says so", () => {
    // The per-GB metric price includes 15 months and no longer option is published.
    // The charge is unchanged: 1,620 GB x $0.50 = $810.
    const w = base();
    w.metrics = { ...w.metrics, retentionMonths: 24 };
    const estimate = estimateVendor(awsCloudwatch, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(810, 6);
    expect(estimate.assumptions[0]).toContain("at most 15 months");
  });

  it("worked example (a): the mid-size preset with all three signals, default settings", () => {
    // Logs: 330 GB/day x 30 = 9,900 GB = 9,900 / 1.073741824 of AWS's GB
    const logGib = 9_900 / GIB;
    const logs =
      (logGib - 5) * 0.5 + // ingestion, 5 GB free
      (logGib * 0.15 - 5) * 0.03 + // 30 days held, compressed, 5 GB free
      (20 * logGib - 5) * 0.005; // typical query load, 5 GB free
    // Metrics: 250,000 series x 43,200 points x 150 bytes = 1,620 GB x $0.50
    const metrics = 1_620 * 0.5;
    // Traces: 2,000 spans/s x 2,592,000 s = 5.184B spans x 1,000 bytes = 5,184 GB
    const spanGib = 5_184 / GIB;
    const traces =
      spanGib * 0.35 + // all inside the first 10 TB
      spanGib * 0.15 * 0.03; // 30 days held, compressed; logs used up the free 5 GB
    const estimate = estimateVendor(awsCloudwatch, base(), DEFAULT_SETTINGS);
    expect(estimate.byBucket.logs).toBeCloseTo(logs, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(metrics, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(traces, 6);
    expect(estimate.byBucket.platform).toBe(0);
    expect(estimate.monthly).toBeCloseTo(logs + metrics + traces, 6);
    // By hand: 9,220.09 GiB of logs gives 4,607.55 + 41.34 + 921.98 = 5,570.87.
    // 4,827.98 GiB of spans gives 1,689.79 + 21.73 = 1,711.52 (no paid indexing).
    // 5,570.87 + 810.00 + 1,711.52 = 8,092.39
    expect(estimate.monthly).toBeCloseTo(8_092.39, 2);
  });
});

describe("Amazon CloudWatch: profiles through CodeGuru Profiler", () => {
  it("bills each profiled host-hour as a sampling hour", () => {
    // Mid preset, profiling on: 100 profiled hosts × 720 hours = 72,000 sampling hours × $0.005 = $360.
    const w = base();
    w.send.profiles = true;
    const estimate = estimateVendor(awsCloudwatch, onlySignals(w, ["profiles"]), DEFAULT_SETTINGS);
    expect(charged(estimate, "profiles", "profiler-sampling-hour")).toBeCloseTo(360, 6);
    expect(estimate.monthly).toBeCloseTo(360, 6);
    expect(estimate.assumptions.join(" ")).toContain("upper bound");
  });
});
