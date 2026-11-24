/**
 * Coralogix.
 *
 * Usage is billed in units at one published unit price. Logs and traces use a
 * published number of units per GB sent, set by the pipeline the data is
 * routed to. Metrics have a per-GB price with a published conversion from
 * active time series. No seats, host fees, query fees or published minimum.
 * All data is archived in the customer's bucket, which the customer pays
 * the cloud provider for.
 *
 * Routing modeled here: the searchable share of logs and traces is priced in
 * the High priority pipeline (Frequent Search), the rest in Medium priority
 * (Monitoring). Rates read from coralogix.com on the checkedOn date.
 */
import { billFor } from "../bill";
import { compact, num, usdRate } from "../format";
import type { LineItem, Rate, Source, VendorAdapter } from "../types";
import { DAYS_PER_MONTH } from "../units";

const sources: Source[] = [
  { id: "pricing", label: "Pricing page", url: "https://coralogix.com/pricing/" },
  {
    id: "usage-pricing",
    label: "Docs: usage pricing (units per GB by pipeline)",
    url: "https://coralogix.com/docs/user-guides/account-management/organization-management/usage-and-quota/how-usage-is-measured/",
  },
  {
    id: "tco-optimizer",
    label: "Docs: TCO Optimizer (what each pipeline stores and supports)",
    url: "https://coralogix.com/docs/user-guides/account-management/tco-optimizer/",
  },
  {
    id: "data-usage",
    label: "Docs: data usage (units per entity type)",
    url: "https://coralogix.com/docs/user-guides/account-management/payment-and-billing/data-usage/",
  },
  {
    id: "pay-as-you-go",
    label: "Docs: pay-as-you-go (the overage rate)",
    url: "https://coralogix.com/docs/user-guides/account-management/payment-and-billing/pay-as-you-go/",
  },
  {
    id: "metrics-engine",
    label: "Blog: new metrics engine (daily cost example)",
    url: "https://coralogix.com/blog/introducing-the-new-coralogix-metrics-engine/",
  },
  {
    id: "comparison-guide",
    label: "Guide: comparison page that calls the logs headline price blended",
    url: "https://coralogix.com/guides/coralogix-vs-splunk/",
  },
];

/** What one unit costs. Stated on the pricing page and in the usage pricing docs. */
const UNIT_USD = 1.5;

/** Units used per GB sent, by pipeline (usage pricing docs). */
const UNITS_PER_GB = {
  logs: { high: 0.75, medium: 0.32, low: 0.12, blocked: 0.08 },
  traces: { high: 0.5, medium: 0.25, low: 0.1 },
};

/**
 * Pricing page: "1GB = 750 active time series", and usage is calculated
 * daily. The metrics engine post (12 August 2026) prices "daily active
 * series" and says "every figure is a daily cost", so the rule is applied
 * per day: 750 series active in a day count as 1 GB that day.
 */
const ACTIVE_SERIES_PER_GB_A_DAY = 750;

/** Pay-as-you-go docs: usage above the daily quota bills 25% above the plan rate. */
const PAYG_PREMIUM = 0.25;

/** Pricing page FAQ: the hot index retention Coralogix advises not to exceed. */
const RECOMMENDED_HOT_DAYS = 7;

/**
 * Two other metrics figures on Coralogix's pages. They are quoted in the
 * notes next to what the pricing page rule gives. No amount is computed from
 * them.
 */
const DOCS_METRIC_GB_PER_UNIT = 30; // usage pricing docs
const POST_EXAMPLE_SERIES = 1_000_000; // metrics engine post
const POST_EXAMPLE_UNITS_A_DAY = 30; // same post, new engine row
const POST_EXAMPLE_SAVING = 0.25; // the routing saving that row assumes

/** The dollar price of a GB in a pipeline: its units per GB at the unit price. */
const perGb = (unitUsd: number, unitsPerGb: number) => usdRate(unitUsd * unitsPerGb);

function pipelineRate(id: string, label: string, unitsPerGb: number): Rate {
  return {
    id,
    label,
    usd: UNIT_USD,
    unit: "unit",
    sourceId: "usage-pricing",
    basis: "list",
    note: `1 GB sent counts as ${num(unitsPerGb)} units, which is ${perGb(UNIT_USD, unitsPerGb)} per GB`,
  };
}

const rates: Rate[] = [
  pipelineRate(
    "logs-high",
    "Logs, High priority pipeline (Frequent Search)",
    UNITS_PER_GB.logs.high,
  ),
  pipelineRate(
    "logs-medium",
    "Logs, Medium priority pipeline (Monitoring)",
    UNITS_PER_GB.logs.medium,
  ),
  pipelineRate(
    "traces-high",
    "Traces, High priority pipeline (Frequent Search)",
    UNITS_PER_GB.traces.high,
  ),
  pipelineRate(
    "traces-medium",
    "Traces, Medium priority pipeline (Monitoring)",
    UNITS_PER_GB.traces.medium,
  ),
  {
    id: "metrics-gb",
    label: "Metrics",
    usd: 0.06,
    unit: "GB",
    sourceId: "pricing",
    basis: "list",
    note: `1 GB = ${ACTIVE_SERIES_PER_GB_A_DAY} active time series, counted per day`,
  },
  {
    id: "headline-logs",
    label: "Logs, headline price on the pricing page",
    usd: 0.42,
    unit: "GB",
    sourceId: "pricing",
    basis: "list",
    note: "A blended figure that matches no single pipeline. Not used in the estimate",
  },
  {
    id: "headline-traces",
    label: "Traces, headline price on the pricing page",
    usd: 0.16,
    unit: "GB",
    sourceId: "pricing",
    basis: "list",
    note: "Matches no single pipeline in the unit table. Not used in the estimate",
  },
  {
    id: "archive-logs-traces",
    label: "Archive storage in your S3 bucket, logs and traces",
    usd: 0.003,
    unit: "GB sent",
    sourceId: "pricing",
    basis: "example",
    note: "Coralogix's estimate of the cloud provider's charge after 5x compression. Not a Coralogix charge and not in the estimate",
  },
  {
    id: "archive-metrics",
    label: "Archive storage in your S3 bucket, metrics",
    usd: 0.000033,
    unit: "GB sent",
    sourceId: "pricing",
    basis: "example",
    note: "Coralogix's estimate of the cloud provider's charge after 30x compression. Not a Coralogix charge and not in the estimate",
  },
];

/**
 * How a pipeline's units were reached: the volume, the part of it routed
 * there when the searchable share splits it, and the units per GB.
 */
function unitsDetail(
  volume: string,
  share: number,
  part: "searchable" | "not searchable",
  gb: number,
  unitsPerGb: number,
  unitUsd: number,
): string {
  const split = share < 1 ? ` × ${num(share * 100)}% ${part}` : "";
  return `${volume}${split} = ${num(gb)} GB sent, at ${num(unitsPerGb)} units per GB (${perGb(unitUsd, unitsPerGb)} per GB)`;
}

export const coralogix: VendorAdapter = {
  id: "coralogix",
  name: "Coralogix",
  group: "otel-native",
  plan: () => "Unit plan with a daily quota sized to the workload, list price",
  pricingUrl: "https://coralogix.com/pricing/",
  checkedOn: "2026-11-12",
  sources,
  rates,
  coverage: { logs: "priced", metrics: "priced", traces: "priced", profiles: "unpriced" },
  coverageNote: {
    profiles:
      "Coralogix lists CPU profiles as a data type but publishes no rate for them.",
  },

  price({ w, d }) {
    const bill = billFor(rates);
    const lines: LineItem[] = [];
    const assumptions: string[] = [];
    const notes: string[] = [];

    // Every pipeline row carries the same price: the unit.
    const unitUsd = bill.usd("logs-high");

    const logsOn = d.logs.gbPerMonth > 0;
    const tracesOn = d.traces.gbPerMonth > 0;
    const metricsOn = d.metrics.activeSeries > 0;

    const logHighGb = d.logs.searchableGbPerMonth;
    const logMediumGb = Math.max(0, d.logs.gbPerMonth - logHighGb);
    const logShare = logsOn ? logHighGb / d.logs.gbPerMonth : 1;
    const logVolume = `${num(w.logs.gbPerDay)} GB/day × ${DAYS_PER_MONTH} days`;

    lines.push(
      ...bill.line({
        bucket: "logs",
        label: "Logs indexed for fast search (Frequent Search pipeline)",
        quantity: logHighGb * UNITS_PER_GB.logs.high,
        unit: "units",
        rateId: "logs-high",
        detail: unitsDetail(
          logVolume,
          logShare,
          "searchable",
          logHighGb,
          UNITS_PER_GB.logs.high,
          unitUsd,
        ),
      }),
      ...bill.line({
        bucket: "logs",
        label: "Logs stored and queried in your bucket (Monitoring pipeline)",
        quantity: logMediumGb * UNITS_PER_GB.logs.medium,
        unit: "units",
        rateId: "logs-medium",
        detail: unitsDetail(
          logVolume,
          1 - logShare,
          "not searchable",
          logMediumGb,
          UNITS_PER_GB.logs.medium,
          unitUsd,
        ),
      }),
    );

    const traceHighGb = d.traces.searchableGbPerMonth;
    const traceMediumGb = Math.max(0, d.traces.gbPerMonth - traceHighGb);
    const traceShare = tracesOn ? traceHighGb / d.traces.gbPerMonth : 1;
    const traceVolume = `${compact(d.traces.spansPerMonth)} spans × ${num(w.traces.avgSpanBytes, 0)} bytes`;

    lines.push(
      ...bill.line({
        bucket: "traces",
        label: "Traces indexed for fast search (Frequent Search pipeline)",
        quantity: traceHighGb * UNITS_PER_GB.traces.high,
        unit: "units",
        rateId: "traces-high",
        detail: unitsDetail(
          traceVolume,
          traceShare,
          "searchable",
          traceHighGb,
          UNITS_PER_GB.traces.high,
          unitUsd,
        ),
      }),
      ...bill.line({
        bucket: "traces",
        label: "Traces stored and queried in your bucket (Monitoring pipeline)",
        quantity: traceMediumGb * UNITS_PER_GB.traces.medium,
        unit: "units",
        rateId: "traces-medium",
        detail: unitsDetail(
          traceVolume,
          1 - traceShare,
          "not searchable",
          traceMediumGb,
          UNITS_PER_GB.traces.medium,
          unitUsd,
        ),
      }),
    );

    lines.push(
      ...bill.line({
        bucket: "metrics",
        label: "Metrics, billed on active time series",
        quantity: (d.metrics.activeSeries / ACTIVE_SERIES_PER_GB_A_DAY) * DAYS_PER_MONTH,
        unit: "GB",
        rateId: "metrics-gb",
        detail: `${compact(d.metrics.activeSeries)} active series / ${ACTIVE_SERIES_PER_GB_A_DAY} series per GB a day × ${DAYS_PER_MONTH} days`,
      }),
    );

    // The receipt shows the first few entries of each list and folds the rest,
    // so both lists lead with what moves the bill most.
    const logsOrTraces = logsOn || tracesOn;
    const routed = [logsOn ? "logs" : "", tracesOn ? "traces" : ""].filter(Boolean).join(" and ");
    const allSearchable = logMediumGb === 0 && traceMediumGb === 0;
    const anySearchable = logHighGb > 0 || traceHighGb > 0;
    const retentionAsked = [
      logsOn ? `${num(d.logs.retentionDays)} days for logs` : "",
      tracesOn ? `${num(d.traces.retentionDays)} days for traces` : "",
    ]
      .filter(Boolean)
      .join(", ");

    if (logsOrTraces) {
      assumptions.push(
        allSearchable
          ? `The searchable share is 100%, so all ${routed} are priced in the High priority pipeline (Frequent Search), which indexes data in Coralogix's hot storage. A lower share moves the rest to Medium priority (Monitoring), which costs less per GB.`
          : `The searchable share of ${routed} is priced in the High priority pipeline (Frequent Search), which indexes data in Coralogix's hot storage. The rest is priced in Medium priority (Monitoring), which keeps data only in your bucket. It can still be queried there and used in alerts and dashboards, with slower queries than Frequent Search.`,
      );
    }
    if (metricsOn) {
      assumptions.push(
        `Metrics are billed on active time series. The pricing page counts ${ACTIVE_SERIES_PER_GB_A_DAY} active series as 1 GB and calculates usage daily, and Coralogix's metrics engine post prices daily active series as a daily cost. So ${ACTIVE_SERIES_PER_GB_A_DAY} series active in a day count as 1 GB that day.`,
        "Coralogix has no host fee and no separate class for custom metrics, so host, container and application series are billed the same way.",
      );
    }
    if (logsOrTraces) {
      assumptions.push(
        `Retention does not change Coralogix's unit rates. Every pipeline also writes to an archive in your bucket, which you can keep and query for as long as you choose. The retention asked for (${retentionAsked}) is met from that archive.`,
      );
      if (anySearchable) {
        assumptions.push(
          `Frequent Search data stays in Coralogix's hot index for a period chosen with the plan. Coralogix recommends ${RECOMMENDED_HOT_DAYS} days or less there, and older data is queried from the archive. Coralogix publishes no price that depends on that period.`,
        );
      }
      assumptions.push(
        "A GB is counted as 10^9 uncompressed bytes as sent over OTLP. Coralogix bills per GB sent and does not publish how that size is measured, or whether its GB is decimal or binary.",
      );
    }
    if (metricsOn) {
      assumptions.push(
        "An active series is one that received data in the last 60 minutes, however often it is sent. The export interval and the bytes per data point set in the workload do not change the metrics line. Series churn is not modeled.",
        `Metrics are stored in your bucket, so the ${num(d.metrics.retentionMonths)} months of retention asked for add no Coralogix charge.`,
      );
    }
    assumptions.push(
      "The same volume is sent every day, on a plan whose daily quota matches it.",
      "Telemetry is priced as sent over OTLP from an OpenTelemetry Collector. Coralogix publishes no separate price for OTLP and charges no host or agent fees.",
    );

    if (logsOrTraces) {
      notes.push(
        `Coralogix bills in units at ${usdRate(unitUsd)} each, and a GB of logs or traces uses a number of units set by the pipeline it is routed to. The headline prices on its pricing page, ${usdRate(bill.usd("headline-logs"))} per GB for logs and ${usdRate(bill.usd("headline-traces"))} per GB for traces, match no single pipeline. Coralogix describes the logs figure as blended. Both are below the Medium priority rates (${perGb(unitUsd, UNITS_PER_GB.logs.medium)} and ${perGb(unitUsd, UNITS_PER_GB.traces.medium)} per GB), so they are only reached when part of the data is routed below Medium priority.`,
      );
    }
    if (metricsOn) {
      notes.push(
        `Coralogix publishes three metrics figures that do not agree. Its usage pricing docs list metrics at 1 unit per ${DOCS_METRIC_GB_PER_UNIT} GB sent, which is ${usdRate(unitUsd / DOCS_METRIC_GB_PER_UNIT)} per GB. Its post on the new metrics engine prices ${num(POST_EXAMPLE_SERIES)} active series at ${POST_EXAMPLE_UNITS_A_DAY} units a day (${usdRate(POST_EXAMPLE_UNITS_A_DAY * unitUsd)}) after an assumed ${num(POST_EXAMPLE_SAVING * 100, 0)}% saving from routing. The pricing page rule used here gives ${usdRate((POST_EXAMPLE_SERIES / ACTIVE_SERIES_PER_GB_A_DAY) * bill.usd("metrics-gb"))} a day for the same series, before any saving.`,
      );
    }
    notes.push(
      `Coralogix sells plans in units and publishes one unit price, ${usdRate(unitUsd)}, with no separate annual or month-to-month rate. Both billing terms give the same price here. Its pay-as-you-go docs describe a rate for usage above the plan's daily quota.`,
      "A plan is a daily quota of units that resets at 00:00 UTC. A quiet day's unused quota does not carry over, so a workload that varies from day to day needs a larger plan than its average.",
      `When a day's usage passes the quota, Coralogix blocks new data until the reset unless pay-as-you-go is switched on. Pay-as-you-go covers up to one extra daily quota at ${num(PAYG_PREMIUM * 100, 0)}% above the plan rate, which is ${usdRate(unitUsd * (1 + PAYG_PREMIUM))} a unit.`,
    );
    if (logsOrTraces) {
      notes.push(
        `Low priority (Compliance) costs ${num(UNITS_PER_GB.logs.low)} units per GB for logs and ${num(UNITS_PER_GB.traces.low)} for traces, which is ${perGb(unitUsd, UNITS_PER_GB.logs.low)} and ${perGb(unitUsd, UNITS_PER_GB.traces.low)} per GB. Data there is queried from the archive, and Coralogix's feature table does not list alerts or dashboards for it. This estimate does not route data to it.`,
        `Data that matches no routing policy is billed as High priority. Logs that are blocked still cost ${num(UNITS_PER_GB.logs.blocked)} units per GB, which is ${perGb(unitUsd, UNITS_PER_GB.logs.blocked)} per GB.`,
        "The pricing page FAQ quotes rounded per-GB figures for logs that are slightly higher than the unit table gives. The unit table is used here.",
      );
    }
    if (metricsOn) {
      notes.push(
        "Metrics bill on active series, so a shorter export interval does not raise the metrics line.",
      );
    }
    notes.push(
      "The pricing page shows no monthly minimum. New accounts get a 14-day trial with a quota of 8 units.",
      "The pricing page gives one price list and does not vary it by region, so the region setting does not change the estimate.",
      "Queries, including queries against the archive, use no units, so the query load setting does not change the estimate.",
    );

    return {
      lines,
      assumptions,
      included: [
        "Unlimited users, hosts and sources",
        "Queries, including queries against the archive in your bucket",
        "Platform features with no feature tiers, including SSO, RBAC and audit trail",
        "Support and onboarding help",
        "Infrastructure events, which are not billed at any volume",
      ],
      notIncluded: [
        `Storage for the archive in your cloud bucket, paid to the cloud provider. Coralogix puts the S3 cost at ${usdRate(bill.usd("archive-logs-traces"))} per GB sent for logs and traces and ${usdRate(bill.usd("archive-metrics"))} per GB sent for metrics, without saying how long the data is kept.`,
        "AI features (Olly, AI evaluations and guardrails), which draw on a separate pool of AI units",
        "RUM data, session recordings and CPU profiles, which use the same daily quota. The public unit table has no rate for session recordings or CPU profiles.",
      ],
      notes,
    };
  },
};
