/**
 * Google Cloud Observability: Cloud Logging, Cloud Monitoring and Cloud Trace.
 *
 * One global pay-as-you-go price list and no plans. Logs bill per GiB stored,
 * with 30 days included and a monthly charge per GiB kept after that. Metrics
 * sent over OTLP bill per sample on four stacked ranges. Traces bill per span.
 * Rates read from cloud.google.com/products/observability/pricing on the
 * checkedOn date.
 */
import { billFor } from "../bill";
import { compact, num, usdRate } from "../format";
import type { Kept, LineItem, Rate, Source, VendorAdapter } from "../types";
import { DAYS_PER_MONTH, SECONDS_PER_MONTH, gbToGib } from "../units";

const sources: Source[] = [
  {
    id: "pricing",
    label: "Pricing page",
    url: "https://cloud.google.com/products/observability/pricing",
  },
  {
    id: "examples",
    label: "Docs: pricing examples",
    url: "https://cloud.google.com/stackdriver/observability-pricing-examples",
  },
  {
    id: "log-example",
    label: "Docs: log cost example (Bigtable audit logs)",
    url: "https://docs.cloud.google.com/bigtable/docs/audit-log-estimate-costs#estimate-costs",
  },
  {
    id: "otlp",
    label: "Docs: OTLP billing",
    url: "https://docs.cloud.google.com/stackdriver/docs/otlp/overview#billing",
  },
  {
    id: "log-retention",
    label: "Docs: log retention periods",
    url: "https://docs.cloud.google.com/logging/quotas#logs_retention_periods",
  },
  {
    id: "metric-retention",
    label: "Docs: metric retention",
    url: "https://docs.cloud.google.com/monitoring/quotas#data_retention_policy",
  },
  {
    id: "trace-retention",
    label: "Docs: trace retention",
    url: "https://docs.cloud.google.com/stackdriver/quotas#observability-api-limits",
  },
];

/** Free log storage per project per month, in GiB. The estimate assumes one project. */
const FREE_LOG_GIB = 50;
/** Days of storage the log storage price includes. */
const INCLUDED_LOG_DAYS = 30;
/** The longest retention a log bucket can be set to, in days. */
const MAX_LOG_DAYS = 3650;
/** Free spans per billing account per month, in millions. */
const FREE_SPANS_MILLIONS = 2.5;
/** Cloud Trace keeps spans this many days. The period is not configurable. */
const TRACE_DAYS = 30;
/** Cloud Monitoring keeps OTLP metrics this many months. No longer option is published. */
const METRIC_MONTHS = 24;
/** Free time series returned by Monitoring API reads per billing account per month, in millions. */
const FREE_API_READ_MILLIONS = 1;

/**
 * Samples are priced by the million on stacked ranges, counted per billing
 * account. Bounds are cumulative, in millions of samples a month.
 */
const SAMPLE_TIERS: { id: string; upToMillions: number | null; usd: number; range: string }[] = [
  { id: "metric-samples-first-50b", upToMillions: 50_000, usd: 0.06, range: "first 50 billion" },
  { id: "metric-samples-50b-250b", upToMillions: 250_000, usd: 0.048, range: "50 to 250 billion" },
  { id: "metric-samples-250b-500b", upToMillions: 500_000, usd: 0.036, range: "250 to 500 billion" },
  { id: "metric-samples-over-500b", upToMillions: null, usd: 0.024, range: "over 500 billion" },
];

const rates: Rate[] = [
  {
    id: "log-storage",
    label: "Log storage",
    usd: 0.5,
    unit: "GiB streamed into log buckets",
    sourceId: "pricing",
    basis: "list",
    note: `One-time charge that includes up to ${INCLUDED_LOG_DAYS} days of storage and all querying. The first ${FREE_LOG_GIB} GiB per project each month are free`,
  },
  {
    id: "log-retention",
    label: `Log retention beyond ${INCLUDED_LOG_DAYS} days`,
    usd: 0.01,
    unit: "GiB per month",
    sourceId: "pricing",
    basis: "list",
    note: `Billed monthly on logs kept longer than ${INCLUDED_LOG_DAYS} days`,
  },
  ...SAMPLE_TIERS.map(
    (t): Rate => ({
      id: t.id,
      label: `Metric samples, ${t.range} a month`,
      usd: t.usd,
      unit: "million samples ingested",
      sourceId: "pricing",
      basis: "list",
      note: "OTLP and Managed Service for Prometheus metrics. Ranges are stacked and counted per billing account",
    }),
  ),
  {
    id: "trace-spans",
    label: "Trace span ingestion",
    usd: 0.2,
    unit: "million spans",
    sourceId: "pricing",
    basis: "list",
    note: `The first ${FREE_SPANS_MILLIONS} million spans per billing account each month are free`,
  },
  {
    id: "monitoring-api-reads",
    label: "Monitoring API reads from outside the Google Cloud console",
    usd: 0.5,
    unit: "million time series returned",
    sourceId: "pricing",
    basis: "list",
    note: `Not part of the estimate. The first ${FREE_API_READ_MILLIONS} million time series per billing account each month are free`,
  },
];

export const googleCloud: VendorAdapter = {
  id: "google-cloud",
  name: "Google Cloud Observability",
  group: "cloud",
  plan: () => "Pay as you go, one project",
  pricingUrl: "https://cloud.google.com/products/observability/pricing",
  checkedOn: "2026-11-12",
  sources,
  rates,
  coverage: { logs: "priced", metrics: "priced", traces: "priced", profiles: "unpriced" },
  coverageNote: {
    profiles:
      "Cloud Profiler has no charge within its quotas (Go, Java, Node.js and Python, kept 30 days). Only platforms that publish a rate for continuous profiling are priced.",
  },

  price({ w, d }) {
    const bill = billFor(rates);
    const lines: LineItem[] = [];

    const logsSent = d.logs.gbPerMonth > 0;
    const metricsSent = d.metrics.dataPointsPerMonth > 0;
    const tracesSent = d.traces.spansPerMonth > 0;

    // Retention shorter than the ask goes first in the assumptions (contract rule 5).
    const shorter: string[] = [];
    const assumptions: string[] = [
      metricsSent
        ? "Telemetry arrives over OTLP from an OpenTelemetry Collector at Google's Telemetry API. On that path Google bills metrics per sample, at the Managed Service for Prometheus price."
        : "Telemetry arrives over OTLP from an OpenTelemetry Collector at Google's Telemetry API.",
    ];

    // Logs: a one-time charge per GiB stored, then a monthly charge per GiB
    // still held after the included 30 days.
    const logGbPerDay = d.logs.gbPerMonth / DAYS_PER_MONTH;
    const logGib = gbToGib(d.logs.gbPerMonth);
    const billableLogGib = Math.max(0, logGib - FREE_LOG_GIB);
    lines.push(
      ...bill.line({
        bucket: "logs",
        label: `Log storage, ${INCLUDED_LOG_DAYS} days included`,
        quantity: billableLogGib,
        unit: "GiB",
        rateId: "log-storage",
        detail: `${num(logGbPerDay)} GB/day × ${DAYS_PER_MONTH} days = ${num(d.logs.gbPerMonth)} GB = ${num(logGib)} GiB, less ${FREE_LOG_GIB} GiB free`,
      }),
    );

    // Retention is priced at steady state: every day of logs older than the
    // included 30 is in storage at once. Google's worked log cost example does
    // the same (90 days kept is two months of volume at the retention rate),
    // and its cost table applies the rate to the whole volume, before the
    // free 50 GiB.
    const logDays = Math.min(Math.max(d.logs.retentionDays, INCLUDED_LOG_DAYS), MAX_LOG_DAYS);
    const extraLogDays = Math.max(0, logDays - INCLUDED_LOG_DAYS);
    const heldLogGb = logGbPerDay * extraLogDays;
    lines.push(
      ...bill.line({
        bucket: "logs",
        label: `Log retention beyond ${INCLUDED_LOG_DAYS} days`,
        quantity: gbToGib(heldLogGb),
        unit: "GiB held",
        rateId: "log-retention",
        detail: `${num(logGbPerDay)} GB/day × ${num(extraLogDays, 0)} days kept after the first ${INCLUDED_LOG_DAYS} = ${num(heldLogGb)} GB = ${num(gbToGib(heldLogGb))} GiB`,
      }),
    );

    if (logsSent) {
      if (d.logs.retentionDays > MAX_LOG_DAYS) {
        shorter.push(
          `Cloud Logging keeps logs for at most ${num(MAX_LOG_DAYS, 0)} days. The ${num(d.logs.retentionDays, 0)} days asked for is priced as ${num(MAX_LOG_DAYS, 0)}.`,
        );
      }
      assumptions.push(
        `Google bills logs per GiB (2^30 bytes). The ${num(d.logs.gbPerMonth)} GB sent each month is ${num(logGib)} GiB.`,
        "Logs are billed at the size sent. Google copies resource and scope attributes into every OTLP log entry, which it says can raise the stored volume. It publishes no factor, so none is applied.",
      );
      if (billableLogGib === 0) {
        assumptions.push(
          `Logs: ${num(logGib)} GiB a month fits inside the ${FREE_LOG_GIB} GiB free allotment, so storage is not charged.`,
        );
      }
      if (extraLogDays > 0) {
        assumptions.push(
          `Log retention is priced with a full ${num(logDays, 0)} days of logs in storage. The charge is lower until that much has built up.`,
        );
      }
      if (d.logs.retentionDays < INCLUDED_LOG_DAYS) {
        assumptions.push(
          `Log storage is a one-time charge that covers up to ${INCLUDED_LOG_DAYS} days. Keeping logs ${num(d.logs.retentionDays, 0)} days costs the same.`,
        );
      }
      if (d.logs.searchableGbPerMonth < d.logs.gbPerMonth) {
        assumptions.push(
          "Cloud Logging has one storage tier. Every log is stored searchable and the searchable share is not used.",
        );
      }
    }

    // Metrics: OTLP metrics are billed per sample, like Managed Service for
    // Prometheus, on stacked ranges. There is no free allotment for samples.
    // Google has no host fee and no separate class for host metrics on this
    // path, so host and custom series are billed alike.
    lines.push(
      ...bill.graduated({
        bucket: "metrics",
        label: "Metric ingestion",
        quantity: d.metrics.dataPointsPerMonth / 1e6,
        unit: "M samples",
        tiers: SAMPLE_TIERS.map((t) => ({ upTo: t.upToMillions, rateId: t.id })),
        detail: `${compact(d.metrics.activeSeries)} series × one sample every ${w.metrics.intervalSeconds} s = ${compact(d.metrics.dataPointsPerMonth)} samples`,
      }),
    );

    if (metricsSent) {
      if (d.metrics.retentionMonths > METRIC_MONTHS) {
        shorter.push(
          `Cloud Monitoring keeps OTLP metrics for ${METRIC_MONTHS} months and lists no longer option. The ${num(d.metrics.retentionMonths, 0)} months asked for is priced as ${METRIC_MONTHS}.`,
        );
      }
      assumptions.push(
        "Every data point is counted as one sample, Google's count for a scalar value. A histogram point counts as 2 samples plus 1 for each non-empty bucket.",
        `All ${compact(d.metrics.activeSeries)} series are billed as samples, including the ${compact(d.metrics.hostSeries)} host, container and Kubernetes series. Google's OTLP docs bill OTLP metrics on the Prometheus samples price, and Google has no host fee that covers them. The system metrics Google Cloud and GKE publish themselves are free. The Collector does not send those.`,
        "The target_info series Google adds for each OpenTelemetry resource is not counted.",
      );
      if (d.metrics.retentionMonths < METRIC_MONTHS) {
        assumptions.push(
          `Cloud Monitoring keeps OTLP metrics ${METRIC_MONTHS} months at no extra charge, longer than the ${num(d.metrics.retentionMonths, 0)} months asked for.`,
        );
      }
    }

    // Traces: per span, whatever the span size, after the free allotment.
    const spanMillions = d.traces.spansPerMonth / 1e6;
    const billableSpanMillions = Math.max(0, spanMillions - FREE_SPANS_MILLIONS);
    lines.push(
      ...bill.line({
        bucket: "traces",
        label: "Trace span ingestion",
        quantity: billableSpanMillions,
        unit: "M spans",
        rateId: "trace-spans",
        detail: `${num(d.traces.spansPerMonth / SECONDS_PER_MONTH)} spans/s × ${num(SECONDS_PER_MONTH)} s a month = ${compact(d.traces.spansPerMonth)} spans, less ${num(FREE_SPANS_MILLIONS)}M free`,
      }),
    );

    if (tracesSent) {
      if (d.traces.retentionDays > TRACE_DAYS) {
        shorter.push(
          `Cloud Trace keeps spans for ${TRACE_DAYS} days and the period cannot be changed. The ${num(d.traces.retentionDays, 0)} days asked for is priced as ${TRACE_DAYS}.`,
        );
      }
      if (billableSpanMillions === 0) {
        assumptions.push(
          `Traces: ${compact(d.traces.spansPerMonth)} spans a month fit inside the ${num(FREE_SPANS_MILLIONS)} million free spans, so tracing is not charged.`,
        );
      }
      if (d.traces.retentionDays < TRACE_DAYS) {
        assumptions.push(
          `Cloud Trace keeps every span ${TRACE_DAYS} days, longer than the ${num(d.traces.retentionDays, 0)} days asked for, at the same price.`,
        );
      }
      if (d.traces.searchableSpansPerMonth < d.traces.spansPerMonth) {
        assumptions.push(
          "Cloud Trace has one storage tier. Every span is stored searchable and the searchable share is not used.",
        );
      }
    }

    // Where each allowance and tier is counted, for the signals being sent.
    const scope = ["One Google Cloud project on one billing account."];
    if (logsSent) scope.push(`The ${FREE_LOG_GIB} GiB of free logs is counted per project.`);
    if (tracesSent && metricsSent) {
      scope.push(
        `The ${num(FREE_SPANS_MILLIONS)} million free spans and the metric sample tiers are counted per billing account.`,
      );
    } else if (tracesSent) {
      scope.push(`The ${num(FREE_SPANS_MILLIONS)} million free spans are counted per billing account.`);
    } else if (metricsSent) {
      scope.push("The metric sample tiers are counted per billing account.");
    }
    assumptions.push(scope.join(" "));

    // The retention each price buys, wherever it differs from the ask.
    const kept: Kept = {};
    if (logsSent && logDays !== d.logs.retentionDays) kept.logsDays = logDays;
    if (metricsSent && d.metrics.retentionMonths !== METRIC_MONTHS) kept.metricsMonths = METRIC_MONTHS;
    if (tracesSent && d.traces.retentionDays !== TRACE_DAYS) kept.tracesDays = TRACE_DAYS;

    const included: string[] = [];
    if (logsSent) {
      included.push(`${INCLUDED_LOG_DAYS} days of log storage, with queries and Log Analytics SQL`);
    }
    if (metricsSent) {
      included.push(
        `${METRIC_MONTHS} months of metric storage, at full resolution for 1 week, 1-minute resolution for the next 5 weeks and 10-minute resolution after that`,
      );
    }
    if (tracesSent) included.push(`${TRACE_DAYS} days of trace storage`);
    included.push("Users, dashboards and alerting");

    const notIncluded: string[] = [];
    if (metricsSent) {
      notIncluded.push(
        `Metric reads through the Monitoring API from outside the Google Cloud console, for example from Grafana, at ${usdRate(bill.usd("monitoring-api-reads"))} per million time series returned after the first ${FREE_API_READ_MILLIONS} million a month`,
      );
    }
    notIncluded.push(
      "Uptime checks and synthetic monitors, which bill per execution",
      "Discounts from a negotiated contract, which Google does not publish",
    );

    const notes: string[] = [
      "Google publishes one global pay-as-you-go price list with no annual rate, and lists no charge for queries in the Google Cloud console. The billing term, region and query load settings do not change this estimate.",
    ];
    if (logsSent) {
      notes.push(
        `Logs cost ${usdRate(bill.usd("log-storage"))} per GiB once when stored, then ${usdRate(bill.usd("log-retention"))} per GiB for each month they are kept past ${INCLUDED_LOG_DAYS} days.`,
        "A log entry routed to more than one log bucket is charged once for each bucket.",
      );
    }
    if (metricsSent) {
      notes.push(
        "Metrics bill per sample, so halving the export interval doubles the metrics bill.",
        "Metrics written as custom metrics through the Cloud Monitoring API bill per MiB on a separate price list.",
      );
    }
    if (tracesSent) {
      notes.push(
        "Spans bill by count. Span size does not change the price.",
        "Google's pricing page says Cloud Trace charges are based on spans ingested and scanned. It lists a price for ingestion only, so no scan charge is modeled.",
      );
    }
    notes.push(
      "Alerting has no charge yet. Google has announced alerting charges that start no sooner than September 1, 2027.",
    );

    return { lines, kept, assumptions: [...shorter, ...assumptions], included, notIncluded, notes };
  },
};
