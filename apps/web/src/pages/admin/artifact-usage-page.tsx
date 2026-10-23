import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ArtifactUsage, DEFAULT_ORG_ARTIFACT_POLICY } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import { Meter } from "@/components/ui/meter.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { formatBytes } from "@/lib/terminal/sessions.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

/** Quản trị thấy số liệu, không thấy nội dung `private` của người khác (C5), nên bảng chỉ có tên và dung lượng. */
const text = {
  vi: {
    title: "Dung lượng artifact",
    lead: "Dung lượng artifact của tổ chức theo dự án và theo người. Chỉ có số liệu, không mở nội dung artifact cá nhân.",
    forbidden: "Chỉ quản trị tổ chức xem được dung lượng artifact.",
    used: "Đã dùng",
    of: "trên",
    percent: (n: number) => `${n}% hạn mức`,
    artifacts: (n: number) => `${n} artifact`,
    warn: "Đã dùng từ 80% hạn mức. Hub báo quản trị một lần mỗi ngày; hết hạn mức thì chặn ghi mới.",
    full: "Đã hết hạn mức: không tạo hoặc sửa được artifact cho tới khi xoá bớt hoặc tăng hạn mức.",
    meter: "Dung lượng artifact đã dùng so với hạn mức",
    byProject: "Theo dự án",
    byUser: "Theo người",
    project: "Dự án",
    user: "Người",
    size: "Dung lượng",
    count: "Số artifact",
    empty: "Chưa có artifact nào.",
    policy: "Đổi hạn mức ở Chính sách agent",
  },
  en: {
    title: "Artifact storage",
    lead: "Organization artifact storage by project and by person. Numbers only; private artifact content stays private.",
    forbidden: "Only organization administrators can see artifact storage.",
    used: "Used",
    of: "of",
    percent: (n: number) => `${n}% of quota`,
    artifacts: (n: number) => `${n} artifacts`,
    warn: "80% of the quota is used. The hub notifies admins once a day; when full, new writes are blocked.",
    full: "Quota is full: artifacts cannot be created or edited until some are deleted or the quota is raised.",
    meter: "Artifact storage used against the quota",
    byProject: "By project",
    byUser: "By person",
    project: "Project",
    user: "Person",
    size: "Size",
    count: "Artifacts",
    empty: "No artifacts yet.",
    policy: "Change the quota in Agent policies",
  },
} satisfies Dict<Record<string, unknown>>;

export function ArtifactUsagePage() {
  const { org, api } = useOrg();
  const t = useT(text);
  const admin = isOrgAdmin(org.role);
  const usage = useQuery({ ...api.artifacts.usage.queryOptions(), enabled: admin });
  let body = <Alert>{t.forbidden}</Alert>;
  if (admin) {
    if (usage.isPending) body = <LoadingState />;
    else if (usage.isError) body = <LoadFailure error={usage.error} retry={() => void usage.refetch()} />;
    else body = <UsageBody usage={usage.data} />;
  }
  return (
    <>
      <PageHeader title={t.title} description={t.lead} />
      <PageBody>{body}</PageBody>
    </>
  );
}

function UsageBody({ usage }: { usage: ArtifactUsage }) {
  const t = useT(text);
  // Hub luôn trả hạn mức; 0 chỉ gặp ở hub cũ nên rơi về mặc định thay vì chia cho 0.
  const quota = usage.quotaBytes || DEFAULT_ORG_ARTIFACT_POLICY.orgQuotaBytes;
  const percent = Math.min(100, Math.round((usage.usedBytes / quota) * 100));
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section aria-label={t.used} className="flex max-w-2xl flex-col gap-3 rounded-xl border border-border p-4">
        <p className="text-sm">
          <span className="text-xl font-semibold">{formatBytes(usage.usedBytes)}</span>{" "}
          <span className="text-muted-foreground">
            {t.of} {formatBytes(quota)} · {t.percent(percent)} · {t.artifacts(usage.artifacts)}
          </span>
        </p>
        <Meter value={percent} label={t.meter} />
        {percent >= 100 && <Alert variant="destructive">{t.full}</Alert>}
        {percent >= 80 && percent < 100 && <Alert>{t.warn}</Alert>}
        <Link to="/admin/policies" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          {t.policy}
        </Link>
      </section>
      <Breakdown
        title={t.byProject}
        head={t.project}
        rows={usage.byProject.map((row) => ({
          id: row.project.id,
          name: `${row.project.name} (${row.project.key})`,
          bytes: row.bytes,
          artifacts: row.artifacts,
        }))}
      />
      <Breakdown
        title={t.byUser}
        head={t.user}
        rows={usage.byUser.map((row) => ({
          id: row.user.id,
          name: row.user.name,
          bytes: row.bytes,
          artifacts: row.artifacts,
        }))}
      />
    </div>
  );
}

function Breakdown({
  title,
  head,
  rows,
}: {
  title: string;
  head: string;
  rows: { id: string; name: string; bytes: number; artifacts: number }[];
}) {
  const t = useT(text);
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2">
      <h2 className="text-base font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.empty}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <Th>{head}</Th>
              <Th className="text-right">{t.size}</Th>
              <Th className="text-right">{t.count}</Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <Td>{row.name}</Td>
                <Td className="text-right tabular-nums">{formatBytes(row.bytes)}</Td>
                <Td className="text-right tabular-nums">{row.artifacts}</Td>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
