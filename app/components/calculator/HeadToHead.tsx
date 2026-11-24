/**
 * Head to head: platforms side by side for the workload above.
 * One row per thing a buyer compares on price: the bill, each signal and what
 * it works out to per unit, retention, and the bill at ten times the volume.
 *
 * It is a table: on a wide screen the row labels run down the left, on a
 * phone each label sits above its values and the wordy rows stack by platform.
 */
import { useMemo } from "react";
import { btnSm, textLink } from "~/components/ui";
import type { Comparison } from "~/pricing/compare";
import { UNIT_OF, compareFacts, withSlot } from "~/pricing/compare";
import { SIGNAL_NAME } from "~/pricing/engine";
import { duration, num, usd, usdApprox } from "~/pricing/format";
import type {
  Settings,
  Signal,
  VendorAdapter,
  VendorEstimate,
  Workload,
} from "~/pricing/types";
import { activeSignals } from "~/pricing/units";
import { SelectField } from "./controls";
import type { Period } from "./Ledger";
import { CostBar } from "./Ledger";
import { SIGNAL_DOT } from "./WorkloadPanel";

/** Label column plus one column per platform, from the md breakpoint up. */
const WIDE: Record<number, string> = {
  2: "md:grid-cols-[10.5rem_minmax(0,1fr)_minmax(0,1fr)]",
  3: "md:grid-cols-[10.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]",
};
/** On a phone the figures keep their columns under the row label. */
const NARROW: Record<number, string> = { 2: "grid-cols-2", 3: "grid-cols-3" };

/** "GB ingested", "GB ingested and GB scanned", "a, b and c". */
function words(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function Row({
  label,
  dot,
  n,
  prose = false,
  children,
}: {
  label: string;
  /** A signal's color, tying the row to its bar segment. */
  dot?: string;
  n: number;
  /** A row of sentences: on a phone its cells stack, one platform after another. */
  prose?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      role="row"
      className={`grid grid-cols-1 gap-x-6 gap-y-2 border-b border-line py-4 ${WIDE[n]}`}
    >
      <div role="rowheader" className="flex items-center gap-2 self-start text-[13px] font-medium text-ink-2 md:pt-0.5">
        {dot ? <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-[3px] ${dot}`} /> : null}
        {label}
      </div>
      <div
        role="presentation"
        className={`grid gap-x-4 gap-y-4 md:contents ${prose ? "grid-cols-1" : NARROW[n]}`}
      >
        {children}
      </div>
    </div>
  );
}

/** A platform's name above its cell, only where the cells are stacked. */
function StackedName({ name }: { name: string }) {
  return <p className="mb-1 text-[13px] font-semibold text-ink md:hidden">{name}</p>;
}

const NO_PRICE = <p className="text-[13px] leading-snug text-ink-3">No public price</p>;

export function HeadToHead({
  vendors,
  estimates,
  w,
  s,
  period,
  ids,
  picked,
  onChange,
  onOpenReceipt,
}: {
  vendors: VendorAdapter[];
  /** Every platform's estimate for the current workload, in any order. */
  estimates: VendorEstimate[];
  w: Workload;
  s: Settings;
  period: Period;
  /** The two or three platforms compared, in the order shown. */
  ids: string[];
  /** Whether the visitor chose them. Until then they follow the lowest estimates. */
  picked: boolean;
  onChange: (ids: string[] | null) => void;
  /** Open this platform's receipt in the list above. */
  onOpenReceipt: (id: string) => void;
}) {
  const k = period === "year" ? 12 : 1;
  const active = activeSignals(w);

  const columns: Comparison[] = useMemo(
    () =>
      ids
        .map((id) => estimates.find((e) => e.vendor.id === id))
        .filter((e): e is VendorEstimate => e !== undefined)
        .map((e) => compareFacts(e, w, s)),
    [ids, estimates, w, s],
  );

  if (active.length === 0 || columns.length < 2) {
    return (
      <p className="max-w-2xl text-[15px] leading-relaxed text-ink-2">
        Switch on a signal to compare platforms.
      </p>
    );
  }

  const n = columns.length;
  const options = vendors.map((v) => ({ value: v.id, label: v.name }));
  const full = columns.filter((c) => c.estimate.complete);
  const lowest = full.length > 0 ? Math.min(...full.map((c) => c.estimate.monthly)) : 0;
  const scaleMax = Math.max(...columns.map((c) => c.estimate.monthly));
  const anyPlatform = columns.some((c) => c.platform.amount > 0);

  const difference = (c: Comparison): string => {
    if (!c.estimate.complete) return c.estimate.monthly > 0 ? "Priced parts only" : "";
    if (full.length < 2) return "";
    const more = c.estimate.monthly - lowest;
    return more < 0.005 ? "Lowest of these" : `${usd(more * k)} more`;
  };

  return (
    <div>
      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:gap-x-3">
        <span className="text-[15px] text-ink-2">Compare</span>
        {[0, 1, 2].map((slot) => (
          <span key={slot} className="contents">
            {slot > 0 ? (
              <span className="hidden text-[15px] text-ink-2 md:inline">{slot === 1 ? "with" : "and"}</span>
            ) : null}
            <span className="md:w-56">
              <SelectField
                size="lg"
                label={["First platform", "Second platform", "Third platform"][slot]}
                value={ids[slot] ?? ""}
                options={slot === 2 ? [{ value: "", label: "No third platform" }, ...options] : options}
                onChange={(id) => onChange(withSlot(ids, slot, id === "" ? null : id))}
              />
            </span>
          </span>
        ))}
        {picked ? (
          <button type="button" onClick={() => onChange(null)} className={btnSm.secondary}>
            Back to the three lowest
          </button>
        ) : null}
      </div>

      <div role="table" aria-label="Platforms side by side" className="mt-7">
        <div
          role="row"
          className={`sticky top-16 z-10 grid grid-cols-1 gap-x-6 border-b-2 border-ink bg-paper py-3 ${WIDE[n]}`}
        >
          <div role="columnheader" className="hidden md:block">
            <span className="sr-only">Compared</span>
          </div>
          <div role="presentation" className={`grid gap-x-4 md:contents ${NARROW[n]}`}>
            {columns.map((c) => (
              <div
                key={c.estimate.vendor.id}
                role="columnheader"
                className="min-w-0 text-[14px] leading-tight font-semibold text-ink md:text-[17px]"
              >
                {c.estimate.vendor.name}
              </div>
            ))}
          </div>
        </div>

        <Row label={`Estimate a ${period}`} n={n}>
          {columns.map((c) => {
            const e = c.estimate;
            const nothing = !e.complete && e.monthly === 0;
            return (
              <div key={e.vendor.id} role="cell" className="min-w-0">
                {nothing ? (
                  <p className="text-[15px] leading-tight text-ink-3">Not priced</p>
                ) : (
                  <p
                    className={`text-[1.15rem] leading-none tracking-[-0.02em] md:text-[clamp(1.5rem,1.1rem+1.2vw,2rem)] ${
                      e.complete ? "font-semibold text-ink" : "font-medium text-ink-2"
                    }`}
                  >
                    {usd(e.monthly * k)}
                  </p>
                )}
                <p className="mt-1.5 min-h-4 text-xs leading-snug text-ink-3">{difference(c)}</p>
                <div className="mt-2 h-3">
                  <CostBar
                    byBucket={e.byBucket}
                    total={e.monthly}
                    scaleMax={scaleMax}
                    period={period}
                    faded={!e.complete}
                  />
                </div>
              </div>
            );
          })}
        </Row>

        {active.map((signal: Signal) => (
          <Row key={signal} label={SIGNAL_NAME[signal]} dot={SIGNAL_DOT[signal]} n={n}>
            {columns.map((c) => {
              const facts = c.signals[signal];
              return (
                <div key={c.estimate.vendor.id} role="cell" className="min-w-0">
                  {!facts || (!facts.priced && facts.amount === 0) ? (
                    NO_PRICE
                  ) : (
                    <>
                      <p className="text-[15px] leading-tight font-semibold text-ink">
                        {usd(facts.amount * k)}
                      </p>
                      {!facts.priced ? (
                        <p className="mt-0.5 text-xs leading-snug text-ink-2">
                          Part of it has no public price
                        </p>
                      ) : null}
                      {facts.perUnit !== null ? (
                        <p className="mt-0.5 text-[13px] leading-snug text-ink-2">
                          {usdApprox(facts.perUnit)} per {UNIT_OF[signal]}
                        </p>
                      ) : null}
                      {facts.billedBy.length > 0 ? (
                        <p className="mt-1 hidden text-xs leading-snug text-ink-3 sm:block">
                          Billed by {words(facts.billedBy)}
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })}
          </Row>
        ))}

        {anyPlatform ? (
          <Row label="Base fees and seats" dot="bg-sig-platform" n={n}>
            {columns.map((c) => (
              <div key={c.estimate.vendor.id} role="cell" className="min-w-0">
                {c.platform.amount > 0 ? (
                  <>
                    <p className="text-[15px] leading-tight font-semibold text-ink">
                      {usd(c.platform.amount * k)}
                    </p>
                    {c.platform.billedBy.length > 0 ? (
                      <p className="mt-1 hidden text-xs leading-snug text-ink-3 sm:block">
                        Billed by {words(c.platform.billedBy)}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-[13px] leading-snug text-ink-3">None</p>
                )}
              </div>
            ))}
          </Row>
        ) : null}

        <Row label="Kept at this price" n={n}>
          {columns.map((c) => (
            <div key={c.estimate.vendor.id} role="cell" className="min-w-0 text-[13px] leading-snug text-ink-2">
              {c.retention.map((r) =>
                c.signals[r.signal]?.priced === false && c.signals[r.signal]?.amount === 0 ? null : (
                  <p key={r.signal}>
                    {SIGNAL_NAME[r.signal]}{" "}
                    <span className="font-semibold text-ink">{duration(r.kept, r.unit)}</span>
                    {r.kept < r.asked ? (
                      <span className="text-ink-3">, you set {duration(r.asked, r.unit)}</span>
                    ) : null}
                  </p>
                ),
              )}
            </div>
          ))}
        </Row>

        <Row label="At ten times the volume" n={n}>
          {columns.map((c) => {
            const e = c.estimate;
            const comparable = c.tenTimes.complete && e.complete && e.monthly > 0;
            return (
              <div key={e.vendor.id} role="cell" className="min-w-0">
                {c.tenTimes.complete ? (
                  <p className="text-[15px] leading-tight font-semibold text-ink">
                    {usd(c.tenTimes.monthly * k)}
                  </p>
                ) : (
                  NO_PRICE
                )}
                {comparable ? (
                  <p className="mt-0.5 text-xs leading-snug text-ink-3">
                    {num(c.tenTimes.monthly / e.monthly, 1)} times the bill today
                  </p>
                ) : null}
              </div>
            );
          })}
        </Row>

        <Row label="Plan priced" n={n} prose>
          {columns.map((c) => (
            <div key={c.estimate.vendor.id} role="cell" className="min-w-0 text-[13px] leading-snug text-ink-2">
              <StackedName name={c.estimate.vendor.name} />
              {c.estimate.vendor.plan(s)}
            </div>
          ))}
        </Row>

        <Row label="The arithmetic" n={n}>
          {columns.map((c) => (
            <div key={c.estimate.vendor.id} role="cell" className="min-w-0">
              <button
                type="button"
                onClick={() => onOpenReceipt(c.estimate.vendor.id)}
                className={`${textLink} text-left text-[13px]`}
              >
                See every line
                <span className="sr-only"> for {c.estimate.vendor.name}</span>
              </button>
            </div>
          ))}
        </Row>
      </div>

      <p className="mt-4 max-w-3xl text-[13px] leading-relaxed text-ink-3">
        Per-unit figures leave out base fees and seats.
      </p>
    </div>
  );
}
