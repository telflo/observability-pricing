/**
 * Splunk Observability Cloud: metrics and traces on its per-host bundles.
 *
 * The pricing page lists three bundles at "starts at" prices per host per
 * month, billed annually. Two apply here: Infrastructure (metrics) and
 * App & Infra (adds APM). Every host carries fixed allotments from Splunk's
 * entitlement terms. Past an allotment Splunk sells more capacity without a
 * public price, so the excess is returned as unpriced and never guessed.
 * The bundles carry no log storage: Log Observer Connect reads logs held in
 * Splunk Cloud Platform or Splunk Enterprise, which are quote-only. Read from
 * splunk.com and help.splunk.com on the checkedOn date.
 */
import { billFor, smallestCovering } from "../bill";
import { compact, num, usdRate } from "../format";
import type { LineItem, Rate, Source, Unpriced, VendorAdapter } from "../types";
import { MINUTES_PER_MONTH } from "../units";

const DOCS = "https://help.splunk.com/en/splunk-observability-cloud";

const sources: Source[] = [
  {
    id: "pricing",
    label: "Pricing page",
    url: "https://www.splunk.com/en_us/products/pricing.html",
  },
  {
    id: "entitlements",
    label: "Terms: usage, subscription limits and entitlements",
    url: "https://www.splunk.com/en_us/legal/usage-subscription-limits-enforcement-and-entitlements.html",
  },
  {
    id: "suites",
    label: "Terms: suites and the definition of a host",
    url: "https://www.splunk.com/en_us/legal/suitification-licensing.html",
  },
  {
    id: "infra-usage",
    label: "Docs: infrastructure subscription usage",
    url: `${DOCS}/administer/monitor-subscription-usage-and-billing/infrastructure-subscription-usage-host-and-metrics-plans`,
  },
  {
    id: "infra-billing",
    label: "Docs: infrastructure billing and overage",
    url: `${DOCS}/administer/monitor-subscription-usage-and-billing/manage-infrastructure-billing-host-and-metrics-plans`,
  },
  {
    id: "apm-usage",
    label: "Docs: APM billing and subscription usage",
    url: `${DOCS}/administer/monitor-subscription-usage-and-billing/apm-billing-and-subscription-usage`,
  },
  {
    id: "retention",
    label: "Docs: data retention",
    url: `${DOCS}/administer/org-reference-info/data-retention-in-splunk-observability-cloud`,
  },
  {
    id: "resolution",
    label: "Docs: metric resolution",
    url: `${DOCS}/manage-data/metrics-metadata-and-events/metrics-events-and-metadata/get-started-with-metrics`,
  },
  {
    id: "service",
    label: "Docs: service description",
    url: `${DOCS}/get-started/service-description/splunk-observability-cloud-service-description`,
  },
  {
    id: "free-edition",
    label: "Docs: Free Edition",
    url: `${DOCS}/get-started/free-edition/splunk-observability-cloud-free-edition`,
  },
];

/**
 * Standard edition entitlements per host, from the entitlements terms. The
 * suites terms give the same figures for the Commercial Edition bundles, the
 * lower of the two editions. The pricing page names no edition, so its
 * from-prices are paired with this smaller set.
 */
const CONTAINERS_PER_HOST = 10;
const CUSTOM_METRICS_PER_HOST = 100;
/** Trace volume per APM host. Splunk writes "MB" and does not define it. */
const TRACE_MB_PER_MINUTE_PER_HOST = 10.24;
/** The entitlement's MB read as 10^6 bytes, so 1,000 to a decimal GB. */
const MB_PER_GB = 1000;

/** The suites terms define a host as a machine "up to 64 GB of memory". */
const HOST_MEMORY_LIMIT_GB = 64;

/** Raw trace retention options in days. The first is the default, the rest are set up on request. */
const TRACE_RETENTION_DAYS = [8, 15, 30];
const DEFAULT_TRACE_DAYS = TRACE_RETENTION_DAYS[0];
/** Retention of metrics at one-minute resolution or coarser, in months. */
const METRIC_MONTHS = 13;
/** Retention of metrics finer than one minute at Standard edition, in days. */
const FINE_METRIC_DAYS = 8;
/** Metrics are processed at this resolution unless a series is marked high-resolution. */
const DEFAULT_RESOLUTION_SECONDS = 10;

/** Usage past a subscription limit is charged at this percentage of list price. */
const OVERAGE_PERCENT = 150;
/** A histogram data point bills as this many custom metric series. */
const SERIES_PER_HISTOGRAM = 8;
/** The Free Edition's host limit. Its other limits are not published. */
const FREE_EDITION_HOSTS = 15;

const rates: Rate[] = [
  {
    id: "infrastructure-host",
    label: "Infrastructure bundle",
    usd: 15,
    unit: "host per month",
    sourceId: "pricing",
    basis: "starting-from",
    note: `Billed annually. Standard edition entitlements assumed: ${CONTAINERS_PER_HOST} containers and ${CUSTOM_METRICS_PER_HOST} custom metric series per host`,
  },
  {
    id: "app-infra-host",
    label: "App & Infra bundle",
    usd: 60,
    unit: "host per month",
    sourceId: "pricing",
    basis: "starting-from",
    note: `Billed annually. Adds APM to the Infrastructure bundle: ${TRACE_MB_PER_MINUTE_PER_HOST} MB of spans a minute per host`,
  },
];

const clampShare = (x: number) => Math.min(1, Math.max(0, x));

export const splunk: VendorAdapter = {
  id: "splunk",
  name: "Splunk Observability Cloud",
  group: "suite",
  plan: () => "Infrastructure and App & Infra bundles, billed annually, Commercial Edition allotments",
  pricingUrl: "https://www.splunk.com/en_us/products/pricing.html",
  checkedOn: "2026-11-12",
  sources,
  rates,
  coverage: { logs: "unpriced", metrics: "priced", traces: "priced", profiles: "unpriced" },
  coverageNote: {
    profiles:
      "AlwaysOn Profiling is part of the APM host fee, with a profiling volume allowance per host and no published rate past it.",
  },

  price({ w, d }) {
    const bill = billFor(rates);
    const lines: LineItem[] = [];
    const unpriced: Unpriced[] = [];

    const metricsSent = d.metrics.activeSeries > 0;
    const tracesSent = d.traces.spansPerMonth > 0;
    // Host fees follow the signal: no metrics, no infrastructure hosts; no spans, no APM hosts.
    const infraHosts = metricsSent ? d.infra.monitoredHosts : 0;
    const apmHosts = tracesSent ? d.infra.tracedHosts : 0;
    // App & Infra already covers infrastructure monitoring on the hosts it is bought for.
    const infraOnlyHosts = Math.max(0, infraHosts - apmHosts);

    const traceMbPerMinute = (d.traces.gbPerMonth * MB_PER_GB) / MINUTES_PER_MONTH;
    const traceAllotmentMb = apmHosts * TRACE_MB_PER_MINUTE_PER_HOST;
    const infraAllowance = `${CONTAINERS_PER_HOST} containers and ${CUSTOM_METRICS_PER_HOST} custom metric series per host`;

    lines.push(
      ...bill.line({
        bucket: "metrics",
        label:
          apmHosts > 0
            ? "Infrastructure bundle, hosts without tracing"
            : "Infrastructure bundle, hosts sending metrics",
        quantity: infraOnlyHosts,
        unit: "hosts",
        rateId: "infrastructure-host",
        detail:
          apmHosts > 0
            ? `${num(infraHosts)} hosts sending metrics, less ${num(apmHosts)} on App & Infra. Includes ${infraAllowance}.`
            : `${num(infraHosts)} hosts sending metrics. Includes ${infraAllowance}.`,
      }),
      ...bill.line({
        bucket: "traces",
        label:
          infraHosts > 0
            ? "App & Infra bundle, hosts with tracing (metrics and APM)"
            : "App & Infra bundle, hosts with tracing",
        quantity: apmHosts,
        unit: "hosts",
        rateId: "app-infra-host",
        detail:
          `${num(d.infra.hosts)} hosts × ${num(clampShare(w.infra.tracedHostShare) * 100)}% running traced services, rounded up. ` +
          `Each includes ${TRACE_MB_PER_MINUTE_PER_HOST} MB of spans a minute and ${CONTAINERS_PER_HOST} containers sending spans. ` +
          `Trace volume: ${num(traceMbPerMinute)} MB a minute sent against ${num(traceAllotmentMb)} MB included.` +
          (infraHosts > 0 ? ` Metrics on these hosts are covered too, with ${infraAllowance}.` : ""),
      }),
    );

    // Logs: the bundles carry a connector to logs held in the Splunk platform, not log storage.
    if (d.logs.gbPerMonth > 0) {
      unpriced.push({
        bucket: "logs",
        reason:
          "The Observability Cloud bundles hold no logs. Their Log Observer Connect reads logs kept in Splunk Cloud Platform or Splunk Enterprise, and Splunk prices those by quote.",
      });
    }

    // Metrics: the per-host allotments, pooled across every host that sends metrics.
    if (metricsSent && infraHosts === 0) {
      unpriced.push({
        bucket: "metrics",
        reason:
          "Splunk's public price for metrics is per host and this workload has no hosts. Its usage-based plan, billed per metric time series, has no public price.",
      });
    }
    if (infraHosts > 0) {
      const containerAllotment = infraHosts * CONTAINERS_PER_HOST;
      if (d.infra.containers > containerAllotment) {
        unpriced.push({
          bucket: "metrics",
          reason: `${num(d.infra.containers - containerAllotment)} containers are past the ${num(containerAllotment)} included (${CONTAINERS_PER_HOST} per host). Splunk sells more container capacity but publishes no price for it.`,
        });
      }
      const customAllotment = infraHosts * CUSTOM_METRICS_PER_HOST;
      if (d.metrics.customSeries > customAllotment) {
        unpriced.push({
          bucket: "metrics",
          reason: `${compact(d.metrics.customSeries - customAllotment)} custom metric series are past the ${compact(customAllotment)} included (${CUSTOM_METRICS_PER_HOST} per host). Splunk charges each extra custom series separately and publishes no price for it.`,
        });
      }
    }

    // Traces: trace volume and containers per APM host.
    if (tracesSent && apmHosts === 0) {
      unpriced.push({
        bucket: "traces",
        reason:
          "Splunk's public price for APM is per host and no hosts are marked as running traced services. Its usage-based plan, billed per trace analyzed per minute, has no public price.",
      });
    }
    if (apmHosts > 0) {
      if (traceMbPerMinute > traceAllotmentMb * (1 + 1e-9)) {
        unpriced.push({
          bucket: "traces",
          reason: `Spans come to ${num(traceMbPerMinute)} MB a minute, past the ${num(traceAllotmentMb)} MB included (${TRACE_MB_PER_MINUTE_PER_HOST} MB per traced host). Splunk publishes no price for more trace volume.`,
        });
      }
      if (w.infra.containersPerHost > CONTAINERS_PER_HOST) {
        unpriced.push({
          bucket: "traces",
          reason: `Up to ${num(apmHosts * w.infra.containersPerHost)} containers on traced hosts could send spans, past the ${num(apmHosts * CONTAINERS_PER_HOST)} included (${CONTAINERS_PER_HOST} per traced host). Splunk's APM container add-on has no public price.`,
        });
      }
    }

    // The per-host price is for a machine up to a memory size.
    if ((infraHosts > 0 || apmHosts > 0) && w.infra.memoryGibPerHost > HOST_MEMORY_LIMIT_GB) {
      unpriced.push({
        bucket: "platform",
        reason: `Hosts average ${num(w.infra.memoryGibPerHost)} GiB of memory. Splunk's suite terms define a host as a machine with up to ${HOST_MEMORY_LIMIT_GB} GB and do not say how larger machines are counted, so the host fees shown may be low.`,
      });
    }

    // Retention the host fees buy: metrics at one-minute resolution for 13 months,
    // raw traces for the 8-day default (15 and 30 days are on request, unpriced).
    const kept: { tracesDays?: number; metricsMonths?: number } = {};
    const assumptions: string[] = [];
    if (infraHosts > 0 && d.metrics.retentionMonths !== METRIC_MONTHS) {
      kept.metricsMonths = METRIC_MONTHS;
      if (d.metrics.retentionMonths > METRIC_MONTHS) {
        assumptions.push(
          `Metrics are kept ${METRIC_MONTHS} months, the longest retention Splunk lists. The ${num(d.metrics.retentionMonths)} months asked for is longer.`,
        );
      }
    }
    if (apmHosts > 0 && d.traces.retentionDays !== DEFAULT_TRACE_DAYS) {
      kept.tracesDays = DEFAULT_TRACE_DAYS;
      if (d.traces.retentionDays > DEFAULT_TRACE_DAYS) {
        const asked = d.traces.retentionDays;
        const longest = TRACE_RETENTION_DAYS[TRACE_RETENTION_DAYS.length - 1];
        const option = smallestCovering(TRACE_RETENTION_DAYS, (days) => days, asked);
        const gap =
          asked > longest
            ? `The ${num(asked)} days asked for is past its longest option, ${longest} days.`
            : option === asked
              ? `The ${num(asked)} days asked for is an option Splunk sets up on request.`
              : `The ${num(asked)} days asked for needs the ${option}-day option, which Splunk sets up on request.`;
        assumptions.push(
          `Traces are kept ${DEFAULT_TRACE_DAYS} days, Splunk's default raw trace retention. ${gap} Splunk publishes no price for retention past the default.`,
        );
      }
    }
    assumptions.push(
      'The pricing page shows "starts at" prices and names no edition. They are paired here with the lower of Splunk\'s two editions, Commercial Edition, whose bundles carry the Standard per-host entitlements.',
    );
    if (infraHosts > 0 && apmHosts > 0) {
      assumptions.push(
        infraOnlyHosts > 0
          ? `Hosts that run traced services are priced at the App & Infra bundle (${usdRate(bill.usd("app-infra-host"))} a host) and the rest at the Infrastructure bundle (${usdRate(bill.usd("infrastructure-host"))} a host). Splunk's pages do not say whether one subscription can mix the two.`
          : `Every host runs traced services, so all of them are priced at the App & Infra bundle (${usdRate(bill.usd("app-infra-host"))} a host).`,
        "The App & Infra fee is shown under traces. It also covers infrastructure metrics on those hosts.",
      );
    } else if (apmHosts > 0) {
      assumptions.push(
        "Splunk sells APM separately but lists no price for it. Traced hosts are priced at App & Infra, the lowest listed bundle that includes APM.",
      );
    }
    assumptions.push(
      "Splunk's agent is a distribution of the OpenTelemetry Collector, and Splunk lists no separate price for OTLP. Host fees apply to every host that reports metrics or sends spans.",
    );
    if (infraHosts > 0) {
      assumptions.push(
        `Splunk's billing docs count host and container metrics, including those Collector receivers collect out of the box, under the host fee, and every other series as custom. The ${compact(d.metrics.hostSeries)} host, container and Kubernetes series are treated as covered, and the ${compact(d.metrics.customSeries)} other series are compared with the custom allotment. The docs name Splunk's Collector distribution as the source of default metrics and do not say how an upstream Collector is counted.`,
      );
      if (w.metrics.intervalSeconds < 60) {
        assumptions.push(
          `Metrics arrive every ${num(w.metrics.intervalSeconds)} s. Splunk keeps data finer than one minute for ${FINE_METRIC_DAYS} days at Standard edition and the one-minute roll-ups for ${METRIC_MONTHS} months.`,
        );
      }
      if (w.metrics.intervalSeconds < DEFAULT_RESOLUTION_SECONDS) {
        assumptions.push(
          `Splunk processes metrics at ${DEFAULT_RESOLUTION_SECONDS}-second resolution unless a series is marked high-resolution. High-resolution series have a separate allotment, which is not checked here.`,
        );
      }
    }
    if (apmHosts > 0) {
      assumptions.push(
        "Trace volume is counted as uncompressed span bytes, the measure Splunk's docs describe. Splunk gives the allotment in MB without defining it, and it is read here as 10^6 bytes.",
      );
    }

    return {
      lines,
      kept: Object.keys(kept).length > 0 ? kept : undefined,
      assumptions,
      included: [
        "Infrastructure bundle: Infrastructure Monitoring, Network Explorer, synthetic uptime tests and Log Observer Connect",
        "App & Infra bundle: all of that plus APM with AlwaysOn Profiling and synthetic API tests",
        `Per host: ${CONTAINERS_PER_HOST} containers and ${CUSTOM_METRICS_PER_HOST} custom metric series. Per APM host: ${TRACE_MB_PER_MINUTE_PER_HOST} MB of spans a minute`,
        `Metrics kept ${METRIC_MONTHS} months at one-minute resolution and raw traces kept ${DEFAULT_TRACE_DAYS} days`,
        "No per-user or per-query fee is listed for Observability Cloud",
      ],
      notIncluded: [
        "Log ingestion, storage and search, which run in Splunk Cloud Platform or Splunk Enterprise and are priced by quote",
        "Containers, custom metrics and trace volume past the per-host allotments, which Splunk sells without a public price",
        "Overage on APM MetricSets or profiling volume. The workload has no inputs for them",
        "Enterprise edition and its larger per-host allotments, priced by quote",
        "Real user monitoring and browser synthetic tests, which need the End-to-End bundle",
      ],
      notes: [
        'Both prices are "starts at" prices. Splunk publishes no full rate card and says volume discounts are available, so the contract sets the final price.',
        "Splunk publishes these prices billed annually only, so the monthly term shows the same figures.",
        "Splunk bills the monthly average of hourly counts for infrastructure and of per-minute counts for APM.",
        "Allotments are pooled. The limit is the per-host figure times the hosts on the plan.",
        `Usage above a subscription limit is charged at ${OVERAGE_PERCENT}% of list price for that item, or Splunk may block new monitors.`,
        `A histogram sent as histogram data points counts as ${SERIES_PER_HISTOGRAM} custom metric series.`,
        "The export interval does not change the bill on host-based plans.",
        "On Kubernetes, keep the Kubernetes attributes processor in the Collector. Splunk uses its attributes to count hosts and containers.",
        `Splunk's Free Edition covers Agent Observability on up to ${FREE_EDITION_HOSTS} hosts. Its docs do not list Infrastructure Monitoring or APM, so it is not modeled.`,
      ],
      unpriced,
    };
  },
};
