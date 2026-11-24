import { describe, expect, it } from "vitest";
import { billFor } from "./bill";
import {
  cheapestRoute,
  estimateAll,
  estimateRoute,
  estimateVendor,
  onlySignals,
  rankForSignal,
  scaleWorkload,
  usableRoute,
} from "./engine";
import { compact, duration, num, usd, usdApprox, usdCompact, usdRate } from "./format";
import type { Rate, Signal, VendorAdapter } from "./types";
import { activeSignals, derive, gbToGib } from "./units";
import { VENDORS } from "./vendors";
import { DEFAULT_SETTINGS, PRESETS, defaultWorkload } from "./workloads";

/** A toy vendor: a flat rate per signal plus an optional base fee. */
function toy(
  id: string,
  perUnit: Partial<Record<Signal, number>>,
  baseFee = 0,
): VendorAdapter {
  const rates: Rate[] = [
    { id: "base", label: "Base fee", usd: baseFee, unit: "month", sourceId: "p", basis: "list" },
    { id: "logs", label: "Logs", usd: perUnit.logs ?? 0, unit: "GB", sourceId: "p", basis: "list" },
    { id: "metrics", label: "Metrics", usd: perUnit.metrics ?? 0, unit: "k series", sourceId: "p", basis: "list" },
    { id: "traces", label: "Traces", usd: perUnit.traces ?? 0, unit: "M spans", sourceId: "p", basis: "list" },
  ];
  return {
    id,
    name: id,
    group: "otel-native",
    plan: () => "Toy",
    pricingUrl: "https://example.com/pricing",
    checkedOn: "2026-11-12",
    sources: [{ id: "p", label: "Pricing page", url: "https://example.com/pricing" }],
    rates,
    coverage: {
      logs: perUnit.logs === undefined ? "unpriced" : "priced",
      metrics: perUnit.metrics === undefined ? "unpriced" : "priced",
      traces: perUnit.traces === undefined ? "unpriced" : "priced",
      profiles: "unsupported",
    },
    price({ d }) {
      const bill = billFor(rates);
      return {
        lines: [
          ...(baseFee > 0
            ? bill.line({ bucket: "platform", label: "Base fee", quantity: 1, unit: "month", rateId: "base" })
            : []),
          ...(perUnit.logs !== undefined
            ? bill.line({ bucket: "logs", label: "Logs", quantity: d.logs.gbPerMonth, unit: "GB", rateId: "logs" })
            : []),
          ...(perUnit.metrics !== undefined
            ? bill.line({ bucket: "metrics", label: "Metrics", quantity: d.metrics.activeSeries / 1000, unit: "k series", rateId: "metrics" })
            : []),
          ...(perUnit.traces !== undefined
            ? bill.line({ bucket: "traces", label: "Traces", quantity: d.traces.spansPerMonth / 1e6, unit: "M spans", rateId: "traces" })
            : []),
        ],
        assumptions: [],
        included: ["Everything"],
        notIncluded: [],
        notes: [],
      };
    },
  };
}

describe("units", () => {
  it("derives monthly quantities from the workload on a 30-day month", () => {
    const w = defaultWorkload();
    w.logs = { ...w.logs, gbPerDay: 100, avgRecordBytes: 1000, retentionDays: 30, searchableShare: 0.2 };
    w.metrics = { ...w.metrics, activeSeries: 10_000, intervalSeconds: 30 };
    w.traces = { ...w.traces, spansPerSecond: 1000, avgSpanBytes: 500, retentionDays: 15 };
    const d = derive(w);
    expect(d.logs.gbPerMonth).toBe(3000);
    expect(d.logs.recordsPerMonth).toBe(3e9);
    expect(d.logs.searchableGbPerMonth).toBeCloseTo(600);
    expect(d.logs.storedGb).toBe(3000);
    expect(d.metrics.dataPointsPerMinute).toBe(20_000);
    expect(d.metrics.dataPointsPerMonth).toBe(864_000_000);
    expect(d.traces.spansPerMonth).toBe(2_592_000_000);
    expect(d.traces.gbPerMonth).toBeCloseTo(1296);
    expect(d.traces.storedGb).toBeCloseTo(648);
  });

  it("zeroes a signal that is switched off, and the host fees tied to it", () => {
    const w = onlySignals(defaultWorkload(), ["logs"]);
    const d = derive(w);
    expect(d.metrics.activeSeries).toBe(0);
    expect(d.traces.spansPerMonth).toBe(0);
    expect(d.infra.monitoredHosts).toBe(0);
    expect(d.infra.tracedHosts).toBe(0);
    expect(d.infra.hosts).toBe(w.infra.hosts);
    expect(activeSignals(w)).toEqual(["logs"]);
  });

  it("converts decimal GB to binary GiB", () => {
    expect(gbToGib(1)).toBeCloseTo(0.9313, 4);
  });
});

describe("bill helpers", () => {
  const rates: Rate[] = [
    { id: "t1", label: "Tier 1", usd: 0.5, unit: "GB", sourceId: "p", basis: "list" },
    { id: "t2", label: "Tier 2", usd: 0.25, unit: "GB", sourceId: "p", basis: "list" },
    { id: "free", label: "Free", usd: 0, unit: "GB", sourceId: "p", basis: "list" },
    { id: "min", label: "Minimum", usd: 49, unit: "month", sourceId: "p", basis: "list" },
  ];
  const bill = billFor(rates);

  it("bills graduated tiers slice by slice", () => {
    const lines = bill.graduated({
      bucket: "logs",
      label: "Ingest",
      quantity: 1500,
      unit: "GB",
      tiers: [
        { upTo: 100, rateId: "free" },
        { upTo: 1000, rateId: "t1" },
        { upTo: null, rateId: "t2" },
      ],
    });
    expect(lines.map((l) => l.quantity)).toEqual([100, 900, 500]);
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(0 + 450 + 125);
  });

  it("bills volume tiers at the rate of the tier the total lands in", () => {
    const [line] = bill.volume({
      bucket: "logs",
      label: "Ingest",
      quantity: 1500,
      unit: "GB",
      tiers: [
        { upTo: 1000, rateId: "t1" },
        { upTo: null, rateId: "t2" },
      ],
    });
    expect(line.amount).toBeCloseTo(375);
  });

  it("drops zero-quantity lines and tops up to a minimum", () => {
    expect(bill.line({ bucket: "logs", label: "x", quantity: 0, unit: "GB", rateId: "t1" })).toEqual([]);
    expect(bill.topUp({ label: "Minimum", minimumRateId: "min", usage: 60 })).toEqual([]);
    const [gap] = bill.topUp({ label: "Minimum", minimumRateId: "min", usage: 9 });
    expect(gap.amount).toBe(40);
    expect(gap.kind).toBe("top-up");
  });

  it("refuses a rate id that is not in the table", () => {
    expect(() => bill.usd("nope")).toThrow();
  });
});

describe("engine", () => {
  const w = defaultWorkload(); // 330 GB/day logs, 250k series, 2,000 spans/s
  const cheapLogs = toy("cheap-logs", { logs: 0.1, metrics: 10, traces: 5 });
  const cheapMetrics = toy("cheap-metrics", { logs: 1, metrics: 1, traces: 5 }, 100);
  const cheapTraces = toy("cheap-traces", { logs: 1, metrics: 10, traces: 0.5 });
  const noLogs = toy("no-logs", { metrics: 0.01, traces: 0.01 });
  const vendors = [cheapLogs, cheapMetrics, cheapTraces, noLogs];

  it("totals lines by bucket", () => {
    const e = estimateVendor(cheapMetrics, w, DEFAULT_SETTINGS);
    expect(e.byBucket.platform).toBe(100);
    expect(e.byBucket.logs).toBeCloseTo(9900);
    expect(e.byBucket.metrics).toBeCloseTo(250);
    expect(e.monthly).toBeCloseTo(e.byBucket.logs + e.byBucket.metrics + e.byBucket.traces + 100);
    expect(e.complete).toBe(true);
  });

  it("marks a vendor incomplete when a sent signal has no public price, and ranks it last", () => {
    const e = estimateVendor(noLogs, w, DEFAULT_SETTINGS);
    expect(e.complete).toBe(false);
    expect(e.unpriced.map((u) => u.bucket)).toEqual(["logs"]);
    const all = estimateAll(vendors, w, DEFAULT_SETTINGS);
    expect(all[all.length - 1].vendor.id).toBe("no-logs");
    expect(all.filter((x) => x.complete).map((x) => x.monthly)).toEqual(
      [...all.filter((x) => x.complete).map((x) => x.monthly)].sort((a, b) => a - b),
    );
  });

  it("finds the cheapest split and counts a base fee once", () => {
    const best = cheapestRoute(vendors, w, DEFAULT_SETTINGS)!;
    expect(best.route).toEqual({
      logs: "cheap-logs",
      metrics: "no-logs",
      traces: "no-logs",
      profiles: null,
    });
    expect(best.complete).toBe(true);
    const single = Math.min(
      ...estimateAll(vendors, w, DEFAULT_SETTINGS).filter((e) => e.complete).map((e) => e.monthly),
    );
    expect(best.monthly).toBeLessThanOrEqual(single);

    // One vendor carrying two signals pays its base fee once.
    const both = estimateRoute(vendors, w, DEFAULT_SETTINGS, {
      logs: "cheap-metrics",
      metrics: "cheap-metrics",
      traces: "cheap-traces",
      profiles: null,
    });
    const part = both.parts.find((p) => p.vendor.id === "cheap-metrics")!;
    expect(part.signals).toEqual(["logs", "metrics"]);
    expect(part.estimate.byBucket.platform).toBe(100);
  });

  it("clears route entries that cannot be priced", () => {
    // Links are typed by hand: an unknown id and a platform with no price for
    // that signal are both dropped; a good entry is kept.
    const route = usableRoute(vendors, w, DEFAULT_SETTINGS, {
      logs: "no-logs",
      metrics: "does-not-exist",
      traces: "cheap-traces",
      profiles: null,
    });
    expect(route).toEqual({ logs: null, metrics: null, traces: "cheap-traces", profiles: null });
    // A signal that is switched off is never routed.
    const noTraces = usableRoute(vendors, onlySignals(w, ["logs", "metrics"]), DEFAULT_SETTINGS, {
      logs: "cheap-logs",
      metrics: "cheap-metrics",
      traces: "cheap-traces",
      profiles: null,
    });
    expect(noTraces).toEqual({
      logs: "cheap-logs",
      metrics: "cheap-metrics",
      traces: null,
      profiles: null,
    });
  });

  it("prefers a split that keeps data as long as asked", () => {
    // Almost free, but keeps logs for a week when a month was asked.
    const shortLogs: VendorAdapter = {
      ...toy("short-logs", { logs: 0.001, metrics: 10, traces: 5 }),
      price: (input) => ({
        ...toy("short-logs", { logs: 0.001, metrics: 10, traces: 5 }).price(input),
        kept: { logsDays: 7 },
      }),
    };
    const best = cheapestRoute([...vendors, shortLogs], w, DEFAULT_SETTINGS)!;
    expect(best.route.logs).toBe("cheap-logs");
    expect(best.parts.every((part) => part.estimate.shortRetention.length === 0)).toBe(true);

    // With nothing else pricing logs, the shorter price is used and reported.
    const onlyShort = cheapestRoute([noLogs, shortLogs], w, DEFAULT_SETTINGS)!;
    expect(onlyShort.route.logs).toBe("short-logs");
    const part = onlyShort.parts.find((x) => x.vendor.id === "short-logs")!;
    expect(part.estimate.shortRetention.map((g) => g.signal)).toEqual(["logs"]);
  });

  it("does not call one platform at the same price a split", () => {
    const a = toy("a", { logs: 1, metrics: 1, traces: 1 });
    const b = toy("b", { logs: 1, metrics: 1, traces: 1 });
    const best = cheapestRoute([a, b], w, DEFAULT_SETTINGS)!;
    expect(best.parts.length).toBe(1);
  });

  it("ranks vendors for one signal alone", () => {
    const ranked = rankForSignal(vendors, w, DEFAULT_SETTINGS, "logs");
    expect(ranked.map((e) => e.vendor.id)).toEqual(["cheap-logs", "cheap-traces", "cheap-metrics"]);
  });

  it("reports a retention shorter than the ask, and only for signals that are sent", () => {
    const short: VendorAdapter = {
      ...cheapLogs,
      id: "short",
      price: (input) => ({
        ...cheapLogs.price(input),
        kept: { logsDays: 7, tracesDays: 30, metricsMonths: 1 },
      }),
    };
    const e = estimateVendor(short, w, DEFAULT_SETTINGS); // asks 30 days, 30 days, 13 months
    expect(e.shortRetention).toEqual([
      { signal: "logs", asked: 30, kept: 7, unit: "days" },
      { signal: "metrics", asked: 13, kept: 1, unit: "months" },
    ]);
    expect(e.complete).toBe(true);
    const logsOnly = estimateVendor(short, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(logsOnly.shortRetention.map((g) => g.signal)).toEqual(["logs"]);
  });

  it("splits series into host and custom by the host share", () => {
    const d = derive({ ...w, metrics: { ...w.metrics, activeSeries: 1000, hostSeriesShare: 0.25 } });
    expect(d.metrics.hostSeries).toBe(250);
    expect(d.metrics.customSeries).toBe(750);
  });

  it("scales volumes and hosts, not people", () => {
    const big = scaleWorkload(w, 10);
    expect(big.logs.gbPerDay).toBe(w.logs.gbPerDay * 10);
    expect(big.infra.hosts).toBe(w.infra.hosts * 10);
    expect(big.users).toBe(w.users);
    const sizes = [0.5, 1, 2].map(
      (factor) => estimateVendor(cheapLogs, scaleWorkload(w, factor), DEFAULT_SETTINGS).monthly,
    );
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  it("ships presets whose volumes are all non-negative", () => {
    for (const preset of PRESETS) {
      const d = derive(preset.workload);
      expect(d.logs.gbPerMonth).toBeGreaterThanOrEqual(0);
      expect(d.metrics.activeSeries).toBeGreaterThan(0);
    }
  });
});

describe("format", () => {
  it("formats numbers, money and unit prices", () => {
    expect(num(1234.567)).toBe("1,235");
    expect(num(12.345)).toBe("12.3");
    expect(compact(2_592_000_000)).toBe("2.59B");
    expect(usd(1234.5)).toBe("$1,235");
    expect(usd(12.5)).toBe("$12.50");
    expect(usdRate(0.1)).toBe("$0.10");
    expect(usdRate(1.7)).toBe("$1.70");
    expect(usdRate(0.0000016)).toBe("$0.0000016");
    expect(usdRate(0.005)).toBe("$0.005");
    // Rounding never crosses a unit or prints a negative zero.
    expect(compact(999_600)).toBe("1M");
    expect(usd(99.995)).toBe("$100");
    expect(usd(-0.001)).toBe("$0.00");
    expect(usdCompact(999.6)).toBe("$1K");
    // A worked-out unit price keeps two significant digits below a dollar.
    expect(usdApprox(1234.5)).toBe("$1,235");
    expect(usdApprox(49.5)).toBe("$49.50");
    expect(usdApprox(2.6)).toBe("$2.60");
    expect(usdApprox(0.4166)).toBe("$0.42");
    expect(usdApprox(0.0314)).toBe("$0.031");
    expect(usdApprox(0)).toBe("$0");
    expect(duration(365, "days")).toBe("1 year");
    expect(duration(1, "months")).toBe("1 month");
    expect(duration(13, "months")).toBe("13 months");
  });
});

describe("the lowest-cost split with profiles", () => {
  it("matches a brute-force search over every assignment of four signals", () => {
    const pick = ["datadog", "grafana-cloud", "dash0", "aws-cloudwatch", "signoz", "honeycomb"];
    const vendors = VENDORS.filter((v) => pick.includes(v.id));
    const w = structuredClone(PRESETS[1].workload);
    w.send = { logs: true, metrics: true, traces: true, profiles: true };
    const best = cheapestRoute(vendors, w, DEFAULT_SETTINGS)!;
    expect(best.complete).toBe(true);
    expect(best.route.profiles).not.toBeNull();

    // The search prefers prices that keep everything as long as asked, and
    // falls back to shorter retention only when nothing else covers it.
    let lowest = Infinity;
    let lowestFull = Infinity;
    const ids = vendors.map((v) => v.id);
    for (const logs of ids)
      for (const metrics of ids)
        for (const traces of ids)
          for (const profiles of ids) {
            const r = estimateRoute(vendors, w, DEFAULT_SETTINGS, { logs, metrics, traces, profiles });
            if (!r.complete) continue;
            lowest = Math.min(lowest, r.monthly);
            if (r.parts.every((part) => part.estimate.shortRetention.length === 0)) {
              lowestFull = Math.min(lowestFull, r.monthly);
            }
          }
    expect(best.monthly).toBeCloseTo(Number.isFinite(lowestFull) ? lowestFull : lowest, 6);
  });
});
