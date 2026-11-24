/**
 * Filling the volumes from a host count, for people who know how many hosts
 * they run but not how much telemetry those hosts emit.
 *
 * These are conventions, not measurements, in line with the per-host ratios
 * public vendor comparisons use: about 50 GB of logs per host per month,
 * 45 to 50 GB of traces per traced host with about half the hosts traced
 * (about 26 GB per host at 1 KB a span), and 300 to 2,100 series per host.
 * Real fleets vary a lot, which is why the page shows the ratios and lets
 * every volume be overridden.
 */
import type { Workload } from "./types";
import { LIMITS } from "./url-state";

export const PER_HOST = {
  logGbPerDay: 1.6,
  activeSeries: 1_250,
  spansPerSecond: 10,
};

const twoDigits = (n: number) => Number(n.toPrecision(2));

/**
 * A volume held to the form's limits. A large fleet would otherwise get
 * numbers no one could type, and a copied link (which clamps on the way in)
 * would open at a different price.
 */
const within = (n: number, { min, max }: { min: number; max: number }) =>
  Math.min(max, Math.max(min, twoDigits(n)));

export function sizeFromHosts(w: Workload, hosts: number): Workload {
  return {
    ...w,
    send: { ...w.send, logs: true, metrics: true, traces: true },
    logs: { ...w.logs, gbPerDay: within(hosts * PER_HOST.logGbPerDay, LIMITS.logGbPerDay) },
    metrics: {
      ...w.metrics,
      activeSeries: within(hosts * PER_HOST.activeSeries, LIMITS.activeSeries),
    },
    traces: {
      ...w.traces,
      spansPerSecond: within(hosts * PER_HOST.spansPerSecond, LIMITS.spansPerSecond),
    },
    infra: { ...w.infra, hosts },
  };
}
