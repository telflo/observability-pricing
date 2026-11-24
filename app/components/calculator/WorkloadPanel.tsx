/**
 * The left-hand form: the workload being priced. Fleet size comes first,
 * because a reader usually knows it and the volumes can be estimated from it.
 * Each signal has one main number on a log-scale slider; the sizes that
 * convert it into each vendor's units sit under "Assumptions", visible and
 * editable.
 */
import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { compact, dataSize, duration, num } from "~/pricing/format";
import { PER_HOST, sizeFromHosts } from "~/pricing/sizing";
import type { Settings, Signal, Workload } from "~/pricing/types";
import { SCAN_MULTIPLE, derive } from "~/pricing/units";
import {
  INTERVALS_SECONDS,
  LIMITS,
  LOG_RETENTION_DAYS,
  METRIC_RETENTION_MONTHS,
  TRACE_RETENTION_DAYS,
} from "~/pricing/url-state";
import { LogSlider, NumberField, Segmented, SelectField, Switch } from "./controls";

export const SIGNAL_DOT: Record<Signal, string> = {
  logs: "bg-sig-logs",
  metrics: "bg-sig-metrics",
  traces: "bg-sig-traces",
  profiles: "bg-sig-profiles",
};

const days = (n: number) => duration(n, "days");
const months = (n: number) => duration(n, "months");

function SignalBlock({
  signal,
  title,
  on,
  onToggle,
  children,
}: {
  signal: Signal;
  title: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-line px-5 py-3" aria-label={title}>
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className={`size-2.5 rounded-[3px] ${SIGNAL_DOT[signal]}`} />
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        <span className="ml-auto">
          <Switch label={`Send ${title.toLowerCase()}`} on={on} onChange={onToggle} />
        </span>
      </div>
      <div className={on ? "mt-3" : "pointer-events-none mt-3 opacity-40"} inert={!on}>
        {children}
      </div>
    </section>
  );
}

/**
 * How much of a signal must stay searchable. Some vendors bill indexing
 * apart from ingestion, so this is one of the inputs that moves results most
 * and it sits next to the volume, not under Assumptions.
 */
function Searchable({
  label,
  value,
  onChange,
  explain = false,
}: {
  label: string;
  value: number;
  onChange: (share: number) => void;
  /** Spell out what the share means. Said once, under the first signal. */
  explain?: boolean;
}) {
  return (
    <div className="mt-2 text-xs leading-snug text-ink-3">
      <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
        <NumberField
          label={label}
          value={Math.round(value * 100)}
          min={1}
          max={100}
          integer
          compact
          className="w-11"
          onChange={(pct) => onChange(pct / 100)}
        />
        % kept searchable
      </span>
      {explain ? (
        <p className="mt-1">
          The rest is ingested but not indexed.
        </p>
      ) : null}
    </div>
  );
}

const INLINE_BUTTON =
  "py-0.5 font-medium text-ink-2 underline decoration-line-2 underline-offset-[3px] transition-colors hover:text-ink";

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-ink-2">{children}</div>;
}

function Field({
  label,
  hint,
  below = false,
  children,
}: {
  label: string;
  hint?: string;
  /** Put the control under the hint: for a control too wide to sit beside it. */
  below?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={below ? "py-2" : "flex items-start justify-between gap-3 py-2"}>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink">{label}</p>
        {hint ? <p className="mt-0.5 text-xs leading-snug text-ink-3">{hint}</p> : null}
      </div>
      <div
        className={`flex shrink-0 items-center gap-1.5 text-[13px] text-ink-3 ${below ? "mt-2" : ""}`}
      >
        {children}
      </div>
    </div>
  );
}

export function WorkloadPanel({
  w,
  s,
  onWorkload,
  onSettings,
  onReset,
}: {
  w: Workload;
  s: Settings;
  onWorkload: (next: Workload) => void;
  onSettings: (next: Settings) => void;
  onReset: () => void;
}) {
  // The captions under each volume say what that volume comes to, whether or
  // not the signal is switched on, so a dimmed block never contradicts itself.
  const d = derive({ ...w, send: { logs: true, metrics: true, traces: true, profiles: true } });
  const send = (signal: Signal, on: boolean) =>
    onWorkload({ ...w, send: { ...w.send, [signal]: on } });

  // Estimating from the host count overwrites three numbers the visitor may
  // have typed, so it says what it set and can be undone until the next edit.
  const [estimate, setEstimate] = useState<{ before: Workload; after: Workload } | null>(null);
  const estimateShown = estimate !== null && estimate.after === w;
  const estimateFromHosts = () => {
    const after = sizeFromHosts(w, w.infra.hosts);
    setEstimate({ before: w, after });
    onWorkload(after);
  };
  const undoEstimate = () => {
    if (estimate) onWorkload(estimate.before);
    setEstimate(null);
  };

  const panel = useRef<HTMLDivElement>(null);
  const assumptionsStart = useRef<HTMLDivElement>(null);
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const toggleAssumptions = () => {
    const opening = !assumptionsOpen;
    setAssumptionsOpen(opening);
    if (!opening) return;
    // Beside the results the panel scrolls inside itself, and the section
    // opens below its fold. Bring it up under the panel's heading.
    requestAnimationFrame(() => {
      const el = panel.current;
      const start = assumptionsStart.current;
      if (!el || !start || typeof el.scrollTo !== "function") return;
      if (el.scrollHeight <= el.clientHeight + 1) return;
      const heading = (el.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
      const still =
        typeof window.matchMedia !== "function" ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollTo({ top: start.offsetTop - heading, behavior: still ? "auto" : "smooth" });
    });
  };

  return (
    // On a wide screen the panel stays beside the results and scrolls inside
    // itself when it is taller than the window.
    <div
      ref={panel}
      className="opc-scroll relative rounded-xl border border-line bg-paper-2 lg:max-h-[calc(100vh-5.75rem)] lg:overflow-y-auto"
    >
      <div className="flex items-baseline justify-between rounded-t-xl border-b border-line bg-paper-2 px-5 py-2 lg:sticky lg:top-0 lg:z-10">
        <h2 className="text-[15px] font-semibold text-ink">Your workload</h2>
        <button
          type="button"
          onClick={onReset}
          className="py-1 text-[13px] font-medium text-ink-3 underline decoration-line-2 underline-offset-[3px] transition-colors hover:text-ink"
        >
          Reset to defaults
        </button>
      </div>

      <section className="border-b border-line px-5 py-3" aria-label="Hosts and seats">
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="block text-[13px] font-medium text-ink">Hosts or nodes</span>
            <NumberField
              label="Hosts or nodes"
              value={w.infra.hosts}
              min={LIMITS.hosts.min}
              max={LIMITS.hosts.max}
              integer
              className="mt-1.5 w-full"
              onChange={(hosts) => onWorkload({ ...w, infra: { ...w.infra, hosts } })}
            />
          </label>
          <label className="block">
            <span
              className="block text-[13px] font-medium text-ink"
              title="Anyone who queries data or edits dashboards and alerts"
            >
              People who need a seat
            </span>
            <NumberField
              label="People who need a seat"
              value={w.users}
              min={LIMITS.users.min}
              max={LIMITS.users.max}
              integer
              className="mt-1.5 w-full"
              onChange={(users) => onWorkload({ ...w, users })}
            />
          </label>
        </div>
        <p className="mt-2 text-xs leading-snug text-ink-3">
          {estimateShown ? (
            <>
              Volumes set to {PER_HOST.logGbPerDay} GB of logs a day, {num(PER_HOST.activeSeries, 0)}{" "}
              series and {PER_HOST.spansPerSecond} spans a second for each host.{" "}
              <button type="button" onClick={undoEstimate} className={INLINE_BUTTON}>
                Undo
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={estimateFromHosts}
                title={`Replaces the three volumes below with ${PER_HOST.logGbPerDay} GB of logs a day, ${num(PER_HOST.activeSeries, 0)} active series and ${PER_HOST.spansPerSecond} spans a second for each host, and switches all three signals on.`}
                className={INLINE_BUTTON}
              >
                Estimate volumes from the host count
              </button>
            </>
          )}
        </p>
      </section>

      <SignalBlock signal="logs" title="Logs" on={w.send.logs} onToggle={(on) => send("logs", on)}>
        <Row>
          <NumberField
            label="Log volume in GB per day"
            value={w.logs.gbPerDay}
            min={LIMITS.logGbPerDay.min}
            max={LIMITS.logGbPerDay.max}
            onChange={(gbPerDay) => onWorkload({ ...w, logs: { ...w.logs, gbPerDay } })}
          />
          <span>GB a day, kept</span>
          <SelectField
            label="Log retention"
            value={w.logs.retentionDays}
            options={LOG_RETENTION_DAYS.map((n) => ({ value: n, label: days(n) }))}
            onChange={(retentionDays) => onWorkload({ ...w, logs: { ...w.logs, retentionDays } })}
          />
        </Row>
        <div className="mt-0.5">
          <LogSlider
            label="Adjust log volume"
            value={w.logs.gbPerDay}
            min={LIMITS.logGbPerDay.min}
            max={LIMITS.logGbPerDay.max}
            valueText={`${num(w.logs.gbPerDay)} GB a day`}
            onChange={(gbPerDay) => onWorkload({ ...w, logs: { ...w.logs, gbPerDay } })}
          />
        </div>
        <p className="mt-1 text-xs text-ink-3">
          {dataSize(d.logs.gbPerMonth)} a month uncompressed, {compact(d.logs.recordsPerMonth)} records
        </p>
        <Searchable
          explain
          label="Share of logs kept searchable, percent"
          value={w.logs.searchableShare}
          onChange={(searchableShare) => onWorkload({ ...w, logs: { ...w.logs, searchableShare } })}
        />
      </SignalBlock>

      <SignalBlock
        signal="metrics"
        title="Metrics"
        on={w.send.metrics}
        onToggle={(on) => send("metrics", on)}
      >
        <Row>
          <NumberField
            label="Active metric series"
            value={w.metrics.activeSeries}
            min={LIMITS.activeSeries.min}
            max={LIMITS.activeSeries.max}
            integer
            className="w-28"
            onChange={(activeSeries) => onWorkload({ ...w, metrics: { ...w.metrics, activeSeries } })}
          />
          <span>active series</span>
        </Row>
        <div className="mt-0.5">
          <LogSlider
            label="Adjust active metric series"
            value={w.metrics.activeSeries}
            min={LIMITS.activeSeries.min}
            max={LIMITS.activeSeries.max}
            valueText={`${compact(w.metrics.activeSeries)} series`}
            onChange={(activeSeries) => onWorkload({ ...w, metrics: { ...w.metrics, activeSeries } })}
          />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-3">
          <span>One point every</span>
          <SelectField
            label="Metric export interval"
            value={w.metrics.intervalSeconds}
            options={INTERVALS_SECONDS.map((n) => ({ value: n, label: `${n} s` }))}
            onChange={(intervalSeconds) =>
              onWorkload({ ...w, metrics: { ...w.metrics, intervalSeconds } })
            }
            className="py-0.5 text-xs"
          />
          <span>is {compact(d.metrics.dataPointsPerMonth)} data points a month</span>
        </div>
      </SignalBlock>

      <SignalBlock
        signal="traces"
        title="Traces"
        on={w.send.traces}
        onToggle={(on) => send("traces", on)}
      >
        <Row>
          <NumberField
            label="Spans per second"
            value={w.traces.spansPerSecond}
            min={LIMITS.spansPerSecond.min}
            max={LIMITS.spansPerSecond.max}
            integer
            className="w-[5.25rem]"
            onChange={(spansPerSecond) => onWorkload({ ...w, traces: { ...w.traces, spansPerSecond } })}
          />
          <span>spans a second, kept</span>
          <SelectField
            label="Trace retention"
            value={w.traces.retentionDays}
            options={TRACE_RETENTION_DAYS.map((n) => ({ value: n, label: days(n) }))}
            onChange={(retentionDays) => onWorkload({ ...w, traces: { ...w.traces, retentionDays } })}
          />
        </Row>
        <div className="mt-0.5">
          <LogSlider
            label="Adjust spans per second"
            value={w.traces.spansPerSecond}
            min={LIMITS.spansPerSecond.min}
            max={LIMITS.spansPerSecond.max}
            valueText={`${compact(w.traces.spansPerSecond)} spans a second`}
            onChange={(spansPerSecond) => onWorkload({ ...w, traces: { ...w.traces, spansPerSecond } })}
          />
        </div>
        <p className="mt-1 text-xs text-ink-3">
          {compact(d.traces.spansPerMonth)} spans a month after sampling, {dataSize(d.traces.gbPerMonth)}
        </p>
        <Searchable
          label="Share of spans kept searchable, percent"
          value={w.traces.searchableShare}
          onChange={(searchableShare) => onWorkload({ ...w, traces: { ...w.traces, searchableShare } })}
        />
      </SignalBlock>

      <SignalBlock
        signal="profiles"
        title="Profiles"
        on={w.send.profiles}
        onToggle={(on) => send("profiles", on)}
      >
        <Row>
          <NumberField
            label="Share of hosts running a continuous profiler, percent"
            value={Math.round(w.profiles.profiledHostShare * 100)}
            min={1}
            max={100}
            integer
            compact
            className="w-11"
            onChange={(pct) =>
              onWorkload({ ...w, profiles: { ...w.profiles, profiledHostShare: pct / 100 } })
            }
          />
          <span>
            % of hosts run a continuous profiler: {num(d.profiles.profiledHosts)}{" "}
            {d.profiles.profiledHosts === 1 ? "host" : "hosts"}
          </span>
        </Row>
        <p className="mt-1 text-xs text-ink-3">
          {compact(d.profiles.samplesPerMonth)} samples a month, {dataSize(d.profiles.gbPerMonth)}
        </p>
        <p className="mt-1 text-xs leading-snug text-ink-3">
          Priced only where a profiling rate is published: Amazon CloudWatch (CodeGuru Profiler),
          Dash0, Datadog and Grafana Cloud. The rest are listed apart as not priced.
        </p>
      </SignalBlock>

      {/*
        Beside the results this heading stays at the foot of the panel while
        the section is below the fold, so it is never out of sight.
      */}
      <div ref={assumptionsStart} aria-hidden="true" />
      <h3 className="-mt-px border-t border-line bg-paper-2 lg:sticky lg:bottom-0 lg:z-10">
        <button
          type="button"
          aria-expanded={assumptionsOpen}
          aria-controls="opc-assumptions"
          onClick={toggleAssumptions}
          className="group/assume flex w-full items-center justify-between px-5 py-3 text-left text-[15px] font-semibold text-ink"
        >
          Assumptions
          <ChevronDown
            aria-hidden="true"
            strokeWidth={1.75}
            className="size-4 text-ink-3 transition-transform duration-200 group-hover/assume:text-ink group-aria-expanded/assume:rotate-180 motion-reduce:transition-none"
          />
        </button>
      </h3>
      {assumptionsOpen ? (
        <div id="opc-assumptions" className="divide-y divide-line border-t border-line px-5 pb-3">
          <Field
            label="Average log record"
            hint="For vendors that bill logs per event."
          >
            <NumberField
              label="Average log record size in bytes"
              value={w.logs.avgRecordBytes}
              min={LIMITS.avgRecordBytes.min}
              max={LIMITS.avgRecordBytes.max}
              integer
              className="w-20"
              onChange={(avgRecordBytes) => onWorkload({ ...w, logs: { ...w.logs, avgRecordBytes } })}
            />
            bytes
          </Field>
          <Field label="Average span" hint="For vendors that bill traces by GB.">
            <NumberField
              label="Average span size in bytes"
              value={w.traces.avgSpanBytes}
              min={LIMITS.avgSpanBytes.min}
              max={LIMITS.avgSpanBytes.max}
              integer
              className="w-20"
              onChange={(avgSpanBytes) => onWorkload({ ...w, traces: { ...w.traces, avgSpanBytes } })}
            />
            bytes
          </Field>
          <Field
            label="Profiling samples per host"
            hint="For vendors that bill profiles per sample or by GB. About two busy CPUs at the OpenTelemetry eBPF profiler's 20 samples a second each."
          >
            <NumberField
              label="Profiling samples per second per profiled host"
              value={w.profiles.samplesPerSecondPerHost}
              min={LIMITS.samplesPerSecondPerHost.min}
              max={LIMITS.samplesPerSecondPerHost.max}
              integer
              className="w-20"
              onChange={(samplesPerSecondPerHost) =>
                onWorkload({ ...w, profiles: { ...w.profiles, samplesPerSecondPerHost } })
              }
            />
            a second
          </Field>
          <Field label="Profiling sample" hint="For vendors that bill profiles by GB.">
            <NumberField
              label="Bytes per profiling sample"
              value={w.profiles.bytesPerSample}
              min={LIMITS.bytesPerSample.min}
              max={LIMITS.bytesPerSample.max}
              integer
              className="w-20"
              onChange={(bytesPerSample) =>
                onWorkload({ ...w, profiles: { ...w.profiles, bytesPerSample } })
              }
            />
            bytes
          </Field>
          <Field
            label="Metric data point"
            hint="For vendors that bill metrics by GB."
          >
            <NumberField
              label="Bytes per metric data point"
              value={w.metrics.bytesPerDataPoint}
              min={LIMITS.bytesPerDataPoint.min}
              max={LIMITS.bytesPerDataPoint.max}
              integer
              className="w-20"
              onChange={(bytesPerDataPoint) =>
                onWorkload({ ...w, metrics: { ...w.metrics, bytesPerDataPoint } })
              }
            />
            bytes
          </Field>
          <Field
            label="Host and container metrics"
            hint="Standard host, container and Kubernetes metrics. Some vendors include these in a host fee and bill the rest as custom."
          >
            <NumberField
              label="Share of series that are host and container metrics, percent"
              value={Math.round(w.metrics.hostSeriesShare * 100)}
              min={0}
              max={100}
              integer
              className="w-16"
              onChange={(pct) =>
                onWorkload({ ...w, metrics: { ...w.metrics, hostSeriesShare: pct / 100 } })
              }
            />
            %
          </Field>
          <Field label="Metrics kept">
            <SelectField
              label="Metric retention"
              value={w.metrics.retentionMonths}
              options={METRIC_RETENTION_MONTHS.map((n) => ({ value: n, label: months(n) }))}
              onChange={(retentionMonths) =>
                onWorkload({ ...w, metrics: { ...w.metrics, retentionMonths } })
              }
            />
          </Field>
          <Field
            below
            label="Query load"
            hint={`GB scanned a month for every GB ingested: ${SCAN_MULTIPLE.light}, ${SCAN_MULTIPLE.typical} or ${SCAN_MULTIPLE.heavy}.`}
          >
            <Segmented
              label="Query load"
              value={s.queryLoad}
              options={[
                { value: "light", label: "Light" },
                { value: "typical", label: "Typical" },
                { value: "heavy", label: "Heavy" },
              ]}
              onChange={(queryLoad) => onSettings({ ...s, queryLoad })}
            />
          </Field>
          <Field
            label="Hosts running traced services"
            hint="For vendors that bill tracing per host."
          >
            <NumberField
              label="Share of hosts running traced services, percent"
              value={Math.round(w.infra.tracedHostShare * 100)}
              min={0}
              max={100}
              integer
              className="w-16"
              onChange={(pct) =>
                onWorkload({ ...w, infra: { ...w.infra, tracedHostShare: pct / 100 } })
              }
            />
            %
          </Field>
          <Field
            label="Containers per host"
            hint="For vendors that bill containers."
          >
            <NumberField
              label="Containers per host"
              value={w.infra.containersPerHost}
              min={LIMITS.containersPerHost.min}
              max={LIMITS.containersPerHost.max}
              integer
              className="w-16"
              onChange={(containersPerHost) =>
                onWorkload({ ...w, infra: { ...w.infra, containersPerHost } })
              }
            />
          </Field>
          <Field
            label="Memory per host"
            hint="For vendors that bill by host memory."
          >
            <NumberField
              label="Memory per host in GiB"
              value={w.infra.memoryGibPerHost}
              min={LIMITS.memoryGibPerHost.min}
              max={LIMITS.memoryGibPerHost.max}
              integer
              className="w-16"
              onChange={(memoryGibPerHost) =>
                onWorkload({ ...w, infra: { ...w.infra, memoryGibPerHost } })
              }
            />
            GiB
          </Field>
        </div>
      ) : null}
    </div>
  );
}
