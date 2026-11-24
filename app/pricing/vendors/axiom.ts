/**
 * Axiom Cloud, pay as you go.
 *
 * A flat platform fee plus three meters that every signal shares: data
 * loading per GB ingested and query compute per GB-hour, both on graduated
 * tiers, and storage per GB of compressed data at a rate that falls as the
 * data ages. The fee covers the first 1,000 GB of ingest, 100 GB-hours of
 * queries and 100 GB of storage each month. Metrics bill by GB like logs and
 * traces. Rates read from axiom.co/pricing and the rate card at
 * axiom.co/pricing/llms.txt on the checkedOn date.
 *
 * Three things here come from Axiom's pages rather than from the workload:
 * the size of a billed GB (its usage docs count ingest in units of 2^30
 * bytes), the query compute per GB ingested (the Low, Base and High presets
 * of the calculator on axiom.co/pricing) and the share of ingested bytes that
 * is stored (95% compression by default).
 */
import { billFor } from "../bill";
import type { Bill, TierStep } from "../bill";
import { compact, num, usdRate } from "../format";
import type { LineItem, Rate, Settings, Signal, Source, VendorAdapter } from "../types";
import { DAYS_PER_MONTH, gbToGib } from "../units";

const sources: Source[] = [
  { id: "pricing", label: "Pricing page", url: "https://axiom.co/pricing" },
  { id: "rate-card", label: "Rate card", url: "https://axiom.co/pricing/llms.txt" },
  {
    id: "terms",
    label: "Compute credit and committed use terms",
    url: "https://axiom.co/docs/legal/committed-use-terms",
  },
  {
    id: "usage",
    label: "Docs: optimize usage",
    url: "https://axiom.co/docs/reference/optimize-usage",
  },
  { id: "limits", label: "Docs: limits", url: "https://axiom.co/docs/reference/limits" },
  {
    id: "metrics",
    label: "Changelog: metrics billed per GB",
    url: "https://axiom.co/changelog/metrics-mpl",
  },
];

/** The monthly Always Free allowance on Axiom Cloud, covered by the platform fee. */
const FREE_INGEST = 1_000; // GB of data loading
const FREE_QUERY = 100; // GB-hours of query compute
const FREE_STORAGE = 100; // GB of compressed storage

/**
 * The rate card's default compression: "100 GB of raw data becomes
 * approximately 5 GB of stored data". Storage bills on the compressed size.
 */
const COMPRESSION_PERCENT = 95;
const STORED_SHARE = (100 - COMPRESSION_PERCENT) / 100;

interface QueryProfile {
  /** Axiom's name for the workload. */
  name: string;
  /**
   * GB-hours of query compute per GB ingested, from the calculator on the
   * pricing page. Its config gives each preset a ratio and the page computes
   * round(ratio x GB ingested); at 1,000 GB it shows 50, 250 and 1,500 GB-hours.
   */
  gbHoursPerGb: number;
  /** The rate card's "Query workload guidance" for the same name, quoted in the notes only. */
  rateCardGbHoursPerGb: number;
}

/**
 * Axiom's usage profiles, mapped from the query load setting. Axiom
 * publishes two sets: the calculator on axiom.co/pricing (0.05, 0.25 and 1.5
 * GB-hours per GB) and the rate card at /pricing/llms.txt (0.01, 0.40 and
 * 2.00). This adapter uses the calculator's, as the pricing page shows them.
 */
const QUERY_PROFILES: Record<Settings["queryLoad"], QueryProfile> = {
  light: { name: "Low", gbHoursPerGb: 0.05, rateCardGbHoursPerGb: 0.01 },
  typical: { name: "Base", gbHoursPerGb: 0.25, rateCardGbHoursPerGb: 0.4 },
  heavy: { name: "High", gbHoursPerGb: 1.5, rateCardGbHoursPerGb: 2 },
};

interface Tier {
  /** Where the tier starts and ends, in total monthly volume. null: no limit. */
  from: number;
  upTo: number | null;
  usd: number;
}

interface Ladder {
  id: "ingest" | "query";
  /** The unit on the bill lines. */
  unit: string;
  /** Monthly volume the platform fee covers before the first paid tier. */
  free: number;
  tiers: Tier[];
}

/** Data loading compute, graduated on the organization's monthly ingest. */
const INGEST: Ladder = {
  id: "ingest",
  unit: "GiB",
  free: FREE_INGEST,
  tiers: [
    { from: 1_000, upTo: 100_000, usd: 0.12 },
    { from: 100_000, upTo: 500_000, usd: 0.1 },
    { from: 500_000, upTo: 1_000_000, usd: 0.085 },
    { from: 1_000_000, upTo: 5_000_000, usd: 0.07 },
    { from: 5_000_000, upTo: null, usd: 0.06 },
  ],
};

/** Query compute, graduated on the organization's monthly GB-hours. */
const QUERY: Ladder = {
  id: "query",
  unit: "GB-hours",
  free: FREE_QUERY,
  tiers: [
    { from: 100, upTo: 500, usd: 0.2 },
    { from: 500, upTo: 5_000, usd: 0.16 },
    { from: 5_000, upTo: 50_000, usd: 0.12 },
    { from: 50_000, upTo: 2_500_000, usd: 0.1 },
    { from: 2_500_000, upTo: null, usd: 0.08 },
  ],
};

interface StorageBand {
  id: string;
  name: string;
  /** Data age in days where the band starts and ends. null: end of retention. */
  fromDay: number;
  untilDay: number | null;
  usd: number;
}

/** The "typical query range" the rate card's storage schedule assumes by default. */
const TYPICAL_QUERY_RANGE_DAYS = 30;

/**
 * Storage access tiers by data age, as the rate card prices them with its
 * default 30-day typical query range: data leaves Frequent Access 30 days
 * after it falls out of that range, and Infrequent Access 60 days later.
 */
const STORAGE_BANDS: StorageBand[] = [
  { id: "storage-frequent", name: "Frequent Access", fromDay: 0, untilDay: 60, usd: 0.03 },
  { id: "storage-infrequent", name: "Infrequent Access", fromDay: 60, untilDay: 120, usd: 0.0163 },
  { id: "storage-archive", name: "Archive Instant Access", fromDay: 120, untilDay: null, usd: 0.00522 },
];

/** Where the 12-month pre-purchase table starts to discount, and where it ends. */
const PREPAID_FIRST_ROW = { from: 25_000, upTo: 99_999 };
const PREPAID_LAST_ROW_FROM = 2_500_000;

/** The free Personal plan's limits, mentioned in the notes and not priced. */
const PERSONAL = { ingestGb: 500, retentionDays: 30 };

const span = (tier: Tier, unit: string) =>
  tier.upTo === null
    ? `above ${num(tier.from)} ${unit}`
    : `${num(tier.from)} to ${num(tier.upTo)} ${unit}`;

const bandAges = (band: StorageBand) =>
  band.untilDay === null
    ? `data older than ${band.fromDay} days`
    : band.fromDay === 0
      ? `data up to ${band.untilDay} days old`
      : `data ${band.fromDay} to ${band.untilDay} days old`;

const NOT_ESTIMATED = "Not part of the estimate";

const rates: Rate[] = [
  {
    id: "platform-fee",
    label: "Axiom Cloud platform fee",
    usd: 25,
    unit: "month",
    sourceId: "pricing",
    basis: "list",
    note: `Per organization. Covers the first ${num(FREE_INGEST)} GB of data loading, ${FREE_QUERY} GB-hours of query compute and ${FREE_STORAGE} GB of storage each month`,
  },
  ...INGEST.tiers.map(
    (tier, index): Rate => ({
      id: `ingest-${index + 1}`,
      label: `Data loading compute, ${span(tier, "GB")} a month`,
      usd: tier.usd,
      unit: "GB ingested",
      sourceId: "rate-card",
      basis: "list",
      note: "Graduated: the rate applies only to the volume inside this tier. Axiom's usage docs count ingest in units of 2^30 bytes (GiB)",
    }),
  ),
  ...QUERY.tiers.map(
    (tier, index): Rate => ({
      id: `query-${index + 1}`,
      label: `Query compute, ${span(tier, "GB-hours")} a month`,
      usd: tier.usd,
      unit: "GB-hour",
      sourceId: "rate-card",
      basis: "list",
      note: "Graduated: the rate applies only to the GB-hours inside this tier",
    }),
  ),
  ...STORAGE_BANDS.map(
    (band): Rate => ({
      id: band.id,
      label: `Storage, ${band.name}`,
      usd: band.usd,
      unit: "GB of compressed data per month",
      sourceId: "rate-card",
      basis: "list",
      note: `By default, ${bandAges(band)}. The first ${FREE_STORAGE} GB is free`,
    }),
  ),
  {
    id: "credit-on-demand",
    label: "Compute credit, pay as you go",
    usd: 1,
    unit: "compute credit",
    sourceId: "pricing",
    basis: "list",
    note: "Data loading and query compute are billed in credits. The per-GB and per-GB-hour rates here are already in dollars at this price",
  },
  {
    id: "credit-12mo-first",
    label: `Compute credit, 12-month pre-purchase of ${num(PREPAID_FIRST_ROW.from)} to ${num(PREPAID_FIRST_ROW.upTo)} a year`,
    usd: 0.9,
    unit: "compute credit",
    sourceId: "rate-card",
    basis: "list",
    note: NOT_ESTIMATED,
  },
  {
    id: "credit-12mo-best",
    label: `Compute credit, 12-month pre-purchase of ${num(PREPAID_LAST_ROW_FROM)} or more a year`,
    usd: 0.6,
    unit: "compute credit",
    sourceId: "rate-card",
    basis: "list",
    note: NOT_ESTIMATED,
  },
  {
    id: "addon-sso",
    label: "SAML SSO add-on",
    usd: 100,
    unit: "month",
    sourceId: "pricing",
    basis: "list",
    note: NOT_ESTIMATED,
  },
  {
    id: "addon-directory-sync",
    label: "Directory Sync add-on",
    usd: 100,
    unit: "month",
    sourceId: "pricing",
    basis: "list",
    note: NOT_ESTIMATED,
  },
  {
    id: "addon-rbac",
    label: "Role-based access control add-on",
    usd: 50,
    unit: "month",
    sourceId: "pricing",
    basis: "list",
    note: NOT_ESTIMATED,
  },
  {
    id: "addon-audit-logs",
    label: "Extended audit logs add-on",
    usd: 50,
    unit: "month",
    sourceId: "pricing",
    basis: "list",
    note: NOT_ESTIMATED,
  },
];

interface Slice {
  rateId: string;
  /** The tier's range in total monthly volume, for the label. */
  range: string;
  quantity: number;
}

/**
 * Walks a ladder for the organization's total and returns the volume that
 * lands in each paid tier. The helper is given the volume past the free
 * allowance, with every tier edge moved down by the same amount.
 */
function paidSlices(bill: Bill, ladder: Ladder, total: number): Slice[] {
  const tiers: TierStep[] = ladder.tiers.map((tier, index) => ({
    upTo: tier.upTo === null ? null : tier.upTo - ladder.free,
    rateId: `${ladder.id}-${index + 1}`,
  }));
  return bill
    .graduated({
      bucket: "platform",
      label: ladder.id,
      quantity: total - ladder.free,
      unit: ladder.unit,
      tiers,
    })
    .map((line) => {
      const index = tiers.findIndex((tier) => tier.rateId === line.rateId);
      return {
        rateId: line.rateId,
        range: span(ladder.tiers[index], ladder.unit),
        quantity: line.quantity,
      };
    });
}

interface Part {
  bucket: Signal;
  /** Starts a line label: "Log". */
  title: string;
  /** Lower-case plural for labels and text: "logs". */
  name: string;
  /** GB a month as sent (10^9 bytes). */
  gb: number;
  /** How that GB figure was reached. */
  how: string;
  /** Days the data is kept. */
  keptDays: number;
  /** The retention as the visitor set it: "30 days", "13 months, or 390 days". */
  kept: string;
}

const atLeastZero = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
const count = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;

export const axiom: VendorAdapter = {
  id: "axiom",
  name: "Axiom",
  group: "logs",
  plan: () => "Axiom Cloud, pay as you go",
  pricingUrl: "https://axiom.co/pricing",
  checkedOn: "2026-11-12",
  sources,
  rates,
  coverage: { logs: "priced", metrics: "priced", traces: "priced", profiles: "unsupported" },

  price({ w, d, s }) {
    const bill = billFor(rates);
    const lines: LineItem[] = [];
    const profile = QUERY_PROFILES[s.queryLoad];

    const logDays = atLeastZero(d.logs.retentionDays);
    const metricMonths = atLeastZero(d.metrics.retentionMonths);
    const traceDays = atLeastZero(d.traces.retentionDays);
    const candidates: Part[] = [
      {
        bucket: "logs",
        title: "Log",
        name: "logs",
        gb: d.logs.gbPerMonth,
        how: `${num(w.logs.gbPerDay)} GB/day × ${DAYS_PER_MONTH} days`,
        keptDays: logDays,
        kept: count(logDays, "day", "days"),
      },
      {
        bucket: "metrics",
        title: "Metric",
        name: "metrics",
        gb: d.metrics.gbPerMonth,
        how: `${compact(d.metrics.dataPointsPerMonth)} data points × ${num(w.metrics.bytesPerDataPoint, 0)} bytes`,
        keptDays: metricMonths * DAYS_PER_MONTH,
        kept: `${count(metricMonths, "month", "months")}, or ${num(metricMonths * DAYS_PER_MONTH)} days`,
      },
      {
        bucket: "traces",
        title: "Trace",
        name: "traces",
        gb: d.traces.gbPerMonth,
        how: `${compact(d.traces.spansPerMonth)} spans × ${num(w.traces.avgSpanBytes, 0)} bytes`,
        keptDays: traceDays,
        kept: count(traceDays, "day", "days"),
      },
    ];
    const parts = candidates.filter((part) => part.gb > 0);
    const single = parts.length === 1;
    const sending =
      d.logs.gbPerMonth > 0 || d.metrics.dataPointsPerMonth > 0 || d.traces.spansPerMonth > 0;

    // One organization, three meters. Every signal lands on the same ingest
    // ladder, the same query ladder and the same storage allowance.
    const totalGib = gbToGib(parts.reduce((sum, part) => sum + part.gb, 0));
    const totalGbHours = totalGib * profile.gbHoursPerGb;
    const totalStoredPerMonth = totalGib * STORED_SHARE;
    // The rate card takes the free storage off each month's compressed volume
    // and multiplies what is left by the months kept.
    const paidStorageShare =
      totalStoredPerMonth > FREE_STORAGE
        ? (totalStoredPerMonth - FREE_STORAGE) / totalStoredPerMonth
        : 0;

    const ingestSlices = paidSlices(bill, INGEST, totalGib);
    const querySlices = paidSlices(bill, QUERY, totalGbHours);

    if (sending) {
      lines.push(
        ...bill.line({
          bucket: "platform",
          label: "Platform fee",
          quantity: 1,
          unit: "month",
          rateId: "platform-fee",
          detail: `Charged once per organization, however many signals are sent. Covers the first ${num(FREE_INGEST)} GiB of ingest, ${FREE_QUERY} GB-hours of query compute and ${FREE_STORAGE} GiB of storage each month`,
        }),
      );
    }

    for (const part of parts) {
      const gib = gbToGib(part.gb);
      const share = gib / totalGib;
      const shareNote = single ? "" : ` (${num(share * 100, 1)}% share)`;
      const size = `${part.how} = ${num(part.gb)} GB, counted as ${num(gib)} GiB`;

      // Ingest: this signal's share of each paid tier of the combined volume.
      const ingestDetail = single
        ? `${size}, less ${num(FREE_INGEST)} GiB free`
        : `${size}. All signals fill one tier ladder: ${num(totalGib)} GiB in all, the first ${num(FREE_INGEST)} free, and each tier is split between them by volume`;
      ingestSlices.forEach((slice, position) => {
        lines.push(
          ...bill.line({
            bucket: part.bucket,
            label: `${part.title} ingestion, ${slice.range}${shareNote}`,
            quantity: slice.quantity * share,
            unit: INGEST.unit,
            rateId: slice.rateId,
            detail: position === 0 ? ingestDetail : undefined,
          }),
        );
      });

      // Query compute: estimated from ingest, so it splits the same way.
      const gbHours = gib * profile.gbHoursPerGb;
      const queryMath = `${num(gib)} GiB ingested × ${num(profile.gbHoursPerGb)} GB-hours per GB ingested, as billed in GiB (${s.queryLoad} query load) = ${num(gbHours)} GB-hours`;
      const queryDetail = single
        ? `${queryMath}, less ${FREE_QUERY} GB-hours free`
        : `${queryMath}. All signals fill one tier ladder: ${num(totalGbHours)} GB-hours in all, the first ${FREE_QUERY} free`;
      querySlices.forEach((slice, position) => {
        lines.push(
          ...bill.line({
            bucket: part.bucket,
            label: `Query compute on ${part.name}, ${slice.range}${shareNote}`,
            quantity: slice.quantity * share,
            unit: QUERY.unit,
            rateId: slice.rateId,
            detail: position === 0 ? queryDetail : undefined,
          }),
        );
      });

      // Storage: compressed size, held for the retention asked for, priced by
      // how old each day's data is.
      const storedPerMonth = gib * STORED_SHARE;
      const paidPerMonth = storedPerMonth * paidStorageShare;
      const storageDetail = `${num(gib)} GiB a month × ${num(100 - COMPRESSION_PERCENT)}% left after compression = ${num(storedPerMonth)} GiB, less ${single ? "" : "its share of "}the ${FREE_STORAGE} GiB free = ${num(paidPerMonth)} GiB a month, kept ${part.kept}`;
      STORAGE_BANDS.forEach((band, position) => {
        const untilDay = Math.min(part.keptDays, band.untilDay ?? part.keptDays);
        const daysInBand = Math.max(0, untilDay - band.fromDay);
        lines.push(
          ...bill.line({
            bucket: part.bucket,
            label: `${part.title} storage, ${band.name}, days ${num(band.fromDay)} to ${num(untilDay)}`,
            quantity: (paidPerMonth * daysInBand) / DAYS_PER_MONTH,
            unit: "GiB",
            rateId: band.id,
            detail: position === 0 ? storageDetail : undefined,
          }),
        );
      });
    }

    const assumptions: string[] = [
      `Axiom's price list is written in GB. Its usage docs measure ingest by dividing bytes by 1024^3, and its terms for pre-purchased credits say data loading is measured in gibibytes. So each GB sent (10^9 bytes) is counted as ${num(gbToGib(1), 3)} GiB, and the tiers and free allowances are read in the same unit.`,
      `Query compute is billed on memory and run time, which data volume does not determine. This estimate uses the ${profile.name} preset of the calculator on Axiom's pricing page, ${num(profile.gbHoursPerGb)} GB-hours per GB ingested, for a ${s.queryLoad} query load.`,
      `Storage is billed on compressed data. Axiom's rate card assumes ${COMPRESSION_PERCENT}% compression by default, so ${num(100 - COMPRESSION_PERCENT)}% of the ingested volume is stored. Actual compression varies with the data.`,
      `Stored data is priced by age as on the rate card: Frequent Access to day ${STORAGE_BANDS[0].untilDay}, Infrequent Access to day ${STORAGE_BANDS[1].untilDay} and Archive Instant Access after that. That schedule is Axiom's default, where queries usually reach back ${TYPICAL_QUERY_RANGE_DAYS} days.`,
      `The free storage is applied as in the rate card's example: ${FREE_STORAGE} GiB comes off each month's compressed volume before it is multiplied by the time kept.`,
      "OTLP logs, traces and metrics are billed as ingested volume. Axiom has no host fee and no custom metric class, so host and custom series are billed alike. Its docs say API ingest is measured on the uncompressed size of the request and give no separate rule for OTLP, so the uncompressed OTLP size is billed as sent.",
    ];
    if (d.metrics.gbPerMonth > 0) {
      assumptions.push(
        `Metrics are billed by ingested volume. Axiom publishes no size per data point, so the workload's ${num(w.metrics.bytesPerDataPoint, 0)} bytes per data point is used.`,
      );
    }
    if (!single && parts.length > 0) {
      assumptions.push(
        "The free allowances and the volume tiers apply to the organization's total. Each signal is given a share in proportion to its ingested volume.",
      );
    }
    if (parts.length > 0 && totalGib <= FREE_INGEST) {
      assumptions.push(
        `Ingest: ${num(totalGib)} GiB a month fits inside the ${num(FREE_INGEST)} GiB the platform fee covers, so data loading is not charged.`,
      );
    }
    if (parts.length > 0 && totalGbHours <= FREE_QUERY) {
      assumptions.push(
        `Query compute: ${num(totalGbHours)} GB-hours a month fits inside the ${FREE_QUERY} GB-hours the platform fee covers, so queries are not charged.`,
      );
    }
    if (parts.length > 0 && totalStoredPerMonth <= FREE_STORAGE) {
      assumptions.push(
        `Storage: ${num(totalStoredPerMonth)} GiB of compressed data a month fits inside the ${FREE_STORAGE} GiB free allowance, so storage is not charged.`,
      );
    }

    const profiles = [QUERY_PROFILES.light, QUERY_PROFILES.typical, QUERY_PROFILES.heavy];
    const listed = (values: number[]) =>
      `${values.slice(0, -1).map((value) => num(value)).join(", ")} and ${num(values[values.length - 1])}`;
    const calculatorPresets = listed(profiles.map((p) => p.gbHoursPerGb));
    const rateCardPresets = listed(profiles.map((p) => p.rateCardGbHoursPerGb));

    return {
      lines,
      assumptions,
      included: [
        `The first ${num(FREE_INGEST)} GiB of ingest, ${FREE_QUERY} GB-hours of query compute and ${FREE_STORAGE} GiB of compressed storage each month, covered by the platform fee`,
        "Dashboards, monitors and the MCP server. Their queries count toward query compute",
        "Any retention period, paid for through the storage lines",
        "Email support",
      ],
      notIncluded: [
        `SAML SSO (${usdRate(bill.usd("addon-sso"))} a month), Directory Sync (${usdRate(bill.usd("addon-directory-sync"))}), role-based access control (${usdRate(bill.usd("addon-rbac"))}) and extended audit logs (${usdRate(bill.usd("addon-audit-logs"))}), which are monthly add-ons`,
        "A HIPAA BAA, support with an SLA and a second edge deployment in another region, which are add-ons with no public price",
      ],
      notes: [
        `Both billing terms are priced pay as you go, with no minimum commitment. Ingest and query compute are billed in compute credits at ${usdRate(bill.usd("credit-on-demand"))} each.`,
        `Axiom also sells compute credits in advance for 12, 24 or 36 months. On a 12-month term a credit costs from ${usdRate(bill.usd("credit-12mo-first"))} at ${num(PREPAID_FIRST_ROW.from)} credits a year down to ${usdRate(bill.usd("credit-12mo-best"))} at ${num(PREPAID_LAST_ROW_FROM)}. That discount is not applied here, and it does not cover storage or the platform fee.`,
        "Axiom publishes one price list. An organization picks its edge deployment, US East 1 or EU Central 1, when it is created, so the region setting does not change this estimate.",
        "The pricing page lists no per-user price.",
        "Every query counts toward query compute, whether a person, a dashboard, a monitor or an AI agent runs it.",
        `Axiom publishes two sets of query presets. The calculator on its pricing page uses ${calculatorPresets} GB-hours per GB ingested for Low, Base and High, and this estimate uses those. The rate card at axiom.co/pricing/llms.txt gives ${rateCardPresets}.`,
        "The storage lines show the steady state, once data has been kept for the full retention period. Axiom moves data between storage tiers by when it was last queried, so a query over older data returns it to Frequent Access.",
        "A spending limit, if you set one, pauses ingest or queries when it is reached instead of billing past it.",
        `Axiom also has a free Personal plan for one user, capped at ${PERSONAL.ingestGb} GB of ingest a month and ${PERSONAL.retentionDays} days of retention. It is not priced here.`,
      ],
    };
  },
};
