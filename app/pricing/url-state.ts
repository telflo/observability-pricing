/**
 * The calculator's state as a short query string, so any estimate is a link.
 * Only values that differ from the default workload are written.
 */
import type { Route } from "./engine";
import type { Settings, Workload } from "./types";
import { DEFAULT_SETTINGS, defaultWorkload } from "./workloads";

export interface CalculatorState {
  w: Workload;
  s: Settings;
  /** A split chosen by hand; null follows the lowest-cost split. */
  route: Route | null;
  /** What the visitor pays today, in US dollars a month; drawn as a marker. */
  bill?: number | null;
  /** Platforms picked for the head-to-head; null follows the lowest estimates. */
  compare?: string[] | null;
  /** How the results are shown, so a copied link opens the same view. */
  view?: View;
}

export interface View {
  period: "month" | "year";
  sort: "low" | "high" | "name";
  /** Vendor ids whose receipts are open. */
  open: string[];
}

export const DEFAULT_VIEW: View = { period: "month", sort: "low", open: [] };

/** Input limits, shared with the form controls. */
export const LIMITS = {
  logGbPerDay: { min: 1, max: 20_000 },
  activeSeries: { min: 1_000, max: 20_000_000 },
  spansPerSecond: { min: 10, max: 500_000 },
  hosts: { min: 1, max: 20_000 },
  users: { min: 1, max: 1_000 },
  avgRecordBytes: { min: 100, max: 5_000 },
  avgSpanBytes: { min: 100, max: 5_000 },
  bytesPerDataPoint: { min: 8, max: 1_000 },
  containersPerHost: { min: 0, max: 200 },
  memoryGibPerHost: { min: 1, max: 1_024 },
  samplesPerSecondPerHost: { min: 1, max: 2_000 },
  bytesPerSample: { min: 10, max: 2_000 },
} as const;

export const LOG_RETENTION_DAYS = [7, 15, 30, 90, 180, 365];
export const TRACE_RETENTION_DAYS = [7, 15, 30, 90];
export const METRIC_RETENTION_MONTHS = [1, 3, 6, 13, 24];
export const INTERVALS_SECONDS = [10, 15, 30, 60];

const TERM = { a: "annual", m: "monthly" } as const;
const QUERY = { l: "light", t: "typical", h: "heavy" } as const;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function readNumber(
  params: URLSearchParams,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

function readOption(params: URLSearchParams, key: string, options: number[], fallback: number) {
  const n = Number(params.get(key));
  return options.includes(n) ? n : fallback;
}

const VENDOR_ID = /^[a-z0-9-]{1,40}$/;

function readVendorId(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key);
  return raw && VENDOR_ID.test(raw) ? raw : null;
}

/** A comma-separated list of vendor ids, without junk or repeats. */
function readVendorIds(params: URLSearchParams, key: string, max: number): string[] {
  const ids = (params.get(key) ?? "").split(",").filter((id) => VENDOR_ID.test(id));
  return [...new Set(ids)].slice(0, max);
}

export function decodeState(params: URLSearchParams): CalculatorState {
  const base = defaultWorkload();
  const off = (key: string) => params.get(key) === "0";

  const logsOff = off("lo");
  const metricsOff = off("mo");
  const tracesOff = off("to");
  // Profiles are off by default, so the link records them being on.
  const profilesOn = params.get("po") === "1";

  const w: Workload = {
    send: { logs: !logsOff, metrics: !metricsOff, traces: !tracesOff, profiles: profilesOn },
    logs: {
      // Volumes obey the form's minimums. A signal is turned off with its
      // switch (lo, mo, to), never with a zero.
      gbPerDay: readNumber(
        params,
        "lg",
        base.logs.gbPerDay,
        LIMITS.logGbPerDay.min,
        LIMITS.logGbPerDay.max,
      ),
      avgRecordBytes: readNumber(
        params,
        "lb",
        base.logs.avgRecordBytes,
        LIMITS.avgRecordBytes.min,
        LIMITS.avgRecordBytes.max,
      ),
      retentionDays: readOption(params, "lr", LOG_RETENTION_DAYS, base.logs.retentionDays),
      searchableShare: readNumber(params, "ls", base.logs.searchableShare * 100, 1, 100) / 100,
    },
    metrics: {
      activeSeries: readNumber(
        params,
        "ms",
        base.metrics.activeSeries,
        LIMITS.activeSeries.min,
        LIMITS.activeSeries.max,
      ),
      intervalSeconds: readOption(params, "mi", INTERVALS_SECONDS, base.metrics.intervalSeconds),
      bytesPerDataPoint: readNumber(
        params,
        "mb",
        base.metrics.bytesPerDataPoint,
        LIMITS.bytesPerDataPoint.min,
        LIMITS.bytesPerDataPoint.max,
      ),
      retentionMonths: readOption(params, "mr", METRIC_RETENTION_MONTHS, base.metrics.retentionMonths),
      hostSeriesShare: readNumber(params, "mh", base.metrics.hostSeriesShare * 100, 0, 100) / 100,
    },
    traces: {
      spansPerSecond: readNumber(
        params,
        "ts",
        base.traces.spansPerSecond,
        LIMITS.spansPerSecond.min,
        LIMITS.spansPerSecond.max,
      ),
      avgSpanBytes: readNumber(
        params,
        "tb",
        base.traces.avgSpanBytes,
        LIMITS.avgSpanBytes.min,
        LIMITS.avgSpanBytes.max,
      ),
      retentionDays: readOption(params, "tr", TRACE_RETENTION_DAYS, base.traces.retentionDays),
      searchableShare: readNumber(params, "tsh", base.traces.searchableShare * 100, 1, 100) / 100,
    },
    profiles: {
      profiledHostShare: readNumber(params, "ph", base.profiles.profiledHostShare * 100, 1, 100) / 100,
      samplesPerSecondPerHost: readNumber(
        params,
        "ps",
        base.profiles.samplesPerSecondPerHost,
        LIMITS.samplesPerSecondPerHost.min,
        LIMITS.samplesPerSecondPerHost.max,
      ),
      bytesPerSample: readNumber(
        params,
        "pb",
        base.profiles.bytesPerSample,
        LIMITS.bytesPerSample.min,
        LIMITS.bytesPerSample.max,
      ),
    },
    infra: {
      hosts: Math.round(readNumber(params, "h", base.infra.hosts, LIMITS.hosts.min, LIMITS.hosts.max)),
      containersPerHost: readNumber(
        params,
        "c",
        base.infra.containersPerHost,
        LIMITS.containersPerHost.min,
        LIMITS.containersPerHost.max,
      ),
      tracedHostShare: readNumber(params, "th", base.infra.tracedHostShare * 100, 0, 100) / 100,
      memoryGibPerHost: readNumber(
        params,
        "mem",
        base.infra.memoryGibPerHost,
        LIMITS.memoryGibPerHost.min,
        LIMITS.memoryGibPerHost.max,
      ),
    },
    users: Math.round(readNumber(params, "u", base.users, LIMITS.users.min, LIMITS.users.max)),
  };

  const term = params.get("term");
  const query = params.get("q");
  const region = params.get("rg");
  const s: Settings = {
    term: term === "a" || term === "m" ? TERM[term] : DEFAULT_SETTINGS.term,
    region: region === "us" || region === "eu" ? region : DEFAULT_SETTINGS.region,
    queryLoad: query === "l" || query === "t" || query === "h" ? QUERY[query] : DEFAULT_SETTINGS.queryLoad,
  };

  const logs = readVendorId(params, "rl");
  const metrics = readVendorId(params, "rm");
  const traces = readVendorId(params, "rt");
  const profiles = readVendorId(params, "rp");
  const route: Route | null =
    logs || metrics || traces || profiles ? { logs, metrics, traces, profiles } : null;

  const rawBill = Number(params.get("b"));
  const bill = params.get("b") && Number.isFinite(rawBill) && rawBill > 0 ? Math.min(rawBill, 1e9) : null;

  const sort = params.get("o");
  const view: View = {
    period: params.get("p") === "y" ? "year" : "month",
    sort: sort === "h" ? "high" : sort === "n" ? "name" : "low",
    open: readVendorIds(params, "v", 30),
  };

  // "c" is containers per host; the picks need a key of their own.
  const picked = readVendorIds(params, "cmp", 3);
  const compare = picked.length > 0 ? picked : null;

  return { w, s, route, bill, compare, view };
}

/**
 * Trim float noise so links stay short (0.30000000000000004 becomes 0.3)
 * without touching a typed value: 12,345,678 series stays 12,345,678.
 */
const short = (n: number) => String(Math.round(n * 1e4) / 1e4);

export function encodeState({
  w,
  s,
  route,
  bill,
  compare,
  view,
}: CalculatorState): URLSearchParams {
  const base = defaultWorkload();
  const params = new URLSearchParams();
  const put = (key: string, value: number, fallback: number) => {
    if (Math.abs(value - fallback) > 1e-9) params.set(key, short(value));
  };

  if (!w.send.logs) params.set("lo", "0");
  if (!w.send.metrics) params.set("mo", "0");
  if (!w.send.traces) params.set("to", "0");
  if (w.send.profiles) params.set("po", "1");

  put("lg", w.logs.gbPerDay, base.logs.gbPerDay);
  put("lb", w.logs.avgRecordBytes, base.logs.avgRecordBytes);
  put("lr", w.logs.retentionDays, base.logs.retentionDays);
  put("ls", Math.round(w.logs.searchableShare * 100), base.logs.searchableShare * 100);

  put("ms", w.metrics.activeSeries, base.metrics.activeSeries);
  put("mi", w.metrics.intervalSeconds, base.metrics.intervalSeconds);
  put("mb", w.metrics.bytesPerDataPoint, base.metrics.bytesPerDataPoint);
  put("mr", w.metrics.retentionMonths, base.metrics.retentionMonths);
  put("mh", Math.round(w.metrics.hostSeriesShare * 100), base.metrics.hostSeriesShare * 100);

  put("ts", w.traces.spansPerSecond, base.traces.spansPerSecond);
  put("tb", w.traces.avgSpanBytes, base.traces.avgSpanBytes);
  put("tr", w.traces.retentionDays, base.traces.retentionDays);
  put("tsh", Math.round(w.traces.searchableShare * 100), base.traces.searchableShare * 100);

  put("ph", Math.round(w.profiles.profiledHostShare * 100), base.profiles.profiledHostShare * 100);
  put("ps", w.profiles.samplesPerSecondPerHost, base.profiles.samplesPerSecondPerHost);
  put("pb", w.profiles.bytesPerSample, base.profiles.bytesPerSample);

  put("h", w.infra.hosts, base.infra.hosts);
  put("c", w.infra.containersPerHost, base.infra.containersPerHost);
  put("th", Math.round(w.infra.tracedHostShare * 100), base.infra.tracedHostShare * 100);
  put("mem", w.infra.memoryGibPerHost, base.infra.memoryGibPerHost);
  put("u", w.users, base.users);

  if (s.term !== DEFAULT_SETTINGS.term) params.set("term", s.term === "annual" ? "a" : "m");
  if (s.region !== DEFAULT_SETTINGS.region) params.set("rg", s.region);
  if (s.queryLoad !== DEFAULT_SETTINGS.queryLoad) params.set("q", s.queryLoad[0]);

  if (route) {
    if (route.logs) params.set("rl", route.logs);
    if (route.metrics) params.set("rm", route.metrics);
    if (route.traces) params.set("rt", route.traces);
    if (route.profiles) params.set("rp", route.profiles);
  }

  if (bill && bill > 0) params.set("b", short(bill));

  if (compare && compare.length > 0) params.set("cmp", compare.join(","));

  if (view) {
    if (view.period === "year") params.set("p", "y");
    if (view.sort !== "low") params.set("o", view.sort === "high" ? "h" : "n");
    if (view.open.length > 0) params.set("v", view.open.join(","));
  }

  return params;
}

/** Whether two workloads are the same for the purpose of matching a preset. */
export function sameWorkload(a: Workload, b: Workload): boolean {
  return encodeState({ w: a, s: DEFAULT_SETTINGS, route: null }).toString() ===
    encodeState({ w: b, s: DEFAULT_SETTINGS, route: null }).toString();
}
