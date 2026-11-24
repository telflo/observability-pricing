import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import type { Settings, VendorEstimate, Workload } from "../types";
import { SECONDS_PER_MONTH } from "../units";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { datadog } from "./datadog";

/** 200 hosts, 330 GB of logs a day, 2,000 spans a second, 250,000 series. */
const base = (): Workload => structuredClone(presetById("mid")!.workload);

const MONTHLY: Settings = { ...DEFAULT_SETTINGS, term: "monthly" };

/** Dollars billed on one rate, over every line that uses it. */
const billedOn = (estimate: VendorEstimate, rateId: string) =>
  estimate.lines.filter((l) => l.rateId === rateId).reduce((sum, l) => sum + l.amount, 0);

/** Traces that come to an exact span count, GB volume and indexed share for the month. */
function spans(
  w: Workload,
  o: { hosts: number; perMonth: number; gb: number; indexed: number; retentionDays: number },
): Workload {
  return {
    ...w,
    infra: { ...w.infra, hosts: o.hosts, tracedHostShare: 1 },
    traces: {
      spansPerSecond: o.perMonth / SECONDS_PER_MONTH,
      avgSpanBytes: (o.gb * 1e9) / o.perMonth,
      retentionDays: o.retentionDays,
      searchableShare: o.indexed / o.perMonth,
    },
  };
}

describe("Datadog: worked examples", () => {
  it("matches Datadog's APM example: 5 hosts, 30M indexed spans and 900 GB is $212.50", () => {
    // docs.datadoghq.com/account_management/billing/apm_tracing_profiler,
    // "APM Hosts, indexed spans, and extra ingested spans" (annual rates,
    // 15-day indexed span retention):
    //   5 APM hosts x $31                                   = $155.00
    //   30M indexed spans, 5M included: 25 x $1.70          =  $42.50
    //   900 GB ingested, 750 GB included: 150 x $0.10       =  $15.00
    //                                                 total = $212.50
    // $31 is the price with Infrastructure Monitoring on the same hosts, so
    // metrics are sent too and only the traces part of the bill is checked.
    const w = spans(base(), { hosts: 5, perMonth: 300e6, gb: 900, indexed: 30e6, retentionDays: 15 });
    const estimate = estimateVendor(datadog, onlySignals(w, ["metrics", "traces"]), DEFAULT_SETTINGS);
    expect(billedOn(estimate, "apm-host-annual")).toBeCloseTo(155, 6);
    expect(billedOn(estimate, "spans-index-15d-annual")).toBeCloseTo(42.5, 6);
    expect(billedOn(estimate, "spans-ingest")).toBeCloseTo(15, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(212.5, 6);
  });

  it("charges no span overage at the pooled allotment, as Datadog's pricing FAQ says", () => {
    // datadoghq.com/pricing, APM FAQ: with 2 APM hosts, 300 GB ingested and
    // 2 million indexed spans in total are not billed. That leaves the hosts:
    //   2 x $31 = $62.00
    const atAllotment = spans(base(), { hosts: 2, perMonth: 20e6, gb: 300, indexed: 2e6, retentionDays: 15 });
    const inside = estimateVendor(datadog, onlySignals(atAllotment, ["metrics", "traces"]), DEFAULT_SETTINGS);
    expect(inside.byBucket.traces).toBeCloseTo(62, 6);

    // One GB and one million indexed spans past the allotment:
    //   $62.00 + 1 x $0.10 + 1 x $1.70 = $63.80
    const past = spans(base(), { hosts: 2, perMonth: 20e6, gb: 301, indexed: 3e6, retentionDays: 15 });
    const over = estimateVendor(datadog, onlySignals(past, ["metrics", "traces"]), DEFAULT_SETTINGS);
    expect(billedOn(over, "spans-ingest")).toBeCloseTo(0.1, 6);
    expect(billedOn(over, "spans-index-15d-annual")).toBeCloseTo(1.7, 6);
    expect(over.byBucket.traces).toBeCloseTo(63.8, 6);
  });

  it("prices traces alone at the standalone APM rate", () => {
    // datadoghq.com/pricing, APM FAQ: standalone APM is $36 per host, billed
    // annually. The same spans as Datadog's example above:
    //   5 x $36 + 25 x $1.70 + 150 x $0.10 = $180 + $42.50 + $15 = $237.50
    const w = spans(base(), { hosts: 5, perMonth: 300e6, gb: 900, indexed: 30e6, retentionDays: 15 });
    const annual = estimateVendor(datadog, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    expect(billedOn(annual, "apm-host-standalone")).toBeCloseTo(180, 6);
    expect(annual.monthly).toBeCloseTo(237.5, 6);
    expect(annual.byBucket.metrics).toBe(0);
    expect(annual.assumptions.join(" ")).toContain("standalone");

    // Month-to-month: no standalone month-to-month price is published, so the
    // $36 figure is reused and the note says so. Indexed spans move to $2.04.
    //   5 x $36 + 25 x $2.04 + 150 x $0.10 = $180 + $51 + $15 = $246.00
    const monthly = estimateVendor(datadog, onlySignals(w, ["traces"]), MONTHLY);
    expect(monthly.monthly).toBeCloseTo(246, 6);
    expect(monthly.notes.join(" ")).toContain("no month-to-month figure");
  });

  it("prices logs alone: ingest on every GB, indexing per million events", () => {
    const w = base();
    w.logs = { gbPerDay: 100, avgRecordBytes: 1000, retentionDays: 15, searchableShare: 1 };
    // 100 GB/day x 30 = 3,000 GB = 3,000 million events at 1,000 bytes each
    //   ingest:   3,000 GB x $0.10 =   $300
    //   indexing: 3,000 M  x $1.70 = $5,100 (15-day, billed annually)
    const annual = estimateVendor(datadog, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(billedOn(annual, "logs-ingest")).toBeCloseTo(300, 6);
    expect(billedOn(annual, "logs-index-15d-annual")).toBeCloseTo(5100, 6);
    expect(annual.monthly).toBeCloseTo(5400, 6);
    expect(annual.byBucket.logs).toBeCloseTo(5400, 6);

    // Month-to-month: indexing is $2.04, ingest stays $0.10
    //   $300 + 3,000 x $2.04 = $300 + $6,120 = $6,420
    const monthly = estimateVendor(datadog, onlySignals(w, ["logs"]), MONTHLY);
    expect(monthly.monthly).toBeCloseTo(6420, 6);
  });

  it("indexes only the searchable share and rounds retention up to a rung", () => {
    const w = base();
    w.logs = { gbPerDay: 100, avgRecordBytes: 500, retentionDays: 5, searchableShare: 0.2 };
    // 3,000 GB at 500 bytes each = 6,000 million events, 20% indexed = 1,200 M
    // 5 days is priced at the 7-day rung:
    //   ingest:   3,000 GB x $0.10 =   $300
    //   indexing: 1,200 M  x $1.27 = $1,524
    const estimate = estimateVendor(datadog, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(billedOn(estimate, "logs-ingest")).toBeCloseTo(300, 6);
    expect(billedOn(estimate, "logs-index-7d-annual")).toBeCloseTo(1524, 6);
    expect(estimate.monthly).toBeCloseTo(1824, 6);
    expect(estimate.assumptions.join(" ")).toContain("7-day");
  });

  it("prices retention past the last published rung at that rung and says so", () => {
    const w = base();
    w.logs = { gbPerDay: 100, avgRecordBytes: 1000, retentionDays: 45, searchableShare: 1 };
    // Standard indexing is published up to 30 days:
    //   $300 + 3,000 M x $2.50 = $300 + $7,500 = $7,800
    const logs = estimateVendor(datadog, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(logs.monthly).toBeCloseTo(7800, 6);
    expect(logs.assumptions[0]).toContain("30-day rate");
    expect(logs.shortRetention).toEqual([{ signal: "logs", asked: 45, kept: 30, unit: "days" }]);

    // Indexed spans: 3 days rounds up to the 7-day rung. On the mid preset,
    // 2,000 spans/s x 2,592,000 s = 5,184 M spans, all indexed, 120 APM hosts:
    //   120 x $31                      = $3,720.00
    //   (5,184 - 120) M x $1.27        = $6,431.28
    //   5,184 GB against 18,000 GB included, no ingest charge
    const t = base();
    t.traces = { ...t.traces, retentionDays: 3 };
    const traces = estimateVendor(datadog, onlySignals(t, ["metrics", "traces"]), DEFAULT_SETTINGS);
    expect(billedOn(traces, "spans-index-7d-annual")).toBeCloseTo(6431.28, 6);
    expect(traces.byBucket.traces).toBeCloseTo(10151.28, 6);
    expect(traces.assumptions.join(" ")).toContain("7-day indexed span rate");
  });

  it("prices metrics alone: hosts, then containers and custom metrics above the allotment", () => {
    // Mid preset: 200 hosts, 10 containers per host, 250,000 series of which
    // 25% are host, container and Kubernetes series. Datadog's OpenTelemetry
    // docs (docs.datadoghq.com/opentelemetry/integrations) say metrics from
    // its supported receivers are collected at no extra cost, so only the
    // other 75% count as custom.
    //   hosts:          200 x $15                               =  $3,000
    //   containers:     2,000 - 5 x 200 = 1,000 x $1            =  $1,000
    //   custom metrics: 250,000 x 0.75 = 187,500 custom series
    //                   187,500 - 100 x 200 = 167,500
    //                   1,675 blocks of 100 x $5                =  $8,375
    const annual = estimateVendor(datadog, onlySignals(base(), ["metrics"]), DEFAULT_SETTINGS);
    expect(billedOn(annual, "infra-pro-annual")).toBeCloseTo(3000, 6);
    expect(billedOn(annual, "containers")).toBeCloseTo(1000, 6);
    expect(billedOn(annual, "custom-metrics")).toBeCloseTo(8375, 6);
    expect(annual.monthly).toBeCloseTo(12375, 6);
    expect(annual.byBucket.metrics).toBeCloseTo(12375, 6);

    // Month-to-month: hosts are $18, containers and custom metrics do not change
    //   200 x $18 + $1,000 + $8,375 = $12,975
    const monthly = estimateVendor(datadog, onlySignals(base(), ["metrics"]), MONTHLY);
    expect(monthly.monthly).toBeCloseTo(12975, 6);
  });

  it("bills only the custom share of series as custom metrics", () => {
    // All series from supported receivers: nothing billed as custom.
    const allHost = base();
    allHost.metrics = { ...allHost.metrics, hostSeriesShare: 1 };
    const hostOnly = estimateVendor(datadog, onlySignals(allHost, ["metrics"]), DEFAULT_SETTINGS);
    expect(billedOn(hostOnly, "custom-metrics")).toBe(0);
    expect(hostOnly.monthly).toBeCloseTo(4000, 6);

    // No host series: 250,000 - 20,000 = 230,000, 2,300 blocks x $5 = $11,500
    const allCustom = base();
    allCustom.metrics = { ...allCustom.metrics, hostSeriesShare: 0 };
    const custom = estimateVendor(datadog, onlySignals(allCustom, ["metrics"]), DEFAULT_SETTINGS);
    expect(billedOn(custom, "custom-metrics")).toBeCloseTo(11500, 6);
  });

  it("charges nothing extra until the pooled host allotments are used up", () => {
    // docs.datadoghq.com/account_management/billing/custom_metrics,
    // "Allocation": on the Pro plan with three hosts, 300 custom metrics are
    // allocated. With 5 containers a host the 15 containers are included too:
    //   3 x $15 = $45 and nothing else
    const w = base();
    w.infra = { ...w.infra, hosts: 3, containersPerHost: 5 };
    w.metrics = { ...w.metrics, activeSeries: 300, hostSeriesShare: 0 };
    const inside = estimateVendor(datadog, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(inside.monthly).toBeCloseTo(45, 6);
    expect(inside.lines).toHaveLength(1);

    // 100 series past the allotment is one block of 100: $45 + $5 = $50
    w.metrics = { ...w.metrics, activeSeries: 400 };
    const oneBlock = estimateVendor(datadog, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(billedOn(oneBlock, "custom-metrics")).toBeCloseTo(5, 6);
    expect(oneBlock.monthly).toBeCloseTo(50, 6);

    // A sixth container per host is 18 - 15 = 3 containers past the allotment:
    //   $50 + 3 x $1 = $53
    w.infra = { ...w.infra, containersPerHost: 6 };
    const moreContainers = estimateVendor(datadog, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(billedOn(moreContainers, "containers")).toBeCloseTo(3, 6);
    expect(moreContainers.monthly).toBeCloseTo(53, 6);
  });

  it("adds up the mid-size preset with all three signals", () => {
    // Worked by hand from datadoghq.com/pricing/list (2026-11-12), US site.
    // 200 hosts (200 x 0.6 = 120 traced), 330 GB of logs a day at 1,000 bytes
    // per event, 2,000 spans a second at 1,000 bytes, 250,000 series (25% host
    // series), 10 containers per host, 30-day log and trace retention.
    //
    // Billed annually:
    //   logs     9,900 GB x $0.10                       =    $990
    //            9,900 M events x $2.50 (30-day)         = $24,750
    //                                                    = $25,740
    //   metrics  200 hosts x $15                         =  $3,000
    //            (2,000 - 5 x 200) containers x $1       =  $1,000
    //            (187,500 - 100 x 200) / 100 x $5        =  $8,375
    //                                                    = $12,375
    //   traces   120 APM hosts x $31                     =  $3,720
    //            2,000 x 2,592,000 = 5,184 M spans = 5,184 GB,
    //            under the 120 x 150 = 18,000 GB included =     $0
    //            (5,184 - 120) M indexed x $2.50 (30-day) = $12,660
    //                                                    = $16,380
    //                                              total = $54,495
    const annual = estimateVendor(datadog, base(), DEFAULT_SETTINGS);
    expect(annual.byBucket.logs).toBeCloseTo(25740, 6);
    expect(annual.byBucket.metrics).toBeCloseTo(12375, 6);
    expect(annual.byBucket.traces).toBeCloseTo(16380, 6);
    expect(annual.byBucket.platform).toBe(0);
    expect(annual.monthly).toBeCloseTo(54495, 6);
    expect(annual.complete).toBe(true);
    // Datadog keeps metrics 15 months for the 13 asked: longer, so no gap.
    expect(annual.shortRetention).toEqual([]);

    // Billed month-to-month:
    //   logs     $990 + 9,900 M x $3.00              = $30,690
    //   metrics  200 x $18 + $1,000 + $8,375         = $12,975
    //   traces   120 x $36 + 5,064 M x $3.00         = $4,320 + $15,192 = $19,512
    //                                          total = $63,177
    const monthly = estimateVendor(datadog, base(), MONTHLY);
    expect(monthly.byBucket.logs).toBeCloseTo(30690, 6);
    expect(monthly.byBucket.metrics).toBeCloseTo(12975, 6);
    expect(monthly.byBucket.traces).toBeCloseTo(19512, 6);
    expect(monthly.monthly).toBeCloseTo(63177, 6);
  });

  it("prices 100 GB of logs a day alone at 30-day retention", () => {
    // datadoghq.com/pricing/list: ingest $0.10 per GB, 30-day standard
    // indexing $2.50 per 1M events annually and $3.00 month-to-month.
    //   100 GB/day x 30 days = 3,000 GB; at 1,000 bytes = 3,000 M events
    //   annual:  3,000 x $0.10 + 3,000 x $2.50 = $300 + $7,500 = $7,800
    //   monthly: 3,000 x $0.10 + 3,000 x $3.00 = $300 + $9,000 = $9,300
    const w = base();
    w.logs = { gbPerDay: 100, avgRecordBytes: 1000, retentionDays: 30, searchableShare: 1 };
    const annual = estimateVendor(datadog, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(billedOn(annual, "logs-ingest")).toBeCloseTo(300, 6);
    expect(billedOn(annual, "logs-index-30d-annual")).toBeCloseTo(7500, 6);
    expect(annual.monthly).toBeCloseTo(7800, 6);
    expect(annual.shortRetention).toEqual([]);
    const monthly = estimateVendor(datadog, onlySignals(w, ["logs"]), MONTHLY);
    expect(monthly.monthly).toBeCloseTo(9300, 6);
  });

  it("reports retention past the published rungs as kept, first in the assumptions", () => {
    const w = base();
    w.logs = { ...w.logs, retentionDays: 90 };
    w.traces = { ...w.traces, retentionDays: 60 };
    w.metrics = { ...w.metrics, retentionMonths: 24 };
    const estimate = estimateVendor(datadog, w, DEFAULT_SETTINGS);
    expect(estimate.shortRetention).toEqual(
      expect.arrayContaining([
        { signal: "logs", asked: 90, kept: 30, unit: "days" },
        { signal: "traces", asked: 60, kept: 30, unit: "days" },
        { signal: "metrics", asked: 24, kept: 15, unit: "months" },
      ]),
    );
    expect(estimate.assumptions.slice(0, 3).join(" ")).toMatch(/Metrics.*Logs.*Traces/);
  });

  it("adds up the Kubernetes preset, where containers run past the allotment", () => {
    // 50 nodes, all traced, 30 containers each, 100 GB of logs a day,
    // 600 spans a second, 250,000 series. Billed annually:
    //   logs     3,000 GB x $0.10 + 3,000 M x $2.50                    =  $7,800
    //   metrics  90% of series are host series, so 25,000 are custom:
    //            50 x $15 + (1,500 - 250) x $1 + (25,000 - 5,000) / 100 x $5
    //            = $750 + $1,250 + $1,000                              =  $3,000
    //   traces   50 x $31 + (1,555.2 - 50) M x $2.50 = $1,550 + $3,763 =  $5,313
    //            1,555.2 GB of spans against 7,500 GB included
    //                                                            total = $16,113
    const estimate = estimateVendor(datadog, presetById("kubernetes")!.workload, DEFAULT_SETTINGS);
    expect(estimate.byBucket.logs).toBeCloseTo(7800, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(3000, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(5313, 6);
    expect(estimate.monthly).toBeCloseTo(16113, 6);
  });

  it("bills no host fee for a signal that is switched on but empty", () => {
    // Traces on with no spans: no APM hosts, whatever the traced share says.
    const noSpans = base();
    noSpans.traces = { ...noSpans.traces, spansPerSecond: 0 };
    const withoutSpans = estimateVendor(datadog, noSpans, DEFAULT_SETTINGS);
    expect(withoutSpans.byBucket.traces).toBe(0);
    expect(withoutSpans.monthly).toBeCloseTo(25740 + 12375, 6);

    // Metrics on with no series: no Infrastructure hosts, so APM is standalone.
    //   traces 120 x $36 + 5,064 M x $2.50 = $4,320 + $12,660 = $16,980
    const noSeries = base();
    noSeries.metrics = { ...noSeries.metrics, activeSeries: 0 };
    const withoutSeries = estimateVendor(datadog, noSeries, DEFAULT_SETTINGS);
    expect(withoutSeries.byBucket.metrics).toBe(0);
    expect(withoutSeries.byBucket.traces).toBeCloseTo(16980, 6);
  });

  it("gives the same price in both regions and at every query load", () => {
    // The price list shows the same rates for the US and EU sites and has no
    // query charge, so the mid preset stays at $54,495 billed annually.
    const estimate = estimateVendor(datadog, base(), { term: "annual", region: "eu", queryLoad: "heavy" });
    expect(estimate.monthly).toBeCloseTo(54495, 6);
  });
});

describe("Datadog: continuous profiling", () => {
  it("prices the standalone Continuous Profiler per host, with pooled containers", () => {
    // Mid preset, profiling on: 200 hosts × 50% = 100 profiled hosts, 10 containers each.
    //   hosts       100 × $19 (annual)                          = $1,900
    //   containers  1,000 less 400 included (4 per host) = 600 × $2 = $1,200
    const w = base();
    w.send.profiles = true;
    const annual = estimateVendor(datadog, onlySignals(w, ["profiles"]), DEFAULT_SETTINGS);
    expect(annual.byBucket.profiles).toBeCloseTo(3_100, 6);
    expect(annual.monthly).toBeCloseTo(3_100, 6);
    // Month-to-month: 100 × $23 + $1,200 = $3,500.
    const monthly = estimateVendor(datadog, onlySignals(w, ["profiles"]), {
      ...DEFAULT_SETTINGS,
      term: "monthly",
    });
    expect(monthly.monthly).toBeCloseTo(3_500, 6);
    // Billed per host: the sample rate does not change it.
    w.profiles.samplesPerSecondPerHost = 400;
    expect(estimateVendor(datadog, onlySignals(w, ["profiles"]), DEFAULT_SETTINGS).monthly).toBeCloseTo(3_100, 6);
  });
});
