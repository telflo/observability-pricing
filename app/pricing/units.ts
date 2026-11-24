/**
 * Unit conventions and the one place a workload is turned into quantities.
 *
 * Adapters never re-derive a count from bytes (or the reverse) with their
 * size assumption: they read both from `derive()`, which uses the sizes the
 * visitor can see and edit. That is where public comparisons usually diverge.
 */
import type { Derived, Settings, Signal, Workload } from "./types";

export const DAYS_PER_MONTH = 30;
export const HOURS_PER_MONTH = 720;
export const MINUTES_PER_MONTH = 43_200;
export const SECONDS_PER_MONTH = 2_592_000;

export const BYTES_PER_GB = 1e9;
export const BYTES_PER_GIB = 2 ** 30;

/** Decimal GB (10^9 bytes) to binary GiB (2^30 bytes). */
export function gbToGib(gb: number): number {
  return (gb * BYTES_PER_GB) / BYTES_PER_GIB;
}

/**
 * GB scanned by queries each month, per GB ingested that month. The query
 * load belongs to the visitor, so every vendor that bills scanned volume is
 * asked to scan the same amount: adapters use these multiples as they are.
 * The anchors are vendors' allowances: AWS includes 5x in its unified
 * pricing, Bronto's plans include 20x and 100x. Only a vendor whose query
 * meter is not scanned volume (compute time, for example) maps the three
 * levels onto its published usage profiles, and says so.
 */
export const SCAN_MULTIPLE: Record<Settings["queryLoad"], number> = {
  light: 5,
  typical: 20,
  heavy: 100,
};

/** Signals that are both switched on and non-zero. */
export function activeSignals(w: Workload): Signal[] {
  const out: Signal[] = [];
  if (w.send.logs && w.logs.gbPerDay > 0) out.push("logs");
  if (w.send.metrics && w.metrics.activeSeries > 0) out.push("metrics");
  if (w.send.traces && w.traces.spansPerSecond > 0) out.push("traces");
  // Profiles come from hosts: a profiler on no host sends nothing.
  if (
    w.send.profiles &&
    w.infra.hosts > 0 &&
    w.profiles.profiledHostShare > 0 &&
    w.profiles.samplesPerSecondPerHost > 0
  ) {
    out.push("profiles");
  }
  return out;
}

const clampShare = (x: number) => Math.min(1, Math.max(0, x));

export function derive(w: Workload): Derived {
  // "On" means switched on and non-zero, the same test the engine uses, so a
  // per-host fee can never follow a signal that carries no data.
  const active = activeSignals(w);
  const logsOn = active.includes("logs");
  const metricsOn = active.includes("metrics");
  const tracesOn = active.includes("traces");
  const profilesOn = active.includes("profiles");

  const logGbPerDay = logsOn ? Math.max(0, w.logs.gbPerDay) : 0;
  const logGbPerMonth = logGbPerDay * DAYS_PER_MONTH;
  const recordsPerMonth =
    (logGbPerMonth * BYTES_PER_GB) / Math.max(1, w.logs.avgRecordBytes);
  const logShare = clampShare(w.logs.searchableShare);

  const series = metricsOn ? Math.max(0, w.metrics.activeSeries) : 0;
  const hostSeries = series * clampShare(w.metrics.hostSeriesShare);
  const dataPointsPerMinute = (series * 60) / Math.max(1, w.metrics.intervalSeconds);
  const dataPointsPerMonth = dataPointsPerMinute * MINUTES_PER_MONTH;

  const spansPerSecond = tracesOn ? Math.max(0, w.traces.spansPerSecond) : 0;
  const spansPerMonth = spansPerSecond * SECONDS_PER_MONTH;
  const traceGbPerMonth = (spansPerMonth * w.traces.avgSpanBytes) / BYTES_PER_GB;
  const traceShare = clampShare(w.traces.searchableShare);

  const hosts = Math.max(0, w.infra.hosts);
  // Same float guard as tracedHosts below.
  const profiledHosts = profilesOn
    ? Math.ceil(hosts * clampShare(w.profiles.profiledHostShare) - 1e-9)
    : 0;
  const samplesPerMonth =
    profiledHosts * Math.max(0, w.profiles.samplesPerSecondPerHost) * SECONDS_PER_MONTH;

  return {
    logs: {
      gbPerMonth: logGbPerMonth,
      recordsPerMonth,
      searchableGbPerMonth: logGbPerMonth * logShare,
      searchableRecordsPerMonth: recordsPerMonth * logShare,
      storedGb: logGbPerDay * w.logs.retentionDays,
      retentionDays: w.logs.retentionDays,
    },
    metrics: {
      activeSeries: series,
      hostSeries,
      customSeries: series - hostSeries,
      dataPointsPerMinute,
      dataPointsPerMonth,
      gbPerMonth: (dataPointsPerMonth * w.metrics.bytesPerDataPoint) / BYTES_PER_GB,
      retentionMonths: w.metrics.retentionMonths,
    },
    traces: {
      spansPerMonth,
      gbPerMonth: traceGbPerMonth,
      searchableSpansPerMonth: spansPerMonth * traceShare,
      searchableGbPerMonth: traceGbPerMonth * traceShare,
      storedGb: (traceGbPerMonth / DAYS_PER_MONTH) * w.traces.retentionDays,
      retentionDays: w.traces.retentionDays,
    },
    profiles: {
      profiledHosts,
      profiledHostHours: profiledHosts * HOURS_PER_MONTH,
      samplesPerMonth,
      gbPerMonth: (samplesPerMonth * Math.max(0, w.profiles.bytesPerSample)) / BYTES_PER_GB,
    },
    infra: {
      hosts,
      monitoredHosts: metricsOn ? hosts : 0,
      // 50 hosts x 14% is 7.000000000000001 in floating point: that is 7 hosts.
      tracedHosts: tracesOn ? Math.ceil(hosts * clampShare(w.infra.tracedHostShare) - 1e-9) : 0,
      containers: hosts * Math.max(0, w.infra.containersPerHost),
      memoryGib: hosts * Math.max(0, w.infra.memoryGibPerHost),
    },
    users: Math.max(0, w.users),
  };
}
