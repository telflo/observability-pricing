# Observability Pricing

[![CI](https://github.com/telflo/observability-pricing/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/telflo/observability-pricing/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/telflo/observability-pricing)](https://github.com/telflo/observability-pricing/releases/latest)
[![Node](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Ftelflo%2Fobservability-pricing%2Fmain%2Fpackage.json&query=%24.engines.node&label=node)](package.json)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

Price one telemetry workload (logs, metrics, traces, hosts, seats) at each observability
platform's public list price. Every rate links to the vendor page it came from.

Estimates are list prices in US dollars. They are not quotes.

## Fix a price or add a platform

Each platform is one file in [`app/pricing/vendors`](app/pricing/vendors). Change it and open a
pull request, or [open an issue](../../issues/new?template=price-correction.yml) and we will.
Read [CONTRIBUTING.md](CONTRIBUTING.md) first.

A price change is merged once it matches the vendor's public page.

## Run it

Node 20.19 or newer.

```bash
npm install
npm run dev        # the site, at http://localhost:5173
npm test           # every adapter's contract checks and worked examples
npm run typecheck
npm run build      # static files in build/client
```

`npm run build` renders every page to static HTML.

## Layout

```
app/pricing/            the engine. No framework, no network, pure functions.
  types.ts              the contract: Workload, Rate, LineItem, VendorAdapter
  units.ts              one workload turned into monthly quantities
  engine.ts             runs adapters, totals lines, ranks, prices a split
  compare.ts            the head-to-head figures
  spec.ts               declarative platforms: a data object becomes an adapter
  vendors/<id>.ts       one platform: the pages read, the rates, the bill (a spec, or a price() function)
  vendors/<id>.test.ts  a handwritten platform's worked examples (a spec carries its own)
  vendors/specs.test.ts runs every spec's worked examples
  vendors/adapter-contract.ts   the checks every platform must pass
  vendors/contract.test.ts      runs those checks on every platform in the registry
app/components/         the calculator and the site's header and footer
app/routes/             the pages: calculator, platforms, one platform, method, contribute
scripts/export-data.ts  writes public/data/rates.json and rates.csv
scripts/stale.ts        lists platforms not re-read lately
```

## How a price is made

1. The form takes a workload: GB of logs a day, active series, spans a second, hosts, seats and
   retention.
2. `units.ts` turns it into monthly GB, log records, data points and spans.
3. Each adapter converts those into the vendor's billing units and returns bill lines. A line is
   a quantity times a published rate.
4. The engine adds up the lines.

Every platform gets the same conventions: a 30-day month, a GB of 10^9 uncompressed bytes, list
price and the same retention. A missing price is shown as missing.

## Who runs this

Maintained by [Telflo](https://telflo.com), which makes software for managing OpenTelemetry
Collectors. Telflo does not sell an observability platform. It is used to change where telemetry
is sent, so it gains when teams compare platforms.

No vendor pays to be listed or to change a number. See [GOVERNANCE.md](GOVERNANCE.md).

Contact: open an issue.

## Licence

Code and price data under the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
Product names belong to their owners.
