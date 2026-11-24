import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import type { Workload } from "../types";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { splunk } from "./splunk";

// Mid preset: 200 hosts, 60% traced, 10 containers per host, 16 GiB per host,
// 250,000 series at 60 s, 2,000 spans/s at 1,000 bytes, 330 GB of logs a day.
const base = (): Workload => structuredClone(presetById("mid")!.workload);

describe("Splunk Observability Cloud: worked examples", () => {
  it("prices the mid preset by hand from Splunk's pages", () => {
    // splunk.com/en_us/products/pricing.html (read 2026-11-12):
    //   Infrastructure "Starts at $15 per host/month", App & Infra "Starts at $60 per host/month".
    // Mid preset: 200 hosts, 60% traced -> ceil(200 x 0.6) = 120 App & Infra hosts.
    //   App & Infra: 120 x $60 = $7,200 (covers metrics on those hosts too)
    //   Infrastructure: (200 - 120) x $15 = 80 x $15 = $1,200
    //   Total: $7,200 + $1,200 = $8,400 a month.
    // Allotments (Commercial/Standard, entitlements terms, pooled across the plan):
    //   containers 200 x 10 = 2,000 included, 200 x 10 = 2,000 used: inside.
    //   custom series: host series 250,000 x 0.25 = 62,500 are covered (billing docs:
    //   default and out-of-the-box receiver metrics are host and container metrics);
    //   custom 187,500 against 200 x 100 = 20,000: 167,500 over, no public price.
    //   trace volume 2,000 spans/s x 1,000 B x 60 s = 120 MB/min against
    //   120 x 10.24 = 1,228.8 MB/min: inside.
    // Logs: Splunk Cloud Platform, quote-only. Traces kept 8 days against 30 asked.
    const estimate = estimateVendor(splunk, base(), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(8400, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(7200, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(1200, 6);
    expect(estimate.byBucket.logs).toBe(0);
    expect(estimate.unpriced.map((u) => u.bucket).sort()).toEqual(["logs", "metrics"]);
    expect(estimate.unpriced.find((u) => u.bucket === "metrics")!.reason).toContain(
      "168K custom metric series are past the 20K included",
    );
    expect(estimate.shortRetention).toEqual([{ signal: "traces", asked: 30, kept: 8, unit: "days" }]);
    expect(estimate.assumptions[0]).toContain("Traces are kept 8 days");
    expect(estimate.complete).toBe(false);
  });

  it("prices 100 GB of logs a day at 30-day retention at nothing, as unpriced", () => {
    // 100 GB/day x 30 days = 3,000 GB a month. Observability Cloud stores no logs:
    // Log Observer Connect reads logs held in Splunk Cloud Platform or Splunk
    // Enterprise (service description), and splunk.com shows only "Get a quote"
    // for those. So $0 of priced lines and one unpriced logs entry.
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };
    const estimate = estimateVendor(splunk, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(estimate.lines).toEqual([]);
    expect(estimate.monthly).toBe(0);
    expect(estimate.unpriced).toHaveLength(1);
    expect(estimate.unpriced[0].bucket).toBe("logs");
    expect(estimate.complete).toBe(false);
  });

  it("matches the pricing page: one host of metrics starts at $15 a month", () => {
    // splunk.com/en_us/products/pricing.html: "Simple, host-based entity
    // pricing starting at $15 per host per month". 1 host x $15 = $15.
    // 100 series and 10 containers are exactly one host's Standard allotment.
    const w = base();
    w.infra = { ...w.infra, hosts: 1, containersPerHost: 10 };
    w.metrics = { ...w.metrics, activeSeries: 100 };
    const estimate = estimateVendor(splunk, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(estimate.monthly).toBeCloseTo(15, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(15, 6);
    expect(estimate.unpriced).toEqual([]);
    expect(estimate.complete).toBe(true);
  });

  it("prices metrics alone at the Infrastructure bundle and flags the custom metric overflow", () => {
    const estimate = estimateVendor(splunk, onlySignals(base(), ["metrics"]), DEFAULT_SETTINGS);
    // 200 hosts x $15 = $3,000
    expect(estimate.byBucket.metrics).toBeCloseTo(3000, 6);
    expect(estimate.monthly).toBeCloseTo(3000, 6);
    // Host series (25% of 250,000 = 62,500) are covered by the host fee.
    // Custom: 250,000 x 0.75 = 187,500 against 200 x 100 = 20,000 included: 167,500 over.
    // Containers: 200 x 10 = 2,000, exactly the 200 x 10 included.
    expect(estimate.unpriced).toHaveLength(1);
    expect(estimate.unpriced[0].bucket).toBe("metrics");
    expect(estimate.unpriced[0].reason).toContain("168K custom metric series are past the 20K included");
    expect(estimate.complete).toBe(false);
  });

  it("prices traces alone at the App & Infra bundle", () => {
    const estimate = estimateVendor(splunk, onlySignals(base(), ["traces"]), DEFAULT_SETTINGS);
    // Traced hosts: 200 x 0.6 = 120. 120 x $60 = $7,200.
    expect(estimate.byBucket.traces).toBeCloseTo(7200, 6);
    expect(estimate.monthly).toBeCloseTo(7200, 6);
    // Trace volume: 2,000 spans/s x 1,000 bytes x 60 s = 120 MB a minute,
    // inside 120 hosts x 10.24 MB = 1,228.8 MB. 10 containers per host is the allotment.
    expect(estimate.unpriced).toEqual([]);
    expect(estimate.complete).toBe(true);
    // The preset asks for 30 days of traces; the public price carries the 8-day default.
    const assumed = estimate.assumptions.join(" ");
    expect(assumed).toContain("Traces are kept 8 days");
    expect(assumed).toContain("30 days asked for");
    expect(estimate.shortRetention).toEqual([{ signal: "traces", asked: 30, kept: 8, unit: "days" }]);
  });

  it("leaves logs alone unpriced", () => {
    const estimate = estimateVendor(splunk, onlySignals(base(), ["logs"]), DEFAULT_SETTINGS);
    // Logs go to Splunk Cloud Platform, which has no public price: nothing is charged here.
    expect(estimate.lines).toEqual([]);
    expect(estimate.monthly).toBe(0);
    expect(estimate.unpriced).toHaveLength(1);
    expect(estimate.unpriced[0].bucket).toBe("logs");
    expect(estimate.unpriced[0].reason).toContain("Splunk Cloud Platform");
    expect(estimate.complete).toBe(false);
  });

  it("moves traced hosts to App & Infra when metrics and traces are both sent", () => {
    const estimate = estimateVendor(
      splunk,
      onlySignals(base(), ["metrics", "traces"]),
      DEFAULT_SETTINGS,
    );
    // 120 traced hosts x $60 = $7,200, which covers their metrics too.
    expect(estimate.byBucket.traces).toBeCloseTo(7200, 6);
    // The other 200 - 120 = 80 hosts x $15 = $1,200.
    expect(estimate.byBucket.metrics).toBeCloseTo(1200, 6);
    // $7,200 + $1,200 = $8,400, less than $3,000 + $7,200 for the two alone.
    expect(estimate.monthly).toBeCloseTo(8400, 6);
    expect(estimate.byBucket.platform).toBe(0);
  });

  it("charges the same for all three signals as for metrics and traces, and says logs are missing", () => {
    const estimate = estimateVendor(splunk, base(), DEFAULT_SETTINGS);
    // 120 x $60 + 80 x $15 = $8,400. Logs add nothing because they have no public price.
    expect(estimate.monthly).toBeCloseTo(8400, 6);
    expect(estimate.byBucket.logs).toBe(0);
    expect(estimate.unpriced.map((u) => u.bucket)).toContain("logs");
    expect(estimate.complete).toBe(false);
  });

  it("matches the docs example: 25 hosts include 250 containers, so 300 containers is 50 over", () => {
    // help.splunk.com, "Manage Infrastructure billing (Host and metrics plans)":
    // a plan of 25 hosts and 10 containers per host covers 250 containers, and
    // usage of 300 containers is 50 over the limit.
    const w = base();
    // 25 hosts x 100 custom series: at the allotment, all of them custom.
    w.metrics = { ...w.metrics, activeSeries: 2_500, hostSeriesShare: 0 };
    w.infra = { ...w.infra, hosts: 25, containersPerHost: 10 };
    const inside = estimateVendor(splunk, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    // 25 hosts x $15 = $375, and 25 x 10 = 250 containers is exactly the allotment.
    expect(inside.monthly).toBeCloseTo(375, 6);
    expect(inside.unpriced).toEqual([]);
    expect(inside.complete).toBe(true);

    w.infra = { ...w.infra, containersPerHost: 12 };
    const over = estimateVendor(splunk, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    // 25 x 12 = 300 containers against 250 included: 50 over. The host fee is still $375.
    expect(over.monthly).toBeCloseTo(375, 6);
    expect(over.unpriced).toHaveLength(1);
    expect(over.unpriced[0].bucket).toBe("metrics");
    expect(over.unpriced[0].reason).toContain("50 containers are past the 250 included");
    expect(over.complete).toBe(false);
  });

  it("crosses the custom metric allotment of 100 series per host", () => {
    const w = base();
    w.infra = { ...w.infra, hosts: 25 };
    w.metrics = { ...w.metrics, activeSeries: 2_600, hostSeriesShare: 0 };
    const estimate = estimateVendor(splunk, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    // All 2,600 series custom. 25 hosts x 100 = 2,500 included; 100 series over.
    // The host fee stays 25 x $15 = $375 and the overflow has no public price.
    expect(estimate.monthly).toBeCloseTo(375, 6);
    expect(estimate.unpriced).toHaveLength(1);
    expect(estimate.unpriced[0].reason).toContain("100 custom metric series are past the 2.5K included");
    expect(estimate.complete).toBe(false);
  });

  it("crosses the trace volume allotment of 10.24 MB a minute per traced host", () => {
    const w = base();
    w.infra = { ...w.infra, hosts: 10, tracedHostShare: 1 };
    // Allotment: 10 hosts x 10.24 MB = 102.4 MB a minute.
    w.traces = { ...w.traces, spansPerSecond: 1_700, avgSpanBytes: 1_000 };
    const inside = estimateVendor(splunk, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    // 1,700 x 1,000 bytes x 60 s = 102 MB a minute: inside. 10 hosts x $60 = $600.
    expect(inside.monthly).toBeCloseTo(600, 6);
    expect(inside.complete).toBe(true);

    w.traces = { ...w.traces, spansPerSecond: 1_800 };
    const over = estimateVendor(splunk, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    // 1,800 x 1,000 bytes x 60 s = 108 MB a minute: 5.6 MB past 102.4. Still $600 of host fees.
    expect(over.monthly).toBeCloseTo(600, 6);
    expect(over.unpriced).toHaveLength(1);
    expect(over.unpriced[0].bucket).toBe("traces");
    expect(over.unpriced[0].reason).toContain("108 MB a minute");
    expect(over.complete).toBe(false);
  });

  it("rounds traced hosts up to a whole host", () => {
    const w = base();
    w.infra = { ...w.infra, hosts: 25, tracedHostShare: 0.5 };
    const estimate = estimateVendor(splunk, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    // 25 x 0.5 = 12.5, billed as 13 hosts. 13 x $60 = $780.
    // 120 MB of spans a minute is inside 13 x 10.24 = 133.12 MB.
    expect(estimate.monthly).toBeCloseTo(780, 6);
    expect(estimate.complete).toBe(true);
  });

  it("leaves traces unpriced when no host is marked as running traced services", () => {
    const w = base();
    w.infra = { ...w.infra, tracedHostShare: 0 };
    const estimate = estimateVendor(splunk, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    // 200 hosts x 0 = 0 APM hosts, so there is no host fee to charge. Spans are
    // still sent, and the usage-based APM plan has no public price.
    expect(estimate.lines).toEqual([]);
    expect(estimate.monthly).toBe(0);
    expect(estimate.unpriced.map((u) => u.bucket)).toEqual(["traces"]);
    expect(estimate.complete).toBe(false);
  });

  it("keeps the 8-day price and names the retention option a longer ask would need", () => {
    const priceAt = (retentionDays: number) => {
      const w = base();
      w.traces = { ...w.traces, retentionDays };
      return estimateVendor(splunk, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    };
    // Raw trace retention is 8 days by default, with 15 or 30 days on request and no
    // public price. The host fee is 120 x $60 = $7,200 whatever is asked for.
    const eight = priceAt(8);
    expect(eight.monthly).toBeCloseTo(7200, 6);
    expect(eight.assumptions.join(" ")).not.toContain("asked for");

    const ten = priceAt(10);
    expect(ten.monthly).toBeCloseTo(7200, 6);
    expect(ten.assumptions.join(" ")).toContain("needs the 15-day option");

    const fortyFive = priceAt(45);
    expect(fortyFive.monthly).toBeCloseTo(7200, 6);
    expect(fortyFive.assumptions.join(" ")).toContain("past its longest option, 30 days");
  });

  it("flags dense Kubernetes nodes for both container allotments", () => {
    // Kubernetes preset: 50 nodes, all traced, 30 containers each, 250,000 series, 600 spans/s.
    const w = structuredClone(presetById("kubernetes")!.workload);
    const estimate = estimateVendor(
      splunk,
      onlySignals(w, ["metrics", "traces"]),
      DEFAULT_SETTINGS,
    );
    // Every node is traced, so all 50 are on App & Infra: 50 x $60 = $3,000.
    expect(estimate.byBucket.traces).toBeCloseTo(3000, 6);
    expect(estimate.byBucket.metrics).toBe(0);
    expect(estimate.monthly).toBeCloseTo(3000, 6);
    const reasons = estimate.unpriced.map((u) => u.reason).join(" ");
    // Infrastructure: 50 x 30 = 1,500 containers against 50 x 10 = 500 included: 1,000 over.
    expect(reasons).toContain("1,000 containers are past the 500 included");
    // Custom metrics: 250,000 x (1 - 0.9) = 25,000 custom against 50 x 100 = 5,000: 20,000 over.
    expect(reasons).toContain("20K custom metric series are past the 5K included");
    // APM: up to 1,500 containers could send spans against 500 included.
    expect(reasons).toContain("Up to 1,500 containers on traced hosts");
    expect(estimate.complete).toBe(false);
  });

  it("flags hosts larger than the 64 GB in Splunk's definition of a host", () => {
    const w = base();
    w.infra = { ...w.infra, hosts: 10, tracedHostShare: 1, memoryGibPerHost: 128 };
    // 1,000 spans/s x 1,000 bytes x 60 s = 60 MB a minute, inside 10 x 10.24 = 102.4 MB.
    w.traces = { ...w.traces, spansPerSecond: 1_000 };
    const estimate = estimateVendor(splunk, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    // 10 hosts x $60 = $600 is still shown, with the host size called out.
    expect(estimate.monthly).toBeCloseTo(600, 6);
    expect(estimate.unpriced.map((u) => u.bucket)).toEqual(["platform"]);
    expect(estimate.unpriced[0].reason).toContain("64 GB");
    expect(estimate.complete).toBe(false);
  });

  it("gives the same price on both billing terms, since only annual billing is published", () => {
    const w = onlySignals(base(), ["metrics", "traces"]);
    const annual = estimateVendor(splunk, w, { ...DEFAULT_SETTINGS, term: "annual" });
    const monthly = estimateVendor(splunk, w, { ...DEFAULT_SETTINGS, term: "monthly" });
    // Both: 120 x $60 + 80 x $15 = $8,400.
    expect(annual.monthly).toBeCloseTo(8400, 6);
    expect(monthly.monthly).toBeCloseTo(8400, 6);
    expect(monthly.notes.join(" ")).toContain("billed annually only");
    expect(splunk.plan({ ...DEFAULT_SETTINGS, term: "monthly" })).toContain("billed annually");
  });
});
