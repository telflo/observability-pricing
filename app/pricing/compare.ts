/**
 * Head to head: which platforms sit side by side, and the figures the
 * comparison adds to an estimate. For each signal that is what its lines work
 * out to per unit and the meters behind them; for the whole estimate, the
 * retention priced and the bill at ten times the volume.
 */
import { estimateVendor, scaleWorkload } from "./engine";
import type { Bucket, Settings, Signal, VendorEstimate, Workload } from "./types";
import { activeSignals, derive } from "./units";

/** A comparison is two or three platforms. */
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 3;

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * The platforms to compare. Until the visitor picks, that is the first three
 * rows of the ranked list (fully priced estimates, lowest first). Picks naming
 * a platform the page does not know are dropped, and a single pick is paired
 * with the lowest estimate that is not already in it.
 */
export function resolveCompare(picked: string[] | null, estimates: VendorEstimate[]): string[] {
  // estimateAll returns fully priced estimates first, lowest first.
  const ranked = estimates.map((e) => e.vendor.id);
  if (picked === null) return ranked.slice(0, COMPARE_MAX);
  const picks = unique(picked.filter((id) => ranked.includes(id))).slice(0, COMPARE_MAX);
  for (const id of ranked) {
    if (picks.length >= COMPARE_MIN) break;
    if (!picks.includes(id)) picks.push(id);
  }
  return picks;
}

/**
 * The comparison with one slot changed. Picking a platform that is already in
 * another slot swaps the two, so a platform is never compared with itself.
 * A null id empties the slot, down to the two a comparison needs.
 */
export function withSlot(ids: string[], index: number, id: string | null): string[] {
  const next = [...ids];
  if (id === null) {
    if (next.length > COMPARE_MIN && index < next.length) next.splice(index, 1);
    return next;
  }
  const other = next.indexOf(id);
  if (other === index) return next;
  if (other >= 0 && index < next.length) {
    next[other] = next[index];
    next[index] = id;
    return next;
  }
  if (other >= 0) return next; // already compared, and the slot is new: nothing to add
  if (index < next.length) next[index] = id;
  else if (next.length < COMPARE_MAX) next.push(id);
  return next;
}

/** The visitor's picks with one more. Full comparisons stay as they are. */
export function withAdded(picked: string[] | null, id: string): string[] {
  const picks = picked ?? [];
  if (picks.includes(id) || picks.length >= COMPARE_MAX) return picks;
  return [...picks, id];
}

/** What one unit of each signal is, for the per-unit figures. */
export const UNIT_OF: Record<Signal, string> = {
  logs: "GB",
  metrics: "1,000 series",
  traces: "million spans",
  profiles: "profiled host",
};

export interface SignalFacts {
  /** This signal's lines, monthly US dollars. */
  amount: number;
  /** False when the vendor publishes no price for part of this signal. */
  priced: boolean;
  /**
   * The amount divided by the signal's monthly volume (a GB of logs, 1,000
   * active series, a million spans). Null when there is nothing to divide.
   */
  perUnit: number | null;
  /** The meters this signal is billed by, as the vendor's price list names them. */
  billedBy: string[];
}

export interface KeptFor {
  signal: Signal;
  asked: number;
  kept: number;
  unit: "days" | "months";
}

export interface Comparison {
  estimate: VendorEstimate;
  signals: Partial<Record<Signal, SignalFacts>>;
  /** Base fees and seats. */
  platform: { amount: number; billedBy: string[] };
  /** How long each signal is kept at this price, next to what was asked. */
  retention: KeptFor[];
  /** The same workload at ten times the volume and hosts. */
  tenTimes: { monthly: number; complete: boolean };
}

function meters(estimate: VendorEstimate, bucket: Bucket): string[] {
  const rates = new Map(estimate.vendor.rates.map((r) => [r.id, r]));
  const units: string[] = [];
  for (const line of estimate.lines) {
    if (line.bucket !== bucket || line.kind === "top-up") continue;
    const unit = rates.get(line.rateId)?.unit;
    if (unit && !units.includes(unit)) units.push(unit);
  }
  return units;
}

export function compareFacts(estimate: VendorEstimate, w: Workload, s: Settings): Comparison {
  const d = derive(w);
  const volume: Record<Signal, number> = {
    logs: d.logs.gbPerMonth,
    metrics: d.metrics.activeSeries / 1000,
    traces: d.traces.spansPerMonth / 1e6,
    profiles: d.profiles.profiledHosts,
  };
  // Profiles have no retention to ask for: each vendor keeps them its own fixed time.
  const asked: Partial<Record<Signal, { n: number; unit: "days" | "months" }>> = {
    logs: { n: w.logs.retentionDays, unit: "days" },
    metrics: { n: w.metrics.retentionMonths, unit: "months" },
    traces: { n: w.traces.retentionDays, unit: "days" },
  };

  const signals: Partial<Record<Signal, SignalFacts>> = {};
  const retention: KeptFor[] = [];
  for (const signal of activeSignals(w)) {
    const amount = estimate.byBucket[signal];
    const priced = !estimate.unpriced.some((u) => u.bucket === signal);
    signals[signal] = {
      amount,
      priced,
      perUnit: priced && amount > 0 && volume[signal] > 0 ? amount / volume[signal] : null,
      billedBy: meters(estimate, signal),
    };
    const ask = asked[signal];
    if (!ask) continue;
    const gap = estimate.shortRetention.find((g) => g.signal === signal);
    retention.push({
      signal,
      asked: ask.n,
      kept: gap ? gap.kept : ask.n,
      unit: ask.unit,
    });
  }

  const big = estimateVendor(estimate.vendor, scaleWorkload(w, 10), s);
  return {
    estimate,
    signals,
    platform: { amount: estimate.byBucket.platform, billedBy: meters(estimate, "platform") },
    retention,
    tenTimes: { monthly: big.monthly, complete: big.complete },
  };
}
