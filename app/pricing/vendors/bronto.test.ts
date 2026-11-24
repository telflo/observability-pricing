import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import type { Settings, VendorEstimate, Workload } from "../types";
import { PRESETS, presetById, DEFAULT_SETTINGS } from "../workloads";
import { bronto } from "./bronto";

// Read on bronto.io/pricing on 2026-11-12:
//   Starter  $10 a month, printed beside a struck-through $25 under a "New" label. The page
//            title, bronto.io/starterplan and Bronto's calculator all give $10 with no end
//            date, so $10 is the list price. Covers 1 TB of ingest and 20× search (20 TB).
//   Pro      $500 a month. Covers 5 TB of ingest and 100× search (500 TB).
//   Usage    $0.10 per GB ingested and $1.00 per TB searched: the Enterprise rates, and the
//            overage rates on both plans.
//   Annual   the toggle says "2 months free" but the page text prints no annual figure, so
//            both terms use the monthly prices.
// Scanned volume is ingested GB × SCAN_MULTIPLE: 5 (light), 20 (typical), 100 (heavy).
// A TB is 1,000 GB.
const TYPICAL: Settings = { term: "monthly", region: "us", queryLoad: "typical" };
const ANNUAL: Settings = { ...TYPICAL, term: "annual" };
const LIGHT: Settings = { ...TYPICAL, queryLoad: "light" };
const HEAVY: Settings = { ...TYPICAL, queryLoad: "heavy" };

/** The mid-size preset, with every number these examples depend on written out. */
const mid = (): Workload => {
  const w = structuredClone(presetById("mid")!.workload);
  w.logs = { ...w.logs, gbPerDay: 330, retentionDays: 30, searchableShare: 1 };
  w.metrics = {
    ...w.metrics,
    activeSeries: 250_000,
    intervalSeconds: 60,
    bytesPerDataPoint: 150,
    retentionMonths: 13,
  };
  w.traces = {
    ...w.traces,
    spansPerSecond: 2000,
    avgSpanBytes: 1000,
    retentionDays: 30,
    searchableShare: 1,
  };
  return w;
};

/** Logs alone at a daily volume. 100 GB a day is 3,000 GB a month. */
const logsOnly = (gbPerDay: number, retentionDays = 30): Workload => {
  const w = mid();
  w.logs = { ...w.logs, gbPerDay, retentionDays };
  return onlySignals(w, ["logs"]);
};

/** Traces alone: 1,000 spans/s × 2,592,000 s × 1,000 bytes = 2,592 GB a month. */
const tracesOnly = (): Workload => {
  const w = mid();
  w.traces = { ...w.traces, spansPerSecond: 1000, avgSpanBytes: 1000 };
  return onlySignals(w, ["traces"]);
};

/** Metrics alone: 100,000 series × 43,200 points a month × 150 bytes = 648 GB a month. */
const metricsOnly = (retentionMonths = 13): Workload => {
  const w = mid();
  w.metrics = {
    ...w.metrics,
    activeSeries: 100_000,
    intervalSeconds: 60,
    bytesPerDataPoint: 150,
    retentionMonths,
  };
  return onlySignals(w, ["metrics"]);
};

/** Dollars billed at one rate, whichever signals the lines belong to. */
const amountAt = (estimate: VendorEstimate, rateId: string) =>
  estimate.lines.filter((l) => l.rateId === rateId).reduce((sum, l) => sum + l.amount, 0);

const rateIds = (estimate: VendorEstimate) => [...new Set(estimate.lines.map((l) => l.rateId))].sort();

describe("Bronto: worked examples", () => {
  it("prices the mid preset with the default settings at $2,004.48 a month", () => {
    // DEFAULT_SETTINGS: annual, US, typical query load (20×).
    //   logs     330 GB/day × 30 days                       =  9,900 GB
    //   metrics  250,000 series × 43,200 points × 150 bytes =  1,620 GB
    //   traces   2,000 spans/s × 2,592,000 s × 1,000 bytes  =  5,184 GB
    //   total                                                 16,704 GB, past Pro's 5 TB
    // So the usage rates apply to the whole volume (no annual price is published):
    //   logs     9,900 × $0.10 =   $990.00 + 198 TB × $1     =   $198.00 -> $1,188.00
    //   metrics  1,620 × $0.10 =   $162.00 + 32.4 TB × $1    =    $32.40 ->   $194.40
    //   traces   5,184 × $0.10 =   $518.40 + 103.68 TB × $1  =   $103.68 ->   $622.08
    //   total    $1,670.40 ingest + $334.08 search = $2,004.48
    const estimate = estimateVendor(bronto, presetById("mid")!.workload, DEFAULT_SETTINGS);
    expect(rateIds(estimate)).toEqual(["ingest", "search"]);
    expect(amountAt(estimate, "ingest")).toBeCloseTo(1670.4, 6);
    expect(amountAt(estimate, "search")).toBeCloseTo(334.08, 6);
    expect(estimate.byBucket.logs).toBeCloseTo(1188, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(194.4, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(622.08, 6);
    expect(estimate.byBucket.platform).toBe(0);
    expect(estimate.monthly).toBeCloseTo(2004.48, 6);
    expect(estimate.complete).toBe(true);
    // Metrics are asked for 13 months; every plan keeps 12. Logs and traces get 365 days.
    expect(estimate.shortRetention).toEqual([
      { signal: "metrics", asked: 13, kept: 12, unit: "months" },
    ]);
    expect(estimate.assumptions[0]).toContain("metrics are asked for 13 months");

    // Light (5×): $1,670.40 + 83.52 TB × $1 = $1,753.92. Heavy (100×): $1,670.40 + $1,670.40.
    expect(estimateVendor(bronto, mid(), LIGHT).monthly).toBeCloseTo(1753.92, 6);
    expect(estimateVendor(bronto, mid(), HEAVY).monthly).toBeCloseTo(3340.8, 6);
    // Region, term, hosts and users change nothing.
    expect(estimateVendor(bronto, mid(), { ...ANNUAL, region: "eu" }).monthly).toBeCloseTo(2004.48, 6);
  });

  it("prices 100 GB a day of logs alone at 30 days at the $500 Pro fee", () => {
    // 100 GB/day × 30 days = 3,000 GB; typical load scans 3,000 × 20 = 60,000 GB = 60 TB.
    // Past Starter (1 TB), inside Pro (5 TB, 500 TB): Pro at $500, as Bronto's calculator
    // prices it. The usage rates ($300 + $60 = $360) are only overage below Pro.
    for (const s of [DEFAULT_SETTINGS, TYPICAL]) {
      const estimate = estimateVendor(bronto, logsOnly(100, 30), s);
      expect(rateIds(estimate)).toEqual(["pro"]);
      expect(estimate.byBucket.platform).toBeCloseTo(500, 6);
      expect(estimate.monthly).toBeCloseTo(500, 6);
      expect(estimate.assumptions.join(" ")).toContain("usage rates alone would come to $360.00");
      // 30 days asked, 365 kept: longer, so no retention gap.
      expect(estimate.shortRetention).toEqual([]);
    }
    // Heavy (100×): 300 TB scanned. Usage would be $300 + $300 = $600, so Pro at $500.
    const heavy = estimateVendor(bronto, logsOnly(100), HEAVY);
    expect(rateIds(heavy)).toEqual(["pro"]);
    expect(heavy.monthly).toBeCloseTo(500, 6);
  });

  it("matches Bronto's calculator at its default inputs: $1,030 a month at 100×", () => {
    // bronto.io/observability-cost-calculator opens on 100 GB/day of logs, 50 GB/day of
    // traces, 100,000 series at 60 s and 150 bytes a point, and 100× search, and shows
    // $515 of ingest + $515 of search = $1,030 a month. 100× is the heavy load here.
    const w = mid();
    w.logs = { ...w.logs, gbPerDay: 100 }; // 3,000 GB
    w.traces = { ...w.traces, spansPerSecond: 50e9 / 86_400 / 1000, avgSpanBytes: 1000 }; // 1,500 GB
    w.metrics = { ...w.metrics, activeSeries: 100_000, intervalSeconds: 60, bytesPerDataPoint: 150 }; // 648 GB
    // 5,148 GB is past Pro: 5,148 × $0.10 = $514.80 + 514.8 TB × $1 = $514.80.
    const estimate = estimateVendor(bronto, w, HEAVY);
    expect(amountAt(estimate, "ingest")).toBeCloseTo(514.8, 6);
    expect(amountAt(estimate, "search")).toBeCloseTo(514.8, 6);
    expect(Math.round(estimate.monthly)).toBe(1030);
  });

  it("moves to usage rates on the whole volume past the Pro plan", () => {
    // Typical (20×). 200 GB/day = 6,000 GB, past Pro: $600 + 120 TB × $1 = $720.
    const past = estimateVendor(bronto, logsOnly(200), TYPICAL);
    expect(rateIds(past)).toEqual(["ingest", "search"]);
    expect(past.monthly).toBeCloseTo(720, 6);
    expect(past.assumptions.join(" ")).toContain("prices a month past Pro the same way");

    // Heavy (100×). 166 GB/day = 4,980 GB, 498 TB: inside Pro, usage $996, so Pro at $500.
    const inside = estimateVendor(bronto, logsOnly(166), HEAVY);
    expect(rateIds(inside)).toEqual(["pro"]);
    expect(inside.monthly).toBeCloseTo(500, 6);
    // 167 GB/day = 5,010 GB, 501 TB: past Pro. $501 + $501 = $1,002.
    const heavyPast = estimateVendor(bronto, logsOnly(167), HEAVY);
    expect(heavyPast.monthly).toBeCloseTo(1002, 6);
  });

  it("takes the Pro plan for any month past Starter that fits inside it", () => {
    // Typical (20×): 130 GB/day = 3,900 GB, usage $468, under $500: still Pro.
    expect(rateIds(estimateVendor(bronto, logsOnly(130), TYPICAL))).toEqual(["pro"]);
    expect(estimateVendor(bronto, logsOnly(130), TYPICAL).monthly).toBeCloseTo(500, 6);
    // 150 GB/day = 4,500 GB -> $450 + $90 = $540: Pro at $500, on either term.
    for (const s of [TYPICAL, ANNUAL]) {
      const pro = estimateVendor(bronto, logsOnly(150), s);
      expect(rateIds(pro)).toEqual(["pro"]);
      expect(pro.monthly).toBeCloseTo(500, 6);
    }
    // Heavy (100×): 80 GB/day (usage $480) and 90 GB/day (usage $540) are both Pro.
    expect(estimateVendor(bronto, logsOnly(80), HEAVY).monthly).toBeCloseTo(500, 6);
    expect(rateIds(estimateVendor(bronto, logsOnly(90), HEAVY))).toEqual(["pro"]);
  });

  it("prices 1 TB a month at the $10 Starter list price and names the struck-through $25", () => {
    // 1,000 GB a month at 20× scans 20 TB: exactly the Starter allowance.
    for (const s of [TYPICAL, ANNUAL]) {
      const estimate = estimateVendor(bronto, logsOnly(1000 / 30), s);
      expect(rateIds(estimate)).toEqual(["starter"]);
      expect(estimate.byBucket.platform).toBeCloseTo(10, 6);
      expect(estimate.monthly).toBeCloseTo(10, 6);
      expect(estimate.notes.join(" ")).toContain("$10.00 a month beside a struck-through $25.00");
    }
    // The struck-through price is never billed.
    for (const preset of PRESETS) {
      for (const s of [TYPICAL, LIGHT, HEAVY]) {
        for (const factor of [0.001, 0.01, 0.1, 1]) {
          const w = structuredClone(preset.workload);
          w.logs.gbPerDay *= factor;
          w.metrics.activeSeries *= factor;
          w.traces.spansPerSecond *= factor;
          for (const line of estimateVendor(bronto, w, s).lines) {
            expect(line.rateId).not.toBe("starter-launch");
          }
        }
      }
    }
  });

  it("leaves Starter for Pro past 1 TB of ingest or 20 TB of search, and keeps it as the floor", () => {
    // Typical (20×). 33 GB/day = 990 GB, 19.8 TB: Starter, $10.
    expect(rateIds(estimateVendor(bronto, logsOnly(33), TYPICAL))).toEqual(["starter"]);
    // 34 GB/day = 1,020 GB, 20.4 TB: past Starter, inside Pro: $500.
    expect(rateIds(estimateVendor(bronto, logsOnly(34), TYPICAL))).toEqual(["pro"]);
    expect(estimateVendor(bronto, logsOnly(34), TYPICAL).monthly).toBeCloseTo(500, 6);

    // Heavy (100×). 6 GB/day = 180 GB scans 18 TB: Starter. 7 GB/day = 210 GB scans 21 TB:
    // past the search allowance, so Pro.
    expect(rateIds(estimateVendor(bronto, logsOnly(6), HEAVY))).toEqual(["starter"]);
    expect(estimateVendor(bronto, logsOnly(7), HEAVY).monthly).toBeCloseTo(500, 6);

    // 1 GB/day = 30 GB, 0.6 TB: usage would be $3 + $0.60 = $3.60, Starter $10 is the floor.
    const small = estimateVendor(bronto, logsOnly(1), TYPICAL);
    expect(rateIds(small)).toEqual(["starter"]);
    expect(small.monthly).toBeCloseTo(10, 6);
    expect(small.assumptions.join(" ")).toContain("usage rates alone would come to less");
  });

  it("prices traces and metrics alone by GB", () => {
    // Traces: 2,592 GB, 51.84 TB at 20×: past Starter, inside Pro: $500.
    const traces = estimateVendor(bronto, tracesOnly(), TYPICAL);
    expect(rateIds(traces)).toEqual(["pro"]);
    expect(traces.monthly).toBeCloseTo(500, 6);

    // Metrics: 648 GB, 12.96 TB at 20×: inside Starter, $10.
    expect(rateIds(estimateVendor(bronto, metricsOnly(), TYPICAL))).toEqual(["starter"]);
    // At 100×: 64.8 TB, past Starter's search, inside Pro: $500.
    const heavy = estimateVendor(bronto, metricsOnly(), HEAVY);
    expect(rateIds(heavy)).toEqual(["pro"]);
    expect(heavy.monthly).toBeCloseTo(500, 6);
    // Host and custom series cost the same: no per-host or custom-metric class.
    const hostHeavy = metricsOnly();
    hostHeavy.metrics = { ...hostHeavy.metrics, hostSeriesShare: 1 };
    expect(estimateVendor(bronto, hostHeavy, HEAVY).monthly).toBeCloseTo(500, 6);
  });

  it("scans ingested GB × SCAN_MULTIPLE", () => {
    // 1,000 GB/day = 30,000 GB, $3,000 of ingestion at any load.
    // Scanned: 5× = 150 TB; 20× = 600 TB; 100× = 3,000 TB.
    const logs = logsOnly(1000);
    expect(amountAt(estimateVendor(bronto, logs, LIGHT), "ingest")).toBeCloseTo(3000, 6);
    expect(amountAt(estimateVendor(bronto, logs, LIGHT), "search")).toBeCloseTo(150, 6);
    expect(amountAt(estimateVendor(bronto, logs, TYPICAL), "search")).toBeCloseTo(600, 6);
    expect(amountAt(estimateVendor(bronto, logs, HEAVY), "search")).toBeCloseTo(3000, 6);
  });

  it("reports the 12 months every plan keeps as the retention bought", () => {
    // 648 GB of metrics at 100× is the $500 Pro fee whatever the retention.
    const six = estimateVendor(bronto, metricsOnly(6), HEAVY);
    expect(six.monthly).toBeCloseTo(500, 6);
    expect(six.shortRetention).toEqual([]);

    for (const months of [13, 24]) {
      const estimate = estimateVendor(bronto, metricsOnly(months), HEAVY);
      expect(estimate.monthly).toBeCloseTo(500, 6);
      expect(estimate.shortRetention).toEqual([
        { signal: "metrics", asked: months, kept: 12, unit: "months" },
      ]);
      expect(estimate.assumptions[0]).toContain(`metrics are asked for ${months} months`);
    }

    // Logs: 3,000 GB at 20× is $500 at 7, 30, 365 and 400 days alike; only 400 is short.
    for (const days of [7, 30, 365]) {
      const estimate = estimateVendor(bronto, logsOnly(100, days), TYPICAL);
      expect(estimate.monthly).toBeCloseTo(500, 6);
      expect(estimate.shortRetention).toEqual([]);
    }
    const long = estimateVendor(bronto, logsOnly(100, 400), TYPICAL);
    expect(long.monthly).toBeCloseTo(500, 6);
    expect(long.shortRetention).toEqual([{ signal: "logs", asked: 400, kept: 365, unit: "days" }]);
  });

  it("ignores region, hosts, users and the searchable share", () => {
    const bigger = mid();
    bigger.infra = { ...bigger.infra, hosts: bigger.infra.hosts * 10 };
    bigger.users = bigger.users * 10;
    expect(estimateVendor(bronto, bigger, TYPICAL).monthly).toBeCloseTo(2004.48, 6);

    const partlySearchable = mid();
    partlySearchable.logs = { ...partlySearchable.logs, searchableShare: 0.2 };
    const estimate = estimateVendor(bronto, partlySearchable, TYPICAL);
    expect(estimate.monthly).toBeCloseTo(2004.48, 6);
    expect(estimate.assumptions.join(" ")).toContain("searchable share is not used");
  });
});
