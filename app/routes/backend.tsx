import { Link, useParams } from "react-router";
import type { Route } from "./+types/backend";
import { BUCKET_BG, BUCKET_LABEL, CostBar, formatDay, rowNote } from "~/components/calculator/Ledger";
import { btnSm, container, textLink } from "~/components/ui";
import { estimateVendor } from "~/pricing/engine";
import { usd, usdRate } from "~/pricing/format";
import type { Rate, VendorAdapter } from "~/pricing/types";
import { BUCKETS } from "~/pricing/types";
import { VENDORS, vendorById } from "~/pricing/vendors";
import { DEFAULT_SETTINGS, PRESETS } from "~/pricing/workloads";
import { SITE, editFile, newIssue, vendorFile } from "~/site";

export function meta({ params }: Route.MetaArgs) {
  const vendor = vendorById(params.id ?? "");
  if (!vendor) return [{ title: `No such platform | ${SITE.name}` }];
  const title = `${vendor.name} pricing: public list prices and a calculator | ${SITE.name}`;
  const description = `${vendor.rates.length} public list prices for ${vendor.name}, each linked to the page it was read from on ${formatDay(vendor.checkedOn)}, and what six reference workloads come to.`;
  return [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: `${SITE.url}/backends/${vendor.id}` },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
  ];
}

const BASIS: Record<Rate["basis"], string> = {
  list: "List price",
  "starting-from": "Starting price",
  promotional: "Promotional price",
  example: "Vendor's example rate",
};

function Notes({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="break-inside-avoid">
      <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
      <ul className="mt-2 space-y-1.5">
        {items.map((item) => (
          <li key={item} className="relative pl-3.5 text-[14px] leading-snug text-ink-2">
            <span aria-hidden="true" className="absolute top-[0.6em] left-0 h-px w-2 bg-line-2" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReferenceWorkloads({ vendor }: { vendor: VendorAdapter }) {
  const rows = PRESETS.map((preset) => ({
    preset,
    estimate: estimateVendor(vendor, preset.workload, DEFAULT_SETTINGS),
  }));
  const scaleMax = Math.max(...rows.map((r) => r.estimate.monthly));
  return (
    <ul aria-label="Reference workloads" className="border-t border-line">
      {rows.map(({ preset, estimate }) => {
        const note = rowNote(estimate);
        const nothing = !estimate.complete && estimate.monthly === 0;
        return (
          <li
            key={preset.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-2 border-b border-line py-3 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_7rem]"
          >
            <span className="min-w-0">
              <span className="block text-[15px] font-semibold text-ink">{preset.name}</span>
              <span className="block text-[13px] leading-snug text-ink-3">{preset.summary}</span>
              {note ? <span className="mt-0.5 block text-xs leading-snug text-ink-2">{note}</span> : null}
            </span>
            <span className="order-last col-span-full h-3 md:order-none md:col-span-1">
              <CostBar
                byBucket={estimate.byBucket}
                total={estimate.monthly}
                scaleMax={scaleMax}
                faded={!estimate.complete}
              />
            </span>
            <span
              className={`text-right ${
                nothing
                  ? "text-[13px] text-ink-3"
                  : estimate.complete
                    ? "text-[16px] font-semibold text-ink"
                    : "text-[15px] font-medium text-ink-2"
              }`}
            >
              {nothing ? "Not priced" : usd(estimate.monthly)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default function Backend() {
  const { id = "" } = useParams();
  const vendor = vendorById(id);

  if (!vendor) {
    return (
      <section className="py-24">
        <div className={container}>
          <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink">No platform by that name</h1>
          <p className="mt-3 text-[16px] text-ink-2">
            <Link to="/backends" className={textLink}>
              See the {VENDORS.length} that are priced here
            </Link>
          </p>
        </div>
      </section>
    );
  }

  const file = vendorFile(vendor.id);
  const sources = new Map(vendor.sources.map((source) => [source.id, source]));
  // The mid-size reference workload, for the notes that explain how an estimate is built.
  const reference = estimateVendor(vendor, PRESETS[1].workload, DEFAULT_SETTINGS);

  return (
    <>
      <section className="pt-8 pb-8 md:pt-10">
        <div className={container}>
          <p className="text-[13.5px] text-ink-3">
            <Link to="/backends" className={textLink}>
              Platforms
            </Link>
            <span aria-hidden="true" className="mx-2">
              /
            </span>
            {vendor.name}
          </p>
          <h1 className="mt-4 max-w-3xl text-[clamp(1.9rem,1.4rem+1.9vw,2.9rem)] leading-[1.06] font-semibold tracking-[-0.03em] text-ink">
            {vendor.name} pricing
          </h1>
          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-2">
            Read on {formatDay(vendor.checkedOn)}. Plan priced: {vendor.plan(DEFAULT_SETTINGS)}.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link to={`/?v=${vendor.id}#results`} className={btnSm.primary}>
              Price your workload
            </Link>
            <a href={editFile(file)} target="_blank" rel="noreferrer noopener" className={btnSm.secondary}>
              Edit these prices
            </a>
            <a
              href={newIssue("price-correction", `${vendor.name}: `)}
              target="_blank"
              rel="noreferrer noopener"
              className={btnSm.secondary}
            >
              Report a wrong price
            </a>
          </div>
        </div>
      </section>

      <section className="border-t border-line py-12">
        <div className={container}>
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
            <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink">
              Reference workloads
            </h2>
            <ul className="flex flex-wrap gap-x-5 gap-y-1" aria-label="What the bar colors mean">
              {BUCKETS.map((bucket) => (
                <li key={bucket} className="inline-flex items-center gap-2 text-[13px] text-ink-2">
                  <span aria-hidden="true" className={`size-2.5 rounded-[3px] ${BUCKET_BG[bucket]}`} />
                  {BUCKET_LABEL[bucket]}
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-3">
            A month at list price, annual commitment, US region.
          </p>
          <div className="mt-5">
            <ReferenceWorkloads vendor={vendor} />
          </div>
        </div>
      </section>

      <section className="border-t border-line py-12">
        <div className={container}>
          <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Rates</h2>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-left text-[14px]">
              <thead>
                <tr className="text-xs font-medium text-ink-3">
                  <th scope="col" className="border-b border-line-2 py-2 pr-4 font-medium">
                    What is priced
                  </th>
                  <th scope="col" className="border-b border-line-2 py-2 pr-4 text-right font-medium">
                    Price
                  </th>
                  <th scope="col" className="border-b border-line-2 py-2 pr-4 font-medium">
                    Per
                  </th>
                  <th scope="col" className="border-b border-line-2 py-2 pr-4 font-medium">
                    Kind
                  </th>
                  <th scope="col" className="border-b border-line-2 py-2 font-medium">
                    Read from
                  </th>
                </tr>
              </thead>
              <tbody>
                {vendor.rates.map((rate) => {
                  const source = sources.get(rate.sourceId);
                  return (
                    <tr key={rate.id}>
                      <th scope="row" className="border-b border-line py-2 pr-4 text-left align-top font-normal text-ink">
                        {rate.label}
                        {rate.note ? (
                          <span className="mt-0.5 block text-[13px] leading-snug text-ink-3">{rate.note}</span>
                        ) : null}
                      </th>
                      <td className="border-b border-line py-2 pr-4 text-right align-top font-tech text-[13px] whitespace-nowrap text-ink tabular-nums">
                        {usdRate(rate.usd)}
                      </td>
                      <td className="border-b border-line py-2 pr-4 align-top text-ink-2">{rate.unit}</td>
                      <td className="border-b border-line py-2 pr-4 align-top whitespace-nowrap text-ink-2">
                        {BASIS[rate.basis]}
                      </td>
                      <td className="border-b border-line py-2 align-top">
                        {source ? (
                          <a href={source.url} target="_blank" rel="noreferrer noopener" className={textLink}>
                            {source.label}
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="border-t border-line py-12">
        <div className={container}>
          <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink">How the estimate is built</h2>
          <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-3">
            For the mid-size reference workload.
          </p>
          <div className="mt-6 gap-x-12 md:columns-2 [&>div]:mb-7">
            <Notes title="Assumes" items={reference.assumptions} />
            <Notes title="Included in the price" items={reference.included} />
            <Notes title="Not in the estimate" items={reference.notIncluded} />
            <Notes title="Worth knowing" items={reference.notes} />
            <Notes title="No public price" items={reference.unpriced.map((gap) => gap.reason)} />
          </div>
        </div>
      </section>

      <section className="border-t border-line py-12">
        <div className={`${container} grid gap-x-12 gap-y-8 md:grid-cols-12`}>
          <div className="min-w-0 md:col-span-7">
            <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Pages read</h2>
            <ul className="mt-4 border-t border-line">
              {vendor.sources.map((source) => (
                <li key={source.id} className="border-b border-line py-2.5 text-[14px]">
                  <a href={source.url} target="_blank" rel="noreferrer noopener" className={textLink}>
                    {source.label}
                  </a>
                  <span className="mt-0.5 block truncate text-[13px] text-ink-3">{source.url}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="min-w-0 md:col-span-5">
            <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Work at {vendor.name}?</h2>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-2">
              Fix anything that is wrong here. We merge it once it matches your public pricing
              page.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <a href={editFile(file)} target="_blank" rel="noreferrer noopener" className={btnSm.primary}>
                Edit this platform
              </a>
              <Link to="/contribute" className={btnSm.secondary}>
                How changes are reviewed
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
