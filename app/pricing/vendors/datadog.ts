/**
 * Datadog: Infrastructure Pro, APM (base tier) and Log Management with
 * standard indexing, on the default per-series custom metric pricing.
 *
 * Host-based, with pooled allotments. Every host that reports metrics is an
 * Infrastructure Pro host and adds 100 custom metrics and 5 containers to the
 * account's pool. Every host that sends traces is an APM host and adds 150 GB
 * of ingested spans and 1 million indexed spans. Usage above a pool bills per
 * unit. Host, container and Kubernetes series from Datadog's supported
 * OpenTelemetry receivers are not custom metrics (its OpenTelemetry
 * integrations docs), so only d.metrics.customSeries is billed as custom.
 * Logs bill twice: per GB ingested, then per million events indexed at a
 * rate set by retention.
 *
 * The price list has three columns. "annual" uses Billed Annually and
 * "monthly" uses Billed Month-to-month. The On-demand column is not used. The
 * list is priced per Datadog site: the US sites and EU1 show the same prices,
 * so the region setting is ignored. UK1, AP1, AP2 and US1-FED are priced
 * higher and are not modeled. Rates read from datadoghq.com/pricing/list and
 * datadoghq.com/pricing on the checkedOn date.
 */
import { billFor, smallestCovering } from "../bill";
import { compact, num, usdRate } from "../format";
import type { Kept, LineItem, Rate, Settings, Source, VendorAdapter } from "../types";
import { DAYS_PER_MONTH } from "../units";

const sources: Source[] = [
  { id: "price-list", label: "Price list", url: "https://www.datadoghq.com/pricing/list/" },
  { id: "pricing", label: "Pricing page and its FAQs", url: "https://www.datadoghq.com/pricing/" },
  {
    id: "allotments",
    label: "Allotments per host",
    url: "https://www.datadoghq.com/pricing/allotments/",
  },
  {
    id: "billing-units",
    label: "Billing docs: pricing units and host counting",
    url: "https://docs.datadoghq.com/account_management/billing/pricing/",
  },
  {
    id: "billing-custom-metrics",
    label: "Billing docs: custom metrics",
    url: "https://docs.datadoghq.com/account_management/billing/custom_metrics/",
  },
  {
    id: "billing-containers",
    label: "Billing docs: containers",
    url: "https://docs.datadoghq.com/account_management/billing/containers/",
  },
  {
    id: "billing-apm",
    label: "Billing docs: APM, with worked examples",
    url: "https://docs.datadoghq.com/account_management/billing/apm_tracing_profiler/",
  },
  {
    id: "trace-retention",
    label: "Docs: trace retention and which indexed spans are billed",
    url: "https://docs.datadoghq.com/tracing/trace_pipeline/trace_retention/",
  },
  {
    id: "data-retention",
    label: "Docs: data retention periods",
    url: "https://docs.datadoghq.com/data_security/data_retention_periods/",
  },
  {
    id: "otel-metric-pricing",
    label: "OpenTelemetry docs: metrics from supported receivers at no extra cost",
    url: "https://docs.datadoghq.com/opentelemetry/integrations/",
  },
  {
    id: "otel-collector",
    label: "OpenTelemetry docs: sending from a Collector over OTLP",
    url: "https://docs.datadoghq.com/opentelemetry/setup/collector_exporter/",
  },
  {
    id: "profiler-pricing",
    label: "Pricing page: Continuous Profiler",
    url: "https://www.datadoghq.com/pricing/?product=continuous-profiler",
  },
  {
    id: "metric-name-pricing",
    label: "Billing docs: Metric Name pricing",
    url: "https://docs.datadoghq.com/account_management/billing/metric_name_pricing/",
  },
];

type Term = Settings["term"];
/** Profiled containers each profiled host includes, summed across profiled hosts. */
const PROFILED_CONTAINERS_PER_HOST = 4;

const TERMS: Term[] = ["annual", "monthly"];
const TERM_NOTE: Record<Term, string> = {
  annual: "Billed Annually column",
  monthly: "Billed Month-to-month column",
};
const SAME_IN_BOTH = "Same price in the Billed Annually and Billed Month-to-month columns";

/** Custom metrics each Infrastructure Pro host adds to the account's pool. */
const CUSTOM_METRICS_PER_HOST = 100;
/** Custom metrics above the pool are sold by the hundred. */
const CUSTOM_METRIC_BLOCK = 100;
/** Containers each Infrastructure Pro host adds to the account's pool. */
const CONTAINERS_PER_HOST = 5;
/** GB of ingested spans each APM host adds to the pool, per month. */
const INGESTED_SPAN_GB_PER_APM_HOST = 150;
/** Indexed spans each APM host adds to the pool, per month. */
const INDEXED_SPANS_PER_APM_HOST = 1_000_000;
/** Minutes every ingested span stays searchable, indexed or not. */
const LIVE_SEARCH_MINUTES = 15;
/** Months Datadog keeps metrics. No other option is published. */
const METRIC_RETENTION_MONTHS = 15;

/** Standard indexing: dollars per million log events, by index retention. */
const LOG_INDEX_LADDER: { days: number; annual: number; monthly: number }[] = [
  { days: 3, annual: 1.06, monthly: 1.27 },
  { days: 7, annual: 1.27, monthly: 1.52 },
  { days: 15, annual: 1.7, monthly: 2.04 },
  { days: 30, annual: 2.5, monthly: 3 },
];

/** Indexed spans: dollars per million, by retention. */
const SPAN_INDEX_LADDER: { days: number; annual: number; monthly: number }[] = [
  { days: 7, annual: 1.27, monthly: 1.52 },
  { days: 15, annual: 1.7, monthly: 2.04 },
  { days: 30, annual: 2.5, monthly: 3 },
];

const LONGEST_LOG_DAYS = LOG_INDEX_LADDER[LOG_INDEX_LADDER.length - 1].days;
const LONGEST_SPAN_DAYS = SPAN_INDEX_LADDER[SPAN_INDEX_LADDER.length - 1].days;

const rates: Rate[] = [
  {
    id: "infra-pro-annual",
    label: "Infrastructure Pro",
    usd: 15,
    unit: "infra host per month",
    sourceId: "price-list",
    basis: "list",
    note: TERM_NOTE.annual,
  },
  {
    id: "infra-pro-monthly",
    label: "Infrastructure Pro",
    usd: 18,
    unit: "infra host per month",
    sourceId: "price-list",
    basis: "list",
    note: TERM_NOTE.monthly,
  },
  {
    id: "containers",
    label: "Container monitoring, prepaid containers",
    usd: 1,
    unit: "container per month",
    sourceId: "price-list",
    basis: "list",
    note: `Containers above the ${CONTAINERS_PER_HOST} allotted per host. ${SAME_IN_BOTH}`,
  },
  {
    id: "custom-metrics",
    label: "Custom metrics",
    usd: 5,
    unit: `${CUSTOM_METRIC_BLOCK} custom metrics per month`,
    sourceId: "price-list",
    basis: "list",
    note: `Custom metrics above the ${CUSTOM_METRICS_PER_HOST} allotted per host. ${SAME_IN_BOTH}`,
  },
  {
    id: "logs-ingest",
    label: "Log ingestion",
    usd: 0.1,
    unit: "GB ingested",
    sourceId: "price-list",
    basis: "list",
    note: `Uncompressed GB. ${SAME_IN_BOTH}`,
  },
  ...LOG_INDEX_LADDER.flatMap((t) =>
    TERMS.map(
      (term): Rate => ({
        id: `logs-index-${t.days}d-${term}`,
        label: `Indexed log events, ${t.days}-day retention`,
        usd: t[term],
        unit: "million indexed log events",
        sourceId: "price-list",
        basis: "list",
        note: TERM_NOTE[term],
      }),
    ),
  ),
  {
    id: "apm-host-annual",
    label: "APM, with Infrastructure Monitoring attached",
    usd: 31,
    unit: "APM host per month",
    sourceId: "price-list",
    basis: "list",
    note: TERM_NOTE.annual,
  },
  {
    id: "apm-host-monthly",
    label: "APM, with Infrastructure Monitoring attached",
    usd: 36,
    unit: "APM host per month",
    sourceId: "price-list",
    basis: "list",
    note: TERM_NOTE.monthly,
  },
  {
    id: "apm-host-standalone",
    label: "APM, standalone",
    usd: 36,
    unit: "APM host per month",
    sourceId: "pricing",
    basis: "list",
    note: "Without Infrastructure Monitoring. The APM FAQ gives one figure, billed annually or on demand",
  },
  {
    id: "profiler-host-annual",
    label: "Continuous Profiler, standalone",
    usd: 19,
    unit: "profiled host per month",
    sourceId: "profiler-pricing",
    basis: "list",
    note: `${TERM_NOTE.annual}. Includes ${PROFILED_CONTAINERS_PER_HOST} profiled containers per host, summed across profiled hosts`,
  },
  {
    id: "profiler-host-monthly",
    label: "Continuous Profiler, standalone",
    usd: 23,
    unit: "profiled host per month",
    sourceId: "profiler-pricing",
    basis: "list",
    note: `${TERM_NOTE.monthly}. Includes ${PROFILED_CONTAINERS_PER_HOST} profiled containers per host, summed across profiled hosts`,
  },
  {
    id: "profiler-container",
    label: "Profiled containers above the allotment",
    usd: 2,
    unit: "profiled container per month",
    sourceId: "price-list",
    basis: "list",
    note: "Prepaid rate. Without a commitment Datadog bills $0.004 per profiled container per hour",
  },
  {
    id: "spans-ingest",
    label: "Ingested spans",
    usd: 0.1,
    unit: "GB ingested",
    sourceId: "price-list",
    basis: "list",
    note: `Ingested spans above the ${INGESTED_SPAN_GB_PER_APM_HOST} GB allotted per APM host. ${SAME_IN_BOTH}`,
  },
  ...SPAN_INDEX_LADDER.flatMap((t) =>
    TERMS.map(
      (term): Rate => ({
        id: `spans-index-${t.days}d-${term}`,
        label: `Indexed spans, ${t.days}-day retention`,
        usd: t[term],
        unit: "million indexed spans",
        sourceId: "price-list",
        basis: "list",
        note: TERM_NOTE[term],
      }),
    ),
  ),
];

const counted = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;
const hostCount = (n: number) => counted(n, "host", "hosts");
const apmHostCount = (n: number) => counted(n, "APM host", "APM hosts");
const percent = (part: number, whole: number) => `${num(whole > 0 ? (part / whole) * 100 : 0, 1)}%`;

export const datadog: VendorAdapter = {
  id: "datadog",
  name: "Datadog",
  group: "suite",
  plan: (s) =>
    `Infra Pro, APM and Logs, ${s.term === "annual" ? "billed annually" : "month-to-month"}`,
  pricingUrl: "https://www.datadoghq.com/pricing/",
  checkedOn: "2026-11-12",
  sources,
  rates,
  coverage: { logs: "priced", metrics: "priced", traces: "priced", profiles: "priced" },

  price({ w, d, s }) {
    const bill = billFor(rates);
    const lines: LineItem[] = [];
    const term = s.term;
    const kept: Kept = {};
    /** Retention shorter than the ask: these lead the assumptions. */
    const shorter: string[] = [];
    const assumptions: string[] = [];

    const logsSent = d.logs.gbPerMonth > 0;
    const metricsSent = d.metrics.activeSeries > 0;
    const tracesSent = d.traces.spansPerMonth > 0;

    // A host is billed for a product only when that product's signal arrives.
    const infraHosts = metricsSent ? d.infra.monitoredHosts : 0;
    const apmHosts = tracesSent ? d.infra.tracedHosts : 0;
    const profiledHosts = d.profiles.profiledHosts;
    // The list price for APM assumes Infrastructure Monitoring on the same
    // hosts. Without it Datadog sells APM standalone at a separate price.
    const apmStandalone = apmHosts > 0 && infraHosts === 0;

    const path = ["Telemetry is priced as sent over OTLP from an OpenTelemetry Collector."];
    if (tracesSent) {
      path.push(
        "Datadog's pricing FAQ counts a host that sends traces through an OpenTelemetry Collector as an APM host.",
      );
    }
    if (metricsSent) {
      path.push(
        "Datadog bills each host in its Infrastructure list as an infrastructure host, and its Collector docs say a host running the host metrics receiver appears in that list. The billing docs do not mention the Collector, so each host that sends metrics is priced as an Infrastructure Pro host.",
      );
    }
    if (!metricsSent && !tracesSent) {
      path.push("Log Management is sold separately and has no per-host fee.");
    }
    assumptions.push(path.join(" "));

    // Metrics: a fee per host, then containers and custom metrics above what
    // the hosts include.
    lines.push(
      ...bill.line({
        bucket: "metrics",
        label: "Infrastructure Pro hosts",
        quantity: infraHosts,
        unit: "hosts",
        rateId: `infra-pro-${term}`,
        detail: `${hostCount(infraHosts)} reporting metrics`,
      }),
    );

    const containerAllotment = CONTAINERS_PER_HOST * infraHosts;
    const containers = metricsSent ? d.infra.containers : 0;
    const billableContainers = Math.max(0, containers - containerAllotment);
    lines.push(
      ...bill.line({
        bucket: "metrics",
        label: "Containers above the host allotment",
        quantity: billableContainers,
        unit: "containers",
        rateId: "containers",
        detail: `${num(containers)} containers, less ${CONTAINERS_PER_HOST} per host × ${hostCount(infraHosts)}`,
      }),
    );

    const customSeries = metricsSent ? d.metrics.customSeries : 0;
    const hostSeries = metricsSent ? d.metrics.hostSeries : 0;
    const metricAllotment = CUSTOM_METRICS_PER_HOST * infraHosts;
    const billableMetrics = Math.max(0, customSeries - metricAllotment);
    lines.push(
      ...bill.line({
        bucket: "metrics",
        label: "Custom metrics above the host allotment",
        quantity: billableMetrics / CUSTOM_METRIC_BLOCK,
        unit: `blocks of ${CUSTOM_METRIC_BLOCK}`,
        rateId: "custom-metrics",
        detail: `${compact(customSeries)} custom series, less ${CUSTOM_METRICS_PER_HOST} per host × ${hostCount(infraHosts)}, leaves ${compact(billableMetrics)}`,
      }),
    );

    if (metricsSent) {
      assumptions.push(
        `Datadog's OpenTelemetry docs say metrics from its supported receivers, including host, Docker and Kubernetes metrics, are collected at no extra cost. The ${compact(hostSeries)} host, container and Kubernetes series are not billed as custom metrics. The other ${compact(customSeries)} series are, less ${CUSTOM_METRICS_PER_HOST} per Infrastructure Pro host.`,
      );
      if (customSeries > 0 && billableMetrics === 0) {
        assumptions.push(
          `Custom metrics: ${compact(customSeries)} series fit inside the ${compact(metricAllotment)} included with ${hostCount(infraHosts)}, so none are charged.`,
        );
      }
      if (containers > 0) {
        assumptions.push(
          `Datadog's container billing docs do not mention the Collector. The calculator counts containers reported through a Collector the same way: ${num(containers)} running containers, less ${CONTAINERS_PER_HOST} per Infrastructure Pro host.`,
        );
        if (billableContainers === 0) {
          assumptions.push(
            `Containers: ${num(containers)} fit inside the ${num(containerAllotment)} included with ${hostCount(infraHosts)}, so none are charged.`,
          );
        }
      }
      if (d.metrics.retentionMonths !== METRIC_RETENTION_MONTHS) {
        kept.metricsMonths = METRIC_RETENTION_MONTHS;
        if (d.metrics.retentionMonths > METRIC_RETENTION_MONTHS) {
          shorter.push(
            `Metrics: Datadog keeps metrics for ${METRIC_RETENTION_MONTHS} months and publishes no price for longer retention. This estimate keeps them ${METRIC_RETENTION_MONTHS} months, shorter than the ${num(d.metrics.retentionMonths, 0)} months asked for.`,
          );
        } else {
          assumptions.push(
            `Metrics: Datadog keeps metrics for ${METRIC_RETENTION_MONTHS} months on every plan, longer than the ${num(d.metrics.retentionMonths, 0)} months asked for.`,
          );
        }
      }
    }

    // Logs: every GB pays the ingest fee, then the searchable events pay for
    // indexing at the rate of the retention rung.
    lines.push(
      ...bill.line({
        bucket: "logs",
        label: "Log ingestion",
        quantity: d.logs.gbPerMonth,
        unit: "GB",
        rateId: "logs-ingest",
        detail: `${num(w.logs.gbPerDay)} GB/day × ${DAYS_PER_MONTH} days`,
      }),
    );

    const logTier = smallestCovering(LOG_INDEX_LADDER, (t) => t.days, d.logs.retentionDays);
    lines.push(
      ...bill.line({
        bucket: "logs",
        label: `Log indexing, ${logTier.days}-day retention`,
        quantity: d.logs.searchableRecordsPerMonth / 1e6,
        unit: "M events",
        rateId: `logs-index-${logTier.days}d-${term}`,
        detail: `${compact(d.logs.recordsPerMonth)} log events at ${num(w.logs.avgRecordBytes, 0)} bytes each, ${percent(d.logs.searchableRecordsPerMonth, d.logs.recordsPerMonth)} indexed`,
      }),
    );

    if (logsSent && d.logs.searchableRecordsPerMonth > 0 && logTier.days !== d.logs.retentionDays) {
      kept.logsDays = logTier.days;
      if (d.logs.retentionDays > LONGEST_LOG_DAYS) {
        shorter.push(
          `Logs: Datadog publishes standard indexing prices up to ${LONGEST_LOG_DAYS} days and quotes longer retention on request. This estimate uses the ${LONGEST_LOG_DAYS}-day rate and keeps indexed logs ${LONGEST_LOG_DAYS} days, shorter than the ${num(d.logs.retentionDays, 0)} days asked for.`,
        );
      } else {
        assumptions.push(
          `Logs: ${num(d.logs.retentionDays, 0)} days of retention is priced at the ${logTier.days}-day indexing rate, the nearest option Datadog sells that covers it.`,
        );
      }
    }

    // Traces: a fee per APM host, then ingested GB and indexed spans above
    // what the hosts include.
    lines.push(
      ...bill.line({
        bucket: "traces",
        label: apmStandalone ? "APM hosts, standalone" : "APM hosts",
        quantity: apmHosts,
        unit: "hosts",
        rateId: apmStandalone ? "apm-host-standalone" : `apm-host-${term}`,
        detail: `${hostCount(apmHosts)} sending traces, out of ${num(d.infra.hosts)}`,
      }),
    );

    const spanGbAllotment = INGESTED_SPAN_GB_PER_APM_HOST * apmHosts;
    const billableSpanGb = Math.max(0, d.traces.gbPerMonth - spanGbAllotment);
    const spanGb = `${compact(d.traces.spansPerMonth)} spans × ${num(w.traces.avgSpanBytes, 0)} bytes = ${num(d.traces.gbPerMonth)} GB`;
    lines.push(
      ...bill.line({
        bucket: "traces",
        label: apmHosts > 0 ? "Ingested spans above the host allotment" : "Ingested spans",
        quantity: billableSpanGb,
        unit: "GB",
        rateId: "spans-ingest",
        detail:
          apmHosts > 0
            ? `${spanGb}, less ${INGESTED_SPAN_GB_PER_APM_HOST} GB per APM host × ${hostCount(apmHosts)}`
            : spanGb,
      }),
    );

    const spanTier = smallestCovering(SPAN_INDEX_LADDER, (t) => t.days, d.traces.retentionDays);
    const indexedAllotment = INDEXED_SPANS_PER_APM_HOST * apmHosts;
    const billableIndexedSpans = Math.max(0, d.traces.searchableSpansPerMonth - indexedAllotment);
    const indexedSpans = `${compact(d.traces.searchableSpansPerMonth)} spans indexed (${percent(d.traces.searchableSpansPerMonth, d.traces.spansPerMonth)} of ${compact(d.traces.spansPerMonth)})`;
    lines.push(
      ...bill.line({
        bucket: "traces",
        label:
          apmHosts > 0
            ? `Indexed spans above the host allotment, ${spanTier.days}-day retention`
            : `Indexed spans, ${spanTier.days}-day retention`,
        quantity: billableIndexedSpans / 1e6,
        unit: "M spans",
        rateId: `spans-index-${spanTier.days}d-${term}`,
        detail:
          apmHosts > 0
            ? `${indexedSpans}, less ${compact(INDEXED_SPANS_PER_APM_HOST)} per APM host × ${hostCount(apmHosts)}`
            : indexedSpans,
      }),
    );

    if (tracesSent) {
      if (apmHosts === 0) {
        assumptions.push(
          "Traces: no hosts are marked as running traced services, so no APM host fee or span allotment is applied. Datadog bills each host that sends traces as an APM host.",
        );
      }
      if (apmStandalone) {
        const standalone = bill.usd("apm-host-standalone");
        const attached = bill.usd(`apm-host-${term}`);
        const parts = [
          `APM is priced standalone at ${usdRate(standalone)} per host because no Infrastructure hosts are billed here.`,
        ];
        if (attached !== standalone) {
          parts.push(
            `The ${usdRate(attached)} price applies only with Infrastructure Monitoring on the same hosts.`,
          );
        }
        parts.push(
          "The span allotments are applied to standalone APM hosts as well, since Datadog states them per APM host.",
        );
        assumptions.push(parts.join(" "));
      }
      if (apmHosts > 0 && billableSpanGb === 0) {
        assumptions.push(
          `Ingested spans: ${num(d.traces.gbPerMonth)} GB fit inside the ${num(spanGbAllotment)} GB included with ${apmHostCount(apmHosts)}, so ingestion is not charged.`,
        );
      }
      if (d.traces.searchableSpansPerMonth > 0) {
        if (apmHosts > 0 && billableIndexedSpans === 0) {
          assumptions.push(
            `Indexed spans: ${compact(d.traces.searchableSpansPerMonth)} fit inside the ${compact(indexedAllotment)} included with ${apmHostCount(apmHosts)}, so indexing is not charged.`,
          );
        }
        if (spanTier.days !== d.traces.retentionDays) {
          kept.tracesDays = spanTier.days;
          if (d.traces.retentionDays > LONGEST_SPAN_DAYS) {
            shorter.push(
              `Traces: Datadog publishes indexed span prices up to ${LONGEST_SPAN_DAYS} days and quotes longer retention on request. This estimate uses the ${LONGEST_SPAN_DAYS}-day rate and keeps indexed spans ${LONGEST_SPAN_DAYS} days, shorter than the ${num(d.traces.retentionDays, 0)} days asked for.`,
            );
          } else {
            assumptions.push(
              `Traces: ${num(d.traces.retentionDays, 0)} days of retention is priced at the ${spanTier.days}-day indexed span rate, the nearest option Datadog sells that covers it.`,
            );
          }
        }
        if (apmHosts > 0) {
          assumptions.push(
            `Datadog's allotment pages do not say which retention the ${compact(INDEXED_SPANS_PER_APM_HOST)} indexed spans per APM host apply to. The calculator subtracts them from spans indexed at the ${spanTier.days}-day rate.`,
          );
        }
      }
    }

    // Profiles: the standalone Continuous Profiler, per profiled host, with a
    // pooled container allotment. Every container on a profiled host is
    // counted as profiled.
    if (profiledHosts > 0) {
      lines.push(
        ...bill.line({
          bucket: "profiles",
          label: "Continuous Profiler hosts",
          quantity: profiledHosts,
          unit: "hosts",
          rateId: `profiler-host-${term}`,
          detail: `${hostCount(profiledHosts)} running the profiler, out of ${num(d.infra.hosts)}`,
        }),
      );
      const profiledContainers = profiledHosts * Math.max(0, w.infra.containersPerHost);
      const containerAllotment = profiledHosts * PROFILED_CONTAINERS_PER_HOST;
      lines.push(
        ...bill.line({
          bucket: "profiles",
          label: "Profiled containers above the allotment",
          quantity: Math.max(0, profiledContainers - containerAllotment),
          unit: "containers",
          rateId: "profiler-container",
          detail: `${num(profiledContainers)} containers on profiled hosts, less ${num(containerAllotment)} included (${PROFILED_CONTAINERS_PER_HOST} per host)`,
        }),
      );
      assumptions.push(
        `Profiles: priced as the standalone Continuous Profiler, per profiled host, with every container on a profiled host counted as profiled. Datadog bills profiling per host, so the sample rate and sample size do not change this line.`,
      );
    }

    if (logsSent || tracesSent) {
      assumptions.push(
        "A GB is counted as 10^9 uncompressed bytes as sent. Datadog prices logs per GB of uncompressed data and spans per ingested GB. It publishes no conversion from OTLP size, so the raw size is billed.",
      );
    }

    const included: string[] = [];
    if (metricsSent) {
      included.push(
        `${METRIC_RETENTION_MONTHS} months of metric retention`,
        "Host, container and Kubernetes metrics from Datadog's supported OpenTelemetry receivers",
        `${CUSTOM_METRICS_PER_HOST} custom metrics and ${CONTAINERS_PER_HOST} containers for each Infrastructure Pro host, pooled across hosts`,
      );
    }
    if (tracesSent) {
      if (apmHosts > 0) {
        included.push(
          `${INGESTED_SPAN_GB_PER_APM_HOST} GB of ingested spans and ${compact(INDEXED_SPANS_PER_APM_HOST)} indexed spans a month for each APM host, pooled across APM hosts`,
        );
      }
      included.push(
        `Live search over every ingested span for ${LIVE_SEARCH_MINUTES} minutes`,
        "Spans kept by Datadog's intelligent retention filter, which are not billed as indexed spans",
      );
    }
    if (logsSent) {
      included.push(
        "Log processing, live tail and archiving to your cloud storage, covered by the ingest fee",
      );
    }
    included.push(
      "Dashboards and alerts. The price list has no per-user or per-query charge for these products.",
    );

    const notIncluded: string[] = [];
    if (logsSent) {
      notIncluded.push(
        "Flex Logs, Datadog's tier for longer log retention, which this estimate does not model",
        `Standard log indexing kept longer than ${LONGEST_LOG_DAYS} days, which is priced by quote`,
      );
    }
    if (metricsSent) {
      notIncluded.push(
        "Metric Name pricing, the opt-in alternative to per-series custom metrics, which this estimate does not model. Its rates are set by contract.",
      );
    }
    notIncluded.push(
      profiledHosts > 0
        ? "Higher tiers and add-ons, such as Infrastructure Enterprise, APM Pro, APM Enterprise and Database Monitoring. APM Enterprise includes the Continuous Profiler, and can cost less where the same hosts run APM and the profiler."
        : "Higher tiers and add-ons, such as Infrastructure Enterprise, APM Pro, APM Enterprise, Continuous Profiler and Database Monitoring",
      "Volume, multi-year and negotiated discounts, which Datadog does not publish",
    );

    const notes: string[] = [
      "Annual uses the Billed Annually column of Datadog's price list and monthly uses the Billed Month-to-month column. Usage above a commitment is billed from the On-demand column, which is higher for indexed logs and indexed spans.",
      "The price list shows the same prices for Datadog's US sites and its EU1 site, so the region setting does not change this estimate. Its UK1, AP1 and AP2 sites are priced higher and are not modeled.",
      "The price list has no query charge for metrics, indexed logs or indexed spans, so the query load setting does not change this estimate.",
    ];
    if (metricsSent || tracesSent || profiledHosts > 0) {
      notes.push(
        "Datadog bills hosts on the highest hourly host count of the month after the top 1% of hours are dropped. The estimate uses the host count as entered.",
      );
    }
    if (logsSent) {
      notes.push(
        `Logs are charged twice: ${usdRate(bill.usd("logs-ingest"))} per GB on everything ingested, then per million events on what is indexed. Lowering the searchable share reduces only the indexing charge.`,
      );
    }
    if (metricsSent) {
      notes.push(
        "Custom metrics are billed on the monthly average of distinct series per hour. The export interval does not change the bill.",
        "A histogram or distribution metric counts as five custom metrics for each tag combination in Datadog's billing docs. The calculator counts each active series once.",
        "Containers above the allotment are priced at the prepaid rate. Without a container commitment Datadog bills them by the container-hour from its On-demand column.",
      );
    }
    if (tracesSent) {
      notes.push(
        "Only indexed spans are kept for the retention period. Lowering the searchable share of spans reduces the indexing charge and leaves ingestion unchanged.",
        "Datadog has a separate per-GB price for OTLP sent directly from managed platforms such as Cloudflare and Vercel. This estimate does not use it.",
      );
    }
    if (apmStandalone && term === "monthly") {
      notes.push(
        `Datadog publishes one standalone APM price (${usdRate(bill.usd("apm-host-standalone"))} per host), billed annually or on demand, and no month-to-month figure. The month-to-month estimate uses the same figure.`,
      );
    }

    return {
      lines,
      kept,
      assumptions: [...shorter, ...assumptions],
      included,
      notIncluded,
      notes,
    };
  },
};
