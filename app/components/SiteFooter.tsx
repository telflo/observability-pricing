import { Link } from "react-router";
import { SITE, newIssue } from "~/site";
import { Mark } from "./SiteHeader";
import { ThemeToggle } from "./ThemeToggle";
import { container, textLink } from "./ui";

const quiet = "text-[14px] text-ink-2 transition-colors hover:text-ink";

export function SiteFooter() {
  return (
    <footer className="border-t border-line-2 bg-paper-2 py-12">
      <div
        className={`${container} grid gap-10 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:gap-x-14`}
      >
        <div className="min-w-0 md:col-span-2 lg:col-span-1">
          <p className="flex items-center gap-2.5 text-[15px] font-semibold text-ink">
            <Mark />
            {SITE.name}
          </p>
          <p className="mt-3 max-w-md text-[14px] leading-relaxed text-ink-2">
            Maintained by{" "}
            <a href={SITE.maintainer.url} target="_blank" rel="noreferrer noopener" className={textLink}>
              {SITE.maintainer.name}
            </a>
            , which does not sell an observability platform. No vendor pays to be listed.{" "}
            <Link to="/method#who" className={textLink}>
              Who runs this
            </Link>
          </p>
        </div>

        <nav aria-label="Pages" className="flex min-w-0 flex-col gap-2">
          <p className="text-[13px] font-semibold text-ink">The price book</p>
          <Link to="/" className={quiet}>
            Calculator
          </Link>
          <Link to="/backends" className={quiet}>
            Platforms
          </Link>
          <Link to="/method" className={quiet}>
            How the numbers are made
          </Link>
          <a href="/data/rates.json" className={quiet}>
            Rates (JSON)
          </a>
        </nav>

        <nav aria-label="Contributing" className="flex min-w-0 flex-col gap-2">
          <p className="text-[13px] font-semibold text-ink">Open source</p>
          <Link to="/contribute" className={quiet}>
            Fix a price or add a platform
          </Link>
          <a href={SITE.repo} target="_blank" rel="noreferrer noopener" className={quiet}>
            GitHub
          </a>
          <a href={newIssue("price-correction")} target="_blank" rel="noreferrer noopener" className={quiet}>
            Report a wrong price
          </a>
        </nav>
      </div>
      <div className={container}>
        <div className="mt-10 flex flex-col gap-5 border-t border-line pt-5 sm:flex-row sm:items-start sm:justify-between sm:gap-10">
          <p className="max-w-2xl text-[13px] leading-relaxed text-ink-3">
            Code and price data under Apache-2.0. Product names belong to their owners.
          </p>
          <div className="shrink-0">
            <ThemeToggle />
          </div>
        </div>
      </div>
    </footer>
  );
}
