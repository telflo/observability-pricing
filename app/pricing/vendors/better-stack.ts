/**
 * Better Stack telemetry at pay-as-you-go rates.
 *
 * Logs and traces pay a per-GB ingestion price and then a per-GB price for
 * each month the data is kept. Metrics pay nothing at ingestion and a per-GB
 * price each month on the data retained. Every price is published per data
 * region. Each signal has a free allowance. Better Stack's comparison posts say
 * paid plans start at one responder license; the pricing page states no
 * minimum. Rates read from betterstack.com/pricing on the checkedOn date.
 */
import { billFor } from "../bill";
import { compact, num, usdRate } from "../format";
import type { LineItem, Rate, Settings, Source, Unpriced, VendorAdapter } from "../types";
import { DAYS_PER_MONTH } from "../units";

const sources: Source[] = [
  { id: "pricing", label: "Pricing page", url: "https://betterstack.com/pricing" },
  {
    id: "metrics-billing",
    label: "Docs: how metrics are billed",
    url: "https://betterstack.com/docs/logs/billing-for-metrics/",
  },
  {
    id: "paid-plan",
    label: "Comparison post stating that paid plans start at one responder license",
    url: "https://betterstack.com/community/comparisons/real-user-monitoring-tools/",
  },
  {
    id: "roles",
    label: "Docs: roles that use a responder license",
    url: "https://betterstack.com/docs/uptime/team-management/manage-roles/",
  },
  {
    id: "retention-example",
    label: "Comparison post with a worked ingestion and retention example",
    url: "https://betterstack.com/community/comparisons/better-stack-vs-grafana-cloud/",
  },
  {
    id: "metric-retention",
    label: "Infrastructure monitoring page (default metrics retention)",
    url: "https://betterstack.com/infrastructure-monitoring",
  },
  {
    id: "scale",
    label: "Docs: wide events and metrics (volumes to discuss with sales)",
    url: "https://betterstack.com/docs/logs/wide-events-time-series/",
  },
];

/** Free each month, for logs and again for traces: this many GB, kept this many days. */
const INCLUDED_LOG_TRACE_GB = 3;
const INCLUDED_LOG_TRACE_DAYS = 3;
/** Retained metrics that are free. */
const INCLUDED_METRIC_GB = 30;

/**
 * Figures Better Stack publishes that are quoted in the text. No amount is
 * computed from them.
 */
const DEFAULT_METRIC_RETENTION_MONTHS = 13; // "metric-retention"
const CONTACT_ABOVE_TB_PER_MONTH = 100; // "scale"

const rates: Rate[] = [
  {
    id: "ingest-us",
    label: "Logs and traces ingestion, United States",
    usd: 0.15,
    unit: "GB ingested",
    sourceId: "pricing",
    basis: "list",
  },
  {
    id: "retention-us",
    label: "Logs and traces retention, United States",
    usd: 0.08,
    unit: "GB per month",
    sourceId: "pricing",
    basis: "list",
    note: "Charged on the data kept, on top of ingestion",
  },
  {
    id: "metrics-us",
    label: "Metrics retention, United States",
    usd: 0.75,
    unit: "GB per month",
    sourceId: "pricing",
    basis: "list",
    note: "Charged on the data retained. Metrics have no ingestion charge. The metrics billing docs give the same rate for US East and US West",
  },
  {
    id: "ingest-eu",
    label: "Logs and traces ingestion, Europe",
    usd: 0.1,
    unit: "GB ingested",
    sourceId: "pricing",
    basis: "list",
  },
  {
    id: "retention-eu",
    label: "Logs and traces retention, Europe",
    usd: 0.05,
    unit: "GB per month",
    sourceId: "pricing",
    basis: "list",
    note: "Charged on the data kept, on top of ingestion",
  },
  {
    id: "metrics-eu",
    label: "Metrics retention, Europe",
    usd: 0.5,
    unit: "GB per month",
    sourceId: "pricing",
    basis: "list",
    note: "Charged on the data retained. Metrics have no ingestion charge",
  },
  {
    id: "responder-yearly",
    label: "Responder license, billed yearly",
    usd: 29,
    unit: "license per month",
    sourceId: "pricing",
    basis: "list",
    note: "Team members with telemetry access are $0",
  },
  {
    id: "responder-monthly",
    label: "Responder license, billed monthly",
    usd: 34,
    unit: "license per month",
    sourceId: "pricing",
    basis: "list",
    note: "Team members with telemetry access are $0",
  },
  {
    id: "query-boost",
    label: "Query boost (optional)",
    usd: 0.001,
    unit: "GB scanned",
    sourceId: "pricing",
    basis: "list",
    note: "Not in the estimate. Standard querying is included",
  },
];

interface RegionRates {
  name: string;
  ingest: string;
  retention: string;
  metrics: string;
}

const REGION: Record<Settings["region"], RegionRates> = {
  us: { name: "United States", ingest: "ingest-us", retention: "retention-us", metrics: "metrics-us" },
  eu: { name: "Europe", ingest: "ingest-eu", retention: "retention-eu", metrics: "metrics-eu" },
};

/** Logs and traces share one price list and one shape of bill. */
interface EventSignal {
  bucket: "logs" | "traces";
  /** "Log", for line labels. */
  noun: string;
  gbPerMonth: number;
  /** GB held once the retention period is full. */
  heldGb: number;
  retentionDays: number;
  /** How the monthly GB was reached. */
  volume: string;
  /** How the GB held was reached. */
  held: string;
  searchableShare: number;
}

/** Usage past an allowance. Float noise at the edge of an allowance is not usage. */
function past(total: number, included: number): number {
  const over = total - included;
  return over > 1e-9 ? over : 0;
}

const plural = (n: number, word: string) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;

export const betterStack: VendorAdapter = {
  id: "better-stack",
  name: "Better Stack",
  group: "logs",
  plan: (s) =>
    `Pay as you go, ${REGION[s.region].name} region, billed ${s.term === "annual" ? "yearly" : "monthly"}`,
  pricingUrl: "https://betterstack.com/pricing",
  checkedOn: "2026-11-12",
  sources,
  rates,
  // Metrics are billed on the size Better Stack stores, and it publishes no
  // size per data point. Pricing them from the size sent over OTLP could be
  // off by an order of magnitude in either direction, so they are not priced.
  coverage: { logs: "priced", metrics: "unpriced", traces: "priced", profiles: "unsupported" },

  price({ w, d, s }) {
    const bill = billFor(rates);
    const region = REGION[s.region];
    const licenseRateId = s.term === "annual" ? "responder-yearly" : "responder-monthly";
    const lines: LineItem[] = [];
    const assumptions: string[] = [];

    const events: EventSignal[] = [
      {
        bucket: "logs",
        noun: "Log",
        gbPerMonth: d.logs.gbPerMonth,
        heldGb: d.logs.storedGb,
        retentionDays: d.logs.retentionDays,
        volume: `${num(w.logs.gbPerDay)} GB/day × ${DAYS_PER_MONTH} days`,
        held: `${num(w.logs.gbPerDay)} GB/day × ${plural(d.logs.retentionDays, "day")} kept`,
        searchableShare: w.logs.searchableShare,
      },
      {
        bucket: "traces",
        noun: "Trace",
        gbPerMonth: d.traces.gbPerMonth,
        heldGb: d.traces.storedGb,
        retentionDays: d.traces.retentionDays,
        volume: `${compact(d.traces.spansPerMonth)} spans × ${num(w.traces.avgSpanBytes, 0)} bytes`,
        held: `${num(d.traces.gbPerMonth)} GB a month × ${plural(d.traces.retentionDays, "day")} kept / ${DAYS_PER_MONTH}`,
        searchableShare: w.traces.searchableShare,
      },
    ];
    const sent = events.filter((v) => v.gbPerMonth > 0);

    if (sent.length > 0) {
      assumptions.push(
        "A GB of logs or traces is counted as 10^9 uncompressed bytes as sent over OTLP. Better Stack's pricing page and docs do not say how an ingested GB is measured, so the raw size is billed.",
        `Each month the first ${INCLUDED_LOG_TRACE_GB} GB of logs and the first ${INCLUDED_LOG_TRACE_GB} GB of traces are free to ingest and free to keep for ${INCLUDED_LOG_TRACE_DAYS} days. Keeping that data longer is charged like any other data.`,
        "Retention is charged per GB per month on the data held. The estimate uses the volume held once the retention period has filled: the daily volume × the days kept.",
      );
    }

    for (const v of sent) {
      const includedGb = Math.min(v.gbPerMonth, INCLUDED_LOG_TRACE_GB);
      const includedDays = Math.min(Math.max(0, v.retentionDays), INCLUDED_LOG_TRACE_DAYS);
      // The included GB, each held for the included days, as a share of a month.
      const includedHeldGb = (includedGb * includedDays) / DAYS_PER_MONTH;

      lines.push(
        ...bill.line({
          bucket: v.bucket,
          label: `${v.noun} ingestion`,
          quantity: past(v.gbPerMonth, INCLUDED_LOG_TRACE_GB),
          unit: "GB",
          rateId: region.ingest,
          detail: `${v.volume} = ${num(v.gbPerMonth)} GB, less ${INCLUDED_LOG_TRACE_GB} GB included`,
        }),
        ...bill.line({
          bucket: v.bucket,
          label: `${v.noun} retention, ${plural(v.retentionDays, "day")}`,
          quantity: past(v.heldGb, includedHeldGb),
          unit: "GB held",
          rateId: region.retention,
          detail: `${v.held} = ${num(v.heldGb)} GB held, less ${num(includedHeldGb)} GB for the included ${num(includedGb)} GB kept ${plural(includedDays, "day")}`,
        }),
      );
    }

    const unpriced: Unpriced[] = [];
    if (d.metrics.activeSeries > 0) {
      unpriced.push({
        bucket: "metrics",
        reason: `Better Stack charges ${usdRate(bill.usd(region.metrics))} a month for each GB of metrics it holds, past ${INCLUDED_METRIC_GB} GB, measured as the size it stores. It publishes no size per data point, so that charge cannot be worked out from its public pages.`,
      });
    }

    // Anything past the free allowances needs a paid plan, and paid plans
    // start at one responder license.
    const usage = lines.reduce((sum, line) => sum + line.amount, 0);
    const paid = usage > 0;
    if (paid) {
      lines.push(
        ...bill.line({
          bucket: "platform",
          label: "Responder license",
          quantity: 1,
          unit: "license",
          rateId: licenseRateId,
          detail: "One license, the starting point of a paid plan. Team members with telemetry access are $0",
        }),
      );
      assumptions.push(
        "Better Stack's comparison posts say paid plans start at one responder license, so the estimate includes one. The pricing page states no minimum, and the roles docs list a Billing admin role that uses no license. Team members who only use telemetry are $0.",
      );
    } else {
      assumptions.push(
        "Everything sent fits the free plan's allowances, so nothing is charged. Better Stack describes that plan as free for personal projects.",
      );
    }

    if (sent.some((v) => v.searchableShare < 1)) {
      assumptions.push(
        "Better Stack has one tier for logs and traces. Everything ingested stays searchable, so the searchable share is not used.",
      );
    }

    return {
      lines,
      unpriced,
      assumptions,
      included: [
        "Standard querying, dashboards and alerts",
        "Team members with telemetry access, at $0 each",
        `${INCLUDED_LOG_TRACE_GB} GB of logs and ${INCLUDED_LOG_TRACE_GB} GB of traces a month kept ${INCLUDED_LOG_TRACE_DAYS} days, and ${INCLUDED_METRIC_GB} GB of retained metrics`,
        ...(paid
          ? ["One responder license, which gives one person incident management and on-call"]
          : []),
        "Data sent over OTLP, at the same per-GB rates, with no per-host fee",
      ],
      notIncluded: [
        paid
          ? `More responder licenses at ${usdRate(bill.usd(licenseRateId))} a month each, for anyone else who needs incidents, on-call or uptime monitoring`
          : `Responder licenses at ${usdRate(bill.usd(licenseRateId))} a month each, for anyone who needs incidents, on-call or uptime monitoring`,
        `Query boost, an optional parallel search billed at ${usdRate(bill.usd("query-boost"))} per GB scanned`,
        "Error tracking, session replay, web events, uptime monitors and status pages, which are priced separately",
        "AI SRE, which is billed per model token",
        "Add-ons such as hosting data in your bucket, single sign-on with Okta or Azure and audit logs",
        "Enterprise options such as custom cluster deployment, which are priced by quote",
      ],
      notes: [
        `Prices depend on the data region. A GB of logs or traces costs ${usdRate(bill.usd(REGION.eu.ingest))} to ingest in Europe and ${usdRate(bill.usd(REGION.us.ingest))} in the United States. Singapore costs more and is not modeled.`,
        `Logs and traces are charged at ingestion and again for retention, at ${usdRate(bill.usd(region.retention))} per GB for each month the data is kept.`,
        `Metrics are charged only while they are retained, at ${usdRate(bill.usd(region.metrics))} per GB a month. Better Stack keeps them ${DEFAULT_METRIC_RETENTION_MONTHS} months by default.`,
        `The pricing page shows one usage rate for monthly and yearly billing, so both terms use it. The responder license is ${usdRate(bill.usd("responder-monthly"))} a month billed monthly and ${usdRate(bill.usd("responder-yearly"))} billed yearly.`,
        "Better Stack also sells prepaid monthly bundles of logs, traces and metrics that cost less per GB than these rates. The estimate uses pay-as-you-go rates.",
        "Accounts and metric sources created before 2026 can still be billed per retained data point instead of per GB.",
        `Better Stack asks teams planning more than ${CONTACT_ABOVE_TB_PER_MONTH} TB a month to get in touch, and Enterprise pricing is by quote.`,
      ],
    };
  },
};
