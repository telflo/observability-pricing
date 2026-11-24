import { describe, expect, it } from "vitest";
import { estimateVendor, onlySignals } from "../engine";
import { usdRate } from "../format";
import { derive } from "../units";
import type { Settings, VendorEstimate, Workload } from "../types";
import { DEFAULT_SETTINGS, presetById } from "../workloads";
import { newRelic } from "./new-relic";

// The mid-size preset: 330 GB/day of logs, 2,000 spans/s at 1,000 bytes,
// 250,000 series at 60 s and 150 bytes a point, 15 users, 30-day log and trace
// retention, 13-month metric retention.
const base = (): Workload => structuredClone(presetById("mid")!.workload);

const PAY_AS_YOU_GO: Settings = { ...DEFAULT_SETTINGS, term: "monthly" };
const EU: Settings = { ...DEFAULT_SETTINGS, region: "eu" };

/** The month's total of every line billed at one rate. */
const billedAt = (estimate: VendorEstimate, rateId: string) =>
  estimate.lines.filter((l) => l.rateId === rateId).reduce((sum, l) => sum + l.amount, 0);

const allText = (estimate: VendorEstimate) => [
  ...estimate.assumptions,
  ...estimate.included,
  ...estimate.notIncluded,
  ...estimate.notes,
  ...estimate.unpriced.map((u) => u.reason),
  ...estimate.lines.flatMap((l) => [l.label, l.detail ?? ""]),
];

// Rates read on newrelic.com/pricing on 2026-11-12: $0.40 per GB after 100 GB
// free, $0.05 per GB for the EU data center, Standard seats $10 then $99 (5 at
// most), Pro seats $349 on an annual commitment and $418.80 pay as you go.
// Added retention is $0.05 per GB ingested per 30 days (docs: manage data
// retention, and the usage plan's list price table).

describe("New Relic: hand-computed from the vendor's pages", () => {
  it("prices the mid-size preset at $12,706.80 a month on the default settings", () => {
    // Volumes (30-day month, GB = 10^9 bytes, which is New Relic's definition):
    //   logs     330 GB/day x 30 days                           =  9,900 GB
    //   traces   2,000 spans/s x 2,592,000 s x 1,000 bytes      =  5,184 GB
    //   metrics  250,000 series x 43,200 points x 150 bytes     =  1,620 GB
    //   total                                                   = 16,704 GB
    // Pricing page: "100 GB of free data ingest per month and $0.40/GB
    // ingested beyond", one rate whatever the data type.
    //   16,704 - 100 = 16,604 billable GB x $0.40               = $6,641.60
    // Retention docs: logs are kept 30 days and distributed traces 8 days on
    // the original data option. 30 days of traces needs one 30-day step of
    // added retention at $0.05 per GB ingested, charged on all data.
    //   16,604 GB x $0.05                                       =   $830.20
    // Pricing page: Standard is "limited to 5 full platform users", so 15
    // users need Pro at "$349/user (for annual commitments)".
    //   15 x $349                                               = $5,235.00
    //   total                                                   = $12,706.80
    const estimate = estimateVendor(newRelic, base(), DEFAULT_SETTINGS);
    expect(billedAt(estimate, "data-original")).toBeCloseTo(6641.6, 6);
    expect(billedAt(estimate, "extended-retention")).toBeCloseTo(830.2, 6);
    expect(billedAt(estimate, "pro-user-annual")).toBeCloseTo(5235, 6);
    expect(estimate.lines).toHaveLength(7);
    expect(estimate.monthly).toBeCloseTo(12706.8, 6);
    expect(estimate.complete).toBe(true);

    // Each signal carries its share of the 16,604 billable GB, at $0.40 for
    // ingest plus $0.05 for the retention step:
    //   logs     16,604 x  9,900 / 16,704 = 9,840.73 GB x $0.45 = $4,428.33
    //   metrics  16,604 x  1,620 / 16,704 = 1,610.30 GB x $0.45 =   $724.64
    //   traces   16,604 x  5,184 / 16,704 = 5,152.97 GB x $0.45 = $2,318.83
    expect(estimate.byBucket.logs).toBeCloseTo(((16_604 * 9_900) / 16_704) * 0.45, 6);
    expect(estimate.byBucket.metrics).toBeCloseTo(((16_604 * 1_620) / 16_704) * 0.45, 6);
    expect(estimate.byBucket.traces).toBeCloseTo(((16_604 * 5_184) / 16_704) * 0.45, 6);
    expect(estimate.byBucket.platform).toBeCloseTo(5235, 6);

    // Pay as you go changes only the seats: 15 x $418.80 = $6,282.
    const payg = estimateVendor(newRelic, base(), PAY_AS_YOU_GO);
    expect(billedAt(payg, "pro-user-payg")).toBeCloseTo(6282, 6);
    expect(payg.monthly).toBeCloseTo(6641.6 + 830.2 + 6282, 6);

    // The EU data center adds $0.05 on each billable GB: 16,604 x $0.05 = $830.20.
    const eu = estimateVendor(newRelic, base(), EU);
    expect(billedAt(eu, "eu-data-center")).toBeCloseTo(830.2, 6);
    expect(eu.monthly).toBeCloseTo(12706.8 + 830.2, 6);
  });

  it("prices 100 GB of logs a day alone, kept 30 days", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };
    const estimate = estimateVendor(newRelic, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // 100 GB/day x 30 days = 3,000 GB - 100 GB free = 2,900 GB x $0.40 = $1,160.
    // Logs are kept 30 days by default, so no retention is added.
    // The preset's 15 users are more than Standard's 5: Pro, 15 x $349 = $5,235.
    // Total $6,395.
    expect(estimate.lines).toHaveLength(2);
    expect(billedAt(estimate, "data-original")).toBeCloseTo(1160, 6);
    expect(billedAt(estimate, "extended-retention")).toBe(0);
    expect(estimate.byBucket.logs).toBeCloseTo(1160, 6);
    expect(estimate.byBucket.metrics).toBe(0);
    expect(estimate.byBucket.traces).toBe(0);
    expect(estimate.byBucket.platform).toBeCloseTo(5235, 6);
    expect(estimate.monthly).toBeCloseTo(6395, 6);

    // Pay as you go: $1,160 + 15 x $418.80 = $7,442.
    const payg = estimateVendor(newRelic, onlySignals(w, ["logs"]), PAY_AS_YOU_GO);
    expect(payg.monthly).toBeCloseTo(7442, 6);
  });
});

describe("New Relic: worked examples", () => {
  it("counts 100.2 GB as 101 GB, the rounding example in New Relic's billing docs", () => {
    // docs.newrelic.com, "How New Relic pricing works": "if your organization
    // uses 100.2 GBs during a month, that's counted as 101 GBs."
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 3.34, retentionDays: 30 }; // 3.34 x 30 = 100.2 GB
    w.users = 1;
    const estimate = estimateVendor(newRelic, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // 101 GB counted - 100 GB free = 1 GB x $0.40 = $0.40
    expect(estimate.byBucket.logs).toBeCloseTo(0.4, 6);
    // Past the free 100 GB the account is on Standard: first user $10
    expect(estimate.byBucket.platform).toBeCloseTo(10, 6);
    expect(estimate.monthly).toBeCloseTo(10.4, 6);
  });

  it("prices traces alone, with one retention step for a 30-day ask", () => {
    const estimate = estimateVendor(newRelic, onlySignals(base(), ["traces"]), DEFAULT_SETTINGS);
    // 2,000 spans/s x 2,592,000 s = 5.184B spans x 1,000 bytes = 5,184 GB.
    // 5,184 - 100 free = 5,084 GB x $0.40 = $2,033.60.
    // Spans are kept 8 days by default. 30 days needs one 30-day step, charged
    // on all billable data: 5,084 GB x $0.05 = $254.20.
    expect(estimate.byBucket.traces).toBeCloseTo(2033.6 + 254.2, 6);
    expect(estimate.byBucket.logs).toBe(0);
    expect(estimate.byBucket.metrics).toBe(0);
    // 15 Pro users x $349 = $5,235
    expect(estimate.monthly).toBeCloseTo(2287.8 + 5235, 6);
    expect(estimate.assumptions.join(" ")).toContain("traces 38 days");

    // Asking for the default 8 days drops the retention step.
    const w = base();
    w.traces = { ...w.traces, retentionDays: 8 };
    const short = estimateVendor(newRelic, onlySignals(w, ["traces"]), DEFAULT_SETTINGS);
    expect(short.byBucket.traces).toBeCloseTo(2033.6, 6);
  });

  it("prices metrics alone, by size", () => {
    const estimate = estimateVendor(newRelic, onlySignals(base(), ["metrics"]), DEFAULT_SETTINGS);
    // 250,000 series x 43,200 points a month = 10.8B points x 150 bytes = 1,620 GB.
    // 1,620 - 100 free = 1,520 GB x $0.40 = $608. Metric rollups are kept 13
    // months, which covers the 13 months asked.
    expect(estimate.byBucket.metrics).toBeCloseTo(608, 6);
    expect(estimate.byBucket.logs).toBe(0);
    expect(estimate.byBucket.traces).toBe(0);
    // 15 Pro users x $349 = $5,235
    expect(estimate.monthly).toBeCloseTo(608 + 5235, 6);
    // Raw points are kept 30 days, so the 13 months is met by rollups. Say so.
    expect(estimate.assumptions.join(" ")).toContain(
      "raw data points 30 days and rollups of one minute and longer 13 months",
    );
  });

  it("charges nothing on the Free edition: one user and under 100 GB", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 3, retentionDays: 30 }; // 90 GB a month
    w.users = 1;
    const free = estimateVendor(newRelic, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(free.lines).toEqual([]);
    expect(free.monthly).toBe(0);
    expect(free.assumptions.join(" ")).toContain("Edition: Free");

    // The same 90 GB with five users: data is still free, seats are not.
    // Standard: $10 + 4 x $99 = $406.
    w.users = 5;
    const standard = estimateVendor(newRelic, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(standard.byBucket.logs).toBe(0);
    expect(standard.monthly).toBeCloseTo(406, 6);
  });

  it("moves from Standard to Pro at the sixth full platform user", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };

    w.users = 5;
    const five = estimateVendor(newRelic, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // Standard: $10 for the first user + 4 x $99 = $406
    expect(five.byBucket.platform).toBeCloseTo(406, 6);
    expect(five.assumptions.join(" ")).toContain("Edition: Standard");
    // Standard has one published seat price, so pay as you go is the same.
    const fivePayg = estimateVendor(newRelic, onlySignals(w, ["logs"]), PAY_AS_YOU_GO);
    expect(fivePayg.byBucket.platform).toBeCloseTo(406, 6);

    w.users = 6;
    const six = estimateVendor(newRelic, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // Pro, annual commitment: 6 x $349 = $2,094
    expect(six.byBucket.platform).toBeCloseTo(2094, 6);
    expect(six.assumptions.join(" ")).toContain("Edition: Pro");
    const sixPayg = estimateVendor(newRelic, onlySignals(w, ["logs"]), PAY_AS_YOU_GO);
    // Pro, pay as you go: 6 x $418.80 = $2,512.80
    expect(sixPayg.byBucket.platform).toBeCloseTo(2512.8, 6);
    // Data is the same on both terms: 2,900 GB x $0.40 = $1,160
    expect(six.byBucket.logs).toBeCloseTo(1160, 6);
    expect(sixPayg.byBucket.logs).toBeCloseTo(1160, 6);
  });

  it("never describes Standard seats as an annual commitment", () => {
    // Pricing page FAQ: pay as you go is offered on Standard and Pro,
    // commitment contracts on Pro and Enterprise only.
    expect(newRelic.plan(DEFAULT_SETTINGS)).toContain("Pro seats on an annual commitment");
    expect(newRelic.plan(PAY_AS_YOU_GO)).toContain("pay as you go");
    expect(newRelic.plan(PAY_AS_YOU_GO)).not.toContain("annual");
    expect(newRelic.plan(EU)).toContain("EU data center");

    const w = base();
    w.users = 5;
    const standard = estimateVendor(newRelic, w, DEFAULT_SETTINGS);
    expect(standard.assumptions[0]).toContain("Standard is sold pay as you go only");
    const seatLines = standard.lines.filter((l) => l.bucket === "platform");
    expect(seatLines.map((l) => l.rateId)).toEqual([
      "standard-first-user",
      "standard-additional-user",
    ]);
    for (const line of seatLines) expect(`${line.label} ${line.detail}`).not.toContain("annual");
  });

  it("adds $0.05 per billable GB in the EU data center", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 30 };
    const estimate = estimateVendor(newRelic, onlySignals(w, ["logs"]), EU);
    // 2,900 billable GB x ($0.40 + $0.05) = $1,305
    expect(estimate.byBucket.logs).toBeCloseTo(1305, 6);
  });

  it("buys longer retention in 30-day steps", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 45 };
    const oneStep = estimateVendor(newRelic, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // 45 days is past the 30-day default: one step, logs kept 60 days.
    // 2,900 GB x $0.40 + 2,900 GB x 1 x $0.05 = $1,160 + $145 = $1,305
    expect(oneStep.byBucket.logs).toBeCloseTo(1305, 6);
    expect(oneStep.assumptions.join(" ")).toContain("logs 60 days");
    // One step is a plain per-GB charge on the 2,900 billable GB.
    const one = oneStep.lines.find((l) => l.rateId === "extended-retention")!;
    expect(one.quantity).toBeCloseTo(2900, 6);
    expect(one.unit).toBe("GB");

    w.logs = { ...w.logs, retentionDays: 90 };
    const twoSteps = estimateVendor(newRelic, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // 90 days = 30 + 2 x 30: $1,160 + 2,900 GB x 2 x $0.05 = $1,160 + $290 = $1,450
    expect(twoSteps.byBucket.logs).toBeCloseTo(1450, 6);
    const two = twoSteps.lines.find((l) => l.rateId === "extended-retention")!;
    expect(two.quantity).toBeCloseTo(5800, 6);
    expect(two.unit).toBe("GB-steps");
  });

  it("charges a retention step on every signal, and says which one asked for it", () => {
    const estimate = estimateVendor(newRelic, base(), DEFAULT_SETTINGS);
    const detailFor = (bucket: string) =>
      estimate.lines.find((l) => l.rateId === "extended-retention" && l.bucket === bucket)!.detail;
    // Only traces asked for more than the default. Logs and metrics pay too.
    expect(detailFor("traces")).toContain("Keeps traces 38 days.");
    expect(detailFor("logs")).toContain("Charged on all data. Logs are kept 60 days.");
    expect(detailFor("metrics")).toContain("Metric retention does not change.");
    // The page shows the first three assumptions: edition, retention, sizing.
    expect(estimate.assumptions[0]).toContain("Edition: Pro");
    expect(estimate.assumptions[1]).toContain("The 30 days asked for traces is priced with 1 step");
    expect(estimate.assumptions[2]).toContain("This estimate bills the bytes sent");
  });

  it("stops added retention at the 395-day limit and says so", () => {
    const w = base();
    w.logs = { ...w.logs, gbPerDay: 100, retentionDays: 730 };
    const estimate = estimateVendor(newRelic, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    // 30 + 12 x 30 = 390 days is the longest step under 395 days.
    // $1,160 + 2,900 GB x 12 x $0.05 = $1,160 + $1,740 = $2,900
    expect(estimate.byBucket.logs).toBeCloseTo(2900, 6);
    expect(estimate.assumptions.join(" ")).toContain("390 days is priced");
  });

  it("prices the default retention when less is asked, and says so", () => {
    const w = base();
    w.logs = { ...w.logs, retentionDays: 15 };
    w.traces = { ...w.traces, retentionDays: 7 };
    const estimate = estimateVendor(newRelic, w, DEFAULT_SETTINGS);
    // No retention step: 16,604 GB x $0.40 = $6,641.60, plus 15 x $349.
    expect(billedAt(estimate, "extended-retention")).toBe(0);
    expect(estimate.monthly).toBeCloseTo(6641.6 + 5235, 6);
    const text = estimate.assumptions.join(" ");
    expect(text).toContain("Logs: 15 days asked.");
    expect(text).toContain("so 30 days is priced");
    expect(text).toContain("Traces: 7 days asked.");
    expect(text).toContain("so 8 days is priced");
  });

  it("says the price is incomplete past 15M metric series in one account", () => {
    // Docs, "Manage cardinality": an account includes a budget of 15 million
    // unique series a day. A budget of up to 200 million needs the Advanced
    // Compute add-on, and the extra cardinality consumes compute units at a
    // rate that is not published.
    const w = base();
    w.metrics = { ...w.metrics, activeSeries: 15_000_000 };
    const atBudget = estimateVendor(newRelic, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(atBudget.complete).toBe(true);
    expect(atBudget.notes.join(" ")).toContain("One account includes 15M unique metric series a day");

    w.metrics = { ...w.metrics, activeSeries: 20_000_000 };
    const past = estimateVendor(newRelic, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    expect(past.complete).toBe(false);
    expect(past.unpriced).toHaveLength(1);
    expect(past.unpriced[0].bucket).toBe("metrics");
    expect(past.unpriced[0].reason).toContain("15M unique metric series a day");
    expect(past.unpriced[0].reason).toContain("20M active series");
    expect(past.unpriced[0].reason).toContain("up to 200M");
    // Ingest is still priced: 20M series x 43,200 points x 150 bytes = 129,600 GB.
    // 129,600 - 100 free = 129,500 GB x $0.40 = $51,800.
    expect(past.byBucket.metrics).toBeCloseTo(51_800, 6);
  });

  it("keeps metric retention at 13 months when more is asked", () => {
    const w = base();
    w.metrics = { ...w.metrics, retentionMonths: 24 };
    const estimate = estimateVendor(newRelic, onlySignals(w, ["metrics"]), DEFAULT_SETTINGS);
    // Same 1,520 billable GB x $0.40 = $608: metric retention cannot be bought.
    expect(estimate.byBucket.metrics).toBeCloseTo(608, 6);
    expect(estimate.assumptions.join(" ")).toContain("13 months is priced");
    // Shorter than asked: reported in kept and said first.
    expect(estimate.shortRetention).toEqual([
      { signal: "metrics", asked: 24, kept: 13, unit: "months" },
    ]);
    expect(estimate.assumptions[0]).toContain("Metrics: 24 months asked");
  });

  it("returns the retention the price buys wherever it differs from the ask", () => {
    // Mid preset: one step for traces, so logs are kept 60 days and traces 38
    // days against 30 asked for each. Metrics: 13 months asked, 13 kept.
    const mid = newRelic.price({ w: base(), d: derive(base()), s: DEFAULT_SETTINGS });
    expect(mid.kept).toEqual({ logsDays: 60, tracesDays: 38 });
    expect(estimateVendor(newRelic, base(), DEFAULT_SETTINGS).shortRetention).toEqual([]);

    // Past the 395-day limit: 390 days kept for 730 asked, and said first.
    const w = base();
    w.logs = { ...w.logs, retentionDays: 730 };
    const long = estimateVendor(newRelic, onlySignals(w, ["logs"]), DEFAULT_SETTINGS);
    expect(long.shortRetention).toEqual([{ signal: "logs", asked: 730, kept: 390, unit: "days" }]);
    expect(long.assumptions[0]).toContain("Logs: 730 days asked");
  });

  it("uses the multiplication sign in line details", () => {
    const estimate = estimateVendor(newRelic, base(), DEFAULT_SETTINGS);
    for (const line of estimate.lines) expect(line.detail ?? "").not.toMatch(/\d x /);
    expect(estimate.lines.some((l) => (l.detail ?? "").includes(" × "))).toBe(true);
  });
});

describe("New Relic: text", () => {
  const scenarios = (): VendorEstimate[] => {
    const standard = base();
    standard.users = 5;
    const free = base();
    free.logs = { ...free.logs, gbPerDay: 3 };
    free.users = 1;
    const long = base();
    long.logs = { ...long.logs, retentionDays: 730, searchableShare: 0.3 };
    long.metrics = { ...long.metrics, retentionMonths: 24, activeSeries: 20_000_000 };
    return [
      estimateVendor(newRelic, base(), DEFAULT_SETTINGS),
      estimateVendor(newRelic, base(), { ...PAY_AS_YOU_GO, region: "eu" }),
      estimateVendor(newRelic, standard, DEFAULT_SETTINGS),
      estimateVendor(newRelic, standard, PAY_AS_YOU_GO),
      estimateVendor(newRelic, onlySignals(free, ["logs"]), DEFAULT_SETTINGS),
      estimateVendor(newRelic, long, DEFAULT_SETTINGS),
    ];
  };

  it("quotes only prices that are in the rates table", () => {
    const published = new Set(newRelic.rates.map((r) => usdRate(r.usd)));
    for (const estimate of scenarios()) {
      for (const text of allText(estimate)) {
        for (const price of text.match(/\$\d[\d,]*(\.\d+)?/g) ?? []) {
          expect(published, `"${price}" in "${text}"`).toContain(price);
        }
      }
    }
  });

  it("uses no em dashes or semicolons, and rate notes that can end a sentence", () => {
    for (const estimate of scenarios()) {
      for (const text of [...allText(estimate), ...[DEFAULT_SETTINGS, PAY_AS_YOU_GO, EU].map(newRelic.plan)]) {
        expect(text).not.toMatch(/[—–;]/);
      }
    }
    // The page prints "<note>. Source: ..." after each rate.
    for (const rate of newRelic.rates) expect(rate.note ?? "").not.toMatch(/\.$/);
  });
});
