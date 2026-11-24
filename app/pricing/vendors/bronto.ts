/**
 * Bronto.
 *
 * Two flat plans and one pair of usage rates. Starter and Pro each cover a
 * month's ingest across logs, metrics and traces plus a search allowance. The
 * usage rates (per GB ingested, per TB scanned by queries) are printed on the
 * Enterprise plan and as the overage rate on the two plans. Every plan keeps
 * data hot for 12 months, and there are no seat, host or per-metric fees.
 *
 * The estimate is the smallest plan the month fits inside, and past Pro the
 * usage rates on the whole volume. That is how Bronto's own calculator
 * prices a month ("Volumes or search beyond Pro use Enterprise usage rates").
 * Below Pro the usage rates are only overage on a plan, and overages are not
 * relied on: Bronto says it usually moves sustained overages onto a larger
 * plan. So a month past Starter that fits Pro pays the Pro fee.
 *
 * Starter is priced at $10. The pricing page prints $25 struck through beside
 * it under a "New" label, and every other Bronto page (page title, Starter
 * plan page, Bronto's calculator) gives $10 with no end date, so $10 is read
 * as the list price and $25 as the price it replaced (the July 2026 launch
 * price). The Annual toggle is labeled "2 months free" but the page text
 * prints no annual figure, so both terms use the monthly prices.
 *
 * Rates read from bronto.io/pricing on the checkedOn date.
 */
import { billFor } from "../bill";
import { compact, num, usdRate } from "../format";
import type { LineItem, Rate, Signal, Source, VendorAdapter } from "../types";
import { DAYS_PER_MONTH, SCAN_MULTIPLE } from "../units";

const sources: Source[] = [
  { id: "pricing", label: "Pricing page", url: "https://bronto.io/pricing" },
  { id: "starter", label: "Starter plan page", url: "https://bronto.io/starterplan" },
  {
    id: "calculator",
    label: "Bronto's cost calculator (how it prices its plans)",
    url: "https://bronto.io/observability-cost-calculator",
  },
  {
    id: "announcement",
    label: "Blog: pricing announcement of July 2026",
    url: "https://bronto.io/blog/fixing-observability-pricing-for-the-ai-era",
  },
  {
    id: "usage-units",
    label: "Docs: My Data (how usage is measured)",
    url: "https://docs.bronto.io/My-Data/My-Data",
  },
  {
    id: "retention",
    label: "Docs: data retention",
    url: "https://docs.bronto.io/Account-Management/Retention",
  },
];

/** The plan cards print 1 TB beside 20× search as 20 TB, so a TB is 1,000 GB. */
const GB_PER_TB = 1000;

interface Plan {
  name: string;
  /** Ingest covered each month, in TB, across logs, metrics and traces. */
  ingestTb: number;
  /** Search covered each month, in TB scanned, as printed on the plan card. */
  searchTb: number;
  /** The same allowance as the multiple of ingest the card prints beside it. */
  searchMultiple: number;
  rateId: string;
}

const STARTER: Plan = {
  name: "Starter",
  ingestTb: 1,
  searchTb: 20,
  searchMultiple: 20,
  rateId: "starter",
};

const PRO: Plan = {
  name: "Pro",
  ingestTb: 5,
  searchTb: 500,
  searchMultiple: 100,
  rateId: "pro",
};

/** Hot retention every plan includes (pricing page; the Starter page writes it as 365 days). */
const INCLUDED_RETENTION_MONTHS = 12;
const INCLUDED_RETENTION_DAYS = 365;

const TRIAL_DAYS = 14;

/**
 * Slack when a volume is compared with a plan allowance, so that a month of
 * exactly 1 TB built from a daily figure (1,000 / 30 × 30) still fits.
 */
const EDGE_TOLERANCE = 1e-9;

const covers = (plan: Plan) =>
  `Covers ${plan.ingestTb} TB of ingest and ${plan.searchTb} TB of search a month`;

const USAGE_RATE_NOTE =
  "Printed on the Enterprise plan and as the overage rate on Starter and Pro. One price for both terms";

const TERM_NOTE =
  "The Annual toggle is labeled 2 months free, but the page prints no annual price, so this price is used for both terms";

const rates: Rate[] = [
  {
    id: "starter",
    label: "Starter plan",
    usd: 10,
    unit: "month",
    sourceId: "pricing",
    basis: "list",
    note: `${covers(STARTER)}. Printed beside a struck-through $25 under a New label; the Starter plan page and Bronto's calculator also give $10. ${TERM_NOTE}`,
  },
  {
    id: "starter-launch",
    label: "Starter plan, price at launch",
    usd: 25,
    unit: "month",
    sourceId: "pricing",
    basis: "list",
    note: "Printed struck through beside the $10 price. The July 2026 announcement gave it as the entry price. Named in the notes, not used in the estimate",
  },
  {
    id: "pro",
    label: "Pro plan",
    usd: 500,
    unit: "month",
    sourceId: "pricing",
    basis: "list",
    note: `${covers(PRO)}. ${TERM_NOTE}`,
  },
  {
    id: "ingest",
    label: "Ingestion at usage rates",
    usd: 0.1,
    unit: "GB ingested",
    sourceId: "pricing",
    basis: "list",
    note: `Logs, metrics and traces at one rate. ${USAGE_RATE_NOTE}`,
  },
  {
    id: "search",
    label: "Search at usage rates",
    usd: 1,
    unit: "TB searched",
    sourceId: "pricing",
    basis: "list",
    note: `Data scanned by queries from the UI, API, alerts and dashboards. ${USAGE_RATE_NOTE}`,
  },
];

interface SignalVolume {
  signal: Signal;
  /** "Log", for line labels. */
  noun: string;
  gbPerMonth: number;
  /** How the GB figure was reached. */
  detail: string;
}

export const bronto: VendorAdapter = {
  id: "bronto",
  name: "Bronto",
  group: "logs",
  plan: () => "Lowest-priced of Starter, Pro and usage rates, billed monthly",
  pricingUrl: "https://bronto.io/pricing",
  checkedOn: "2026-11-12",
  sources,
  rates,
  coverage: { logs: "priced", metrics: "priced", traces: "priced", profiles: "unsupported" },

  price({ w, d, s }) {
    const bill = billFor(rates);
    const multiple = SCAN_MULTIPLE[s.queryLoad];

    const volumes: SignalVolume[] = [
      {
        signal: "logs",
        noun: "Log",
        gbPerMonth: d.logs.gbPerMonth,
        detail: `${num(w.logs.gbPerDay)} GB/day × ${DAYS_PER_MONTH} days`,
      },
      {
        signal: "metrics",
        noun: "Metric",
        gbPerMonth: d.metrics.gbPerMonth,
        detail: `${compact(d.metrics.dataPointsPerMonth)} data points × ${num(w.metrics.bytesPerDataPoint, 0)} bytes`,
      },
      {
        signal: "traces",
        noun: "Trace",
        gbPerMonth: d.traces.gbPerMonth,
        detail: `${compact(d.traces.spansPerMonth)} spans × ${num(w.traces.avgSpanBytes, 0)} bytes`,
      },
    ];

    const ingestGb = volumes.reduce((sum, v) => sum + Math.max(0, v.gbPerMonth), 0);
    const scannedTb = (ingestGb * multiple) / GB_PER_TB;

    // The month at usage rates, signal by signal. These lines are the bill when
    // no plan costs less, and their total is what each plan fee is set against.
    const usageLines: LineItem[] = volumes.flatMap((v) => [
      ...bill.line({
        bucket: v.signal,
        label: `${v.noun} ingestion`,
        quantity: v.gbPerMonth,
        unit: "GB",
        rateId: "ingest",
        detail: v.detail,
      }),
      ...bill.line({
        bucket: v.signal,
        label: `Data scanned by ${v.noun.toLowerCase()} queries`,
        quantity: (v.gbPerMonth * multiple) / GB_PER_TB,
        unit: "TB",
        rateId: "search",
        detail: `${num(v.gbPerMonth)} GB ingested × ${multiple} (${s.queryLoad} query load) ÷ ${num(GB_PER_TB)} GB per TB`,
      }),
    ]);
    const usageTotal = usageLines.reduce((sum, line) => sum + line.amount, 0);

    const fits = (plan: Plan) =>
      ingestGb <= plan.ingestTb * GB_PER_TB * (1 + EDGE_TOLERANCE) &&
      scannedTb <= plan.searchTb * (1 + EDGE_TOLERANCE);

    const planLine = (plan: Plan): LineItem[] =>
      bill.line({
        bucket: "platform",
        label: `${plan.name} plan`,
        quantity: 1,
        unit: "month",
        rateId: plan.rateId,
        detail: `${covers(plan)}. The workload sends ${num(ingestGb)} GB and scans ${num(scannedTb)} TB (${num(ingestGb)} GB × ${multiple})`,
      });

    const starterFee = bill.usd(STARTER.rateId);
    const proFee = bill.usd(PRO.rateId);

    // Retention: every plan keeps every signal hot for 12 months, and a shorter
    // setting does not lower the price. Longer retention has no public price.
    const logsOn = d.logs.gbPerMonth > 0;
    const tracesOn = d.traces.gbPerMonth > 0;
    const metricsOn = d.metrics.gbPerMonth > 0;
    const shortfall: string[] = [];
    if (logsOn && d.logs.retentionDays > INCLUDED_RETENTION_DAYS) {
      shortfall.push(`logs are asked for ${num(d.logs.retentionDays, 0)} days`);
    }
    if (tracesOn && d.traces.retentionDays > INCLUDED_RETENTION_DAYS) {
      shortfall.push(`traces are asked for ${num(d.traces.retentionDays, 0)} days`);
    }
    if (metricsOn && d.metrics.retentionMonths > INCLUDED_RETENTION_MONTHS) {
      shortfall.push(`metrics are asked for ${num(d.metrics.retentionMonths, 0)} months`);
    }

    const assumptions: string[] = [];
    if (shortfall.length > 0) {
      const asked = shortfall.join(" and ");
      assumptions.push(
        `Retention is priced at the ${INCLUDED_RETENTION_MONTHS} months every plan includes, which is shorter than asked: ${asked}. Longer retention is arranged on the Enterprise plan and has no public price.`,
      );
    }
    assumptions.push(
      "Volume is billed as sent over OTLP, before compression, and a GB is 10^9 bytes. Bronto's calculator asks for the raw volume before compression, and its docs count 1 GB as 1,000,000,000 bytes. The pricing page has one rate by volume sent and no separate price for OTLP data.",
      `Search is priced on ${multiple} GB scanned for each GB ingested, the ${s.queryLoad} query load used for every vendor here. Bronto's sizing guide gives 20× for low or infrequent use, 100× for most DevOps use, 200× for API-heavy use and 300× for API and agent-heavy use.`,
    );
    if (metricsOn) {
      assumptions.push(
        `Metrics are billed by GB at the same rate as logs and traces, with no per-series or per-host fee. Their volume is data points × the ${num(w.metrics.bytesPerDataPoint, 0)} bytes per data point set in the workload. Bronto's calculator converts the same way and starts from 150 bytes.`,
      );
    }
    assumptions.push(
      "The estimate is the smallest plan the month fits inside, and past the Pro plan the usage rates on the whole volume, as Bronto's calculator prices it. Overages on a plan are not counted on, because Bronto says it usually moves sustained overages onto a larger plan.",
    );

    // Bronto's calculator labels a plan's search allowance as a multiple of
    // ingest (20×, 100×). The plan cards also print it in TB, and that is what
    // a month is held against here. Where the two readings part, say so.
    const allowanceReading = (plan: Plan) =>
      multiple > plan.searchMultiple
        ? ` The search allowance is read as the ${plan.searchTb} TB printed on the plan card. Read as a ${plan.searchMultiple}× multiple of ingest, the ${multiple}× query load would not fit the plan.`
        : "";

    const lines: LineItem[] = [];
    let chosen: Plan | null = null;

    if (!(ingestGb > 0)) {
      // Nothing is sent, so nothing is charged.
    } else if (fits(STARTER)) {
      chosen = STARTER;
      lines.push(...planLine(STARTER));
      assumptions.push(
        `The month fits inside the Starter plan, so the plan fee is the whole bill.${
          usageTotal < starterFee
            ? " The usage rates alone would come to less, but Bronto prints them only as overage on a plan or as Enterprise rates under a custom contract."
            : ""
        }${allowanceReading(STARTER)}`,
      );
    } else if (fits(PRO)) {
      chosen = PRO;
      lines.push(...planLine(PRO));
      assumptions.push(
        `The month is past the Starter plan, which covers ${STARTER.ingestTb} TB of ingest and ${STARTER.searchTb} TB of search, and fits inside the Pro plan, so the Pro fee is the whole bill. Bronto's calculator prices it the same way.${
          usageTotal < proFee
            ? ` The usage rates alone would come to ${usdRate(usageTotal)}, but below Pro they are only overage, and Bronto moves sustained overage onto a larger plan.`
            : ""
        }${allowanceReading(PRO)}`,
      );
    } else {
      lines.push(...usageLines);
      assumptions.push(
        `The month is past the Pro plan, which covers ${PRO.ingestTb} TB of ingest and ${PRO.searchTb} TB of search, so the usage rates apply to the whole volume. Bronto's calculator prices a month past Pro the same way.`,
      );
    }

    const shareSet =
      (logsOn && w.logs.searchableShare < 1) || (tracesOn && w.traces.searchableShare < 1);
    if (shareSet) {
      assumptions.push(
        "Bronto keeps everything hot in one tier, so all of it stays searchable and the searchable share is not used.",
      );
    }

    return {
      lines,
      kept: {
        ...(logsOn ? { logsDays: INCLUDED_RETENTION_DAYS } : {}),
        ...(tracesOn ? { tracesDays: INCLUDED_RETENTION_DAYS } : {}),
        ...(metricsOn ? { metricsMonths: INCLUDED_RETENTION_MONTHS } : {}),
      },
      assumptions,
      included: [
        `${INCLUDED_RETENTION_MONTHS} months of hot, searchable retention for every signal. A shorter setting does not lower the price.`,
        ...(chosen ? [`Search up to the ${chosen.name} plan's ${chosen.searchTb} TB scanned a month`] : []),
        "Unlimited users, with no per-host or per-metric fees",
        "SSO, role-based access control, and API and MCP access on every plan",
      ],
      notIncluded: [
        `Retention past ${INCLUDED_RETENTION_MONTHS} months, which is arranged on the Enterprise plan and has no public price`,
        "The Enterprise plan's SLA, dedicated Slack channel and technical account manager, which come with a custom contract",
        "Any discount for annual billing, because the pricing page prints no annual price",
      ],
      notes: [
        `The pricing page shows the Starter plan at ${usdRate(starterFee)} a month beside a struck-through ${usdRate(bill.usd("starter-launch"))}, the price announced in July 2026. Bronto's other pages give ${usdRate(starterFee)} with no end date, so the estimate uses it as the list price.`,
        `Annual billing is advertised as two months free, but the page prints no annual price. Both terms use the monthly prices: ${usdRate(starterFee)} for Starter and ${usdRate(proFee)} for Pro.`,
        `Overages on a plan are priced at the usage rates, ${usdRate(bill.usd("ingest"))} per GB ingested and ${usdRate(bill.usd("search"))} per TB searched. Bronto says it contacts the customer before charging them.`,
        "Search is billed on the data that queries scan, whether they come from the UI, the API, alerts or dashboards.",
        "The Enterprise plan is priced as Custom. The page prints its usage rates and no minimum or platform fee.",
        "The pricing page prints one price list with no region, so the region setting does not change the estimate.",
        `Starter and Pro have a ${TRIAL_DAYS}-day free trial.`,
      ],
    };
  },
};
