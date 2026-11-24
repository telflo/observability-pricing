/**
 * Number formatting shared by the adapters (line details) and the page.
 * Fixed "en-US" so server and client render the same string. Formatters are
 * cached: the page formats thousands of numbers on every input change, and
 * building an Intl.NumberFormat per call is what made that slow.
 */

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(minDecimals: number, maxDecimals: number): Intl.NumberFormat {
  const key = `${minDecimals}:${maxDecimals}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: minDecimals,
      maximumFractionDigits: maxDecimals,
    });
    formatters.set(key, cached);
  }
  return cached;
}

/** 1,234 or 12.5: thousands separators, at most `maxDecimals` decimals. */
export function num(n: number, maxDecimals = 2): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const decimals = abs >= 100 ? 0 : abs >= 10 ? Math.min(1, maxDecimals) : maxDecimals;
  return formatter(0, decimals).format(n);
}

const UNITS: [number, string][] = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/** 1.2K, 3.4M, 5.6B, 7.8T. Under 1,000 it is the plain number. */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  for (const [size, suffix] of UNITS) {
    // A value that would round up to 1,000 of the unit below belongs here:
    // 999,600 is "1M", never "1,000K".
    if (abs >= size * 0.9995) {
      const value = n / size;
      const digits = Math.abs(value) >= 99.95 ? 0 : Math.abs(value) >= 9.995 ? 1 : 2;
      return `${formatter(0, digits).format(value)}${suffix}`;
    }
  }
  return num(n);
}

/** A dollar total: $1,234 from $100 up, $12.50 below. */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  // Round to cents before choosing a form, so $99.995 is "$100" and float
  // noise below a cent never prints as "-$0.00".
  const cents = Math.round(Math.abs(n) * 100) / 100;
  const sign = n < 0 && cents > 0 ? "-" : "";
  if (cents >= 100) return `${sign}$${formatter(0, 0).format(Math.round(cents))}`;
  return `${sign}$${formatter(2, 2).format(cents)}`;
}

/** A dollar total for tight spaces: $1.2K, $34K, $5.6M. */
export function usdCompact(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  if (Math.abs(n) < 999.5) return `$${formatter(0, 0).format(Math.round(n))}`;
  return `$${compact(n)}`;
}

/**
 * A worked-out price per unit, to two significant digits below a dollar:
 * $1,235, $49.50, $2.60, $0.42, $0.031. For figures we derive, where more
 * digits would claim a precision the estimate does not have.
 */
export function usdApprox(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 100) return `$${formatter(0, 0).format(Math.round(n))}`;
  if (n >= 0.995) return `$${formatter(2, 2).format(n)}`;
  return `$${formatter(2, 8).format(Number(n.toPrecision(2)))}`;
}

/** A unit price: $0.10, $1.70, $0.0000016. Keeps the digits a rate card shows. */
export function usdRate(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  if (n === 0) return "$0";
  const abs = Math.abs(n);
  if (abs >= 1) return `$${formatter(2, 4).format(abs)}`;
  // Below a dollar: at least two decimals, up to four significant digits.
  const magnitude = Math.ceil(-Math.log10(abs));
  const decimals = Math.min(10, Math.max(2, magnitude + 3));
  const trimmed = abs.toFixed(decimals).replace(/0+$/, "");
  const [whole, frac = ""] = trimmed.split(".");
  return `$${whole}.${frac.padEnd(2, "0")}`;
}

/** Bytes as a short size: 500 B, 1.2 KB. */
export function bytes(n: number): string {
  if (n < 1000) return `${num(n, 0)} B`;
  return `${num(n / 1000, 1)} KB`;
}

/** GB as GB, TB or PB. */
export function dataSize(gb: number): string {
  if (gb >= 1e6) return `${num(gb / 1e6, 2)} PB`;
  if (gb >= 1000) return `${num(gb / 1000, 2)} TB`;
  return `${num(gb, 1)} GB`;
}

/** A retention as words: "30 days", "1 month", "1 year". */
export function duration(n: number, unit: "days" | "months"): string {
  if (unit === "days" && n === 365) return "1 year";
  return `${n} ${n === 1 ? unit.slice(0, -1) : unit}`;
}
