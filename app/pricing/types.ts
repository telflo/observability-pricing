/**
 * Types for the observability pricing calculator.
 *
 * One vendor-neutral description of a telemetry workload goes in; each vendor
 * adapter turns it into that vendor's billing units and returns the bill as
 * line items. Every line points at a published rate, and every rate points at
 * the page it was read from, so a reader can check any number.
 *
 * Conventions (printed on the page, fixed here):
 *   - a month is 30 days (720 hours)
 *   - a GB is 10^9 bytes; vendors that bill GiB are converted explicitly
 *   - volumes are uncompressed bytes as exported by an OpenTelemetry Collector
 *     over OTLP, before any vendor-side enrichment
 *   - prices are public list prices in US dollars
 */

export type Signal = "logs" | "metrics" | "traces" | "profiles";

/** Where a cost lands on the bill: one of the signals, or a fee tied to none. */
export type Bucket = Signal | "platform";

export const SIGNALS: Signal[] = ["logs", "metrics", "traces", "profiles"];
export const BUCKETS: Bucket[] = ["logs", "metrics", "traces", "profiles", "platform"];

export interface Workload {
  /**
   * Which signals go to this vendor. Split routing prices a vendor with some
   * switched off; a signal that is off must cost nothing, and fees that exist
   * only to unlock it (for example a per-host APM fee) must not be charged.
   */
  send: Record<Signal, boolean>;
  logs: {
    /** Uncompressed GB per day (10^9 bytes). */
    gbPerDay: number;
    /** Average bytes per log record, used by vendors that bill per event. */
    avgRecordBytes: number;
    /** Days the logs must stay searchable. */
    retentionDays: number;
    /**
     * Share (0-1) of log volume that must stay searchable for the whole
     * retention window. The rest is still ingested but need not be indexed.
     * Vendors with one tier ignore this and keep everything searchable.
     */
    searchableShare: number;
  };
  metrics: {
    /** Active time series, all of them: host, container and application. */
    activeSeries: number;
    /** Export interval in seconds (one data point per series per interval). */
    intervalSeconds: number;
    /** Bytes per data point, used only by vendors that bill metrics by GB. */
    bytesPerDataPoint: number;
    /**
     * Share (0-1) of the series that are standard host, container and
     * Kubernetes metrics, as the Collector's hostmetrics, kubeletstats and
     * similar receivers produce them. Vendors with a per-host fee often cover
     * these in the fee and bill only the rest as custom metrics.
     */
    hostSeriesShare: number;
    /** Months the metrics must be kept. */
    retentionMonths: number;
  };
  traces: {
    /** Spans per second reaching the platform, after any sampling upstream. */
    spansPerSecond: number;
    /** Average bytes per span. */
    avgSpanBytes: number;
    /** Days the spans must stay searchable. */
    retentionDays: number;
    /** Share (0-1) of spans that must stay searchable; see logs.searchableShare. */
    searchableShare: number;
  };
  /**
   * Continuous profiling. Off in every preset: few vendors publish a price,
   * so switching it on sets the others apart as partly priced.
   */
  profiles: {
    /** Share (0-1) of hosts running a continuous profiler. */
    profiledHostShare: number;
    /**
     * Stack samples per second from one profiled host. The OpenTelemetry
     * eBPF profiler samples each busy CPU about 20 times a second.
     */
    samplesPerSecondPerHost: number;
    /** Bytes per sample as sent, used only by vendors that bill profiles by GB. */
    bytesPerSample: number;
  };
  infra: {
    /** Hosts or Kubernetes nodes emitting this telemetry. */
    hosts: number;
    /** Average containers per host. */
    containersPerHost: number;
    /** Share (0-1) of hosts that run traced services. */
    tracedHostShare: number;
    /** Average memory per host in GiB (some vendors bill host monitoring by memory). */
    memoryGibPerHost: number;
  };
  /** People who need full access: querying, dashboards, alerts. */
  users: number;
}

export interface Settings {
  /** "annual": a one-year commitment. "monthly": no commitment, pay as you go. */
  term: "annual" | "monthly";
  /** Where the data is stored. Only matters at vendors that price by region. */
  region: "us" | "eu";
  /**
   * How hard the data is queried. Only matters at vendors that charge for
   * queries or scanned data; see SCAN_MULTIPLE in units.ts.
   */
  queryLoad: "light" | "typical" | "heavy";
}

/** Quantities every adapter needs, derived once from the workload. */
export interface Derived {
  logs: {
    gbPerMonth: number;
    recordsPerMonth: number;
    /** GB per month that must be searchable (gbPerMonth x searchableShare). */
    searchableGbPerMonth: number;
    searchableRecordsPerMonth: number;
    /** GB held at steady state: gbPerDay x retentionDays. */
    storedGb: number;
    retentionDays: number;
  };
  metrics: {
    activeSeries: number;
    /** activeSeries x hostSeriesShare: standard host, container and Kubernetes series. */
    hostSeries: number;
    /** The rest: application and other custom series. */
    customSeries: number;
    dataPointsPerMinute: number;
    dataPointsPerMonth: number;
    /** dataPointsPerMonth x bytesPerDataPoint, in GB. */
    gbPerMonth: number;
    retentionMonths: number;
  };
  traces: {
    spansPerMonth: number;
    gbPerMonth: number;
    searchableSpansPerMonth: number;
    searchableGbPerMonth: number;
    /** GB held at steady state: daily GB x retentionDays. */
    storedGb: number;
    retentionDays: number;
  };
  profiles: {
    /** hosts x profiledHostShare, rounded up. Zero when profiles are not sent. */
    profiledHosts: number;
    /** profiledHosts x 720 hours. */
    profiledHostHours: number;
    /** profiledHosts x samplesPerSecondPerHost x seconds in a month. */
    samplesPerMonth: number;
    /** samplesPerMonth x bytesPerSample, in GB. */
    gbPerMonth: number;
  };
  infra: {
    /** The raw host count, whatever is being sent. */
    hosts: number;
    /**
     * Hosts a per-host infrastructure fee applies to: all of them when
     * metrics are sent, zero when they are not.
     */
    monitoredHosts: number;
    /** hosts x tracedHostShare, rounded up. Zero when traces are not sent. */
    tracedHosts: number;
    /** hosts x containersPerHost. */
    containers: number;
    /** hosts x memoryGibPerHost. */
    memoryGib: number;
  };
  users: number;
}

/** A page the rates were read from. */
export interface Source {
  id: string;
  /** What the page is, e.g. "Pricing page" or "Billing docs: custom metrics". */
  label: string;
  url: string;
}

/**
 * One published price. Adapters compute from these and the page prints them,
 * so the number used and the number shown cannot drift apart.
 */
export interface Rate {
  id: string;
  /** What is priced, e.g. "Log ingestion". */
  label: string;
  /** US dollars per unit. */
  usd: number;
  /** The billing unit in the vendor's words, e.g. "GB ingested". */
  unit: string;
  sourceId: string;
  /**
   * "list": a published rate. "starting-from": the vendor publishes only a
   * from-price. "promotional": a discounted price shown next to list.
   * "example": the vendor calls the figure an example, the contract governs.
   */
  basis: "list" | "starting-from" | "promotional" | "example";
  /** Free-text qualifier: term, region, tier range, retention it applies to. */
  note?: string;
}

/**
 * One line of a vendor's bill. For a usage line, amount equals
 * quantity x rate.usd. A "top-up" line is the gap between usage and a plan
 * minimum: its rate is the minimum, its quantity is 1 and its amount is the gap.
 */
export interface LineItem {
  kind?: "usage" | "top-up";
  bucket: Bucket;
  /** What is being charged, e.g. "Log ingestion". */
  label: string;
  /** Billable quantity in the rate's unit, after free allowances. */
  quantity: number;
  /** The quantity's unit, short, e.g. "GB", "M events", "hosts", "k series". */
  unit: string;
  /** Rate id from the adapter's rates table. */
  rateId: string;
  /** Monthly US dollars. */
  amount: number;
  /** How the quantity was reached, e.g. "100 GB/day x 30 days, less 50 GB free". */
  detail?: string;
}

/** A part of the workload the vendor publishes no price for. */
export interface Unpriced {
  bucket: Bucket;
  /** Plain reason, e.g. "Log pricing is quote-only (Splunk Cloud Platform)". */
  reason: string;
}

export interface PriceInput {
  w: Workload;
  d: Derived;
  s: Settings;
}

/**
 * The retention a price actually buys. An adapter sets a field when what it
 * priced differs from what was asked: a vendor that keeps metrics 30 days
 * returns metricsMonths: 1 for a 13-month ask. The page marks the row, so a
 * shorter retention is never ranked silently against a longer one.
 */
export interface Kept {
  logsDays?: number;
  tracesDays?: number;
  metricsMonths?: number;
}

/** A signal kept for less time than the visitor asked for. */
export interface RetentionGap {
  signal: Signal;
  asked: number;
  kept: number;
  unit: "days" | "months";
}

export interface PriceOutput {
  lines: LineItem[];
  /** Set per signal when the priced retention differs from the ask; see Kept. */
  kept?: Kept;
  /** Vendor-specific conversions and choices made to reach the lines. */
  assumptions: string[];
  /** What the price already covers: retention, queries, seats. */
  included: string[];
  /** Real costs this estimate leaves out. */
  notIncluded: string[];
  /** Billing mechanics a buyer should know about. */
  notes: string[];
  /** Sent signals (or fees) that have no public price. */
  unpriced?: Unpriced[];
}

export type VendorGroup = "suite" | "cloud" | "open-source" | "otel-native" | "logs";

export interface VendorAdapter {
  /** Stable kebab-case id, used in URLs. */
  id: string;
  name: string;
  group: VendorGroup;
  /** The plan and options the estimate assumes, e.g. "Pro, billed annually". */
  plan: (s: Settings) => string;
  /** The vendor's main pricing page. */
  pricingUrl: string;
  /** The day the rates were last read from the vendor's pages (YYYY-MM-DD). */
  checkedOn: string;
  sources: Source[];
  rates: Rate[];
  /**
   * Per signal: "priced" (public price modeled), "unpriced" (accepted, but
   * no public price) or "unsupported" (the product does not take the signal).
   */
  coverage: Record<Signal, "priced" | "unpriced" | "unsupported">;
  /**
   * Optional wording for a signal that is not "priced", shown in place of
   * the generic "publishes no price" (for example "included in the host fee").
   */
  coverageNote?: Partial<Record<Signal, string>>;
  price: (input: PriceInput) => PriceOutput;
}

/** What the engine returns for one vendor. */
export interface VendorEstimate {
  vendor: VendorAdapter;
  /** Sum of the line amounts, monthly US dollars. */
  monthly: number;
  byBucket: Record<Bucket, number>;
  lines: LineItem[];
  assumptions: string[];
  included: string[];
  notIncluded: string[];
  notes: string[];
  unpriced: Unpriced[];
  /** Signals this price keeps for less time than was asked. */
  shortRetention: RetentionGap[];
  /**
   * True when every signal being sent has a public price. Incomplete
   * estimates are shown apart from the ranking: their total is missing a part.
   */
  complete: boolean;
}
