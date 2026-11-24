# Price log

Every change to a price or to a method, newest first. One line each: the date the vendor's page
was read, the platform, and what changed.

## 2026

- **2026-11-22** Dash0 rewritten as a declarative spec. Same rates, same sources, same totals.
  Its line labels and some sentences are reworded: "Log ingestion" is now "Log record
  ingestion", and a retention shorter than asked is said in the same words as for every spec.
- **2026-11-22** ClickHouse Observability, OpenObserve Cloud and SigNoz Cloud rewritten as
  declarative specs. Same rates, same sources, same totals. The one change: SigNoz no longer
  bills its $49 minimum when only an unpriced signal (profiles) is sent.
- **2026-11-22** Continuous profiling added as an optional fourth signal, off by default. Priced
  at Amazon CloudWatch (CodeGuru Profiler, $0.005 per sampling hour), Dash0 ($0.06 ingestion and
  $0.54 storage per million samples), Datadog (Continuous Profiler, $19 annual or $23
  month-to-month per host, 4 containers per host, then $2 per container) and Grafana Cloud
  ($0.05, $0.40 and $0.10 per GB processed, written and retained, 50 GB included). Every other
  platform is listed as not priced for profiles, with the reason.
- **2026-11-22** Amazon CloudWatch: method change. Span indexing is no longer charged for the
  searchable share. Every ingested span is searchable in Transaction Search, and indexing (which
  only adds X-Ray trace summaries) stays at AWS's free default of 1%. The mid preset falls from
  $11,941.51 to $8,092.39 a month. Rates unchanged.
- **2026-11-22** Bronto: method change. A month past Starter that fits inside Pro is priced at the
  $500 Pro fee, as Bronto's calculator does, instead of usage rates. Below Pro the usage rates are
  only overage. Rates unchanged.
- **2026-11-13** Head-to-head comparison added. No prices changed.
- **2026-11-12** First read of all 20 platforms: Amazon CloudWatch, Axiom, Azure Monitor, Better
  Stack, Bronto, ClickHouse Observability, Coralogix, Dash0, Datadog, Dynatrace, Elastic Cloud
  Serverless, Google Cloud Observability, Grafana Cloud, Honeycomb, Logz.io, New Relic,
  OpenObserve Cloud, SigNoz Cloud, Splunk Observability Cloud and Uptrace Cloud.
- **2026-11-12** Six vendors checked and listed as not priced, because they publish no price that
  can be computed from: Chronosphere, CrowdStrike Falcon LogScale, Mezmo, Splunk Cloud Platform,
  Sumo Logic and VictoriaMetrics Cloud.
