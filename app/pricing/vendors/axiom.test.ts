import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import type { VendorEstimate, Workload } from "../types";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { axiom } from "./axiom";

const base = (): Workload => structuredClone(presetById("mid")!.workload);

/**
 * Axiom's rate card is written in GB and its terms measure data loading in
 * GiB, so the vendor's examples are reproduced by sending exactly that
 * many GiB. This is the decimal GB (10^9 bytes) that arrives as `gib` GiB.
 */
const gibAsGb = (gib: number) => (gib * 2 ** 30) / 1e9;

/** A logs-only workload that sends `gib` GiB a month, kept `days` days. */
const logsOf = (gib: number, days: number): Workload => {
  const w = base();
  w.logs = { ...w.logs, gbPerDay: gibAsGb(gib) / 30, retentionDays: days };
  return onlySignals(w, ["logs"]);
};

const sumOf = (estimate: VendorEstimate, labelStart: string) =>
  estimate.lines
    .filter((line) => line.label.startsWith(labelStart))
    .reduce((sum, line) => sum + line.amount, 0);

describe("Axiom: worked examples", () => {
  it("matches the rate card's 1 PB worked example on ingest and storage", () => {
    // axiom.co/pricing/llms.txt, "Worked example": 1,000,000 GB a month,
    // 12-month retention, 95% compression, pay as you go, $142,309.56 in all.
    //   data loading  99,000 x 0.12 + 400,000 x 0.10 + 500,000 x 0.085 = 94,380
    //   storage       1,000,000 x 5% = 50,000, less 100 free = 49,900 a month
    //                 2 months  99,800 x 0.03    = 2,994.00
    //                 2 months  99,800 x 0.0163  = 1,626.74
    //                 8 months 399,200 x 0.00522 = 2,083.824
    // The rate card's example queries at its Base guidance (0.40 GB-hours
    // per GB = 41,200). This adapter uses the pricing page calculator's Base
    // preset, 0.25 GB-hours per GB, so the query line differs:
    //   query         1,000,000 x 0.25 = 250,000 GB-hours, first 100 free:
    //                 400 x 0.20 + 4,500 x 0.16 + 45,000 x 0.12 + 200,000 x 0.10 = 26,200
    //   total         25 + 94,380 + 26,200 + 6,704.564 = 127,309.564
    //   rate card     127,309.564 - 26,200 + 41,200 = 142,309.564, the printed figure
    const estimate = estimateVendor(axiom, logsOf(1_000_000, 360), DEFAULT_SETTINGS);
    expect(estimate.byBucket.platform).toBe(25);
    expect(sumOf(estimate, "Log ingestion")).toBeCloseTo(94_380, 4);
    expect(sumOf(estimate, "Query compute on logs")).toBeCloseTo(26_200, 4);
    expect(sumOf(estimate, "Log storage")).toBeCloseTo(6_704.564, 4);
    expect(estimate.monthly).toBeCloseTo(127_309.564, 4);
    expect((estimate.monthly - 26_200 + 41_200).toFixed(2)).toBe("142309.56");
    expect(estimate.complete).toBe(true);
  });

  it("crosses a tier edge like the rate card's data loading example: 150,000 GB is 16,880 credits", () => {
    // axiom.co/pricing/llms.txt, "Data loading compute": first 1,000 GB free,
    // 99,000 x 0.12 = 11,880, then 50,000 x 0.10 = 5,000. A credit is $1.
    const estimate = estimateVendor(axiom, logsOf(150_000, 30), DEFAULT_SETTINGS);
    const ingest = estimate.lines.filter((line) => line.label.startsWith("Log ingestion"));
    expect(ingest.map((line) => line.rateId)).toEqual(["ingest-1", "ingest-2"]);
    expect(ingest[0].quantity).toBeCloseTo(99_000, 4);
    expect(ingest[0].amount).toBeCloseTo(11_880, 4);
    expect(ingest[1].quantity).toBeCloseTo(50_000, 4);
    expect(ingest[1].amount).toBeCloseTo(5_000, 4);
    expect(sumOf(estimate, "Log ingestion")).toBeCloseTo(16_880, 4);
  });

  it("matches the rate card's storage example: 100,000 GB a month kept 12 months is $658.36", () => {
    // axiom.co/pricing/llms.txt, "Storage": 100,000 x 5% = 5,000, less 100
    // free = 4,900 a month, x 12 months = 58,800 held.
    //   Frequent Access   2 months  9,800 x 0.03    = 294.00
    //   Infrequent Access 2 months  9,800 x 0.0163  = 159.74
    //   Archive Instant   8 months 39,200 x 0.00522 = 204.624
    const estimate = estimateVendor(axiom, logsOf(100_000, 360), DEFAULT_SETTINGS);
    const storage = estimate.lines.filter((line) => line.label.startsWith("Log storage"));
    expect(storage.map((line) => line.rateId)).toEqual([
      "storage-frequent",
      "storage-infrequent",
      "storage-archive",
    ]);
    expect(storage[0].quantity).toBeCloseTo(9_800, 4);
    expect(storage[1].quantity).toBeCloseTo(9_800, 4);
    expect(storage[2].quantity).toBeCloseTo(39_200, 4);
    expect(sumOf(estimate, "Log storage")).toBeCloseTo(658.364, 4);
  });

  it("prices logs alone: 10,000 GiB a month kept 30 days", () => {
    //   ingest   (10,000 - 1,000 free) x 0.12 = 1,080
    //   query    10,000 x 0.25 = 2,500 GB-hours: 400 x 0.20 + 2,000 x 0.16 = 400
    //   storage  10,000 x 5% = 500, less 100 free = 400, all under 60 days old: 400 x 0.03 = 12
    //   total    25 + 1,080 + 400 + 12 = 1,517
    const estimate = estimateVendor(axiom, logsOf(10_000, 30), DEFAULT_SETTINGS);
    expect(sumOf(estimate, "Log ingestion")).toBeCloseTo(1_080, 6);
    expect(sumOf(estimate, "Query compute on logs")).toBeCloseTo(400, 6);
    expect(sumOf(estimate, "Log storage")).toBeCloseTo(12, 6);
    expect(estimate.byBucket.logs).toBeCloseTo(1_492, 6);
    expect(estimate.byBucket.platform).toBe(25);
    expect(estimate.byBucket.metrics).toBe(0);
    expect(estimate.byBucket.traces).toBe(0);
    expect(estimate.monthly).toBeCloseTo(1_517, 6);
  });

  it("prices the retention asked for through storage: the same logs kept 90 days", () => {
    //   stored   10,000 x 5% = 500, less 100 free = 400 GiB a month
    //   days 0 to 60   400 x 60/30 = 800 GiB x 0.03   = 24.00
    //   days 60 to 90  400 x 30/30 = 400 GiB x 0.0163 =  6.52
    //   storage  30.52, and ingest and query are unchanged: 25 + 1,080 + 400 + 30.52 = 1,535.52
    const estimate = estimateVendor(axiom, logsOf(10_000, 90), DEFAULT_SETTINGS);
    const storage = estimate.lines.filter((line) => line.label.startsWith("Log storage"));
    expect(storage.map((line) => line.rateId)).toEqual(["storage-frequent", "storage-infrequent"]);
    expect(storage[0].quantity).toBeCloseTo(800, 6);
    expect(storage[1].quantity).toBeCloseTo(400, 6);
    expect(sumOf(estimate, "Log storage")).toBeCloseTo(30.52, 6);
    expect(estimate.monthly).toBeCloseTo(1_535.52, 6);
  });

  it("worked example (b): 100 GB of logs a day alone, kept 30 days, is $353.23", () => {
    // From axiom.co/pricing and its rate card, by hand, default settings:
    //   sent     100 GB/day x 30 = 3,000 GB = 3,000 x 10^9 / 2^30 = 2,793.9677 GiB
    //   platform 25
    //   ingest   (2,793.9677 - 1,000 free) x 0.12 = 1,793.9677 x 0.12 = 215.2761
    //   query    Base preset: 2,793.9677 x 0.25 = 698.4919 GB-hours, first 100 free:
    //            400 x 0.20 + 198.4919 x 0.16 = 80 + 31.7587 = 111.7587
    //   storage  2,793.9677 x 5% = 139.6984 GiB, less 100 free = 39.6984,
    //            all under 60 days old: 39.6984 x 0.03 = 1.1910
    //   total    25 + 215.2761 + 111.7587 + 1.1910 = 353.2258
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };
    const estimate = estimateVendor(axiom, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    const ingest = estimate.lines.filter((line) => line.label.startsWith("Log ingestion"));
    expect(ingest).toHaveLength(1);
    expect(ingest[0].quantity).toBeCloseTo(1_793.9677, 3);
    expect(ingest[0].amount).toBeCloseTo(215.2761, 3);
    expect(sumOf(estimate, "Query compute on logs")).toBeCloseTo(111.7587, 3);
    expect(sumOf(estimate, "Log storage")).toBeCloseTo(1.191, 3);
    expect(estimate.monthly).toBeCloseTo(353.2258, 3);
    expect(estimate.shortRetention).toEqual([]);
    expect(estimate.assumptions.join(" ")).toContain("0.931 GiB");
  });

  it("worked example (a): the mid preset with default settings is $2,421.63", () => {
    // From axiom.co/pricing and its rate card, by hand:
    //   logs     330 GB/day x 30                   = 9,900 GB = 9,220.0935 GiB
    //   traces   2,000 spans/s x 2,592,000 x 1,000 B = 5,184 GB = 4,827.9762 GiB
    //   metrics  250,000 series x 43,200 x 150 B    = 1,620 GB = 1,508.7426 GiB
    //   total    16,704 GB = 15,556.8123 GiB
    //   platform 25
    //   ingest   (15,556.8123 - 1,000) x 0.12 = 1,746.8175
    //   query    Base preset: 15,556.8123 x 0.25 = 3,889.2031 GB-hours:
    //            400 x 0.20 + 3,389.2031 x 0.16 = 80 + 542.2725 = 622.2725
    //   storage  15,556.8123 x 5% = 777.8406 GiB a month, less 100 free: 87.1439% is paid
    //            logs     9,220.0935 x 5% x 0.871439 = 401.7374, 30 days x 0.03 = 12.0521
    //            traces   4,827.9762 x 5% x 0.871439 = 210.3643, 30 days x 0.03 =  6.3109
    //            metrics  1,508.7426 x 5% x 0.871439 =  65.7389 a month kept 390 days:
    //                     131.4777 x 0.03 + 131.4777 x 0.0163 + 591.6497 x 0.00522 = 9.1758
    //            storage  27.5389
    //   total    25 + 1,746.8175 + 622.2725 + 27.5389 = 2,421.6288
    const estimate = estimateVendor(axiom, presetById("mid")!.workload, DEFAULT_SETTINGS);
    const ingest =
      sumOf(estimate, "Log ingestion") +
      sumOf(estimate, "Metric ingestion") +
      sumOf(estimate, "Trace ingestion");
    expect(ingest).toBeCloseTo(1_746.8175, 3);
    expect(sumOf(estimate, "Query compute on")).toBeCloseTo(622.2725, 3);
    expect(
      sumOf(estimate, "Log storage") + sumOf(estimate, "Metric storage") + sumOf(estimate, "Trace storage"),
    ).toBeCloseTo(27.5389, 3);
    expect(estimate.byBucket.platform).toBe(25);
    expect(estimate.monthly).toBeCloseTo(2_421.6288, 3);
    expect(estimate.complete).toBe(true);
    expect(estimate.shortRetention).toEqual([]);
  });

  it("prices metrics alone by GB: 1M series at 60 s kept 13 months", () => {
    //   sent     1,000,000 x 43,200 = 43.2B data points x 150 bytes = 6,480 GB = 6,034.9703 GiB
    //   ingest   (6,034.9703 - 1,000) x 0.12 = 604.1964
    //   query    6,034.9703 x 0.25 = 1,508.7426 GB-hours: 400 x 0.20 + 1,008.7426 x 0.16 = 241.3988
    //   storage  6,034.9703 x 5% = 301.7485, less 100 = 201.7485 a month, kept 390 days
    //            2 months   403.4970 x 0.03    = 12.1049
    //            2 months   403.4970 x 0.0163  =  6.5770
    //            9 months 1,815.7366 x 0.00522 =  9.4781
    //   total    25 + 604.1964 + 241.3988 + 28.1601 = 898.7553
    const w = base();
    w.metrics = {
      ...w.metrics,
      activeSeries: 1_000_000,
      intervalSeconds: 60,
      bytesPerDataPoint: 150,
      retentionMonths: 13,
    };
    const estimate = estimateVendor(axiom, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(sumOf(estimate, "Metric ingestion")).toBeCloseTo(604.1964, 3);
    expect(sumOf(estimate, "Query compute on metrics")).toBeCloseTo(241.3988, 3);
    expect(sumOf(estimate, "Metric storage")).toBeCloseTo(28.1601, 3);
    expect(estimate.byBucket.logs).toBe(0);
    expect(estimate.byBucket.traces).toBe(0);
    expect(estimate.monthly).toBeCloseTo(898.7553, 3);
  });

  it("prices traces alone: 1,000 spans a second kept 30 days", () => {
    //   sent     1,000 x 2,592,000 = 2.592B spans x 1,000 bytes = 2,592 GB = 2,413.9881 GiB
    //   ingest   (2,413.9881 - 1,000) x 0.12 = 169.6786
    //   query    2,413.9881 x 0.25 = 603.4970 GB-hours: 400 x 0.20 + 103.4970 x 0.16 = 96.5595
    //   storage  2,413.9881 x 5% = 120.6994, less 100 = 20.6994 x 0.03 = 0.6210
    //   total    25 + 169.6786 + 96.5595 + 0.6210 = 291.8591
    const w = base();
    w.traces = { ...w.traces, spansPerSecond: 1_000, avgSpanBytes: 1_000, retentionDays: 30 };
    const estimate = estimateVendor(axiom, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    expect(sumOf(estimate, "Trace ingestion")).toBeCloseTo(169.6786, 3);
    expect(sumOf(estimate, "Query compute on traces")).toBeCloseTo(96.5595, 3);
    expect(sumOf(estimate, "Trace storage")).toBeCloseTo(0.621, 3);
    expect(estimate.byBucket.logs).toBe(0);
    expect(estimate.byBucket.metrics).toBe(0);
    expect(estimate.monthly).toBeCloseTo(291.8591, 3);
  });

  it("bills only the platform fee inside the Always Free allowance", () => {
    //   sent     20 GB/day x 30 = 600 GB = 558.7935 GiB, under the 1,000 free
    //   query    light: 558.7935 x 0.05 = 27.9397 GB-hours, under the 100 free
    //   storage  558.7935 x 5% = 27.9397 GiB a month, under the 100 free
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 20, retentionDays: 30 };
    const light = estimateVendor(axiom, onlySignals(w, ["logs"]), {
      ...DEFAULT_SETTINGS,
      queryLoad: "light",
    });
    expect(light.lines).toHaveLength(1);
    expect(light.lines[0].rateId).toBe("platform-fee");
    expect(light.monthly).toBe(25);
    expect(light.assumptions.join(" ")).toContain("fits inside");

    // The same data queried at the typical load leaves the query allowance:
    // 558.7935 x 0.25 = 139.6984 GB-hours, (139.6984 - 100) x 0.20 = 7.9397
    const typical = estimateVendor(axiom, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(typical.monthly).toBeCloseTo(32.9397, 3);
  });

  it("maps query load onto the pricing page calculator's Low, Base and High presets", () => {
    // 10,000 GiB ingested, GB-hours per GB from the calculator on axiom.co/pricing:
    //   light   x 0.05 =    500 GB-hours: 400 x 0.20 = 80
    //   typical x 0.25 =  2,500 GB-hours: 400 x 0.20 + 2,000 x 0.16 = 400
    //   heavy   x 1.50 = 15,000 GB-hours: 400 x 0.20 + 4,500 x 0.16 + 10,000 x 0.12 = 2,000
    const w = logsOf(10_000, 30);
    const at = (queryLoad: "light" | "typical" | "heavy") =>
      estimateVendor(axiom, w, { ...DEFAULT_SETTINGS, queryLoad });
    expect(sumOf(at("light"), "Query compute")).toBeCloseTo(80, 6);
    expect(sumOf(at("typical"), "Query compute")).toBeCloseTo(400, 6);
    expect(sumOf(at("heavy"), "Query compute")).toBeCloseTo(2_000, 6);
    expect(at("light").assumptions.join(" ")).toContain("Low");
    expect(at("typical").assumptions.join(" ")).toContain("Base");
    expect(at("heavy").assumptions.join(" ")).toContain("High");
  });

  it("shares the tiers and allowances between signals by volume", () => {
    //   logs     200 GB/day x 30                    = 6,000 GB  (50.7099%)
    //   metrics  500,000 series x 43,200 x 150 B    = 3,240 GB  (27.3834%)
    //   traces   1,000 spans/s x 2,592,000 x 1,000 B = 2,592 GB  (21.9067%)
    //   total    11,832 GB = 11,019.4087 GiB
    //   ingest   (11,019.4087 - 1,000) x 0.12 = 1,202.3290
    //   query    11,019.4087 x 0.25 = 2,754.8522 GB-hours: 400 x 0.20 + 2,254.8522 x 0.16 = 440.7763
    //   storage  11,019.4087 x 5% = 550.9704 GiB a month, less 100: 81.8502% is paid
    //            logs    279.3968 x 0.818502 = 228.6868, 30 days: x 0.03 = 6.8606
    //            traces  120.6994 x 0.818502 =  98.7927, 30 days: x 0.03 = 2.9638
    //            metrics 150.8743 x 0.818502 = 123.4909 a month, 390 days:
    //                    246.9818 x 0.03 + 246.9818 x 0.0163 + 1,111.4180 x 0.00522 = 17.2369
    //   buckets  logs    1,643.1054 x 0.507099 + 6.8606  = 840.0783
    //            metrics 1,643.1054 x 0.273834 + 17.2369 = 467.1744
    //            traces  1,643.1054 x 0.219067 + 2.9638  = 362.9138
    //   total    25 + 1,202.3290 + 440.7763 + 27.0612 = 1,695.1666
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 200, retentionDays: 30 };
    w.metrics = {
      ...w.metrics,
      activeSeries: 500_000,
      intervalSeconds: 60,
      bytesPerDataPoint: 150,
      retentionMonths: 13,
    };
    w.traces = { ...w.traces, spansPerSecond: 1_000, avgSpanBytes: 1_000, retentionDays: 30 };
    const estimate = estimateVendor(axiom, w, DEFAULT_SETTINGS);

    const ingest =
      sumOf(estimate, "Log ingestion") +
      sumOf(estimate, "Metric ingestion") +
      sumOf(estimate, "Trace ingestion");
    expect(ingest).toBeCloseTo(1_202.329, 3);
    expect(sumOf(estimate, "Log ingestion")).toBeCloseTo(1_202.329 * (6_000 / 11_832), 3);
    expect(sumOf(estimate, "Query compute on")).toBeCloseTo(440.7763, 3);
    expect(estimate.byBucket.logs).toBeCloseTo(840.0783, 3);
    expect(estimate.byBucket.metrics).toBeCloseTo(467.1744, 3);
    expect(estimate.byBucket.traces).toBeCloseTo(362.9138, 3);
    expect(estimate.byBucket.platform).toBe(25);
    expect(estimate.monthly).toBeCloseTo(1_695.1666, 3);
  });

  it("charges the platform fee once and ignores term and region", () => {
    const w = base();
    const all = estimateVendor(axiom, w, DEFAULT_SETTINGS);
    const fees = all.lines.filter((line) => line.rateId === "platform-fee");
    expect(fees).toHaveLength(1);
    expect(fees[0].amount).toBe(25);

    // Axiom publishes one pay-as-you-go price list for both regions.
    const monthlyEu = estimateVendor(axiom, w, {
      term: "monthly",
      region: "eu",
      queryLoad: "typical",
    });
    expect(monthlyEu.monthly).toBe(all.monthly);
    expect(axiom.plan(DEFAULT_SETTINGS)).toBe("Axiom Cloud, pay as you go");

    // One queryable store: the searchable share does not change the price.
    const partlySearchable = base();
    partlySearchable.logs = { ...partlySearchable.logs, searchableShare: 0.2 };
    partlySearchable.traces = { ...partlySearchable.traces, searchableShare: 0.2 };
    expect(estimateVendor(axiom, partlySearchable, DEFAULT_SETTINGS).monthly).toBe(all.monthly);
  });
});
