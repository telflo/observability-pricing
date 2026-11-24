/**
 * Light or dark. Light is the default for everyone, whatever the system is set
 * to; dark is a choice the reader makes, kept in their browser.
 *
 * The choice lives on <html data-theme="dark">. No attribute means light.
 */

export type Theme = "light" | "dark";

export const THEME_KEY = "theme";

/**
 * Runs in <head> before the first paint, so a saved dark choice never flashes
 * light. Kept as a string because it has to run before any module loads.
 */
export const themeInitScript = `try{if(localStorage.getItem("${THEME_KEY}")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`;

const listeners = new Set<() => void>();

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") root.dataset.theme = "dark";
  else delete root.dataset.theme;
  for (const listener of listeners) listener();
}

export function readTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function setTheme(theme: Theme) {
  apply(theme);
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be blocked (private windows, site data off). The page still switches.
  }
}

export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  // A choice made in another tab applies here too.
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_KEY) apply(e.newValue === "dark" ? "dark" : "light");
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
