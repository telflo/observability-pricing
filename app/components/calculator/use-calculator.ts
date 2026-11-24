/**
 * The calculator's state and everything derived from it. The workload and
 * settings are the source of truth; the URL mirrors them, and the view, so
 * any estimate can be shared as a link that opens the same way.
 */
import { useEffect, useMemo, useState } from "react";
import { resolveCompare, withAdded } from "~/pricing/compare";
import type { Route } from "~/pricing/engine";
import { cheapestRoute, estimateAll } from "~/pricing/engine";
import type { Settings, VendorEstimate, Workload } from "~/pricing/types";
import type { CalculatorState, View } from "~/pricing/url-state";
import { DEFAULT_VIEW, encodeState, sameWorkload } from "~/pricing/url-state";
import { VENDORS } from "~/pricing/vendors";
import {
  DEFAULT_SETTINGS,
  PRESETS,
  defaultWorkload,
  presetById,
} from "~/pricing/workloads";

export type Sort = View["sort"];
export type Period = View["period"];

function order(estimates: VendorEstimate[], sort: Sort): VendorEstimate[] {
  const by =
    sort === "name"
      ? (a: VendorEstimate, b: VendorEstimate) => a.vendor.name.localeCompare(b.vendor.name)
      : sort === "high"
        ? (a: VendorEstimate, b: VendorEstimate) => b.monthly - a.monthly
        : (a: VendorEstimate, b: VendorEstimate) => a.monthly - b.monthly;
  return [...estimates].sort(by);
}

/** A value that follows its source only once the source has stopped changing. */
function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export function useCalculator(initial: CalculatorState) {
  const [state, setState] = useState<CalculatorState>({
    w: initial.w,
    s: initial.s,
    route: initial.route,
    bill: initial.bill ?? null,
    compare: initial.compare ?? null,
  });
  const [view, setView] = useState<View>(initial.view ?? DEFAULT_VIEW);

  // The ranked list re-prices on every change, so the bars move with a
  // dragged slider. The split search is heavier, so it waits until the
  // inputs have been still for a moment.
  const settled = useSettled(state, 160);

  const estimates = useMemo(() => estimateAll(VENDORS, state.w, state.s), [state.w, state.s]);
  const ordered = useMemo(() => order(estimates, view.sort), [estimates, view.sort]);
  const complete = useMemo(() => estimates.filter((e) => e.complete), [estimates]);
  const lowestSplit = useMemo(
    () => cheapestRoute(VENDORS, settled.w, settled.s),
    [settled.w, settled.s],
  );
  const compareIds = useMemo(
    () => resolveCompare(state.compare ?? null, estimates),
    [state.compare, estimates],
  );

  const presetId = useMemo(
    () => PRESETS.find((p) => sameWorkload(p.workload, state.w))?.id ?? null,
    [state.w],
  );

  // Keep the address bar in step without adding history entries.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const query = encodeState({ ...state, view }).toString();
      const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
      if (url !== `${window.location.pathname}${window.location.search}`) {
        window.history.replaceState(window.history.state, "", url);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [state, view]);

  return {
    state,
    settled,
    period: view.period,
    sort: view.sort,
    openIds: view.open,
    estimates,
    ordered,
    complete,
    /**
     * The lowest estimate for sending everything to one platform. A platform
     * that keeps data for less time than asked is passed over while one that
     * keeps all of it exists: estimateAll sorts complete estimates lowest first.
     */
    lowestSingle: complete.find((e) => e.shortRetention.length === 0) ?? complete[0] ?? null,
    lowestSplit,
    /** The two or three platforms in the head-to-head, in the order shown. */
    compareIds,
    /** The visitor's picks, or null while the comparison follows the lowest estimates. */
    comparePicked: state.compare ?? null,
    presetId,
    vendors: VENDORS,
    setPeriod: (period: Period) => setView((v) => ({ ...v, period })),
    setSort: (sort: Sort) => setView((v) => ({ ...v, sort })),
    toggleOpen: (id: string) =>
      setView((v) => ({
        ...v,
        open: v.open.includes(id) ? v.open.filter((x) => x !== id) : [...v.open, id],
      })),
    /** Open a receipt if it is closed; leave it alone if it is open. */
    open: (id: string) =>
      setView((v) => (v.open.includes(id) ? v : { ...v, open: [...v.open, id] })),
    setWorkload: (w: Workload) => setState((prev) => ({ ...prev, w })),
    setSettings: (s: Settings) => setState((prev) => ({ ...prev, s })),
    setRoute: (route: Route | null) => setState((prev) => ({ ...prev, route })),
    setBill: (bill: number | null) => setState((prev) => ({ ...prev, bill })),
    setCompare: (compare: string[] | null) => setState((prev) => ({ ...prev, compare })),
    addToCompare: (id: string) =>
      setState((prev) => ({ ...prev, compare: withAdded(prev.compare ?? null, id) })),
    removeFromCompare: (id: string) =>
      setState((prev) => {
        const left = (prev.compare ?? []).filter((x) => x !== id);
        return { ...prev, compare: left.length > 0 ? left : null };
      }),
    applyPreset: (id: string) => {
      const preset = presetById(id);
      if (preset) setState((prev) => ({ ...prev, w: structuredClone(preset.workload) }));
    },
    reset: () => {
      setState({
        w: defaultWorkload(),
        s: DEFAULT_SETTINGS,
        route: null,
        bill: null,
        compare: null,
      });
      setView(DEFAULT_VIEW);
    },
    /** The current state as an absolute link. */
    link: () => {
      const query = encodeState({ ...state, view }).toString();
      return `${window.location.origin}${window.location.pathname}${query ? `?${query}` : ""}`;
    },
  };
}

export type Calculator = ReturnType<typeof useCalculator>;
