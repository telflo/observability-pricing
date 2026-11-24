/**
 * Everything that names the site, in one place. Renaming it, moving it to
 * another domain or pointing it at another repository is an edit here.
 */
export const SITE = {
  name: "Observability Pricing",
  domain: "observabilitypricing.org",
  url: "https://observabilitypricing.org",
  tagline: "An open price book for observability platforms",
  /** The public repository the prices, the engine and this site live in. */
  repo: "https://github.com/telflo/observability-pricing",
  branch: "main",
  /** Who keeps the site running. Disclosed on every page. */
  maintainer: { name: "Telflo", url: "https://telflo.com" },
  /**
   * True until the repository is public and the domain is live. While it is,
   * a strip at the top says the repository links do not work yet.
   */
  preview: true,
} as const;

/** Where one platform's prices live in the repository. */
export const vendorFile = (id: string) => `app/pricing/vendors/${id}.ts`;

export const repoFile = (path: string) => `${SITE.repo}/blob/${SITE.branch}/${path}`;

/** GitHub's in-browser editor: the shortest path from "this is wrong" to a pull request. */
export const editFile = (path: string) => `${SITE.repo}/edit/${SITE.branch}/${path}`;

/** A new issue from one of the templates in .github/ISSUE_TEMPLATE. */
export function newIssue(template: "price-correction" | "new-backend" | "method", title = ""): string {
  const query = new URLSearchParams({ template: `${template}.yml` });
  if (title) query.set("title", title);
  return `${SITE.repo}/issues/new?${query.toString()}`;
}
