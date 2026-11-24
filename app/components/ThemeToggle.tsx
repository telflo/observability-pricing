import { useSyncExternalStore } from "react";
import type { Theme } from "~/theme";
import { readTheme, setTheme, subscribeTheme } from "~/theme";
import { Segmented } from "./calculator/controls";

const OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Light or dark. The pages are built ahead of time as light, so that is what the server says. */
export function ThemeToggle() {
  const theme = useSyncExternalStore<Theme>(subscribeTheme, readTheme, () => "light");
  return <Segmented label="Color theme" value={theme} options={OPTIONS} onChange={setTheme} />;
}
