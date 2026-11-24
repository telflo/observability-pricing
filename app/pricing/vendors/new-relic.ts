/**
 * New Relic, usage-based pricing on the data and user model.
 *
 * Two meters. Data: every signal is billed as GB ingested at one rate on the
 * original data option, after 100 GB free each month, with per-GB add-ons for
 * the EU data center and for retention beyond the defaults. Seats: full
 * platform users, priced by edition. Standard allows five and is sold pay as
 * you go only. Pro has no limit and adds an annual commitment price.
 * Rates read from newrelic.com/pricing and the docs usage plan on the
 * checkedOn date.
 */
import { billFor, smallestCovering } from "../bill";
import { compact, num, usdRate } from "../format";
import type { Kept, LineItem, Rate, Signal, Source, Unpriced, VendorAdapter } from "../types";
import { DAYS_PER_MONTH } from "../units";

const sources: Source[] = [
  { id: "pricing", label: "Pricing page", url: "https://newrelic.com/pricing" },
  {
    id: "usage-plan",
    label: "Docs: usage plan list prices",
    url: "https://docs.newrelic.com/docs/licenses/license-information/usage-plans/new-relic-usage-plan/",
  },
  {
    id: "billing",
    label: "Billing docs: how pricing works",
    url: "https://docs.newrelic.com/docs/accounts/accounts-billing/new-relic-one-pricing-billing/new-relic-one-pricing-billing/",
  },
  {
    id: "retention",
    label: "Docs: data retention",
    url: "https://docs.newrelic.com/docs/data-apis/manage-data/manage-data-retention/",
  },
  {
    id: "definitions",
    label: "Docs: pricing definitions",
    url: "https://docs.newrelic.com/docs/licenses/license-information/product-definitions/new-relic-one-pricing-definitions/",
  },
  {
    id: "otlp-volume",
    label: "OpenTelemetry docs: managing data ingest volume",
    url: "https://docs.newrelic.com/docs/opentelemetry/best-practices/opentelemetry-manage-data-ingest-volume/",
  },
  {
    id: "cardinality",
    label: "Docs: manage metric cardinality",
    url: "https://docs.newrelic.com/docs/data-apis/ingest-apis/metric-api/cardinality-management/",
  },
  {
    id: "estimate-guide",
    label: "Blog: estimate your data ingest costs (2022)",
    url: "https://newrelic.com/blog/news/estimate-data-cost",
  },
];

/** GB of ingest that are free each month, on every edition. One pool for all data. */
const FREE_GB = 100;
/** Full platform users the Free edition includes. */
const FREE_EDITION_USERS = 1;
/** The most full platform users the Standard edition allows. */
const STANDARD_MAX_USERS = 5;
/** Days the original data option keeps logs and spans by default. */
const DEFAULT_LOG_DAYS = 30;
const DEFAULT_TRACE_DAYS = 8;
/** Raw metric points are kept this many days, rollups this many months. Not editable. */
const METRIC_RAW_DAYS = 30;
const METRIC_ROLLUP_MONTHS = 13;
/** Added retention is sold in steps of this many days, for all data at once. */
const RETENTION_STEP_DAYS = 30;
/** The longest retention the add-on reaches, from New Relic's 2022 estimate guide. */
const RETENTION_CEILING_DAYS = 395;
/**
 * Unique metric series a day that one account includes. A larger budget, up
 * to the maximum, is sold through the Advanced Compute add-on. New Relic does
 * not publish how many compute units the extra series use.
 */
const ACCOUNT_SERIES_BUDGET = 15_000_000;
const ACCOUNT_SERIES_BUDGET_MAX = 200_000_000;
/** Float noise to ignore before the monthly total is rounded up to a whole GB. */
const ROUNDING_EPSILON_GB = 1e-6;

// Rate notes carry no closing period: the page appends them to a sentence.
const rates: Rate[] = [
  {
    id: "data-original",
    label: "Data ingest, original data option",
    usd: 0.4,
    unit: "GB ingested",
    sourceId: "pricing",
    basis: "list",
    note: `One rate for logs, metrics and traces, after the first ${FREE_GB} GB each month. Same price on both billing terms`,
  },
  {
    id: "eu-data-center",
    label: "EU data center",
    usd: 0.05,
    unit: "GB ingested",
    sourceId: "pricing",
    basis: "list",
    note: "Added to the data price when data is stored in the EU region",
  },
  {
    id: "extended-retention",
    label: "Added retention",
    usd: 0.05,
    unit: `GB ingested, per ${RETENTION_STEP_DAYS} days added`,
    sourceId: "retention",
    basis: "list",
    note: "Raises retention for all data types at once",
  },
  {
    id: "standard-first-user",
    label: "Full platform user, Standard edition, first user",
    usd: 10,
    unit: "user per month",
    sourceId: "pricing",
    basis: "promotional",
    note: "The usage plan calls this a promotional price for the first user",
  },
  {
    id: "standard-additional-user",
    label: "Full platform user, Standard edition, each additional user",
    usd: 99,
    unit: "user per month",
    sourceId: "pricing",
    basis: "list",
    note: `Pay as you go. Standard allows at most ${STANDARD_MAX_USERS} full platform users`,
  },
  {
    id: "pro-user-annual",
    label: "Full platform user, Pro edition, annual commitment",
    usd: 349,
    unit: "user per month",
    sourceId: "pricing",
    basis: "list",
    note: "The usage plan lists this price with annual upfront billing",
  },
  {
    id: "pro-user-monthly-billing",
    label: "Full platform user, Pro edition, monthly billing",
    usd: 390.88,
    unit: "user per month",
    sourceId: "usage-plan",
    basis: "list",
    note: "Not part of the estimate",
  },
  {
    id: "pro-user-payg",
    label: "Full platform user, Pro edition, pay as you go",
    usd: 418.8,
    unit: "user per month",
    sourceId: "pricing",
    basis: "list",
    note: "No commitment, billed monthly in arrears",
  },
  {
    id: "core-user",
    label: "Core user",
    usd: 49,
    unit: "user per month",
    sourceId: "pricing",
    basis: "list",
    note: "Not part of the estimate. Same price on Standard, Pro and Enterprise",
  },
  {
    id: "data-plus",
    label: "Data ingest, Data Plus option",
    usd: 0.6,
    unit: "GB ingested",
    sourceId: "pricing",
    basis: "list",
    note: "Not part of the estimate. Adds up to 90 days of retention on most data types",
  },
  {
    id: "live-archives",
    label: "Live Archives log storage",
    usd: 0.007,
    unit: "GB-month stored",
    sourceId: "usage-plan",
    basis: "list",
    note: "Not part of the estimate. Queries on archived logs consume Advanced Compute",
  },
];

/** The retention a data type reaches with 0, 1, 2... steps of the add-on. */
function retentionLadder(defaultDays: number): { steps: number; days: number }[] {
  const maxSteps = Math.floor((RETENTION_CEILING_DAYS - defaultDays) / RETENTION_STEP_DAYS);
  return Array.from({ length: maxSteps + 1 }, (_, steps) => ({
    steps,
    days: defaultDays + steps * RETENTION_STEP_DAYS,
  }));
}

const days = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);

interface Part {
  bucket: Signal;
  /** Lower-case plural for labels and text: "logs". */
  name: string;
  ingestLabel: string;
  /** GB a month, as sent. */
  gb: number;
  /** How that GB figure was reached. */
  how: string;
}

export const newRelic: VendorAdapter = {
  id: "new-relic",
  name: "New Relic",
  group: "suite",
  // The edition depends on the seat count, which plan() does not receive. The
  // first assumption and the seat lines name the edition that was priced.
  plan: (s) =>
    `Standard or Pro edition by seat count, original data option, ${
      s.term === "annual" ? "Pro seats on an annual commitment" : "pay as you go"
    }${s.region === "eu" ? ", EU data center" : ""}`,
  pricingUrl: "https://newrelic.com/pricing",
  checkedOn: "2026-11-12",
  sources,
  rates,
  coverage: { logs: "priced", metrics: "priced", traces: "priced", profiles: "unpriced" },
  coverageNote: {
    profiles:
      "Java profiling is billed as ordinary data ingest, and New Relic publishes no profile volume per host to price it from.",
  },

  price({ w, d, s }) {
    const bill = billFor(rates);
    const lines: LineItem[] = [];
    const eu = s.region === "eu";
    const annual = s.term === "annual";

    const allParts: Part[] = [
      {
        bucket: "logs",
        name: "logs",
        ingestLabel: "Log data ingest",
        gb: d.logs.gbPerMonth,
        how: `${num(w.logs.gbPerDay)} GB/day × ${DAYS_PER_MONTH} days`,
      },
      {
        bucket: "metrics",
        name: "metrics",
        ingestLabel: "Metric data ingest",
        gb: d.metrics.gbPerMonth,
        how: `${compact(d.metrics.dataPointsPerMonth)} data points × ${num(w.metrics.bytesPerDataPoint, 0)} bytes`,
      },
      {
        bucket: "traces",
        name: "traces",
        ingestLabel: "Trace data ingest",
        gb: d.traces.gbPerMonth,
        how: `${compact(d.traces.spansPerMonth)} spans × ${num(w.traces.avgSpanBytes, 0)} bytes`,
      },
    ];
    const parts = allParts.filter((p) => p.gb > 0);
    const logsSent = d.logs.gbPerMonth > 0;
    const metricsSent = d.metrics.gbPerMonth > 0;
    const tracesSent = d.traces.gbPerMonth > 0;

    // Data: one meter for every signal. The month's total is rounded up to a
    // whole GB, the first 100 GB are free and the rest bills at one rate.
    const sentGb = parts.reduce((sum, p) => sum + p.gb, 0);
    const countedGb = Math.ceil(sentGb - ROUNDING_EPSILON_GB);
    const roundedUp = countedGb - sentGb > ROUNDING_EPSILON_GB;
    const billableGb = Math.max(0, countedGb - FREE_GB);

    // Retention: logs and spans have fixed defaults. More is bought in 30-day
    // steps that apply to all data at once, so the signal that needs the most
    // steps sets the number for everything.
    const logAsk = days(d.logs.retentionDays);
    const traceAsk = days(d.traces.retentionDays);
    const logRung = smallestCovering(retentionLadder(DEFAULT_LOG_DAYS), (r) => r.days, logAsk);
    const traceRung = smallestCovering(retentionLadder(DEFAULT_TRACE_DAYS), (r) => r.days, traceAsk);
    const logNeeds = logsSent ? logRung.steps : 0;
    const traceNeeds = tracesSent ? traceRung.steps : 0;
    const steps = Math.max(logNeeds, traceNeeds);
    const stepWord = steps === 1 ? "step" : "steps";
    const logDays = DEFAULT_LOG_DAYS + steps * RETENTION_STEP_DAYS;
    const traceDays = DEFAULT_TRACE_DAYS + steps * RETENTION_STEP_DAYS;
    // What the add-on does for each signal it is charged on.
    const retentionEffect: Partial<Record<Signal, string>> = {
      logs:
        logNeeds > 0
          ? `Keeps logs ${logDays} days.`
          : `Charged on all data. Logs are kept ${logDays} days.`,
      metrics: "Charged on all data. Metric retention does not change.",
      traces:
        traceNeeds > 0
          ? `Keeps traces ${traceDays} days.`
          : `Charged on all data. Traces are kept ${traceDays} days.`,
    };

    // Edition: the lowest-priced one that allows this many full platform users.
    // The Free edition cannot go past 100 GB or change retention.
    const users = Math.ceil(d.users);
    const userText = `${num(users, 0)} full platform ${users === 1 ? "user" : "users"}`;
    const edition: "Free" | "Standard" | "Pro" =
      users > STANDARD_MAX_USERS
        ? "Pro"
        : users <= FREE_EDITION_USERS && billableGb === 0 && steps === 0
          ? "Free"
          : "Standard";

    // Assumptions, most consequential first: the page shows the first three
    // and folds the rest away.
    const assumptions: string[] = [];

    if (edition === "Free") {
      assumptions.push(
        `Edition: Free. It includes ${FREE_EDITION_USERS} full platform user and ${FREE_GB} GB of data a month at no charge.`,
      );
    } else if (edition === "Standard") {
      const payAsYouGo = `Standard is sold pay as you go only${
        annual ? ", so the annual term does not change its price" : ""
      }.`;
      if (users > FREE_EDITION_USERS) {
        assumptions.push(
          `Edition: Standard, the lowest-priced edition that allows ${userText}. It allows up to ${STANDARD_MAX_USERS}. ${payAsYouGo}`,
        );
      } else {
        // The Free edition has enough seats, so say what rules it out.
        assumptions.push(
          `Edition: Standard, the lowest-priced paid edition. The Free edition ${
            billableGb > 0 ? `stops at ${FREE_GB} GB of data a month` : "cannot change retention"
          }. ${payAsYouGo}${users === 0 ? " No full platform users are priced. Basic users are free." : ""}`,
        );
      }
    } else {
      assumptions.push(
        `Edition: Pro. Standard allows at most ${STANDARD_MAX_USERS} full platform users and ${num(users, 0)} are needed. Pro is the lowest-priced edition without that limit.`,
      );
    }

    if (steps > 0) {
      const defaults: string[] = [];
      const asks: string[] = [];
      const kept: string[] = [];
      if (logsSent) {
        defaults.push(`logs ${DEFAULT_LOG_DAYS} days`);
        kept.push(`logs ${logDays} days`);
      }
      if (tracesSent) {
        defaults.push(`traces ${DEFAULT_TRACE_DAYS} days`);
        kept.push(`traces ${traceDays} days`);
      }
      if (logNeeds > 0) asks.push(`${num(logAsk, 0)} days asked for logs`);
      if (traceNeeds > 0) asks.push(`${num(traceAsk, 0)} days asked for traces`);
      assumptions.push(
        `Retention: the original data option keeps ${defaults.join(" and ")}. The ${asks.join(" and the ")} ${
          asks.length === 1 ? "is" : "are"
        } priced with ${steps} ${stepWord} of added retention (${RETENTION_STEP_DAYS} days${
          steps === 1 ? "" : " each"
        }), which keeps ${kept.join(" and ")}.`,
      );
    }

    assumptions.push(
      "New Relic bills the size of the data it stores after processing and publishes no factor to convert the size sent into that size. This estimate bills the bytes sent, with a GB as 10^9 bytes.",
      "The stored size can differ from the size sent. New Relic says log events are metered as JSON, which is larger than the raw log, and that OTLP resource attributes are copied onto every span, metric and log record.",
    );

    if (steps > 0) {
      assumptions.push(
        `Added retention cannot be bought for one data type. It is priced per GB ingested and charged here on every billable GB, after the free allowance${
          metricsSent ? ". That includes metrics, although metric retention does not change" : ""
        }.`,
      );
      if (edition === "Standard") {
        assumptions.push(
          "On Standard, retention can be changed only in an organization with a single account. With several accounts it needs Pro.",
        );
      }
    }

    assumptions.push(
      "OTLP data is billed like any other data, per GB ingested. New Relic has no host, container or agent fee and no custom-metric class, so host and custom series are billed alike, by size.",
    );

    for (const p of parts) {
      const quantity = (billableGb * p.gb) / sentGb;
      const size = `${p.how} = ${num(p.gb)} GB`;
      lines.push(
        ...bill.line({
          bucket: p.bucket,
          label: p.ingestLabel,
          quantity,
          unit: "GB",
          rateId: "data-original",
          detail:
            parts.length === 1
              ? `${size}${roundedUp ? `, rounded up to ${num(countedGb)} GB` : ""}, less ${FREE_GB} GB free`
              : `${size} of ${num(countedGb)} GB in total${roundedUp ? " after rounding up" : ""}, less its share of the ${FREE_GB} GB free`,
        }),
      );
      if (eu) {
        lines.push(
          ...bill.line({
            bucket: p.bucket,
            label: `EU data center surcharge on ${p.name}`,
            quantity,
            unit: "GB",
            rateId: "eu-data-center",
            detail: `${num(quantity)} billable GB stored in the EU data center`,
          }),
        );
      }
      if (steps > 0) {
        lines.push(
          ...bill.line({
            bucket: p.bucket,
            label: `Added retention, +${steps * RETENTION_STEP_DAYS} days, charged on ${p.name}`,
            quantity: quantity * steps,
            // One step is a plain per-GB charge. More steps multiply it.
            unit: steps === 1 ? "GB" : "GB-steps",
            rateId: "extended-retention",
            detail: `${num(quantity)} billable GB × ${steps} ${stepWord} of ${RETENTION_STEP_DAYS} days. ${retentionEffect[p.bucket]}`,
          }),
        );
      }
    }

    if (billableGb === 0) {
      assumptions.push(
        `All ${num(countedGb)} GB a month fits inside the ${FREE_GB} GB free allowance, so data is not charged.`,
      );
    } else {
      if (parts.length > 1) {
        assumptions.push(
          `The ${FREE_GB} GB free allowance is one pool for all data. It is split here across the signals in proportion to their volume.`,
        );
      }
      if (roundedUp) {
        assumptions.push(
          `New Relic rounds the month's total up to a whole GB before billing, here ${num(countedGb)} GB.`,
        );
      }
    }

    // Retention the ask does not match: past the add-on's limit, or shorter
    // than what New Relic keeps anyway. A shorter retention leads the list.
    const shorter: string[] = [];
    if (logsSent && logDays < logAsk) {
      shorter.push(
        `Logs: ${num(logAsk, 0)} days asked. New Relic's 2022 estimate guide puts the limit for added retention at ${RETENTION_CEILING_DAYS} days, so ${logDays} days is priced, the longest step under that limit.`,
      );
    }
    if (tracesSent && traceDays < traceAsk) {
      shorter.push(
        `Traces: ${num(traceAsk, 0)} days asked. New Relic's 2022 estimate guide puts the limit for added retention at ${RETENTION_CEILING_DAYS} days, so ${traceDays} days is priced, the longest step under that limit.`,
      );
    }
    if (steps === 0) {
      if (logsSent && logAsk < DEFAULT_LOG_DAYS) {
        assumptions.push(
          `Logs: ${num(logAsk, 0)} days asked. The original data option keeps logs ${DEFAULT_LOG_DAYS} days at the same price, so ${DEFAULT_LOG_DAYS} days is priced.`,
        );
      }
      if (tracesSent && traceAsk < DEFAULT_TRACE_DAYS) {
        assumptions.push(
          `Traces: ${num(traceAsk, 0)} days asked. The original data option keeps traces ${DEFAULT_TRACE_DAYS} days at the same price, so ${DEFAULT_TRACE_DAYS} days is priced.`,
        );
      }
    }
    if (metricsSent) {
      const monthsAsked = `${num(d.metrics.retentionMonths, 0)} ${d.metrics.retentionMonths === 1 ? "month" : "months"} asked`;
      if (d.metrics.retentionMonths > METRIC_ROLLUP_MONTHS) {
        shorter.push(
          `Metrics: ${monthsAsked}. New Relic keeps metric rollups ${METRIC_ROLLUP_MONTHS} months and the period cannot be changed, so ${METRIC_ROLLUP_MONTHS} months is priced.`,
        );
      } else {
        assumptions.push(
          `Metrics: ${monthsAsked}. New Relic keeps raw data points ${METRIC_RAW_DAYS} days and rollups of one minute and longer ${METRIC_ROLLUP_MONTHS} months. Neither period can be changed.`,
        );
      }
    }
    assumptions.unshift(...shorter);
    if (eu) {
      assumptions.push(
        "The EU data center surcharge is priced per GB ingested. It is charged here on billable GB, after the free allowance, like the data price.",
      );
    }
    if (
      (logsSent && d.logs.searchableGbPerMonth < d.logs.gbPerMonth) ||
      (tracesSent && d.traces.searchableGbPerMonth < d.traces.gbPerMonth)
    ) {
      assumptions.push(
        "New Relic has one storage tier. Everything ingested is indexed and kept for the full retention, so the searchable share is not used.",
      );
    }

    // Seats: charged once, whatever is sent.
    if (edition === "Standard") {
      lines.push(
        ...bill.line({
          bucket: "platform",
          label: "First full platform user, Standard edition",
          quantity: Math.min(users, 1),
          unit: "user",
          rateId: "standard-first-user",
          detail: "Promotional price for the first user, pay as you go",
        }),
        ...bill.line({
          bucket: "platform",
          label: "Additional full platform users, Standard edition",
          quantity: Math.max(0, users - 1),
          unit: users - 1 === 1 ? "user" : "users",
          rateId: "standard-additional-user",
          detail: `${num(users, 0)} users less the first, pay as you go. Standard allows at most ${STANDARD_MAX_USERS}.`,
        }),
      );
    } else if (edition === "Pro") {
      lines.push(
        ...bill.line({
          bucket: "platform",
          label: `Full platform users, Pro edition, ${annual ? "annual commitment" : "pay as you go"}`,
          quantity: users,
          unit: "users",
          rateId: annual ? "pro-user-annual" : "pro-user-payg",
          detail: `${num(users, 0)} people who need full access${
            annual ? ", at the price listed with annual upfront billing" : ""
          }`,
        }),
      );
    }

    const included: string[] = [
      "Queries, dashboards and alerts",
      "Unlimited hosts, containers and agents",
      "Unlimited basic users, who can run queries and use custom dashboards",
      `The first ${FREE_GB} GB of data each month`,
    ];
    if (logsSent) included.push(`${logDays} days of log retention`);
    if (tracesSent) included.push(`${traceDays} days of trace retention`);
    if (metricsSent) {
      included.push(
        `Raw metric data points for ${METRIC_RAW_DAYS} days and rollups for ${METRIC_ROLLUP_MONTHS} months`,
      );
    }
    included.push("Indexing of all data, with no rehydration or egress fee");

    const notIncluded: string[] = [
      "Advanced Compute features such as New Relic AI, Live Archives and Pipeline Control, which bill per compute unit used",
      "Synthetic checks beyond the number included with the edition",
      "Enterprise edition features such as FedRAMP and HIPAA eligibility, which need Enterprise seats and the Data Plus option",
      "Discounts from a commitment contract, which New Relic does not publish",
    ];

    const notes: string[] = [];
    if (edition === "Pro") {
      notes.push(
        `New Relic lists three Pro seat prices: ${usdRate(bill.usd("pro-user-annual"))} on an annual commitment billed upfront, ${usdRate(bill.usd("pro-user-monthly-billing"))} with monthly billing and ${usdRate(bill.usd("pro-user-payg"))} pay as you go. The annual term here uses the first and the monthly term the last.`,
      );
    } else if (edition === "Standard") {
      notes.push(
        `New Relic publishes one Standard seat price, pay as you go: ${usdRate(bill.usd("standard-first-user"))} for the first user and ${usdRate(bill.usd("standard-additional-user"))} for each of the others. Both billing terms give the same seat price here. A sixth user needs the Pro edition, where every user costs ${usdRate(bill.usd(annual ? "pro-user-annual" : "pro-user-payg"))}.`,
      );
    } else {
      notes.push(
        `On the Free edition, ingest stops and access to the platform is lost once more than ${FREE_GB} GB is sent in a month, until the next month or an upgrade.`,
      );
    }
    notes.push(
      `Seats here are full platform users. Core users, who get the logs UI and errors inbox without the full platform, cost ${usdRate(bill.usd("core-user"))} a month each.`,
      `Data costs ${usdRate(bill.usd("data-original"))} per GB on both billing terms. Only Pro seats change with the term.`,
      "Seats are counted per calendar month at the highest user type a person held in it. A user is billable from the day they are added, even before signing in.",
    );
    if (steps === 0 && (logsSent || tracesSent)) {
      notes.push(
        `Retention beyond the defaults costs ${usdRate(bill.usd("extended-retention"))} per GB for each ${RETENTION_STEP_DAYS} days added. It cannot be bought for one data type and is charged on all data.`,
      );
    }
    notes.push(
      `The Data Plus option costs ${usdRate(bill.usd("data-plus"))} per GB instead of ${usdRate(bill.usd("data-original"))} and adds up to 90 days of retention on most data types, with export and compliance features. It is not used here.`,
    );
    if (logsSent && logAsk > DEFAULT_LOG_DAYS) {
      notes.push(
        `Live Archives keeps logs for up to seven years at ${usdRate(bill.usd("live-archives"))} per GB-month of storage. Queries on archived logs are billed in Advanced Compute units, which depend on the query, so it is not priced here.`,
      );
    }

    // Metric series: one account includes a daily budget of unique series.
    // Past it, part of the charge has no public price.
    const unpriced: Unpriced[] = [];
    const pastSeriesBudget = metricsSent && d.metrics.activeSeries > ACCOUNT_SERIES_BUDGET;
    if (pastSeriesBudget) {
      unpriced.push({
        bucket: "metrics",
        reason: `One account includes ${compact(ACCOUNT_SERIES_BUDGET)} unique metric series a day and this workload has ${compact(d.metrics.activeSeries)} active series. Past the budget New Relic pauses rollups for the rest of the day. A budget of up to ${compact(ACCOUNT_SERIES_BUDGET_MAX)} needs the Advanced Compute add-on. It is billed in compute units, and New Relic does not publish how many units the extra series use. Metric ingest is priced above.`,
      });
    }
    if (metricsSent) {
      notes.push(
        "Metrics bill by GB ingested, so the series count matters only through the data size. New Relic says halving the export interval about doubles metric volume. It recommends delta temporality over OTLP and says cumulative generally results in high data ingest.",
      );
      if (!pastSeriesBudget) {
        notes.push(
          `One account includes ${compact(ACCOUNT_SERIES_BUDGET)} unique metric series a day. A larger budget needs the Advanced Compute add-on, which is not priced here.`,
        );
      }
    }
    notes.push(
      "Queries are not billed in this model, so the query load setting does not change this estimate.",
      "New Relic also offers Core Compute, which replaces seats with usage-based compute charges. It is in public preview and its rates are not published.",
      "New Relic's usage plan calls its list prices promotional and subject to change.",
    );

    // The retention the price buys, wherever it differs from the ask.
    const kept: Kept = {};
    if (logsSent && logDays !== logAsk) kept.logsDays = logDays;
    if (tracesSent && traceDays !== traceAsk) kept.tracesDays = traceDays;
    if (metricsSent && d.metrics.retentionMonths !== METRIC_ROLLUP_MONTHS) {
      kept.metricsMonths = METRIC_ROLLUP_MONTHS;
    }

    return { lines, kept, assumptions, included, notIncluded, notes, unpriced };
  },
};
