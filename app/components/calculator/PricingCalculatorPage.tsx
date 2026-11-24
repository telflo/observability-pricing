/**
 * The calculator: one telemetry workload, priced at every platform.
 *
 * Layout: a short header, the reference workloads, then the workbench (the
 * form on the left, the ranked bills on the right), then split routing and the
 * head-to-head comparison.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { container, btnSm, textLink } from "~/components/ui";
import { toCsv, toMarkdown } from "~/pricing/export";
import { usd } from "~/pricing/format";
import type { Bucket } from "~/pricing/types";
import { BUCKETS } from "~/pricing/types";
import { activeSignals } from "~/pricing/units";
import { UNLISTED } from "~/pricing/unlisted";
import type { CalculatorState } from "~/pricing/url-state";
import { FIRST_CHECKED } from "~/pricing/vendors";
import { PRESETS } from "~/pricing/workloads";
import { MoneyField, Segmented, SelectField } from "./controls";
import { HeadToHead } from "./HeadToHead";
import { BUCKET_BG, BUCKET_LABEL, GAP_NAME, Ledger, formatDay } from "./Ledger";
import { SplitRouting } from "./SplitRouting";
import { WorkloadPanel } from "./WorkloadPanel";
import type { Sort } from "./use-calculator";
import { useCalculator } from "./use-calculator";

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="max-w-3xl text-[clamp(1.6rem,1.25rem+1.4vw,2.25rem)] leading-[1.1] font-semibold tracking-[-0.02em] text-ink">
      {children}
    </h2>
  );
}

function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5" aria-label="What the bar colors mean">
      {BUCKETS.map((bucket: Bucket) => (
        <li key={bucket} className="inline-flex items-center gap-2 text-[13px] text-ink-2">
          <span aria-hidden="true" className={`size-2.5 rounded-[3px] ${BUCKET_BG[bucket]}`} />
          {BUCKET_LABEL[bucket]}
        </li>
      ))}
    </ul>
  );
}

/** A button that confirms what it did for a moment, then goes back. */
function ActionButton({
  label,
  done,
  failed = "Could not copy",
  onAction,
}: {
  label: string;
  done: string;
  failed?: string;
  onAction: () => Promise<void> | void;
}) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  // One pending reset at a time, dropped if the button goes away first.
  const reset = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(reset.current), []);
  return (
    <button
      type="button"
      className={btnSm.secondary}
      onClick={async () => {
        try {
          await onAction();
          setState("done");
        } catch {
          // The clipboard can be refused (permissions, an insecure context).
          setState("failed");
        }
        window.clearTimeout(reset.current);
        reset.current = window.setTimeout(() => setState("idle"), 1600);
      }}
    >
      <span aria-live="polite">{state === "done" ? done : state === "failed" ? failed : label}</span>
    </button>
  );
}

/** A value that follows its source once the source has been still for a moment. */
function useDelayed<T>(value: T, delayMs: number): T {
  const [delayed, setDelayed] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDelayed(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return delayed;
}

/** True while the element has not been scrolled to yet: it is below the window. */
function useBelowFold<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [below, setBelow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Read the position on every scroll. An intersection observer alone misses
    // a jump straight past the element (End, or a link to a later section),
    // because the element never crosses the window on the way.
    let frame = 0;
    const read = () => {
      frame = 0;
      setBelow(el.getBoundingClientRect().top >= window.innerHeight);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // The form above can grow or shrink and move the list without a scroll.
    const observer =
      typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(schedule);
    observer?.observe(el);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, []);
  return { ref, below };
}

function download(filename: string, text: string) {
  // The byte-order mark makes spreadsheet apps read the file as UTF-8.
  const url = URL.createObjectURL(new Blob(["﻿", text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking in the same tick can cancel the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PricingCalculatorPage({ initial }: { initial: CalculatorState }) {
  const calc = useCalculator(initial);
  const { state, settled, complete, ordered, period } = calc;

  const k = period === "year" ? 12 : 1;
  const anySignal = activeSignals(state.w).length > 0;
  // estimateAll returns complete estimates lowest first.
  const low = usd((complete[0]?.monthly ?? 0) * k);
  const high = usd((complete[complete.length - 1]?.monthly ?? 0) * k);
  const range = low === high ? low : `${low} to ${high}`;
  const priced = anySignal && complete.length > 0;
  const belowBill = complete.filter((e) => e.monthly < (state.bill ?? 0)).length;
  const partial = anySignal ? ordered.filter((e) => !e.complete) : [];
  const preset = PRESETS.find((p) => p.id === calc.presetId) ?? null;
  const results = useBelowFold<HTMLDivElement>();

  // "See every line" in the head-to-head: open that platform's receipt in the
  // list and bring its row to the top.
  const openReceipt = (id: string) => {
    calc.open(id);
    requestAnimationFrame(() => document.getElementById(`row-${id}`)?.scrollIntoView());
  };

  // Read out the new result once the inputs have stopped moving.
  const announcement = useDelayed(
    priced
      ? `${complete.length} ${complete.length === 1 ? "platform" : "platforms"} priced. ${range} a ${period}.${
          complete[0] ? ` Lowest: ${complete[0].vendor.name}.` : ""
        }`
      : anySignal
        ? "No platform publishes a price for all of this."
        : "Nothing to price yet.",
    700,
  );

  return (
    <>
      <section className="pt-10 pb-6 md:pt-14 md:pb-8">
        <div className={container}>
          <div className="flex items-center justify-between gap-6">
            <div className="min-w-0">
              <h1 className="max-w-[14ch] text-[clamp(2.3rem,1.3rem+4vw,4.25rem)] leading-[1] font-semibold tracking-[-0.04em] text-ink lowercase">
                come come, all are welcome
              </h1>
              <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-ink-2">
                Price your logs, metrics and traces on all major observability platforms
              </p>
            </div>
            <img
              src="/santa.gif"
              alt="Santa waving you over"
              width={208}
              height={208}
              className="size-28 shrink-0 border-[3px] border-[#c0c0c0] [border-style:ridge] [image-rendering:pixelated] sm:size-40 md:size-52"
            />
          </div>
          <p className="mt-6 text-[13.5px] text-ink-3">Every rate checked on or after {formatDay(FIRST_CHECKED)}</p>
        </div>
      </section>

      <section className="pb-16 md:pb-24" aria-label="Calculator">
        <div className={container}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-4">
            <span className="text-[13.5px] text-ink-3">Start from</span>
            <div className="hidden md:block">
              <Segmented
                label="Reference workload"
                value={calc.presetId ?? ""}
                options={PRESETS.map((p) => ({ value: p.id, label: p.name }))}
                onChange={calc.applyPreset}
              />
            </div>
            <div className="min-w-0 flex-1 md:hidden">
              <SelectField
                size="lg"
                label="Reference workload"
                value={calc.presetId ?? ""}
                options={[
                  ...(preset ? [] : [{ value: "", label: "Custom numbers" }]),
                  ...PRESETS.map((p) => ({ value: p.id, label: p.name })),
                ]}
                onChange={(id) => {
                  if (id) calc.applyPreset(id);
                }}
              />
            </div>
            <p className="w-full text-[13.5px] text-ink-3 lg:w-auto">
              {preset ? `${preset.summary}.` : "Custom numbers."}
            </p>
          </div>

          <div className="mt-7 grid grid-cols-1 gap-x-10 gap-y-10 lg:grid-cols-[22.5rem_minmax(0,1fr)]">
            <div className="min-w-0 lg:sticky lg:top-[4.75rem] lg:self-start">
              <WorkloadPanel
                w={state.w}
                s={state.s}
                onWorkload={calc.setWorkload}
                onSettings={calc.setSettings}
                onReset={calc.reset}
              />
            </div>

            <div className="min-w-0">
              <div ref={results.ref} id="results" className="min-w-0 scroll-mt-24">
                {priced ? (
                  <h2 className="text-[clamp(2rem,1.3rem+3vw,3.5rem)] leading-[1.02] font-semibold tracking-[-0.03em] text-ink">
                    {range}{" "}
                    <span className="text-[15px] font-normal tracking-normal whitespace-nowrap text-ink-3">
                      a {period}
                    </span>
                  </h2>
                ) : (
                  <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink">
                    {anySignal ? "No platform publishes a price for all of this" : "Nothing to price yet"}
                  </h2>
                )}
                {anySignal ? null : (
                  <p className="mt-2 text-[13.5px] text-ink-3">Switch on a signal to see what it costs.</p>
                )}
                <p role="status" className="sr-only">
                  {announcement}
                </p>
              </div>

              {anySignal ? (
                <>
                  <div className="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Segmented
                        label="Billing term"
                        value={state.s.term}
                        options={[
                          { value: "annual", label: "Annual commitment" },
                          { value: "monthly", label: "Pay as you go" },
                        ]}
                        onChange={(term) => calc.setSettings({ ...state.s, term })}
                      />
                      <SelectField
                        label="Data region"
                        value={state.s.region}
                        options={[
                          { value: "us", label: "US region" },
                          { value: "eu", label: "EU region" },
                        ]}
                        onChange={(region) => calc.setSettings({ ...state.s, region })}
                        className="py-[5px]"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Segmented
                        label="Show cost per"
                        value={period}
                        options={[
                          { value: "month", label: "Per month" },
                          { value: "year", label: "Per year" },
                        ]}
                        onChange={calc.setPeriod}
                      />
                      <SelectField<Sort>
                        label="Sort platforms"
                        value={calc.sort}
                        options={[
                          { value: "low", label: "Lowest first" },
                          { value: "high", label: "Highest first" },
                          { value: "name", label: "A to Z" },
                        ]}
                        onChange={calc.setSort}
                        className="py-[5px]"
                      />
                    </div>
                  </div>

                  <div className="mt-5 mb-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                      <Legend />
                      <label className="inline-flex items-center gap-2 text-[13px] text-ink-2">
                        What you pay now, a month
                        <MoneyField
                          label="What you pay now, in dollars a month"
                          value={state.bill ?? null}
                          onChange={calc.setBill}
                          placeholder="optional"
                          compact
                        />
                      </label>
                    </div>
                    {state.bill ? (
                      <p className="mt-2 flex items-start gap-2 text-[13px] leading-snug text-ink-2">
                        <span aria-hidden="true" className="mt-0.5 h-3.5 w-px shrink-0 bg-ink" />
                        <span>
                          {belowBill} of {complete.length} estimates are below your current bill of{" "}
                          {usd(state.bill * k)} a {period}.
                        </span>
                      </p>
                    ) : null}
                  </div>

                  <Ledger
                    estimates={ordered.filter((e) => e.complete)}
                    s={state.s}
                    period={period}
                    openIds={calc.openIds}
                    onToggle={calc.toggleOpen}
                    bill={state.bill ?? null}
                    comparePicked={calc.comparePicked}
                    onCompareAdd={calc.addToCompare}
                    onCompareRemove={calc.removeFromCompare}
                  />

                  <div className="mt-5 flex flex-wrap items-center gap-2">
                    <ActionButton
                      label="Copy link"
                      done="Link copied"
                      onAction={() => navigator.clipboard.writeText(calc.link())}
                    />
                    <ActionButton
                      label="Copy as Markdown"
                      done="Table copied"
                      onAction={() =>
                        navigator.clipboard.writeText(toMarkdown(ordered, state.w, state.s, calc.link()))
                      }
                    />
                    <ActionButton
                      label="Download CSV"
                      done="Downloaded"
                      failed="Could not download"
                      onAction={() =>
                        download(
                          `observability-pricing-${new Date().toISOString().slice(0, 10)}.csv`,
                          toCsv(ordered, state.w, state.s),
                        )
                      }
                    />
                    <a href="#compare" className={`${textLink} ml-1 text-[14px] sm:ml-auto`}>
                      Compare head to head
                    </a>
                  </div>
                  <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-ink-3">
                    Estimates at public list price, not quotes.{" "}
                    <Link to="/method" className={textLink}>
                      How these numbers are made
                    </Link>
                  </p>
                </>
              ) : null}

              <div id="not-priced" className="mt-10">
                <h3 className="text-[15px] font-semibold text-ink">Not priced here</h3>
                <ul className="mt-3 border-t border-line">
                  {partial.map((estimate) => (
                    <li
                      key={estimate.vendor.id}
                      className="grid gap-x-6 gap-y-0.5 border-b border-line py-2.5 text-[13.5px] md:grid-cols-[13.5rem_minmax(0,1fr)]"
                    >
                      <Link
                        to={`/backends/${estimate.vendor.id}`}
                        className="font-medium text-ink underline decoration-line-2 underline-offset-[3px] transition-colors hover:text-azure"
                      >
                        {estimate.vendor.name}
                      </Link>
                      <span className="text-ink-3">No public price for your{" "}
                        {[...new Set(estimate.unpriced.map((u) => GAP_NAME[u.bucket]))]
                          .join(", ")
                          .replace(/, ([^,]*)$/, " and $1")}
                        .</span>
                    </li>
                  ))}
                  {UNLISTED.map((vendor) => (
                    <li
                      key={vendor.name}
                      className="grid gap-x-6 gap-y-0.5 border-b border-line py-2.5 text-[13.5px] md:grid-cols-[13.5rem_minmax(0,1fr)]"
                    >
                      <a
                        href={vendor.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="font-medium text-ink underline decoration-line-2 underline-offset-[3px] transition-colors hover:text-azure"
                      >
                        {vendor.name}
                      </a>
                      <span className="text-ink-3">{vendor.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="split" className="scroll-mt-24 border-t border-line py-16 md:py-20">
        <div className={container}>
          <Heading>Price each signal at a different platform</Heading>
          <div className="mt-9">
            <SplitRouting
              vendors={calc.vendors}
              w={settled.w}
              s={settled.s}
              period={period}
              lowestSplit={calc.lowestSplit}
              lowestSingle={calc.lowestSingle}
              singleSkipsShorter={
                calc.lowestSingle !== null && complete[0]?.vendor.id !== calc.lowestSingle.vendor.id
              }
              route={state.route}
              onRoute={calc.setRoute}
            />
          </div>
        </div>
      </section>

      <section id="compare" className="scroll-mt-20 border-t border-line py-16 md:py-20">
        <div className={container}>
          <Heading>Compare head to head</Heading>
          <div className="mt-8">
            <HeadToHead
              vendors={calc.vendors}
              estimates={calc.estimates}
              w={state.w}
              s={state.s}
              period={period}
              ids={calc.compareIds}
              picked={calc.comparePicked !== null}
              onChange={calc.setCompare}
              onOpenReceipt={openReceipt}
            />
          </div>
        </div>
      </section>

      {/* On a phone the form comes first, so the answer rides along until the list is reached. */}
      {priced && results.below ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line-2 bg-paper px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] lg:hidden">
          <a href="#results" className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block truncate text-[15px] leading-tight font-semibold text-ink">
                {range}
              </span>
              <span className="mt-0.5 block text-xs text-ink-3">
                a {period} at {complete.length} {complete.length === 1 ? "platform" : "platforms"}
              </span>
            </span>
            <span className={`shrink-0 ${btnSm.secondary}`}>See the list</span>
          </a>
        </div>
      ) : null}
    </>
  );
}
