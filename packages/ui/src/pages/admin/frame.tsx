// Pages that came from the Web Admin, in the one web shell (roadmap 35b): they draw no padding of their own, and the
// overview reads a time range that used to sit in the admin top bar.
import { createContext, useContext, useState, type ReactNode } from "react";
import { cn } from "cn";
import { useT } from "#ui/i18n/index.tsx";
import { OpsOverview } from "./Ops.tsx";

export type AdminRange = "d1" | "d7" | "d30";
export const RANGE_HOURS: Record<AdminRange, number> = { d1: 24, d7: 24 * 7, d30: 24 * 30 };

const RangeContext = createContext<{ range: AdminRange }>({ range: "d1" });
/** The time range picked on the overview (24h / 7d / 30d). */
export const useAdminRange = (): AdminRange => useContext(RangeContext).range;

/** The padded column an operations page sits in. */
export function OpsPage({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-[clamp(14px,2.2vw,24px)] pt-[clamp(14px,2.2vw,24px)] pb-8">{children}</div>;
}

/** The hub's overview with its time range, remembered on this browser. */
export function OverviewWithRange() {
  const t = useT();
  const [range, setRange] = useState<AdminRange>(() => {
    try {
      const v = localStorage.getItem("hive-admin-range");
      return v === "d7" || v === "d30" ? v : "d1";
    } catch {
      return "d1";
    }
  });
  const pick = (r: AdminRange) => {
    setRange(r);
    try {
      localStorage.setItem("hive-admin-range", r);
    } catch {
      // Not remembered.
    }
  };
  const picker = (
    <div role="radiogroup" aria-label={t("ops.rangeLabel")} className="flex w-fit gap-0.5 rounded-[7px] bg-sunken p-0.5">
      {(["d1", "d7", "d30"] as const).map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={range === r}
          onClick={() => pick(r)}
          className={cn("h-[26px] cursor-pointer rounded-[5px] px-2.5 font-mono text-xs/none outline-none focus-visible:focus-ring", range === r ? "bg-surface font-semibold text-fg-strong shadow-e1" : "text-fg-secondary")}
        >
          {t(`ops.range.${r}`)}
        </button>
      ))}
    </div>
  );
  return (
    <RangeContext.Provider value={{ range }}>
      <OpsPage>
        <OpsOverview lead={picker} />
      </OpsPage>
    </RangeContext.Provider>
  );
}
