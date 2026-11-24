/**
 * Dash0.
 *
 * Billed by count, pay as you go. Each signal has two fees per million: an
 * ingestion fee on everything sent and a storage fee on what is kept. There
 * is no plan, base fee, seat fee or minimum. Storage is discounted past 15
 * billion units a month per signal at rates Dash0 does not publish; like
 * Dash0's worked example, this spec applies the list rate to all of it, so
 * the estimate is an upper bound above that volume. Rates read from
 * dash0.com/pricing on the checkedOn date.
 *
 * A spec with `extra`: the four meters are data, and the two sentences that
 * depend on the workload (the discount point, the profiling sample rate) are
 * written in code.
 */
import { compact, num } from "../format";
import { defineVendor } from "../spec";

/** Retention that comes with the storage rate. The pricing page lists no other option. */
const LOG_RETENTION_DAYS = 30;
const TRACE_RETENTION_DAYS = 30;
const METRIC_RETENTION_MONTHS = 13;
const PROFILE_RETENTION_DAYS = 30;

/**
 * Units kept a month, per signal type, past which the pricing page says
 * storage is discounted at unpublished rates. Dash0's 15-second example
 * (21,600M data points at $0.20 = $4,320) bills past it at the list rate,
 * and so does this spec.
 */
const STORAGE_DISCOUNT_FROM = 15e9;

/** Ingestion is discounted from here, and only on self-hosted SignalControl Edge. */
const EDGE_INGESTION_DISCOUNT_FROM = 200e9;

const INGESTION_NOTE = "Charged on everything sent, before any filtering by SignalControl";

const storageNote = (retention: string) =>
  `${retention} retention. Charged on what is kept. Discounted past ${compact(STORAGE_DISCOUNT_FROM)} a month at unpublished rates; applied here to all volume, as in Dash0's example`;

const ingestion = (label: string, usd: number, unit: string) => ({
  label: `${label}, ingestion`,
  usd,
  unit,
  sourceId: "pricing",
  basis: "list" as const,
  note: INGESTION_NOTE,
});

const storage = (label: string, usd: number, unit: string, retention: string) => ({
  label: `${label}, storage`,
  usd,
  unit,
  sourceId: "pricing",
  basis: "list" as const,
  note: storageNote(retention),
});

export const dash0 = defineVendor({
  id: "dash0",
  name: "Dash0",
  group: "otel-native",
  plan: "Pay as you go",
  pricingUrl: "https://www.dash0.com/pricing",
  checkedOn: "2026-11-12",
  sources: {
    pricing: "https://www.dash0.com/pricing",
    billing: {
      label: "Docs: billing and cost control",
      url: "https://www.dash0.com/docs/dash0/cost-control/overview",
    },
    signalcontrol: {
      label: "Docs: SignalControl",
      url: "https://www.dash0.com/docs/dash0/telemetry/signal-control/about-signal-control",
    },
    example: {
      label: "Dash0's worked cost example",
      url: "https://www.dash0.com/comparisons/datadog-pricing",
    },
    "no-base-fee": {
      label: "Changelog: base fee removed",
      url: "https://www.dash0.com/changelog/no-more-base-subscription-fee",
    },
    profiling: {
      label: "Docs: collecting and sending profiles",
      url: "https://www.dash0.com/docs/dash0/telemetry/profiling/collect-and-send-profiles",
    },
    budget: {
      label: "Docs: monthly budget",
      url: "https://www.dash0.com/docs/dash0/cost-control/monthly-budget",
    },
  },
  rates: {
    "logs-ingestion": ingestion("Log records", 0.06, "million log records"),
    "logs-storage": storage("Log records", 0.54, "million log records", `${LOG_RETENTION_DAYS}-day`),
    "traces-ingestion": ingestion("Spans and span events", 0.06, "million spans and span events"),
    "traces-storage": storage(
      "Spans and span events",
      0.54,
      "million spans and span events",
      `${TRACE_RETENTION_DAYS}-day`,
    ),
    "metrics-ingestion": ingestion("Metric data points", 0.02, "million metric data points"),
    "metrics-storage": storage(
      "Metric data points",
      0.18,
      "million metric data points",
      `${METRIC_RETENTION_MONTHS}-month`,
    ),
    "profiles-ingestion": ingestion("Profiling samples", 0.06, "million profiling samples"),
    "profiles-storage": storage(
      "Profiling samples",
      0.54,
      "million profiling samples",
      `${PROFILE_RETENTION_DAYS}-day`,
    ),
  },
  // Everything sent pays ingestion. What is kept pays storage.
  logs: {
    unit: "million-records",
    rate: "logs-ingestion",
    storage: {
      rate: "logs-storage",
      on: "searchable",
      note: "It is priced as filtered out by SignalControl after ingestion and cannot be recovered.",
    },
    retention: { included: LOG_RETENTION_DAYS },
  },
  traces: {
    unit: "million-spans",
    rate: "traces-ingestion",
    storage: {
      rate: "traces-storage",
      on: "searchable",
      note: "It is priced as sampled out by SignalControl after ingestion and cannot be recovered.",
    },
    retention: { included: TRACE_RETENTION_DAYS },
  },
  metrics: {
    unit: "million-data-points",
    rate: "metrics-ingestion",
    storage: { rate: "metrics-storage", on: "all" },
    retention: { included: METRIC_RETENTION_MONTHS },
  },
  profiles: {
    unit: "million-samples",
    rate: "profiles-ingestion",
    storage: { rate: "profiles-storage", on: "all" },
    retention: { included: PROFILE_RETENTION_DAYS },
  },

  // The two sentences that depend on the workload.
  extra({ w, d, active }) {
    const assumptions: string[] = [];
    if (active.has("profiles")) {
      assumptions.push(
        `Profiles: Dash0 bills profiling per sample, at the same two fees as spans, and keeps samples ${PROFILE_RETENTION_DAYS} days. Its pricing page does not define a sample; here it is one stack sample, at ${num(w.profiles.samplesPerSecondPerHost)} a second per profiled host.`,
      );
    }
    const pastDiscount = [
      { name: "log records", kept: d.logs.searchableRecordsPerMonth },
      { name: "spans", kept: d.traces.searchableSpansPerMonth },
      { name: "metric data points", kept: d.metrics.dataPointsPerMonth },
      { name: "profiling samples", kept: d.profiles.samplesPerMonth },
    ].filter((s) => s.kept > STORAGE_DISCOUNT_FROM);
    if (pastDiscount.length > 0) {
      assumptions.push(
        `Storage past ${compact(STORAGE_DISCOUNT_FROM)} a month (here: ${pastDiscount
          .map((s) => `${compact(s.kept - STORAGE_DISCOUNT_FROM)} ${s.name}`)
          .join(", ")}) is priced at the list rate. Dash0 discounts that volume at rates it does not publish, so this part of the estimate is an upper bound. Dash0's 15-second example prices it the same way.`,
      );
    }
    return { assumptions };
  },

  assumptions: [
    {
      when: "metrics",
      text: "Metrics: Dash0 has no host fee and no custom-metric class. Host, container and application series all bill per data point at the same rate.",
    },
    "Telemetry goes over OTLP to Dash0, which bills by count. Log records are counted from the daily volume and the average record size, spans from the span rate, and metric data points as one per series per export interval.",
  ],
  included: [
    `${LOG_RETENTION_DAYS} days of retention for log records and spans, ${METRIC_RETENTION_MONTHS} months for metric data points`,
    { when: "profiles", text: `${PROFILE_RETENTION_DAYS} days of retention for profiling samples` },
    "Queries, dashboards and alerting. The rate card has no meter for them",
    "Any number of users and hosts. There is no seat, host or base fee",
  ],
  notIncluded: [
    "Span events, which Dash0 counts and bills like spans",
    "Web events, synthetic checks, session replays and Agent0 AI credits, each billed on a separate meter",
    `Storage discounts past ${compact(STORAGE_DISCOUNT_FROM)} units a month per signal, whose rates are not published`,
  ],
  notes: [
    "Ingestion ({rate:logs-ingestion} per million log records or spans, {rate:metrics-ingestion} per million data points) is charged on everything sent, including data that SignalControl filters or samples out. Storage is charged only on what is kept.",
    `Storage rates drop each time monthly volume doubles past ${compact(STORAGE_DISCOUNT_FROM)}, with each tier's rate applied to the volume inside it. Dash0 does not publish those rates.`,
    `Ingestion is discounted only on self-hosted SignalControl Edge past ${compact(EDGE_INGESTION_DISCOUNT_FROM)} signals a month per signal type. That is not modeled.`,
    "Metrics bill per data point, so halving the export interval doubles the metrics bill.",
    "Dash0 publishes one pay-as-you-go rate card with no annual or regional prices, so the billing term and region do not change the estimate.",
    "There is no monthly minimum or free allowance. An optional monthly budget pauses ingestion after a 4-day grace period once it is reached.",
  ],

  examples: [
    {
      // dash0.com/comparisons/datadog-pricing, "Illustrative cost under Dash0's
      // pricing model". The page's total of $4,729.56 adds web events ($15.00)
      // and synthetic checks ($34.56), which are not modeled here.
      name: "the vendor's worked example: 3,000M spans x $0.60 + 3,000M logs x $0.60 + 5,400M data points x $0.20 = $4,680",
      preset: "mid",
      workload: {
        logs: { gbPerDay: 100, avgRecordBytes: 1000, retentionDays: 30, searchableShare: 1 },
        traces: { spansPerSecond: 3e9 / 2_592_000, retentionDays: 30, searchableShare: 1 },
        metrics: { activeSeries: 125_000, intervalSeconds: 60, retentionMonths: 13 },
      },
      expect: { traces: 1800, logs: 1800, metrics: 1080, platform: 0, total: 4680 },
    },
    {
      // Same page: "3,000M x $0.06 + 300M x $0.54 = $342 instead of $1,800".
      name: "the vendor's sampling example: keeping 10% of 3,000M spans is $180 of ingestion + $162 of storage = $342",
      preset: "mid",
      signals: ["traces"],
      workload: { traces: { spansPerSecond: 3e9 / 2_592_000, retentionDays: 30, searchableShare: 0.1 } },
      expect: { traces: 342, total: 342 },
      lines: 2,
    },
    {
      // dash0.com/changelog/no-more-base-subscription-fee: 1 million logs, 2 million
      // spans and 4 million data points is "1x $0.60 + 2x $0.60 + 4x $0.20 = $2.60".
      name: "the vendor's small bill, with no minimum: 1M logs x $0.60 + 2M spans x $0.60 + 4M data points x $0.20 = $2.60",
      preset: "mid",
      workload: {
        logs: { gbPerDay: 1 / 30, avgRecordBytes: 1000, retentionDays: 30, searchableShare: 1 },
        traces: { spansPerSecond: 2e6 / 2_592_000, retentionDays: 30, searchableShare: 1 },
        metrics: { activeSeries: 4e6 / 43_200, intervalSeconds: 60, retentionMonths: 13 },
      },
      expect: { logs: 0.6, traces: 1.2, metrics: 0.8, platform: 0, total: 2.6 },
    },
    {
      // Same page as the worked example: "At a 15-second scrape interval, metric
      // data points cost $4,320". The example bills past 15B at the list rate.
      name: "the vendor's 15-second example: 125,000 series x 172,800 points = 21,600M x $0.20 = $4,320",
      preset: "mid",
      signals: ["metrics"],
      workload: { metrics: { activeSeries: 125_000, intervalSeconds: 15, retentionMonths: 13 } },
      expect: 4320,
    },
    {
      name: "the mid preset: 9,900M logs x $0.60 + 5,184M spans x $0.60 + 10,800M data points x $0.20 = $11,210.40",
      preset: "mid",
      expect: { logs: 5940, traces: 3110.4, metrics: 2160, platform: 0, total: 11_210.4 },
      lines: 6,
    },
  ],
});
