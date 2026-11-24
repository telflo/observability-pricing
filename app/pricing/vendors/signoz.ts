/**
 * SigNoz Cloud, Teams plan.
 *
 * Three meters: GB of logs, GB of traces and metric data points, each at a
 * rate that depends on the retention chosen, with a $49 monthly minimum that
 * usage counts toward. Rates read from signoz.io/pricing on the checkedOn date.
 */
import { defineVendor } from "../spec";

/** Logs and traces share one ladder: the per-GB rate rises with retention. */
const LOG_TRACE_LADDER = [
  { at: 15, usd: 0.3 },
  { at: 30, usd: 0.4 },
  { at: 90, usd: 0.6 },
  { at: 180, usd: 0.8 },
  { at: 365, usd: 1.4 },
];

export const signoz = defineVendor({
  id: "signoz",
  name: "SigNoz Cloud",
  group: "open-source",
  plan: "Teams plan, pay as you go",
  pricingUrl: "https://signoz.io/pricing/",
  checkedOn: "2026-11-12",
  sources: {
    pricing: "https://signoz.io/pricing/",
    retention: { label: "Docs: retention period", url: "https://signoz.io/docs/userguide/retention-period/" },
    meter: { label: "Docs: cost meter", url: "https://signoz.io/docs/cost-meter/query-api/" },
  },
  rates: {
    "teams-minimum": {
      label: "Teams plan monthly minimum",
      usd: 49,
      unit: "month",
      sourceId: "pricing",
      basis: "list",
      note: "Usage counts toward it",
    },
  },
  logs: { unit: "gb", ladder: { source: "pricing", steps: LOG_TRACE_LADDER } },
  traces: { unit: "gb", ladder: { source: "pricing", steps: LOG_TRACE_LADDER } },
  metrics: {
    unit: "million-data-points",
    ladder: {
      source: "pricing",
      steps: [
        { at: 1, usd: 0.1 },
        { at: 3, usd: 0.12 },
        { at: 6, usd: 0.15 },
        { at: 13, usd: 0.18 },
      ],
    },
  },
  profiles: { coverage: "unsupported" },
  minimum: { rate: "teams-minimum", label: "Top-up to the Teams monthly minimum" },
  assumptions: [
    "A GB is counted as 10^9 uncompressed bytes as sent. SigNoz's docs give the formula (bytes / 10^9 x price) but not whether enrichment is counted.",
  ],
  included: [
    "Queries, dashboards and alerts",
    "Unlimited users and hosts",
    "The retention you pick, priced into the ingest rate",
  ],
  notIncluded: ["Enterprise plan features and support, which are priced by quote"],
  notes: [
    "Retention changes the ingest rate itself: the same GB costs {rate:logs-15d} kept 15 days and {rate:logs-365d} kept a year.",
    "Metrics bill per data point, so halving the export interval doubles the metrics bill.",
    "The Teams plan has no published annual discount, so both billing terms give the same price here.",
  ],
  examples: [
    {
      name: "the vendor's metrics example: 10,000 series at 30 s is about 864M samples, $86.40 at the 1-month rate",
      preset: "mid",
      signals: ["metrics"],
      workload: { metrics: { activeSeries: 10_000, intervalSeconds: 30, retentionMonths: 1 } },
      expect: { metrics: 86.4, total: 86.4 },
    },
    {
      name: "100 GB of logs a day at 30 days: 3,000 GB x $0.40 = $1,200",
      preset: "mid",
      signals: ["logs"],
      workload: { logs: { gbPerDay: 100, retentionDays: 30 } },
      expect: 1200,
    },
    {
      name: "45 days is priced at the 90-day rung: 3,000 GB x $0.60 = $1,800",
      preset: "mid",
      signals: ["logs"],
      workload: { logs: { gbPerDay: 100, retentionDays: 45 } },
      expect: 1800,
    },
    {
      name: "the $49 minimum: 30 GB x $0.30 = $9 of usage, topped up by $40",
      preset: "mid",
      signals: ["logs"],
      workload: { logs: { gbPerDay: 1, retentionDays: 15 } },
      expect: { logs: 9, platform: 40, total: 49 },
      lines: 2,
    },
  ],
});
