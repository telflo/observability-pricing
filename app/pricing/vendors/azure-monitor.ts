/**
 * Azure Monitor.
 *
 * Logs and traces sent over OTLP land in a Log Analytics workspace on the
 * Analytics plan and bill per GB, pay-as-you-go or on a daily commitment tier.
 * Metrics land in an Azure Monitor workspace and bill per sample. "us" is
 * East US and "eu" is West Europe.
 *
 * The pricing page fills its prices in with JavaScript, so every number here
 * is read from Microsoft's Retail Prices API (prices.azure.com), which serves
 * the same meters. The billing rules come from the pricing page and the
 * learn.microsoft.com docs listed in `sources`.
 */
import { billFor } from "../bill";
import type { Bill } from "../bill";
import { compact, num, usdRate } from "../format";
import type { Kept, LineItem, Rate, Settings, Source, VendorAdapter } from "../types";
import { DAYS_PER_MONTH, SCAN_MULTIPLE } from "../units";

const API = "https://prices.azure.com/api/retail/prices?$filter=";

const sources: Source[] = [
  {
    id: "pricing",
    label: "Pricing page: billing rules (prices load with JavaScript)",
    url: "https://azure.microsoft.com/en-us/pricing/details/monitor/",
  },
  {
    id: "cost-logs",
    label: "Docs: Azure Monitor Logs cost calculations, including the average billed size",
    url: "https://learn.microsoft.com/en-us/azure/azure-monitor/logs/cost-logs",
  },
  {
    id: "retention",
    label: "Docs: data retention in a Log Analytics workspace",
    url: "https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure",
  },
  {
    id: "otlp",
    label: "Docs: ingest OTLP with the OpenTelemetry Collector",
    url: "https://learn.microsoft.com/en-us/azure/azure-monitor/containers/opentelemetry-protocol-ingestion",
  },
  {
    id: "metrics-workspace",
    label: "Docs: Azure Monitor workspace",
    url: "https://learn.microsoft.com/en-us/azure/azure-monitor/metrics/azure-monitor-workspace-overview",
  },
  {
    id: "api-eastus-logs",
    label: "Retail Prices API: Log Analytics meters, East US",
    url: `${API}serviceName%20eq%20%27Log%20Analytics%27%20and%20armRegionName%20eq%20%27eastus%27`,
  },
  {
    id: "api-eastus-commitment",
    label: "Retail Prices API: commitment tiers, East US",
    url: `${API}serviceName%20eq%20%27Azure%20Monitor%27%20and%20armRegionName%20eq%20%27eastus%27%20and%20contains(meterName,%27Commitment%27)`,
  },
  {
    id: "api-eastus-metrics",
    label: "Retail Prices API: metric and long-term retention meters, East US",
    url: `${API}serviceName%20eq%20%27Azure%20Monitor%27%20and%20armRegionName%20eq%20%27eastus%27%20and%20(contains(meterName,%27Metric%27)%20or%20contains(meterName,%27Archive%27))`,
  },
  {
    id: "api-westeurope-logs",
    label: "Retail Prices API: Log Analytics meters, West Europe",
    url: `${API}serviceName%20eq%20%27Log%20Analytics%27%20and%20armRegionName%20eq%20%27westeurope%27`,
  },
  {
    id: "api-westeurope-commitment",
    label: "Retail Prices API: commitment tiers, West Europe",
    url: `${API}serviceName%20eq%20%27Azure%20Monitor%27%20and%20armRegionName%20eq%20%27westeurope%27%20and%20contains(meterName,%27Commitment%27)`,
  },
  {
    id: "api-westeurope-metrics",
    label: "Retail Prices API: metric and long-term retention meters, West Europe",
    url: `${API}serviceName%20eq%20%27Azure%20Monitor%27%20and%20armRegionName%20eq%20%27westeurope%27%20and%20(contains(meterName,%27Metric%27)%20or%20contains(meterName,%27Archive%27))`,
  },
];

/**
 * Billed GB per GB sent, for logs and traces in a Log Analytics workspace.
 * Microsoft bills the size of the column values it writes, and its cost docs
 * (source "cost-logs") say: "On average across all event types, the billed
 * size is around 25 percent less than the incoming data size for Analytics
 * Logs and Basic Logs." This is that published average. Retention bills the
 * same billed size. Metrics bill per sample and carry no factor.
 */
const BILLED_SIZE_FACTOR = 0.75;
/** Analytics Logs pay-as-you-go: GB free per billing account each month. */
const FREE_GB_PER_MONTH = 5;
/** Days of analytics retention the Analytics Logs ingestion price includes. */
const INCLUDED_DAYS = 31;
/** The longest analytics (directly searchable) retention of an Analytics table, in days. */
const MAX_ANALYTICS_DAYS = 730;
/** Days a commitment tier locks for once chosen. */
const COMMITMENT_DAYS = 31;
/** Months an Azure Monitor workspace keeps metrics. Fixed, with no longer option. */
const METRIC_MONTHS = 18;
/** Metric meters are priced per this many samples. */
const SAMPLES_PER_UNIT = 1e7;
/** Active series one Azure Monitor workspace takes before a limit increase is needed. */
const WORKSPACE_SERIES_LIMIT = 1_000_000;

interface Region {
  /** Azure region id, used in rate ids. */
  key: string;
  name: string;
  /** Analytics Logs pay-as-you-go, US dollars per GB. */
  payg: number;
  /** Commitment tiers as [GB per day committed, US dollars per day]. */
  commitment: [number, number][];
  /** Analytics retention past the included days, US dollars per GB per month. */
  analyticsRetention: number;
  /** Long-term retention, US dollars per GB per month. */
  longTermRetention: number;
}

const REGIONS: Record<Settings["region"], Region> = {
  us: {
    key: "eastus",
    name: "East US",
    payg: 2.3,
    commitment: [
      [100, 196],
      [200, 368],
      [300, 540],
      [400, 704],
      [500, 865],
      [1_000, 1_700],
      [2_000, 3_320],
      [5_000, 8_050],
      [10_000, 15_640],
      [25_000, 37_950],
      [50_000, 73_600],
    ],
    analyticsRetention: 0.1,
    longTermRetention: 0.02,
  },
  eu: {
    key: "westeurope",
    name: "West Europe",
    payg: 2.99,
    commitment: [
      [100, 252.84],
      [200, 474.72],
      [300, 696.6],
      [400, 908.16],
      [500, 1_115.85],
      [1_000, 2_193],
      [2_000, 4_282.8],
      [5_000, 10_384.5],
      [10_000, 20_175.6],
      [25_000, 48_955.5],
      [50_000, 94_944],
    ],
    analyticsRetention: 0.13,
    longTermRetention: 0.026,
  },
};

const paygId = (r: Region) => `${r.key}-logs-payg`;
const tierId = (r: Region, gbPerDay: number) => `${r.key}-logs-commit-${gbPerDay}`;
const retentionId = (r: Region) => `${r.key}-retention-analytics`;
const longTermId = (r: Region) => `${r.key}-retention-long-term`;

function regionRates(r: Region): Rate[] {
  return [
    {
      id: paygId(r),
      label: `Analytics Logs ingestion, pay-as-you-go (${r.name})`,
      usd: r.payg,
      unit: "GB ingested",
      sourceId: `api-${r.key}-logs`,
      basis: "list",
      note: `Meter "Analytics Logs Data Ingestion". Logs and traces. Includes ${INCLUDED_DAYS} days of retention and queries. The first ${FREE_GB_PER_MONTH} GB per billing account each month are free`,
    },
    ...r.commitment.map(
      ([gbPerDay, usdPerDay]): Rate => ({
        id: tierId(r, gbPerDay),
        label: `Analytics Logs, ${num(gbPerDay, 0)} GB/day commitment tier (${r.name})`,
        usd: usdPerDay,
        unit: "day of the tier",
        sourceId: `api-${r.key}-commitment`,
        basis: "list",
        note: `Meter "${gbPerDay} GB Commitment Tier Capacity Reservation", per day. ${usdRate(usdPerDay / gbPerDay)} per GB. A day above ${num(gbPerDay, 0)} GB bills as a fraction of a day on the same meter. ${COMMITMENT_DAYS}-day commitment`,
      }),
    ),
    {
      id: retentionId(r),
      label: `Analytics retention beyond ${INCLUDED_DAYS} days (${r.name})`,
      usd: r.analyticsRetention,
      unit: "GB per month",
      sourceId: `api-${r.key}-logs`,
      basis: "list",
      note: `Meter "Analytics Logs Data Retention". Up to ${MAX_ANALYTICS_DAYS} days, billed daily`,
    },
    {
      id: longTermId(r),
      label: `Long-term retention (${r.name})`,
      usd: r.longTermRetention,
      unit: "GB per month",
      sourceId: `api-${r.key}-metrics`,
      basis: "list",
      note: 'Meter "Data Archive". Shown in notes only. Up to 12 years. Reading the data needs a search job or a restore',
    },
  ];
}

const rates: Rate[] = [
  ...regionRates(REGIONS.us),
  ...regionRates(REGIONS.eu),
  {
    id: "metric-samples-ingested",
    label: "Metric samples ingested",
    usd: 0.11,
    unit: "10 million samples",
    sourceId: "api-eastus-metrics",
    basis: "list",
    note: `Meter "Metric Samples Ingested". Prometheus and OpenTelemetry metrics in an Azure Monitor workspace. Includes ${METRIC_MONTHS} months of retention. West Europe lists the same price`,
  },
  {
    id: "metric-samples-processed",
    label: "Metric samples processed",
    usd: 0.05,
    unit: "10 million samples",
    sourceId: "api-eastus-metrics",
    basis: "list",
    note: 'Meter "Metric Samples Processed". Charged here on every sample ingested; see the assumptions. West Europe lists the same price',
  },
  {
    id: "metric-query-samples",
    label: "Metric samples read by queries",
    usd: 0.001,
    unit: "10 million samples",
    sourceId: "api-eastus-metrics",
    basis: "list",
    note: 'Meter "Prometheus Metrics Queries". Samples read by PromQL queries, which is also the charge for Prometheus alert rules. West Europe lists the same price',
  },
];

interface IngestPlan {
  /** GB per day committed, or null for pay-as-you-go. */
  tierGbPerDay: number | null;
  rateId: string;
  /** Monthly US dollars for log and trace ingestion on this plan. */
  monthly: number;
}

/**
 * Pay-as-you-go, or the commitment tier that costs least for this volume. A
 * tier bills each day the larger of one day of the tier and the day's usage
 * as a fraction of the tier.
 */
function pickIngestPlan(bill: Bill, region: Region, gbPerMonth: number): IngestPlan {
  const payg = paygId(region);
  let best: IngestPlan = {
    tierGbPerDay: null,
    rateId: payg,
    monthly: Math.max(0, gbPerMonth - FREE_GB_PER_MONTH) * bill.usd(payg),
  };
  const gbPerDay = gbPerMonth / DAYS_PER_MONTH;
  for (const [tierGb] of region.commitment) {
    const rateId = tierId(region, tierGb);
    const monthly = Math.max(1, gbPerDay / tierGb) * DAYS_PER_MONTH * bill.usd(rateId);
    if (monthly < best.monthly) best = { tierGbPerDay: tierGb, rateId, monthly };
  }
  return best;
}

export const azureMonitor: VendorAdapter = {
  id: "azure-monitor",
  name: "Azure Monitor",
  group: "cloud",
  plan: (s) =>
    `Analytics Logs, pay-as-you-go or a ${COMMITMENT_DAYS}-day commitment tier, ${REGIONS[s.region].name}`,
  pricingUrl: "https://azure.microsoft.com/en-us/pricing/details/monitor/",
  checkedOn: "2026-11-12",
  sources,
  rates,
  coverage: { logs: "priced", metrics: "priced", traces: "priced", profiles: "unpriced" },
  coverageNote: {
    profiles:
      "Application Insights runs a .NET profiler at no extra charge on App Service. It samples for about 30 seconds an hour rather than profiling continuously, so it is not priced as continuous profiling here.",
  },

  price({ w, d, s }) {
    const bill = billFor(rates);
    const region = REGIONS[s.region];
    const lines: LineItem[] = [];

    const logsSent = d.logs.gbPerMonth > 0;
    const tracesSent = d.traces.gbPerMonth > 0;
    const metricsSent = d.metrics.dataPointsPerMonth > 0;
    const workspaceSent = logsSent || tracesSent;
    /** The signals that land in the Log Analytics workspace, for sentences. */
    const stored = logsSent && tracesSent ? "Logs and traces" : logsSent ? "Logs" : "Traces";

    // Retention the price buys. Analytics tables include 31 days and extend to
    // 730 days of directly searchable retention.
    const logDays = Math.min(Math.max(d.logs.retentionDays, INCLUDED_DAYS), MAX_ANALYTICS_DAYS);
    const traceDays = Math.min(Math.max(d.traces.retentionDays, INCLUDED_DAYS), MAX_ANALYTICS_DAYS);
    const kept: Kept = {};
    if (logsSent) kept.logsDays = logDays;
    if (tracesSent) kept.tracesDays = traceDays;
    if (metricsSent) kept.metricsMonths = METRIC_MONTHS;

    // Shorter retention than asked goes first, so a reader sees it.
    const shorter: string[] = [];
    if (logsSent && d.logs.retentionDays > MAX_ANALYTICS_DAYS) {
      shorter.push(
        `Logs stay directly searchable for at most ${MAX_ANALYTICS_DAYS} days. The ${num(d.logs.retentionDays, 0)} days asked for are priced as ${MAX_ANALYTICS_DAYS}.`,
      );
    }
    if (tracesSent && d.traces.retentionDays > MAX_ANALYTICS_DAYS) {
      shorter.push(
        `Traces stay directly searchable for at most ${MAX_ANALYTICS_DAYS} days. The ${num(d.traces.retentionDays, 0)} days asked for are priced as ${MAX_ANALYTICS_DAYS}.`,
      );
    }
    if (metricsSent && d.metrics.retentionMonths > METRIC_MONTHS) {
      shorter.push(
        `An Azure Monitor workspace keeps metrics for at most ${METRIC_MONTHS} months. The ${num(d.metrics.retentionMonths, 0)} months asked for are kept ${METRIC_MONTHS}.`,
      );
    }

    const path = [
      "Telemetry arrives over OTLP from an OpenTelemetry Collector at Azure Monitor's ingestion endpoints.",
    ];
    if (workspaceSent) path.push(`${stored} are stored in a Log Analytics workspace and billed per GB.`);
    if (metricsSent) path.push("Metrics are stored in an Azure Monitor workspace and billed per sample.");
    const assumptions: string[] = [...shorter, path.join(" ")];

    // Logs and traces: one workspace, so one pricing tier and one free allowance.
    // Every volume from here on is the billed size.
    const logGb = d.logs.gbPerMonth * BILLED_SIZE_FACTOR;
    const traceGb = d.traces.gbPerMonth * BILLED_SIZE_FACTOR;
    const logGbPerDay = logGb / DAYS_PER_MONTH;
    const traceGbPerDay = traceGb / DAYS_PER_MONTH;
    const totalGb = logGb + traceGb;
    const totalGbPerDay = totalGb / DAYS_PER_MONTH;
    const sentLogGbPerDay = d.logs.gbPerMonth / DAYS_PER_MONTH;

    const ingest = pickIngestPlan(bill, region, totalGb);
    const logDetail = `${num(sentLogGbPerDay)} GB/day sent × ${DAYS_PER_MONTH} days × ${BILLED_SIZE_FACTOR} billed size`;
    const traceDetail = `${compact(d.traces.spansPerMonth)} spans × ${num(w.traces.avgSpanBytes, 0)} bytes × ${BILLED_SIZE_FACTOR} billed size`;

    let unusedDays = 0;
    if (ingest.tierGbPerDay === null) {
      const freeLogGb = Math.min(FREE_GB_PER_MONTH, logGb);
      const freeTraceGb = Math.min(FREE_GB_PER_MONTH - freeLogGb, traceGb);
      lines.push(
        ...bill.line({
          bucket: "logs",
          label: "Log ingestion, pay-as-you-go",
          quantity: logGb - freeLogGb,
          unit: "GB",
          rateId: ingest.rateId,
          detail: `${logDetail}, less ${num(freeLogGb)} GB free`,
        }),
        ...bill.line({
          bucket: "traces",
          label: "Trace ingestion, pay-as-you-go",
          quantity: traceGb - freeTraceGb,
          unit: "GB",
          rateId: ingest.rateId,
          detail: freeTraceGb > 0 ? `${traceDetail}, less ${num(freeTraceGb)} GB free` : traceDetail,
        }),
      );
    } else {
      const tierGb = ingest.tierGbPerDay;
      const tierName = `${num(tierGb, 0)} GB/day commitment tier`;
      const usedDays = (totalGbPerDay / tierGb) * DAYS_PER_MONTH;
      // A float residue is not an unused commitment.
      unusedDays = DAYS_PER_MONTH - usedDays > 1e-9 ? DAYS_PER_MONTH - usedDays : 0;
      lines.push(
        ...bill.line({
          bucket: "logs",
          label: `Log ingestion, ${tierName}`,
          quantity: (logGbPerDay / tierGb) * DAYS_PER_MONTH,
          unit: "tier-days",
          rateId: ingest.rateId,
          detail: `${num(logGbPerDay)} GB/day billed (${num(sentLogGbPerDay)} GB/day sent × ${BILLED_SIZE_FACTOR}) ÷ ${num(tierGb, 0)} GB × ${DAYS_PER_MONTH} days`,
        }),
        ...bill.line({
          bucket: "traces",
          label: `Trace ingestion, ${tierName}`,
          quantity: (traceGbPerDay / tierGb) * DAYS_PER_MONTH,
          unit: "tier-days",
          rateId: ingest.rateId,
          detail: `${num(traceGbPerDay)} GB/day billed (${traceDetail} a month) ÷ ${num(tierGb, 0)} GB × ${DAYS_PER_MONTH} days`,
        }),
        ...bill.line({
          bucket: "platform",
          label: `Unused part of the ${tierName}`,
          quantity: unusedDays,
          unit: "tier-days",
          rateId: ingest.rateId,
          detail: `${num(tierGb - totalGbPerDay)} GB/day unused ÷ ${num(tierGb, 0)} GB × ${DAYS_PER_MONTH} days`,
        }),
      );
    }

    // Analytics retention past the included days, on the data held at steady state.
    const extraLogDays = logsSent ? logDays - INCLUDED_DAYS : 0;
    const extraTraceDays = tracesSent ? traceDays - INCLUDED_DAYS : 0;
    lines.push(
      ...bill.line({
        bucket: "logs",
        label: `Log retention beyond ${INCLUDED_DAYS} days`,
        quantity: logGbPerDay * extraLogDays,
        unit: "GB held",
        rateId: retentionId(region),
        detail: `${num(logGbPerDay)} GB/day billed × ${num(extraLogDays, 0)} days kept after the first ${INCLUDED_DAYS}`,
      }),
      ...bill.line({
        bucket: "traces",
        label: `Trace retention beyond ${INCLUDED_DAYS} days`,
        quantity: traceGbPerDay * extraTraceDays,
        unit: "GB held",
        rateId: retentionId(region),
        detail: `${num(traceGbPerDay)} GB/day billed × ${num(extraTraceDays, 0)} days kept after the first ${INCLUDED_DAYS}`,
      }),
    );

    if (workspaceSent) {
      assumptions.push(
        `${stored} are billed at ${num(BILLED_SIZE_FACTOR * 100, 0)} percent of the bytes sent, for ingestion and retention. This uses Microsoft's published average: its cost docs say the billed size is around ${num((1 - BILLED_SIZE_FACTOR) * 100, 0)} percent less than the incoming data. That figure is an average across all event types. The real billed size of OTLP data can differ.`,
      );
      if (ingest.tierGbPerDay === null) {
        assumptions.push(
          `${stored} are priced pay-as-you-go at ${usdRate(bill.usd(ingest.rateId))} per GB. At ${num(totalGbPerDay)} GB billed a day no commitment tier costs less.`,
        );
        if (totalGb <= FREE_GB_PER_MONTH) {
          assumptions.push(
            `The ${num(totalGb)} GB billed a month fit inside the ${FREE_GB_PER_MONTH} GB free each month, so ingestion is not charged.`,
          );
        } else {
          assumptions.push(
            logsSent && tracesSent
              ? `The first ${FREE_GB_PER_MONTH} GB a month are free on pay-as-you-go, once per billing account. The allowance is taken off logs first.`
              : `The first ${FREE_GB_PER_MONTH} GB a month are free on pay-as-you-go, once per billing account.`,
          );
        }
      } else {
        assumptions.push(
          `${stored} are priced on the ${num(ingest.tierGbPerDay, 0)} GB/day commitment tier at ${usdRate(bill.usd(ingest.rateId))} a day, which is ${usdRate(bill.usd(ingest.rateId) / ingest.tierGbPerDay)} per GB against ${usdRate(bill.usd(paygId(region)))} pay-as-you-go. It is the lowest-priced of pay-as-you-go and the commitment tiers for ${num(totalGbPerDay)} GB billed a day.`,
          "The same volume is assumed every day. A commitment tier bills by the day, so a quiet day still pays one full day of the tier.",
        );
        if (unusedDays > 0) {
          assumptions.push(
            "The commitment is larger than the volume sent and still costs less than pay-as-you-go. The unused part is billed and shown as a separate line.",
          );
        }
      }
      if (logsSent && tracesSent) {
        assumptions.push("Logs and traces share one Log Analytics workspace, so they share one pricing tier.");
      }
      if (extraLogDays > 0 || extraTraceDays > 0) {
        assumptions.push("Retention is priced at steady state, with the full retention window of data in the workspace.");
      }
      if (
        (logsSent && d.logs.retentionDays < INCLUDED_DAYS) ||
        (tracesSent && d.traces.retentionDays < INCLUDED_DAYS)
      ) {
        assumptions.push(
          `The ingestion price includes ${INCLUDED_DAYS} days of retention, and Microsoft says a shorter setting does not lower the price. Data is priced as kept ${INCLUDED_DAYS} days.`,
        );
      }
      if (tracesSent && d.traces.retentionDays > INCLUDED_DAYS) {
        assumptions.push(
          `Microsoft lists 90 days of included retention for the Application Insights tables. Its docs do not say whether traces sent over OTLP get them, so ${INCLUDED_DAYS} days are taken as included.`,
        );
      }
      if (
        d.logs.searchableGbPerMonth < d.logs.gbPerMonth ||
        d.traces.searchableGbPerMonth < d.traces.gbPerMonth
      ) {
        assumptions.push(
          "Everything is stored on the Analytics plan and stays searchable. The searchable share is not used.",
        );
      }
    }

    // Metrics: per sample. Two ingestion-side meters and one query meter.
    const sampleUnits = d.metrics.dataPointsPerMonth / SAMPLES_PER_UNIT;
    const scanMultiple = SCAN_MULTIPLE[s.queryLoad];
    lines.push(
      ...bill.line({
        bucket: "metrics",
        label: "Metric samples ingested",
        quantity: sampleUnits,
        unit: "10M samples",
        rateId: "metric-samples-ingested",
        detail: `${compact(d.metrics.activeSeries)} series × one sample every ${w.metrics.intervalSeconds} s = ${compact(d.metrics.dataPointsPerMonth)} samples`,
      }),
      ...bill.line({
        bucket: "metrics",
        label: "Metric samples processed",
        quantity: sampleUnits,
        unit: "10M samples",
        rateId: "metric-samples-processed",
        detail: `The same ${compact(d.metrics.dataPointsPerMonth)} samples`,
      }),
      ...bill.line({
        bucket: "metrics",
        label: "Metric samples read by queries",
        quantity: sampleUnits * scanMultiple,
        unit: "10M samples",
        rateId: "metric-query-samples",
        detail: `${compact(d.metrics.dataPointsPerMonth)} samples ingested × ${scanMultiple} (${s.queryLoad} query load)`,
      }),
    );

    if (metricsSent) {
      assumptions.push(
        "Each active series counts as one sample per export interval. Microsoft does not say how a histogram data point is counted.",
        `Microsoft prices two meters for samples sent to an Azure Monitor workspace, samples ingested and samples processed. Its pricing page does not say which samples the second one counts. Both are charged on every sample here: together they come to ${usdRate(bill.usd("metric-samples-ingested") + bill.usd("metric-samples-processed"))} per 10 million, the price of the single "Metrics ingestion" meter that the Retail Prices API still lists.`,
        `PromQL queries bill per sample read. Samples read are taken as ${scanMultiple} times the samples ingested, the ${s.queryLoad} query load.`,
        "Azure Monitor has no per-host fee and no separate class for custom metrics, so host and application series bill the same.",
      );
    }

    const included: string[] = [];
    if (workspaceSent) {
      included.push(
        `${INCLUDED_DAYS} days of searchable retention for ${stored.toLowerCase()}`,
        "Queries on Analytics tables, with no charge for data scanned",
      );
    }
    if (metricsSent) included.push(`${METRIC_MONTHS} months of metric retention`);
    included.push("Any number of hosts and users. These meters have no per-host or per-user fee.");

    const notIncluded: string[] = [
      "Alert rules and notifications, which bill per rule, per monitored time series and per notification",
      "Network egress from wherever the Collector runs. Inbound transfer to Azure is free.",
      "Azure Managed Grafana, a separate product, if it is used for dashboards",
    ];
    if (workspaceSent) {
      notIncluded.push(
        "Search jobs, restores and data export, which bill per GB",
        "Microsoft Sentinel charges, if Sentinel is enabled on the same workspace",
      );
    }
    notIncluded.push("Enterprise Agreement and other negotiated discounts, which are not public");

    const notes: string[] = [];
    if (workspaceSent) {
      notes.push(
        `Prices are for ${region.name}. Log Analytics prices are set per Azure region and differ even between US regions.`,
        `Microsoft publishes no annual rate for Azure Monitor. A commitment tier runs for ${COMMITMENT_DAYS} days, so both billing terms use the lower of pay-as-you-go and the commitment tiers.`,
        "A commitment tier bills per workspace each day. A day above the commitment bills as a fraction of a day on the same tier.",
        `The ${FREE_GB_PER_MONTH} GB free each month apply to pay-as-you-go only and are counted once per billing account.`,
        "Microsoft says the billed size of small events can be up to 50 percent below the incoming size, so the real bill depends on the shape of the records.",
        `Past ${MAX_ANALYTICS_DAYS} days data can only move to long-term retention at ${usdRate(bill.usd(longTermId(region)))} per GB a month. Reading it back needs a search job or a restore.`,
        "The Basic and Auxiliary table plans charge less per GB to ingest and charge per GB scanned by queries. They are not modeled.",
      );
    }
    if (metricsSent) {
      notes.push(
        "The metric sample prices are the same in East US and West Europe, and the billing term does not change them.",
        "Metrics bill per sample, so halving the export interval doubles the metrics bill.",
      );
      if (d.metrics.activeSeries > WORKSPACE_SERIES_LIMIT) {
        notes.push(
          `One Azure Monitor workspace takes ${compact(WORKSPACE_SERIES_LIMIT)} active series by default. ${compact(d.metrics.activeSeries)} series need a limit increase from Microsoft support or more than one workspace.`,
        );
      }
    }

    return { lines, kept, assumptions, included, notIncluded, notes };
  },
};
