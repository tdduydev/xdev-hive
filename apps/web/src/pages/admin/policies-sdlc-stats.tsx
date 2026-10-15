import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { SdlcMetrics } from "@xdev-hive/contracts";
import { useState } from "react";
import { type Dict, type Lang, useLang, useT } from "@/lib/i18n.ts";
import { useOrg } from "@/shell/org-context.ts";

const DAYS = 30;
const DAY_MS = 86_400_000;

const text: Dict<{
  aria: string;
  autoTop: string;
  revokeTop: string;
  projects: string;
  projectsHint: (total: number) => string;
  byMode: (mode: string, days: number) => string;
  none: (days: number) => string;
  more: string;
}> = {
  vi: {
    aria: "Số liệu tự duyệt AI SDLC",
    autoTop: "Tỉ lệ tự duyệt cao nhất",
    revokeTop: "Tỉ lệ thu hồi cao nhất",
    projects: "Dự án bật tự duyệt",
    projectsHint: (total) => `trên ${total} dự án bật AI SDLC`,
    byMode: (mode, days) => `${mode} · ${days} ngày qua`,
    none: (days) => `chưa có trong ${days} ngày qua`,
    more: "Xem chỉ số theo chế độ và dự án",
  },
  en: {
    aria: "AI SDLC auto-approval figures",
    autoTop: "Highest auto-approval rate",
    revokeTop: "Highest revoke rate",
    projects: "Projects with it on",
    projectsHint: (total) => `of ${total} AI SDLC projects`,
    byMode: (mode, days) => `${mode} · last ${days} days`,
    none: (days) => `none in the last ${days} days`,
    more: "See metrics by mode and project",
  },
};

type Row = SdlcMetrics["autoApproval"][number];

/** Dòng có tỉ lệ lớn nhất. Hub chỉ trả tỉ lệ, không trả số cổng, nên không cộng gộp được thành một tỉ lệ chung. */
function top(rows: Row[], pick: (r: Row) => number | null): { row: Row; rate: number } | null {
  let best: { row: Row; rate: number } | null = null;
  for (const row of rows) {
    const rate = pick(row);
    if (rate !== null && rate > (best?.rate ?? -1)) best = { row, rate };
  }
  return best;
}

const pct = (rate: number, lang: Lang) =>
  `${new Intl.NumberFormat(lang === "en" ? "en-GB" : "vi-VN", { maximumFractionDigits: 1 }).format(rate * 100)}%`;

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xl font-semibold tabular-nums">{value}</span>
      <span className="truncate text-xs text-muted-foreground">{hint}</span>
    </div>
  );
}

/**
 * Hàng số liệu cuối mục AI SDLC của /admin/policies (Policies.dc.html): quản trị thấy tự duyệt đang dùng tới đâu trước
 * khi siết hay nới. Đọc `sdlc.metrics` 30 ngày; hub lỗi hoặc người xem không có quyền đọc chỉ số thì ẩn hàng này, vì
 * form chính sách vẫn phải dùng được.
 */
export function SdlcPolicyStats() {
  const t = useT(text);
  const lang = useLang();
  const { api } = useOrg();
  // Giữ mốc thời gian cố định trong phiên trang để khoá truy vấn không đổi mỗi lần vẽ.
  const [to] = useState(() => Date.now());
  const metrics = useQuery({
    ...api.sdlc.metrics.queryOptions({
      input: { from: new Date(to - DAYS * DAY_MS).toISOString(), to: new Date(to).toISOString() },
    }),
    retry: false,
  });
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const modes = useQuery({ ...api.sdlc.modes.list.queryOptions({ input: {} }), retry: false });

  if (!metrics.isSuccess || !projects.isSuccess) return null;
  const sdlcProjects = projects.data.filter((p) => p.settings.sdlc?.enabled);
  if (!sdlcProjects.length) return null;

  const autoOn = sdlcProjects.filter((p) => p.settings.sdlc?.autoApprove.enabled).length;
  // Dòng cả chế độ (không gắn dự án) là con số quản trị cần so; chỉ khi hub không trả dòng đó mới xét dòng theo dự án.
  const rows = metrics.data.autoApproval;
  const wholeMode = rows.filter((r) => r.projectKey === null);
  const pool = wholeMode.length ? wholeMode : rows;
  const modeName = (ref: string) => modes.data?.find((m) => m.ref === ref)?.definition.name ?? ref;
  const label = (r: Row) => (r.projectKey ? `${modeName(r.modeRef)} · ${r.projectKey}` : modeName(r.modeRef));
  const auto = top(pool, (r) => r.autoRate);
  const revoke = top(pool, (r) => r.revokeRate);

  return (
    <div className="grid gap-2.5 border-t border-dashed border-border pt-3.5">
      <section aria-label={t.aria} className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2.5">
        <Stat
          label={t.autoTop}
          value={auto ? pct(auto.rate, lang) : "—"}
          hint={auto ? t.byMode(label(auto.row), DAYS) : t.none(DAYS)}
        />
        <Stat
          label={t.revokeTop}
          value={revoke ? pct(revoke.rate, lang) : "—"}
          hint={revoke ? t.byMode(label(revoke.row), DAYS) : t.none(DAYS)}
        />
        <Stat label={t.projects} value={String(autoOn)} hint={t.projectsHint(sdlcProjects.length)} />
      </section>
      <Link to="/sdlc/metrics" className="justify-self-start text-sm font-medium text-primary hover:text-primary/90">
        {t.more}
      </Link>
    </div>
  );
}
