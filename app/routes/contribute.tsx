import { Link } from "react-router";
import type { Route } from "./+types/contribute";
import { btnSm, container, textLink } from "~/components/ui";
import { SITE, newIssue, repoFile } from "~/site";

const TITLE = `Fix a price or add a platform | ${SITE.name}`;
const DESCRIPTION =
  "How to correct a price or add a platform. Every price is in a public repository, one file per platform.";

export function meta({}: Route.MetaArgs) {
  return [
    { title: TITLE },
    { name: "description", content: DESCRIPTION },
    { tagName: "link", rel: "canonical", href: `${SITE.url}/contribute` },
    { property: "og:title", content: TITLE },
    { property: "og:description", content: DESCRIPTION },
  ];
}

function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-line py-12">
      <div className={`${container} grid gap-x-12 gap-y-4 md:grid-cols-12`}>
        <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink md:col-span-4">{title}</h2>
        <div className="min-w-0 space-y-4 text-[15px] leading-relaxed text-ink-2 md:col-span-8">
          {children}
        </div>
      </div>
    </section>
  );
}

function External({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={textLink}>
      {children}
    </a>
  );
}

export default function Contribute() {
  return (
    <>
      <section className="pt-10 pb-10 md:pt-14">
        <div className={container}>
          <h1 className="max-w-3xl text-[clamp(1.9rem,1.4rem+1.9vw,2.9rem)] leading-[1.06] font-semibold tracking-[-0.03em] text-ink">
            Fix a price or add a platform
          </h1>
          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-2">
            Every price lives in a public repository, one file per platform.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <a href={SITE.repo} target="_blank" rel="noreferrer noopener" className={btnSm.primary}>
              Open the repository
            </a>
            <a
              href={newIssue("price-correction")}
              target="_blank"
              rel="noreferrer noopener"
              className={btnSm.secondary}
            >
              Report a wrong price
            </a>
          </div>
        </div>
      </section>

      <Section title="A price is wrong">
        <p>
          Open the platform under{" "}
          <Link to="/backends" className={textLink}>
            Platforms
          </Link>{" "}
          and click Edit these prices. Change the number, then open a pull request with a link to
          the vendor page that shows it.
        </p>
        <p>
          Or <External href={newIssue("price-correction")}>report it</External> and we will fix it.
        </p>
      </Section>

      <Section title="Your product is missing">
        <p>
          Open a pull request. Read{" "}
          <External href={repoFile("CONTRIBUTING.md")}>CONTRIBUTING.md</External> first. Or{" "}
          <External href={newIssue("new-backend")}>open an issue</External> and we will add it.
        </p>
        <p>We can only price what is public. A product priced by quote is listed as not priced.</p>
      </Section>

      <Section title="You disagree with the method">
        <p>
          The method is{" "}
          <Link to="/method" className={textLink}>
            written down
          </Link>
          . If it treats a product unfairly,{" "}
          <External href={newIssue("method")}>open a method question</External>. A method changes
          for every platform at once.
        </p>
      </Section>

      <Section title="What gets merged">
        <ul className="space-y-2.5">
          {[
            ["Public pages only.", "A rate must be on a page anyone can open without an account."],
            [
              "List price in US dollars.",
              "Published tiers and free allowances apply. Negotiated discounts do not.",
            ],
            ["A missing price stays missing.", "Nothing is guessed."],
            ["The same rules for every platform.", ""],
            ["Plain wording.", "Notes say what is billed. They do not rate the product."],
          ].map(([lead, rest]) => (
            <li key={lead} className="relative pl-4">
              <span aria-hidden="true" className="absolute top-[0.7em] left-0 h-px w-2.5 bg-line-2" />
              <span className="font-semibold text-ink">{lead}</span> {rest}
            </li>
          ))}
        </ul>
        <p>
          Work for a vendor? Say so in the pull request. How disputes are decided is in{" "}
          <External href={repoFile("GOVERNANCE.md")}>GOVERNANCE.md</External>.
        </p>
      </Section>

      <Section title="Use the data">
        <p>
          All rates are in{" "}
          <a href="/data/rates.json" className={textLink}>
            rates.json
          </a>{" "}
          and{" "}
          <a href="/data/rates.csv" className={textLink}>
            rates.csv
          </a>
          , under Apache-2.0, as is the code.
        </p>
      </Section>
    </>
  );
}
