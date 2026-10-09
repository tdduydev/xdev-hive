// Máy & agent (72g): the pieces of the design's machine card (system block, plan tile with its quota rings).
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import type { MachineSystem, ReportedProfile } from "@xdev-hive/core";
import { cn } from "cn";
import { cosmicAssets } from "#ui/assets/cosmic.ts";
import { useI18n, useT } from "#ui/i18n/index.tsx";

const PLANET: Record<string, string> = { claude: cosmicAssets.planetViolet, codex: cosmicAssets.planetGreen, gemini: cosmicAssets.planetBlue };

const OS_TAG: Record<MachineSystem["os"], { label: string; bg: string; fg: string }> = {
  macos: { label: "macOS", bg: "var(--os-mac-bg)", fg: "var(--os-mac-fg)" },
  ubuntu: { label: "Ubuntu", bg: "var(--os-ubuntu-bg)", fg: "var(--os-ubuntu-fg)" },
  windows: { label: "Windows", bg: "var(--os-win-bg)", fg: "var(--os-win-fg)" },
  linux: { label: "Linux", bg: "var(--os-ubuntu-bg)", fg: "var(--os-ubuntu-fg)" },
};

const level = (p: number) => (p >= 90 ? "var(--accent-red)" : p >= 75 ? "var(--accent-amber)" : "var(--accent-green)");
const numColor = (p: number) => (p >= 90 ? "var(--num-danger)" : p >= 75 ? "var(--num-warn)" : "var(--text-strong)");

/** The OS, hardware and CPU/RAM/disk of the machine, from what the machine reported (never filled in). */
export function MachineSystemBlock({ system: s }: { system: MachineSystem }) {
  const t = useT();
  const os = OS_TAG[s.os];
  const rows = [
    { label: t("agentMap.cpu"), ...s.cpu },
    { label: t("agentMap.ram"), ...s.ram },
    { label: t("agentMap.disk"), ...s.disk },
  ].filter((r): r is { label: string; percent: number; detail: string } => r.percent !== undefined);
  return (
    <div className="flex flex-col gap-3 rounded-[16px] bg-sunken p-[14px] shadow-[var(--ring-glass)]">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex h-[22px] items-center rounded-[6px] px-2 text-[10.5px]/none font-bold tracking-[.3px] whitespace-nowrap" style={{ background: os.bg, color: os.fg }}>{os.label}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px]/[18px] font-semibold">{s.osName}</span>
          <span className="truncate text-[12px]/[18px] font-medium text-fg-muted">{s.hardware}</span>
        </span>
        {s.uptime ? <span className="text-[11px]/4 font-semibold whitespace-nowrap text-[color:var(--text-faint)]">{s.uptime}</span> : null}
      </div>
      {rows.length ? (
        <div className="grid grid-cols-3 gap-2.5">
          {rows.map((r) => (
            <div key={r.label} className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-baseline gap-1.5">
                <span className="flex-1 text-[11px]/4 font-semibold tracking-[.5px] text-[color:var(--text-faint)] uppercase">{r.label}</span>
                <span className="text-[14px]/none font-bold" style={{ color: numColor(r.percent) }}>{r.percent}%</span>
              </div>
              <div className="h-[5px] overflow-hidden rounded-full bg-[var(--track)]"><div className="h-full rounded-full" style={{ width: `${r.percent}%`, background: level(r.percent) }} /></div>
              <span className="truncate text-[11px]/[15px] font-medium text-fg-muted">{r.detail}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const MASK = (ring: number, edge: number) => {
  const mask = `radial-gradient(farthest-side, transparent calc(100% - ${ring}px), #000 calc(100% - ${edge}px))`;
  return { WebkitMask: mask, mask } as CSSProperties;
};

const leftTone = (left: number) => (left < 20 ? "var(--accent-red)" : left < 40 ? "var(--accent-amber)" : "var(--accent-green)");

const WEEKDAY_VI = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

/** "15:40" of an instant; the CLI's own words when the machine sent no instant. */
function sessionAt(iso: string | null | undefined, text: string | null | undefined): string | null {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(+at) ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : (text ?? null);
}

function weekAt(iso: string | null | undefined, text: string | null | undefined, lang: string): string | null {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(+at)) return text ?? null;
  return lang === "vi" ? WEEKDAY_VI[at.getDay()]! : at.toLocaleDateString("en", { weekday: "short" });
}

/** One plan: two rings (5-hour session outside, week inside), its reset times and the weekly resets it has left. */
export function PlanTile({ profile: p, pick, extra, state, attrs }: {
  profile: ReportedProfile;
  pick: { on: boolean; toggle: () => void } | null;
  /** What the design has no place for (state, runs, a change waiting): under the reset lines, only when there is something. */
  extra?: ReactNode;
  state?: string;
  attrs?: Record<string, string>;
}) {
  const t = useT();
  const lang = useI18n().locale;
  const left5 = p.sessionPercent == null ? null : Math.max(0, Math.round(100 - p.sessionPercent));
  const leftWk = p.weekPercent == null ? null : Math.max(0, Math.round(100 - p.weekPercent));
  const out = left5 === 0;
  const reset5 = sessionAt(p.sessionResetsAt, p.sessionResets);
  const resetWk = weekAt(p.weekResetsAt, p.weekResets, lang);
  const planet = PLANET[p.kind];
  const resetsLeft = p.resetsLeft ?? null;
  const onKey = (e: KeyboardEvent) => {
    if (pick && (e.key === " " || e.key === "Enter")) { e.preventDefault(); pick.toggle(); }
  };
  const pct = (n: number | null) => (n == null ? "—" : `${n}%`);
  return (
    <div
      role={pick ? "checkbox" : undefined}
      aria-checked={pick ? pick.on : undefined}
      tabIndex={pick ? 0 : undefined}
      onClick={pick?.toggle}
      onKeyDown={onKey}
      data-map-state={state}
      title={t("agentMap.planTip", { name: p.label, left5: pct(left5), reset5: reset5 ?? "—", leftWk: pct(leftWk), resetWk: resetWk ?? "—" })}
      {...attrs}
      className={cn("flex min-w-0 flex-col items-center gap-2 rounded-[16px] bg-sunken px-1.5 pt-3 pb-2.5 outline-none", pick && "cursor-pointer focus-visible:focus-ring")}
      style={{ boxShadow: pick?.on ? "inset 0 0 0 2px var(--border-selected)" : out ? "var(--ring-danger)" : "var(--ring-glass)" }}
    >
      <div className="relative size-[68px]">
        <div className="absolute inset-0 rounded-full" style={{ background: `conic-gradient(${leftTone(left5 ?? 0)} ${left5 ?? 0}%, var(--track) 0)`, ...MASK(6, 5) }} />
        <div className="absolute inset-[10px] rounded-full opacity-75" style={{ background: `conic-gradient(${leftTone(leftWk ?? 0)} ${leftWk ?? 0}%, var(--track) 0)`, ...MASK(4, 3) }} />
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[15px]/4 font-bold" style={{ color: out ? "var(--num-danger)" : "var(--text-strong)" }}>{pct(left5)}</span>
          <span className="text-[9px]/3 font-semibold tracking-[.3px] text-[color:var(--text-faint)]">{t("agentMap.left")}</span>
        </div>
      </div>
      <div className="flex w-full min-w-0 flex-col items-center gap-px">
        <span className="flex max-w-full items-start justify-center gap-[5px] text-[12px]/4 font-semibold">
          {planet ? <span aria-hidden="true" className="mt-0.5 inline-block size-3 shrink-0 rounded-full bg-contain bg-center bg-no-repeat" style={{ backgroundImage: `url('${planet}')` }} /> : null}
          <span className="text-center [overflow-wrap:anywhere]">{p.label}</span>
        </span>
        <span data-usage-resets className="flex max-w-full flex-col items-center gap-px">
          <span className="max-w-full truncate text-[11px]/[15px] font-medium whitespace-nowrap" style={{ color: out ? "var(--num-danger)" : "var(--text-secondary)" }}>
            {reset5 ? t(out ? "agentMap.outReset" : "agentMap.reset", { time: reset5 }) : "—"}
          </span>
          <span className="max-w-full truncate text-[10.5px]/[14px] font-medium whitespace-nowrap text-[color:var(--text-faint)]">
            {leftWk == null ? "—" : resetWk ? t("agentMap.weekLeft", { pct: pct(leftWk), reset: resetWk }) : t("agentMap.weekLeftOnly", { pct: pct(leftWk) })}
          </span>
        </span>
        {extra}
      </div>
      <span
        title={resetsLeft == null ? undefined : t("agentMap.resetTip", { count: resetsLeft })}
        className="inline-flex h-[26px] w-full items-center justify-center gap-[5px] rounded-full px-1.5 text-[11px]/none font-semibold whitespace-nowrap"
        style={resetsLeft ? { background: "var(--reset-bg)", boxShadow: "var(--reset-ring)", color: "var(--text-strong)" } : { background: "var(--reset-off-bg)", boxShadow: "var(--ring-glass)", color: "var(--text-faint)" }}
      >
        <RotateCcw aria-hidden="true" className="size-[11px]" style={{ opacity: resetsLeft ? 0.9 : 0.35 }} />
        <span>{resetsLeft == null ? t("agentMap.resetWeekPlain") : t("agentMap.resetWeek", { count: resetsLeft })}</span>
      </span>
    </div>
  );
}
