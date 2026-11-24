import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { SiteFooter } from "~/components/SiteFooter";
import { SiteHeader } from "~/components/SiteHeader";
import { VENDORS } from "~/pricing/vendors";
import { SITE, editFile, vendorFile } from "~/site";
import Backend from "./backend";
import Backends from "./backends";
import Contribute from "./contribute";
import Home from "./home";
import MethodPage from "./method";

function at(path: string, element: React.ReactNode, pattern = path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => window.history.replaceState(null, "", "/"));

describe("the list of platforms", () => {
  it("links every platform to a page", () => {
    // Looked up by address: twenty role queries over this page run close to the time limit.
    const { container } = at("/backends", <Backends />);
    for (const vendor of VENDORS) {
      const link = container.querySelector(`main a[href="/backends/${vendor.id}"], a[href="/backends/${vendor.id}"]`);
      expect(link?.textContent?.trim().startsWith(vendor.name), vendor.id).toBe(true);
    }
  });
});

describe("a platform's page", () => {
  it("shows every rate with the page it was read from", () => {
    for (const vendor of VENDORS) {
      const { container, unmount } = at(`/backends/${vendor.id}`, <Backend />, "/backends/:id");
      expect(screen.getByRole("heading", { level: 1, name: `${vendor.name} pricing` })).toBeInTheDocument();
      const rows = container.querySelectorAll("table tbody tr");
      expect(rows.length, vendor.id).toBe(vendor.rates.length);
      for (const row of rows) {
        const source = row.querySelector<HTMLAnchorElement>("a[href]");
        expect(source?.href, vendor.id).toMatch(/^https:\/\//);
      }
      unmount();
    }
  });

  it("points at the one file to change, and at the calculator", () => {
    at("/backends/datadog", <Backend />, "/backends/:id");
    const edit = screen.getByRole("link", { name: "Edit these prices" });
    expect(edit).toHaveAttribute("href", editFile(vendorFile("datadog")));
    expect(edit.getAttribute("href")).toContain("app/pricing/vendors/datadog.ts");
    expect(screen.getByRole("link", { name: "Price your workload" })).toHaveAttribute(
      "href",
      "/?v=datadog#results",
    );
  });

  it("prices all six reference workloads", () => {
    at("/backends/grafana-cloud", <Backend />, "/backends/:id");
    const list = screen.getByRole("list", { name: "Reference workloads" });
    expect(within(list).getAllByRole("listitem").length).toBe(6);
    expect(list.textContent).toMatch(/\$[\d,]+/);
  });

  it("says so when there is no such platform", () => {
    at("/backends/nope", <Backend />, "/backends/:id");
    expect(screen.getByRole("heading", { name: "No platform by that name" })).toBeInTheDocument();
  });
});

describe("the contribute page", () => {
  it("covers a wrong price, a missing product, the method and the data", () => {
    at("/contribute", <Contribute />);
    for (const name of [
      "A price is wrong",
      "Your product is missing",
      "You disagree with the method",
      "What gets merged",
      "Use the data",
    ]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "CONTRIBUTING.md" })).toBeInTheDocument();
  });
});

describe("the site's frame", () => {
  it("names the maintainer on every page and keeps the pitch out", () => {
    at(
      "/",
      <>
        <SiteHeader />
        <SiteFooter />
      </>,
    );
    const footer = screen.getByRole("contentinfo");
    expect(footer.textContent).toContain(`Maintained by ${SITE.maintainer.name}`);
    expect(footer.textContent).toContain("does not sell an observability platform");
    expect(within(footer).getByRole("link", { name: "GitHub" })).toHaveAttribute(
      "href",
      SITE.repo,
    );
  });
});

describe("the calculator page", () => {
  it("starts from the default workload, then adopts the one in the link", async () => {
    window.history.replaceState(null, "", "/?lg=1000&v=datadog");
    await act(async () => {
      at("/", <Home />);
    });
    expect(screen.getByLabelText("Log volume in GB per day")).toHaveValue("1,000");
    const open = document.querySelectorAll('button[aria-controls^="receipt-"][aria-expanded="true"]');
    expect([...open].map((b) => b.getAttribute("aria-controls"))).toEqual(["receipt-datadog"]);
  });

  it("keeps the default workload when the link carries nothing", async () => {
    await act(async () => {
      at("/", <Home />);
    });
    expect(screen.getByLabelText("Log volume in GB per day")).toHaveValue("330");
  });

  it("mentions the maintainer only in the disclosure, never beside a price", async () => {
    await act(async () => {
      at("/", <Home />);
    });
    const calculator = screen.getByRole("region", { name: "Calculator" });
    expect(calculator.textContent).not.toContain(SITE.maintainer.name);
    for (const id of ["split", "compare"]) {
      expect(document.getElementById(id)!.textContent).not.toContain(SITE.maintainer.name);
    }
  });
});

describe("the method page", () => {
  it("says who runs the site", () => {
    at("/method", <MethodPage />);
    expect(screen.getByRole("heading", { level: 1, name: "How these numbers are made" })).toBeInTheDocument();
    const text = document.getElementById("method")!.textContent;
    expect(text).toContain(`maintained by ${SITE.maintainer.name}`);
    expect(text).toContain("does not sell an observability platform");
    expect(text).toContain("They are not quotes");
  });
});
