/**
 * Platforms that are not priced here, and why. A missing price is shown as
 * missing: nothing in this list is estimated from third-party figures.
 * Checked against each vendor's pages on the date given.
 */
export interface UnlistedVendor {
  name: string;
  /** Why there is no estimate, as a plain fact about the vendor's public pricing. */
  reason: string;
  url: string;
  checkedOn: string;
}

export const UNLISTED: UnlistedVendor[] = [
  {
    name: "Chronosphere",
    reason: "Publishes its billing meters but no rates. Pricing is by quote.",
    url: "https://chronosphere.io/pricing/",
    checkedOn: "2026-11-12",
  },
  {
    name: "CrowdStrike Falcon LogScale",
    reason: "Licensed by average GB per day and retention tier, with no published price.",
    url: "https://www.crowdstrike.com/en-us/platform/next-gen-siem/falcon-logscale/",
    checkedOn: "2026-11-12",
  },
  {
    name: "Mezmo",
    reason: "The pricing page shows no dollar figures. Pricing is by quote.",
    url: "https://www.mezmo.com/pricing",
    checkedOn: "2026-11-12",
  },
  {
    name: "Splunk Cloud Platform",
    reason: "Log ingestion is priced by quote.",
    url: "https://www.splunk.com/en_us/products/pricing.html",
    checkedOn: "2026-11-12",
  },
  {
    name: "Sumo Logic",
    reason: "Bills in credits, and the published credits per GB are examples. Each contract sets them.",
    url: "https://www.sumologic.com/pricing",
    checkedOn: "2026-11-12",
  },
  {
    name: "VictoriaMetrics Cloud",
    reason: "Storage and network rates are public, but the capacity tier prices are shown only inside the console.",
    url: "https://docs.victoriametrics.com/victoriametrics-cloud/billing/",
    checkedOn: "2026-11-12",
  },
];
