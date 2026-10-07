import { AttentionList } from "#ui/components/AttentionList.tsx";
import { SummaryStrip } from "#ui/components/SummaryStrip.tsx";
import { Page, PageHeader } from "#ui/components/common.tsx";

/** Browser-only fixture route for checking these shared components before product pages adopt them. */
export function DashboardComponentsFixture() {
  return (
    <Page>
      <PageHeader title="Dashboard components" />
      <SummaryStrip
        label="Tóm tắt"
        items={[
          { id: "running", label: "Đang chạy", value: 2, href: "#/runs?status=running" },
          { id: "queued", label: "Hàng đợi", value: 1, href: "#/runs?status=queued" },
          { id: "review", label: "Chờ duyệt", value: 3, href: "#/tasks?status=review", tone: "warning" },
        ]}
      />
      <AttentionList
        label="Cần chú ý"
        items={[
          { id: "quota", level: "warning", levelLabel: "Chú ý", text: "Một máy sắp hết quota", action: <button type="button">Xem máy</button> },
          { id: "backup", level: "danger", levelLabel: "Lỗi", text: "Backup chưa sẵn sàng", action: <button type="button" disabled>Đang kiểm tra</button> },
        ]}
      />
    </Page>
  );
}
