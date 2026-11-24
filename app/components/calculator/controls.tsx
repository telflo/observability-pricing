/**
 * Form controls for the pricing calculator: a log-scale slider, a number
 * field that accepts "250k", a segmented choice, a switch and a select.
 * All are plain controlled inputs styled with the marketing tokens.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { num } from "~/pricing/format";

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Two significant digits: a dragged value lands on a number worth reading. */
export function nice(n: number): number {
  return n > 0 ? Number(n.toPrecision(2)) : 0;
}

/** The next "nice" value up or down from `value`: 330 -> 340, 1,000 -> 990. */
export function stepNice(value: number, direction: 1 | -1, min: number, max: number): number {
  const v = clamp(value || min, min, max);
  const exponent = Math.floor(Math.log10(v));
  // Stepping down from a power of ten uses the finer step of the decade below.
  const fine = direction === -1 && v === 10 ** exponent ? exponent - 2 : exponent - 1;
  const next = v + direction * 10 ** fine;
  return clamp(Number(next.toPrecision(3)), min, max);
}

const STEPS = 1000;

function toPosition(value: number, min: number, max: number): number {
  const v = clamp(value || min, min, max);
  return Math.round((STEPS * Math.log(v / min)) / Math.log(max / min));
}

function fromPosition(position: number, min: number, max: number): number {
  return clamp(nice(min * (max / min) ** (position / STEPS)), min, max);
}

export function LogSlider({
  label,
  value,
  min,
  max,
  onChange,
  disabled = false,
  valueText,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  valueText?: string;
}) {
  const position = toPosition(value, min, max);
  return (
    <input
      type="range"
      className="opc-range"
      min={0}
      max={STEPS}
      step={1}
      value={position}
      disabled={disabled}
      aria-label={label}
      aria-valuetext={valueText ?? num(value)}
      style={{ "--fill": `${(position / STEPS) * 100}%` } as React.CSSProperties}
      onChange={(e) => onChange(fromPosition(Number(e.target.value), min, max))}
      onKeyDown={(e) => {
        // The track is logarithmic, so arrow keys move by value, not by pixel.
        const up = e.key === "ArrowRight" || e.key === "ArrowUp";
        const down = e.key === "ArrowLeft" || e.key === "ArrowDown";
        if (up || down) {
          e.preventDefault();
          onChange(stepNice(value, up ? 1 : -1, min, max));
        } else if (e.key === "PageUp" || e.key === "PageDown") {
          e.preventDefault();
          onChange(clamp(nice(value * (e.key === "PageUp" ? 2 : 0.5)), min, max));
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          onChange(e.key === "Home" ? min : max);
        }
      }}
    />
  );
}

/** "250k", "1.5m", "2,000" -> a number. NaN when it is not one. */
export function parseAmount(text: string): number {
  const match = text
    .trim()
    .toLowerCase()
    .replace(/[,\s_]/g, "")
    .match(/^(\d*\.?\d+)([kmbt])?$/);
  if (!match) return Number.NaN;
  const scale = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[match[2] as "k" | "m" | "b" | "t"] ?? 1;
  return Number(match[1]) * scale;
}

/**
 * The editing behaviour number fields share. Blurred, a field shows its
 * formatted value; focused, it holds what was typed. Focusing selects the
 * whole value, so typing replaces it. Enter commits, Escape discards.
 */
function useDraft(shown: string, raw: string, commit: (text: string) => void) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const selectNext = useRef(false);
  const cancelled = useRef(false);
  const keepSelection = useRef(false);

  // Focusing swaps the formatted text for the raw number, which would drop
  // the selection. Select once that render has landed, and only if the field
  // still has focus.
  useLayoutEffect(() => {
    if (selectNext.current) {
      selectNext.current = false;
      if (ref.current && document.activeElement === ref.current) ref.current.select();
    }
  });

  return {
    ref,
    value: draft ?? shown,
    setDraft,
    props: {
      onFocus: () => {
        cancelled.current = false;
        selectNext.current = true;
        keepSelection.current = true;
        setDraft(raw);
      },
      // A click focuses on mousedown and would place the caret on mouseup,
      // undoing the select-all. Swallow that one mouseup.
      onMouseUp: (e: React.MouseEvent<HTMLInputElement>) => {
        if (keepSelection.current) {
          keepSelection.current = false;
          e.preventDefault();
        }
      },
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        keepSelection.current = false;
        setDraft(e.target.value);
      },
      onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
        keepSelection.current = false;
        if (cancelled.current) {
          cancelled.current = false;
          setDraft(null);
          return;
        }
        commit(e.target.value);
        setDraft(null);
      },
    },
    cancel: (input: HTMLInputElement) => {
      cancelled.current = true;
      input.blur();
    },
  };
}

export function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  disabled = false,
  className = "w-24",
  integer = false,
  compact = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  className?: string;
  integer?: boolean;
  /** A smaller field for secondary numbers set inline with text. */
  compact?: boolean;
}) {
  const field = useDraft(num(value), String(Number(value.toPrecision(12))), (text) => {
    const parsed = parseAmount(text);
    if (Number.isFinite(parsed)) onChange(clamp(integer ? Math.round(parsed) : parsed, min, max));
  });

  return (
    <input
      ref={field.ref}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      aria-label={label}
      disabled={disabled}
      value={field.value}
      {...field.props}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          field.cancel(e.currentTarget);
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const stepped = stepNice(value, e.key === "ArrowUp" ? 1 : -1, min, max);
          const next = integer ? Math.round(stepped) : stepped;
          onChange(next);
          field.setDraft(String(next));
        }
      }}
      className={`rounded-md border border-line-2 bg-paper text-right font-semibold text-ink transition-colors hover:border-ink-3 focus:border-azure disabled:opacity-40 ${
        compact ? "px-1.5 py-0.5 text-[13px]" : "px-2 py-1 text-[15px]"
      } ${className}`}
    />
  );
}

/** An optional dollar amount: empty means "not given". Accepts "42k". */
export function MoneyField({
  label,
  value,
  onChange,
  placeholder,
  className = "w-28",
  compact = false,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
  className?: string;
  compact?: boolean;
}) {
  const field = useDraft(value ? num(value, 0) : "", value ? String(value) : "", (text) => {
    const parsed = parseAmount(text.replace(/^\$/, ""));
    if (text.trim() === "") onChange(null);
    else if (Number.isFinite(parsed) && parsed > 0) onChange(Math.min(parsed, 1e9));
  });

  return (
    <span className="relative inline-block">
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-3 ${
          compact ? "text-[13px]" : "text-[15px]"
        }`}
      >
        $
      </span>
      <input
        ref={field.ref}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        placeholder={placeholder}
        value={field.value}
        {...field.props}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") field.cancel(e.currentTarget);
        }}
        className={`rounded-md border border-line-2 bg-paper pr-2 pl-5 text-right font-semibold text-ink transition-colors placeholder:font-normal placeholder:text-ink-3 hover:border-ink-3 focus:border-azure ${
          compact ? "py-[3px] text-[13px]" : "py-1 text-[15px]"
        } ${className}`}
      />
    </span>
  );
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  full = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  full?: boolean;
}) {
  const index = options.findIndex((o) => o.value === value);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`${full ? "flex" : "inline-flex"} rounded-md border border-line-2 bg-paper p-0.5`}
      onKeyDown={(e) => {
        const last = options.length - 1;
        const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
        const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
        // With nothing checked, forward lands on the first option and back on the last.
        const from = index < 0 ? (forward ? -1 : 0) : index;
        const next = forward
          ? (from + 1) % options.length
          : back
            ? (from + last) % options.length
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? last
                : -1;
        if (next < 0) return;
        e.preventDefault();
        onChange(options[next].value);
        e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
      }}
    >
      {options.map((option, i) => {
        const checked = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={checked}
            // One tab stop for the group: the checked option, or the first when none is.
            tabIndex={checked || (index < 0 && i === 0) ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={`${full ? "flex-1" : ""} rounded-[5px] px-2.5 py-1 text-[13px] font-medium whitespace-nowrap transition-colors ${
              checked ? "bg-ink text-paper" : "text-ink-2 hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      // The pseudo-element widens the touch target without growing the control.
      className={`relative h-[18px] w-8 shrink-0 rounded-full border transition-colors before:absolute before:-inset-3 before:content-[''] ${
        on ? "border-ink bg-ink" : "border-ink-3 bg-paper"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-[2px] left-0 size-3 rounded-full transition-transform motion-reduce:transition-none ${
          on ? "translate-x-[16px] bg-paper" : "translate-x-[2px] bg-ink-3"
        }`}
      />
    </button>
  );
}

export function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className = "",
  size = "sm",
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "lg";
}) {
  return (
    <span className={`relative inline-block ${size === "lg" ? "w-full" : ""}`}>
      <select
        aria-label={label}
        disabled={disabled}
        value={String(value)}
        onChange={(e) => {
          const picked = options.find((o) => String(o.value) === e.target.value);
          if (picked) onChange(picked.value);
        }}
        className={`w-full cursor-pointer appearance-none rounded-md border border-line-2 bg-paper text-ink transition-colors hover:border-ink-3 focus:border-azure disabled:opacity-40 ${
          size === "lg" ? "py-2 pr-8 pl-2.5 text-[14px] font-medium" : "py-1 pr-6 pl-2 text-[13px] font-medium"
        } ${className}`}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        strokeWidth={1.75}
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-ink-3 ${
          size === "lg" ? "right-2.5 size-4" : "right-1.5 size-3.5"
        }`}
      />
    </span>
  );
}
