# Contributing

Anyone can change a price here, including the vendor whose price it is. If you work for a
vendor, say so in your pull request.

## 1. A price is wrong

Each platform is one file: `app/pricing/vendors/<id>.ts`. Near the top it lists the pages the prices
were read from and the prices themselves, as a `sources` map and a `rates` map in a spec, or two
lists in a handwritten adapter.

`sources` are the public pages the prices were read from:

```ts
sources: {
  pricing: "https://example.com/pricing",
  docs: { label: "Docs: billing", url: "https://example.com/docs/billing" },
},
```

`rates` are the prices on those pages:

```ts
"logs-30d": {
  label: "Logs, 30-day retention",
  usd: 0.4,              // the price, in US dollars
  unit: "GB ingested",   // the unit, in the vendor's words
  sourceId: "pricing",   // which page in `sources` it is on
  basis: "list",         // list | starting-from | promotional | example
},
```

A handwritten adapter writes the same fields as two arrays, `sources` and `rates`, each entry
with its `id`. A spec with a retention `ladder` lists its steps as `{ at, usd }` instead.

To correct one:

1. Change `usd`. If the page moved, change the source's `url`.
2. Set `checkedOn` (further down the file) to the day you read the page.
3. Run `npm test`. A worked example (in the spec's `examples`, or in `<id>.test.ts`) may now
   expect the old figure. Update it, and say where the new figure comes from.
4. Open the pull request and paste the address of the page that shows the new price.
5. Add a line to [PRICE-LOG.md](PRICE-LOG.md): the date, the platform, what changed.

Every platform's page on the site has an "Edit these prices" button that opens the file in
GitHub. Or open a **Price correction** issue with the page that shows the right price.

## 2. A platform is missing

Most platforms with simple pricing need no code. Write the platform as a **spec**: one object
that lists its sources, its rates, how each signal is billed and a few worked examples. The
shared builder turns it into an adapter, and the shared tests run its examples and the checks
every platform passes, so you write no `price()` function and no test file.

Copy `signoz.ts`, which is a spec with a retention ladder and a monthly minimum:

```ts
import { defineVendor } from "../spec";

export const example = defineVendor({
  id: "example",                       // kebab-case, used in addresses
  name: "Example",                     // the product name, as the vendor writes it
  group: "otel-native",
  plan: "Pay as you go",               // the plan the estimate assumes
  pricingUrl: "https://example.com/pricing",
  checkedOn: "2026-11-12",             // the day you read the pages
  sources: {
    pricing: "https://example.com/pricing",
    docs: { label: "Docs: billing", url: "https://example.com/docs/billing" },
  },
  rates: {
    logs: { label: "Log ingestion", usd: 0.5, unit: "GB ingested", sourceId: "pricing", basis: "list" },
    spans: { label: "Spans", usd: 1, unit: "million spans", sourceId: "pricing", basis: "list" },
    minimum: { label: "Monthly minimum", usd: 25, unit: "month", sourceId: "pricing", basis: "list" },
  },
  // One meter per signal, or why there is none: "unpriced" (accepted, no
  // public price) or "unsupported" (the product does not take the signal).
  logs: { unit: "gb", rate: "logs", free: 50, retention: { included: 30 } },
  traces: { unit: "million-spans", rate: "spans", retention: { included: 14 } },
  metrics: { coverage: "unpriced" },
  profiles: { coverage: "unsupported" },
  minimum: { rate: "minimum", label: "Top-up to the monthly minimum" },
  assumptions: ["A GB is counted as 10^9 uncompressed bytes as sent."],
  included: ["30 days of log retention, 14 days of trace retention"],
  notIncluded: ["Negotiated discounts, which the vendor does not publish"],
  notes: ["Logs cost {rate:logs} per GB after the first 50 GB."],
  // Worked examples from the vendor's own pages or calculator. Say where each
  // figure comes from and show the arithmetic.
  examples: [
    {
      name: "the vendor's calculator: 100 GB/day, 3,000 GB less 50 free x $0.50 = $1,475",
      preset: "mid",
      signals: ["logs"],
      workload: { logs: { gbPerDay: 100, retentionDays: 30 } },
      expect: 1475,
    },
  ],
});
```

What a meter can say:

- `unit`: how the vendor counts. Logs: `gb` or `million-records`. Traces: `gb` or
  `million-spans`. Metrics: `gb`, `million-data-points` or `thousand-series`. Profiles: `gb`
  or `million-samples`.
- `rate`: a rate id, or one per billing term (`{ annual, monthly }`) or region (`{ us, eu }`).
- `ladder`: one price per retention option instead of `rate`, as SigNoz sells it. The option
  that covers the retention asked for is priced. Each step becomes a rate named
  `<signal>-<at>d` (`logs-15d`), or `<signal>-<at>mo` for metrics (`metrics-13mo`), which is
  the id a `{rate:...}` in your text uses.
- `retention: { included: 30 }`: the one retention sold (days for logs, traces and profiles,
  months for metrics). A longer ask is priced at it and marked as shorter than asked.
- `retentionExtra: { rate }`: logs and traces by GB kept past `retention.included` are billed
  as GB held per day, as OpenObserve does.
- `storage: { rate, on: "all" | "searchable", note }`: a second line on the same count, as
  Dash0 bills ingestion and storage. `note` says what happens to data that is not kept.
- `scan: { rate }`: data scanned by queries, at the query-load multiple.
- `free`: a monthly allowance in the meter's unit.

Plan-wide: `minimum` (a top-up to a plan minimum that usage counts toward) and `platformFee`
(a flat fee whenever something priced is sent). Any sentence can be limited to when it applies:
`{ when: "metrics", text: "..." }`, or `when: "scan"`, `"extraRetention"`,
`"partlySearchable"`, `"topUp"`. A sentence that quotes a price writes `{rate:<id>}`, so the
figure can never drift from the rates table.

Then:

1. Add it to `app/pricing/vendors/index.ts`, in alphabetical order.
2. Run `npm test` and `npm run typecheck`. The spec's examples run from `specs.test.ts`, and the
   contract checks run from `contract.test.ts` on every platform in `index.ts`.

### When a spec is not enough

There are three ways to write a platform. Take the first one that fits.

| | For | What you write |
|---|---|---|
| 1. A spec | One meter per signal, an allowance, a retention, a minimum | Data only, as above |
| 2. A spec with `extra` | A spec, plus a rule or a sentence the fields cannot say | The data, and one function for that part |
| 3. A `price()` function | Choosing between plans, pooled host allotments, two billing modes | The whole bill, by hand |

**A spec with `extra`.** Keep everything that fits as data, and add an `extra` function for the
part that does not. `dash0.ts` is the model: its four meters are data, and the sentence about
discounts past 15 billion units, which depends on the volume, is code.

```ts
export const example = defineVendor({
  // ...sources, rates, logs, traces, metrics, profiles, examples as above...
  rates: {
    // ...
    seat: { label: "Full user", usd: 10, unit: "user", sourceId: "pricing", basis: "list" },
  },
  extra: ({ w, d, s, bill, lines, active }) => ({
    lines: bill.line({
      bucket: "platform",
      label: "Full users",
      quantity: d.users,
      unit: "users",
      rateId: "seat",          // a rate in this spec's table, like every other line
    }),
    assumptions: d.logs.gbPerMonth > 10_000 ? ["Past 10 TB a month the vendor quotes by hand."] : [],
  }),
});
```

`extra` is given `w`, `d` and `s` (described below), `bill` to build lines from the rates table,
the `lines` the meters wrote and the `active` signals. It returns any of `lines`, `assumptions`,
`included`, `notIncluded` and `notes`. It runs after the meters and before `minimum` and
`platformFee`, so a top-up counts what it adds, and it runs only when a priced signal is sent.
It adds to the bill. It cannot change a line a meter wrote. The contract checks apply to its
lines like any others.

**One rule keeps the spec small.** A pricing rule that one platform has is written in that
platform's file, in `extra`. It becomes a field of the spec only when a second platform needs
the same thing. Please do not add a field to `spec.ts` for one platform.

**A `price()` function.** Some platforms choose between plans, pool allowances across hosts, or
compare two billing modes. Those are written as a `price()` function on a `VendorAdapter`.
`uptrace.ts` is a small one to start from; `datadog.ts` shows pooled host allotments. You then
also write `app/pricing/vendors/<id>.test.ts`, with at least one worked example taken from the
vendor's pricing page or calculator and a comment saying which. The contract checks need no
call from you: `contract.test.ts` runs them once the platform is in `index.ts`.

If your pricing needs a handwritten adapter, we will happily take it. But we will admit to a
small hope: that one day every platform fits the simple spec, and this section can be deleted.
If a price needs 300 lines of code to explain, that is rather the problem with observability
pricing today. This project exists to make it simple.

What `price()` and `extra` receive:

- `w`, the workload as entered.
- `d`, the same workload as monthly quantities: `d.logs.gbPerMonth`, `d.logs.recordsPerMonth`,
  `d.metrics.activeSeries`, `d.metrics.dataPointsPerMonth`, `d.traces.spansPerMonth`,
  `d.traces.gbPerMonth`, `d.infra.monitoredHosts` and more. See `Derived` in `types.ts`.
- `s`, the settings: billing term, region, query load.

If the product keeps data for less time than the workload asks, price the longest it does and
return `kept: { logsDays: 7 }` so the page can mark the row. If it publishes no price for
something, return it under `unpriced` with the reason. Never fill a gap with a guess.

### The checks every platform passes

`contract.test.ts` runs the checks in `adapter-contract.ts` on every platform in `index.ts`, spec
or handwritten, over every reference workload at several sizes:

- every line is a quantity times a rate in the adapter's rate list, and every rate cites a
  source
- nothing is charged for a signal that is not sent, and nothing sent costs nothing
- switching a signal off never raises the bill
- a bigger workload never costs less
- the wording is neutral
- a retention limit mentioned in the assumptions is also reported as data

## 3. You disagree with the method

The method is in [README.md](README.md#how-a-price-is-made) and on the site at `/method`. If it
treats a product unfairly, open a **Method question** issue. A method changes for every platform
at once. See [GOVERNANCE.md](GOVERNANCE.md).

## What gets merged

- **Public pages only.** A rate must be on a page anyone can open without an account.
- **List price in US dollars.** Published tiers and free allowances apply. Negotiated discounts
  do not.
- **A missing price stays missing.** Nothing is guessed.
- **The same rules for every platform.**
- **Plain wording.** Notes say what is billed. They do not rate the product. Words like "cheap"
  fail the checks.
- **No product logos.** Names are text.

## Running it

```bash
npm install
npm run dev
npm test
npm run typecheck
npm run build
```

`npm run stale` lists the platforms whose pages have not been re-read in 90 days.

CI runs on every pull request: the secret scan; the typecheck, the tests and the build; the
release scripts' tests (`scripts/release/*.test.sh`); `npm audit` and `npm audit signatures`;
and CodeQL, whose findings go to the Security tab. After a merge, main runs the same on Node 20,
22 and 24, scans the full git history for secrets, and keeps the built site as the run's
artifact for 30 days. It runs again every Monday, since new advisories appear when nothing here
changed.

To check the dependencies yourself:

```bash
npm audit
npm audit signatures
```

To run the secret scan yourself (gitleaks, pinned and checked by sha256, into the git-ignored
`.tools/`):

```bash
bash scripts/ci/tools.sh fetch gitleaks
bash scripts/ci/check-secrets.sh            # the files git would commit
bash scripts/ci/check-secrets.sh --history  # every commit
```

A made-up value that gitleaks flags in a test is listed in `.gitleaksignore` after review. Never
list a real credential: remove it, and rotate it.

## Releasing

A release is one version, `x.y.z` (digits only, no leading zeros), tagged `v<x.y.z>` on a
commit of main. Its [GitHub release](https://github.com/telflo/observability-pricing/releases)
holds that version's `rates.json` and `rates.csv` (the files the site serves at `/data`) with
their `SHA256SUMS`, and its CHANGELOG.md entry as the notes. A published version is never
changed: a fix is a new version.

The version says what changed for someone reading the data files: a patch for price
corrections and re-reads, a minor version for a new platform, signal or method, a major version
for a change to `rates.json`'s or `rates.csv`'s fields.

**1. The version, through a pull request.** On a branch, set the version in package.json and
package-lock.json, and move CHANGELOG.md's Unreleased entries under the version's heading, dated
the day you release, `## 0.2.0 - 2026-12-01`. Then commit:

```bash
npm version 0.2.0 --no-git-tag-version
git commit -m "Release 0.2.0" -- package.json package-lock.json CHANGELOG.md
```

The release commit lands on main through a pull request, reviewed like any other change.

**2. The tag**, after the merge: annotated, on the commit of main that holds the new version,
with the message `observability-pricing <version>`. Only a maintainer can push a `v*` tag, and
none can be moved or deleted once pushed (the `release tags` ruleset). Only the tag is pushed:

```bash
git switch main
git pull --ff-only origin main
git tag -a v0.2.0 -m "observability-pricing 0.2.0"
git push origin v0.2.0
```

**3. The release workflow** (`.github/workflows/release.yml`) starts on the tag. It refuses a
tag that isn't `v<x.y.z>`, isn't annotated, isn't on main, or doesn't match package.json,
package-lock.json and a dated CHANGELOG.md entry at its commit
(`scripts/release/verify-tag.sh`). It then runs main's full CI on the tag's commit. Once that
passes, the `release` environment's reviewer approves the last job, which makes the GitHub
release (`scripts/release/github-release.sh`).

If a run fails for a reason outside the commit (a runner, the network), use "Re-run failed jobs": a release
that exists already is never made again. If it fails on the tag's commit, fix it on main and
release the next version: the tag can't be moved.

To see a release's notes before you tag it:

```bash
bash scripts/release/notes.sh 0.2.0
```

## The site

The bar colors were checked for color-vision separation in both themes. Do not change them
without re-checking.
