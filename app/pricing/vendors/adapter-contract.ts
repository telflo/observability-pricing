/**
 * The checks every vendor adapter must pass, spec or handwritten. Test-only:
 * contract.test.ts runs them on every platform in index.ts.
 */
import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals, scaleWorkload } from "../engine";
import type { Settings, Signal, VendorAdapter, Workload } from "../types";
import { BUCKETS, SIGNALS } from "../types";
import { PRESETS } from "../workloads";

const SETTINGS: Settings[] = [
  { term: "annual", region: "us", queryLoad: "typical" },
  { term: "monthly", region: "us", queryLoad: "typical" },
  { term: "annual", region: "eu", queryLoad: "heavy" },
  { term: "monthly", region: "eu", queryLoad: "light" },
];

/** A preset with profiling switched on: every preset ships with it off. */
function withProfiles(w: Workload): Workload {
  return { ...w, send: { ...w.send, profiles: true } };
}

/** The presets as shipped, then again with profiling on. */
function presetWorkloads(): { id: string; workload: Workload }[] {
  return PRESETS.flatMap((p) => [
    { id: p.id, workload: p.workload },
    { id: `${p.id} +profiles`, workload: withProfiles(p.workload) },
  ]);
}

/** Every preset at a spread of sizes, so tier edges and floors get exercised. */
function sampleWorkloads(): { name: string; w: Workload }[] {
  const out: { name: string; w: Workload }[] = [];
  for (const preset of presetWorkloads()) {
    for (const factor of [0.01, 0.1, 1, 10]) {
      out.push({ name: `${preset.id} x${factor}`, w: scaleWorkload(preset.workload, factor) });
    }
  }
  return out;
}

export function describeAdapterContract(adapter: VendorAdapter) {
  describe(`${adapter.name}: adapter contract`, () => {
    it("has well-formed metadata", () => {
      expect(adapter.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(adapter.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(adapter.pricingUrl).toMatch(/^https:\/\//);
      expect(adapter.sources.length).toBeGreaterThan(0);

      const sourceIds = adapter.sources.map((s) => s.id);
      expect(new Set(sourceIds).size).toBe(sourceIds.length);
      for (const source of adapter.sources) expect(source.url).toMatch(/^https:\/\//);

      const rateIds = adapter.rates.map((r) => r.id);
      expect(new Set(rateIds).size).toBe(rateIds.length);
      for (const rate of adapter.rates) {
        expect(sourceIds, `rate ${rate.id} cites a source`).toContain(rate.sourceId);
        expect(Number.isFinite(rate.usd) && rate.usd >= 0, `rate ${rate.id} is a price`).toBe(true);
      }
      for (const s of SETTINGS) expect(adapter.plan(s).length).toBeGreaterThan(0);
    });

    it("builds every line from a published rate", () => {
      const rates = new Map(adapter.rates.map((r) => [r.id, r]));
      for (const { name, w } of sampleWorkloads()) {
        for (const s of SETTINGS) {
          const estimate = estimateVendor(adapter, w, s);
          expect(Number.isFinite(estimate.monthly), `${name}: total is a number`).toBe(true);
          expect(estimate.monthly).toBeGreaterThanOrEqual(0);
          for (const line of estimate.lines) {
            const rate = rates.get(line.rateId);
            expect(rate, `${name}: line "${line.label}" uses a known rate`).toBeDefined();
            expect(BUCKETS).toContain(line.bucket);
            expect(line.amount, `${name}: "${line.label}" is not negative`).toBeGreaterThanOrEqual(0);
            expect(line.label.length).toBeGreaterThan(0);
            if (line.kind === "top-up") {
              expect(line.amount).toBeLessThanOrEqual(rate!.usd + 1e-9);
            } else {
              expect(line.amount, `${name}: "${line.label}" is quantity x rate`).toBeCloseTo(
                line.quantity * rate!.usd,
                6,
              );
            }
          }
        }
      }
    });

    it("charges nothing for a signal that is not sent", () => {
      for (const { name, w } of sampleWorkloads()) {
        for (const off of SIGNALS) {
          const rest = SIGNALS.filter((x) => x !== off) as Signal[];
          const estimate = estimateVendor(adapter, onlySignals(w, rest), SETTINGS[0]);
          const stray = estimate.lines.filter((l) => l.bucket === off && l.amount > 0);
          expect(stray, `${name}: no ${off} lines when ${off} is off`).toEqual([]);
        }
        const nothing = estimateVendor(adapter, onlySignals(w, []), SETTINGS[0]);
        expect(nothing.monthly, `${name}: nothing sent costs nothing`).toBe(0);
      }
    });

    it("never charges more when a signal is switched off", () => {
      for (const { name, w } of sampleWorkloads()) {
        for (const s of SETTINGS) {
          const everything = estimateVendor(adapter, w, s);
          // A partly priced estimate is not a total, so there is nothing to compare against.
          if (!everything.complete) continue;
          for (const off of SIGNALS) {
            if (!w.send[off]) continue;
            const rest = SIGNALS.filter((x) => x !== off) as Signal[];
            const without = estimateVendor(adapter, onlySignals(w, rest), s);
            expect(
              without.monthly,
              `${name}, ${s.term} ${s.region}: dropping ${off} does not raise the bill`,
            ).toBeLessThanOrEqual(everything.monthly + 1e-6);
          }
        }
      }
    });

    it("does not get cheaper when the workload doubles", () => {
      for (const preset of presetWorkloads()) {
        for (const s of SETTINGS) {
          let previous = -1;
          for (const factor of [0.125, 0.25, 0.5, 1, 2, 4, 8]) {
            const estimate = estimateVendor(adapter, scaleWorkload(preset.workload, factor), s);
            if (!estimate.complete) continue;
            expect(
              estimate.monthly,
              `${preset.id} x${factor} costs at least as much as half of it`,
            ).toBeGreaterThanOrEqual(previous - 1e-6);
            previous = estimate.monthly;
          }
        }
      }
    });

    it("uses neutral wording and reports a shorter retention as data", () => {
      // Words a neutral price page does not use about a vendor's options,
      // and punctuation the site's copy rules exclude.
      const banned = /cheap|\u2014|!/i;
      for (const preset of presetWorkloads()) {
        for (const s of SETTINGS) {
          const estimate = estimateVendor(adapter, preset.workload, s);
          const texts = [
            adapter.plan(s),
            ...estimate.assumptions,
            ...estimate.included,
            ...estimate.notIncluded,
            ...estimate.notes,
            ...estimate.unpriced.map((u) => u.reason),
            ...estimate.lines.flatMap((l) => [l.label, l.detail ?? ""]),
          ];
          for (const text of texts) {
            expect(banned.test(text), `${preset.id}: "${text}" uses neutral wording`).toBe(false);
          }
          for (const gap of estimate.shortRetention) {
            expect(gap.kept, `${preset.id}: kept ${gap.signal} retention is positive`).toBeGreaterThan(0);
            expect(gap.kept).toBeLessThan(gap.asked);
          }
        }
      }
      // Asking for the longest retention the page offers must either be
      // priced in full or be reported as shorter: never silently capped.
      const long = structuredClone(PRESETS[1].workload);
      long.logs.retentionDays = 365;
      long.traces.retentionDays = 90;
      long.metrics.retentionMonths = 24;
      const estimate = estimateVendor(adapter, long, SETTINGS[0]);
      const limit =
        /(longest|maximum|at most|no more than|capped|limit)[^.]{0,80}(retention|days|months|year)|(retention|kept|keeps)[^.]{0,80}(longest|maximum|at most|no more than|capped|limit)/i;
      const capped = estimate.assumptions.filter((a) => limit.test(a));
      if (capped.length > 0 && estimate.complete) {
        expect(
          estimate.shortRetention.length,
          `assumptions mention a retention limit (${capped[0]}), so kept must report it`,
        ).toBeGreaterThan(0);
      }
    });

    it("says what it assumed and what it left out", () => {
      const estimate = estimateVendor(adapter, PRESETS[1].workload, SETTINGS[0]);
      expect(estimate.lines.length + estimate.unpriced.length).toBeGreaterThan(0);
      // With profiling on, a vendor that prices it bills it, and one that does not says so.
      const profiled = estimateVendor(adapter, withProfiles(PRESETS[1].workload), SETTINGS[0]);
      if (adapter.coverage.profiles === "priced") {
        expect(profiled.byBucket.profiles, "profiles are billed").toBeGreaterThan(0);
      } else {
        expect(profiled.unpriced.map((u) => u.bucket)).toContain("profiles");
      }
      expect(estimate.included.length + estimate.notIncluded.length).toBeGreaterThan(0);
      for (const text of [
        ...estimate.assumptions,
        ...estimate.included,
        ...estimate.notIncluded,
        ...estimate.notes,
      ]) {
        expect(text.trim().length).toBeGreaterThan(0);
      }
    });
  });
}
