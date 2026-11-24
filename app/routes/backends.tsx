import { Link } from "react-router";
import type { Route } from "./+types/backends";
import { formatDay } from "~/components/calculator/Ledger";
import { btnSm, container, textLink } from "~/components/ui";
import { SIGNALS, SIGNAL_NAME } from "~/pricing/engine";
import { UNLISTED } from "~/pricing/unlisted";
import { VENDORS } from "~/pricing/vendors";
import { DEFAULT_SETTINGS } from "~/pricing/workloads";
import { SITE, newIssue } from "~/site";

const TITLE = `Observability platforms and their public prices | ${SITE.name}`;
const DESCRIPTION = `The ${VENDORS.length} observability platforms priced here, the plan each estimate assumes, and the day each vendor's pricing pages were last read.`;

export function meta({}: Route.MetaArgs) {
  return [
    { title: TITLE },
    { name: "description", content: DESCRIPTION },
    { tagName: "link", rel: "canonical", href: `${SITE.url}/backends` },
    { property: "og:title", content: TITLE },
    { property: "og:description", content: DESCRIPTION },
  ];
}

/** "Logs, metrics and traces", from the signals a platform publishes a price for. */
function pricedSignals(coverage: Record<string, string>): string {
  const names = SIGNALS.filter((signal) => coverage[signal] === "priced").map((signal) =>
    SIGNAL_NAME[signal].toLowerCase(),
  );
  if (names.length === 0) return "None in full";
  const text = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const COLUMNS = "md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_11rem_3.5rem_7rem]";

export default function Backends() {
  return (
    <>
      <section className="pt-10 pb-8 md:pt-14">
        <div className={container}>
          <h1 className="max-w-3xl text-[clamp(1.9rem,1.4rem+1.9vw,2.9rem)] leading-[1.06] font-semibold tracking-[-0.03em] text-ink">
            Platforms priced here
          </h1>
        </div>
      </section>

      <section className="pb-16">
        <div className={container}>
          <div
            aria-hidden="true"
            className={`hidden gap-x-6 border-b border-line-2 pb-2 text-xs font-medium text-ink-3 md:grid ${COLUMNS}`}
          >
            <span>Platform</span>
            <span>Plan priced</span>
            <span>Public price for</span>
            <span className="text-right">Rates</span>
            <span className="text-right">Pages read</span>
          </div>
          <ul>
            {VENDORS.map((vendor) => (
              <li key={vendor.id} className="border-b border-line">
                <Link
                  to={`/backends/${vendor.id}`}
                  className={`group grid grid-cols-1 gap-x-6 gap-y-1 py-3.5 transition-colors hover:bg-paper-2 ${COLUMNS}`}
                >
                  <span className="text-[15px] font-semibold text-ink decoration-line-2 underline-offset-4 group-hover:underline">
                    {vendor.name}
                  </span>
                  <span className="text-[14px] leading-snug text-ink-2">{vendor.plan(DEFAULT_SETTINGS)}</span>
                  <span className="text-[14px] text-ink-2">
                    <span className="text-ink-3 md:hidden">Public price for: </span>
                    {pricedSignals(vendor.coverage)}
                  </span>
                  <span className="text-[14px] text-ink-2 md:text-right">
                    {vendor.rates.length}
                    <span className="text-ink-3 md:hidden"> rates</span>
                  </span>
                  <span className="text-[14px] text-ink-2 md:text-right">
                    <span className="text-ink-3 md:hidden">Read </span>
                    {formatDay(vendor.checkedOn)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          <div className="mt-14 grid gap-x-12 gap-y-8 md:grid-cols-12">
            <div className="md:col-span-7">
              <h2 className="text-xl font-semibold tracking-[-0.01em] text-ink">Not priced here</h2>
              <ul className="mt-4 border-t border-line">
                {UNLISTED.map((vendor) => (
                  <li key={vendor.name} className="border-b border-line py-3 text-[14px]">
                    <a href={vendor.url} target="_blank" rel="noreferrer noopener" className={textLink}>
                      {vendor.name}
                    </a>
                    <span className="mt-0.5 block text-ink-3">{vendor.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="md:col-span-5">
              <h2 className="text-xl font-semibold tracking-[-0.01em] text-ink">
                Missing, or out of date?
              </h2>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link to="/contribute" className={btnSm.primary}>
                  How to add or fix a platform
                </Link>
                <a
                  href={newIssue("new-backend")}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={btnSm.secondary}
                >
                  Ask for a platform
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
