/**
 * Every platform written as a spec: the worked examples the spec carries, and
 * a check that its text quotes only published prices. A spec vendor needs no
 * test file of its own. The contract checks run from contract.test.ts.
 */
import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import { usdRate } from "../format";
import type { Settings, Workload } from "../types";
import { BUCKETS } from "../types";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { SPEC_BUILT } from "./index";

it("has spec-built platforms to check", () => {
  expect(SPEC_BUILT.length).toBeGreaterThan(0);
});

for (const vendor of SPEC_BUILT) {
  describe(`${vendor.name}: worked examples`, () => {
    it("has at least one worked example", () => {
      expect(vendor.spec.examples.length).toBeGreaterThan(0);
    });

    for (const example of vendor.spec.examples) {
      it(example.name, () => {
        const preset = presetById(example.preset);
        expect(preset, `preset ${example.preset} exists`).toBeDefined();
        let w: Workload = structuredClone(preset!.workload);
        for (const [section, changes] of Object.entries(example.workload ?? {})) {
          const key = section as keyof Workload;
          w = { ...w, [key]: { ...(w[key] as object), ...(changes as object) } };
        }
        if (example.signals) w = onlySignals(w, example.signals);
        const s: Settings = { ...DEFAULT_SETTINGS, ...example.settings };

        const estimate = estimateVendor(vendor, w, s);
        if (typeof example.expect === "number") {
          expect(estimate.monthly).toBeCloseTo(example.expect, 6);
        } else {
          for (const bucket of BUCKETS) {
            const want = example.expect[bucket];
            if (want !== undefined) expect(estimate.byBucket[bucket], bucket).toBeCloseTo(want, 6);
          }
          if (example.expect.total !== undefined) {
            expect(estimate.monthly).toBeCloseTo(example.expect.total, 6);
          }
        }
        if (example.lines !== undefined) expect(estimate.lines).toHaveLength(example.lines);
        expect(estimate.complete).toBe(example.complete ?? true);
      });
    }
  });

  describe(`${vendor.name}: text`, () => {
    it("quotes no price that is not in the rates table", () => {
      const published = vendor.rates.map((r) => usdRate(r.usd));
      const preset = presetById("mid")!.workload;
      const odd = structuredClone(preset);
      odd.logs = { ...odd.logs, retentionDays: 90, searchableShare: 0.2 };
      odd.traces = { ...odd.traces, retentionDays: 7 };
      odd.metrics = { ...odd.metrics, retentionMonths: 24 };
      odd.send = { ...odd.send, profiles: true };
      const estimates = [
        estimateVendor(vendor, preset, DEFAULT_SETTINGS),
        estimateVendor(vendor, odd, { term: "monthly", region: "eu", queryLoad: "heavy" }),
        estimateVendor(vendor, onlySignals(preset, ["logs"]), DEFAULT_SETTINGS),
      ];
      const texts = [
        vendor.plan(DEFAULT_SETTINGS),
        ...vendor.rates.flatMap((r) => [r.label, r.unit, r.note ?? ""]),
        ...estimates.flatMap((e) => [
          ...e.assumptions,
          ...e.included,
          ...e.notIncluded,
          ...e.notes,
          ...e.lines.flatMap((l) => [l.label, l.detail ?? ""]),
        ]),
      ];
      for (const text of texts) {
        for (const price of text.match(/\$\d+(,\d{3})*(\.\d+)?/g) ?? []) {
          expect(published, `"${price}" in "${text}"`).toContain(price);
        }
      }
    });
  });
}
