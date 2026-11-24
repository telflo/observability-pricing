import { describe, expect, it } from "vitest";
import { compareFacts, resolveCompare, withAdded, withSlot } from "./compare";
import { estimateAll, estimateVendor, onlySignals, scaleWorkload } from "./engine";
import { decodeState, encodeState } from "./url-state";
import { VENDORS, vendorById } from "./vendors";
import { DEFAULT_SETTINGS, defaultWorkload } from "./workloads";

const w = defaultWorkload();
const s = DEFAULT_SETTINGS;
const estimates = estimateAll(VENDORS, w, s);
const ranked = estimates.map((e) => e.vendor.id);

describe("which platforms are compared", () => {
  it("starts with the first three rows of the ranked list", () => {
    expect(resolveCompare(null, estimates)).toEqual(ranked.slice(0, 3));
    for (const id of resolveCompare(null, estimates)) {
      expect(estimates.find((e) => e.vendor.id === id)!.complete).toBe(true);
    }
  });

  it("keeps the visitor's picks, in their order", () => {
    expect(resolveCompare(["datadog", "grafana-cloud"], estimates)).toEqual(["datadog", "grafana-cloud"]);
    expect(resolveCompare(["new-relic", "datadog", "dynatrace"], estimates)).toEqual([
      "new-relic",
      "datadog",
      "dynatrace",
    ]);
  });

  it("drops unknown and repeated picks and never compares fewer than two", () => {
    expect(resolveCompare(["datadog", "nope", "datadog"], estimates)).toEqual(["datadog", ranked[0]]);
    expect(resolveCompare([ranked[0]], estimates)).toEqual([ranked[0], ranked[1]]);
    expect(resolveCompare(["nope"], estimates)).toEqual(ranked.slice(0, 2));
    expect(resolveCompare(["a", "b", "c", "d"].map(() => "datadog"), estimates).length).toBe(2);
  });

  it("changes one slot, swapping when the platform is already compared", () => {
    expect(withSlot(["a", "b"], 0, "c")).toEqual(["c", "b"]);
    expect(withSlot(["a", "b", "c"], 0, "c")).toEqual(["c", "b", "a"]);
    expect(withSlot(["a", "b"], 2, "c")).toEqual(["a", "b", "c"]);
    // Asking for a third that is already there changes nothing.
    expect(withSlot(["a", "b"], 2, "a")).toEqual(["a", "b"]);
    expect(withSlot(["a", "b", "c"], 1, "b")).toEqual(["a", "b", "c"]);
  });

  it("empties the third slot but never goes below two", () => {
    expect(withSlot(["a", "b", "c"], 2, null)).toEqual(["a", "b"]);
    expect(withSlot(["a", "b"], 1, null)).toEqual(["a", "b"]);
    expect(withSlot(["a", "b"], 2, null)).toEqual(["a", "b"]);
  });

  it("adds to the visitor's picks until the comparison is full", () => {
    expect(withAdded(null, "a")).toEqual(["a"]);
    expect(withAdded(["a"], "a")).toEqual(["a"]);
    expect(withAdded(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(withAdded(["a", "b", "c"], "d")).toEqual(["a", "b", "c"]);
  });

  it("travels in the link", () => {
    const state = { w, s, route: null, compare: ["datadog", "grafana-cloud", "new-relic"] };
    const query = encodeState(state).toString();
    expect(query).toBe("cmp=datadog%2Cgrafana-cloud%2Cnew-relic");
    expect(decodeState(new URLSearchParams(query)).compare).toEqual(state.compare);
    expect(decodeState(new URLSearchParams("")).compare).toBeNull();
    expect(decodeState(new URLSearchParams("cmp=../x,,datadog,datadog,a,b,c")).compare).toEqual([
      "datadog",
      "a",
      "b",
    ]);
  });
});

describe("what the comparison adds to an estimate", () => {
  it("works out each signal per unit from its lines", () => {
    for (const estimate of estimates.filter((e) => e.complete)) {
      const facts = compareFacts(estimate, w, s);
      const logs = facts.signals.logs!;
      expect(logs.amount).toBe(estimate.byBucket.logs);
      if (logs.amount > 0) {
        // 330 GB a day for 30 days is 9,900 GB.
        expect(logs.perUnit!, estimate.vendor.id).toBeCloseTo(estimate.byBucket.logs / 9900, 9);
      }
      const metrics = facts.signals.metrics!;
      if (metrics.amount > 0) expect(metrics.perUnit!).toBeCloseTo(estimate.byBucket.metrics / 250, 9);
      const traces = facts.signals.traces!;
      if (traces.amount > 0) expect(traces.perUnit!).toBeCloseTo(estimate.byBucket.traces / 5184, 9);
      expect(facts.platform.amount).toBe(estimate.byBucket.platform);
    }
  });

  it("names the meters behind every priced signal", () => {
    for (const estimate of estimates.filter((e) => e.complete)) {
      const facts = compareFacts(estimate, w, s);
      const units = new Set(estimate.vendor.rates.map((r) => r.unit));
      for (const signal of ["logs", "metrics", "traces"] as const) {
        const f = facts.signals[signal]!;
        if (f.amount > 0) expect(f.billedBy.length, `${estimate.vendor.id} ${signal}`).toBeGreaterThan(0);
        for (const meter of f.billedBy) expect(units.has(meter)).toBe(true);
        expect(new Set(f.billedBy).size).toBe(f.billedBy.length);
      }
    }
  });

  it("says nothing per unit where there is no public price", () => {
    const honeycomb = compareFacts(estimates.find((e) => e.vendor.id === "honeycomb")!, w, s);
    for (const signal of ["logs", "metrics", "traces"] as const) {
      expect(honeycomb.signals[signal]!.priced).toBe(false);
      expect(honeycomb.signals[signal]!.perUnit).toBeNull();
    }
  });

  it("leaves out a signal that is switched off", () => {
    const noTraces = onlySignals(w, ["logs", "metrics"]);
    const facts = compareFacts(estimateVendor(vendorById("datadog")!, noTraces, s), noTraces, s);
    expect(Object.keys(facts.signals)).toEqual(["logs", "metrics"]);
    expect(facts.retention.map((r) => r.signal)).toEqual(["logs", "metrics"]);
  });

  it("reports the retention priced next to the one asked", () => {
    const long = structuredClone(w);
    long.logs.retentionDays = 365;
    long.traces.retentionDays = 90;
    long.metrics.retentionMonths = 24;
    for (const estimate of estimateAll(VENDORS, long, s)) {
      const facts = compareFacts(estimate, long, s);
      for (const r of facts.retention) {
        const gap = estimate.shortRetention.find((g) => g.signal === r.signal);
        expect(r.kept).toBe(gap ? gap.kept : r.asked);
        expect(r.kept).toBeLessThanOrEqual(r.asked);
      }
    }
  });

  it("prices the same workload at ten times the volume", () => {
    const datadog = estimates.find((e) => e.vendor.id === "datadog")!;
    const facts = compareFacts(datadog, w, s);
    const big = estimateVendor(datadog.vendor, scaleWorkload(w, 10), s);
    expect(facts.tenTimes.monthly).toBe(big.monthly);
    expect(facts.tenTimes.monthly).toBeGreaterThan(datadog.monthly);
  });
});
