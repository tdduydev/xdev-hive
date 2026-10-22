import { ORPCError } from "@orpc/client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { ProjectTokenUsageRow } from "@xdev-hive/contracts";
import { buttonVariants } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, Td, Th } from "@xdev-hive/ui/table";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";
import { FilterChips } from "@/components/ui/filter-chips.tsx";
import { EmptyState, LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { formatDayTime, formatInt } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

type Drift = ProjectTokenUsageRow["policyDrift"][number];

const PERIODS = [7, 30] as const;
type Period = (typeof PERIODS)[number];

const text: Dict<{
  title: string;
  lead: string;
  projectCrumb: string;
  period: string;
  periodDays: (days: number) => string;
  caption: string;
  colUser: string;
  colMachine: string;
  colTokens: string;
  colSessions: string;
  colScore: string;
  colDrift: string;
  colSent: string;
  total: (machines: number) => string;
  noDrift: string;
  emptyTitle: string;
  empty: (days: number) => string;
  outsideTitle: string;
  outside: string;
  backToBoard: string;
  drift: Record<Drift, string>;
}> = {
  vi: {
    title: "Token",
    lead: "Token quy đổi theo người và máy trong dự án. Chỉ có số liệu, không có nội dung phiên.",
    projectCrumb: "Dự án",
    period: "Kỳ xem",
    periodDays: (days) => `${days} ngày`,
    caption: "Token theo người và máy của dự án",
    colUser: "Người",
    colMachine: "Máy",
    colTokens: "Token quy đổi",
    colSessions: "Phiên",
    colScore: "Điểm",
    colDrift: "Lệch chính sách",
    colSent: "Gửi lần cuối",
    total: (machines) => `Tổng (${machines} máy)`,
    noDrift: "Không lệch",
    emptyTitle: "Chưa có máy nào gửi số liệu",
    empty: (days) =>
      `Trong ${days} ngày qua chưa có máy nào gửi số liệu token của dự án này. Mỗi thành viên bật "Gửi số liệu token" ở màn Memory của app desktop thì máy của họ hiện ở đây.`,
    outsideTitle: "Bạn không xem được số liệu này",
    outside: "Chỉ thành viên đội sở hữu dự án xem được token của dự án. Dự án cũng có thể không tồn tại.",
    backToBoard: "Về dự án",
    drift: {
      level: "Mức tối ưu",
      rtk: "RTK",
      codegraph: "CodeGraph",
      autoCompactWindow: "Cửa sổ tự nén",
      contextBudgetTokens: "Ngân sách ngữ cảnh",
      memoryAutoSync: "Tự đồng bộ memory",
    },
  },
  en: {
    title: "Tokens",
    lead: "Weighted tokens per person and machine in the project. Numbers only, no session content.",
    projectCrumb: "Projects",
    period: "Period",
    periodDays: (days) => `${days} days`,
    caption: "Tokens per person and machine of the project",
    colUser: "Person",
    colMachine: "Machine",
    colTokens: "Weighted tokens",
    colSessions: "Sessions",
    colScore: "Score",
    colDrift: "Policy drift",
    colSent: "Last sent",
    total: (machines) => `Total (${machines} machines)`,
    noDrift: "In line",
    emptyTitle: "No machine has reported yet",
    empty: (days) =>
      `No machine has sent token numbers for this project in the last ${days} days. Each member turns on "Send token numbers" on the Memory screen of the desktop app and their machine shows up here.`,
    outsideTitle: "You cannot view these numbers",
    outside: "Only members of the team that owns the project can see its tokens. The project may also not exist.",
    backToBoard: "Back to the project",
    drift: {
      level: "Optimizer level",
      rtk: "RTK",
      codegraph: "CodeGraph",
      autoCompactWindow: "Auto-compact window",
      contextBudgetTokens: "Context budget",
      memoryAutoSync: "Memory auto-sync",
    },
  },
};

/** Hub báo người ngoài dự án như không tìm thấy dự án để không lộ dự án; FORBIDDEN giữ cho hợp đồng sau này đổi. */
export function isOutsideProject(error: unknown): boolean {
  return error instanceof ORPCError && (error.code === "FORBIDDEN" || error.code === "NOT_FOUND");
}

export interface TokenTotals {
  tokens: number;
  sessions: number;
  machines: number;
}

export function totalsOf(rows: readonly ProjectTokenUsageRow[]): TokenTotals {
  return {
    tokens: rows.reduce((sum, r) => sum + r.tokens, 0),
    sessions: rows.reduce((sum, r) => sum + r.sessions, 0),
    machines: rows.length,
  };
}

/** /projects/$key/token-usage: token theo người và máy của dự án, cho thành viên dự án. */
export function TokenUsagePage() {
  const { api } = useOrg();
  const t = useT(text);
  const { key } = useParams({ from: "/session/app/in-org/projects/$key/token-usage" });
  const [days, setDays] = useState<Period>(7);
  const usage = useQuery({
    ...api.projects.tokenUsage.queryOptions({ input: { key, days } }),
    placeholderData: keepPreviousData,
  });

  const crumb = (
    <>
      <Link to="/projects" className="text-primary hover:text-primary/90">
        {t.projectCrumb}
      </Link>{" "}
      /{" "}
      <Link to="/projects/$key" params={{ key }} className="text-primary hover:text-primary/90">
        <span className="font-mono">{key}</span>
      </Link>
    </>
  );

  const rows = usage.data?.rows ?? [];
  return (
    <>
      <PageHeader crumb={crumb} title={t.title} description={t.lead} />
      <PageBody>
        <div className="grid gap-5">
          {usage.isError && isOutsideProject(usage.error) ? (
            <>
              <EmptyState icon={GaugeIcon} title={t.outsideTitle} description={t.outside} />
              <Link to="/projects/$key" params={{ key }} className={`${buttonVariants({ variant: "outline" })} w-fit`}>
                {t.backToBoard}
              </Link>
            </>
          ) : (
            <>
              <FilterChips
                label={t.period}
                value={String(days)}
                onChange={(key) => setDays(key === "30" ? 30 : 7)}
                chips={PERIODS.map((d) => ({ key: String(d), label: t.periodDays(d) }))}
              />
              {usage.isPending ? (
                <TableSkeleton rows={4} columns={7} />
              ) : usage.isError ? (
                <LoadFailure error={usage.error} retry={() => usage.refetch()} />
              ) : rows.length === 0 ? (
                <EmptyState icon={GaugeIcon} title={t.emptyTitle} description={t.empty(days)} />
              ) : (
                <div className="min-w-0" aria-busy={usage.isPlaceholderData}>
                  <UsageTable rows={rows} />
                </div>
              )}
            </>
          )}
        </div>
      </PageBody>
    </>
  );
}

function UsageTable({ rows }: { rows: readonly ProjectTokenUsageRow[] }) {
  const t = useT(text);
  const total = totalsOf(rows);
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <Table className="[&_td]:align-top" style={{ minWidth: 820 }}>
        <caption className="sr-only">{t.caption}</caption>
        <thead>
          <tr>
            <Th variant="plain">{t.colUser}</Th>
            <Th variant="plain">{t.colMachine}</Th>
            <Th variant="plain" className="text-right">
              {t.colTokens}
            </Th>
            <Th variant="plain" className="text-right">
              {t.colSessions}
            </Th>
            <Th variant="plain" className="text-right">
              {t.colScore}
            </Th>
            <Th variant="plain">{t.colDrift}</Th>
            <Th variant="plain">{t.colSent}</Th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-muted/40 font-medium">
            <Td colSpan={2}>{t.total(total.machines)}</Td>
            <Td className="text-right tabular-nums">{formatInt(total.tokens)}</Td>
            <Td className="text-right tabular-nums">{formatInt(total.sessions)}</Td>
            <Td colSpan={3} />
          </tr>
          {rows.map((row) => (
            <tr key={`${row.userId}:${row.machineId}`}>
              <Td className="text-sm font-medium">{row.userName || row.userId}</Td>
              <Td className="text-sm break-all">{row.machineName}</Td>
              <Td className="text-right text-sm tabular-nums">{formatInt(row.tokens)}</Td>
              <Td className="text-right text-sm tabular-nums">{formatInt(row.sessions)}</Td>
              <Td className="text-right text-sm tabular-nums">{row.score === null ? "—" : formatInt(row.score)}</Td>
              <Td>
                {row.policyDrift.length === 0 ? (
                  <span className="text-sm text-muted-foreground">{t.noDrift}</span>
                ) : (
                  <ul className="flex flex-wrap gap-1.5" aria-label={t.colDrift}>
                    {row.policyDrift.map((d) => (
                      <li key={d}>
                        <Pill tone="warn">{t.drift[d]}</Pill>
                      </li>
                    ))}
                  </ul>
                )}
              </Td>
              <Td className="text-sm tabular-nums">{formatDayTime(row.periodEnd)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
