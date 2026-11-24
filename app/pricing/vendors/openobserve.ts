/**
 * OpenObserve Cloud, Professional plan.
 *
 * One per-GB ingest rate for every signal (metrics are billed by GB, with no
 * series or data point meter), a per-GB charge for data scanned by queries, and a
 * per-GB charge for logs and traces held past the included 30 days. That last
 * price is published per 30-day period and metered by the GB-hour, so it is
 * charged pro rata by the day. No minimum, no seats, no host fees. Rates read
 * from openobserve.ai on the checkedOn date.
 */
import { defineVendor } from "../spec";

/** Retention the ingest price already covers (pricing page). */
const INCLUDED_LOG_TRACE_DAYS = 30;
const INCLUDED_METRIC_MONTHS = 15;

/**
 * Figures OpenObserve uses in its posts. They are quoted in the assumptions so
 * a reader can set them against the workload. No amount is computed from them.
 */
const VENDOR_EXAMPLE_INGESTED_GB = 1300; // "pricing-models" worked example
const VENDOR_EXAMPLE_QUERIED_GB = 5000; // same example
const VENDOR_POST_BYTES_PER_METRIC_POINT = 25; // "record-sizes" post

const ingest = {
  unit: "gb",
  rate: { annual: "ingest-annual", monthly: "ingest-payg" },
  scan: {
    rate: "query",
    note: `OpenObserve's worked example scans ${VENDOR_EXAMPLE_QUERIED_GB.toLocaleString("en-US")} GB against ${VENDOR_EXAMPLE_INGESTED_GB.toLocaleString("en-US")} GB ingested.`,
  },
} as const;

export const openobserve = defineVendor({
  id: "openobserve",
  name: "OpenObserve Cloud",
  group: "open-source",
  plan: {
    annual: "Cloud Professional, annual commitment",
    monthly: "Cloud Professional, pay as you go",
  },
  pricingUrl: "https://openobserve.ai/pricing/",
  checkedOn: "2026-11-12",
  sources: {
    pricing: { label: "Pricing page and its FAQ", url: "https://openobserve.ai/pricing/" },
    "pricing-models": {
      label: "Blog: pricing models, with the pay-as-you-go rate and a worked example",
      url: "https://openobserve.ai/blog/observability-pricing-models/",
    },
    "deployment-costs": {
      label: "Blog: deployment models, with a cost table for both terms",
      url: "https://openobserve.ai/blog/self-hosted-vs-saas-vs-byoc-observability/",
    },
    "retention-example": {
      label: "Blog: comparison post with a 90-day retention example",
      url: "https://openobserve.ai/blog/openobserve-vs-signoz/",
    },
    "usage-meters": {
      label: "Docs: Cloud usage meters",
      url: "https://openobserve.ai/docs/user-guide/account-administration/cloud-usage/",
    },
    "stream-details": {
      label: "Docs: stream details, on how ingested data is sized",
      url: "https://openobserve.ai/docs/user-guide/data-processing/streams/stream-details/",
    },
    "record-sizes": {
      label: "Blog: comparison post stating the record sizes it assumes",
      url: "https://openobserve.ai/blog/openobserve-vs-dash0/",
    },
  },
  rates: {
    "ingest-annual": {
      label: "Ingestion, annual commitment",
      usd: 0.5,
      unit: "GB ingested",
      sourceId: "pricing",
      basis: "list",
      note: "Logs, metrics and traces at one rate. The page says the price includes a 30% discount for an annual commitment",
    },
    "ingest-payg": {
      label: "Ingestion, pay as you go",
      usd: 0.7,
      unit: "GB ingested",
      sourceId: "pricing-models",
      basis: "list",
      note: "Stated in OpenObserve's blog posts. The pricing page prints only the annual rate",
    },
    query: {
      label: "Queries",
      usd: 0.01,
      unit: "GB queried",
      sourceId: "pricing",
      basis: "list",
      note: "Data scanned by searches, dashboards and alerts. One price for both terms",
    },
    "extra-retention": {
      label: "Retention past 30 days, logs and traces",
      usd: 0.02,
      unit: "GB per additional 30-day period",
      sourceId: "pricing",
      basis: "list",
      note: "Metered by the GB-hour. Metrics keep 15 months at no charge. One price for both terms",
    },
  },
  logs: {
    ...ingest,
    retention: { included: INCLUDED_LOG_TRACE_DAYS },
    retentionExtra: { rate: "extra-retention" },
  },
  traces: {
    ...ingest,
    retention: { included: INCLUDED_LOG_TRACE_DAYS },
    retentionExtra: { rate: "extra-retention" },
  },
  metrics: { ...ingest, retention: { included: INCLUDED_METRIC_MONTHS } },
  profiles: {
    coverage: "unpriced",
    note: "OpenObserve accepts OpenTelemetry profiles, but its pricing page lists no rate for them.",
  },
  assumptions: [
    "A GB, ingested or scanned, is counted as 10^9 uncompressed bytes as sent over OTLP. OpenObserve does not publish how its billed GB is measured against OTLP bytes. Its docs call a stream's ingested data the uncompressed size of the stored data.",
    {
      when: "metrics",
      text: `A comparison post by OpenObserve assumes about ${VENDOR_POST_BYTES_PER_METRIC_POINT} bytes per metric point.`,
    },
    {
      when: "extraRetention",
      text: `OpenObserve's usage docs meter stored data by the GB-hour, so part of a ${INCLUDED_LOG_TRACE_DAYS}-day period is charged pro rata. The pricing page lists additional retention among the Enterprise plan's features. Its FAQ gives the per-GB price as an extension of the pay-as-you-go plan. The estimate adds that price to Professional rates.`,
    },
  ],
  included: [
    `${INCLUDED_LOG_TRACE_DAYS} days of retention for logs and traces`,
    `${INCLUDED_METRIC_MONTHS} months of retention for metrics`,
    "Unlimited users, with no per-host fees",
    "Dashboards and alerts, with no limit on their number",
  ],
  notIncluded: [
    "Enterprise plan features such as pipelines, sensitive data redaction, audit trail and storage in your bucket, which are priced by quote",
    "RUM, session replay and error tracking data, which bill at the same per-GB rate when sent",
    "AI credits beyond the free pool and synthetic checks, which are metered but have no rate on the pricing page",
  ],
  notes: [
    "The pricing page prints the annual-commitment rate, {rate:ingest-annual} per GB. The pay-as-you-go rate, {rate:ingest-payg} per GB, is stated in OpenObserve's blog posts.",
    `Queries cost {rate:query} per GB scanned by searches, dashboards and alerts. Keeping logs or traces past ${INCLUDED_LOG_TRACE_DAYS} days costs {rate:extra-retention} per GB for each additional ${INCLUDED_LOG_TRACE_DAYS}-day period. Each has one published price, used for both terms.`,
    "The pricing page shows one flat rate at every volume. OpenObserve publishes no minimum size for an annual commitment. Volume discounts are on the Enterprise plan, by quote.",
    "The estimator on OpenObserve's pricing page counts ingestion only, at the annual rate. This estimate adds queries.",
    "There is no monthly minimum and no free tier. New accounts get a 14-day trial.",
    "One price is published for all four cloud regions, so the region setting does not change the estimate.",
  ],
  examples: [
    {
      // 16,704 GB x $0.50 = $8,352 of ingestion; x 20 = 334,080 GB scanned x $0.01 = $3,340.80.
      name: "the mid preset, annual, typical queries: $8,352 of ingestion + $3,340.80 of queries = $11,692.80",
      preset: "mid",
      expect: { logs: 6930, metrics: 1134, traces: 3628.8, platform: 0, total: 11_692.8 },
      lines: 6,
    },
    {
      // The $1,500 is the vendor's figure for 100 GB a day on an annual contract
      // (blog: self-hosted vs SaaS vs BYOC) and what the pricing page estimator shows.
      name: "100 GB of logs a day, annual: 3,000 GB x $0.50 + 60,000 GB scanned x $0.01 = $2,100",
      preset: "mid",
      signals: ["logs"],
      workload: { logs: { gbPerDay: 100, retentionDays: 30 } },
      expect: { logs: 2100, total: 2100 },
      lines: 2,
    },
    {
      name: "100 GB of logs a day, pay as you go: 3,000 GB x $0.70 + $600 of queries = $2,700",
      preset: "mid",
      signals: ["logs"],
      settings: { term: "monthly" },
      workload: { logs: { gbPerDay: 100, retentionDays: 30 } },
      expect: 2700,
    },
    {
      // Blog: 900 GB logs, 300 GB traces, 100 GB metrics. "1,300 x 0.50 = $650";
      // light queries scan 5 GB per GB: 6,500 GB x $0.01 = $65.
      name: "the vendor's worked example, annual, light queries: 1,300 GB x $0.50 + $65 of queries = $715",
      preset: "mid",
      settings: { queryLoad: "light" },
      workload: {
        logs: { gbPerDay: 30, retentionDays: 30 },
        traces: { spansPerSecond: 300e9 / 2_592_000 / 1000, avgSpanBytes: 1000, retentionDays: 30 },
        metrics: { activeSeries: 100e9 / (43_200 * 150), intervalSeconds: 60, bytesPerDataPoint: 150 },
      },
      expect: { logs: 495, traces: 165, metrics: 55, platform: 0, total: 715 },
    },
    {
      name: "the same month pay as you go: 1,300 GB x $0.70 + $65 = $975",
      preset: "mid",
      settings: { queryLoad: "light", term: "monthly" },
      workload: {
        logs: { gbPerDay: 30, retentionDays: 30 },
        traces: { spansPerSecond: 300e9 / 2_592_000 / 1000, avgSpanBytes: 1000, retentionDays: 30 },
        metrics: { activeSeries: 100e9 / (43_200 * 150), intervalSeconds: 60, bytesPerDataPoint: 150 },
      },
      expect: 975,
    },
    {
      // Blog: 90-day retention is "$0.50 plus two $0.02 extensions", $0.54 a GB.
      // 100 GB/day x 60 days past the included 30 = 6,000 GB held x $0.02 = $120.
      name: "100 GB of logs a day kept 90 days, light queries: $1,500 + $150 + $120 of retention = $1,770",
      preset: "mid",
      signals: ["logs"],
      settings: { queryLoad: "light" },
      workload: { logs: { gbPerDay: 100, retentionDays: 90 } },
      expect: 1770,
      lines: 3,
    },
    {
      name: "traces alone kept 60 days: 2,592 GB x $0.50 + 51,840 GB scanned x $0.01 + 2,592 GB held x $0.02 = $1,866.24",
      preset: "mid",
      signals: ["traces"],
      workload: { traces: { spansPerSecond: 1000, avgSpanBytes: 1000, retentionDays: 60 } },
      expect: 1866.24,
    },
    {
      // Blog: "a team ingesting 20 GB/month pays ... about $10 on OpenObserve, since there's no floor".
      name: "20 GB a month, light queries: $10 of ingestion + $1 of queries, no minimum",
      preset: "mid",
      signals: ["logs"],
      settings: { queryLoad: "light" },
      workload: { logs: { gbPerDay: 20 / 30, retentionDays: 30 } },
      expect: { logs: 11, platform: 0, total: 11 },
    },
  ],
});
