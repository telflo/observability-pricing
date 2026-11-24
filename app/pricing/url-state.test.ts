import { describe, expect, it } from "vitest";
import { estimateAll } from "./engine";
import { csvCell, describeWorkload, toCsv, toMarkdown } from "./export";
import { sizeFromHosts } from "./sizing";
import { DEFAULT_VIEW, LIMITS, decodeState, encodeState, sameWorkload } from "./url-state";
import { VENDORS } from "./vendors";
import { DEFAULT_SETTINGS, PRESETS, defaultWorkload } from "./workloads";

describe("share links", () => {
  it("writes nothing for the default workload", () => {
    const query = encodeState({ w: defaultWorkload(), s: DEFAULT_SETTINGS, route: null });
    expect(query.toString()).toBe("");
  });

  it("round-trips every preset, the settings and a hand-picked split", () => {
    for (const preset of PRESETS) {
      const state = {
        w: preset.workload,
        s: { term: "monthly", region: "eu", queryLoad: "heavy" } as const,
        route: { logs: "signoz", metrics: null, traces: "clickhouse", profiles: null },
      };
      const back = decodeState(new URLSearchParams(encodeState(state).toString()));
      expect(sameWorkload(back.w, preset.workload), preset.id).toBe(true);
      expect(back.s).toEqual(state.s);
      expect(back.route).toEqual(state.route);
    }
  });

  it("keeps a switched-off signal off and non-default assumptions", () => {
    const w = defaultWorkload();
    w.send.traces = false;
    w.logs.avgRecordBytes = 400;
    w.logs.searchableShare = 0.2;
    w.metrics.intervalSeconds = 15;
    const back = decodeState(encodeState({ w, s: DEFAULT_SETTINGS, route: null }));
    expect(back.w.send).toEqual({ logs: true, metrics: true, traces: false, profiles: false });
    expect(back.w.logs.avgRecordBytes).toBe(400);
    expect(back.w.logs.searchableShare).toBeCloseTo(0.2);
    expect(back.w.metrics.intervalSeconds).toBe(15);
  });

  it("ignores junk and clamps out-of-range values", () => {
    const back = decodeState(
      new URLSearchParams("lg=abc&ms=-5&ts=9e99&h=0&term=x&rg=mars&q=z&lr=31&rl=../etc"),
    );
    const base = defaultWorkload();
    expect(back.w.logs.gbPerDay).toBe(base.logs.gbPerDay);
    // A volume is never below the form's minimum: a signal is turned off
    // with its switch, not with a zero.
    expect(back.w.metrics.activeSeries).toBe(LIMITS.activeSeries.min);
    expect(back.w.traces.spansPerSecond).toBe(500_000);
    expect(back.w.infra.hosts).toBe(1);
    expect(back.w.logs.retentionDays).toBe(base.logs.retentionDays);
    expect(back.s).toEqual(DEFAULT_SETTINGS);
    expect(back.route).toBeNull();
  });
});

describe("share links: the view", () => {
  it("keeps zero volumes out, so every switched-on signal has something to price", () => {
    const back = decodeState(new URLSearchParams("lg=0&ms=0&ts=0"));
    expect(back.w.send).toEqual({ logs: true, metrics: true, traces: true, profiles: false });
    expect(back.w.logs.gbPerDay).toBe(LIMITS.logGbPerDay.min);
    expect(back.w.metrics.activeSeries).toBe(LIMITS.activeSeries.min);
    expect(back.w.traces.spansPerSecond).toBe(LIMITS.spansPerSecond.min);
  });

  it("carries the period, the sort, the open receipts and the current bill", () => {
    const state = {
      w: defaultWorkload(),
      s: DEFAULT_SETTINGS,
      route: null,
      bill: 90_000,
      view: { period: "year", sort: "high", open: ["datadog", "grafana-cloud"] } as const,
    };
    const query = encodeState({ ...state, view: { ...state.view, open: [...state.view.open] } });
    expect(query.toString()).toBe("b=90000&p=y&o=h&v=datadog%2Cgrafana-cloud");
    const back = decodeState(new URLSearchParams(query.toString()));
    expect(back.bill).toBe(90_000);
    expect(back.view).toEqual({ period: "year", sort: "high", open: ["datadog", "grafana-cloud"] });
  });

  it("opens the default view from a bare link and drops junk receipt ids", () => {
    expect(decodeState(new URLSearchParams("")).view).toEqual(DEFAULT_VIEW);
    const back = decodeState(new URLSearchParams("v=datadog,../x,,UPPER&p=z&o=q"));
    expect(back.view).toEqual({ period: "month", sort: "low", open: ["datadog"] });
  });

  it("keeps a typed value exactly", () => {
    const w = defaultWorkload();
    w.metrics.activeSeries = 12_345_678;
    w.logs.gbPerDay = 0.1 + 0.2 + 5; // float noise is trimmed, the value is not rounded away
    const back = decodeState(encodeState({ w, s: DEFAULT_SETTINGS, route: null }));
    expect(back.w.metrics.activeSeries).toBe(12_345_678);
    expect(back.w.logs.gbPerDay).toBe(5.3);
  });

  it("keeps containers per host and the head-to-head picks apart", () => {
    const w = defaultWorkload();
    w.infra.containersPerHost = 30;
    const both = decodeState(
      encodeState({ w, s: DEFAULT_SETTINGS, route: null, compare: ["datadog", "axiom"] }),
    );
    expect(both.w.infra.containersPerHost).toBe(30);
    expect(both.compare).toEqual(["datadog", "axiom"]);

    // Containers alone must not come back as a pick.
    const alone = decodeState(encodeState({ w, s: DEFAULT_SETTINGS, route: null }));
    expect(alone.w.infra.containersPerHost).toBe(30);
    expect(alone.compare).toBeNull();
  });
});

describe("sizing from hosts", () => {
  it("fills the three volumes from the host count", () => {
    const w = sizeFromHosts(defaultWorkload(), 100);
    expect(w.logs.gbPerDay).toBe(160);
    expect(w.metrics.activeSeries).toBe(130_000);
    expect(w.traces.spansPerSecond).toBe(1000);
    expect(w.infra.hosts).toBe(100);
  });

  it("stays within the form's limits, so a copied link opens at the same price", () => {
    const w = sizeFromHosts(defaultWorkload(), LIMITS.hosts.max);
    expect(w.logs.gbPerDay).toBe(LIMITS.logGbPerDay.max);
    expect(w.metrics.activeSeries).toBe(LIMITS.activeSeries.max);
    expect(w.traces.spansPerSecond).toBeLessThanOrEqual(LIMITS.spansPerSecond.max);
    const back = decodeState(encodeState({ w, s: DEFAULT_SETTINGS, route: null }));
    expect(sameWorkload(back.w, w)).toBe(true);
  });
});

describe("exports", () => {
  const w = defaultWorkload();
  const estimates = estimateAll(VENDORS, w, DEFAULT_SETTINGS);

  it("writes CSV fields a spreadsheet will not run as formulas", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("line\rbreak")).toBe('"line\rbreak"');
    expect(csvCell(null)).toBe("");
  });

  it("describes the workload in one sentence", () => {
    expect(describeWorkload(w, DEFAULT_SETTINGS)).toContain("330 GB of logs a day kept 30 days");
  });

  it("writes one Markdown row per platform, with the link", () => {
    const md = toMarkdown(estimates, w, DEFAULT_SETTINGS, "https://example.com/x");
    for (const e of estimates) expect(md).toContain(`| ${e.vendor.name} |`);
    expect(md).toContain("https://example.com/x");
    expect(md).toContain("These are not quotes");
  });

  it("keeps partly priced platforms out of the ranked Markdown table", () => {
    const md = toMarkdown(estimates, w, DEFAULT_SETTINGS);
    const partial = estimates.filter((e) => !e.complete);
    expect(partial.length).toBeGreaterThan(0);
    const cut = md.indexOf("**Part of this has no public price.**");
    expect(cut).toBeGreaterThan(0);
    for (const e of estimates) {
      const at = md.indexOf(`| ${e.vendor.name} |`);
      expect(e.complete ? at < cut : at > cut, e.vendor.name).toBe(true);
    }
    // A platform with nothing priced never shows as a zero-dollar bill.
    expect(md).not.toContain("$0.00");
    for (const e of partial.filter((x) => x.monthly === 0)) {
      const row = md.split("\n").find((line) => line.startsWith(`| ${e.vendor.name} |`))!;
      expect(row).toContain("Not priced");
    }
  });

  it("writes one CSV row per line item, each with a source, and a total per platform", () => {
    const csv = toCsv(estimates, w, DEFAULT_SETTINGS).split("\n");
    const lines = estimates.reduce((n, e) => n + e.lines.length + e.unpriced.length, 0);
    // The header, the workload row, every line and gap, and one total per platform.
    expect(csv.length).toBe(1 + 1 + lines + estimates.length);
    const header = csv[0].split(",");
    expect(header).toContain("source_url");
    expect(header).toContain("status");
    expect(csv[1]).toContain("330 GB of logs a day kept 30 days");
    for (const row of csv.slice(2)) expect(row).toMatch(/https:\/\//);

    const totals = csv.filter((row) => row.includes(",total,Total,"));
    expect(totals.length).toBe(estimates.length);
    // Plan names contain commas, so read the status by what it says.
    expect(totals.filter((row) => row.includes(",complete,")).length).toBeGreaterThan(0);
    expect(totals.some((row) => row.includes("no public price for part of"))).toBe(true);
  });
});

describe("registry", () => {
  it("lists every platform once, in alphabetical order", () => {
    const ids = VENDORS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = VENDORS.map((v) => v.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
