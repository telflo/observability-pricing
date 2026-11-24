/**
 * How the numbers are made: where prices come from, how one workload is
 * converted for each vendor, what the estimates leave out and who publishes
 * them. Plain statements a reader can check against the receipts above.
 */
import { Link } from "react-router";
import { textLink } from "~/components/ui";
import type { Settings, VendorAdapter } from "~/pricing/types";
import { SCAN_MULTIPLE } from "~/pricing/units";
import { SITE, newIssue } from "~/site";
import { formatDay } from "./Ledger";

function Point({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-24 grid gap-x-10 gap-y-2 border-b border-line py-6 md:grid-cols-12 md:py-7">
      <h3 className="text-lg font-semibold text-ink md:col-span-4">{title}</h3>
      <div className="space-y-3 text-[15px] leading-relaxed text-ink-2 md:col-span-8">{children}</div>
    </div>
  );
}

export function Method({ vendors, s }: { vendors: VendorAdapter[]; s: Settings }) {
  return (
    <div className="border-t border-line">
      <Point title="Where the prices come from">
        <p>
          Every rate comes from a page the vendor publishes, usually its pricing page or billing
          docs. Each line on a receipt links to it.
        </p>
        <p>If a vendor publishes no price for something, we mark it as missing.</p>
      </Point>

      <Point title="How your workload is converted">
        <p>
          Vendors bill in GB, events, spans, data points, series, hosts and seats. We convert your
          telemetry into each vendor's units and show the conversion on the receipt.
        </p>
        <p>
          Every platform is asked to keep all of your data searchable for the retention you set. If
          a vendor does not price that retention, the row says so.
        </p>
        <p>
          A month is 30 days and a GB is one billion uncompressed bytes. You can change record,
          span and data point sizes under Assumptions.
        </p>
        <p>
          Query load is {SCAN_MULTIPLE.light}, {SCAN_MULTIPLE.typical} or {SCAN_MULTIPLE.heavy} GB
          scanned a month for every GB ingested.
        </p>
        <p>
          Continuous profiling is off unless you switch it on. Vendors bill it per host, per
          sample, per GB or per hour profiled, so it is priced only where a profiling rate is
          published: {vendors
            .filter((v) => v.coverage.profiles === "priced")
            .map((v) => v.name)
            .join(", ")}
          . Samples per host and bytes per sample are conventions you can change under Assumptions;
          no vendor publishes a typical figure. Platforms that include profiling in a host fee or
          offer it free are listed apart, with the reason.
        </p>
      </Point>

      <Point title="What the estimates leave out">
        <p>
          Estimates use public list price in US dollars, with published volume tiers, free
          allowances and annual rates. They are not quotes. Negotiated discounts, credits, taxes,
          support plans and data transfer are left out.
        </p>
      </Point>

      <Point id="who" title="Who runs this">
        <p>
          {SITE.name} is maintained by{" "}
          <a href={SITE.maintainer.url} target="_blank" rel="noreferrer noopener" className={textLink}>
            {SITE.maintainer.name}
          </a>
          , which makes software for managing OpenTelemetry Collectors. Telflo does not sell an
          observability platform. It is used to change where telemetry is sent, so it gains when
          teams compare platforms.
        </p>
        <p>No vendor pays to be listed or to change a number.</p>
        <p>
          Found a wrong number?{" "}
          <a href={newIssue("price-correction")} target="_blank" rel="noreferrer noopener" className={textLink}>
            Open an issue
          </a>{" "}
          or{" "}
          <Link to="/contribute" className={textLink}>
            fix it yourself
          </Link>
          .
        </p>
      </Point>

      <details className="group/sources border-b border-line">
        <summary className="flex cursor-pointer list-none items-center justify-between py-5 text-lg font-semibold text-ink [&::-webkit-details-marker]:hidden">
          Sources for every platform
          <span aria-hidden="true" className="text-ink-3 transition-transform group-open/sources:rotate-90">
            ›
          </span>
        </summary>
        <div className="overflow-x-auto pb-8">
          <table className="w-full min-w-[38rem] border-collapse text-left text-sm">
            <thead>
              <tr>
                <th scope="col" className="border-b border-line-2 py-2 pr-4 text-xs font-medium text-ink-3">Platform</th>
                <th scope="col" className="border-b border-line-2 py-2 pr-4 text-xs font-medium text-ink-3">Plan priced</th>
                <th scope="col" className="border-b border-line-2 py-2 pr-4 text-xs font-medium text-ink-3">Pages read</th>
                <th scope="col" className="border-b border-line-2 py-2 text-xs font-medium text-ink-3">Read from</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((vendor) => (
                <tr key={vendor.id}>
                  <th scope="row" className="border-b border-line py-2 pr-4 text-left align-top font-medium text-ink">
                    {vendor.name}
                  </th>
                  <td className="border-b border-line py-2 pr-4 align-top text-ink-2">{vendor.plan(s)}</td>
                  <td className="border-b border-line py-2 pr-4 align-top whitespace-nowrap text-ink-2 tabular-nums">
                    {formatDay(vendor.checkedOn)}
                  </td>
                  <td className="border-b border-line py-2 align-top text-ink-2">
                    {vendor.sources.map((source, i) => (
                      <span key={source.id}>
                        {i > 0 ? ", " : ""}
                        <a href={source.url} target="_blank" rel="noreferrer noopener" className={textLink}>
                          {source.label}
                        </a>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
