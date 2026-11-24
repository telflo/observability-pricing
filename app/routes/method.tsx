import type { Route } from "./+types/method";
import { Method } from "~/components/calculator/Method";
import { container } from "~/components/ui";
import { VENDORS } from "~/pricing/vendors";
import { DEFAULT_SETTINGS } from "~/pricing/workloads";
import { SITE } from "~/site";

const TITLE = `How these numbers are made | ${SITE.name}`;
const DESCRIPTION =
  "Where the prices come from, how a workload is converted for each vendor, what the estimates leave out and who runs the site.";

export function meta({}: Route.MetaArgs) {
  return [
    { title: TITLE },
    { name: "description", content: DESCRIPTION },
    { tagName: "link", rel: "canonical", href: `${SITE.url}/method` },
    { property: "og:title", content: TITLE },
    { property: "og:description", content: DESCRIPTION },
  ];
}

export default function MethodPage() {
  return (
    <section id="method" className="pt-10 pb-16 md:pt-14">
      <div className={container}>
        <h1 className="max-w-3xl text-[clamp(1.9rem,1.4rem+1.9vw,2.9rem)] leading-[1.06] font-semibold tracking-[-0.03em] text-ink">
          How these numbers are made
        </h1>
        <div className="mt-8">
          <Method vendors={VENDORS} s={DEFAULT_SETTINGS} />
        </div>
      </div>
    </section>
  );
}
