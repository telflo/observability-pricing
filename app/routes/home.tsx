import { useEffect, useMemo, useState } from "react";
import type { Route } from "./+types/home";
import { PricingCalculatorPage } from "~/components/calculator/PricingCalculatorPage";
import { decodeState } from "~/pricing/url-state";
import { VENDORS } from "~/pricing/vendors";
import { SITE } from "~/site";

const TITLE = `${SITE.name}: price your telemetry at ${VENDORS.length} platforms`;
const DESCRIPTION = `Price one telemetry workload at ${VENDORS.length} observability platforms. Public list prices, each linked to its source. Open source.`;

export function meta({}: Route.MetaArgs) {
  return [
    { title: TITLE },
    { name: "description", content: DESCRIPTION },
    // The canonical is the bare address: a shared link with inputs in its
    // query is the same page, not a duplicate.
    { tagName: "link", rel: "canonical", href: `${SITE.url}/` },
    { property: "og:title", content: TITLE },
    { property: "og:description", content: DESCRIPTION },
    { property: "og:type", content: "website" },
    { property: "og:url", content: `${SITE.url}/` },
    {
      "script:ld+json": {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        name: SITE.name,
        url: `${SITE.url}/`,
        description: DESCRIPTION,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        maintainer: { "@type": "Organization", name: SITE.maintainer.name, url: SITE.maintainer.url },
      },
    },
  ];
}

export default function Home() {
  // The page is built ahead of time with the default workload, and a link
  // carries one in the query. The first render has to match the built
  // page, so the link's state is read right after it and applied once.
  const [search, setSearch] = useState<string | null>(null);
  useEffect(() => setSearch(window.location.search), []);

  const fromLink = search !== null && search.length > 1;
  const initial = useMemo(
    () => decodeState(new URLSearchParams(fromLink && search ? search : "")),
    [fromLink, search],
  );

  return <PricingCalculatorPage key={fromLink ? "link" : "default"} initial={initial} />;
}
