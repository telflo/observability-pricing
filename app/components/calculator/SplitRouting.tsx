/**
 * Split routing: a different platform for each signal, and what the mix costs.
 * A collector can send logs, metrics and traces to different places, so the
 * comparison does not have to be one vendor against another.
 *
 * The answer comes first (the total and how it compares with one platform),
 * then the pickers that change it.
 */
import { useMemo } from "react";
import { btnSm } from "~/components/ui";
import type { Route, RouteEstimate } from "~/pricing/engine";
import {
  estimateRoute,
  rankForSignal,
  SIGNAL_NAME,
  usableRoute,
} from "~/pricing/engine";
import { duration, usd } from "~/pricing/format";
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
import { SIGNAL_DOT } from "./WorkloadPanel";

/** "logs", "logs and metrics", "logs, metrics and traces". */
function words(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function SignalColumn({
  signal,
  ranked,
  picked,
  period,
  onPick,
}: {
  signal: Signal;
  ranked: VendorEstimate[];
  picked: string | null;
  period: Period;
  onPick: (vendorId: string) => void;
}) {
  const k = period === "year" ? 12 : 1;
  const name = SIGNAL_NAME[signal].toLowerCase();
  const shortlist = ranked.slice(0, 4);
  const known = ranked.some((e) => e.vendor.id === picked);
  const options = [
    // Never show a platform as chosen when it is not the one being priced.
    ...(known ? [] : [{ value: "", label: "Pick a platform" }]),
    ...ranked.map((e) => ({
      value: e.vendor.id,
      label: `${e.vendor.name} (${usd(e.monthly * k)})`,
    })),
  ];
  return (
    <div className="min-w-0 border-t border-line pt-4 md:border-t-0 md:border-l md:pt-0 md:pl-6 md:first:border-l-0 md:first:pl-0">
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className={`size-2.5 rounded-[3px] ${SIGNAL_DOT[signal]}`} />
        <h4 className="text-[15px] font-semibold text-ink">{SIGNAL_NAME[signal]}</h4>
      </div>
      <div className="mt-3">
        <SelectField
          size="lg"
          label={`Platform for ${name}`}
          value={known ? (picked as string) : ""}
          options={options}
          onChange={(id) => {
            if (id) onPick(id);
          }}
        />
      </div>
      <p className="mt-4 text-xs text-ink-3">
        {shortlist.length === 1 ? "The only price" : `Lowest ${shortlist.length}`} for {name} alone
      </p>
      <ul className="mt-1.5 border-t border-line">
        {shortlist.map((e) => {
          const active = e.vendor.id === picked;
          const short = e.shortRetention[0];
          return (
            <li key={e.vendor.id} className="border-b border-line">
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onPick(e.vendor.id)}
                className={`group/pick flex w-full items-baseline justify-between gap-3 py-2 text-left text-[13px] ${
                  active ? "font-semibold text-ink" : "text-ink-2 hover:text-ink"
                }`}
              >
                <span className="min-w-0 truncate decoration-line-2 underline-offset-4 group-hover/pick:underline">
                  {e.vendor.name}
                  {short ? (
                    <span className="font-normal text-ink-3">
                      {" "}
                      keeps {duration(short.kept, short.unit)}
                    </span>
                  ) : null}
                </span>
                <span>{usd(e.monthly * k)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SplitRouting({
  vendors,
  w,
  s,
  period,
  lowestSplit,
  lowestSingle,
  singleSkipsShorter = false,
  route,
  onRoute,
}: {
  vendors: VendorAdapter[];
  w: Workload;
  s: Settings;
  period: Period;
  /** The lowest-cost split for this workload, or null when nothing is priced. */
  lowestSplit: RouteEstimate | null;
  /** The lowest single-backend estimate, for comparison. */
  lowestSingle: VendorEstimate | null;
  /** A lower single-backend estimate exists, but it keeps data for less time than asked. */
  singleSkipsShorter?: boolean;
  /** A split picked by hand; null follows the lowest-cost split. */
  route: Route | null;
  onRoute: (route: Route | null) => void;
}) {
  const active = activeSignals(w);
  const k = period === "year" ? 12 : 1;

  const ranked = useMemo(() => {
    const out = {} as Record<Signal, VendorEstimate[]>;
    for (const signal of activeSignals(w)) out[signal] = rankForSignal(vendors, w, s, signal);
    return out;
  }, [vendors, w, s]);

  const shown: RouteEstimate | null = useMemo(() => {
    if (!lowestSplit) return null;
    if (!route) return lowestSplit;
    // A link can name a platform that is unknown, or that has no public price
    // for a signal. Those entries fall back to the lowest-cost split, so the
    // total is always a full price for everything sent.
    const usable = usableRoute(vendors, w, s, route);
    const merged: Route = {
      logs: usable.logs ?? lowestSplit.route.logs,
      metrics: usable.metrics ?? lowestSplit.route.metrics,
      traces: usable.traces ?? lowestSplit.route.traces,
      profiles: usable.profiles ?? lowestSplit.route.profiles,
    };
    const estimate = estimateRoute(vendors, w, s, merged);
    return estimate.complete ? estimate : lowestSplit;
  }, [route, lowestSplit, vendors, w, s]);

  if (active.length < 2) {
    return (
      <p className="max-w-2xl text-[15px] leading-relaxed text-ink-2">
        Switch on at least two signals to split them across platforms.
      </p>
    );
  }
  if (!shown || !lowestSplit) {
    return (
      <p className="max-w-2xl text-[15px] leading-relaxed text-ink-2">
        No platform prices every signal you send.
      </p>
    );
  }

  const pick = (signal: Signal, vendorId: string) =>
    onRoute({ ...shown.route, [signal]: vendorId });

  const isLowest = Math.abs(shown.monthly - lowestSplit.monthly) < 0.005;
  const difference = lowestSingle ? lowestSingle.monthly - shown.monthly : 0;
  const oneBackend = shown.parts.length === 1;

  return (
    <div>
      <div className="grid grid-cols-1 gap-x-12 gap-y-6 border-t-2 border-ink pt-5 md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <h3 className="text-[13px] font-medium text-ink-3">
            {isLowest ? "Lowest-cost split" : "Your split"}
          </h3>
          <p className="mt-1 text-[clamp(2rem,1.5rem+1.8vw,2.75rem)] leading-none font-semibold tracking-[-0.02em] text-ink">
            {usd(shown.monthly * k)}{" "}
            <span className="text-[15px] font-normal tracking-normal text-ink-3">a {period}</span>
          </p>
          <ul className="mt-4 border-t border-line">
            {shown.parts.map((part) => {
              const gaps = part.estimate.shortRetention;
              return (
                <li
                  key={part.vendor.id}
                  className="flex items-baseline justify-between gap-4 border-b border-line py-2 text-[14px]"
                >
                  <span className="min-w-0 text-ink">
                    <span className="font-semibold">{part.vendor.name}</span>
                    <span className="text-ink-3">
                      {" "}
                      for {words(part.signals.map((sig) => SIGNAL_NAME[sig].toLowerCase()))}
                    </span>
                    {gaps.length > 0 ? (
                      <span className="block text-xs leading-snug text-ink-2">
                        Keeps {words(gaps.map((g) => `${g.signal} ${duration(g.kept, g.unit)}`))}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-ink">{usd(part.estimate.monthly * k)}</span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="min-w-0 text-[14px] leading-relaxed text-ink-2">
          {lowestSingle ? (
            <p>
              {singleSkipsShorter
                ? "One platform that keeps everything as long as you set starts at "
                : "One platform for everything starts at "}
              <span className="font-semibold text-ink">{usd(lowestSingle.monthly * k)}</span> a{" "}
              {period}, at <span className="font-semibold text-ink">{lowestSingle.vendor.name}</span>
              {lowestSingle.shortRetention.length > 0
                ? `, which keeps ${words(
                    lowestSingle.shortRetention.map((g) => `${g.signal} ${duration(g.kept, g.unit)}`),
                  )}`
                : ""}
              .{" "}
              {oneBackend && Math.abs(difference) < 0.5
                ? "No split costs less for this workload."
                : Math.abs(difference) < 0.5
                  ? "This split comes to the same."
                  : difference > 0
                    ? `This split is ${usd(difference * k)} less.`
                    : `This split is ${usd(-difference * k)} more.`}
            </p>
          ) : (
            <p>No single platform prices every signal you send.</p>
          )}
          {!isLowest ? (
            <button type="button" onClick={() => onRoute(null)} className={`mt-4 ${btnSm.secondary}`}>
              Use the lowest-cost split
            </button>
          ) : null}
        </div>
      </div>

      <h3 className="mt-10 text-[15px] font-semibold text-ink">Choose where each signal goes</h3>
      <div
        className={`mt-4 grid grid-cols-1 gap-6 ${active.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}
      >
        {active.map((signal) => (
          <SignalColumn
            key={signal}
            signal={signal}
            ranked={ranked[signal] ?? []}
            picked={shown.route[signal]}
            period={period}
            onPick={(vendorId) => pick(signal, vendorId)}
          />
        ))}
      </div>
    </div>
  );
}
