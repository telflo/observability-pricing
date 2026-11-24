/**
 * Declarative vendors. A platform whose pricing is simple enough is a data
 * object, not a price() function: one meter per signal, a free allowance, a
 * fixed retention or a retention ladder, maybe a minimum. defineVendor() turns
 * the object into an ordinary VendorAdapter, so the engine, the pages and the
 * contract checks see no difference. Its worked examples live in the object
 * too, and specs.test.ts runs them, so a contributor writes no test file.
 *
 * Three ways to write a platform, simplest first:
 *   1. a spec: data only
 *   2. a spec with `extra`: data, plus one function for the rule that does not fit
 *   3. a handwritten price() function (plan selection, pooled host allotments,
 *      two billing modes)
 *
 * The rule for this file: a pricing rule that one platform has is written in
 * that platform's file, in `extra`. It becomes a field here only when a
 * second platform needs it. See CONTRIBUTING.md.
 */
import type { Bill } from "./bill";
import { billFor, smallestCovering } from "./bill";
import { compact, duration, num, usdRate } from "./format";
import type {
  Bucket,
  Derived,
  Kept,
  LineItem,
  PriceInput,
  Rate,
  Settings,
  Signal,
  Source,
  VendorAdapter,
  VendorGroup,
  Workload,
} from "./types";
import { DAYS_PER_MONTH, SCAN_MULTIPLE } from "./units";

export type LogsUnit = "gb" | "million-records";
export type TracesUnit = "gb" | "million-spans";
export type MetricsUnit = "gb" | "million-data-points" | "thousand-series";
export type ProfilesUnit = "gb" | "million-samples";
type Unit = LogsUnit | TracesUnit | MetricsUnit | ProfilesUnit;

/** A rate id from `rates`, or one per billing term or per region. */
export type RateRef = string | { annual: string; monthly: string } | { us: string; eu: string };

/** When a line of text applies. A list means any of them. */
export type When = Signal | "scan" | "extraRetention" | "partlySearchable" | "topUp";

/**
 * A sentence for the receipt. `{rate:<id>}` is replaced by that rate's price,
 * so a quoted figure can never drift from the rates table. An unknown id
 * throws when the module loads.
 */
export type Text = string | { when: When | When[]; text: string };

export interface Rung {
  /** Days for logs and traces, months for metrics. */
  at: number;
  usd: number;
}

/**
 * One rate per retention option. Generates rates `<signal>-<at>d` (or
 * `-<at>mo` for metrics), prices the smallest option that covers the
 * retention asked for (or the largest), and reports what was bought.
 */
export interface Ladder {
  source: string;
  steps: Rung[];
  basis?: Rate["basis"];
  note?: string;
}

/** A meter is priced by one rate or by a retention ladder, never both. */
export type Meter<U extends Unit> = MeterOptions<U> &
  ({ rate: RateRef; ladder?: undefined } | { ladder: Ladder; rate?: undefined });

interface MeterOptions<U extends Unit> {
  unit: U;
  /**
   * The one retention sold, in days (logs, traces, profiles) or months
   * (metrics). A longer ask is priced at this retention and marked as shorter
   * than asked; a shorter ask pays the same. Profiles have no retention
   * setting, so theirs only names the retention on the line.
   */
  retention?: { included: number };
  /**
   * Logs and traces by GB only: data kept past `retention.included` is billed
   * as GB held per day past it, at this rate. The retention asked for is then
   * bought in full.
   */
  retentionExtra?: { rate: string };
  /**
   * A second line on the same count: on everything sent, or on the searchable
   * share. `note` is added to the sentence written when part of the data is
   * not kept, to say what happens to the rest. Not with `free`.
   */
  storage?: { rate: RateRef; on: "all" | "searchable"; note?: string };
  /** GB meters only: data scanned by queries, at SCAN_MULTIPLE x the GB ingested. */
  scan?: { rate: string; note?: string };
  /** Free allowance a month, in the meter's unit, taken off before pricing. */
  free?: number;
}

export interface Coverage {
  coverage: "unpriced" | "unsupported";
  /** Shown instead of the generic "publishes no price" line. */
  note?: string;
}

export interface Example {
  /** What the example shows, with the arithmetic, e.g. "3,000 GB x $0.40 = $1,200". */
  name: string;
  /** A preset id from workloads.ts. */
  preset: string;
  /** Only these signals are sent. Default: whatever the preset sends. */
  signals?: Signal[];
  settings?: Partial<Settings>;
  /** Fields to change on the preset, by section. */
  workload?: { [K in keyof Workload]?: Partial<Workload[K]> };
  /** The monthly total, or amounts by bucket (and optionally the total). */
  expect: number | (Partial<Record<Bucket, number>> & { total?: number });
  /** How many lines the receipt has. */
  lines?: number;
  /** Default true: every sent signal has a public price. */
  complete?: boolean;
}

/** What `extra` is given: the pricing input, the bill helper and the bill so far. */
export interface ExtraInput extends PriceInput {
  /** Builds lines from the spec's rates table, so every amount is quantity x a published rate. */
  bill: Bill;
  /** The lines the meters have written. */
  lines: readonly LineItem[];
  /** The priced signals that are being sent. */
  active: ReadonlySet<Signal>;
}

/** What `extra` adds to the bill. Every part is optional. */
export interface ExtraOutput {
  lines?: LineItem[];
  assumptions?: string[];
  included?: string[];
  notIncluded?: string[];
  notes?: string[];
}

export interface VendorSpec {
  id: string;
  name: string;
  group: VendorGroup;
  plan: string | { annual: string; monthly: string };
  pricingUrl: string;
  checkedOn: string;
  /** Source id to its URL, or to a label and URL. */
  sources: Record<string, string | { label: string; url: string }>;
  /** Rate id to the published price. `sourceId` must be a key of `sources`. */
  rates: Record<string, Omit<Rate, "id">>;
  logs: Meter<LogsUnit> | Coverage;
  traces: Meter<TracesUnit> | Coverage;
  metrics: Meter<MetricsUnit> | Coverage;
  profiles: Meter<ProfilesUnit> | Coverage;
  /** A plan minimum that usage counts toward: the gap is billed as a top-up. */
  minimum?: { rate: string; label: string };
  /** A flat monthly fee, charged whenever a priced signal is sent. */
  platformFee?: { rate: string; label: string; detail?: string };
  /**
   * The one rule the fields above cannot say: a line or a sentence worked out
   * in code. It runs after the meters and before `minimum` and `platformFee`,
   * so a top-up counts the lines it adds, and only when a priced signal is
   * sent. It adds to the bill and cannot change a meter's line.
   */
  extra?: (input: ExtraInput) => ExtraOutput;
  assumptions?: Text[];
  included?: Text[];
  notIncluded?: Text[];
  notes?: Text[];
  examples: Example[];
}

export type SpecVendor = VendorAdapter & { readonly spec: VendorSpec };

export const isSpecVendor = (v: VendorAdapter): v is SpecVendor => "spec" in v;

/** The order lines are written in: logs, traces, metrics, then profiles. */
const SIGNALS: Signal[] = ["logs", "traces", "metrics", "profiles"];
const COVERAGE_ORDER: Signal[] = ["logs", "metrics", "traces", "profiles"];
const SIGNAL_NAME: Record<Signal, string> = {
  logs: "Logs",
  traces: "Traces",
  metrics: "Metrics",
  profiles: "Profiles",
};

/** One of a signal, for a label: "Data scanned by log queries", "Trace retention past 30 days". */
const SINGULAR: Record<Signal, string> = {
  logs: "Log",
  traces: "Trace",
  metrics: "Metric",
  profiles: "Profile",
};

const isMeter = (m: Meter<Unit> | Coverage): m is Meter<Unit> => "unit" in m;

/** How one unit of one signal is counted, labelled and explained. */
interface UnitMap {
  sent: (d: Derived) => number;
  searchable: (d: Derived) => number;
  /** The billing unit in the vendor's words, for generated rates. */
  rateUnit: string;
  /** The short unit on a line. */
  lineUnit: string;
  /** The start of a line label: "Log ingestion", "Metric data points". */
  label: string;
  /** The main line's label when a storage line follows it: "Log record ingestion". */
  ingestLabel: string;
  /** The storage line's label: "Log record storage". */
  storageLabel: string;
  /** What is counted, in a sentence: "log records". */
  noun: string;
  /** A count in the meter's unit, written out with its noun: "3B log records". */
  amount: (sent: number) => string;
  detail: (w: Workload, d: Derived) => string;
}

function unitMap(signal: Signal, unit: Unit): UnitMap {
  const key = `${signal}/${unit}`;
  switch (key) {
    case "logs/gb":
      return {
        sent: (d) => d.logs.gbPerMonth,
        searchable: (d) => d.logs.searchableGbPerMonth,
        rateUnit: "GB ingested",
        lineUnit: "GB",
        label: "Log ingestion",
        ingestLabel: "Log ingestion",
        storageLabel: "Log storage",
        noun: "GB of logs",
        amount: (n) => `${num(n)} GB of logs`,
        detail: (w) => `${num(w.logs.gbPerDay)} GB/day × ${DAYS_PER_MONTH} days`,
      };
    case "logs/million-records":
      return {
        sent: (d) => d.logs.recordsPerMonth / 1e6,
        searchable: (d) => d.logs.searchableRecordsPerMonth / 1e6,
        rateUnit: "million log records",
        lineUnit: "M records",
        label: "Log records",
        ingestLabel: "Log record ingestion",
        storageLabel: "Log record storage",
        noun: "log records",
        amount: (n) => `${compact(n * 1e6)} log records`,
        detail: (w) =>
          `${num(w.logs.gbPerDay)} GB/day × ${DAYS_PER_MONTH} days at ${num(w.logs.avgRecordBytes, 0)} bytes a record`,
      };
    case "traces/gb":
      return {
        sent: (d) => d.traces.gbPerMonth,
        searchable: (d) => d.traces.searchableGbPerMonth,
        rateUnit: "GB ingested",
        lineUnit: "GB",
        label: "Trace ingestion",
        ingestLabel: "Trace ingestion",
        storageLabel: "Trace storage",
        noun: "GB of traces",
        amount: (n) => `${num(n)} GB of traces`,
        detail: (w, d) =>
          `${compact(d.traces.spansPerMonth)} spans × ${num(w.traces.avgSpanBytes, 0)} bytes`,
      };
    case "traces/million-spans":
      return {
        sent: (d) => d.traces.spansPerMonth / 1e6,
        searchable: (d) => d.traces.searchableSpansPerMonth / 1e6,
        rateUnit: "million spans",
        lineUnit: "M spans",
        label: "Spans",
        ingestLabel: "Span ingestion",
        storageLabel: "Span storage",
        noun: "spans",
        amount: (n) => `${compact(n * 1e6)} spans`,
        detail: (w) => `${num(w.traces.spansPerSecond)} spans/s × ${DAYS_PER_MONTH} days`,
      };
    case "metrics/gb":
      return {
        sent: (d) => d.metrics.gbPerMonth,
        searchable: (d) => d.metrics.gbPerMonth,
        rateUnit: "GB ingested",
        lineUnit: "GB",
        label: "Metric ingestion",
        ingestLabel: "Metric ingestion",
        storageLabel: "Metric storage",
        noun: "GB of metrics",
        amount: (n) => `${num(n)} GB of metrics`,
        detail: (w, d) =>
          `${compact(d.metrics.dataPointsPerMonth)} data points × ${num(w.metrics.bytesPerDataPoint, 0)} bytes`,
      };
    case "metrics/million-data-points":
      return {
        sent: (d) => d.metrics.dataPointsPerMonth / 1e6,
        searchable: (d) => d.metrics.dataPointsPerMonth / 1e6,
        rateUnit: "million data points",
        lineUnit: "M data points",
        label: "Metric data points",
        ingestLabel: "Metric data point ingestion",
        storageLabel: "Metric data point storage",
        noun: "metric data points",
        amount: (n) => `${compact(n * 1e6)} metric data points`,
        detail: (w, d) =>
          `${compact(d.metrics.activeSeries)} series × one point every ${w.metrics.intervalSeconds} s`,
      };
    case "metrics/thousand-series":
      return {
        sent: (d) => d.metrics.activeSeries / 1e3,
        searchable: (d) => d.metrics.activeSeries / 1e3,
        rateUnit: "thousand active series",
        lineUnit: "k series",
        label: "Metric series",
        ingestLabel: "Metric series ingestion",
        storageLabel: "Metric series storage",
        noun: "active series",
        amount: (n) => `${compact(n * 1e3)} active series`,
        detail: (_w, d) => `${compact(d.metrics.activeSeries)} active series`,
      };
    case "profiles/gb":
      return {
        sent: (d) => d.profiles.gbPerMonth,
        searchable: (d) => d.profiles.gbPerMonth,
        rateUnit: "GB ingested",
        lineUnit: "GB",
        label: "Profile ingestion",
        ingestLabel: "Profile ingestion",
        storageLabel: "Profile storage",
        noun: "GB of profiles",
        amount: (n) => `${num(n)} GB of profiles`,
        detail: (w, d) =>
          `${compact(d.profiles.samplesPerMonth)} samples × ${num(w.profiles.bytesPerSample, 0)} bytes`,
      };
    case "profiles/million-samples":
      return {
        sent: (d) => d.profiles.samplesPerMonth / 1e6,
        searchable: (d) => d.profiles.samplesPerMonth / 1e6,
        rateUnit: "million profiling samples",
        lineUnit: "M samples",
        label: "Profiling samples",
        ingestLabel: "Profiling sample ingestion",
        storageLabel: "Profiling sample storage",
        noun: "profiling samples",
        amount: (n) => `${compact(n * 1e6)} profiling samples`,
        detail: (w, d) =>
          `${num(d.profiles.profiledHosts)} profiled hosts × ${num(w.profiles.samplesPerSecondPerHost)} samples a second × ${DAYS_PER_MONTH} days`,
      };
    default:
      throw new Error(`No unit ${unit} for ${signal}`);
  }
}

/** The retention asked for, in the unit the signal is kept in. */
function askedRetention(signal: Signal, w: Workload): number | null {
  if (signal === "logs") return w.logs.retentionDays;
  if (signal === "traces") return w.traces.retentionDays;
  if (signal === "metrics") return w.metrics.retentionMonths;
  return null;
}

const retentionUnit = (signal: Signal): "days" | "months" =>
  signal === "metrics" ? "months" : "days";

function keptKey(signal: Signal): keyof Kept {
  if (signal === "logs") return "logsDays";
  if (signal === "traces") return "tracesDays";
  return "metricsMonths";
}

/** One day's volume, as text, for the extra-retention line. */
function perDay(signal: Signal, w: Workload, d: Derived): string {
  return signal === "logs"
    ? `${num(w.logs.gbPerDay)} GB/day`
    : `${num(d.traces.gbPerMonth)} GB a month / ${DAYS_PER_MONTH} days`;
}

const span = (n: number, unit: "days" | "months") => duration(n, unit);
const rungLabel = (at: number, unit: "days" | "months") =>
  unit === "days" ? `${at}-day` : `${at}-month`;

function resolveRate(ref: RateRef, s: Settings): string {
  if (typeof ref === "string") return ref;
  if ("annual" in ref) return ref[s.term];
  return ref[s.region];
}

const refIds = (ref: RateRef): string[] =>
  typeof ref === "string" ? [ref] : Object.values(ref);

/** What happened while pricing, for `when` and for the generated sentences. */
interface Flags {
  active: Set<Signal>;
  scan: boolean;
  extraRetention: boolean;
  partlySearchable: boolean;
  topUp: boolean;
}

function applies(when: When | When[], f: Flags): boolean {
  const list = Array.isArray(when) ? when : [when];
  return list.some((k) =>
    k === "scan" || k === "extraRetention" || k === "partlySearchable" || k === "topUp"
      ? f[k]
      : f.active.has(k),
  );
}

export function defineVendor(spec: VendorSpec): SpecVendor {
  const fail = (msg: string): never => {
    throw new Error(`${spec.id}: ${msg}`);
  };

  const sources: Source[] = Object.entries(spec.sources).map(([id, v]) =>
    typeof v === "string" ? { id, label: "Pricing page", url: v } : { id, ...v },
  );
  const sourceIds = new Set(sources.map((s) => s.id));

  // The rates table: the map as written, then one rate per ladder step.
  const rates: Rate[] = Object.entries(spec.rates).map(([id, r]) => ({ id, ...r }));
  for (const signal of SIGNALS) {
    const m = spec[signal];
    if (!isMeter(m) || !m.ladder) continue;
    const unit = retentionUnit(signal);
    const map = unitMap(signal, m.unit);
    let previous = 0;
    for (const step of m.ladder.steps) {
      if (step.at <= previous) fail(`${signal} ladder must ascend`);
      previous = step.at;
      rates.push({
        id: `${signal}-${step.at}${unit === "days" ? "d" : "mo"}`,
        label: `${SIGNAL_NAME[signal]}, ${rungLabel(step.at, unit)} retention`,
        usd: step.usd,
        unit: map.rateUnit,
        sourceId: m.ladder.source,
        basis: m.ladder.basis ?? "list",
        ...(m.ladder.note ? { note: m.ladder.note } : {}),
      });
    }
  }
  const rateIds = new Set<string>();
  for (const r of rates) {
    if (rateIds.has(r.id)) fail(`rate id ${r.id} is used twice (a ladder generates <signal>-<at>d ids)`);
    rateIds.add(r.id);
  }
  for (const r of rates) {
    if (!sourceIds.has(r.sourceId)) fail(`rate ${r.id} cites unknown source ${r.sourceId}`);
  }
  const needRate = (ref: RateRef | undefined, what: string) => {
    if (ref === undefined) return;
    for (const id of refIds(ref)) if (!rateIds.has(id)) fail(`${what} uses unknown rate ${id}`);
  };

  for (const signal of SIGNALS) {
    const m = spec[signal];
    if (!isMeter(m)) continue;
    if (!m.rate && !m.ladder) fail(`${signal} needs a rate or a ladder`);
    if (m.rate && m.ladder) fail(`${signal} has both a rate and a ladder`);
    needRate(m.rate, signal);
    needRate(m.storage?.rate, `${signal} storage`);
    needRate(m.scan?.rate, `${signal} scan`);
    needRate(m.retentionExtra?.rate, `${signal} retentionExtra`);
    if (m.ladder && m.retention) fail(`${signal} has both a ladder and a fixed retention`);
    if (signal === "profiles" && m.ladder) {
      fail("profiles have no retention setting to pick a ladder step with");
    }
    if (m.storage && m.free) fail(`${signal} has both storage and a free allowance`);
    if (m.retentionExtra) {
      if (!m.retention) fail(`${signal} retentionExtra needs retention.included`);
      if (m.unit !== "gb" || (signal !== "logs" && signal !== "traces")) {
        fail(`${signal} retentionExtra is for logs and traces billed by GB`);
      }
    }
    if (m.scan && m.unit !== "gb") fail(`${signal} scan needs a GB meter`);
    unitMap(signal, m.unit);
  }
  needRate(spec.minimum?.rate, "minimum");
  needRate(spec.platformFee?.rate, "platformFee");

  // `{rate:<id>}` in text, checked once here so a bad id cannot reach the page.
  const usdOf = new Map(rates.map((r) => [r.id, usdRate(r.usd)]));
  const fill = (text: string): string =>
    text.replace(/\{rate:([a-z0-9-]+)\}/g, (_, id: string) => {
      const price = usdOf.get(id);
      if (price === undefined) fail(`text quotes unknown rate ${id}`);
      return price!;
    });
  const texts = (items: Text[] | undefined): { text: string; when?: When | When[] }[] =>
    (items ?? []).map((t) =>
      typeof t === "string" ? { text: fill(t) } : { text: fill(t.text), when: t.when },
    );
  const authored = {
    assumptions: texts(spec.assumptions),
    included: texts(spec.included),
    notIncluded: texts(spec.notIncluded),
    notes: texts(spec.notes),
  };
  const pick = (items: { text: string; when?: When | When[] }[], f: Flags) =>
    items.filter((t) => t.when === undefined || applies(t.when, f)).map((t) => t.text);

  // In the contract's signal order, the same as a handwritten adapter writes it.
  const coverage = {} as VendorAdapter["coverage"];
  const coverageNote: Partial<Record<Signal, string>> = {};
  for (const signal of COVERAGE_ORDER) {
    const m = spec[signal];
    if (isMeter(m)) {
      coverage[signal] = "priced";
    } else {
      coverage[signal] = m.coverage;
      if (m.note) coverageNote[signal] = m.note;
    }
  }

  const adapter: SpecVendor = {
    spec,
    id: spec.id,
    name: spec.name,
    group: spec.group,
    plan: typeof spec.plan === "string" ? () => spec.plan as string : (s) => (spec.plan as { annual: string; monthly: string })[s.term],
    pricingUrl: spec.pricingUrl,
    checkedOn: spec.checkedOn,
    sources,
    rates,
    coverage,
    ...(Object.keys(coverageNote).length > 0 ? { coverageNote } : {}),

    price({ w, d, s }) {
      const bill = billFor(rates);
      const lines: LineItem[] = [];
      const kept: Kept = {};
      const flags: Flags = {
        active: new Set(),
        scan: false,
        extraRetention: false,
        partlySearchable: false,
        topUp: false,
      };
      /** Retention shorter than asked: read before anything else. */
      const shorter: string[] = [];
      /** Retention priced on a different option than asked, but not shorter. */
      const different: string[] = [];
      const generated: string[] = [];
      /** The included days that extra retention was billed past, one sentence each. */
      const extraPast = new Set<number>();
      let metricsByGb = false;
      let added: ExtraOutput = {};

      for (const signal of SIGNALS) {
        const m = spec[signal];
        if (!isMeter(m)) continue;
        const map = unitMap(signal, m.unit);
        const sent = map.sent(d);
        if (!(sent > 0)) continue;
        flags.active.add(signal);
        const name = SIGNAL_NAME[signal];

        // The rate, and what retention it buys.
        let rateId: string;
        let sold: string | null = null;
        const asked = askedRetention(signal, w);
        const rUnit = retentionUnit(signal);
        if (m.ladder) {
          const step = smallestCovering(m.ladder.steps, (r) => r.at, asked ?? 0);
          rateId = `${signal}-${step.at}${rUnit === "days" ? "d" : "mo"}`;
          sold = rungLabel(step.at, rUnit);
          kept[keptKey(signal)] = step.at;
          if (asked !== null && step.at !== asked) {
            const line =
              step.at >= asked
                ? `${name}: ${span(asked, rUnit)} of retention is priced at the ${sold} rate, the nearest option ${spec.name} sells that covers it.`
                : `${name}: the longest retention ${spec.name} sells is the ${sold} option, so ${span(asked, rUnit)} is priced at that rate and the data is kept for less time than asked.`;
            (step.at >= asked ? different : shorter).push(line);
          }
        } else {
          rateId = resolveRate(m.rate, s);
        }

        let extraDays = 0;
        if (m.retention) sold = rungLabel(m.retention.included, rUnit);
        if (m.retention && asked !== null) {
          const included = m.retention.included;
          if (m.retentionExtra && asked > included) {
            extraDays = asked - included;
          } else if (asked > included) {
            kept[keptKey(signal)] = included;
            shorter.push(
              `${name}: ${span(asked, rUnit)} of retention was asked for. ${spec.name} keeps ${name.toLowerCase()} for ${span(included, rUnit)} and publishes no price for longer, so ${span(included, rUnit)} is priced and the data is kept for less time than asked.`,
            );
          } else if (asked < included) {
            kept[keptKey(signal)] = included;
            different.push(
              `${name}: ${span(asked, rUnit)} of retention costs the same as the ${span(included, rUnit)} the price includes.`,
            );
          }
        }

        // The main line.
        const free = m.free ?? 0;
        const quantity = Math.max(0, sent - free);
        const withRetention = sold !== null && !m.storage && !m.retentionExtra;
        lines.push(
          ...bill.line({
            bucket: signal,
            label: m.storage
              ? map.ingestLabel
              : withRetention
                ? `${map.label}, ${sold} retention`
                : map.label,
            quantity,
            unit: map.lineUnit,
            rateId,
            detail: free > 0 ? `${map.detail(w, d)}, less ${num(free)} ${map.lineUnit} free` : map.detail(w, d),
          }),
        );

        if (m.storage) {
          const stored = m.storage.on === "searchable" ? map.searchable(d) : sent;
          lines.push(
            ...bill.line({
              bucket: signal,
              label: sold ? `${map.storageLabel}, ${sold} retention` : map.storageLabel,
              quantity: stored,
              unit: map.lineUnit,
              rateId: resolveRate(m.storage.rate, s),
              detail:
                stored < sent
                  ? `${num((stored / sent) * 100, 1)}% of ${map.amount(sent)} kept`
                  : `All ${map.amount(sent)} kept`,
            }),
          );
          if (stored < sent) {
            generated.push(
              [
                `${name}: ${num((stored / sent) * 100, 1)}% of ${map.noun} are kept and searchable. The rest pays the ingestion rate only.`,
                ...(m.storage.note ? [m.storage.note] : []),
              ].join(" "),
            );
          }
        }

        if (m.scan) {
          const multiple = SCAN_MULTIPLE[s.queryLoad];
          flags.scan = true;
          lines.push(
            ...bill.line({
              bucket: signal,
              label: `Data scanned by ${SINGULAR[signal].toLowerCase()} queries`,
              quantity: sent * multiple,
              unit: "GB",
              rateId: m.scan.rate,
              detail: `${num(sent)} GB ingested × ${multiple} GB scanned per GB (${s.queryLoad} query load)`,
            }),
          );
        }

        if (extraDays > 0 && m.retentionExtra && m.retention) {
          flags.extraRetention = true;
          extraPast.add(m.retention.included);
          const heldGb = (sent / DAYS_PER_MONTH) * extraDays;
          lines.push(
            ...bill.line({
              bucket: signal,
              label: `${SINGULAR[signal]} retention past ${m.retention.included} days`,
              quantity: heldGb,
              unit: "GB held",
              rateId: m.retentionExtra.rate,
              detail: `${perDay(signal, w, d)} × ${num(extraDays, 0)} days kept past the included ${m.retention.included} = ${num(heldGb)} GB held`,
            }),
          );
        }

        if (signal === "metrics" && m.unit === "gb") metricsByGb = true;
        const share = signal === "logs" ? w.logs.searchableShare : signal === "traces" ? w.traces.searchableShare : 1;
        if (share < 1 && !m.storage) flags.partlySearchable = true;
      }

      // The plan: a minimum usage counts toward, or a flat fee on top of it.
      if (flags.active.size > 0) {
        if (spec.extra) {
          added = spec.extra({ w, d, s, bill, lines: [...lines], active: flags.active });
          lines.push(...(added.lines ?? []));
        }
        if (spec.minimum) {
          const usage = lines.reduce((sum, l) => sum + l.amount, 0);
          const topUp = bill.topUp({
            label: spec.minimum.label,
            minimumRateId: spec.minimum.rate,
            usage,
          });
          flags.topUp = topUp.length > 0;
          lines.push(...topUp);
        }
        if (spec.platformFee) {
          lines.push(
            ...bill.line({
              bucket: "platform",
              label: spec.platformFee.label,
              quantity: 1,
              unit: "month",
              rateId: spec.platformFee.rate,
              detail: spec.platformFee.detail ?? "Flat monthly fee",
            }),
          );
        }
      }

      if (flags.scan) {
        const multiple = SCAN_MULTIPLE[s.queryLoad];
        const notes = SIGNALS.map((sig) => spec[sig])
          .filter((m): m is Meter<Unit> => isMeter(m) && Boolean(m.scan?.note))
          .map((m) => m.scan!.note!);
        generated.push(
          [
            `Queries are priced at ${multiple} GB scanned for each GB ingested, the ${s.queryLoad} query load.`,
            ...new Set(notes),
          ].join(" "),
        );
      }
      if (metricsByGb) {
        generated.push(
          `Metrics are billed by GB, with no series or data point meter. Their volume is data points × the ${num(w.metrics.bytesPerDataPoint, 0)} bytes per data point set in the workload.`,
        );
      }
      for (const included of extraPast) {
        generated.push(
          `Retention past ${included} days is priced on the uncompressed GB that are older than ${included} days at steady state, one day's volume for each day kept past them.`,
        );
      }
      if (flags.partlySearchable) {
        generated.push(
          `${spec.name} prices one tier, so everything ingested stays searchable and the searchable share is not used.`,
        );
      }

      return {
        lines,
        ...(Object.keys(kept).length > 0 ? { kept } : {}),
        assumptions: [
          ...shorter,
          ...pick(authored.assumptions, flags),
          ...generated,
          ...(added.assumptions ?? []),
          ...different,
        ],
        included: [...pick(authored.included, flags), ...(added.included ?? [])],
        notIncluded: [...pick(authored.notIncluded, flags), ...(added.notIncluded ?? [])],
        notes: [...pick(authored.notes, flags), ...(added.notes ?? [])],
      };
    },
  };
  return adapter;
}
