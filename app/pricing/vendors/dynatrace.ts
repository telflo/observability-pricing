/**
 * Dynatrace Platform Subscription, OTLP-only path.
 *
 * Telemetry reaches Dynatrace through the OTLP API from an OpenTelemetry
 * Collector, with no OneAgent. On that path nothing is billed per host or per
 * memory-GiB, and none of the metric and trace volume bundled with OneAgent
 * monitoring applies: every signal is priced on the rate card's meters.
 *
 *   logs     ingest per GiB, then either retain per GiB-day plus query per
 *            GiB scanned, or retain with included queries per GiB-day
 *   metrics  ingest per 100k data points (queries and 15 months of retention
 *            included), retain per GiB-day beyond that
 *   traces   ingest per GiB (10 days of retention included), retain per
 *            GiB-day beyond that, query per GiB scanned
 *
 * Rates read from dynatrace.com/pricing/rate-card on the checkedOn date. The
 * counting rules (what a data point is, where a size is measured, what is
 * included) come from the billing docs listed in `sources`. The rate card
 * also lists "Classic" meters (per 1,000 data points, log records or spans).
 * Dynatrace's OpenTelemetry licensing page bills OTLP data on the meters
 * above, so the Classic ones are not used here.
 */
import { billFor } from "../bill";
import { compact, num, usdRate } from "../format";
import type { Kept, LineItem, Rate, Source, VendorAdapter } from "../types";
import { BYTES_PER_GB, DAYS_PER_MONTH, MINUTES_PER_MONTH, SCAN_MULTIPLE, gbToGib } from "../units";

const sources: Source[] = [
  { id: "rate-card", label: "Rate card", url: "https://www.dynatrace.com/pricing/rate-card/" },
  { id: "pricing", label: "Pricing page", url: "https://www.dynatrace.com/pricing/" },
  {
    id: "otel-licensing",
    label: "Docs: OpenTelemetry licensing",
    url: "https://docs.dynatrace.com/docs/ingest-from/opentelemetry/opentelemetry-licensing",
  },
  {
    id: "logs-billing",
    label: "Billing docs: log analytics",
    url: "https://docs.dynatrace.com/docs/license/capabilities/log-analytics",
  },
  {
    id: "logs-ingest-billing",
    label: "Billing docs: log ingest",
    url: "https://docs.dynatrace.com/docs/license/capabilities/log-analytics/dps-log-ingest",
  },
  {
    id: "logs-retain-billing",
    label: "Billing docs: log retention",
    url: "https://docs.dynatrace.com/docs/license/capabilities/log-analytics/dps-log-retain",
  },
  {
    id: "logs-query-billing",
    label: "Billing docs: log queries",
    url: "https://docs.dynatrace.com/docs/license/capabilities/log-analytics/dps-log-query",
  },
  {
    id: "metrics-billing",
    label: "Billing docs: metrics",
    url: "https://docs.dynatrace.com/docs/license/capabilities/telemetry/dps-metrics",
  },
  {
    id: "traces-billing",
    label: "Billing docs: traces",
    url: "https://docs.dynatrace.com/docs/license/capabilities/telemetry/dps-traces",
  },
];

/** Metrics billing docs: "Metrics include 15 months (462 days) of one-minute-granularity retention." */
const INCLUDED_METRIC_RETENTION_MONTHS = 15;
const INCLUDED_METRIC_RETENTION_DAYS = 462;

/** Traces billing docs: "The first 10 days of retention are included." */
const INCLUDED_TRACE_RETENTION_DAYS = 10;

/** Pricing page: retention is extendable to 10 years on every signal. */
const MAX_RETENTION_DAYS = 3_650;

/**
 * Metrics billing docs, "Estimate your Retain cost": "Assume each metric data
 * point adds about 600 bytes of processed metric data to storage."
 */
const RETAINED_BYTES_PER_DATA_POINT = 600;

/**
 * Log retention is measured after parsing and enrichment (ingest is measured
 * before). The log analytics billing docs say only that "the total data volume
 * after processing can increase by a factor of 2 or more". That is a caution
 * with no fixed factor, so retained and scanned logs are billed at the size
 * sent and an assumption line says so. The log query docs do not say scans are
 * measured on enriched size.
 */

/**
 * Retain with Included Queries, from the log analytics billing docs and the
 * pricing page: a window of 10 to 35 days, with queries included up to 15
 * times the retained volume in any 24 hours.
 */
const INCLUDED_QUERIES = { minDays: 10, maxDays: 35, dailyScanMultiple: 15 };

const rates: Rate[] = [
  {
    id: "logs-ingest",
    label: "Log ingest and processing",
    usd: 0.2,
    unit: "GiB",
    sourceId: "rate-card",
    basis: "list",
    note: "Raw bytes sent, before enrichment",
  },
  {
    id: "logs-retain",
    label: "Log retention",
    usd: 0.0007,
    unit: "GiB-day",
    sourceId: "rate-card",
    basis: "list",
    note: "Measured after enrichment, before compression. No retention is included",
  },
  {
    id: "logs-query",
    label: "Log queries",
    usd: 0.0035,
    unit: "GiB-scanned",
    sourceId: "rate-card",
    basis: "list",
  },
  {
    id: "logs-retain-with-queries",
    label: "Log retention with included queries",
    usd: 0.02,
    unit: "GiB-day",
    sourceId: "rate-card",
    basis: "list",
    note: "For a window of 10 to 35 days. Replaces the retention and query rates",
  },
  {
    id: "metrics-ingest",
    label: "Metric ingest and processing",
    usd: 0.15,
    unit: "100k datapoints",
    sourceId: "rate-card",
    basis: "list",
    note: "Queries and 15 months of retention are included",
  },
  {
    id: "metrics-retain",
    label: "Metric retention beyond 15 months",
    usd: 0.0007,
    unit: "GiB-day",
    sourceId: "rate-card",
    basis: "list",
  },
  {
    id: "traces-ingest",
    label: "Trace ingest and processing",
    usd: 0.2,
    unit: "GiB",
    sourceId: "rate-card",
    basis: "list",
    note: "10 days of retention are included",
  },
  {
    id: "traces-retain",
    label: "Trace retention beyond 10 days",
    usd: 0.0007,
    unit: "GiB-day",
    sourceId: "rate-card",
    basis: "list",
  },
  {
    id: "traces-query",
    label: "Trace queries",
    usd: 0.0035,
    unit: "GiB-scanned",
    sourceId: "rate-card",
    basis: "list",
    note: "Not charged in the Distributed Tracing and Services apps",
  },
];

const total = (items: LineItem[]) => items.reduce((sum, item) => sum + item.amount, 0);

export const dynatrace: VendorAdapter = {
  id: "dynatrace",
  name: "Dynatrace",
  group: "suite",
  plan: () => "Platform Subscription rate card, OTLP ingest without OneAgent",
  pricingUrl: "https://www.dynatrace.com/pricing/",
  checkedOn: "2026-11-12",
  sources,
  rates,
  coverage: { logs: "priced", metrics: "priced", traces: "priced", profiles: "unpriced" },
  coverageNote: {
    profiles:
      "Profiling is part of Full-Stack Monitoring, billed by host memory, with no separate profiling rate.",
  },

  price({ w, d, s }) {
    const bill = billFor(rates);
    const lines: LineItem[] = [];
    const scan = SCAN_MULTIPLE[s.queryLoad];

    const logGib = gbToGib(d.logs.gbPerMonth);
    const traceGib = gbToGib(d.traces.gbPerMonth);
    const hasLogs = logGib > 0;
    const hasTraces = traceGib > 0;
    const hasMetrics = d.metrics.activeSeries > 0;

    const included: string[] = [];
    const kept: Kept = {};
    /** Lines saying a signal is kept for less time than asked; they lead the assumptions. */
    const shortfalls: string[] = [];
    const assumptions: string[] = [
      "Telemetry arrives over OTLP from an OpenTelemetry Collector with no OneAgent. That path has no per-host or per-memory monitoring fee, and none of the metric and trace volume that comes included with OneAgent hosts.",
    ];
    if (hasLogs || hasTraces) {
      assumptions.push(
        `Dynatrace bills binary GiB, so each GB (10^9 bytes) counts as ${num(gbToGib(1), 3)} GiB.`,
        "Log and trace ingest is counted at the uncompressed size sent. Dynatrace measures ingest before enrichment and publishes no factor for converting OTLP bytes.",
        `Log and trace queries are assumed to scan ${scan} times the GiB ingested each month (${s.queryLoad} query load). Dynatrace publishes no usage profile, so this is the calculator's scale.`,
      );
    }

    // Logs: ingest on what is sent, then whichever of the two published ways
    // to pay for keeping and querying it costs less.
    if (hasLogs) {
      const days = Math.min(Math.max(0, d.logs.retentionDays), MAX_RETENTION_DAYS);
      const gibPerDay = logGib / DAYS_PER_MONTH;

      lines.push(
        ...bill.line({
          bucket: "logs",
          label: "Log ingestion",
          quantity: logGib,
          unit: "GiB",
          rateId: "logs-ingest",
          detail: `${num(w.logs.gbPerDay)} GB/day × 30 days = ${num(d.logs.gbPerMonth)} GB, or ${num(logGib)} GiB`,
        }),
      );

      const heldGib = gibPerDay * days;
      const payPerQuery = [
        ...bill.line({
          bucket: "logs",
          label: `Log retention, ${num(days)} days`,
          quantity: heldGib * DAYS_PER_MONTH,
          unit: "GiB-days",
          rateId: "logs-retain",
          detail: `${num(gibPerDay)} GiB/day × ${num(days)} days kept = ${num(heldGib)} GiB held, billed for each of 30 days`,
        }),
        ...bill.line({
          bucket: "logs",
          label: "Log queries",
          quantity: logGib * scan,
          unit: "GiB scanned",
          rateId: "logs-query",
          detail: `${num(logGib)} GiB ingested × ${scan} (${s.queryLoad} query load) = ${num(logGib * scan)} GiB scanned`,
        }),
      ];

      // The included-queries window cannot be shorter than its 10-day minimum.
      const windowDays = Math.max(days, INCLUDED_QUERIES.minDays);
      const windowGib = gibPerDay * windowDays;
      const withQueries = bill.line({
        bucket: "logs",
        label: `Log retention with queries included, ${num(windowDays)} days`,
        quantity: windowGib * DAYS_PER_MONTH,
        unit: "GiB-days",
        rateId: "logs-retain-with-queries",
        detail: `${num(gibPerDay)} GiB/day × ${num(windowDays)} days kept = ${num(windowGib)} GiB held, billed for each of 30 days. Queries are included up to ${INCLUDED_QUERIES.dailyScanMultiple} times the held volume a day`,
      });
      const windowFits =
        windowDays <= INCLUDED_QUERIES.maxDays &&
        scan <= INCLUDED_QUERIES.dailyScanMultiple * windowDays;
      const useWindow = windowFits && total(withQueries) < total(payPerQuery);
      lines.push(...(useWindow ? withQueries : payPerQuery));

      assumptions.push(
        "Dynatrace measures retained logs after parsing and enrichment. Its log billing docs say processing can grow the volume by a factor of 2 or more but publish no fixed factor, so retained and scanned logs are billed at the size sent. Logs that grow in processing cost more to retain than shown.",
      );
      if (useWindow) {
        included.push(`Log queries on logs up to ${num(windowDays)} days old`);
        assumptions.push(
          `Logs are priced on Retain with Included Queries, which costs less than separate retention and query charges at ${num(days)} days of retention and a ${s.queryLoad} query load.`,
        );
        if (windowDays !== days) {
          kept.logsDays = windowDays;
          assumptions.push(
            `Logs: the included-queries window is at least ${INCLUDED_QUERIES.minDays} days, so ${INCLUDED_QUERIES.minDays} days of retention is priced for the ${num(d.logs.retentionDays)} asked.`,
          );
        }
      }
      if (d.logs.retentionDays > MAX_RETENTION_DAYS) {
        kept.logsDays = MAX_RETENTION_DAYS;
        shortfalls.push(
          `Logs are kept 10 years, the longest retention Dynatrace offers, for the ${num(d.logs.retentionDays)} days asked.`,
        );
      }
      if (w.logs.searchableShare < 1) {
        assumptions.push(
          "Logs: Dynatrace keeps every retained log queryable for the whole retention period and does not price indexing separately, so the searchable share is not used.",
        );
      }
    }

    // Metrics: stored data points, at most one per series per minute.
    if (hasMetrics) {
      const pointsPerMinute = Math.min(d.metrics.dataPointsPerMinute, d.metrics.activeSeries);
      const points = pointsPerMinute * MINUTES_PER_MONTH;
      const subMinute = d.metrics.dataPointsPerMinute > d.metrics.activeSeries;
      const cadence =
        w.metrics.intervalSeconds > 60 ? `every ${num(w.metrics.intervalSeconds)} s` : "a minute";

      lines.push(
        ...bill.line({
          bucket: "metrics",
          label: "Metric data points",
          quantity: points / 100_000,
          unit: "100k data points",
          rateId: "metrics-ingest",
          detail: `${compact(d.metrics.activeSeries)} series × one data point ${cadence} = ${compact(points)} data points in a 30-day month`,
        }),
      );

      const askedDays = d.metrics.retentionMonths * DAYS_PER_MONTH;
      const days = Math.min(askedDays, MAX_RETENTION_DAYS);
      const extraDays = Math.max(0, days - INCLUDED_METRIC_RETENTION_DAYS);
      const pointsPerDay = points / DAYS_PER_MONTH;
      const gbPerDay = (pointsPerDay * RETAINED_BYTES_PER_DATA_POINT) / BYTES_PER_GB;
      const gibPerDay = gbToGib(gbPerDay);
      const heldGib = gibPerDay * extraDays;
      lines.push(
        ...bill.line({
          bucket: "metrics",
          label: `Metric retention past the ${INCLUDED_METRIC_RETENTION_MONTHS} included months`,
          quantity: heldGib * DAYS_PER_MONTH,
          unit: "GiB-days",
          rateId: "metrics-retain",
          detail: `${compact(pointsPerDay)} data points/day × ${RETAINED_BYTES_PER_DATA_POINT} bytes = ${num(gbPerDay)} GB, or ${num(gibPerDay)} GiB a day, × ${num(extraDays)} days past the ${INCLUDED_METRIC_RETENTION_DAYS} included = ${num(heldGib)} GiB held, billed for each of 30 days`,
        }),
      );

      included.push(
        `Metric queries, and ${INCLUDED_METRIC_RETENTION_MONTHS} months of metric retention at one-minute granularity`,
      );
      assumptions.push(
        `All ${compact(d.metrics.activeSeries)} series are billed as data points, including the ${compact(d.metrics.hostSeries)} standard host, container and Kubernetes series. Dynatrace's OpenTelemetry licensing docs bill OpenTelemetry metrics like other ingested metrics and include built-in host metrics only for OneAgent-monitored hosts.`,
        "Each series is counted as a gauge or counter, which is one data point per measurement. Dynatrace counts a histogram measurement as 10 data points.",
      );
      if (subMinute) {
        assumptions.push(
          `Metrics arrive every ${num(w.metrics.intervalSeconds)} s. Dynatrace aggregates anything collected more often than once a minute into one-minute buckets and bills stored data points, so each series is billed one data point a minute.`,
        );
      }
      const capped = askedDays > MAX_RETENTION_DAYS;
      if (capped) {
        kept.metricsMonths = MAX_RETENTION_DAYS / DAYS_PER_MONTH;
        shortfalls.push(
          `Metrics are kept 10 years, the longest retention Dynatrace offers, for the ${num(d.metrics.retentionMonths)} months asked.`,
        );
      }
      if (extraDays > 0) {
        const asked = capped ? "10 years" : `${num(d.metrics.retentionMonths)} months`;
        assumptions.push(
          `Metrics: ${asked} of retention is counted as ${num(days)} days, of which the first ${INCLUDED_METRIC_RETENTION_DAYS} are included. Retained metrics are sized at ${RETAINED_BYTES_PER_DATA_POINT} bytes a data point, the figure in Dynatrace's metrics billing docs.`,
        );
      } else if (d.metrics.retentionMonths < INCLUDED_METRIC_RETENTION_MONTHS) {
        kept.metricsMonths = INCLUDED_METRIC_RETENTION_MONTHS;
        assumptions.push(
          `Metrics: ${num(d.metrics.retentionMonths)} months of retention is covered by the ${INCLUDED_METRIC_RETENTION_MONTHS} months Dynatrace includes. A shorter period does not lower the price.`,
        );
      }
    }

    // Traces: ingest on what is sent, retention only past the included days.
    if (hasTraces) {
      const days = Math.min(Math.max(0, d.traces.retentionDays), MAX_RETENTION_DAYS);
      const extraDays = Math.max(0, days - INCLUDED_TRACE_RETENTION_DAYS);
      const gibPerDay = traceGib / DAYS_PER_MONTH;
      const heldGib = gibPerDay * extraDays;

      lines.push(
        ...bill.line({
          bucket: "traces",
          label: "Trace ingestion",
          quantity: traceGib,
          unit: "GiB",
          rateId: "traces-ingest",
          detail: `${compact(d.traces.spansPerMonth)} spans × ${num(w.traces.avgSpanBytes, 0)} bytes = ${num(d.traces.gbPerMonth)} GB, or ${num(traceGib)} GiB`,
        }),
        ...bill.line({
          bucket: "traces",
          label: `Trace retention past the ${INCLUDED_TRACE_RETENTION_DAYS} included days`,
          quantity: heldGib * DAYS_PER_MONTH,
          unit: "GiB-days",
          rateId: "traces-retain",
          detail: `${num(gibPerDay)} GiB/day × ${num(extraDays)} days past the ${INCLUDED_TRACE_RETENTION_DAYS} included = ${num(heldGib)} GiB held, billed for each of 30 days`,
        }),
        ...bill.line({
          bucket: "traces",
          label: "Trace queries",
          quantity: traceGib * scan,
          unit: "GiB scanned",
          rateId: "traces-query",
          detail: `${num(traceGib)} GiB ingested × ${scan} (${s.queryLoad} query load) = ${num(traceGib * scan)} GiB scanned`,
        }),
      );

      included.push(
        `The first ${INCLUDED_TRACE_RETENTION_DAYS} days of trace retention`,
        "Trace analysis in the Distributed Tracing and Services apps",
      );
      assumptions.push(
        "Retained and scanned spans are billed at the size sent. Dynatrace measures retained spans after processing and publishes no growth factor for them.",
        "The trace query line covers queries run from dashboards, notebooks, workflows, custom apps and the API. The Distributed Tracing and Services apps generate no query charge, so a team that only uses those apps pays less than that line.",
      );
      if (d.traces.retentionDays < INCLUDED_TRACE_RETENTION_DAYS) {
        kept.tracesDays = INCLUDED_TRACE_RETENTION_DAYS;
        assumptions.push(
          `Traces: ${num(d.traces.retentionDays)} days of retention is covered by the ${INCLUDED_TRACE_RETENTION_DAYS} days Dynatrace includes. A shorter period does not lower the price.`,
        );
      }
      if (d.traces.retentionDays > MAX_RETENTION_DAYS) {
        kept.tracesDays = MAX_RETENTION_DAYS;
        shortfalls.push(
          `Traces are kept 10 years, the longest retention Dynatrace offers, for the ${num(d.traces.retentionDays)} days asked.`,
        );
      }
      if (w.traces.searchableShare < 1) {
        assumptions.push(
          "Traces: Dynatrace does not price indexing separately, so every retained span stays queryable and the searchable share is not used.",
        );
      }
    }

    const logQueryRate = usdRate(bill.usd("logs-query"));
    const traceQueryRate = usdRate(bill.usd("traces-query"));
    const queryRates =
      logQueryRate === traceQueryRate
        ? `Log and trace queries cost ${logQueryRate}`
        : `Log queries cost ${logQueryRate} and trace queries ${traceQueryRate}`;

    included.push("Unlimited users");

    return {
      lines,
      kept,
      assumptions: [...shortfalls, ...assumptions],
      included,
      notIncluded: [
        "OneAgent Full-Stack Monitoring and Infrastructure Monitoring, which bill per memory-GiB-hour and per host-hour and are not needed to ingest OTLP",
        "Any gap between this usage and the minimum annual commitment, whose size Dynatrace does not publish",
        "Kubernetes Platform Monitoring, events, Real User Monitoring, synthetic monitoring and application security, each on a separate meter",
        "Metrics created inside Dynatrace from logs or spans, which bill as extra metric data points",
        "Data egress, automation workflows and AI units",
      ],
      notes: [
        "Dynatrace sells the subscription on an annual commitment and bills usage past the commitment at the same rates. There is no separate monthly price, so both billing terms give the same price here.",
        "Unit prices fall as the commitment grows. The discount schedule is not published, so this estimate uses list rates.",
        `Dynatrace sells two log models on the same rate card: retention and queries metered separately, or Retain with Included Queries at ${usdRate(bill.usd("logs-retain-with-queries"))} per GiB-day for a window of ${INCLUDED_QUERIES.minDays} to ${INCLUDED_QUERIES.maxDays} days. This estimate uses whichever costs less for the retention and query load chosen.`,
        `${queryRates} per GiB scanned, so those lines follow how often dashboards, notebooks and workflows read the data. On log queries, data that Dynatrace finds irrelevant to the result is discounted by 98%, which this estimate does not count.`,
        "Metrics bill per stored data point. A series that reports less often than once a minute costs less, and one that reports more often costs the same as once a minute.",
        "The rate card lists one set of US-dollar prices with no regional rates, so the US and EU settings give the same price.",
        "Retention bills per GiB-day held, so a retention line reaches the amount shown only once data has been kept for the full period.",
      ],
    };
  },
};
