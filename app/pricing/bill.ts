/**
 * Helpers adapters use to build line items from their rates table, so an
 * amount is always quantity x a published rate and never a loose number.
 */
import { num } from "./format";
import type { Bucket, LineItem, Rate } from "./types";

interface LineArgs {
  bucket: Bucket;
  label: string;
  quantity: number;
  unit: string;
  rateId: string;
  detail?: string;
}

/** One step of a tier table. `upTo` is the cumulative upper bound; null = no limit. */
export interface TierStep {
  upTo: number | null;
  rateId: string;
}

interface TieredArgs {
  bucket: Bucket;
  label: string;
  quantity: number;
  unit: string;
  tiers: TierStep[];
  detail?: string;
}

export interface Bill {
  /** The rate's price, or a thrown error for an id that is not in the table. */
  usd: (rateId: string) => number;
  /** quantity x rate as one line. Empty when the quantity is zero or less. */
  line: (args: LineArgs) => LineItem[];
  /**
   * Graduated pricing: each slice of the quantity is billed at a separate
   * tier's rate. One line per tier that is reached.
   */
  graduated: (args: TieredArgs) => LineItem[];
  /**
   * Volume pricing: the whole quantity is billed at the rate of the tier it
   * lands in. One line.
   */
  volume: (args: TieredArgs) => LineItem[];
  /**
   * The gap between usage and a plan's monthly minimum, as a "top-up" line.
   * Empty when usage already meets the minimum.
   */
  topUp: (args: {
    bucket?: Bucket;
    label: string;
    minimumRateId: string;
    usage: number;
    detail?: string;
  }) => LineItem[];
}

const fmt = (n: number) => num(n, 2);

/** A tier table must climb, and only its last step may be open-ended. */
function checkTiers(tiers: TierStep[]): void {
  tiers.forEach((tier, i) => {
    const previous = i > 0 ? tiers[i - 1].upTo : 0;
    if (previous === null || (tier.upTo !== null && tier.upTo <= previous)) {
      throw new Error("Tier steps must ascend, with an open-ended step only at the end");
    }
  });
}

export function billFor(rates: Rate[]): Bill {
  const byId = new Map(rates.map((r) => [r.id, r]));
  if (byId.size !== rates.length) {
    throw new Error("Duplicate rate id in rates table");
  }

  const usd = (rateId: string): number => {
    const rate = byId.get(rateId);
    if (!rate) throw new Error(`Unknown rate id: ${rateId}`);
    return rate.usd;
  };

  const line = ({ bucket, label, quantity, unit, rateId, detail }: LineArgs): LineItem[] => {
    if (!(quantity > 0)) return [];
    return [{ bucket, label, quantity, unit, rateId, amount: quantity * usd(rateId), detail }];
  };

  const graduated = ({ bucket, label, quantity, unit, tiers, detail }: TieredArgs): LineItem[] => {
    checkTiers(tiers);
    const out: LineItem[] = [];
    let floor = 0;
    for (const [i, tier] of tiers.entries()) {
      if (quantity <= floor) break;
      // A table whose last step is bounded still bills what lies past it, at
      // that last rate, the way volume() does. Dropping it would undercharge.
      const ceiling = i === tiers.length - 1 ? Infinity : (tier.upTo ?? Infinity);
      const slice = Math.min(quantity, ceiling) - floor;
      if (slice > 0) {
        const range =
          ceiling === Infinity
            ? `above ${fmt(floor)} ${unit}`
            : floor === 0
              ? `first ${fmt(ceiling)} ${unit}`
              : `${fmt(floor)} to ${fmt(ceiling)} ${unit}`;
        out.push({
          bucket,
          label: tiers.length > 1 ? `${label}, ${range}` : label,
          quantity: slice,
          unit,
          rateId: tier.rateId,
          amount: slice * usd(tier.rateId),
          detail: out.length === 0 ? detail : undefined,
        });
      }
      floor = ceiling;
    }
    return out;
  };

  const volume = ({ bucket, label, quantity, unit, tiers, detail }: TieredArgs): LineItem[] => {
    if (!(quantity > 0)) return [];
    checkTiers(tiers);
    const tier = tiers.find((t) => t.upTo === null || quantity <= t.upTo) ?? tiers[tiers.length - 1];
    return [
      { bucket, label, quantity, unit, rateId: tier.rateId, amount: quantity * usd(tier.rateId), detail },
    ];
  };

  const topUp: Bill["topUp"] = ({ bucket = "platform", label, minimumRateId, usage, detail }) => {
    const minimum = usd(minimumRateId);
    // Usage is a sum of floats: half a cent short of the minimum is the minimum.
    if (usage >= minimum - 0.005) return [];
    return [
      {
        kind: "top-up",
        bucket,
        label,
        quantity: 1,
        unit: "month",
        rateId: minimumRateId,
        amount: minimum - usage,
        detail:
          detail ??
          `Usage comes to $${fmt(usage)}; the plan bills at least $${fmt(minimum)} a month`,
      },
    ];
  };

  return { usd, line, graduated, volume, topUp };
}

/**
 * The smallest published option that covers what was asked for (a retention
 * tier, a plan size), or the largest when nothing does.
 */
export function smallestCovering<T>(options: T[], size: (o: T) => number, wanted: number): T {
  const sorted = [...options].sort((a, b) => size(a) - size(b));
  return sorted.find((o) => size(o) >= wanted) ?? sorted[sorted.length - 1];
}
