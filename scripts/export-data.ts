/**
 * Writes the open data files the site serves at /data: every backend's rates,
 * with the unit, the page each was read from and the day it was read.
 * Run by `npm run data`, and before every build.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { csvCell } from "../app/pricing/export";
import { VENDORS } from "../app/pricing/vendors";
import { DEFAULT_SETTINGS } from "../app/pricing/workloads";

const OUT = "public/data";

const backends = VENDORS.map((vendor) => {
  const sources = new Map(vendor.sources.map((source) => [source.id, source]));
  return {
    id: vendor.id,
    name: vendor.name,
    plan_priced: vendor.plan(DEFAULT_SETTINGS),
    pricing_page: vendor.pricingUrl,
    checked_on: vendor.checkedOn,
    public_price_for: vendor.coverage,
    rates: vendor.rates.map((rate) => ({
      id: rate.id,
      label: rate.label,
      usd: rate.usd,
      unit: rate.unit,
      basis: rate.basis,
      note: rate.note ?? null,
      source: sources.get(rate.sourceId)?.url ?? vendor.pricingUrl,
    })),
  };
});

const csv = [
  ["backend", "plan_priced", "rate", "usd", "unit", "basis", "note", "source", "checked_on"].join(","),
  ...backends.flatMap((backend) =>
    backend.rates.map((rate) =>
      [
        backend.name,
        backend.plan_priced,
        rate.label,
        rate.usd,
        rate.unit,
        rate.basis,
        rate.note,
        rate.source,
        backend.checked_on,
      ]
        .map(csvCell)
        .join(","),
    ),
  ),
].join("\n");

mkdirSync(OUT, { recursive: true });
writeFileSync(
  `${OUT}/rates.json`,
  `${JSON.stringify(
    {
      about:
        "Public list prices for observability backends, in US dollars, read from each vendor's own pages.",
      license: "Apache-2.0",
      conventions: {
        month: "30 days",
        gigabyte: "10^9 bytes, uncompressed, as sent over OTLP",
        currency: "USD",
      },
      backends,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(`${OUT}/rates.csv`, `${csv}\n`);

const rates = backends.reduce((n, backend) => n + backend.rates.length, 0);
console.log(`Wrote ${rates} rates for ${backends.length} backends to ${OUT}/rates.json and rates.csv`);
