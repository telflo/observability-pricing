/**
 * ClickHouse Observability, the fully managed service, Scale plan.
 *
 * Two meters: uncompressed GB of logs and traces, and metric data points. One
 * rate each, 30 days of retention included, no minimum, no tiers, no seats.
 *
 * The service is in public beta at half price. This spec prices the list
 * rate, which ClickHouse says applies at general availability. The beta rates
 * sit in the table marked promotional so the notes can quote them. No line
 * uses them. Rates read from clickhouse.com/pricing/observability on the
 * checkedOn date.
 */
import { defineVendor } from "../spec";

/**
 * The only retention the fully managed service has today, on every signal and
 * both plans. Longer retention is planned for general availability and has no
 * published price, so there is no ladder to pick from yet.
 */
const RETENTION_DAYS = 30;

// Rate notes carry no closing period: the page adds one before the source.
const LIST_NOTE = `Scale plan. List price, which applies at general availability. Includes ${RETENTION_DAYS} days of retention`;
const BETA_NOTE =
  "Scale plan. Discounted price during the public beta, shown beside the list price. Not part of the estimate";

export const clickhouse = defineVendor({
  id: "clickhouse",
  name: "ClickHouse Observability",
  group: "open-source",
  plan: "Scale plan, fully managed, list price without the beta discount",
  pricingUrl: "https://clickhouse.com/pricing/observability",
  checkedOn: "2026-11-12",
  sources: {
    pricing: { label: "Observability pricing page", url: "https://clickhouse.com/pricing/observability" },
    product: { label: "Product page: pricing summary and FAQ", url: "https://clickhouse.com/observability" },
    announcement: {
      label: "Blog: launch announcement",
      url: "https://clickhouse.com/blog/announcing-clickhouse-observability",
    },
  },
  rates: {
    "logs-traces-gb": {
      label: "Logs, traces and session replay",
      usd: 0.2,
      unit: "uncompressed GB ingested",
      sourceId: "pricing",
      basis: "list",
      note: LIST_NOTE,
    },
    "metrics-1m": {
      label: "Metrics",
      usd: 0.1,
      unit: "million data points",
      sourceId: "pricing",
      basis: "list",
      note: LIST_NOTE,
    },
    "logs-traces-gb-beta": {
      label: "Logs, traces and session replay, public beta price",
      usd: 0.1,
      unit: "uncompressed GB ingested",
      sourceId: "pricing",
      basis: "promotional",
      note: BETA_NOTE,
    },
    "metrics-1m-beta": {
      label: "Metrics, public beta price",
      usd: 0.05,
      unit: "million data points",
      sourceId: "pricing",
      basis: "promotional",
      note: BETA_NOTE,
    },
  },
  logs: { unit: "gb", rate: "logs-traces-gb", retention: { included: RETENTION_DAYS } },
  traces: { unit: "gb", rate: "logs-traces-gb", retention: { included: RETENTION_DAYS } },
  // 30 days, in the months metric retention is set in.
  metrics: { unit: "million-data-points", rate: "metrics-1m", retention: { included: 1 } },
  profiles: { coverage: "unsupported" },
  assumptions: [
    {
      when: ["logs", "traces"],
      text: "A GB is counted as 10^9 uncompressed bytes as sent over OTLP. ClickHouse bills uncompressed GB ingested, which it describes as the volume you see in your collectors. The pricing page does not say whether that GB is decimal or binary.",
    },
    {
      when: "metrics",
      text: "Each active series counts as one data point per export interval. ClickHouse defines a data point as one metric value at one timestamp. The pricing page does not say how an OTLP histogram is counted.",
    },
  ],
  included: [
    `${RETENTION_DAYS} days of retention for logs, traces and metrics`,
    "Storage, replicas and standard search compute, with no separate charge",
    "Users and hosts, with no per-seat or per-host fee on the price list",
    "The managed OTLP endpoint",
    "Dashboards, alerts, full-text and SQL search",
  ],
  notIncluded: [
    "Session replay, which bills at the same per-GB rate as logs and traces",
    "Enterprise plan features (SAML single sign-on, private regions, enterprise support), sold at higher rates than Scale",
    "Search compute past the included allowance, which the pricing page calls reasonable without giving its size or a price beyond it",
  ],
  notes: [
    // The 50% is the beta discount on both meters; clickhouse.test.ts checks the ratio.
    "This estimate uses the list price, which ClickHouse says applies at general availability. During the public beta the service bills 50% less: {rate:logs-traces-gb-beta} per GB and {rate:metrics-1m-beta} per million data points.",
    "The service is in public beta, and ClickHouse says pricing terms may change before general availability.",
    `Retention is ${RETENTION_DAYS} days on every signal. ClickHouse says longer retention is planned for general availability and has published no price for it.`,
    {
      when: "metrics",
      text: "Metrics bill per data point, with no separate charge per series. More series and a shorter export interval both mean more data points: halving the interval doubles the metrics bill.",
    },
    "ClickHouse publishes one pay-as-you-go rate per meter, with no annual rate, no regional prices and no public volume tiers, so the billing term and the region do not change this estimate. Committed-use pricing for very large volumes is by quote.",
    "There is no monthly minimum, so a small workload pays only for what it sends.",
    "ClickHouse also sells a self-managed option billed on the compute and storage you provision. It is not modeled here.",
  ],
  examples: [
    {
      // The pricing page's estimator gives $325 at the beta rates for these
      // volumes; the same volumes at the list rates on the same page:
      name: "the vendor's example at list: 2,000 GB x $0.20 + 1,000 GB x $0.20 + 500M points x $0.10 = $650",
      preset: "mid",
      workload: {
        logs: { gbPerDay: 2000 / 30, retentionDays: 30 },
        traces: { spansPerSecond: 1e9 / 2_592_000, avgSpanBytes: 1000, retentionDays: 30 },
        metrics: { activeSeries: 500e6 / 43_200, intervalSeconds: 60, retentionMonths: 1 },
      },
      expect: { logs: 400, traces: 200, metrics: 50, platform: 0, total: 650 },
      lines: 3,
    },
    {
      // clickhouse.com/observability, "What $1,000 a month buys for logs".
      name: "the vendor's list-price example: 5 TB of logs is 5,000 GB x $0.20 = $1,000",
      preset: "mid",
      signals: ["logs"],
      workload: { logs: { gbPerDay: 5000 / 30, retentionDays: 30 } },
      expect: 1000,
    },
    {
      name: "100 GB of logs a day at 30 days: 3,000 GB x $0.20 = $600, no minimum",
      preset: "mid",
      signals: ["logs"],
      workload: { logs: { gbPerDay: 100, retentionDays: 30 } },
      expect: { logs: 600, platform: 0, total: 600 },
      lines: 1,
    },
    {
      name: "traces alone: 1,000 spans/s x 2,592,000 s x 1,000 bytes = 2,592 GB x $0.20 = $518.40",
      preset: "mid",
      signals: ["traces"],
      workload: { traces: { spansPerSecond: 1000, avgSpanBytes: 1000, retentionDays: 30 } },
      expect: 518.4,
    },
    {
      // The pricing page: one series every 10 s is about 260K data points a month.
      name: "metrics alone: 1,000 series at 10 s = 259.2M data points x $0.10 = $25.92",
      preset: "mid",
      signals: ["metrics"],
      workload: { metrics: { activeSeries: 1000, intervalSeconds: 10, retentionMonths: 1 } },
      expect: 25.92,
    },
    {
      name: "the mid preset: 9,900 GB x $0.20 + 5,184 GB x $0.20 + 10,800M points x $0.10 = $4,096.80",
      preset: "mid",
      expect: { logs: 1980, traces: 1036.8, metrics: 1080, platform: 0, total: 4096.8 },
      lines: 3,
    },
    {
      name: "1 GB of logs a day: 30 GB x $0.20 = $6, with no top-up",
      preset: "mid",
      signals: ["logs"],
      workload: { logs: { gbPerDay: 1, retentionDays: 30 } },
      expect: 6,
      lines: 1,
    },
  ],
});
