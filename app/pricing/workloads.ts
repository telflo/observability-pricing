/**
 * The default workload and the named reference workloads.
 *
 * The reference workloads are conventions, not measurements: round numbers
 * chosen so two people can price the same thing and compare. The per-host
 * ratios behind them (logs, spans and series per host) follow the baskets
 * public vendor comparisons already use.
 */
import type { Settings, Workload } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  term: "annual",
  region: "us",
  queryLoad: "typical",
};

/** Sizes and shares shared by every preset; each is editable on the page. */
const BASE = {
  avgRecordBytes: 1000,
  avgSpanBytes: 1000,
  bytesPerDataPoint: 150,
  logRetentionDays: 30,
  traceRetentionDays: 30,
  metricRetentionMonths: 13,
  // Profiling conventions, not measurements; each is editable on the page.
  // About two busy CPUs per host at the OpenTelemetry eBPF profiler's
  // 20 samples a second per CPU, and a sample as sent (stack, labels and
  // value, after the profile's own deduplication) of about 100 bytes.
  profiledHostShare: 0.5,
  samplesPerSecondPerHost: 40,
  bytesPerSample: 100,
};

interface PresetShape {
  hosts: number;
  /** null: the preset does not send this signal. */
  logGbPerDay: number | null;
  spansPerSecond: number | null;
  activeSeries: number;
  intervalSeconds?: number;
  /** Share of series that are standard host, container and Kubernetes metrics. */
  hostSeriesShare: number;
  users: number;
  containersPerHost?: number;
  tracedHostShare?: number;
  memoryGibPerHost?: number;
}

function build(p: PresetShape): Workload {
  return {
    // A signal the preset leaves out is switched off, with a volume ready
    // for when the visitor switches it on.
    send: {
      logs: p.logGbPerDay !== null,
      metrics: true,
      traces: p.spansPerSecond !== null,
      profiles: false,
    },
    logs: {
      gbPerDay: p.logGbPerDay ?? Number((p.hosts * 1.6).toPrecision(2)),
      avgRecordBytes: BASE.avgRecordBytes,
      retentionDays: BASE.logRetentionDays,
      searchableShare: 1,
    },
    metrics: {
      activeSeries: p.activeSeries,
      intervalSeconds: p.intervalSeconds ?? 60,
      bytesPerDataPoint: BASE.bytesPerDataPoint,
      retentionMonths: BASE.metricRetentionMonths,
      hostSeriesShare: p.hostSeriesShare,
    },
    traces: {
      spansPerSecond: p.spansPerSecond ?? p.hosts * 10,
      avgSpanBytes: BASE.avgSpanBytes,
      retentionDays: BASE.traceRetentionDays,
      searchableShare: 1,
    },
    profiles: {
      profiledHostShare: BASE.profiledHostShare,
      samplesPerSecondPerHost: BASE.samplesPerSecondPerHost,
      bytesPerSample: BASE.bytesPerSample,
    },
    infra: {
      hosts: p.hosts,
      containersPerHost: p.containersPerHost ?? 10,
      tracedHostShare: p.tracedHostShare ?? 0.5,
      memoryGibPerHost: p.memoryGibPerHost ?? 16,
    },
    users: p.users,
  };
}

export interface Preset {
  id: string;
  name: string;
  /** One line under the name: the numbers that set this workload apart. */
  summary: string;
  workload: Workload;
}

export const PRESETS: Preset[] = [
  {
    id: "small",
    name: "Small team",
    summary: "50 hosts, 80 GB of logs a day",
    workload: build({
      hosts: 50,
      logGbPerDay: 80,
      spansPerSecond: 400,
      activeSeries: 75_000,
      hostSeriesShare: 0.2,
      users: 5,
      tracedHostShare: 0.4,
    }),
  },
  {
    id: "mid",
    name: "Mid-size platform",
    summary: "200 hosts, 330 GB of logs a day",
    workload: build({
      hosts: 200,
      logGbPerDay: 330,
      spansPerSecond: 2_000,
      activeSeries: 250_000,
      hostSeriesShare: 0.25,
      users: 15,
      tracedHostShare: 0.6,
    }),
  },
  {
    id: "large",
    name: "Large fleet",
    summary: "1,000 hosts, 2 TB of logs a day",
    workload: build({
      hosts: 1_000,
      logGbPerDay: 2_000,
      spansPerSecond: 15_000,
      activeSeries: 2_000_000,
      hostSeriesShare: 0.15,
      users: 50,
      tracedHostShare: 0.6,
    }),
  },
  {
    id: "kubernetes",
    name: "Kubernetes-native",
    summary: "50 nodes, 1,500 containers, metrics every 30 s",
    workload: build({
      hosts: 50,
      logGbPerDay: 100,
      spansPerSecond: 600,
      activeSeries: 250_000,
      intervalSeconds: 30,
      hostSeriesShare: 0.9,
      users: 10,
      containersPerHost: 30,
      tracedHostShare: 1,
      memoryGibPerHost: 32,
    }),
  },
  {
    id: "log-heavy",
    name: "Log-heavy",
    summary: "1 TB of logs a day, 100 hosts, no traces",
    workload: build({
      hosts: 100,
      logGbPerDay: 1_000,
      spansPerSecond: null,
      activeSeries: 100_000,
      hostSeriesShare: 0.3,
      users: 5,
      tracedHostShare: 0,
    }),
  },
  {
    id: "metrics-heavy",
    name: "Metrics-heavy",
    summary: "1M series every 15 s, 1,000 hosts, no logs or traces",
    workload: build({
      hosts: 1_000,
      logGbPerDay: null,
      spansPerSecond: null,
      activeSeries: 1_000_000,
      intervalSeconds: 15,
      hostSeriesShare: 0.5,
      users: 10,
      tracedHostShare: 0,
    }),
  },
];

export const DEFAULT_PRESET_ID = "mid";

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export function defaultWorkload(): Workload {
  return structuredClone(presetById(DEFAULT_PRESET_ID)!.workload);
}
