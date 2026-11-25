# Changelog

Every release, newest first, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style. Each release's `rates.json` and
`rates.csv` are on its [GitHub release](https://github.com/telflo/observability-pricing/releases).
Every price change, with the day the vendor's page was read, is in [PRICE-LOG.md](PRICE-LOG.md).

## Unreleased

## 0.1.0 - 2026-11-24

The first release.

### Added

- The calculator: one telemetry workload (GB of logs a day, active metric series, spans a second,
  hosts, seats, retention, and continuous profiling, off by default) priced at each platform's
  public list price. Every bill line is a quantity times a published rate, linked to the vendor
  page it came from.
- 20 platforms priced: Amazon CloudWatch, Axiom, Azure Monitor, Better Stack, Bronto, ClickHouse
  Observability, Coralogix, Dash0, Datadog, Dynatrace, Elastic Cloud Serverless, Google Cloud
  Observability, Grafana Cloud, Honeycomb, Logz.io, New Relic, OpenObserve Cloud, SigNoz Cloud,
  Splunk Observability Cloud and Uptrace Cloud.
- The head-to-head comparison of two platforms.
- A page for each platform: the pages read, every rate and the day it was read.
- The method page: the conventions every platform is priced by (a 30-day month, a GB of 10^9
  uncompressed bytes, list price, the same retention).
- The open data: `rates.json` and `rates.csv`, every platform's rates, served at `/data`.
