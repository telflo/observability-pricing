/**
 * Grafana Cloud, Pro plan (pay as you go), on the price list for new accounts.
 *
 * A flat platform fee, then each product on a separate meter. Every meter has
 * included usage and three graduated volume bands:
 *   - metrics, per 1,000 billable series: the higher of active series and
 *     data points per minute, with one data point a minute per series included
 *   - logs and traces, per GB, on three meters each: Process, Write and Retain
 *   - Grafana users, per person who signs in during the month
 *
 * First-band rates were read from grafana.com/pricing on the checkedOn date.
 * The second and third bands, their bounds and the included usage on each
 * meter were read from the rate tables of the calculator on that page. The
 * billing rules come from Grafana's pricing-and-usage docs. The arithmetic
 * reproduces the calculator at 0% Adaptive reduction.
 *
 * Grafana's pages disagree on one rule. The calculator bills Retain on every
 * GB written at the standard 30-day retention. The billing docs word Retain
 * as a charge for data kept past the included 30 days. This adapter follows
 * the calculator and prints the size of the difference in its assumptions.
 *
 * Not charged: Kubernetes Monitoring and Application Observability host-hour
 * fees. They belong to Grafana's curated products, not to plain OTLP ingest.
 */
import { billFor, smallestCovering } from "../bill";
import type { Bill } from "../bill";
import { compact, num, usd, usdRate } from "../format";
import type { Bucket, Kept, LineItem, Rate, Source, Unpriced, VendorAdapter } from "../types";
import { SCAN_MULTIPLE } from "../units";

const sources: Source[] = [
  // Every rate and band table, the included usage and the retention per plan.
  { id: "pricing", label: "Pricing page", url: "https://grafana.com/pricing/" },
  // The calculator's rate tables: every band's bounds and rate, the included
  // usage on each meter, and that all three GB meters apply to every GB.
  {
    id: "calculator",
    label: "Pricing calculator rate tables",
    url: "https://grafana.com/mw/vendor/pricing-calculator/grafana-pricing-calculator.js",
  },
  // Marginal bands, with the 500,000-series worked example.
  {
    id: "volume-discounts",
    label: "Docs: volume discounts",
    url: "https://grafana.com/docs/grafana-cloud/platform/pricing-and-usage/volume-discounts/",
  },
  // Billable series, included data points per minute, the query allowance, OTLP.
  {
    id: "metrics-billing",
    label: "Docs: metrics billing",
    url: "https://grafana.com/docs/grafana-cloud/platform/pricing-and-usage/metrics/",
  },
  // Process, write and retain, 30-day retention increments, the query allowance.
  {
    id: "logs-billing",
    label: "Docs: logs billing",
    url: "https://grafana.com/docs/grafana-cloud/platform/pricing-and-usage/logs/",
  },
  {
    id: "traces-billing",
    label: "Docs: traces billing",
    url: "https://grafana.com/docs/grafana-cloud/platform/pricing-and-usage/traces/",
  },
  // Process, write and retain for profiles, and the 50 GB included.
  {
    id: "profiles-billing",
    label: "Docs: profiles billing",
    url: "https://grafana.com/docs/grafana-cloud/platform/pricing-and-usage/profiles/",
  },
  // Who counts as an active user.
  {
    id: "users-billing",
    label: "Docs: users billing",
    url: "https://grafana.com/docs/grafana-cloud/platform/pricing-and-usage/users/",
  },
  // Host hours apply only when the Application Observability product is used.
  {
    id: "host-hours",
    label: "Docs: Application Observability billing",
    url: "https://grafana.com/docs/grafana-cloud/platform/pricing-and-usage/application-observability/",
  },
];

/** Usage the platform fee carries each month (pricing page, Pro column). */
const INCLUDED_SERIES = 10_000;
/** Included for logs and again for traces. */
const INCLUDED_GB = 50;
const INCLUDED_USERS = 3;
/** Pro includes one data point per minute per series (metrics docs). */
const INCLUDED_POINTS_PER_MINUTE = 1;

/** Pro keeps metrics this long, and sells nothing longer or shorter. */
const METRIC_RETENTION_MONTHS = [13];
/** Logs and traces are kept at least this long on paid plans. */
const MINIMUM_RETENTION_DAYS = 30;
/** Longer retention is charged per increment of this many days (logs and traces docs). */
const RETENTION_INCREMENT_DAYS = 30;

/** Fair-use query allowances (logs and metrics docs). Past them the rate is not published. */
const LOG_QUERY_FAIR_USE_RATIO = 100;
const INCLUDED_QUERY_UNITS_PER_1K_SERIES = 20e9;
const QUERY_UNITS_PER_DATA_POINT_READ = 10;

/**
 * One step of a published band table. `upTo` is the band's upper bound on
 * the month's total usage, included usage counted; null is open-ended.
 */
interface BandPrice {
  upTo: number | null;
  usd: number;
}

/** A meter: its band table, and how to describe it in the rates table. */
interface Ladder {
  /** Band n has the rate id `${prefix}-${n}`. */
  prefix: string;
  label: string;
  /** The billing unit in Grafana's words. */
  rateUnit: string;
  /** The unit the band bounds are in. */
  boundUnit: string;
  /** What the platform fee covers on this meter. */
  includedNote: string;
  bands: BandPrice[];
  /** A further note on one band, keyed by band index. */
  bandNotes?: Record<number, string>;
}

type GbMeter = "process" | "write" | "retain";

/** Logs and traces publish the same three tables. */
const GB_BANDS: Record<GbMeter, BandPrice[]> = {
  process: [
    { upTo: 10_000, usd: 0.05 },
    { upTo: 25_000, usd: 0.046 },
    { upTo: null, usd: 0.044 },
  ],
  write: [
    { upTo: 1_000, usd: 0.4 },
    { upTo: 2_500, usd: 0.37 },
    { upTo: null, usd: 0.355 },
  ],
  retain: [
    { upTo: 5_000, usd: 0.1 },
    { upTo: 12_500, usd: 0.092 },
    { upTo: null, usd: 0.088 },
  ],
};

function gbLadders(signal: "logs" | "traces", noun: string): Ladder[] {
  const includedNote = `${INCLUDED_GB} GB a month are included with the platform fee`;
  return [
    {
      prefix: `${signal}-process`,
      label: `${noun} processing`,
      rateUnit: "GB processed",
      boundUnit: "GB",
      includedNote,
      bands: GB_BANDS.process,
    },
    {
      prefix: `${signal}-write`,
      label: `${noun} writing`,
      rateUnit: "GB written",
      boundUnit: "GB",
      includedNote,
      bands: GB_BANDS.write,
    },
    {
      prefix: `${signal}-retain`,
      label: `${noun} retention`,
      rateUnit: `GB retained, per ${RETENTION_INCREMENT_DAYS} days`,
      boundUnit: "GB",
      includedNote,
      bands: GB_BANDS.retain,
    },
  ];
}

const ladders: Ladder[] = [
  {
    prefix: "metrics",
    label: "Metrics",
    rateUnit: "1,000 billable series",
    boundUnit: "k series",
    includedNote: `${num(INCLUDED_SERIES / 1000)} k series a month are included with the platform fee`,
    // Bounds in thousands of billable series.
    bands: [
      { upTo: 100, usd: 6.5 },
      { upTo: 200, usd: 5.9 },
      { upTo: null, usd: 5.5 },
    ],
  },
  ...gbLadders("logs", "Log"),
  ...gbLadders("traces", "Trace"),
  {
    prefix: "users",
    label: "Active Grafana users",
    rateUnit: "active user",
    boundUnit: "users",
    includedNote: `${INCLUDED_USERS} users a month are included with the platform fee`,
    bands: [
      { upTo: 25, usd: 8 },
      { upTo: 50, usd: 7.25 },
      { upTo: null, usd: 6.8 },
    ],
  },
];

/** "first 100 k series", "100 to 200 k series", "above 200 k series". */
function bandRange(floor: number, upTo: number | null, unit: string): string {
  if (upTo === null) return `above ${num(floor)} ${unit}`;
  if (floor === 0) return `first ${num(upTo)} ${unit}`;
  return `${num(floor)} to ${num(upTo)} ${unit}`;
}

function ladderRates(ladder: Ladder): Rate[] {
  return ladder.bands.map((band, i): Rate => {
    const floor = i === 0 ? 0 : (ladder.bands[i - 1].upTo ?? 0);
    const notes = [i === 0 ? ladder.includedNote : undefined, ladder.bandNotes?.[i]].filter(
      (note): note is string => Boolean(note),
    );
    return {
      id: `${ladder.prefix}-${i + 1}`,
      label: `${ladder.label}, ${bandRange(floor, band.upTo, ladder.boundUnit)}`,
      usd: band.usd,
      unit: ladder.rateUnit,
      // The pricing page shows the first band; the calculator's tables hold the rest.
      sourceId: i === 0 ? "pricing" : "calculator",
      basis: "list",
      ...(notes.length > 0 ? { note: notes.join(". ") } : {}),
    };
  });
}

const rates: Rate[] = [
  {
    id: "platform-fee",
    label: "Pro plan platform fee",
    usd: 19,
    unit: "month",
    sourceId: "pricing",
    basis: "list",
    note: "Charged on top of usage. It carries the included usage on every meter",
  },
  ...ladders.flatMap(ladderRates),
  // Profiles: the pricing page prints a "starts at" rate on each meter and no
  // band table, so one rate per meter is used for all volume.
  ...(
    [
      ["process", "Profile processing", 0.05, "GB processed"],
      ["write", "Profile writing", 0.4, "GB written"],
      ["retain", "Profile retention", 0.1, `GB retained, per ${RETENTION_INCREMENT_DAYS} days`],
    ] as const
  ).map(
    ([meter, label, price, unit]): Rate => ({
      id: `profiles-${meter}`,
      label,
      usd: price,
      unit,
      sourceId: "pricing",
      basis: "starting-from",
      note: `${INCLUDED_GB} GB of profiles a month are included with the platform fee. Printed as "starts at"; no volume bands are published for profiles`,
    }),
  ),
];

interface Band {
  upTo: number | null;
  rateId: string;
}

function bandsOf(prefix: string): Band[] {
  const ladder = ladders.find((l) => l.prefix === prefix);
  if (!ladder) throw new Error(`No ladder ${prefix}`);
  return ladder.bands.map((band, i) => ({ upTo: band.upTo, rateId: `${prefix}-${i + 1}` }));
}

interface MeterArgs {
  bucket: Bucket;
  /** The charge, with no comma in it: the page groups a meter's bands by the text before ", ". */
  label: string;
  /** The month's usage on this meter, before the included usage is taken off. */
  total: number;
  /** Usage the platform fee covers. It sits at the bottom of the first band. */
  included: number;
  unit: string;
  bands: Band[];
  detail: string;
}

/** Slices smaller than this are float dust from a volume that sits on a band edge. */
const DUST = 1e-9;

/**
 * Graduated bands with included usage, the way Grafana's calculator and its
 * docs example apply them: the bands are measured on total usage, and the
 * included usage is the free bottom of the first band. One line per band
 * reached, each a quantity x a published rate.
 */
function meterLines(
  bill: Bill,
  { bucket, label, total, included, unit, bands, detail }: MeterArgs,
): LineItem[] {
  const out: LineItem[] = [];
  let floor = 0;
  for (const band of bands) {
    const ceiling = band.upTo ?? Infinity;
    const slice = Math.min(total, ceiling) - Math.max(floor, included);
    if (slice > DUST) {
      out.push(
        ...bill.line({
          bucket,
          label: `${label}, ${bandRange(floor, band.upTo, unit)}`,
          quantity: slice,
          unit,
          rateId: band.rateId,
          detail: out.length === 0 ? detail : undefined,
        }),
      );
    }
    floor = ceiling;
  }
  return out;
}

const amountOf = (items: LineItem[]): number => items.reduce((sum, item) => sum + item.amount, 0);

/** Whole 30-day increments needed to cover the retention asked for, at least one. */
function retentionIncrements(days: number): number {
  return Math.max(1, Math.ceil(days / RETENTION_INCREMENT_DAYS));
}

export const grafanaCloud: VendorAdapter = {
  id: "grafana-cloud",
  name: "Grafana Cloud",
  group: "open-source",
  plan: () => "Pro, pay as you go",
  pricingUrl: "https://grafana.com/pricing/",
  checkedOn: "2026-11-12",
  sources,
  rates,
  coverage: { logs: "priced", metrics: "priced", traces: "priced", profiles: "priced" },

  price({ w, d, s }) {
    const bill = billFor(rates);
    const lines: LineItem[] = [];
    const unpriced: Unpriced[] = [];
    const scanMultiple = SCAN_MULTIPLE[s.queryLoad];

    const series = d.metrics.activeSeries;
    const sendsMetrics = series > 0;
    const sendsLogs = d.logs.gbPerMonth > 0;
    const sendsTraces = d.traces.gbPerMonth > 0;
    const sendsProfiles = d.profiles.gbPerMonth > 0;
    const sendsAnything =
      sendsMetrics || sendsLogs || d.traces.spansPerMonth > 0 || sendsProfiles;

    // Assumption lines, gathered by topic and ordered at the end: the page
    // shows the first few, so the ones that move the total most go first.
    const gbModel: string[] = [];
    const billableSeriesRule: string[] = [];
    const retentionChoices: string[] = [];
    const queryAllowances: string[] = [];

    // ---- Logs and traces: three meters each, on the same GB ----
    const gbSignals = [
      {
        bucket: "logs" as const,
        noun: "Log",
        plural: "Logs",
        gb: d.logs.gbPerMonth,
        sized: `${num(w.logs.gbPerDay)} GB/day × 30 days = ${num(d.logs.gbPerMonth)} GB`,
        retentionDays: d.logs.retentionDays,
        searchableShare: w.logs.searchableShare,
      },
      {
        bucket: "traces" as const,
        noun: "Trace",
        plural: "Traces",
        gb: d.traces.gbPerMonth,
        sized: `${compact(d.traces.spansPerMonth)} spans × ${num(w.traces.avgSpanBytes, 0)} bytes = ${num(d.traces.gbPerMonth)} GB`,
        retentionDays: d.traces.retentionDays,
        searchableShare: w.traces.searchableShare,
      },
    ];

    let searchableShareIgnored = false;
    const kept: Kept = {};
    /** Retention lines for asks the price does not cover; they lead the assumptions. */
    const shortfalls: string[] = [];
    /** What the first 30-day increment of retention costs, across logs and traces. */
    let firstRetentionIncrementUsd = 0;

    for (const v of gbSignals) {
      if (!(v.gb > 0)) continue;

      const increments = retentionIncrements(v.retentionDays);
      const pricedDays = increments * RETENTION_INCREMENT_DAYS;
      if (pricedDays !== v.retentionDays) {
        if (v.bucket === "logs") kept.logsDays = pricedDays;
        else kept.tracesDays = pricedDays;
      }
      const less = `less ${INCLUDED_GB} GB included`;

      const retention = (count: number): LineItem[] =>
        meterLines(bill, {
          bucket: v.bucket,
          label: `${v.noun} retention for ${num(count * RETENTION_INCREMENT_DAYS, 0)} days`,
          total: v.gb * count,
          included: INCLUDED_GB,
          unit: "GB",
          bands: bandsOf(`${v.bucket}-retain`),
          detail:
            count === 1
              ? `${num(v.gb)} GB kept ${RETENTION_INCREMENT_DAYS} days, ${less}`
              : `${num(v.gb)} GB × ${count} increments of ${RETENTION_INCREMENT_DAYS} days = ${num(v.gb * count)} GB on the Retain meter, ${less}`,
        });
      const retentionLines = retention(increments);
      firstRetentionIncrementUsd += amountOf(retentionLines) - amountOf(retention(increments - 1));

      lines.push(
        ...meterLines(bill, {
          bucket: v.bucket,
          label: `${v.noun} processing`,
          total: v.gb,
          included: INCLUDED_GB,
          unit: "GB",
          bands: bandsOf(`${v.bucket}-process`),
          detail: `${v.sized}, ${less}`,
        }),
        ...meterLines(bill, {
          bucket: v.bucket,
          label: `${v.noun} writing`,
          total: v.gb,
          included: INCLUDED_GB,
          unit: "GB",
          bands: bandsOf(`${v.bucket}-write`),
          detail: `${num(v.gb)} GB written, with nothing dropped before storage, ${less}`,
        }),
        ...retentionLines,
      );

      if (v.retentionDays < MINIMUM_RETENTION_DAYS) {
        retentionChoices.push(
          `${v.plural}: ${num(v.retentionDays)} days of retention was asked for. Paid plans keep ${v.plural.toLowerCase()} at least ${MINIMUM_RETENTION_DAYS} days, so ${MINIMUM_RETENTION_DAYS} days is priced.`,
        );
      } else if (increments > 1) {
        retentionChoices.push(
          pricedDays === v.retentionDays
            ? `${v.plural}: ${num(v.retentionDays)} days of retention is priced as ${increments} ${RETENTION_INCREMENT_DAYS}-day increments. Grafana's docs charge each additional ${RETENTION_INCREMENT_DAYS}-day increment per GB, and the estimate bills the Retain rate on the month's GB once per increment.`
            : `${v.plural}: ${num(v.retentionDays)} days of retention is priced as ${num(pricedDays, 0)} days, because Grafana charges longer retention in ${RETENTION_INCREMENT_DAYS}-day increments. The estimate bills the Retain rate on the month's GB once per increment.`,
        );
      }
      if (v.searchableShare < 1) searchableShareIgnored = true;
    }

    if (sendsLogs || sendsTraces) {
      const ifDocsApply =
        firstRetentionIncrementUsd > 0
          ? ` Under that wording the first ${RETENTION_INCREMENT_DAYS}-day increment is free and the bill is ${usd(firstRetentionIncrementUsd)} a month lower than this estimate.`
          : "";
      gbModel.push(
        `Process, Write and Retain are each billed on every GB above the ${INCLUDED_GB} GB included per signal. This is how the calculator on Grafana's pricing page bills the standard ${MINIMUM_RETENTION_DAYS}-day retention. Grafana's billing docs word Retain as a charge for data kept past the included ${MINIMUM_RETENTION_DAYS} days.${ifDocsApply}`,
      );
    }

    // ---- Profiles: the same three GB meters, at the published first rates ----
    if (sendsProfiles) {
      const gb = d.profiles.gbPerMonth;
      const less = `less ${INCLUDED_GB} GB included`;
      const one = (meter: GbMeter, label: string, detail: string) =>
        meterLines(bill, {
          bucket: "profiles",
          label,
          total: gb,
          included: INCLUDED_GB,
          unit: "GB",
          bands: [{ upTo: null, rateId: `profiles-${meter}` }],
          detail,
        });
      lines.push(
        ...one(
          "process",
          "Profile processing",
          `${compact(d.profiles.samplesPerMonth)} samples × ${num(w.profiles.bytesPerSample, 0)} bytes = ${num(gb)} GB, ${less}`,
        ),
        ...one("write", "Profile writing", `${num(gb)} GB written, ${less}`),
        ...one(
          "retain",
          `Profile retention for ${RETENTION_INCREMENT_DAYS} days`,
          `${num(gb)} GB kept ${RETENTION_INCREMENT_DAYS} days, ${less}`,
        ),
      );
      gbModel.push(
        `Profiles are billed by GB on the same three meters as logs and traces, at the "starts at" rates on the pricing page, which prints no volume bands for profiles. Their volume is samples × the ${num(w.profiles.bytesPerSample, 0)} bytes per sample set in the workload; Grafana publishes no typical volume per host. They are kept the standard ${MINIMUM_RETENTION_DAYS} days.`,
      );
    }

    // ---- Metrics: billable series, as Grafana defines them ----
    let billableSeries = 0;
    let fasterThanIncluded = false;
    if (sendsMetrics) {
      const pointsPerMinute = d.metrics.dataPointsPerMinute / series;
      billableSeries = Math.max(series, d.metrics.dataPointsPerMinute / INCLUDED_POINTS_PER_MINUTE);
      fasterThanIncluded = pointsPerMinute > INCLUDED_POINTS_PER_MINUTE;
      const less = `less ${compact(INCLUDED_SERIES)} included`;
      const interval = `${num(w.metrics.intervalSeconds, 0)} s`;

      lines.push(
        ...meterLines(bill, {
          bucket: "metrics",
          label: "Metrics",
          total: billableSeries / 1000,
          included: INCLUDED_SERIES / 1000,
          unit: "k series",
          bands: bandsOf("metrics"),
          detail: fasterThanIncluded
            ? `${compact(series)} series × ${num(pointsPerMinute)} data points a minute = ${compact(billableSeries)} billable series, ${less}`
            : `${compact(series)} series, one data point every ${interval}, ${less}`,
        }),
      );

      billableSeriesRule.push(
        fasterThanIncluded
          ? `Billable series are the higher of active series and data points per minute, as Grafana defines them. Pro includes ${INCLUDED_POINTS_PER_MINUTE} data point a minute per series. At a ${interval} export interval each series sends ${num(pointsPerMinute)}, so ${compact(series)} series bill as ${compact(billableSeries)}.`
          : `Billable series are the higher of active series and data points per minute, as Grafana defines them. Pro includes ${INCLUDED_POINTS_PER_MINUTE} data point a minute per series, which a ${interval} export interval does not exceed, so the series count is billed as it is.`,
      );

      const keptMonths = smallestCovering(
        METRIC_RETENTION_MONTHS,
        (m) => m,
        d.metrics.retentionMonths,
      );
      if (d.metrics.retentionMonths !== keptMonths) kept.metricsMonths = keptMonths;
      if (d.metrics.retentionMonths > keptMonths) {
        shortfalls.push(
          `Metrics are kept ${keptMonths} months, shorter than the ${num(d.metrics.retentionMonths)} months asked for. Pro keeps metrics ${keptMonths} months, and longer retention is an Enterprise option priced by quote.`,
        );
      } else if (d.metrics.retentionMonths < keptMonths) {
        retentionChoices.push(
          `Metrics: Pro keeps metrics ${keptMonths} months at no extra charge. Asking for ${num(d.metrics.retentionMonths)} months does not lower the price.`,
        );
      }
    }

    // ---- Queries: free inside the fair-use allowances, unpublished past them ----
    const excessLeftOut =
      "which passes the allowance. Grafana does not publish the rate for the excess, so it is left out.";
    if (sendsLogs) {
      const over = scanMultiple > LOG_QUERY_FAIR_USE_RATIO;
      queryAllowances.push(
        `Log queries are free up to ${LOG_QUERY_FAIR_USE_RATIO} times the GB written each month. The ${s.queryLoad} query load scans ${scanMultiple} times, ${over ? excessLeftOut : "so no log query charge applies."}`,
      );
      if (over) {
        unpriced.push({
          bucket: "logs",
          reason: `Log queries past ${LOG_QUERY_FAIR_USE_RATIO} times the GB written are billed per GB queried at a rate Grafana does not publish. The ${s.queryLoad} query load set here scans ${scanMultiple} times.`,
        });
      }
    }
    if (sendsMetrics) {
      const includedUnits = (billableSeries / 1000) * INCLUDED_QUERY_UNITS_PER_1K_SERIES;
      const includedReads =
        includedUnits / (QUERY_UNITS_PER_DATA_POINT_READ * d.metrics.dataPointsPerMonth);
      const over = scanMultiple > includedReads;
      queryAllowances.push(
        `Metric queries are free up to ${num(INCLUDED_QUERY_UNITS_PER_1K_SERIES / 1e9)} billion query units per 1,000 billable series each month, at ${QUERY_UNITS_PER_DATA_POINT_READ} units per data point read. That covers about ${num(includedReads, 0)} reads of every data point. The ${s.queryLoad} query load makes ${scanMultiple}, ${over ? excessLeftOut : "so no metric query charge applies."}`,
      );
      if (over) {
        unpriced.push({
          bucket: "metrics",
          reason: `Metric queries past the fair-use allowance are billed per billion query units at a rate Grafana does not publish. The ${s.queryLoad} query load set here reads each data point ${scanMultiple} times a month, and the allowance covers about ${num(includedReads, 0)}.`,
        });
      }
    }

    // ---- The platform fee and seats: once, whatever mix of signals is sent ----
    if (sendsAnything) {
      lines.push(
        ...bill.line({
          bucket: "platform",
          label: "Pro plan platform fee",
          quantity: 1,
          unit: "month",
          rateId: "platform-fee",
          detail: `Flat monthly fee. It carries the included usage: ${compact(INCLUDED_SERIES)} metric series, ${INCLUDED_GB} GB of logs, ${INCLUDED_GB} GB of traces, ${INCLUDED_GB} GB of profiles and ${INCLUDED_USERS} users`,
        }),
        ...meterLines(bill, {
          bucket: "platform",
          label: "Active Grafana users",
          total: d.users,
          included: INCLUDED_USERS,
          unit: "users",
          bands: bandsOf("users"),
          detail: `${num(d.users)} people sign in each month, less ${INCLUDED_USERS} included`,
        }),
      );
    }

    const assumptions: string[] = [
      ...shortfalls,
      ...gbModel,
      // A multiplier on the metrics bill when it applies, a formality when it does not.
      ...(fasterThanIncluded ? billableSeriesRule : []),
      ...retentionChoices,
      ...(sendsAnything
        ? [
            "No Kubernetes Monitoring or Application Observability fees are added. Grafana charges those per host hour only when its curated products are used. Telemetry sent over OTLP from an OpenTelemetry Collector into your dashboards is billed as metrics, logs and traces alone.",
          ]
        : []),
      ...(fasterThanIncluded ? [] : billableSeriesRule),
      ...(sendsAnything
        ? [
            "No Adaptive Metrics, Adaptive Logs or Adaptive Traces reduction is applied. Every series is billed, and every GB sent is billed as processed, written and retained.",
          ]
        : []),
      ...(sendsLogs || sendsTraces
        ? [
            "Grafana bills logs and traces by the GB and does not publish how OTLP bytes are counted. The estimate uses the uncompressed size as sent, with a GB as 10^9 bytes.",
          ]
        : []),
      ...(sendsMetrics
        ? [
            "The series count is taken as the Prometheus series Grafana stores after it translates OTLP metrics, at steady usage. Grafana states that series sent over OTLP cost no more than other series, and it bills the 95th percentile of the month.",
          ]
        : []),
      ...queryAllowances,
      ...(searchableShareIgnored
        ? [
            "Grafana Cloud has one storage tier for logs and traces, so everything written stays searchable and the searchable share is not used.",
          ]
        : []),
      ...(sendsMetrics
        ? [
            "Grafana bills host, container and application series at the same rate on this path, so the host share does not change the estimate.",
          ]
        : []),
    ];

    return {
      lines,
      ...(Object.keys(kept).length > 0 ? { kept } : {}),
      assumptions,
      included: [
        `${compact(INCLUDED_SERIES)} billable metric series, ${INCLUDED_GB} GB of logs, ${INCLUDED_GB} GB of traces and ${INCLUDED_USERS} active users each month, carried by the platform fee`,
        `${METRIC_RETENTION_MONTHS[0]} months of metric retention`,
        "Queries inside the fair-use allowances for logs and metrics",
        "Dashboards and alerting for the users billed above",
      ],
      notIncluded: [
        "Query usage past the fair-use allowances, which Grafana bills at rates it does not publish",
        "Kubernetes Monitoring and Application Observability, which add host-hour and container-hour fees on top of the telemetry when those products are used",
        "Frontend sessions, synthetic checks, load tests, incident management, Grafana Assistant and Enterprise plugins, each billed on a separate meter",
        "Enterprise plan rates, premium support and custom retention, which are priced by quote",
      ],
      notes: [
        `Pro is billed monthly as a ${usdRate(bill.usd("platform-fee"))} platform fee plus usage. Grafana publishes no annual rate for Pro, so both billing terms give the same price here.`,
        "Metrics bill on the higher of active series and data points per minute, so exporting every 30 s instead of every 60 s doubles the billable series.",
        `At the first band a GB of logs or traces pays three rates: ${usdRate(bill.usd("logs-process-1"))} to process, ${usdRate(bill.usd("logs-write-1"))} to write and ${usdRate(bill.usd("logs-retain-1"))} to retain for ${RETENTION_INCREMENT_DAYS} days.`,
        "Every meter has graduated volume bands that reset each month. Crossing a band changes the rate only for the usage above it.",
        "Adaptive Logs and Adaptive Traces can cut what is written and retained, but the data they drop still pays the Process rate. Adaptive Metrics can lower the billable series.",
        `Keeping logs or traces past ${MINIMUM_RETENTION_DAYS} days is arranged through Grafana Support and charged in ${RETENTION_INCREMENT_DAYS}-day increments.`,
        "Anyone who signs in during the month counts as an active user. The estimate bills the people entered as needing full access, so read-only users who sign in would add to it.",
        "Grafana publishes one price list for every region, so the region setting does not change the estimate.",
        "Grafana's calculator stops at 500,000 series, 50,000 GB a month of logs or traces and 100 users, and asks larger accounts to contact Grafana. Above those amounts the estimate keeps the last published band rate.",
      ],
      ...(unpriced.length > 0 ? { unpriced } : {}),
    };
  },
};
