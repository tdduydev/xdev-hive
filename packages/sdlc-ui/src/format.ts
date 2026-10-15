import type { SdlcItemSummary } from "@xdev-hive/contracts";
import type { Lang } from "./env.tsx";

const locale = (lang: Lang) => (lang === "en" ? "en-GB" : "vi-VN");

export function formatUsd(value: number | null, lang: Lang): string {
  if (value === null) return "—";
  return `${new Intl.NumberFormat(locale(lang), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} USD`;
}

export function formatWhen(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
}

export type Tone = "neutral" | "ok" | "warn" | "bad" | "sel";

/** Dòng "đang chờ" của thẻ: tạm dừng và chờ máy dễ bị bỏ quên nên tô nổi hơn chờ người. */
export function waitingOf(item: SdlcItemSummary, t: { paused: string; waitingMachine: string }) {
  if (item.status === "paused") return { text: t.paused, tone: "bad" as Tone };
  if (item.waitingMachine) return { text: t.waitingMachine, tone: "warn" as Tone };
  if (item.waitingFor) return { text: item.waitingFor, tone: "neutral" as Tone };
  return null;
}
