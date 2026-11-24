import { Link, NavLink } from "react-router";
import { SITE } from "~/site";
import { container } from "./ui";

/** GitHub's mark, drawn in the text color so it follows the theme. */
function GitHubMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0 fill-current">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** The mark: three bars in the three signal colors, the same ones the bills are drawn in. */
export function Mark({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`inline-flex w-[18px] flex-col gap-[3px] ${className}`}>
      <span className="h-[4px] w-full rounded-[1px] bg-sig-logs" />
      <span className="h-[4px] w-[66%] rounded-[1px] bg-sig-metrics" />
      <span className="h-[4px] w-[40%] rounded-[1px] bg-sig-traces" />
    </span>
  );
}

const NAV = [
  { to: "/", label: "Calculator", end: true },
  { to: "/backends", label: "Platforms", end: false },
  { to: "/contribute", label: "Contribute", end: false },
];

const navClass = ({ isActive }: { isActive: boolean }) =>
  `text-[14px] font-medium transition-colors ${
    isActive ? "text-ink" : "text-ink-3 hover:text-ink"
  }`;

export function SiteHeader() {
  return (
    <>
      {SITE.preview ? (
        <p className="border-b border-line bg-paper-2 px-6 py-1.5 text-center text-xs text-ink-2">
          Preview build. Repository links do not work yet.
        </p>
      ) : null}
      <header className="sticky top-0 z-40 h-16 border-b border-line bg-paper">
        <div className={`${container} flex h-full items-center justify-between gap-6`}>
          <div className="flex items-center gap-2.5">
            <Mark />
            <div className="flex flex-col">
              <Link to="/" className="text-[16px] leading-tight font-semibold tracking-[-0.01em] text-ink">
                {SITE.name}
              </Link>
              <p className="text-[11px] leading-tight text-ink-3">
                by{" "}
                <a
                  href={SITE.maintainer.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="transition-colors hover:text-ink"
                >
                  {SITE.maintainer.name}
                </a>
              </p>
            </div>
          </div>

          <nav aria-label="Site" className="hidden items-center gap-7 md:flex">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                {item.label}
              </NavLink>
            ))}
            <a
              href={SITE.repo}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 rounded-md border border-line-2 px-3 py-1.5 text-[14px] font-medium text-ink transition-colors hover:border-ink-3 hover:bg-paper-2"
            >
              <GitHubMark />
              GitHub
            </a>
          </nav>

          <details className="group relative md:hidden">
            <summary className="cursor-pointer list-none rounded-md border border-line-2 px-3 py-1.5 text-[14px] font-medium text-ink [&::-webkit-details-marker]:hidden">
              Menu
            </summary>
            <nav
              aria-label="Site"
              className="absolute right-0 mt-2 flex w-52 flex-col rounded-md border border-line-2 bg-paper py-1.5"
            >
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `px-4 py-2 ${navClass({ isActive })}`}
                >
                  {item.label}
                </NavLink>
              ))}
              <a
                href={SITE.repo}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-2 px-4 py-2 text-[14px] font-medium text-ink-3 hover:text-ink"
              >
                <GitHubMark />
                GitHub
              </a>
            </nav>
          </details>
        </div>
      </header>
    </>
  );
}
