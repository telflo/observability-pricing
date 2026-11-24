/**
 * Amazon CloudWatch, with everything sent to its OTLP endpoints.
 *
 * Logs land in CloudWatch Logs (Standard class) and pay three separate
 * meters: GB ingested, compressed GB-months stored and GB scanned by Logs
 * Insights. Metrics pay the per-GB OpenTelemetry price, which includes 15
 * months of storage. Spans go through Transaction Search: tiered per GB and
 * log-group storage, with indexing left at the free 1%. Profiles go to
 * CodeGuru Profiler, a separate service billed per sampling hour.
 * Log ingestion and scanning are priced by Region. The other meters cost the
 * same in N. Virginia and Ireland.
 *
 * Two unit conventions, each taken from AWS's worked examples: logs and
 * spans are counted in binary GB (2^30 bytes), metrics in GB of 10^9 bytes.
 *
 * Rates read on the checkedOn date from aws.amazon.com/cloudwatch/pricing,
 * the price data file that page renders its tables from, and the CloudWatch
 * Omni pricing page.
 */
import { billFor, smallestCovering } from "../bill";
import type { TierStep } from "../bill";
import { compact, num, usdRate } from "../format";
import type { Kept, LineItem, Rate, Settings, Source, VendorAdapter } from "../types";
import { DAYS_PER_MONTH, SCAN_MULTIPLE, gbToGib } from "../units";

const sources: Source[] = [
  { id: "pricing", label: "Pricing page", url: "https://aws.amazon.com/cloudwatch/pricing/" },
  {
    id: "price-data",
    label: "Price data file behind the pricing page's tables, by Region",
    url: "https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/cloudwatch/USD/current/cloudwatch.json",
  },
  {
    id: "omni-pricing",
    label: "CloudWatch Omni pricing page",
    url: "https://aws.amazon.com/cloudwatch/omni/pricing/",
  },
  {
    id: "otlp",
    label: "Docs: OTLP endpoints",
    url: "https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html",
  },
  {
    id: "transaction-search",
    label: "Docs: Transaction Search",
    url: "https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Enable-TransactionSearch.html",
  },
  {
    id: "codeguru-pricing",
    label: "CodeGuru pricing page (Profiler)",
    url: "https://aws.amazon.com/codeguru/pricing/",
  },
  {
    id: "retention",
    label: "API reference: log group retention settings",
    url: "https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_PutRetentionPolicy.html",
  },
];

interface RegionRates {
  name: string;
  ingestRateId: string;
  scanRateId: string;
}

/**
 * The two Regions priced, and the rates that differ between them. Frankfurt
 * has higher log prices and is not modeled.
 */
const REGIONS: Record<Settings["region"], RegionRates> = {
  us: { name: "US East (N. Virginia)", ingestRateId: "log-ingest-us", scanRateId: "log-scan-us" },
  eu: { name: "Europe (Ireland)", ingestRateId: "log-ingest-eu", scanRateId: "log-scan-eu" },
};

/**
 * Compressed bytes stored per uncompressed byte ingested. Published in the
 * storage lines of the Omni pricing page's examples ("0.15 (compression)").
 */
const STORAGE_COMPRESSION = 0.15;

/** Monthly free tier: 5 GB each for log ingestion, log storage and Logs Insights scans. */
const FREE_GB = 5;

/** Share of ingested spans indexed as trace summaries at no charge. */
const FREE_INDEX_SHARE = 0.01;

/** Sampling hours per profiling group a month past which CodeGuru Profiler charges nothing. */
const PROFILER_GROUP_CAP_HOURS = 36_000;

/** Months of storage the OpenTelemetry metric price includes. */
const METRIC_RETENTION_MONTHS = 15;

/** Retention settings a log group accepts, in days (PutRetentionPolicy). */
const RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288,
  3653,
];

/**
 * Span volume tiers. The edges are in AWS's GB: its span example prices
 * the first 10 TB as 10 x 1,024 GB and the next 20 TB as 20 x 1,024 GB.
 */
const SPAN_TIERS: TierStep[] = [
  { upTo: 10_240, rateId: "spans-first-10tb" },
  { upTo: 30_720, rateId: "spans-next-20tb" },
  { upTo: null, rateId: "spans-over-30tb" },
];

const rates: Rate[] = [
  {
    id: "log-ingest-us",
    label: "Log ingestion over OTLP, Standard class",
    usd: 0.5,
    unit: "GB ingested",
    sourceId: "price-data",
    basis: "list",
    note: "US East (N. Virginia), \"Ingested Log Otel\". Same as the Logs API rate",
  },
  {
    id: "log-ingest-eu",
    label: "Log ingestion over OTLP, Standard class",
    usd: 0.57,
    unit: "GB ingested",
    sourceId: "price-data",
    basis: "list",
    note: "EU (Ireland), \"Ingested Log Otel\". Same as the Logs API rate",
  },
  {
    id: "log-storage",
    label: "Log group storage, Standard tier",
    usd: 0.03,
    unit: "GB-month, compressed",
    sourceId: "price-data",
    basis: "list",
    note: "\"Stored Data\", same in N. Virginia and Ireland",
  },
  {
    id: "log-scan-us",
    label: "Logs Insights queries",
    usd: 0.005,
    unit: "GB scanned",
    sourceId: "price-data",
    basis: "list",
    note: "US East (N. Virginia), \"Queried Logs Insights\"",
  },
  {
    id: "log-scan-eu",
    label: "Logs Insights queries",
    usd: 0.0057,
    unit: "GB scanned",
    sourceId: "price-data",
    basis: "list",
    note: "EU (Ireland), \"Queried Logs Insights\"",
  },
  {
    id: "otel-metrics",
    label: "OpenTelemetry metrics",
    usd: 0.5,
    unit: "GB ingested",
    sourceId: "pricing",
    basis: "list",
    note: "Includes 15 months of storage",
  },
  {
    id: "spans-first-10tb",
    label: "Spans, first 10 TB a month",
    usd: 0.35,
    unit: "GB ingested",
    sourceId: "pricing",
    basis: "list",
    note: "Up to 10,240 GB",
  },
  {
    id: "spans-next-20tb",
    label: "Spans, next 20 TB a month",
    usd: 0.2,
    unit: "GB ingested",
    sourceId: "pricing",
    basis: "list",
    note: "From 10,240 to 30,720 GB",
  },
  {
    id: "spans-over-30tb",
    label: "Spans, over 30 TB a month",
    usd: 0.15,
    unit: "GB ingested",
    sourceId: "pricing",
    basis: "list",
    note: "Above 30,720 GB",
  },
  {
    id: "span-indexing",
    label: "Spans indexed as trace summaries",
    usd: 0.75,
    unit: "million spans indexed",
    sourceId: "pricing",
    basis: "list",
    note: "After the first 1% of spans, which is indexed at no charge. Not used: the estimate keeps AWS's default 1%, and indexing does not decide what is searchable",
  },
  {
    id: "profiler-sampling-hour",
    label: "CodeGuru Profiler, EC2, ECS, EKS and Fargate",
    usd: 0.005,
    unit: "sampling hour (one instance or container profiled for an hour)",
    sourceId: "codeguru-pricing",
    basis: "list",
    note: `For the first ${num(PROFILER_GROUP_CAP_HOURS)} sampling hours per profiling group a month, with no charge beyond that`,
  },
];

const days = (n: number) => (n === 1 ? "1 day" : `${num(n, 0)} days`);

/** Null when the log group setting equals what was asked for. */
function retentionNote(signal: string, asked: number, billed: number): string | null {
  if (billed === asked) return null;
  return billed > asked
    ? `${signal}: ${days(asked)} is not a log group retention setting, so ${days(billed)}, the next setting up, is priced.`
    : `${signal} are kept at most ${days(billed)}, the longest log group retention setting, which is shorter than the ${days(asked)} asked for.`;
}

export const awsCloudwatch: VendorAdapter = {
  id: "aws-cloudwatch",
  name: "Amazon CloudWatch",
  group: "cloud",
  plan: (s) => `Pay as you go, OTLP ingestion, ${REGIONS[s.region].name}`,
  pricingUrl: "https://aws.amazon.com/cloudwatch/pricing/",
  checkedOn: "2026-11-12",
  sources,
  rates,
  coverage: { logs: "priced", metrics: "priced", traces: "priced", profiles: "priced" },

  price({ w, d, s }) {
    const bill = billFor(rates);
    const region = REGIONS[s.region];
    const lines: LineItem[] = [];

    const logsSent = d.logs.gbPerMonth > 0;
    const metricsSent = d.metrics.gbPerMonth > 0;
    const tracesSent = d.traces.spansPerMonth > 0;

    // Logs: three meters, each with a 5 GB free tier.
    const logGib = gbToGib(d.logs.gbPerMonth);
    lines.push(
      ...bill.line({
        bucket: "logs",
        label: "Log ingestion",
        quantity: logGib - FREE_GB,
        unit: "GiB",
        rateId: region.ingestRateId,
        detail: `${num(w.logs.gbPerDay)} GB/day × 30 days = ${num(d.logs.gbPerMonth)} GB = ${num(logGib)} GiB, less ${FREE_GB} GiB free`,
      }),
    );

    // Storage: what is held at steady state, compressed. The 5 GB free tier is
    // one allowance for the account, so spans get whatever logs leave of it.
    let freeStorage = FREE_GB;
    const logDays = smallestCovering(RETENTION_DAYS, (n) => n, d.logs.retentionDays);
    const logHeldGib = gbToGib((d.logs.gbPerMonth / DAYS_PER_MONTH) * logDays);
    const logStoredGib = logHeldGib * STORAGE_COMPRESSION;
    lines.push(
      ...bill.line({
        bucket: "logs",
        label: `Log storage, ${days(logDays)}`,
        quantity: logStoredGib - freeStorage,
        unit: "GiB-months",
        rateId: "log-storage",
        detail: `${num(logHeldGib)} GiB held (${days(logDays)} of logs) × ${STORAGE_COMPRESSION} compression, less ${FREE_GB} GiB free`,
      }),
    );
    if (logsSent) freeStorage = Math.max(0, freeStorage - logStoredGib);

    // Scans: the month's ingested volume times the shared query-load multiple.
    const scanMultiple = SCAN_MULTIPLE[s.queryLoad];
    const scannedGib = logGib * scanMultiple;
    lines.push(
      ...bill.line({
        bucket: "logs",
        label: "Log queries, Logs Insights",
        quantity: scannedGib - FREE_GB,
        unit: "GiB scanned",
        rateId: region.scanRateId,
        detail: `${num(logGib)} GiB ingested × ${scanMultiple} (${s.queryLoad} query load) = ${num(scannedGib)} GiB, less ${FREE_GB} GiB free`,
      }),
    );

    // Metrics: one meter, on the bytes of the OTLP payload, host and custom alike.
    lines.push(
      ...bill.line({
        bucket: "metrics",
        label: "Metric ingestion, OpenTelemetry",
        quantity: d.metrics.gbPerMonth,
        unit: "GB",
        rateId: "otel-metrics",
        detail: `${compact(d.metrics.activeSeries)} series, one point every ${num(w.metrics.intervalSeconds, 0)} s = ${compact(d.metrics.dataPointsPerMonth)} data points × ${num(w.metrics.bytesPerDataPoint, 0)} bytes`,
      }),
    );

    // Spans: tiered ingestion, indexing beyond the free 1%, then storage.
    const spanGib = gbToGib(d.traces.gbPerMonth);
    lines.push(
      ...bill.graduated({
        bucket: "traces",
        label: "Span ingestion",
        quantity: spanGib,
        unit: "GiB",
        tiers: SPAN_TIERS,
        detail: `${compact(d.traces.spansPerMonth)} spans × ${num(w.traces.avgSpanBytes, 0)} bytes = ${num(d.traces.gbPerMonth)} GB = ${num(spanGib)} GiB`,
      }),
    );

    // No span-indexing line. Every ingested span is searchable in Transaction
    // Search; indexing only adds X-Ray trace summaries, and AWS's default 1%
    // is free and, in its docs, "typically sufficient". The searchable share
    // therefore does not change the trace lines, as with Standard-class logs.

    const spanDays = smallestCovering(RETENTION_DAYS, (n) => n, d.traces.retentionDays);
    const spanHeldGib = gbToGib((d.traces.gbPerMonth / DAYS_PER_MONTH) * spanDays);
    const spanStoredGib = spanHeldGib * STORAGE_COMPRESSION;
    lines.push(
      ...bill.line({
        bucket: "traces",
        label: `Span storage, ${days(spanDays)}`,
        quantity: spanStoredGib - freeStorage,
        unit: "GiB-months",
        rateId: "log-storage",
        detail:
          `${num(spanHeldGib)} GiB held (${days(spanDays)} of spans) × ${STORAGE_COMPRESSION} compression` +
          (freeStorage > 0 ? `, less ${num(freeStorage)} GiB free` : ""),
      }),
    );

    // Retention actually priced, wherever it differs from the ask.
    const kept: Kept = {};
    const shorter: string[] = [];
    const later: string[] = [];
    if (logsSent && logDays !== d.logs.retentionDays) {
      kept.logsDays = logDays;
      const note = retentionNote("Logs", d.logs.retentionDays, logDays);
      if (note) (logDays < d.logs.retentionDays ? shorter : later).push(note);
    }
    if (tracesSent && spanDays !== d.traces.retentionDays) {
      kept.tracesDays = spanDays;
      const note = retentionNote("Spans", d.traces.retentionDays, spanDays);
      if (note) (spanDays < d.traces.retentionDays ? shorter : later).push(note);
    }
    if (metricsSent && d.metrics.retentionMonths !== METRIC_RETENTION_MONTHS) {
      kept.metricsMonths = METRIC_RETENTION_MONTHS;
      if (d.metrics.retentionMonths > METRIC_RETENTION_MONTHS) {
        shorter.push(
          `Metrics are kept at most ${METRIC_RETENTION_MONTHS} months, which is shorter than the ${num(d.metrics.retentionMonths, 0)} months asked for. AWS publishes no longer option for OpenTelemetry metrics.`,
        );
      } else {
        later.push(
          `Metrics: the OpenTelemetry metric price includes ${METRIC_RETENTION_MONTHS} months of storage, so ${METRIC_RETENTION_MONTHS} months is what is priced.`,
        );
      }
    }

    const assumptions: string[] = [
      ...shorter,
      `Telemetry goes to CloudWatch's OTLP endpoints in ${region.name}: logs into the Standard log class, metrics on the per-GB OpenTelemetry price, spans through Transaction Search.`,
      ...later,
    ];
    if (s.region === "eu") {
      assumptions.push(
        "In Ireland, log ingestion and Logs Insights scans cost more than in N. Virginia. Storage, metrics and spans cost the same. Other EU Regions have different log prices.",
      );
    }
    if (logsSent || tracesSent) {
      assumptions.push(
        "AWS's CloudWatch pricing examples count 1,024 GB to a TB and 1,048,576 KB to a GB, so log and span volumes are converted from GB of 10^9 bytes to GiB of 2^30 bytes before pricing.",
        `Storage is billed on compressed bytes. The factor of ${STORAGE_COMPRESSION} compressed bytes per uncompressed byte is the one AWS uses in its Omni pricing examples.`,
      );
    }
    if (logsSent) {
      assumptions.push(
        "Log volume is priced at the size sent. AWS sizes each OTLP log event as its record plus its resource and scope, and publishes no factor between that and the raw OTLP size, so none is applied.",
        `Logs Insights scans ${scanMultiple} times the month's log volume (${s.queryLoad} query load).`,
      );
      if (w.logs.searchableShare < 1) {
        assumptions.push(
          "The Standard log class keeps every log queryable, so the searchable share does not change the log lines.",
        );
      }
    }
    if (metricsSent) {
      assumptions.push(
        "Host, container and application metrics all pay the same per-GB price over OTLP. AWS lists no per-host fee and no custom-metric class on this path, so the host share does not change the metric line.",
        `AWS bills the uncompressed OTLP metric payload and says a typical data point with 10 to 15 attributes is 300 to 600 bytes. This estimate uses ${num(w.metrics.bytesPerDataPoint, 0)} bytes per data point.`,
        "Metric volume is counted in GB of 10^9 bytes, as in AWS's OpenTelemetry metrics example.",
      );
    }
    if (tracesSent) {
      assumptions.push(
        `Every ingested span stays searchable in Transaction Search, so the searchable share does not change the trace lines. Spans are indexed as trace summaries at AWS's default ${FREE_INDEX_SHARE * 100}%, which is free and which its docs call typically sufficient.`,
        "Stored spans are billed at the log storage rate, as in the examples on AWS's Omni pricing page.",
      );
    }
    const profiledHours = d.profiles.profiledHostHours;
    if (profiledHours > 0) {
      lines.push(
        ...bill.line({
          bucket: "profiles",
          label: "CodeGuru Profiler sampling hours",
          quantity: profiledHours,
          unit: "sampling hours",
          rateId: "profiler-sampling-hour",
          detail: `${num(d.profiles.profiledHosts)} profiled hosts × 720 hours`,
        }),
      );
      assumptions.push(
        `Profiles go to CodeGuru Profiler, billed per sampling hour: one host profiled for an hour, whatever the sample rate. A profiling group stops being charged after ${num(PROFILER_GROUP_CAP_HOURS)} hours a month (about ${num(PROFILER_GROUP_CAP_HOURS / 720, 0)} hosts all month). The number of groups depends on how applications are split, so no cap is applied and this line is an upper bound.`,
        "CodeGuru Profiler's agent supports JVM languages and Python 3.6 or later, so this price applies only to services written in those.",
      );
    }
    assumptions.push(
      "The free tier and the span volume tiers are counted once, as for one account in one Region.",
    );

    return {
      lines,
      kept,
      assumptions,
      included: [
        `${METRIC_RETENTION_MONTHS} months of metric storage, with no separate charge per series or per API call`,
        `Indexing of the first ${FREE_INDEX_SHARE * 100}% of spans as trace summaries`,
        `${FREE_GB} GB a month free each for log ingestion, log storage and Logs Insights scans`,
        "No minimum fee, and no per-host or per-user fees",
      ],
      notIncluded: [
        "Alarms and dashboards beyond the free tier",
        "PromQL queries on metrics through the API, charged per million samples scanned",
        "Queries that scan span data, which bill per GB scanned",
        "Data transfer charges from the network the telemetry is sent from",
        "Application Signals metrics, which bill per GB on the span tiers when that feature is on",
        "Add-ons such as Container Insights, Synthetics, RUM and Database Insights",
        ...(profiledHours > 0
          ? ["CodeGuru Profiler's 90-day free trial for new profiling groups"]
          : []),
        "Private discounts agreed with AWS",
      ],
      notes: [
        `Log ingestion at ${usdRate(bill.usd(region.ingestRateId))} per GB includes no retention. Storage is charged from the first day at ${usdRate(bill.usd("log-storage"))} per compressed GB-month, and Logs Insights charges ${usdRate(bill.usd(region.scanRateId))} for each GB a query scans.`,
        "Metrics are billed on payload bytes. More attributes or a shorter export interval raise the bill. The number of series alone does not.",
        `Span indexing costs ${usdRate(bill.usd("span-indexing"))} per million spans after the free ${FREE_INDEX_SHARE * 100}%. It buys X-Ray trace summaries for more traces, not searchability, and is left out.`,
        "Queries run through CloudWatch Omni are metered separately and include scans of up to five times the month's log and span ingestion. This estimate prices Logs Insights, which has no such allowance.",
        "Sent as classic custom metrics the same data bills per metric, and traces sent to X-Ray without Transaction Search bill per trace.",
        "An Infrequent Access log class and automatic storage tiering cost less per GB. Neither is modeled.",
        "A one-time offer covers Application Signals and Transaction Search for three months, or until 100 GB is ingested or 1 million spans are indexed. It is not applied.",
        "AWS publishes pay-as-you-go prices only for CloudWatch, so both billing terms give the same price.",
      ],
    };
  },
};
