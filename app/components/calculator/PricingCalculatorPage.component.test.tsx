import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { decodeState } from "~/pricing/url-state";
import { VENDORS } from "~/pricing/vendors";
import { PricingCalculatorPage } from "./PricingCalculatorPage";

function renderPage(query = "") {
  return render(
    <MemoryRouter>
      <PricingCalculatorPage initial={decodeState(new URLSearchParams(query))} />
    </MemoryRouter>,
  );
}

const rowButtons = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>('button[aria-controls^="receipt-"]')];

describe("PricingCalculatorPage", () => {
  it("prices profiles only where a rate is published, and still lists every platform once", () => {
    const { container } = renderPage("po=1");
    expect(screen.getByRole("switch", { name: "Send profiles" }).getAttribute("aria-checked")).toBe("true");
    const rows = rowButtons(container).map((b) => b.getAttribute("aria-controls")!.replace("receipt-", ""));
    const unpriced = [...container.querySelectorAll<HTMLAnchorElement>('#not-priced a[href^="/backends/"]')].map(
      (a) => a.getAttribute("href")!.replace("/backends/", ""),
    );
    expect([...rows, ...unpriced].sort()).toEqual(VENDORS.map((v) => v.id).sort());
    // Switching it off from the form puts the default ranking back.
    fireEvent.click(screen.getByRole("switch", { name: "Send profiles" }));
    expect(screen.getByRole("switch", { name: "Send profiles" }).getAttribute("aria-checked")).toBe("false");
  });

  it("lists every platform once", () => {
    const { container } = renderPage();
    // A platform is either a priced row or a link under "Not priced here".
    const rows = rowButtons(container).map((b) => b.getAttribute("aria-controls")!.replace("receipt-", ""));
    const unpriced = [...container.querySelectorAll<HTMLAnchorElement>('#not-priced a[href^="/backends/"]')].map(
      (a) => a.getAttribute("href")!.replace("/backends/", ""),
    );
    expect(unpriced.length).toBeGreaterThan(0);
    expect([...rows, ...unpriced].sort()).toEqual(VENDORS.map((v) => v.id).sort());
  });

  it("opens a receipt whose rates link to the vendor's pages", () => {
    const { container } = renderPage();
    const first = rowButtons(container)[0];
    expect(first.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("true");

    const receipt = container.querySelector<HTMLElement>(`#${first.getAttribute("aria-controls")}`)!;
    const links = [...receipt.querySelectorAll<HTMLAnchorElement>("a[href]")];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.href).toMatch(/^https:\/\//);
      expect(link.target).toBe("_blank");
      expect(link.rel).toContain("noopener");
    }
    expect(within(receipt).getByText(/billing rules read on/)).toBeInTheDocument();

    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("false");
  });

  it("re-prices when a reference workload is picked", () => {
    const { container } = renderPage();
    const amounts = () => rowButtons(container).map((b) => b.textContent);
    const before = amounts();
    fireEvent.click(screen.getByRole("radio", { name: /Small team/ }));
    expect(screen.getByRole("radio", { name: /Small team/ })).toHaveAttribute("aria-checked", "true");
    expect(amounts()).not.toEqual(before);
  });

  it("restores a shared link, including a switched-off signal", () => {
    renderPage("lg=1000&to=0&term=m");
    expect(screen.getByLabelText("Log volume in GB per day")).toHaveValue("1,000");
    expect(screen.getByRole("switch", { name: "Send traces" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "Pay as you go" })).toHaveAttribute("aria-checked", "true");
    // No reference workload matches a custom one.
    for (const radio of within(screen.getByRole("radiogroup", { name: "Reference workload" })).getAllByRole("radio")) {
      expect(radio).toHaveAttribute("aria-checked", "false");
    }
  });

  it("accepts shorthand in number fields", () => {
    renderPage();
    const field = screen.getByLabelText("Active metric series");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "1.5m" } });
    fireEvent.blur(field);
    expect(field).toHaveValue("1,500,000");
  });

  it("says there is nothing to price when every signal is off", () => {
    const { container } = renderPage("lo=0&mo=0&to=0");
    expect(screen.getByRole("heading", { name: "Nothing to price yet" })).toBeInTheDocument();
    expect(container.textContent).toContain("Switch on a signal to see what it costs.");
    expect(rowButtons(container)).toEqual([]);
    expect(container.textContent).not.toContain("$0.00");
  });

  it("marks a platform that keeps data for less time than was set", () => {
    // Ask for the longest retention on offer; any platform that prices less says so on its row.
    const { container } = renderPage("lr=365&tr=90&mr=24");
    const short = rowButtons(container).filter((b) => /keeps (logs|metrics|traces)/.test(b.textContent ?? ""));
    for (const row of short) {
      fireEvent.click(row);
      const receipt = container.querySelector<HTMLElement>(`#${row.getAttribute("aria-controls")}`)!;
      expect(receipt.textContent).toMatch(/are kept .* at this price/);
      fireEvent.click(row);
    }
    // The header counts them, so the range is never read as like-for-like by accident.
    if (short.length > 0) expect(container.textContent).toMatch(/less time than you set/);
  });

  it("discards a typed value on Escape and keeps it on Enter", () => {
    renderPage();
    const hosts = screen.getByLabelText("Hosts or nodes");
    fireEvent.focus(hosts);
    fireEvent.change(hosts, { target: { value: "999" } });
    fireEvent.keyDown(hosts, { key: "Escape" });
    fireEvent.blur(hosts);
    expect(hosts).toHaveValue("200");

    fireEvent.focus(hosts);
    fireEvent.change(hosts, { target: { value: "350" } });
    fireEvent.keyDown(hosts, { key: "Enter" });
    fireEvent.blur(hosts);
    expect(hosts).toHaveValue("350");

    const bill = screen.getByLabelText("What you pay now, in dollars a month");
    fireEvent.focus(bill);
    fireEvent.change(bill, { target: { value: "42k" } });
    fireEvent.blur(bill);
    expect(bill).toHaveValue("42,000");
    fireEvent.focus(bill);
    fireEvent.change(bill, { target: { value: "1" } });
    fireEvent.keyDown(bill, { key: "Escape" });
    fireEvent.blur(bill);
    expect(bill).toHaveValue("42,000");
  });

  it("keeps several receipts open at once", () => {
    const { container } = renderPage();
    const [first, second] = rowButtons(container);
    fireEvent.click(first);
    fireEvent.click(second);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(second.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(second.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens a shared link in the same view", () => {
    const { container } = renderPage("p=y&o=h&v=datadog");
    expect(screen.getByRole("radio", { name: "Per year" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Sort platforms")).toHaveValue("high");
    const open = rowButtons(container).filter((b) => b.getAttribute("aria-expanded") === "true");
    expect(open.map((b) => b.getAttribute("aria-controls"))).toEqual(["receipt-datadog"]);
    // Highest first: the first fully priced row is the most expensive one.
    expect(rowButtons(container)[0].getAttribute("aria-controls")).toBe("receipt-datadog");
  });

  it("prices a full split even when a link names platforms that cannot be priced", () => {
    const { container } = renderPage("rl=honeycomb&rm=nope&rt=honeycomb");
    const split = container.querySelector<HTMLElement>("#split")!;
    expect(split.textContent).not.toContain("$0.00");
    expect(split.textContent).not.toContain("no fully priced backend");
    for (const signal of ["logs", "metrics", "traces"]) {
      const select = within(split).getByLabelText(`Platform for ${signal}`) as HTMLSelectElement;
      expect(select.value).not.toBe("");
      expect(select.value).not.toBe("nope");
    }
    expect(within(split).getByRole("heading", { name: "Lowest-cost split" })).toBeInTheDocument();
  });

  it("offers every reference workload as one keyboard group", () => {
    renderPage("lg=1000");
    const group = screen.getByRole("radiogroup", { name: "Reference workload" });
    const radios = within(group).getAllByRole("radio");
    // Nothing matches a custom workload, and the group is still one tab stop.
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toEqual([]);
    expect(radios.filter((r) => r.tabIndex === 0).length).toBe(1);
    fireEvent.keyDown(radios[0], { key: "ArrowRight" });
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radios[0], { key: "End" });
    expect(radios[radios.length - 1]).toHaveAttribute("aria-checked", "true");
  });

  it("estimates the volumes from the host count, says what it set, and can undo it", () => {
    renderPage("lg=500&h=300");
    const logs = screen.getByLabelText("Log volume in GB per day");
    expect(logs).toHaveValue("500");
    fireEvent.click(screen.getByRole("button", { name: "Estimate volumes from the host count" }));
    expect(logs).toHaveValue("480");
    expect(screen.getByLabelText("Active metric series")).toHaveValue("380,000");
    expect(screen.getByLabelText("Hosts or nodes")).toHaveValue("300");
    expect(document.body.textContent).toContain("Volumes set to 1.6 GB of logs a day");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(logs).toHaveValue("500");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("keeps the assumptions one click away and editable", () => {
    renderPage();
    const toggle = screen.getByRole("button", { name: "Assumptions" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Average span size in bytes")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const span = screen.getByLabelText("Average span size in bytes");
    fireEvent.focus(span);
    fireEvent.change(span, { target: { value: "2000" } });
    fireEvent.blur(span);
    expect(span).toHaveValue("2,000");
  });

  it("has a live region for the result", () => {
    renderPage();
    expect(screen.getByRole("status").textContent).toMatch(/platforms priced\. \$[\d,]+ to \$[\d,]+ a month\./);
  });

  it("says prices are list-price estimates and links to the method", () => {
    const { container } = renderPage();
    expect(container.textContent).toContain("Estimates at public list price, not quotes.");
    expect(screen.getByRole("link", { name: "How these numbers are made" })).toHaveAttribute("href", "/method");
  });

  it("drops the small-screen summary after a jump straight past the list", async () => {
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect");
    const listAt = (top: number) =>
      rect.mockReturnValue({
        top,
        bottom: top + 4000,
        left: 0,
        right: 0,
        width: 0,
        height: 4000,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect);
    try {
      // The list starts below the window, so the summary rides along.
      listAt(2000);
      renderPage();
      expect(screen.getByRole("link", { name: /See the list/ })).toBeInTheDocument();
      // End, or a link to a later section: the list is above the window now
      // and never crossed it on the way.
      listAt(-6000);
      fireEvent.scroll(window);
      await waitFor(() => expect(screen.queryByRole("link", { name: /See the list/ })).toBeNull());
    } finally {
      rect.mockRestore();
    }
  });
});
