/**
 * Elastic Cloud Serverless, Observability Complete tier.
 *
 * Two meters, both in GB: data ingested during the month and data retained
 * (GB-months). Logs and traces fill one graduated tier ladder per meter.
 * Metrics stored as time series have separate ladders at a quarter of the
 * standard rate. Elastic meters the enriched size at the end of its ingest
 * pipeline: its estimator multiplies raw log volume by about 1.66 and meters
 * metrics and traces 1:1. Rates differ by cloud region: AWS us-east-1 for
 * "us" and AWS eu-west-1 for "eu". No minimum, seat, host or query charge is
 * listed.
 *
 * Read on the checkedOn date from Elastic's pricing table (one page per
 * region), its estimator, pricing page, billing docs and metrics pricing post.
 * The estimator's outputs were reproduced to the cent with the graduated math
 * below, using its 365/12-day month in place of our 30 days.
 */
import { billFor } from "../bill";
import type { Bill, TierStep } from "../bill";
import { compact, num, usdRate } from "../format";
import type { Bucket, LineItem, Rate, Settings, Source, VendorAdapter } from "../types";
import { BUCKETS } from "../types";
import { BYTES_PER_GB, DAYS_PER_MONTH } from "../units";

/**
 * Billed GB per raw GB of logs. Elastic bills "the fully enriched normalized
 * data size at the end of the ingest pipeline" (billing docs). Its estimator
 * gives the ratio for logs: "Billing meters the enriched, indexed size, about
 * 1.66x this value", and shows 100 GB/day raw as 166 GB/day metered. The
 * tooltip on its cost breakdown adds "Metrics and traces are metered 1:1", so
 * traces carry no factor.
 */
const LOG_ENRICHMENT_FACTOR = 1.66;

/**
 * Billed bytes per metric data point. Elastic bills metrics by the GB, and its
 * metrics pricing post sizes a data point at "~450 bytes ... at ingestion
 * across OpenTelemetry and Prometheus". Its two worked examples come out
 * within 0.1% of this adapter with that figure.
 */
const BYTES_PER_DATA_POINT = 450;

/** GB of data transfer out of a project that are free each month. */
const EGRESS_FREE_GB = 50;

/** Days in the month Elastic's estimator uses: 166 GB a day shows as 5,049 GB a month. */
const ESTIMATOR_DAYS_PER_MONTH = 365 / 12;

type Region = Settings["region"];

const REGION_IDS: Region[] = ["us", "eu"];

const REGIONS: Record<Region, { code: string; place: string; sourceId: string }> = {
  us: { code: "us-east-1", place: "N. Virginia", sourceId: "table-us" },
  eu: { code: "eu-west-1", place: "Ireland", sourceId: "table-eu" },
};

const tableUrl = (regionCode: string) =>
  `https://cloud.elastic.co/cloud-pricing-table?productType=serverless&solution=observability&provider=aws&region=${regionCode}`;

const sources: Source[] = [
  {
    id: "pricing",
    label: "Pricing page",
    url: "https://www.elastic.co/pricing/serverless-observability",
  },
  {
    id: "table-us",
    label: `Pricing table: Observability, AWS ${REGIONS.us.code}`,
    url: tableUrl(REGIONS.us.code),
  },
  {
    id: "table-eu",
    label: `Pricing table: Observability, AWS ${REGIONS.eu.code}`,
    url: tableUrl(REGIONS.eu.code),
  },
  {
    id: "estimator",
    label: "Pricing estimator",
    url: "https://cloud.elastic.co/pricing/serverless?s=observability",
  },
  {
    id: "billing",
    label: "Docs: Observability billing dimensions",
    url: "https://www.elastic.co/docs/deploy-manage/cloud-organization/billing/elastic-observability-billing-dimensions",
  },
  {
    id: "billing-models",
    label: "Docs: billing models",
    url: "https://www.elastic.co/docs/deploy-manage/cloud-organization/billing/billing-models",
  },
  {
    id: "metrics-pricing",
    label: "Blog: metrics pricing",
    url: "https://www.elastic.co/blog/metrics-pricing",
  },
  {
    id: "otel-streams",
    label: "Docs: OpenTelemetry data streams",
    url: "https://www.elastic.co/docs/reference/opentelemetry/data-streams",
  },
  {
    id: "apm-connector",
    label: "Docs: Elastic APM connector",
    url: "https://www.elastic.co/docs/reference/edot-collector/components/elasticapmconnector",
  },
];

/** Upper edges of the volume tiers, in GB. The last tier has no upper edge. */
const INGEST_EDGES = [1_500, 3_000, 6_000, 15_000, 30_000, 60_000, 150_000];
const RETENTION_EDGES = [10_000, 20_000, 50_000, 100_000, 250_000, 1_000_000, 2_500_000];

type LadderId = "ingest" | "retention" | "metrics-ingest" | "metrics-retention";

const LADDER_IDS: LadderId[] = ["ingest", "retention", "metrics-ingest", "metrics-retention"];

interface Ladder {
  /** What the ladder prices, for the rate labels. */
  label: string;
  /** The billing unit in Elastic's words. */
  unit: string;
  /** The unit the tier ranges are counted in. */
  rangeUnit: string;
  edges: number[];
  note?: string;
  /** One price per tier: edges.length + 1 of them, top tier first. */
  usd: Record<Region, number[]>;
}

const LADDERS: Record<LadderId, Ladder> = {
  ingest: {
    label: "Ingest, logs and traces",
    unit: "GB ingested",
    rangeUnit: "GB a month",
    edges: INGEST_EDGES,
    usd: {
      us: [0.5, 0.325, 0.225, 0.15, 0.105, 0.1, 0.095, 0.0925],
      eu: [0.55, 0.3575, 0.2475, 0.165, 0.1155, 0.11, 0.1045, 0.1018],
    },
  },
  retention: {
    label: "Retention, logs and traces",
    unit: "GB retained per month",
    rangeUnit: "GB stored",
    edges: RETENTION_EDGES,
    usd: {
      us: [0.04, 0.032, 0.03, 0.028, 0.026, 0.022, 0.02, 0.0188],
      eu: [0.044, 0.0352, 0.033, 0.0308, 0.0286, 0.0242, 0.022, 0.0207],
    },
  },
  "metrics-ingest": {
    label: "Ingest, metrics stored as time series",
    unit: "GB ingested",
    rangeUnit: "GB a month",
    edges: INGEST_EDGES,
    note: "in effect since July 1, 2026",
    usd: {
      us: [0.125, 0.0813, 0.0563, 0.0375, 0.0263, 0.025, 0.0238, 0.0231],
      eu: [0.1375, 0.0894, 0.0619, 0.0413, 0.0289, 0.0275, 0.0261, 0.0254],
    },
  },
  "metrics-retention": {
    label: "Retention, metrics stored as time series",
    unit: "GB retained per month",
    rangeUnit: "GB stored",
    edges: RETENTION_EDGES,
    note: "in effect since July 1, 2026",
    usd: {
      us: [0.01, 0.008, 0.0075, 0.007, 0.0065, 0.0055, 0.005, 0.0047],
      eu: [0.011, 0.0088, 0.0083, 0.0077, 0.0072, 0.0061, 0.0055, 0.0052],
    },
  },
};

const tierRateId = (ladder: LadderId, region: Region, index: number) =>
  `${ladder}-${region}-${index + 1}`;

/** "first 1,500 GB", "1,500 to 3,000 GB" or "above 150,000 GB". */
function tierRange(edges: number[], index: number, unit: string): string {
  if (index === 0) return `first ${num(edges[0])} ${unit}`;
  if (index >= edges.length) return `above ${num(edges[edges.length - 1])} ${unit}`;
  return `${num(edges[index - 1])} to ${num(edges[index])} ${unit}`;
}

const tierRates: Rate[] = REGION_IDS.flatMap((region) =>
  LADDER_IDS.flatMap((id) => {
    const ladder = LADDERS[id];
    return ladder.usd[region].map(
      (usd, index): Rate => ({
        id: tierRateId(id, region, index),
        label: `${ladder.label}: ${tierRange(ladder.edges, index, ladder.rangeUnit)} (AWS ${REGIONS[region].code})`,
        usd,
        unit: ladder.unit,
        sourceId: REGIONS[region].sourceId,
        basis: "list",
        note: ["Observability Complete, graduated tier", ladder.note].filter(Boolean).join(", "),
      }),
    );
  }),
);

/** Published prices the estimate leaves out. Listed so the text can quote them. */
const SUPPORT_LEVELS = [
  { id: "support-base", level: "Base", subscription: "Gold", usd: 0.05 },
  { id: "support-enhanced", level: "Enhanced", subscription: "Platinum", usd: 0.1 },
  { id: "support-premium", level: "Premium", subscription: "Enterprise", usd: 0.15 },
];

const rates: Rate[] = [
  ...tierRates,
  ...SUPPORT_LEVELS.map(
    (level): Rate => ({
      id: level.id,
      label: `${level.level} support (${level.subscription} subscription)`,
      usd: level.usd,
      unit: "dollar of usage",
      sourceId: "pricing",
      basis: "list",
      note: "Charged as a share of the monthly bill. Not part of this estimate, which assumes Limited support",
    }),
  ),
  {
    id: "egress",
    label: "Data transfer out of the project",
    usd: 0.05,
    unit: "GB transferred",
    sourceId: "pricing",
    basis: "list",
    note: `After ${EGRESS_FREE_GB} GB free each month. Not part of this estimate`,
  },
];

interface LadderPart {
  bucket: Bucket;
  label: string;
  quantity: number;
  detail: string;
}

/**
 * Lines for one graduated ladder. Logs and traces fill the standard ladders
 * together: the tiers apply to their combined volume, as on Elastic's bill,
 * and each tier's slice is then split between the two by volume, so neither
 * gets the lower-priced tiers at the other's expense. A signal alone (and
 * metrics always) gets its ladder to itself.
 */
function ladderLines(
  bill: Bill,
  ladder: LadderId,
  region: Region,
  unit: string,
  parts: LadderPart[],
): LineItem[] {
  const { edges } = LADDERS[ladder];
  const tiers: TierStep[] = LADDERS[ladder].usd[region].map((_, index) => ({
    upTo: index < edges.length ? edges[index] : null,
    rateId: tierRateId(ladder, region, index),
  }));

  const active = parts.filter((part) => part.quantity > 0);
  if (active.length <= 1) {
    return active.flatMap((part) => bill.graduated({ ...part, unit, tiers }));
  }

  // The helper walks the tiers for the combined volume. Each slice is then
  // issued once per signal, still as quantity x the same published rate.
  const total = active.reduce((sum, part) => sum + part.quantity, 0);
  const slices = bill.graduated({ bucket: active[0].bucket, label: "", quantity: total, unit, tiers });
  return active.flatMap((part) => {
    const share = part.quantity / total;
    return slices.flatMap((slice, position) => {
      const index = tiers.findIndex((tier) => tier.rateId === slice.rateId);
      return bill.line({
        bucket: part.bucket,
        label: `${part.label}, ${tierRange(edges, index, unit)} (${num(share * 100, 1)}% share)`,
        quantity: slice.quantity * share,
        unit,
        rateId: slice.rateId,
        detail:
          position === 0
            ? `${part.detail}. Logs and traces are tiered together, ${num(total)} ${unit} in all, and each tier is split between them by volume`
            : undefined,
      });
    });
  });
}

export const elastic: VendorAdapter = {
  id: "elastic",
  name: "Elastic Cloud Serverless",
  group: "open-source",
  plan: (s) =>
    `Observability Complete, AWS ${REGIONS[s.region].code} (${REGIONS[s.region].place}), Limited support, pay as you go`,
  pricingUrl: "https://www.elastic.co/pricing/serverless-observability",
  checkedOn: "2026-11-12",
  sources,
  rates,
  coverage: { logs: "priced", metrics: "priced", traces: "priced", profiles: "unsupported" },
  coverageNote: {
    profiles:
      "Universal Profiling is not available on Elastic Cloud Serverless.",
  },

  price({ w, d, s }) {
    const bill = billFor(rates);
    const region = REGIONS[s.region];

    // What Elastic meters. Logs carry its enrichment factor on both meters,
    // traces are metered 1:1 and metrics are sized at its bytes per data point.
    const logIngestGb = d.logs.gbPerMonth * LOG_ENRICHMENT_FACTOR;
    const logStoredGb = d.logs.storedGb * LOG_ENRICHMENT_FACTOR;
    const traceIngestGb = d.traces.gbPerMonth;
    const traceStoredGb = d.traces.storedGb;
    const metricIngestGb = (d.metrics.dataPointsPerMonth * BYTES_PER_DATA_POINT) / BYTES_PER_GB;
    const metricStoredGb = metricIngestGb * d.metrics.retentionMonths;

    const lines: LineItem[] = [
      ...ladderLines(bill, "ingest", s.region, "GB", [
        {
          bucket: "logs",
          label: "Log ingestion",
          quantity: logIngestGb,
          detail: `${num(w.logs.gbPerDay)} GB/day × ${DAYS_PER_MONTH} days × ${LOG_ENRICHMENT_FACTOR} for enrichment = ${num(logIngestGb)} GB billed`,
        },
        {
          bucket: "traces",
          label: "Trace ingestion",
          quantity: traceIngestGb,
          detail: `${compact(d.traces.spansPerMonth)} spans × ${num(w.traces.avgSpanBytes, 0)} bytes = ${num(traceIngestGb)} GB`,
        },
      ]),
      ...ladderLines(bill, "retention", s.region, "GB stored", [
        {
          bucket: "logs",
          label: "Log retention",
          quantity: logStoredGb,
          detail: `${num(w.logs.gbPerDay)} GB/day × ${num(d.logs.retentionDays)} days kept × ${LOG_ENRICHMENT_FACTOR} for enrichment = ${num(logStoredGb)} GB stored`,
        },
        {
          bucket: "traces",
          label: "Trace retention",
          quantity: traceStoredGb,
          detail: `${num(traceIngestGb)} GB a month × ${num(d.traces.retentionDays)} days kept / ${DAYS_PER_MONTH} = ${num(traceStoredGb)} GB stored`,
        },
      ]),
      ...ladderLines(bill, "metrics-ingest", s.region, "GB", [
        {
          bucket: "metrics",
          label: "Metric ingestion",
          quantity: metricIngestGb,
          detail: `${compact(d.metrics.activeSeries)} series × one point every ${w.metrics.intervalSeconds} s = ${compact(d.metrics.dataPointsPerMonth)} data points × ${BYTES_PER_DATA_POINT} bytes = ${num(metricIngestGb)} GB`,
        },
      ]),
      ...ladderLines(bill, "metrics-retention", s.region, "GB stored", [
        {
          bucket: "metrics",
          label: "Metric retention",
          quantity: metricStoredGb,
          detail: `${num(metricIngestGb)} GB a month × ${num(d.metrics.retentionMonths)} months kept = ${num(metricStoredGb)} GB stored`,
        },
      ]),
    ];
    // Keep each signal's ingest and retention lines together (stable sort).
    lines.sort((a, b) => BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket));

    const logsSent = logIngestGb > 0;
    const tracesSent = traceIngestGb > 0;
    const metricsSent = metricIngestGb > 0;

    // The size conversions come first: they move the total the most.
    const assumptions: string[] = [];
    if (logsSent) {
      assumptions.push(
        `Logs: Elastic bills the size after its ingest pipeline has enriched the data. Its estimator puts that at about ${LOG_ENRICHMENT_FACTOR} times raw log volume, so log ingest and log retention are multiplied by ${LOG_ENRICHMENT_FACTOR}. Logs the collector has already enriched may grow by less.`,
      );
    }
    if (metricsSent) {
      assumptions.push(
        `Metrics: Elastic bills metrics by the GB. Its metrics pricing post sizes a data point at about ${BYTES_PER_DATA_POINT} bytes at ingestion for OpenTelemetry and Prometheus data. That figure is used here in place of the ${num(w.metrics.bytesPerDataPoint, 0)} bytes per data point set in this calculator.`,
      );
    }
    if (tracesSent) {
      assumptions.push(
        "Traces: Elastic's estimator says traces are metered 1:1, so spans are billed at the size sent.",
      );
    }
    if (logsSent && tracesSent) {
      assumptions.push(
        "Logs and traces are one meter at Elastic. Their volumes are added before the volume tiers apply, and each tier's cost is split between the two by volume.",
      );
    }
    if (metricsSent) {
      assumptions.push(
        "Metrics sent over OTLP are stored as time series, which Elastic's metrics rate requires. Metrics stored any other way pay the logs and traces rate.",
      );
    }
    const held: string[] = [];
    if (logsSent || tracesSent) held.push("daily volume times the days kept");
    if (metricsSent) {
      held.push(`monthly volume times the months kept${held.length > 0 ? " for metrics" : ""}`);
    }
    if (held.length > 0) {
      assumptions.push(
        `Retention is billed per GB held in the month. At steady state that is ${held.join(", or ")}.`,
      );
    }
    assumptions.push(
      s.region === "eu"
        ? `Region: AWS ${region.code} (${region.place}). Elastic prices each cloud region separately, and its Frankfurt and London regions list higher rates.`
        : `Region: AWS ${region.code} (${region.place}). Elastic prices each cloud region separately.`,
      "All telemetry goes to one Observability project. Elastic's pricing table says pricing applies per project.",
      "A GB is counted as 10^9 bytes. Elastic's pages do not say whether its GB is decimal or binary.",
    );
    if (
      (logsSent && w.logs.searchableShare < 1) ||
      (tracesSent && w.traces.searchableShare < 1)
    ) {
      assumptions.push(
        "Elastic has one storage tier and keeps everything searchable, so the searchable share is not used.",
      );
    }

    const percent = (rateId: string) => `${num(bill.usd(rateId) * 100)}%`;
    const lastTier = INGEST_EDGES.length;

    const notes: string[] = [
      `Volume tiers are graduated: each slice of the month's volume pays the rate of its tier. In this region the first ${num(INGEST_EDGES[0])} GB of logs and traces cost ${usdRate(bill.usd(tierRateId("ingest", s.region, 0)))} a GB, and only volume past ${num(INGEST_EDGES[lastTier - 1])} GB a month pays ${usdRate(bill.usd(tierRateId("ingest", s.region, lastTier)))}. The "as low as" prices on Elastic's pricing page are the last tiers.`,
    ];
    if (logsSent && !tracesSent && !metricsSent) {
      notes.push(
        "A logs-only project can use the Logs Essentials tier, which lists lower rates and fewer features. It is not modeled here.",
      );
    }
    notes.push(
      "Retention is a separate meter from day one, and none is bundled into the ingest rate. Elastic's docs say OpenTelemetry data streams have no default retention period, so data is kept and billed until you set one.",
      "Elastic sells annual prepaid credits, typically at a discount it does not publish. Both billing terms show the pay-as-you-go list price here.",
      `Elastic's estimator uses a month of about ${num(ESTIMATOR_DAYS_PER_MONTH, 1)} days. For the same inputs it counts about ${num((ESTIMATOR_DAYS_PER_MONTH / DAYS_PER_MONTH - 1) * 100, 1)}% more volume than this page's ${DAYS_PER_MONTH}-day month.`,
    );

    const notIncluded: string[] = [
      `Paid support. Base, Enhanced and Premium support add ${percent("support-base")}, ${percent("support-enhanced")} and ${percent("support-premium")} to the bill`,
    ];
    if (tracesSent) {
      notIncluded.push(
        "Aggregated metrics that Elastic's OTLP endpoint builds from traces at 1, 10 and 60 minute intervals. Their size depends on the data, and Elastic publishes no figure for it",
      );
    }
    notIncluded.push(
      `Data transfer out of the project past the free ${EGRESS_FREE_GB} GB a month, at ${usdRate(bill.usd("egress"))} per GB`,
      "Synthetic monitoring, the Elastic Managed LLM, Workflows, Agent Builder and cross-project search, which are metered add-ons",
    );

    return {
      lines,
      assumptions,
      included: [
        "Limited support, the level that comes with a Standard subscription",
        "Queries, dashboards and alerts for any number of users and hosts. Elastic lists no query, compute, seat or per-host charge for Observability projects",
        "One storage tier in which all retained data stays searchable",
        `The first ${EGRESS_FREE_GB} GB of data transfer out of the project each month`,
      ],
      notIncluded,
      notes,
    };
  },
};
