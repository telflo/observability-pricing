/**
 * The results: one row per platform with its bill as a stacked bar, opening
 * into a receipt that shows every line, the rate behind it and where that
 * rate was read.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { btnSm, textLink } from "~/components/ui";
import { COMPARE_MAX } from "~/pricing/compare";
import {
  compact,
  duration,
  num,
  usd,
  usdCompact,
  usdRate,
} from "~/pricing/format";
import type {
  Bucket,
  LineItem,
  Rate,
  Settings,
  VendorEstimate,
} from "~/pricing/types";
import { BUCKETS } from "~/pricing/types";

export const BUCKET_LABEL: Record<Bucket, string> = {
  logs: "Logs",
  metrics: "Metrics",
  traces: "Traces",
  profiles: "Profiles",
  platform: "Base fees and seats",
};

export const BUCKET_BG: Record<Bucket, string> = {
  logs: "bg-sig-logs",
  metrics: "bg-sig-metrics",
  traces: "bg-sig-traces",
  profiles: "bg-sig-profiles",
  platform: "bg-sig-platform",
};

export type Period = "month" | "year";

const DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? iso : DATE.format(date);
}

const CENTS = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** A line amount, to the cent: receipts do not round. */
const cents = (n: number) => `$${CENTS.format(n)}`;

const quantity = (n: number) => (n >= 1e6 ? compact(n) : num(n, 2));

const BASIS_NOTE: Record<Rate["basis"], string | null> = {
  list: null,
  "starting-from": "starting price",
  promotional: "promotional price",
  example: "vendor's example rate",
};

/** Round dollar ticks for the bars' shared axis: 0, 20K, 40K, 60K for a $54K maximum. */
export function axisTicks(max: number): number[] {
  if (!(max > 0)) return [0];
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude;
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(value);
  return ticks;
}

/**
 * The stacked bar: one segment per part of the bill, on a scale shared by
 * every row. The axis ticks and the "what you pay now" marker are drawn as
 * hairlines through the row, so the list reads as one chart.
 */
export function CostBar({
  byBucket,
  total,
  scaleMax,
  ticks = [],
  marker = null,
  period = "month",
  faded = false,
}: {
  byBucket: Record<Bucket, number>;
  total: number;
  scaleMax: number;
  ticks?: number[];
  period?: Period;
  /** A reference amount on the same scale, drawn as a line through the row. */
  marker?: number | null;
  /** Drawn lighter: the bar covers only part of the workload. */
  faded?: boolean;
}) {
  const share = scaleMax > 0 && total > 0 ? total / scaleMax : 0;
  const width = share > 0 ? Math.max(0.6, share * 100) : 0;
  // A short bar has no room for gaps between its parts: four slivers with
  // gaps read as tick marks. Under an eighth of the scale the parts touch.
  const joined = share < 0.125;
  const at = (value: number) => `${Math.min(100, (value / scaleMax) * 100)}%`;
  return (
    <span aria-hidden="true" className="relative flex h-full min-h-3 w-full items-center">
      {/* Phones have no gridlines, so a track gives the bar something to be read against. */}
      <span className="absolute inset-x-0 top-1/2 h-3 -translate-y-1/2 rounded-[2px] bg-line/45 md:hidden" />
      {scaleMax > 0
        ? ticks.map((tick) => (
            <span
              key={tick}
              className="absolute -inset-y-3.5 hidden w-px bg-line md:block"
              style={{ left: at(tick) }}
            />
          ))
        : null}
      {marker && scaleMax > 0 ? (
        <span className="absolute -inset-y-3.5 z-10 w-px bg-ink" style={{ left: at(marker) }} />
      ) : null}
      <span
        className={`opc-bar relative flex h-3 overflow-hidden rounded-[2px] ${joined ? "" : "gap-[2px]"} ${
          faded ? "opacity-45" : ""
        }`}
        style={{ width: `${width}%` }}
      >
        {BUCKETS.map((bucket) =>
          byBucket[bucket] > 0 ? (
            <span
              key={bucket}
              title={`${BUCKET_LABEL[bucket]}: ${usd(byBucket[bucket] * (period === "year" ? 12 : 1))} a ${period}`}
              className={`opc-seg h-full ${joined ? "" : "min-w-[2px]"} ${BUCKET_BG[bucket]}`}
              style={{ flexGrow: byBucket[bucket], flexBasis: 0 }}
            />
          ) : null,
        )}
      </span>
    </span>
  );
}

/** Rows slide to their new place when the order changes. */
function useReorderAnimation(order: string) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const tops = useRef(new Map<string, number>());
  const lastOrder = useRef(order);

  useLayoutEffect(() => {
    const moved = lastOrder.current !== order;
    lastOrder.current = order;
    const still =
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, number>();
    nodes.current.forEach((el, id) => {
      const top = el.offsetTop;
      next.set(id, top);
      const before = tops.current.get(id);
      if (
        moved &&
        !still &&
        typeof el.animate === "function" &&
        before !== undefined &&
        Math.abs(before - top) > 1
      ) {
        el.animate(
          [{ transform: `translateY(${before - top}px)` }, { transform: "translateY(0)" }],
          { duration: 360, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
        );
      }
    });
    tops.current = next;
  });

  return (id: string) => (el: HTMLElement | null) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  };
}

/** A list of short notes. Long lists show the first few, with the rest one click away. */
function NoteList({ title, items }: { title: string; items: string[] }) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const limit = 3;
  const shown = all || items.length <= limit + 1 ? items : items.slice(0, limit);
  return (
    <div>
      <h4 className="text-[13px] font-semibold text-ink">{title}</h4>
      <ul className="mt-1.5 space-y-1.5">
        {shown.map((item) => (
          <li key={item} className="relative pl-3.5 text-[13.5px] leading-snug text-ink-2">
            <span aria-hidden="true" className="absolute top-[0.55em] left-0 h-px w-2 bg-line-2" />
            {item}
          </li>
        ))}
      </ul>
      {shown.length < items.length ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className={`mt-1.5 ml-3.5 py-0.5 text-[13px] ${textLink}`}
        >
          Show all {items.length}
        </button>
      ) : null}
    </div>
  );
}

/** "9,900 GB × $0.40", with the price linked to the page it was read from. */
function RateMath({ line, estimate }: { line: LineItem; estimate: VendorEstimate }) {
  const rate = estimate.vendor.rates.find((r) => r.id === line.rateId);
  const source = estimate.vendor.sources.find((src) => src.id === rate?.sourceId);
  const basis = rate ? BASIS_NOTE[rate.basis] : null;
  const price = rate ? usdRate(rate.usd) : "";
  const priceTitle = rate
    ? `${rate.label}: ${price} per ${rate.unit}${rate.note ? `. ${rate.note.replace(/\.\s*$/, "")}` : ""}${source ? `. Source: ${source.label}` : ""}`
    : undefined;
  return (
    <>
      {line.kind === "top-up" ? "minimum " : `${quantity(line.quantity)} ${line.unit} × `}
      {source ? (
        <a
          href={source.url}
          target="_blank"
          rel="noreferrer noopener"
          title={priceTitle}
          className="text-ink-2 underline decoration-line-2 underline-offset-[3px] transition-colors hover:text-azure hover:decoration-azure"
        >
          {price}
        </a>
      ) : (
        price
      )}
      {basis ? <span className="ml-1.5 font-display text-ink-3">({basis})</span> : null}
    </>
  );
}

function ReceiptLine({ line, estimate }: { line: LineItem; estimate: VendorEstimate }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-5 border-b border-line py-2.5">
      <div className="min-w-0 md:row-span-2">
        <p className="text-[14px] leading-snug text-ink">{line.label}</p>
        {line.detail ? <p className="mt-0.5 text-xs leading-snug text-ink-3">{line.detail}</p> : null}
      </div>
      <p className="text-right font-tech text-[13px] tabular-nums text-ink">{cents(line.amount)}</p>
      <p className="col-span-2 mt-1 font-tech text-xs tabular-nums text-ink-3 md:col-span-1 md:col-start-2 md:mt-0.5 md:text-right">
        <RateMath line={line} estimate={estimate} />
      </p>
    </li>
  );
}

/**
 * One charge billed across volume tiers: the charge and its total on one
 * line, then a compact row per tier, so a tiered bill stays readable.
 */
function TieredLine({
  title,
  lines,
  estimate,
}: {
  title: string;
  lines: LineItem[];
  estimate: VendorEstimate;
}) {
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  const detail = lines.find((line) => line.detail)?.detail;
  return (
    <li className="border-b border-line py-2.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-5">
        <div className="min-w-0">
          <p className="text-[14px] leading-snug text-ink">{title}</p>
          {detail ? <p className="mt-0.5 text-xs leading-snug text-ink-3">{detail}</p> : null}
        </div>
        <p className="text-right font-tech text-[13px] tabular-nums text-ink">{cents(total)}</p>
      </div>
      <ul className="mt-2 border-l border-line-2 pl-3">
        {lines.map((line, i) => (
          <li
            key={`${line.rateId}-${i}`}
            className="grid grid-cols-1 gap-x-4 py-[3px] text-xs text-ink-3 sm:grid-cols-[minmax(0,1fr)_auto]"
          >
            <span className="min-w-0 truncate">{line.label.slice(title.length + 2)}</span>
            <span className="font-tech tabular-nums sm:text-right">
              <RateMath line={line} estimate={estimate} />
              <span className="ml-3 inline-block min-w-[5.5rem] text-right text-ink-2">
                {cents(line.amount)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** Consecutive lines that share a name before the first comma are tiers of one charge. */
function groupTiers(lines: LineItem[]): { title: string; lines: LineItem[] }[] {
  const blocks: { title: string; lines: LineItem[] }[] = [];
  for (const line of lines) {
    const cut = line.label.indexOf(", ");
    const head = cut > 0 ? line.label.slice(0, cut) : line.label;
    const last = blocks[blocks.length - 1];
    if (last && cut > 0 && last.title === head && last.lines[0].label.indexOf(", ") > 0) {
      last.lines.push(line);
    } else {
      blocks.push({ title: head, lines: [line] });
    }
  }
  return blocks;
}

/** Something that makes this estimate not like-for-like, stated above the lines. */
function Notice({ lead, children }: { lead: string; children: React.ReactNode }) {
  return (
    <p className="mb-4 border-l-2 border-ink-3 py-0.5 pl-3 text-[13.5px] leading-snug text-ink-2">
      <span className="font-semibold text-ink">{lead} </span>
      {children}
    </p>
  );
}

/** The head-to-head, as a receipt sees it: the visitor's picks and how to change them. */
export interface CompareControl {
  /** The visitor's picks, or null while the comparison follows the lowest estimates. */
  picked: string[] | null;
  /** The most platforms a comparison holds. */
  max: number;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}

function CompareAction({ id, compare }: { id: string; compare: CompareControl }) {
  const picked = compare.picked ?? [];
  const inside = picked.includes(id);
  return (
    <p className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-ink-2">
      {inside ? (
        <>
          <span>In your head-to-head.</span>
          <a href="#compare" className={textLink}>
            See it
          </a>
          <button type="button" onClick={() => compare.onRemove(id)} className={INLINE_BUTTON}>
            Remove
          </button>
        </>
      ) : picked.length >= compare.max ? (
        <>
          <span>Your head-to-head already has {compare.max} platforms.</span>
          <a href="#compare" className={textLink}>
            Change them
          </a>
        </>
      ) : (
        <button type="button" onClick={() => compare.onAdd(id)} className={btnSm.secondary}>
          Add to the head-to-head
        </button>
      )}
    </p>
  );
}

const INLINE_BUTTON =
  "py-0.5 font-medium text-ink-2 underline decoration-line-2 underline-offset-[3px] transition-colors hover:text-ink";

function Receipt({
  estimate,
  s,
  compare,
}: {
  estimate: VendorEstimate;
  s: Settings;
  compare?: CompareControl;
}) {
  const { vendor } = estimate;
  return (
    <div className="border-t border-line bg-paper-2 px-4 py-6 md:px-6">
      <p className="mb-5 text-[13.5px] leading-snug text-ink-2">
        <span className="font-semibold text-ink">Plan priced. </span>
        {vendor.plan(s)}
      </p>
      <div>
        {estimate.shortRetention.map((gap) => (
          <Notice
            key={gap.signal}
            lead={`${capitalize(gap.signal)} are kept ${duration(gap.kept, gap.unit)} at this price.`}
          >
            You set {duration(gap.asked, gap.unit)}.
          </Notice>
        ))}
        {BUCKETS.map((bucket) => {
          const lines = estimate.lines.filter((l) => l.bucket === bucket);
          if (lines.length === 0) return null;
          return (
            <section key={bucket} className="mb-5">
              <h4 className="flex items-center gap-2 border-b border-line-2 pb-1.5 text-[13px] font-semibold text-ink">
                <span aria-hidden="true" className={`size-2 rounded-[2px] ${BUCKET_BG[bucket]}`} />
                {BUCKET_LABEL[bucket]}
                <span className="ml-auto font-tech tabular-nums">{cents(estimate.byBucket[bucket])}</span>
              </h4>
              <ul>
                {groupTiers(lines).map((block, i) =>
                  block.lines.length === 1 ? (
                    <ReceiptLine key={`${block.title}-${i}`} line={block.lines[0]} estimate={estimate} />
                  ) : (
                    <TieredLine
                      key={`${block.title}-${i}`}
                      title={block.title}
                      lines={block.lines}
                      estimate={estimate}
                    />
                  ),
                )}
              </ul>
            </section>
          );
        })}

        {estimate.unpriced.map((gap) => (
          <Notice
            key={`${gap.bucket}-${gap.reason}`}
            lead={
              estimate.byBucket[gap.bucket] > 0
                ? `Part of ${GAP_NAME[gap.bucket]} has no public price.`
                : `${capitalize(GAP_NAME[gap.bucket])} have no public price.`
            }
          >
            {gap.reason}
          </Notice>
        ))}

        <p className="flex items-baseline justify-between gap-4 border-t-2 border-ink pt-2.5 text-[15px] font-semibold text-ink">
          <span>{estimate.complete ? "Total a month" : "Total a month, priced parts only"}</span>
          <span className="font-tech tabular-nums">{cents(estimate.monthly)}</span>
        </p>
        <p className="mt-1 flex items-baseline justify-between gap-4 text-[13px] text-ink-3">
          <span>Total a year</span>
          <span className="font-tech tabular-nums">{cents(estimate.monthly * 12)}</span>
        </p>
        {compare ? <CompareAction id={vendor.id} compare={compare} /> : null}
      </div>

      <div className="mt-8 gap-x-10 md:columns-2 [&>div]:mb-5 [&>div]:break-inside-avoid">
        <NoteList title="Assumes" items={estimate.assumptions} />
        <NoteList title="Included in the price" items={estimate.included} />
        <NoteList title="Not in this estimate" items={estimate.notIncluded} />
        <NoteList title="Worth knowing" items={estimate.notes} />
        <div>
          <h4 className="text-[13px] font-semibold text-ink">Sources</h4>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
            Rates and billing rules read on {formatDay(vendor.checkedOn)} from{" "}
            {vendor.sources.map((source, i) => (
              <span key={source.id}>
                {i > 0 ? (i === vendor.sources.length - 1 ? " and " : ", ") : ""}
                <a href={source.url} target="_blank" rel="noreferrer noopener" className={textLink}>
                  {source.label}
                </a>
              </span>
            ))}
            .
          </p>
        </div>
      </div>
    </div>
  );
}

/** "logs", "logs and metrics", "logs, metrics and traces". */
function words(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export const GAP_NAME: Record<Bucket, string> = {
  logs: "logs",
  metrics: "metrics",
  traces: "traces",
  profiles: "profiles",
  platform: "base fees",
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The line under a row's name: whatever makes its total not like-for-like with the others. */
export function rowNote(estimate: VendorEstimate): string | null {
  const notes: string[] = [];
  if (!estimate.complete) {
    const missing = [...new Set(estimate.unpriced.map((u) => GAP_NAME[u.bucket]))];
    notes.push(`${capitalize(words(missing))} not fully priced`);
  }
  if (estimate.shortRetention.length > 0) {
    const kept = estimate.shortRetention.map((g) => `${g.signal} ${duration(g.kept, g.unit)}`);
    notes.push(`${notes.length ? "keeps" : "Keeps"} ${words(kept)}`);
  }
  return notes.length ? notes.join(", ") : null;
}

/** The columns every row and the axis share. */
const ROW_GRID =
  "grid-cols-[minmax(0,1fr)_auto_1.25rem] md:grid-cols-[minmax(0,12.5rem)_minmax(0,1fr)_6.5rem_1.25rem]";

function Row({
  estimate,
  s,
  period,
  scaleMax,
  ticks,
  bill,
  open,
  onToggle,
  register,
  compare,
}: {
  estimate: VendorEstimate;
  s: Settings;
  period: Period;
  scaleMax: number;
  ticks: number[];
  bill: number | null;
  open: boolean;
  onToggle: () => void;
  register: (el: HTMLElement | null) => void;
  compare?: CompareControl;
}) {
  const { vendor } = estimate;
  const shown = estimate.monthly * (period === "year" ? 12 : 1);
  const note = rowNote(estimate);
  const nothingPriced = !estimate.complete && estimate.monthly === 0;
  const panelId = `receipt-${vendor.id}`;
  return (
    <li ref={register} id={`row-${vendor.id}`} className="scroll-mt-20 border-b border-line">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className={`group/row grid w-full items-center gap-x-4 gap-y-2 py-3.5 text-left ${ROW_GRID}`}
      >
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold text-ink decoration-line-2 underline-offset-4 group-hover/row:underline">
            {vendor.name}
          </span>
          {note ? <span className="mt-0.5 block text-xs leading-snug text-ink-2">{note}</span> : null}
        </span>
        <span className="order-last col-span-full h-3 md:order-none md:col-span-1 md:h-auto md:self-stretch">
          <CostBar
            byBucket={estimate.byBucket}
            total={estimate.monthly}
            scaleMax={scaleMax}
            ticks={ticks}
            marker={bill}
            period={period}
            faded={!estimate.complete}
          />
        </span>
        {nothingPriced ? (
          <span className="text-right text-[13px] leading-tight text-ink-3">Not priced</span>
        ) : (
          <span
            className={`text-right leading-tight ${
              estimate.complete
                ? "text-[17px] font-semibold text-ink"
                : "text-[15px] font-medium text-ink-2"
            }`}
          >
            {usd(shown)}
            <span className="sr-only">
              {" "}
              a {period}
              {estimate.complete ? "" : ", priced parts only"}
            </span>
          </span>
        )}
        <ChevronDown
          aria-hidden="true"
          strokeWidth={1.75}
          className="size-4 text-ink-3 transition-[transform,color] duration-200 group-hover/row:text-ink group-aria-expanded/row:rotate-180 motion-reduce:transition-none"
        />
      </button>
      {open ? (
        <div id={panelId}>
          <Receipt estimate={estimate} s={s} compare={compare} />
        </div>
      ) : null}
    </li>
  );
}

export function Ledger({
  estimates,
  s,
  period,
  openIds,
  onToggle,
  bill = null,
  comparePicked = null,
  onCompareAdd,
  onCompareRemove,
}: {
  /** Already in display order. */
  estimates: VendorEstimate[];
  s: Settings;
  period: Period;
  /** Vendor ids whose receipts are open. Any number can be open at once. */
  openIds: string[];
  onToggle: (id: string) => void;
  /** What the visitor pays today, monthly; shares the bars' scale. */
  bill?: number | null;
  /** The visitor's head-to-head picks; with the two handlers, receipts can change them. */
  comparePicked?: string[] | null;
  onCompareAdd?: (id: string) => void;
  onCompareRemove?: (id: string) => void;
}) {
  const compare: CompareControl | undefined =
    onCompareAdd && onCompareRemove
      ? { picked: comparePicked, max: COMPARE_MAX, onAdd: onCompareAdd, onRemove: onCompareRemove }
      : undefined;
  const complete = estimates.filter((e) => e.complete);
  const partial = estimates.filter((e) => !e.complete);
  const ticks = axisTicks(Math.max(0, bill ?? 0, ...estimates.map((e) => e.monthly)));
  const scaleMax = ticks[ticks.length - 1];
  const k = period === "year" ? 12 : 1;
  const at = (value: number) => `${Math.min(100, (value / scaleMax) * 100)}%`;
  const register = useReorderAnimation(estimates.map((e) => e.vendor.id).join(","));

  const rows = (list: VendorEstimate[]) =>
    list.map((estimate) => (
      <Row
        key={estimate.vendor.id}
        estimate={estimate}
        s={s}
        period={period}
        scaleMax={scaleMax}
        ticks={ticks}
        bill={bill}
        open={openIds.includes(estimate.vendor.id)}
        onToggle={() => onToggle(estimate.vendor.id)}
        register={register(estimate.vendor.id)}
        compare={compare}
      />
    ));

  return (
    <div>
      {scaleMax > 0 ? (
        <div aria-hidden="true" className={`hidden items-end gap-x-4 pb-1.5 md:grid ${ROW_GRID}`}>
          <span />
          <span className="relative block h-4 text-xs text-ink-3">
            {ticks.map((tick, i) => (
              <span
                key={tick}
                className={`absolute bottom-0 ${
                  i === 0 ? "" : i === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2"
                }`}
                style={{ left: at(tick) }}
              >
                {usdCompact(tick * k)}
              </span>
            ))}
          </span>
          <span className="text-right text-xs text-ink-3">a {period}</span>
          <span />
        </div>
      ) : null}
      {complete.length > 0 ? (
        <>
          <h3 className="sr-only">Platforms with a public price for all of this workload</h3>
          <ul
            aria-label="Platforms with a public price for all of this workload"
            className="relative border-t border-line"
          >
            {rows(complete)}
          </ul>
        </>
      ) : null}
      {partial.length > 0 ? (
        <div className={complete.length > 0 ? "mt-9" : ""}>
          <h3 className="text-[15px] font-semibold text-ink">Part of this has no public price</h3>
          <p className="mt-1 max-w-2xl text-[13.5px] leading-relaxed text-ink-3">
            These platforms publish no price for part of this workload. The amount shown covers
            only the parts they do price, so it cannot be compared with the totals above.
          </p>
          <ul
            aria-label="Platforms with no public price for part of this workload"
            className="relative mt-3 border-t border-line"
          >
            {rows(partial)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
