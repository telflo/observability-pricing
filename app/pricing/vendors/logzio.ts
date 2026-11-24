/**
 * Logz.io, consumption price list, for a plan started today.
 *
 * Logs are charged in three parts: ingestion on every GB received, indexing
 * on the GB that are indexed (which comes with 7 days of hot retention), and
 * a per-GB charge for each further day in the hot tier. Metrics bill on
 * unique time series per day and traces per GB ingested. There are no seats,
 * host fees or published minimum.
 *
 * The metrics and trace prices are the ones the pricing page shows for
 * consumption plans started from October and November 2026, printed beside
 * struck-through earlier prices. They are what a new plan pays, so the
 * estimate uses them, marked promotional. The earlier prices sit in the table
 * so the notes can quote them. No line uses them.
 *
 * The pricing page bills annually, "or monthly for 1.2x the cost" (a footnote
 * under the consumption prices; the FAQ says the same of the monthly plan),
 * so the monthly term bills from rates derived from the annual ones with that
 * published multiple. Logz.io publishes prices for the AWS US East region
 * only and says other regions cost a different amount, so the EU setting is
 * returned unpriced. Rates read from logz.io/pricing (Consumption tab), the
 * consumption-plan docs and the consumption pricing FAQ on the checkedOn date.
 */
import { billFor } from "../bill";
import { compact, num, usd, usdRate } from "../format";
import type { Kept, LineItem, Rate, Settings, Source, Unpriced, VendorAdapter } from "../types";
import { DAYS_PER_MONTH } from "../units";

const PRICING_URL = "https://logz.io/pricing/";
const DOCS = "https://docs.logz.io/docs";

const sources: Source[] = [
  { id: "pricing", label: "Pricing page (Consumption tab and FAQ)", url: PRICING_URL },
  {
    id: "consumption-docs",
    label: "Docs: consumption-based model",
    url: `${DOCS}/user-guide/admin/plans/consumption/`,
  },
  {
    id: "consumption-faq",
    label: "Consumption pricing FAQ (AWS Marketplace)",
    url: "https://logz.io/consumption-based-pricing-aws-faq/",
  },
  {
    id: "log-usage",
    label: "Docs: log data usage",
    url: `${DOCS}/user-guide/log-management/log-usage-measurement/`,
  },
  {
    id: "drop-filters",
    label: "Docs: drop filters",
    url: `${DOCS}/user-guide/data-hub/drop-filters/drop-fiters-logs/`,
  },
  {
    id: "metric-usage",
    label: "Docs: metrics account usage",
    url: `${DOCS}/user-guide/infrastructure-monitoring/metric-throttling/`,
  },
  {
    id: "metric-storage",
    label: "Docs: how metrics are stored",
    url: `${DOCS}/user-guide/Infrastructure-monitoring/introduction-to-prometheus/store-metrics/`,
  },
  {
    id: "otel",
    label: "Docs: sending OpenTelemetry data",
    url: `${DOCS}/shipping/Other/OpenTelemetry-data/`,
  },
];

/** Days of hot retention that come with log indexing, the shortest on the list (pricing page, docs). */
const INCLUDED_HOT_DAYS = 7;
/** Span retention, fixed (pricing page). */
const TRACE_RETENTION_DAYS = 10;
/** Metric retention, fixed (pricing page, docs unit price table). */
const METRIC_RETENTION_MONTHS = 18;
/** Raw metric samples are kept this long, then only downsampled summaries (metric storage docs). */
const RAW_METRIC_DAYS = 30;
/** Metrics are priced per this many unique time series per day (pricing page). */
const SERIES_PER_UNIT = 1000;
/** Data points a minute per series that the metrics price covers (pricing page: "6 DPM per time series"). */
const MAX_DPM_PER_SERIES = 6;
/** The shortest export interval that stays within it. */
const MIN_INTERVAL_SECONDS = 60 / MAX_DPM_PER_SERIES;

/** When the listed metrics and trace prices took effect for new consumption plans (pricing page). */
const METRICS_PRICE_FROM = "Oct. 1, 2026";
const TRACES_PRICE_FROM = "Nov. 1, 2026";

/** Default daily hard caps on a consumption account (consumption docs). */
const DEFAULT_DAILY_CAP = { logsGb: 300, series: 300_000, tracesGb: 150 };
/** Share of unused data that can roll over each year (consumption FAQ). */
const ROLLOVER_SHARE = 0.2;
/** Free trial length in days (pricing page). */
const TRIAL_DAYS = 14;
/**
 * Monthly billing costs this multiple of the annual price (pricing page
 * footnote "Billed annually (or monthly for 1.2x the cost)", and its FAQ:
 * "The monthly plan is 1.2x the cost of the annual plan").
 */
const MONTHLY_MULTIPLE = 1.2;
/** Use above a subscription plan's volume (pricing page FAQ). Quoted in the notes only. */
const SUBSCRIPTION_ON_DEMAND_MULTIPLE = 1.4;

// Rate notes carry no closing period: the page adds one before the source.
const NOT_USED = "Not used in the estimate";

const annualRates: Rate[] = [
  {
    id: "log-ingest",
    label: "Log ingestion",
    usd: 0.1,
    unit: "GB ingested",
    sourceId: "consumption-docs",
    basis: "list",
    note: "Billed annually. Charged on every GB received. Also in the consumption pricing FAQ",
  },
  {
    id: "log-index",
    label: `Log indexing with ${INCLUDED_HOT_DAYS} days of hot retention`,
    usd: 0.82,
    unit: "GB indexed",
    sourceId: "consumption-docs",
    basis: "list",
    note: `Billed annually. Charged on the GB that are indexed. With ingestion it makes the pricing page's price for a GB of logs kept ${INCLUDED_HOT_DAYS} days`,
  },
  {
    id: "log-hot-day",
    label: "Hot retention extension",
    usd: 0.03,
    unit: "GB per additional day",
    sourceId: "consumption-docs",
    basis: "list",
    note: `Billed annually. Also on the pricing page. Each day of hot retention past the ${INCLUDED_HOT_DAYS} that come with indexing`,
  },
  {
    id: "metric-series-day",
    label: "Metrics on new consumption plans",
    usd: 0.2,
    unit: "1,000 unique time series per day",
    sourceId: "pricing",
    basis: "promotional",
    note: `Billed annually. For consumption plans started from ${METRICS_PRICE_FROM}. Shown as 50% off beside the struck-through earlier price. Logz.io says existing plans keep their current rate. Comes with ${METRIC_RETENTION_MONTHS} months of retention at ${MAX_DPM_PER_SERIES} data points a minute per series`,
  },
  {
    id: "trace-gb",
    label: "Traces on new consumption plans",
    usd: 0.3,
    unit: "GB ingested",
    sourceId: "pricing",
    basis: "promotional",
    note: `Billed annually. For consumption plans started from ${TRACES_PRICE_FROM}. Shown as 68% off beside the struck-through earlier price. Logz.io says existing plans keep their current rate. Comes with ${TRACE_RETENTION_DAYS} days of retention`,
  },
  {
    id: "log-warm-day",
    label: "Warm retention extension",
    usd: 0.015,
    unit: "GB per additional day",
    sourceId: "pricing",
    basis: "list",
    note: NOT_USED,
  },
  {
    id: "log-cold-day",
    label: "Cold retention",
    usd: 0.001,
    unit: "GB per additional day",
    sourceId: "consumption-docs",
    basis: "list",
    note: NOT_USED,
  },
  {
    id: "metric-series-day-earlier",
    label: "Metrics on earlier consumption plans",
    usd: 0.4,
    unit: "1,000 unique time series per day",
    sourceId: "pricing",
    basis: "list",
    note: `Billed annually. Struck through on the Consumption tab. ${NOT_USED}`,
  },
  {
    id: "trace-gb-earlier",
    label: `Traces on consumption plans started before ${TRACES_PRICE_FROM}`,
    usd: 0.92,
    unit: "GB ingested",
    sourceId: "pricing",
    basis: "list",
    note: `Billed annually. Struck through on the Consumption tab. ${NOT_USED}`,
  },
];

/** The rates a line bills from. Each has a monthly-billing twin. */
const BILLED = ["log-ingest", "log-index", "log-hot-day", "metric-series-day", "trace-gb"] as const;
type BilledId = (typeof BILLED)[number];

/** Rounded to a millionth so 0.82 x 1.2 is 0.984 and not 0.98399999. */
const times = (a: number, b: number) => Math.round(a * b * 1e6) / 1e6;

const monthlyRates: Rate[] = BILLED.map((id): Rate => {
  const annual = annualRates.find((r) => r.id === id);
  if (!annual) throw new Error(`No annual rate ${id}`);
  return {
    ...annual,
    id: `${id}-monthly`,
    label: `${annual.label}, billed monthly`,
    usd: times(annual.usd, MONTHLY_MULTIPLE),
    note: `${num(MONTHLY_MULTIPLE)} times the annual ${usdRate(annual.usd)}, the monthly-billing multiple on the pricing page`,
  };
});

const rates: Rate[] = [...annualRates, ...monthlyRates];

/** The rate id a line uses for the chosen billing term. */
const rateFor = (id: BilledId, s: Settings): string => (s.term === "monthly" ? `${id}-monthly` : id);

const percent = (share: number) => `${num(share * 100)}%`;

/** "logs", "logs and traces", "logs, metrics and traces". */
const listOf = (items: string[]) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

const NO_PUBLIC_REGION_PRICE =
  "Logz.io publishes prices for its AWS US East region only. It says other regions cost a different amount and gives those prices on request.";

export const logzio: VendorAdapter = {
  id: "logzio",
  name: "Logz.io",
  group: "logs",
  plan: (s) =>
    s.region === "eu"
      ? "Consumption plan, EU region (no public price)"
      : s.term === "monthly"
        ? `New consumption plan, AWS US East, billed monthly at ${num(MONTHLY_MULTIPLE)} times the annual price`
        : "New consumption plan, AWS US East, billed annually",
  pricingUrl: PRICING_URL,
  checkedOn: "2026-11-13",
  sources,
  rates,
  coverage: { logs: "priced", metrics: "priced", traces: "priced", profiles: "unsupported" },

  price({ w, d, s }) {
    const bill = billFor(rates);
    const r = (id: BilledId) => rateFor(id, s);

    const logsOn = d.logs.gbPerMonth > 0;
    const metricsOn = d.metrics.activeSeries > 0;
    const tracesOn = d.traces.spansPerMonth > 0;

    // Other regions cost a different amount that Logz.io gives only on
    // request, so nothing sent to an EU region has a public price.
    if (s.region === "eu") {
      const unpriced: Unpriced[] = [];
      if (logsOn) unpriced.push({ bucket: "logs", reason: NO_PUBLIC_REGION_PRICE });
      if (metricsOn) unpriced.push({ bucket: "metrics", reason: NO_PUBLIC_REGION_PRICE });
      if (tracesOn) unpriced.push({ bucket: "traces", reason: NO_PUBLIC_REGION_PRICE });
      return {
        lines: [],
        assumptions: ["The EU setting is read as a Logz.io region in Europe."],
        included: [],
        notIncluded: ["The whole bill. Logz.io prices regions other than AWS US East on request."],
        notes: [
          `For reference, the US East consumption list, billed annually, is ${usdRate(bill.usd("log-ingest") + bill.usd("log-index"))} per GB of logs kept ${INCLUDED_HOT_DAYS} days, ${usdRate(bill.usd("metric-series-day"))} per ${num(SERIES_PER_UNIT)} time series per day and ${usdRate(bill.usd("trace-gb"))} per GB of traces. Set the region to US to see it applied to this workload.`,
        ],
        ...(unpriced.length > 0 ? { unpriced } : {}),
      };
    }

    const ingestUsd = bill.usd(r("log-ingest"));
    const indexUsd = bill.usd(r("log-index"));
    const hotDayUsd = bill.usd(r("log-hot-day"));
    /** A GB of logs ingested, indexed and kept the included days. */
    const keptIncludedUsd = ingestUsd + indexUsd;

    const lines: LineItem[] = [];
    const unpriced: Unpriced[] = [];
    const kept: Kept = {};

    // Logs: ingestion on everything sent, indexing and hot retention on the
    // searchable part.
    const indexedGb = d.logs.searchableGbPerMonth;
    const logShare = logsOn ? indexedGb / d.logs.gbPerMonth : 1;
    const extraHotDays = Math.max(0, d.logs.retentionDays - INCLUDED_HOT_DAYS);
    const logsKeptDays = Math.max(INCLUDED_HOT_DAYS, d.logs.retentionDays);
    if (logsOn && logsKeptDays !== d.logs.retentionDays) kept.logsDays = logsKeptDays;

    lines.push(
      ...bill.line({
        bucket: "logs",
        label: "Log ingestion",
        quantity: d.logs.gbPerMonth,
        unit: "GB",
        rateId: r("log-ingest"),
        detail: `${num(w.logs.gbPerDay)} GB/day × ${DAYS_PER_MONTH} days. Charged on all of it, indexed or not`,
      }),
      ...bill.line({
        bucket: "logs",
        label: `Log indexing with ${INCLUDED_HOT_DAYS} days of hot retention`,
        quantity: indexedGb,
        unit: "GB",
        rateId: r("log-index"),
        detail:
          logShare < 1
            ? `${num(d.logs.gbPerMonth)} GB × ${percent(logShare)} kept searchable`
            : `All ${num(d.logs.gbPerMonth)} GB are indexed`,
      }),
      ...bill.line({
        bucket: "logs",
        label: `Hot log retention past the first ${INCLUDED_HOT_DAYS} days`,
        quantity: indexedGb * extraHotDays,
        unit: "GB-days",
        rateId: r("log-hot-day"),
        detail: `${num(indexedGb)} GB indexed × ${num(extraHotDays)} more days to reach ${num(d.logs.retentionDays)}`,
      }),
    );

    // Metrics: unique time series per day. The price covers a fixed number of
    // data points a minute per series, and nothing is published past it.
    const tooFast = metricsOn && w.metrics.intervalSeconds < MIN_INTERVAL_SECONDS;
    const metricsPriced = metricsOn && !tooFast;
    const metricUnits = (d.metrics.activeSeries / SERIES_PER_UNIT) * DAYS_PER_MONTH;
    if (tooFast) {
      unpriced.push({
        bucket: "metrics",
        reason: `Logz.io's metrics price covers ${MAX_DPM_PER_SERIES} data points a minute per series, a ${num(MIN_INTERVAL_SECONDS)}-second export interval. This workload exports every ${num(w.metrics.intervalSeconds)} seconds, and Logz.io publishes no price for that rate.`,
      });
    } else {
      lines.push(
        ...bill.line({
          bucket: "metrics",
          label: `Metric time series with ${METRIC_RETENTION_MONTHS} months of retention`,
          quantity: metricUnits,
          unit: "k series-days",
          rateId: r("metric-series-day"),
          detail: `${compact(d.metrics.activeSeries)} unique series ÷ ${num(SERIES_PER_UNIT)} × ${DAYS_PER_MONTH} days`,
        }),
      );
    }
    if (metricsPriced && d.metrics.retentionMonths !== METRIC_RETENTION_MONTHS) {
      kept.metricsMonths = METRIC_RETENTION_MONTHS;
    }

    // Traces: one price per GB ingested, one fixed retention.
    lines.push(
      ...bill.line({
        bucket: "traces",
        label: `Trace ingestion with ${TRACE_RETENTION_DAYS} days of retention`,
        quantity: d.traces.gbPerMonth,
        unit: "GB",
        rateId: r("trace-gb"),
        detail: `${compact(d.traces.spansPerMonth)} spans × ${num(w.traces.avgSpanBytes, 0)} bytes`,
      }),
    );
    if (tracesOn && d.traces.retentionDays !== TRACE_RETENTION_DAYS) {
      kept.tracesDays = TRACE_RETENTION_DAYS;
    }

    // Assumptions, with the retention shortfalls first.
    const assumptions: string[] = [];
    if (tracesOn && d.traces.retentionDays > TRACE_RETENTION_DAYS) {
      assumptions.push(
        `Traces are kept ${TRACE_RETENTION_DAYS} days, shorter than the ${num(d.traces.retentionDays)} days asked for. Logz.io keeps spans for that fixed period and publishes no price for longer.`,
      );
    }
    if (metricsPriced && d.metrics.retentionMonths > METRIC_RETENTION_MONTHS) {
      assumptions.push(
        `Metrics are kept ${METRIC_RETENTION_MONTHS} months, shorter than the ${num(d.metrics.retentionMonths)} months asked for. Logz.io keeps metrics for that fixed period and publishes no price for longer.`,
      );
    }
    if (tracesOn && d.traces.retentionDays < TRACE_RETENTION_DAYS) {
      assumptions.push(
        `Traces are kept ${TRACE_RETENTION_DAYS} days, a fixed period in the trace price, longer than the ${num(d.traces.retentionDays)} days asked for.`,
      );
    }
    if (metricsPriced && d.metrics.retentionMonths < METRIC_RETENTION_MONTHS) {
      assumptions.push(
        `Metrics are kept ${METRIC_RETENTION_MONTHS} months, a fixed period in the metrics price, longer than the ${num(d.metrics.retentionMonths)} months asked for.`,
      );
    }
    if (logsOn) {
      if (d.logs.retentionDays < INCLUDED_HOT_DAYS) {
        assumptions.push(
          `Logs are kept ${INCLUDED_HOT_DAYS} days, longer than the ${num(d.logs.retentionDays)} days asked for. Indexing comes with ${INCLUDED_HOT_DAYS} days of hot retention, the shortest period on the consumption price list.`,
        );
      }
      if (logShare < 1) {
        assumptions.push(
          `${percent(logShare)} of logs is indexed and kept searchable. The rest pays the ingestion charge only. Logz.io's pages do not say whether logs removed by a drop filter pay that charge. Drop filters keep logs out of the index, so they cannot be searched and are kept only if log archiving to your storage is on.`,
        );
      }
      if (extraHotDays > 0) {
        assumptions.push(
          `The ${num(extraHotDays)} days of log retention past the ${INCLUDED_HOT_DAYS} included are priced in the hot tier.`,
        );
      }
    }
    if (tracesOn && d.traces.searchableSpansPerMonth < d.traces.spansPerMonth) {
      assumptions.push(
        "Logz.io has one trace price, so every span is indexed and the searchable share does not change the trace line.",
      );
    }
    if (logsOn) {
      assumptions.push(
        "A GB of logs is 10^9 uncompressed bytes as sent. Logz.io measures logs as received, after parsing and before indexing, and publishes no factor between that size and the bytes sent.",
      );
    }
    if (tracesOn) {
      assumptions.push(
        "A GB of traces is the span count times the average span size, at 10^9 bytes to the GB. Logz.io does not publish how it measures span size.",
      );
    }
    if (metricsPriced) {
      assumptions.push(
        `Active series are billed as Logz.io unique time series, which it measures as an hourly average. The export interval does not change the bill up to ${MAX_DPM_PER_SERIES} data points a minute per series.`,
        "Host, container and Kubernetes series are billed with the rest. Logz.io's FAQ says custom and system metrics are priced the same, and it has no per-host fee.",
        "Metrics are sent with the Collector's Prometheus remote write exporter, the path Logz.io's OpenTelemetry docs give. Logz.io publishes no other price for that path.",
      );
    }
    assumptions.push(
      "Telemetry is sent from an OpenTelemetry Collector. Logz.io lists no host, agent or per-user fee and no separate price for OpenTelemetry data.",
    );

    const notes: string[] = [];

    const termNote =
      s.term === "monthly"
        ? `Monthly billing costs ${num(MONTHLY_MULTIPLE)} times the annual price, as the pricing page states, so every rate here is the annual rate times ${num(MONTHLY_MULTIPLE)}. A GB of logs kept ${INCLUDED_HOT_DAYS} days is ${usdRate(keptIncludedUsd)} billed monthly and ${usdRate(bill.usd("log-ingest") + bill.usd("log-index"))} billed annually.`
        : `These are the annual rates. The pricing page says monthly billing costs ${num(MONTHLY_MULTIPLE)} times as much.`;
    notes.push(termNote);

    // Who gets the metrics and trace prices, and what the lines would be at
    // the struck-through prices existing plans keep (annual billing).
    const earlierMetricUsd = bill.usd("metric-series-day-earlier");
    const earlierTraceUsd = bill.usd("trace-gb-earlier");
    const metricsAtEarlier = usd(metricUnits * earlierMetricUsd);
    const tracesAtEarlier = usd(d.traces.gbPerMonth * earlierTraceUsd);
    if (metricsPriced && tracesOn) {
      notes.push(
        `The metrics price applies to consumption plans started on or after ${METRICS_PRICE_FROM}, and the trace price to those started on or after ${TRACES_PRICE_FROM}. Logz.io shows both as discounts beside the earlier ${usdRate(earlierMetricUsd)} per ${num(SERIES_PER_UNIT)} series per day and ${usdRate(earlierTraceUsd)} per GB of traces, and says existing plans keep their current rate. At the earlier annual prices the two lines would come to ${metricsAtEarlier} and ${tracesAtEarlier} a month.`,
      );
    } else if (metricsPriced) {
      notes.push(
        `The metrics price applies to consumption plans started on or after ${METRICS_PRICE_FROM}. Logz.io shows it as a discount beside the earlier ${usdRate(earlierMetricUsd)} per ${num(SERIES_PER_UNIT)} series per day, and says existing plans keep their current rate. At the earlier annual price the metrics line would come to ${metricsAtEarlier} a month.`,
      );
    } else if (tracesOn) {
      notes.push(
        `The trace price applies to consumption plans started on or after ${TRACES_PRICE_FROM}. Logz.io shows it as a discount beside the earlier ${usdRate(earlierTraceUsd)} per GB, and says existing plans keep their current rate. At the earlier annual price the trace line would come to ${tracesAtEarlier} a month.`,
      );
    }

    if (logsOn) {
      const split = `A GB of logs kept ${INCLUDED_HOT_DAYS} days costs ${usdRate(keptIncludedUsd)}: ${usdRate(ingestUsd)} to ingest and ${usdRate(indexUsd)} to index.`;
      if (extraHotDays > 0) {
        notes.push(
          `${split} Each further day in the hot tier adds ${usdRate(hotDayUsd)}, so ${num(d.logs.retentionDays)} days comes to ${usdRate(keptIncludedUsd + extraHotDays * hotDayUsd)} per GB.`,
          `The pricing page also lists a warm tier at ${usdRate(bill.usd("log-warm-day"))} and a cold tier at ${usdRate(bill.usd("log-cold-day"))} per GB per additional day, billed annually. The estimate keeps every day in the hot tier.`,
        );
      } else {
        notes.push(`${split} Each further day in the hot tier adds ${usdRate(hotDayUsd)} per GB.`);
      }
    }

    notes.push(
      "Prices are for the AWS US East region. Logz.io says other regions cost a different amount and gives those prices on request.",
    );
    notes.push(
      `Logz.io also sells subscription plans sized by daily volume, which are not modeled. Use above a subscription plan is billed at ${num(SUBSCRIPTION_ON_DEMAND_MULTIPLE)} times the plan rate.`,
    );
    notes.push(
      `A consumption plan is a budget drawn down by use. On Demand charges apply only after the whole budget is used, and up to ${percent(ROLLOVER_SHARE)} of unused data can roll over each year.`,
    );

    const overCap = [
      logsOn && d.logs.gbPerMonth / DAYS_PER_MONTH > DEFAULT_DAILY_CAP.logsGb ? "logs" : "",
      metricsOn && d.metrics.activeSeries > DEFAULT_DAILY_CAP.series ? "metrics" : "",
      tracesOn && d.traces.gbPerMonth / DAYS_PER_MONTH > DEFAULT_DAILY_CAP.tracesGb ? "traces" : "",
    ].filter(Boolean);
    notes.push(
      `Consumption accounts have default daily hard caps of ${num(DEFAULT_DAILY_CAP.logsGb)} GB of logs, ${num(DEFAULT_DAILY_CAP.series)} time series and ${num(DEFAULT_DAILY_CAP.tracesGb)} GB of traces, which Logz.io support raises on request.${
        overCap.length > 0 ? ` This workload is above the default for ${listOf(overCap)}.` : ""
      }`,
    );
    if (metricsPriced) {
      notes.push(
        `Raw metric samples are kept ${RAW_METRIC_DAYS} days. After that only downsampled summaries remain.`,
      );
    }
    notes.push(
      `Volume discounts are negotiated with Logz.io and none is applied here. New accounts get a ${TRIAL_DAYS}-day free trial.`,
    );

    const included: string[] = [];
    if (logsOn) included.push(`${INCLUDED_HOT_DAYS} days of hot log retention, in the indexing price`);
    if (metricsPriced) included.push(`${METRIC_RETENTION_MONTHS} months of metric retention`);
    if (tracesOn) included.push(`${TRACE_RETENTION_DAYS} days of trace retention`);
    included.push(
      "Search, dashboards and alerts, with no query fee listed, so the query load setting does not change the price",
      "Users, with no user limit and no seat fee listed",
    );

    const notIncluded: string[] = [];
    if (logsOn) {
      notIncluded.push(
        "Storage in your bucket if you archive logs, paid to the cloud provider",
        "The Cloud SIEM security add-on, priced per GB of logs",
      );
    }
    notIncluded.push(
      "AI agents (Agentic Observability), billed per million tokens or per agent run",
    );

    return {
      lines,
      ...(Object.keys(kept).length > 0 ? { kept } : {}),
      assumptions,
      included,
      notIncluded,
      notes,
      ...(unpriced.length > 0 ? { unpriced } : {}),
    };
  },
};
