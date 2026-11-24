/**
 * The handful of class strings the site shares. Links and buttons are ink:
 * the only colors on a page are the ones that carry data.
 */

export const container = "mx-auto w-full max-w-6xl px-6";

export const btn = {
  primary:
    "inline-flex items-center justify-center gap-2 rounded-md bg-ink px-4 py-2 text-[15px] font-medium text-paper transition-colors hover:bg-ink-2",
  secondary:
    "inline-flex items-center justify-center gap-2 rounded-md border border-line-2 px-4 py-2 text-[15px] font-medium text-ink transition-colors hover:border-ink-3 hover:bg-paper-2",
};

export const btnSm = {
  primary:
    "inline-flex items-center justify-center gap-1.5 rounded-md bg-ink px-3.5 py-1.5 text-sm font-medium text-paper transition-colors hover:bg-ink-2",
  secondary:
    "inline-flex items-center justify-center gap-1.5 rounded-md border border-line-2 px-3.5 py-1.5 text-sm font-medium text-ink transition-colors hover:border-ink-3 hover:bg-paper-2",
};

export const textLink =
  "font-medium text-ink underline decoration-ink/35 underline-offset-[3px] transition-colors hover:decoration-ink";
