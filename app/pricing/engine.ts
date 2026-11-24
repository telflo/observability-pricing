/**
 * The pricing engine: runs adapters, totals their lines, ranks vendors, prices
 * a split across vendors, and resizes a workload. Pure functions; the page
 * calls them on every input change.
 */
import type {
  Bucket,
  RetentionGap,
  Settings,
  Signal,
  Unpriced,
  VendorAdapter,
  VendorEstimate,
  Workload,
} from "./types";
import { BUCKETS, SIGNALS } from "./types";
import { activeSignals, derive } from "./units";

const SIGNAL_NAME: Record<Signal, string> = {
  logs: "Logs",
  metrics: "Metrics",
  traces: "Traces",
  profiles: "Profiles",
};

const zeroBuckets = (): Record<Bucket, number> => ({
  logs: 0,
  metrics: 0,
  traces: 0,
  profiles: 0,
  platform: 0,
});

export function estimateVendor(
  vendor: VendorAdapter,
  w: Workload,
  s: Settings,
): VendorEstimate {
  const active = activeSignals(w);
  if (active.length === 0) {
    return {
      vendor,
      monthly: 0,
      byBucket: zeroBuckets(),
      lines: [],
      assumptions: [],
      included: [],
      notIncluded: [],
      notes: [],
      unpriced: [],
      shortRetention: [],
      complete: true,
    };
  }

  const out = vendor.price({ w, d: derive(w), s });

  const byBucket = zeroBuckets();
  for (const line of out.lines) byBucket[line.bucket] += line.amount;
  const monthly = BUCKETS.reduce((sum, b) => sum + byBucket[b], 0);

  // A sent signal the vendor does not price is missing from the total. Say so
  // even when the adapter did not.
  const unpriced: Unpriced[] = [...(out.unpriced ?? [])];
  for (const signal of active) {
    const coverage = vendor.coverage[signal];
    if (coverage !== "priced" && !unpriced.some((u) => u.bucket === signal)) {
      unpriced.push({
        bucket: signal,
        reason:
          vendor.coverageNote?.[signal] ??
          (coverage === "unsupported"
            ? `${vendor.name} does not take ${SIGNAL_NAME[signal].toLowerCase()}.`
            : `${vendor.name} publishes no price for ${SIGNAL_NAME[signal].toLowerCase()}.`),
      });
    }
  }

  // A price that keeps data for less time than asked is still a price, but
  // it is not the same thing. Record the gap so the page can mark the row.
  const shortRetention: RetentionGap[] = [];
  const kept = out.kept ?? {};
  const gap = (signal: Signal, asked: number, got: number | undefined, unit: "days" | "months") => {
    if (active.includes(signal) && got !== undefined && got < asked) {
      shortRetention.push({ signal, asked, kept: got, unit });
    }
  };
  gap("logs", w.logs.retentionDays, kept.logsDays, "days");
  gap("metrics", w.metrics.retentionMonths, kept.metricsMonths, "months");
  gap("traces", w.traces.retentionDays, kept.tracesDays, "days");

  return {
    vendor,
    monthly,
    byBucket,
    shortRetention,
    lines: out.lines,
    assumptions: out.assumptions,
    included: out.included,
    notIncluded: out.notIncluded,
    notes: out.notes,
    unpriced,
    complete: unpriced.length === 0,
  };
}

/** Every vendor, complete estimates first and cheapest first within each group. */
export function estimateAll(
  vendors: VendorAdapter[],
  w: Workload,
  s: Settings,
): VendorEstimate[] {
  return vendors
    .map((v) => estimateVendor(v, w, s))
    .sort((a, b) => {
      if (a.complete !== b.complete) return a.complete ? -1 : 1;
      return a.monthly - b.monthly || a.vendor.name.localeCompare(b.vendor.name);
    });
}

/** The workload with only the given signals switched on. */
export function onlySignals(w: Workload, signals: Signal[]): Workload {
  return {
    ...w,
    send: {
      logs: w.send.logs && signals.includes("logs"),
      metrics: w.send.metrics && signals.includes("metrics"),
      traces: w.send.traces && signals.includes("traces"),
      profiles: w.send.profiles && signals.includes("profiles"),
    },
  };
}

/** Which vendor (by id) receives each signal. null: the signal is not routed. */
export type Route = Record<Signal, string | null>;

export const emptyRoute = (): Route => ({ logs: null, metrics: null, traces: null, profiles: null });

export interface RoutePart {
  vendor: VendorAdapter;
  signals: Signal[];
  estimate: VendorEstimate;
}

export interface RouteEstimate {
  route: Route;
  parts: RoutePart[];
  monthly: number;
  complete: boolean;
}

/**
 * Price a split: each vendor is priced once for the signals it receives, so
 * its base fees are counted once however many signals it takes.
 */
export function estimateRoute(
  vendors: VendorAdapter[],
  w: Workload,
  s: Settings,
  route: Route,
): RouteEstimate {
  const active = activeSignals(w);
  const byVendor = new Map<string, Signal[]>();
  let complete = true;
  for (const signal of active) {
    const id = route[signal];
    if (!id) {
      complete = false;
      continue;
    }
    byVendor.set(id, [...(byVendor.get(id) ?? []), signal]);
  }

  const parts: RoutePart[] = [];
  for (const [id, signals] of byVendor) {
    const vendor = vendors.find((v) => v.id === id);
    if (!vendor) {
      complete = false;
      continue;
    }
    const estimate = estimateVendor(vendor, onlySignals(w, signals), s);
    if (!estimate.complete) complete = false;
    parts.push({ vendor, signals, estimate });
  }

  return {
    route,
    parts,
    monthly: parts.reduce((sum, p) => sum + p.estimate.monthly, 0),
    complete,
  };
}

/**
 * The lowest-cost way to split the active signals across vendors. Exhaustive:
 * base fees make the per-signal minimum wrong when one vendor would carry two
 * signals, so every way of grouping the signals is tried, over memoized prices.
 */
export function cheapestRoute(
  vendors: VendorAdapter[],
  w: Workload,
  s: Settings,
): RouteEstimate | null {
  const active = activeSignals(w);
  if (active.length === 0) return null;

  // Two tables of cost[v][mask] (vendor v carrying the subset of active
  // signals in mask): one that only admits prices keeping everything for the
  // retention asked, one that also admits shorter retention.
  const subsets = 1 << active.length;
  const strict: number[][] = [];
  const loose: number[][] = [];
  for (const vendor of vendors) {
    const strictRow = new Array<number>(subsets).fill(Infinity);
    const looseRow = new Array<number>(subsets).fill(Infinity);
    for (let mask = 1; mask < subsets; mask++) {
      const signals = active.filter((_, i) => mask & (1 << i));
      if (signals.some((sig) => vendor.coverage[sig] !== "priced")) continue;
      const estimate = estimateVendor(vendor, onlySignals(w, signals), s);
      if (!estimate.complete) continue;
      looseRow[mask] = estimate.monthly;
      if (estimate.shortRetention.length === 0) strictRow[mask] = estimate.monthly;
    }
    strict.push(strictRow);
    loose.push(looseRow);
  }

  // Over subsets of the active signals: the lowest total for each subset,
  // built from one vendor carrying part of it plus the best for the rest.
  // 3^n steps per vendor instead of vendors^n assignments.
  const search = (cost: number[][]): number[] | null => {
    const best = new Array<number>(subsets).fill(Infinity);
    const count = new Array<number>(subsets).fill(Infinity);
    const choice = new Array<{ v: number; part: number } | null>(subsets).fill(null);
    best[0] = 0;
    count[0] = 0;
    for (let mask = 1; mask < subsets; mask++) {
      // Every non-empty part of mask, as the part one vendor carries.
      for (let part = mask; part > 0; part = (part - 1) & mask) {
        const rest = mask ^ part;
        if (!Number.isFinite(best[rest])) continue;
        for (let v = 0; v < vendors.length; v++) {
          const total = best[rest] + cost[v][part];
          const n = count[rest] + 1;
          // On a tie (to within float noise) the split with fewer vendors wins:
          // one platform at the same price is not a "split".
          const tie = Math.abs(total - best[mask]) <= 1e-6;
          if (total < best[mask] - 1e-6 || (tie && n < count[mask])) {
            best[mask] = total;
            count[mask] = n;
            choice[mask] = { v, part };
          }
        }
      }
    }
    const all = subsets - 1;
    if (!Number.isFinite(best[all])) return null;
    const pick = new Array<number>(active.length).fill(0);
    for (let mask = all; mask > 0; ) {
      const { v, part } = choice[mask]!;
      for (let k = 0; k < active.length; k++) if (part & (1 << k)) pick[k] = v;
      mask ^= part;
    }
    return pick;
  };

  // A shorter retention is never ranked silently against a longer one: the
  // split uses full-retention prices when any exist, and only otherwise falls
  // back to shorter ones, which the page then marks.
  const chosen = search(strict) ?? search(loose);
  if (!chosen) return null;
  const route = emptyRoute();
  active.forEach((signal, i) => {
    route[signal] = vendors[chosen[i]].id;
  });
  return estimateRoute(vendors, w, s, route);
}

/**
 * A route as it can actually be priced: any entry naming an unknown vendor,
 * or one with no public price for that signal, is cleared. Links are typed by
 * hand and outlive price changes, so a stored route is never trusted as is.
 */
export function usableRoute(
  vendors: VendorAdapter[],
  w: Workload,
  s: Settings,
  route: Route,
): Route {
  const out = emptyRoute();
  for (const signal of activeSignals(w)) {
    const vendor = vendors.find((v) => v.id === route[signal]);
    if (!vendor || vendor.coverage[signal] !== "priced") continue;
    if (estimateVendor(vendor, onlySignals(w, [signal]), s).complete) out[signal] = vendor.id;
  }
  return out;
}

/** The cheapest complete vendor for each signal alone, cheapest first. */
export function rankForSignal(
  vendors: VendorAdapter[],
  w: Workload,
  s: Settings,
  signal: Signal,
): VendorEstimate[] {
  return vendors
    .filter((v) => v.coverage[signal] === "priced")
    .map((v) => estimateVendor(v, onlySignals(w, [signal]), s))
    .filter((e) => e.complete)
    .sort((a, b) => a.monthly - b.monthly || a.vendor.name.localeCompare(b.vendor.name));
}

/**
 * The same workload at another size: volumes and hosts scale together, the
 * number of people does not.
 */
export function scaleWorkload(w: Workload, factor: number): Workload {
  return {
    ...w,
    logs: { ...w.logs, gbPerDay: w.logs.gbPerDay * factor },
    metrics: { ...w.metrics, activeSeries: w.metrics.activeSeries * factor },
    traces: { ...w.traces, spansPerSecond: w.traces.spansPerSecond * factor },
    infra: {
      ...w.infra,
      hosts: w.infra.hosts === 0 ? 0 : Math.max(1, Math.round(w.infra.hosts * factor)),
    },
  };
}

export { SIGNALS, SIGNAL_NAME };
