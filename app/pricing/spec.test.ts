/**
 * The spec builder on a made-up platform: every field a spec can set, the
 * `extra` function, the validation, and every sentence the builder writes.
 * A platform's own tests assert its amounts and its own text, never the
 * builder's wording, so that wording can change here without touching them.
 */
import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "./engine";
import type { VendorSpec } from "./spec";
import { defineVendor, isSpecVendor } from "./spec";
import type { Workload } from "./types";
import { DEFAULT_SETTINGS, presetById } from "./workloads";

const base = (): VendorSpec => ({
  id: "example",
  name: "Example",
  group: "otel-native",
  plan: "Pay as you go",
  pricingUrl: "https://example.com/pricing",
  checkedOn: "2026-11-12",
  sources: { pricing: "https://example.com/pricing" },
  rates: {
    "logs-us": { label: "Logs, US", usd: 0.5, unit: "GB ingested", sourceId: "pricing", basis: "list" },
    "logs-eu": { label: "Logs, EU", usd: 0.6, unit: "GB ingested", sourceId: "pricing", basis: "list" },
    "spans-annual": { label: "Spans, annual", usd: 1, unit: "million spans", sourceId: "pricing", basis: "list" },
    "spans-monthly": { label: "Spans, monthly", usd: 1.2, unit: "million spans", sourceId: "pricing", basis: "list" },
    "spans-stored": { label: "Spans stored", usd: 2, unit: "million spans", sourceId: "pricing", basis: "list" },
    series: { label: "Series", usd: 5, unit: "thousand series", sourceId: "pricing", basis: "list" },
    fee: { label: "Platform fee", usd: 19, unit: "month", sourceId: "pricing", basis: "list" },
    minimum: { label: "Minimum", usd: 100, unit: "month", sourceId: "pricing", basis: "list" },
  },
  logs: { unit: "gb", rate: { us: "logs-us", eu: "logs-eu" }, free: 100, retention: { included: 30 } },
  traces: {
    unit: "million-spans",
    rate: { annual: "spans-annual", monthly: "spans-monthly" },
    storage: { rate: "spans-stored", on: "searchable" },
  },
  metrics: { unit: "thousand-series", rate: "series" },
  profiles: { coverage: "unsupported", note: "Example takes no profiles." },
  platformFee: { rate: "fee", label: "Platform fee" },
  assumptions: ["A GB is 10^9 bytes.", { when: "topUp", text: "Topped up." }],
  included: ["Dashboards"],
  notIncluded: ["Support"],
  notes: ["Logs cost {rate:logs-us} per GB in the US."],
  examples: [],
});

/** 100 GB of logs a day, 1,000 spans/s, 10,000 series. */
const workload = (): Workload => {
  const w = structuredClone(presetById("mid")!.workload);
  w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30, searchableShare: 1 };
  w.traces = { ...w.traces, spansPerSecond: 1000, searchableShare: 0.5 };
  w.metrics = { ...w.metrics, activeSeries: 10_000 };
  return w;
};

describe("defineVendor", () => {
  it("builds an adapter the engine prices, with every knob applied", () => {
    const v = defineVendor(base());
    expect(isSpecVendor(v)).toBe(true);
    expect(v.coverage).toEqual({ logs: "priced", traces: "priced", metrics: "priced", profiles: "unsupported" });
    expect(v.coverageNote).toEqual({ profiles: "Example takes no profiles." });

    const e = estimateVendor(v, workload(), DEFAULT_SETTINGS);
    // logs: 3,000 GB less 100 free x $0.50 = $1,450
    expect(e.byBucket.logs).toBeCloseTo(1450, 6);
    // traces: 2,592M spans x $1 + half of them stored x $2 = $2,592 + $2,592
    expect(e.byBucket.traces).toBeCloseTo(5184, 6);
    // metrics: 10 k series x $5
    expect(e.byBucket.metrics).toBeCloseTo(50, 6);
    expect(e.byBucket.platform).toBeCloseTo(19, 6);
    expect(e.lines.map((l) => l.rateId)).toEqual(["logs-us", "spans-annual", "spans-stored", "series", "fee"]);
    expect(e.lines[0].detail).toContain("less 100 GB free");
    expect(e.lines.map((l) => l.label)).toEqual([
      "Log ingestion, 30-day retention",
      "Span ingestion",
      "Span storage",
      "Metric series",
      "Platform fee",
    ]);
    // 1,000 spans/s x 2,592,000 s = 2.59B spans, written as a count and not in millions.
    expect(e.lines[2].detail).toBe("50% of 2.59B spans kept");
    expect(e.assumptions.join(" ")).toContain("50% of spans are kept and searchable");
    expect(e.notes[0]).toBe("Logs cost $0.50 per GB in the US.");
    expect(e.complete).toBe(true);
  });

  it("picks rates by region and by term", () => {
    const v = defineVendor(base());
    const eu = estimateVendor(v, onlySignals(workload(), ["logs"]), { ...DEFAULT_SETTINGS, region: "eu" });
    expect(eu.byBucket.logs).toBeCloseTo(2900 * 0.6, 6);
    const monthly = estimateVendor(v, onlySignals(workload(), ["traces"]), { ...DEFAULT_SETTINGS, term: "monthly" });
    expect(monthly.lines[0].rateId).toBe("spans-monthly");
  });

  it("tops up to a minimum, and says so only then", () => {
    const spec = base();
    delete spec.platformFee;
    spec.minimum = { rate: "minimum", label: "Top-up" };
    const v = defineVendor(spec);
    const small = estimateVendor(v, onlySignals(workload(), ["metrics"]), DEFAULT_SETTINGS);
    expect(small.byBucket.metrics).toBeCloseTo(50, 6);
    expect(small.byBucket.platform).toBeCloseTo(50, 6);
    expect(small.assumptions).toContain("Topped up.");
    const big = estimateVendor(v, workload(), DEFAULT_SETTINGS);
    expect(big.byBucket.platform).toBe(0);
    expect(big.assumptions).not.toContain("Topped up.");
  });

  it("charges no fee when only an unpriced signal is sent", () => {
    const v = defineVendor(base());
    const w = workload();
    w.send = { logs: false, metrics: false, traces: false, profiles: true };
    expect(estimateVendor(v, w, DEFAULT_SETTINGS).monthly).toBe(0);
  });

  it("reports a fixed retention shorter than asked, and the same price for a shorter ask", () => {
    const v = defineVendor(base());
    const long = workload();
    long.logs.retentionDays = 90;
    const e = estimateVendor(v, onlySignals(long, ["logs"]), DEFAULT_SETTINGS);
    expect(e.shortRetention).toEqual([{ signal: "logs", asked: 90, kept: 30, unit: "days" }]);
    expect(e.assumptions[0]).toBe(
      "Logs: 90 days of retention was asked for. Example keeps logs for 30 days and publishes no price for longer, so 30 days is priced and the data is kept for less time than asked.",
    );
    const short = workload();
    short.logs.retentionDays = 7;
    const s = estimateVendor(v, onlySignals(short, ["logs"]), DEFAULT_SETTINGS);
    expect(s.shortRetention).toEqual([]);
    expect(s.assumptions.at(-1)).toContain("Logs: 7 days of retention costs the same as the 30 days");
  });

  it("generates one rate per ladder step and prices the covering step", () => {
    const spec = base();
    spec.metrics = {
      unit: "thousand-series",
      ladder: { source: "pricing", steps: [{ at: 1, usd: 5 }, { at: 13, usd: 8 }] },
    };
    const v = defineVendor(spec);
    expect(v.rates.map((r) => r.id)).toContain("metrics-13mo");
    expect(v.rates.find((r) => r.id === "metrics-1mo")).toMatchObject({ usd: 5, unit: "thousand active series" });
    const w = workload();
    w.metrics.retentionMonths = 6;
    const e = estimateVendor(v, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(e.lines[0].rateId).toBe("metrics-13mo");
    expect(e.byBucket.metrics).toBeCloseTo(80, 6);
    expect(e.assumptions.join(" ")).toContain("6 months of retention is priced at the 13-month rate");
  });

  it("prices scanned data and retention past the included days, and explains both", () => {
    const spec = base();
    spec.rates.scan = { label: "Queries", usd: 0.01, unit: "GB queried", sourceId: "pricing", basis: "list" };
    spec.rates.held = { label: "Extra retention", usd: 0.02, unit: "GB per 30 days", sourceId: "pricing", basis: "list" };
    spec.rates.traces = { label: "Traces", usd: 0.5, unit: "GB ingested", sourceId: "pricing", basis: "list" };
    spec.logs = {
      unit: "gb",
      rate: "logs-us",
      retention: { included: 30 },
      retentionExtra: { rate: "held" },
      scan: { rate: "scan", note: "Example's own example scans 5 GB per GB." },
    };
    spec.traces = {
      unit: "gb",
      rate: "traces",
      retention: { included: 14 },
      retentionExtra: { rate: "held" },
    };
    const v = defineVendor(spec);
    const w = workload();
    w.logs = { ...w.logs, retentionDays: 90, searchableShare: 0.2 };
    w.traces = { ...w.traces, avgSpanBytes: 1000, retentionDays: 44, searchableShare: 1 };
    const e = estimateVendor(v, onlySignals(w, ["logs", "traces"]), DEFAULT_SETTINGS);

    // logs: 3,000 GB x $0.50, 60,000 GB scanned x $0.01, 100 GB/day x 60 days held x $0.02
    expect(e.lines.slice(0, 3).map((l) => [l.label, l.amount])).toEqual([
      ["Log ingestion", 1500],
      ["Data scanned by log queries", 600],
      ["Log retention past 30 days", 120],
    ]);
    expect(e.lines[1].detail).toBe("3,000 GB ingested × 20 GB scanned per GB (typical query load)");
    expect(e.lines[2].detail).toBe("100 GB/day × 60 days kept past the included 30 = 6,000 GB held");
    // traces: 2,592 GB a month, 30 days past the included 14
    expect(e.lines[4]).toMatchObject({ label: "Trace retention past 14 days", unit: "GB held" });
    expect(e.lines[4].detail).toBe(
      "2,592 GB a month / 30 days × 30 days kept past the included 14 = 2,592 GB held",
    );
    // Retention is bought in full, so nothing is kept for less time than asked.
    expect(e.shortRetention).toEqual([]);

    const said = e.assumptions.join(" ");
    expect(said).toContain(
      "Queries are priced at 20 GB scanned for each GB ingested, the typical query load. Example's own example scans 5 GB per GB.",
    );
    // One sentence for each included retention, not the first meter's for both.
    expect(said).toContain("Retention past 30 days is priced on the uncompressed GB");
    expect(said).toContain("Retention past 14 days is priced on the uncompressed GB");
    // One tier, so the searchable share changes nothing, and the estimate says so.
    expect(said).toContain(
      "Example prices one tier, so everything ingested stays searchable and the searchable share is not used.",
    );
  });

  it("names the storage retention on profiles and says what happens to data that is not kept", () => {
    const spec = base();
    spec.rates["samples"] = { label: "Samples", usd: 0.06, unit: "million samples", sourceId: "pricing", basis: "list" };
    spec.rates["samples-stored"] = { label: "Samples stored", usd: 0.54, unit: "million samples", sourceId: "pricing", basis: "list" };
    spec.profiles = {
      unit: "million-samples",
      rate: "samples",
      storage: { rate: "samples-stored", on: "all" },
      retention: { included: 30 },
    };
    spec.traces = {
      unit: "million-spans",
      rate: { annual: "spans-annual", monthly: "spans-monthly" },
      storage: { rate: "spans-stored", on: "searchable", note: "It is dropped after ingestion." },
    };
    const v = defineVendor(spec);
    const w = workload();
    w.send = { logs: false, metrics: false, traces: true, profiles: true };
    const e = estimateVendor(v, w, DEFAULT_SETTINGS);
    expect(e.lines.map((l) => l.label)).toEqual([
      "Span ingestion",
      "Span storage",
      "Profiling sample ingestion",
      "Profiling sample storage, 30-day retention",
      "Platform fee",
    ]);
    expect(e.assumptions).toContain(
      "Traces: 50% of spans are kept and searchable. The rest pays the ingestion rate only. It is dropped after ingestion.",
    );
    expect(e.shortRetention).toEqual([]);
  });

  it("adds what `extra` returns, before the minimum is topped up", () => {
    const spec = base();
    delete spec.platformFee;
    spec.minimum = { rate: "minimum", label: "Top-up" };
    spec.rates.seat = { label: "Seat", usd: 10, unit: "user", sourceId: "pricing", basis: "list" };
    const seen: { lines: number; active: string[] }[] = [];
    spec.extra = ({ d, bill, lines, active }) => {
      seen.push({ lines: lines.length, active: [...active] });
      return {
        lines: bill.line({ bucket: "platform", label: "Seats", quantity: d.users, unit: "users", rateId: "seat" }),
        assumptions: [`${d.users} people have full access.`],
        included: ["A seat for each of them"],
        notIncluded: ["Read-only seats"],
        notes: ["Seats are billed monthly."],
      };
    };
    const v = defineVendor(spec);
    const w = onlySignals(workload(), ["metrics"]);
    w.users = 3;
    const e = estimateVendor(v, w, DEFAULT_SETTINGS);

    // It is given the meters' lines and which signals are sent.
    expect(seen).toEqual([{ lines: 1, active: ["metrics"] }]);
    // metrics $50 + 3 seats x $10 = $80, topped up by $20 to the $100 minimum:
    // the top-up counts the seats.
    expect(e.lines.map((l) => [l.label, l.amount])).toEqual([
      ["Metric series", 50],
      ["Seats", 30],
      ["Top-up", 20],
    ]);
    expect(e.monthly).toBeCloseTo(100, 6);
    expect(e.assumptions).toContain("3 people have full access.");
    expect(e.included).toEqual(["Dashboards", "A seat for each of them"]);
    expect(e.notIncluded).toEqual(["Support", "Read-only seats"]);
    expect(e.notes.at(-1)).toBe("Seats are billed monthly.");

    // Nothing priced is sent: `extra` is not called and nothing is charged.
    const none = workload();
    none.send = { logs: false, metrics: false, traces: false, profiles: true };
    expect(estimateVendor(v, none, DEFAULT_SETTINGS).monthly).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("holds `extra` to the rates table", () => {
    const spec = base();
    spec.extra = ({ bill }) => ({
      lines: bill.line({ bucket: "platform", label: "Seats", quantity: 1, unit: "users", rateId: "nope" }),
    });
    const v = defineVendor(spec);
    expect(() => estimateVendor(v, workload(), DEFAULT_SETTINGS)).toThrow(/Unknown rate id: nope/);
  });

  it("rejects a spec that points at nothing", () => {
    const broken = (change: (s: VendorSpec) => void) => {
      const s = base();
      change(s);
      return () => defineVendor(s);
    };
    expect(broken((s) => (s.metrics = { unit: "thousand-series", rate: "nope" }))).toThrow(/unknown rate nope/);
    expect(broken((s) => (s.rates.series.sourceId = "nowhere"))).toThrow(/unknown source/);
    expect(broken((s) => (s.notes = ["{rate:ghost}"]))).toThrow(/unknown rate ghost/);
    // The types refuse a meter with neither, so this is what a cast or plain JS would hit.
    expect(broken((s) => (s.metrics = { unit: "thousand-series" } as never))).toThrow(
      /needs a rate or a ladder/,
    );
    // A ladder generates `metrics-1mo`: an authored rate of that name would be priced by mistake.
    expect(
      broken((s) => {
        s.rates["metrics-1mo"] = s.rates.series;
        s.metrics = { unit: "thousand-series", ladder: { source: "pricing", steps: [{ at: 1, usd: 5 }] } };
      }),
    ).toThrow(/rate id metrics-1mo is used twice/);
    expect(
      broken((s) => (s.traces = { unit: "million-spans", rate: "spans-annual", free: 10, storage: { rate: "spans-stored", on: "all" } })),
    ).toThrow(/both storage and a free allowance/);
    expect(
      broken((s) => (s.metrics = { unit: "thousand-series", ladder: { source: "pricing", steps: [{ at: 13, usd: 1 }, { at: 1, usd: 2 }] } })),
    ).toThrow(/ascend/);
    expect(broken((s) => (s.metrics = { unit: "thousand-series", rate: "series", scan: { rate: "series" } }))).toThrow(/GB meter/);
    expect(
      broken((s) => (s.logs = { unit: "gb", rate: "logs-us", retentionExtra: { rate: "logs-us" } })),
    ).toThrow(/needs retention.included/);
  });
});
