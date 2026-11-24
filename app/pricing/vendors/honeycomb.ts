/**
 * Honeycomb, Pro plan (2026 pricing).
 *
 * One meter: events per month. A span is an event and so is a log record.
 * Metric data points are a second allotment that comes with the plan, five
 * for each event of plan size. Pro is sold as four fixed tiers from 50M to
 * 750M events a month, and Honeycomb publishes the per-event rate and the two
 * end tiers but not the two in between. So:
 *   - Up to the smallest tier the bill is that tier's published price.
 *   - Between the end tiers, usage is billed at the per-event rate and the
 *     step up to the unpublished tier size is returned as unpriced, never
 *     guessed, which leaves the estimate incomplete.
 *   - Past the largest tier the workload needs an Enterprise quote and
 *     nothing is priced.
 * The only Pro price printed on Honeycomb's pages is $150 for the 50M-event
 * tier. The docs give the rate ($3.00 per million events) and the size of the
 * largest tier (750M). The largest tier's price is that rate times its size.
 * Read from honeycomb.io/pricing and docs.honeycomb.io on the checkedOn date.
 */
import { billFor } from "../bill";
import { compact, num, usdRate } from "../format";
import type { Kept, LineItem, Rate, Source, Unpriced, VendorAdapter } from "../types";

const DOCS = "https://docs.honeycomb.io";

const sources: Source[] = [
  { id: "pricing", label: "Pricing page", url: "https://www.honeycomb.io/pricing" },
  {
    id: "pro-2026",
    label: "Docs: 2026 Pro plan changes",
    url: `${DOCS}/get-started/honeycomb/2026-pro-plan-changes`,
  },
  {
    id: "usage",
    label: "Docs: how Honeycomb calculates usage",
    url: `${DOCS}/get-started/manage-costs/how-honeycomb-calculates-usage`,
  },
  {
    id: "logs",
    label: "Docs: logs in Honeycomb",
    url: `${DOCS}/get-started/honeycomb/logs-in-honeycomb`,
  },
  {
    id: "metrics",
    label: "Docs: metrics in Honeycomb",
    url: `${DOCS}/get-started/honeycomb/metrics-in-honeycomb`,
  },
  {
    id: "billing-cycle",
    label: "Docs: change pricing plan",
    url: `${DOCS}/configure/teams/pricing-plan`,
  },
];

/** The smallest and largest Pro tiers, in events a month (pricing page). */
const PRO_MIN_EVENTS = 50e6;
const PRO_MAX_EVENTS = 750e6;
/** Metric data points a month that come with those two tiers (pricing page). */
const PRO_MIN_POINTS = 250e6;
const PRO_MAX_POINTS = 3.75e9;
/**
 * Data points included for each event of plan size. Both published tiers
 * work out to 5. The two unpublished tiers are taken to carry the same ratio.
 */
const POINTS_PER_EVENT = PRO_MIN_POINTS / PRO_MIN_EVENTS;

/** Events (spans and logs) are kept this many days, fixed (usage docs). */
const EVENT_RETENTION_DAYS = 60;
/** Time series metrics are kept this many months by default (usage docs). */
const METRIC_RETENTION_MONTHS = 13;

/** Pro feature limits (pricing page). */
const PRO_TRIGGERS = 100;
const PRO_SLOS = 2;
/** Free plan limits a month (pricing page). */
const FREE_EVENTS = 20e6;
const FREE_POINTS = 100e6;
const FREE_TRIGGERS = 2;
/** Enterprise plans start from this many events a year (pricing page). */
const ENTERPRISE_BASE_EVENTS_PER_YEAR = 10e9;

/** Keeps floating-point noise in summed counts from tripping a tier edge. */
const EDGE = 1 + 1e-9;

const rates: Rate[] = [
  {
    id: "pro-minimum",
    label: "Pro plan, smallest tier",
    usd: 150,
    unit: "month",
    sourceId: "pricing",
    basis: "starting-from",
    note: `The pricing page gives Pro as starting at this price, for ${compact(PRO_MIN_EVENTS)} events and ${compact(PRO_MIN_POINTS)} metric data points a month`,
  },
  {
    id: "pro-events",
    label: "Pro plan, per-event rate",
    usd: 3,
    unit: "million events a month",
    sourceId: "pro-2026",
    basis: "list",
    note: `Pro is sold as four fixed tiers from ${compact(PRO_MIN_EVENTS)} to ${compact(PRO_MAX_EVENTS)} events a month and you pay for the whole tier. The sizes of the two middle tiers are not published. Applies to Pro plans since July 1, 2026`,
  },
];

const QUOTE_ONLY = "More than that needs the Enterprise plan, which Honeycomb prices by quote.";

export const honeycomb: VendorAdapter = {
  id: "honeycomb",
  name: "Honeycomb",
  group: "otel-native",
  plan: () => "Pro plan, published monthly price",
  pricingUrl: "https://www.honeycomb.io/pricing",
  checkedOn: "2026-11-12",
  sources,
  rates,
  coverage: { logs: "priced", metrics: "priced", traces: "priced", profiles: "unsupported" },

  price({ w, d }) {
    const bill = billFor(rates);
    const perMillion = usdRate(bill.usd("pro-events"));

    const logRecords = d.logs.recordsPerMonth;
    const spans = d.traces.spansPerMonth;
    const points = d.metrics.dataPointsPerMonth;
    const events = logRecords + spans;

    const counting = "Every span and every log record sent over OTLP counts as one event.";

    if (!(events > 0) && !(points > 0)) {
      return { lines: [], assumptions: [counting], included: [], notIncluded: [], notes: [] };
    }

    // Past the largest Pro tier the whole account moves to an Enterprise
    // contract, so no part of the workload keeps a public price.
    const eventsOver = events > PRO_MAX_EVENTS * EDGE;
    const pointsOver = points > PRO_MAX_POINTS * EDGE;
    if (eventsOver || pointsOver) {
      const unpriced: Unpriced[] = [];
      const eventsPastPro = `come to ${compact(events)} events a month. The largest Pro tier takes ${compact(PRO_MAX_EVENTS)}. ${QUOTE_ONLY}`;
      const pulledByMetrics =
        "Metric data points are past the largest Pro tier, so the whole workload needs the Enterprise plan. Its event price is part of the quote.";
      if (logRecords > 0) {
        unpriced.push({
          bucket: "logs",
          reason: !eventsOver
            ? pulledByMetrics
            : spans > 0
              ? `Log records (${compact(logRecords)}) and spans (${compact(spans)}) ${eventsPastPro}`
              : `Log records ${eventsPastPro}`,
        });
      }
      if (points > 0) {
        unpriced.push({
          bucket: "metrics",
          reason: pointsOver
            ? `${compact(points)} metric data points a month is past the ${compact(PRO_MAX_POINTS)} that come with the largest Pro tier. ${QUOTE_ONLY}`
            : "Events are past the largest Pro tier, so the whole workload needs the Enterprise plan. Its data point allotment is part of the quote.",
        });
      }
      if (spans > 0) {
        unpriced.push({
          bucket: "traces",
          reason: !eventsOver
            ? pulledByMetrics
            : logRecords > 0
              ? `Spans (${compact(spans)}) and log records (${compact(logRecords)}) ${eventsPastPro}`
              : `Spans ${eventsPastPro}`,
        });
      }
      return {
        lines: [],
        assumptions: [
          ...(events > 0 ? [counting] : []),
          ...(points > 0
            ? [
                "Metrics sent over OTLP are counted as time series data points, one for each series at each export interval.",
              ]
            : []),
        ],
        included: [],
        notIncluded: [
          `The Enterprise plan this workload needs. Honeycomb prices it by quote, with volume discounts, from a base allowance of ${compact(ENTERPRISE_BASE_EVENTS_PER_YEAR)} events a year.`,
        ],
        notes: [
          `Pro is the largest plan with a public price. It stops at ${compact(PRO_MAX_EVENTS)} events and ${compact(PRO_MAX_POINTS)} metric data points a month.`,
          `Up to that size Pro is priced at ${perMillion} per million events a month.`,
          "Honeycomb counts only what it ingests. Spans and logs sampled out before they reach Honeycomb do not count toward the limit.",
        ],
        unpriced,
      };
    }

    const lines: LineItem[] = [];

    lines.push(
      ...bill.line({
        bucket: "logs",
        label: "Log records, billed as events",
        quantity: logRecords / 1e6,
        unit: "M events",
        rateId: "pro-events",
        detail: `${num(w.logs.gbPerDay)} GB/day × 30 days ÷ ${num(w.logs.avgRecordBytes, 0)} bytes a record = ${compact(logRecords)} records. One record is one event.`,
      }),
      ...bill.line({
        bucket: "traces",
        label: "Spans, billed as events",
        quantity: spans / 1e6,
        unit: "M events",
        rateId: "pro-events",
        detail: `${num(w.traces.spansPerSecond)} spans/s × 2,592,000 s in a 30-day month = ${compact(spans)} spans. One span is one event.`,
      }),
    );
    const eventsUsd = lines.reduce((sum, line) => sum + line.amount, 0);

    // The plan has to be big enough for the events and, at 5 data points per
    // event of plan size, for the data points. Events (or the smallest tier)
    // set the size first. Metrics cost only what they add on top.
    const sizeForEvents = Math.max(events, PRO_MIN_EVENTS);
    const sizeForPoints = points / POINTS_PER_EVENT;
    const extraForPoints = sizeForPoints > sizeForEvents ? sizeForPoints - sizeForEvents : 0;
    const planSize = sizeForEvents + extraForPoints;

    lines.push(
      ...bill.line({
        bucket: "metrics",
        label: "Larger plan to cover metric data points",
        quantity: extraForPoints / 1e6,
        unit: "M events",
        rateId: "pro-events",
        detail:
          `${compact(points)} data points ÷ ${POINTS_PER_EVENT} data points per event = a plan of ${compact(sizeForPoints)} events. ` +
          (events >= PRO_MIN_EVENTS
            ? `Logs and traces already account for ${compact(sizeForEvents)}.`
            : `The smallest tier covers the first ${compact(PRO_MIN_EVENTS)}.`),
      }),
    );

    if (events < PRO_MIN_EVENTS) {
      lines.push(
        ...bill.topUp({
          label: "Top-up to the smallest Pro tier",
          minimumRateId: "pro-minimum",
          usage: eventsUsd,
          detail:
            events > 0
              ? `${compact(events)} events is under the ${compact(PRO_MIN_EVENTS)} of the smallest Pro tier, the least Honeycomb sells on this plan. The tier includes ${compact(PRO_MIN_POINTS)} metric data points.`
              : `No events are sent, but metrics still need a Pro plan. The smallest tier includes ${compact(PRO_MIN_POINTS)} metric data points.`,
        }),
      );
    }

    // Only the two end tiers are published. A plan size between them lands in
    // a tier of unknown size, so the step up to it has no public price.
    const fitsSmallestTier = planSize <= PRO_MIN_EVENTS * EDGE;
    const fillsLargestTier = planSize >= PRO_MAX_EVENTS / EDGE;
    const unpriced: Unpriced[] = [];
    const assumptions: string[] = [];
    const fitsFreePlan = events <= FREE_EVENTS && points <= FREE_POINTS;
    const freePlan = `${compact(FREE_EVENTS)} events and ${compact(FREE_POINTS)} metric data points a month at no charge, with ${FREE_TRIGGERS} triggers and no SLOs`;
    if (fitsSmallestTier) {
      assumptions.push(
        `The workload fits the smallest Pro tier, which includes ${compact(PRO_MIN_EVENTS)} events and ${compact(PRO_MIN_POINTS)} metric data points a month.`,
      );
      if (fitsFreePlan) {
        assumptions.push(
          `It also fits Honeycomb's Free plan, which takes ${freePlan}. The estimate is for Pro.`,
        );
      }
    } else if (fillsLargestTier) {
      assumptions.push(
        `The workload needs the largest Pro tier, ${compact(PRO_MAX_EVENTS)} events and ${compact(PRO_MAX_POINTS)} metric data points a month, priced at the per-event rate of ${perMillion} per million.`,
      );
    } else {
      const shown = lines.reduce((sum, line) => sum + line.amount, 0);
      const largestTier = (PRO_MAX_EVENTS / 1e6) * bill.usd("pro-events");
      const range = `between the ${usdRate(shown)} priced here and ${usdRate(largestTier)} a month, the largest tier at the same rate`;
      unpriced.push({
        bucket: "platform",
        reason:
          `Pro comes in four fixed tiers of events a month and you pay for the whole tier. Honeycomb publishes a price only for the ${compact(PRO_MIN_EVENTS)}-event tier (${usdRate(bill.usd("pro-minimum"))}) and the size of the largest tier (${compact(PRO_MAX_EVENTS)} events). It does not publish the sizes or prices of the two tiers between them. This workload needs a plan of ${compact(planSize)} events, so the step up to the tier that covers it has no public price. ` +
          // The floor leans on the assumed data point ratio when metrics set the plan size.
          (extraForPoints > 0
            ? `If the middle tiers also include ${POINTS_PER_EVENT} data points per event, the invoice is ${range}.`
            : `The invoice is ${range}.`),
      });
      assumptions.push(
        `Usage is billed at Honeycomb's per-event rate, ${perMillion} per million events, on the ${compact(planSize)} events of plan size the workload needs.`,
      );
    }
    if (events > 0) assumptions.push(counting);
    if (points > 0) {
      assumptions.push(
        "Metrics sent over OTLP are stored as time series data points and count against the plan's data point allotment, which is separate from events. One data point is counted for each series at each export interval.",
      );
      if (!fitsSmallestTier && !fillsLargestTier) {
        assumptions.push(
          `The two middle Pro tiers are taken to include ${POINTS_PER_EVENT} data points per event, the ratio at both published tiers (${compact(PRO_MIN_POINTS)} with ${compact(PRO_MIN_EVENTS)} events and ${compact(PRO_MAX_POINTS)} with ${compact(PRO_MAX_EVENTS)}).`,
        );
      }
    }
    if (
      (logRecords > 0 && w.logs.searchableShare < 1) ||
      (spans > 0 && w.traces.searchableShare < 1)
    ) {
      assumptions.push(
        "Pro prices every event the same and keeps all of them searchable, so the searchable share does not change the price.",
      );
    }

    // Retention: fixed for events, a default for metrics. Neither has a priced
    // option, so the price buys 60 days and 13 months whatever was asked.
    const kept: Kept = {};
    const shorter: string[] = [];
    const eventAsks: { name: string; days: number }[] = [];
    if (logRecords > 0) {
      eventAsks.push({ name: "Logs", days: d.logs.retentionDays });
      if (d.logs.retentionDays !== EVENT_RETENTION_DAYS) kept.logsDays = EVENT_RETENTION_DAYS;
    }
    if (spans > 0) {
      eventAsks.push({ name: "Traces", days: d.traces.retentionDays });
      if (d.traces.retentionDays !== EVENT_RETENTION_DAYS) kept.tracesDays = EVENT_RETENTION_DAYS;
    }
    const asks =
      eventAsks.length === 2 && eventAsks[0].days === eventAsks[1].days
        ? [{ name: "Logs and traces", days: eventAsks[0].days }]
        : eventAsks;
    for (const ask of asks) {
      if (ask.days > EVENT_RETENTION_DAYS) {
        shorter.push(
          `${ask.name}: ${num(ask.days)} days of retention were asked for. Pro keeps events for a fixed ${EVENT_RETENTION_DAYS} days and Honeycomb publishes no price for longer, so the price shown keeps them ${EVENT_RETENTION_DAYS} days.`,
        );
      } else if (ask.days < EVENT_RETENTION_DAYS) {
        assumptions.push(
          `${ask.name}: Honeycomb keeps events for a fixed ${EVENT_RETENTION_DAYS} days, which covers the ${num(ask.days)} days asked for.`,
        );
      }
    }
    if (points > 0) {
      const months = d.metrics.retentionMonths;
      if (months !== METRIC_RETENTION_MONTHS) kept.metricsMonths = METRIC_RETENTION_MONTHS;
      if (months > METRIC_RETENTION_MONTHS) {
        shorter.push(
          `Metrics: ${num(months)} months of retention were asked for. Honeycomb keeps time series metrics for ${METRIC_RETENTION_MONTHS} months by default and publishes no price for longer, so the price shown keeps them ${METRIC_RETENTION_MONTHS} months.`,
        );
      } else if (months < METRIC_RETENTION_MONTHS) {
        assumptions.push(
          `Metrics: Honeycomb keeps time series metrics for ${METRIC_RETENTION_MONTHS} months, which covers the ${num(months)} months asked for.`,
        );
      }
    }
    assumptions.unshift(...shorter);

    const included: string[] = [];
    if (points > 0 && extraForPoints === 0) {
      const allotment = fitsSmallestTier
        ? `${compact(PRO_MIN_POINTS)} that come with the smallest tier`
        : fillsLargestTier
          ? `${compact(PRO_MAX_POINTS)} that come with the largest tier`
          : `${compact(planSize * POINTS_PER_EVENT)} a plan of this size carries at ${POINTS_PER_EVENT} data points per event`;
      included.push(`Metric data points: the ${compact(points)} sent are inside the ${allotment}`);
    }
    const eventRetention = `${EVENT_RETENTION_DAYS} days of retention for logs and traces`;
    const metricRetention = `${METRIC_RETENTION_MONTHS} months of retention for time series metrics`;
    included.push(
      events > 0 && points > 0
        ? `${eventRetention} and ${METRIC_RETENTION_MONTHS} months for time series metrics`
        : events > 0
          ? eventRetention
          : metricRetention,
      "Unlimited seats and unlimited querying",
      `${PRO_TRIGGERS} triggers, ${PRO_SLOS} SLOs and single sign-on`,
    );

    const notIncluded: string[] = [];
    if (spans > 0) {
      notIncluded.push(
        "Span events and span links. Honeycomb's usage docs count them as events, and the workload has no count for them",
      );
    }
    if (events > 0) {
      notIncluded.push(
        `Retention past ${EVENT_RETENTION_DAYS} days for logs and traces, which has no published price`,
      );
    }
    notIncluded.push(
      `Enterprise features such as Service Map and more than ${PRO_SLOS} SLOs, priced by quote`,
      "Honeycomb Telemetry Pipeline, a separate product priced per GB",
    );

    return {
      lines,
      kept,
      assumptions,
      included,
      notIncluded,
      notes: [
        "Honeycomb's public pages print one Pro price, for the smallest tier, and the per-event rate. They do not list the sizes of the two middle tiers.",
        "Honeycomb offers Pro on monthly or annual billing and publishes one price, per month. Its docs say annual billing typically includes a discount but give no figure, so both terms show the published price.",
        "Honeycomb's docs describe no overage charge on Pro. After two months in a row over a limit it gives 10 days of notice, then accepts one event in ten until usage stays under the daily target for 72 hours.",
        "Events and data points are separate limits, counted by calendar month. A 31-day month carries about 3% more than the 30-day month priced here.",
        "Metrics bill by data point. More series or a shorter export interval raise the count. Halving the interval doubles it.",
        ...(fitsFreePlan
          ? []
          : [`Honeycomb also has a Free plan, which takes ${freePlan}. This estimate is for Pro.`]),
        "These are the 2026 Pro prices, in effect since July 1, 2026. Teams still on an older Pro plan pay a different rate until they move.",
      ],
      unpriced,
    };
  },
};
