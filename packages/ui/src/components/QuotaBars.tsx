import type { ReportedProfile } from "@xdev-hive/core";
import { cn } from "cn";
import { useT } from "#ui/i18n/index.tsx";
import { meterTone } from "#ui/lib/agents.ts";

const TONE = { ok: "bg-primary", near: "bg-warning-solid", over: "bg-danger-solid" };

/** Reports do not carry custom stop thresholds; overLimit is the runner's authoritative blocker. */
export function QuotaBars({ profile: p }: { profile: ReportedProfile }) {
  const t = useT();
  return <div className="grid min-w-0 grid-cols-[auto_minmax(32px,1fr)_auto] items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
    {(["session", "week"] as const).map(which => {
      const value = which === "session" ? p.sessionPercent : p.weekPercent;
      const pct = Math.max(0, Math.min(100, value ?? 0));
      const label = t(`ops.${which}`);
      return <span key={which} className="contents">
        <span>{label}</span>
        <span role={value == null ? undefined : "meter"} aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value == null ? undefined : pct} className="relative h-1.5 overflow-hidden rounded-full bg-sunken">
          {value != null ? <span className={cn("absolute inset-y-0 left-0 rounded-full", TONE[p.overLimit ? "over" : meterTone(pct, 100)])} style={{ width: `${pct}%` }} /> : null}
        </span>
        <span className="text-right font-mono">{value == null ? "—" : `${Math.round(value)}%`}</span>
      </span>;
    })}
  </div>;
}
