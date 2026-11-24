/**
 * Every platform the calculator prices, in alphabetical order. The page never
 * depends on this order for ranking: results are sorted by the visitor.
 */
import { isSpecVendor } from "../spec";
import type { VendorAdapter } from "../types";
import { awsCloudwatch } from "./aws-cloudwatch";
import { axiom } from "./axiom";
import { azureMonitor } from "./azure-monitor";
import { betterStack } from "./better-stack";
import { bronto } from "./bronto";
import { clickhouse } from "./clickhouse";
import { coralogix } from "./coralogix";
import { dash0 } from "./dash0";
import { datadog } from "./datadog";
import { dynatrace } from "./dynatrace";
import { elastic } from "./elastic";
import { googleCloud } from "./google-cloud";
import { grafanaCloud } from "./grafana-cloud";
import { honeycomb } from "./honeycomb";
import { logzio } from "./logzio";
import { newRelic } from "./new-relic";
import { openobserve } from "./openobserve";
import { signoz } from "./signoz";
import { splunk } from "./splunk";
import { uptrace } from "./uptrace";

export const VENDORS: VendorAdapter[] = [
  awsCloudwatch,
  axiom,
  azureMonitor,
  betterStack,
  bronto,
  clickhouse,
  coralogix,
  dash0,
  datadog,
  dynatrace,
  elastic,
  googleCloud,
  grafanaCloud,
  honeycomb,
  logzio,
  newRelic,
  openobserve,
  signoz,
  splunk,
  uptrace,
].sort((a, b) => a.name.localeCompare(b.name));

/** The platforms written as specs. specs.test.ts runs their contract checks and examples. */
export const SPEC_BUILT = VENDORS.filter(isSpecVendor);

export function vendorById(id: string): VendorAdapter | undefined {
  return VENDORS.find((v) => v.id === id);
}

/** The most recent day any adapter's rates were read. */
export const LAST_CHECKED: string = VENDORS.reduce(
  (latest, v) => (v.checkedOn > latest ? v.checkedOn : latest),
  "",
);

/** The oldest of those days: every rate on the page was read on or after it. */
export const FIRST_CHECKED: string = VENDORS.reduce(
  (oldest, v) => (v.checkedOn < oldest ? v.checkedOn : oldest),
  LAST_CHECKED,
);
