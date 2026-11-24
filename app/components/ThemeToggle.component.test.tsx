import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { THEME_KEY, themeInitScript } from "~/theme";
import { ThemeToggle } from "./ThemeToggle";

const root = document.documentElement;
const option = (name: string) => screen.getByRole("radio", { name });

afterEach(() => {
  delete root.dataset.theme;
  window.localStorage.clear();
});

describe("ThemeToggle", () => {
  it("starts light", () => {
    render(<ThemeToggle />);
    expect(option("Light")).toHaveAttribute("aria-checked", "true");
    expect(option("Dark")).toHaveAttribute("aria-checked", "false");
    expect(root.dataset.theme).toBeUndefined();
  });

  it("switches to dark and back, and remembers the choice", () => {
    render(<ThemeToggle />);
    fireEvent.click(option("Dark"));
    expect(root.dataset.theme).toBe("dark");
    expect(option("Dark")).toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");

    fireEvent.click(option("Light"));
    expect(root.dataset.theme).toBeUndefined();
    expect(option("Light")).toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("light");
  });

  it("keeps every copy of the control in step", () => {
    render(
      <>
        <ThemeToggle />
        <ThemeToggle />
      </>,
    );
    fireEvent.click(screen.getAllByRole("radio", { name: "Dark" })[0]);
    for (const dark of screen.getAllByRole("radio", { name: "Dark" })) {
      expect(dark).toHaveAttribute("aria-checked", "true");
    }
  });

  it("follows a choice made in another tab", () => {
    render(<ThemeToggle />);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: "dark" }));
    });
    expect(root.dataset.theme).toBe("dark");
    expect(option("Dark")).toHaveAttribute("aria-checked", "true");
  });
});

describe("the script that runs before the first paint", () => {
  const run = () => new Function(themeInitScript)();

  it("applies a saved dark choice", () => {
    window.localStorage.setItem(THEME_KEY, "dark");
    run();
    expect(root.dataset.theme).toBe("dark");
  });

  it("leaves the page light with nothing saved, or with light saved", () => {
    run();
    expect(root.dataset.theme).toBeUndefined();
    window.localStorage.setItem(THEME_KEY, "light");
    run();
    expect(root.dataset.theme).toBeUndefined();
  });
});

describe("the stylesheet", () => {
  it("does not go dark because the system is dark", () => {
    const css = readFileSync("app/app.css", "utf8");
    expect(css).not.toContain("prefers-color-scheme");
    expect(css).toContain(':root[data-theme="dark"]');
  });
});
