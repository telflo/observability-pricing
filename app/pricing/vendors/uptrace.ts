/**
 * Uptrace Cloud, pay as you go.
 *
 * Spans and logs bill per GB ingested and metrics per million data points.
 * 28 days of retention are included. Data kept longer goes to cold storage,
 * billed per GB-month for spans and logs and per 1,000 timeseries-months for
 * metrics, for up to 100 weeks.
 *
 * Only the published starting rates are priced. Uptrace's pages say rates
 * fall with volume, but the tier table exists only inside the pricing page's
 * calculator, and a comparison article on the same site describes a
 * different tier model (a base price with data points included). Volume
 * discounts are therefore not modeled. Cold storage uses the rates the FAQ
 * prints; the calculator's extended retention amounts are higher and follow
 * no published formula.
 */
import { billFor } from "../bill";
import { compact, num, usdRate } from "../format";
import type { Kept, LineItem, Rate, Source, VendorAdapter } from "../types";
import { DAYS_PER_MONTH } from "../units";

const sources: Source[] = [
  { id: "pricing", label: "Pricing page and FAQ", url: "https://uptrace.dev/pricing" },
  {
    id: "comparison",
    label: "Cost comparison article: tier rates, egress, cloud deployments",
    url: "https://uptrace.dev/comparisons/observability-tools-pricing",
  },
];

/** FAQ: "keeps all data for 4 weeks (28 days) by default". */
const INCLUDED_DAYS = 28;
/** FAQ: cold storage "for up to 100 weeks". */
const MAX_RETENTION_WEEKS = 100;
const MAX_RETENTION_DAYS = MAX_RETENTION_WEEKS * 7;
/** FAQ: "free up to 50 GB and 5,000 timeseries per month". */
const FREE_GB = 50;
const FREE_SERIES = 5_000;
/** FAQ: "The minimum supported interval in Uptrace is 10 seconds." */
const MIN_INTERVAL_SECONDS = 10;

const rates: Rate[] = [
  {
    id: "ingest-gb",
    label: "Spans and logs ingested",
    usd: 0.1,
    unit: "GB ingested",
    sourceId: "pricing",
    basis: "starting-from",
    note: "Pricing page: rates start at $0.10/GB. Lower volume rates exist but are not published as a table",
  },
  {
    id: "ingest-points",
    label: "Metric data points ingested",
    usd: 0.025,
    unit: "million data points",
    sourceId: "pricing",
    basis: "starting-from",
    note: "FAQ: starts at $0.025 per 1M datapoints and decreases with volume",
  },
  {
    id: "lowest-gb",
    label: "Spans and logs, lowest volume rate",
    usd: 0.016,
    unit: "GB ingested",
    sourceId: "pricing",
    basis: "list",
    note: "Pricing page: drops to $0.016/GB at scale. The volume is not stated. Not used in the estimate",
  },
  {
    id: "lowest-points",
    label: "Metric data points, lowest volume rate",
    usd: 0.004,
    unit: "million data points",
    sourceId: "comparison",
    basis: "list",
    note: "Article: $0.004 to $0.025 per 1M datapoints depending on tier. Not used in the estimate",
  },
  {
    id: "cold-gb",
    label: "Spans and logs kept past 28 days",
    usd: 0.01,
    unit: "GB-month",
    sourceId: "pricing",
    basis: "list",
    note: "FAQ: cold storage for up to 100 weeks. Example: 1,000 GB kept beyond 4 weeks costs $10/month",
  },
  {
    id: "cold-series",
    label: "Metrics kept past 28 days",
    usd: 0.2,
    unit: "1,000 timeseries-months",
    sourceId: "pricing",
    basis: "list",
    note: "FAQ: $0.20 per 1,000 timeseries-month on cold storage, up to 100 weeks",
  },
  {
    id: "dropped-gb",
    label: "Data dropped by Uptrace's sampling",
    usd: 0.01,
    unit: "GB dropped",
    sourceId: "pricing",
    basis: "list",
    note: "Not used in the estimate, which prices everything sent as kept",
  },
];

/** The retention Uptrace sells for an ask: at least the included days, at most 100 weeks. */
const keptDays = (askedDays: number) =>
  Math.min(MAX_RETENTION_DAYS, Math.max(INCLUDED_DAYS, askedDays));

export const uptrace: VendorAdapter = {
  id: "uptrace",
  name: "Uptrace Cloud",
  group: "open-source",
  plan: () => "Cloud, pay as you go, starting rates",
  pricingUrl: "https://uptrace.dev/pricing",
  checkedOn: "2026-11-12",
  sources,
  rates,
  coverage: { logs: "priced", metrics: "priced", traces: "priced", profiles: "unsupported" },

  price({ w, d }) {
    const bill = billFor(rates);
    const assumptions: string[] = [];
    const kept: Kept = {};

    // Retention first: a shorter retention than asked must lead the assumptions.
    const logDays = keptDays(d.logs.retentionDays);
    const traceDays = keptDays(d.traces.retentionDays);
    const metricAskedDays = d.metrics.retentionMonths * DAYS_PER_MONTH;
    const metricDays = keptDays(metricAskedDays);
    const asks = [
      {
        name: "Logs",
        sent: d.logs.gbPerMonth > 0,
        asked: d.logs.retentionDays,
        priced: logDays,
        unit: "days",
      },
      {
        name: "Traces",
        sent: d.traces.gbPerMonth > 0,
        asked: d.traces.retentionDays,
        priced: traceDays,
        unit: "days",
      },
      {
        name: "Metrics",
        sent: d.metrics.activeSeries > 0,
        asked: metricAskedDays,
        priced: metricDays,
        unit: "months",
      },
    ];
    for (const a of asks) {
      if (!a.sent || a.priced === a.asked) continue;
      if (a.name === "Logs") kept.logsDays = a.priced;
      if (a.name === "Traces") kept.tracesDays = a.priced;
      if (a.name === "Metrics") kept.metricsMonths = a.priced / DAYS_PER_MONTH;
      const asked =
        a.unit === "months"
          ? `${num(a.asked / DAYS_PER_MONTH)} months (${num(a.asked, 0)} days)`
          : `${num(a.asked, 0)} days`;
      if (a.priced < a.asked) {
        assumptions.push(
          `${a.name}: ${asked} of retention was asked for. Uptrace keeps data for at most ${MAX_RETENTION_WEEKS} weeks (${num(MAX_RETENTION_DAYS, 0)} days), so the price covers ${num(a.priced, 0)} days.`,
        );
      } else {
        assumptions.push(
          `${a.name}: ${asked} of retention was asked for. Uptrace keeps all data ${INCLUDED_DAYS} days at the ingest price, so the price covers ${INCLUDED_DAYS} days.`,
        );
      }
    }

    // Ingestion. The 50 GB free allowance is shared by spans and logs and is
    // taken from logs first.
    const logFreeGb = Math.min(FREE_GB, d.logs.gbPerMonth);
    const traceFreeGb = Math.min(FREE_GB - logFreeGb, d.traces.gbPerMonth);
    const logIngest = bill.line({
      bucket: "logs",
      label: "Log ingestion",
      quantity: d.logs.gbPerMonth - logFreeGb,
      unit: "GB",
      rateId: "ingest-gb",
      detail: `${num(w.logs.gbPerDay)} GB/day × ${DAYS_PER_MONTH} days = ${num(d.logs.gbPerMonth)} GB, less ${num(logFreeGb)} GB free`,
    });
    const traceIngest = bill.line({
      bucket: "traces",
      label: "Trace ingestion",
      quantity: d.traces.gbPerMonth - traceFreeGb,
      unit: "GB",
      rateId: "ingest-gb",
      detail: `${compact(d.traces.spansPerMonth)} spans × ${num(w.traces.avgSpanBytes, 0)} bytes = ${num(d.traces.gbPerMonth)} GB, less ${num(traceFreeGb)} GB free`,
    });

    // The data points of the first 5,000 series are free.
    const millionPoints = d.metrics.dataPointsPerMonth / 1e6;
    const freeSeries = Math.min(FREE_SERIES, d.metrics.activeSeries);
    const freeMillionPoints =
      d.metrics.activeSeries > 0 ? (millionPoints * freeSeries) / d.metrics.activeSeries : 0;
    const metricIngest = bill.line({
      bucket: "metrics",
      label: "Metric data points",
      quantity: millionPoints - freeMillionPoints,
      unit: "M data points",
      rateId: "ingest-points",
      detail: `${compact(d.metrics.activeSeries)} series × one point every ${num(w.metrics.intervalSeconds)} s = ${compact(d.metrics.dataPointsPerMonth)} points, less the ${compact(freeMillionPoints * 1e6)} points of ${num(freeSeries)} free series`,
    });

    // Cold storage: each day's volume older than 28 days, held for the month.
    const logColdDays = logDays - INCLUDED_DAYS;
    const logColdGb = (d.logs.gbPerMonth / DAYS_PER_MONTH) * logColdDays;
    const logCold = bill.line({
      bucket: "logs",
      label: `Logs kept past ${INCLUDED_DAYS} days`,
      quantity: logColdGb,
      unit: "GB-months",
      rateId: "cold-gb",
      detail: `${num(w.logs.gbPerDay)} GB/day × ${num(logColdDays, 0)} days past the first ${INCLUDED_DAYS} = ${num(logColdGb)} GB held`,
    });
    const traceColdDays = traceDays - INCLUDED_DAYS;
    const traceGbPerDay = d.traces.gbPerMonth / DAYS_PER_MONTH;
    const traceColdGb = traceGbPerDay * traceColdDays;
    const traceCold = bill.line({
      bucket: "traces",
      label: `Traces kept past ${INCLUDED_DAYS} days`,
      quantity: traceColdGb,
      unit: "GB-months",
      rateId: "cold-gb",
      detail: `${num(traceGbPerDay)} GB/day × ${num(traceColdDays, 0)} days past the first ${INCLUDED_DAYS} = ${num(traceColdGb)} GB held`,
    });
    const metricColdMonths = (metricDays - INCLUDED_DAYS) / DAYS_PER_MONTH;
    const thousandSeriesMonths = (d.metrics.activeSeries * metricColdMonths) / 1000;
    const metricCold = bill.line({
      bucket: "metrics",
      label: `Metrics kept past ${INCLUDED_DAYS} days`,
      quantity: thousandSeriesMonths,
      unit: "k timeseries-months",
      rateId: "cold-series",
      detail: `${compact(d.metrics.activeSeries)} series × ${num(metricColdMonths)} months past the first ${INCLUDED_DAYS} days`,
    });

    const lines: LineItem[] = [
      ...logIngest,
      ...logCold,
      ...traceIngest,
      ...traceCold,
      ...metricIngest,
      ...metricCold,
    ];

    if (d.logs.gbPerMonth + d.traces.gbPerMonth > 0) {
      assumptions.push(
        `Spans and logs are priced at ${usdRate(bill.usd("ingest-gb"))} per GB, Uptrace's starting rate. Uptrace lowers the rate as volume grows, down to ${usdRate(bill.usd("lowest-gb"))} per GB, but publishes the tier table only inside its calculator, so volume discounts are not modeled. Above 1 TB a month this estimate is likely higher than Uptrace's calculator shows.`,
        "A GB is counted as 10^9 uncompressed bytes as sent. Uptrace bills uncompressed size and publishes no factor between OTLP bytes and billed bytes.",
        `The free ${FREE_GB} GB a month is deducted once from spans and logs together, from logs first.`,
      );
    }
    if (d.metrics.activeSeries > 0) {
      assumptions.push(
        `Metric data points are priced at ${usdRate(bill.usd("ingest-points"))} per million, Uptrace's starting rate. Lower volume rates down to ${usdRate(bill.usd("lowest-points"))} are not modeled.`,
        `The free ${num(FREE_SERIES)} timeseries are applied as the data points of ${num(FREE_SERIES)} series. Uptrace's FAQ states the allowance in timeseries, and bills metrics in data points.`,
      );
      if (w.metrics.intervalSeconds < MIN_INTERVAL_SECONDS) {
        assumptions.push(
          `Uptrace's shortest supported metric interval is ${MIN_INTERVAL_SECONDS} seconds. The workload's ${num(w.metrics.intervalSeconds)}-second interval is priced as sent.`,
        );
      }
    }
    if (lines.some((l) => l.rateId === "cold-gb" || l.rateId === "cold-series")) {
      assumptions.push(
        `Cold storage uses the rates in Uptrace's FAQ, ${usdRate(bill.usd("cold-gb"))} per GB-month and ${usdRate(bill.usd("cold-series"))} per 1,000 timeseries-months, on the volume older than ${INCLUDED_DAYS} days. The calculator on the same page shows higher extended retention amounts and does not state how it computes them.`,
      );
    }

    return {
      lines,
      kept,
      assumptions,
      included: [
        `${INCLUDED_DAYS} days of retention for every signal`,
        "Unlimited users, services and hosts",
        "Queries, dashboards and alerts, with no query or seat charges",
      ],
      notIncluded: [
        "Data transfer fees from your cloud provider for sending telemetry to Uptrace, which runs in Hetzner data centers in Germany",
        "Deployments on AWS or Google Cloud, which Uptrace says cost more per unit and does not price publicly",
      ],
      notes: [
        "A comparison article on Uptrace's site describes each volume tier as a base price that includes a data point allowance. The pricing page's calculator bills data points separately. This estimate follows the pricing page.",
        "Metrics bill per data point, so halving the export interval doubles the metrics bill.",
        `Uptrace can sample on its side and bills the data it drops at ${usdRate(bill.usd("dropped-gb"))} per GB. The estimate prices everything sent as kept.`,
        "Uptrace publishes pay-as-you-go prices only, with no annual plan, so both billing terms give the same price.",
        "Uptrace Cloud stores data in Germany at one published price, so the region setting does not change the estimate.",
      ],
    };
  },
};
