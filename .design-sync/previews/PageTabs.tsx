import { CommonBadge, ListRow, PageHeader, PageTabs } from "@xdev-hive/ui";

// Tab ids and labels are the hub's own (Sections.tsx + i18n): sections.machines.*, sections.admin.*, knowledge.*.
const MACHINES = { quota: "Quota", map: "Bản đồ agent", fleet: "Đội máy", queue: "Hàng đợi", costs: "Chi phí" } as const;
const ADMIN = {
  ops: "Tổng quan vận hành",
  users: "Người dùng & quyền",
  policy: "Chính sách",
  tools: "Tool",
  budgets: "Ngân sách",
  alerts: "Cảnh báo",
  audit: "Nhật ký",
  webhooks: "Thông báo & webhook",
  versions: "Phiên bản app",
  hub: "Hub",
} as const;

export function KnowledgeTabs() {
  return (
    <PageTabs
      page="docs"
      tabs={["content", "pending"] as const}
      current="content"
      label="Các phần của trang"
      name={(id) => ({ content: "Nội dung", pending: "Chờ duyệt" })[id]}
    >
      <div className="flex flex-col gap-3 px-4 py-4 md:px-6">
        <ListRow title="AGENTS.md" description="Quy ước cho mọi coding agent · bản 14 · sửa 08/10" />
        <ListRow title="docs/roadmap.md" description="Lộ trình tính năng · bản 73 · sửa 09/10" />
      </div>
    </PageTabs>
  );
}

export function MachineTabs() {
  return (
    <PageTabs
      page="machines"
      tabs={Object.keys(MACHINES) as Array<keyof typeof MACHINES>}
      current="fleet"
      label="Các phần của trang"
      name={(id) => MACHINES[id]}
    >
      <div className="flex flex-col gap-4 px-4 py-4 md:px-6">
        <PageHeader title="Đội máy" subtitle="Máy đã nối với hub, phiên bản app và gói agent của từng máy." />
        <div className="flex flex-wrap gap-2">
          <CommonBadge tone="ok">mac-mini-01 · online</CommonBadge>
          <CommonBadge tone="ok">hc-duytd20-linux · online</CommonBadge>
          <CommonBadge tone="neutral">win-qa-02 · offline</CommonBadge>
        </div>
      </div>
    </PageTabs>
  );
}

// Ten admin tabs overflow the card width: the bar scrolls sideways instead of wrapping.
export function AdminTabsOverflow() {
  return (
    <PageTabs
      page="admin"
      tabs={Object.keys(ADMIN) as Array<keyof typeof ADMIN>}
      current="budgets"
      label="Các phần của trang"
      name={(id) => ADMIN[id]}
    >
      <div className="px-4 py-4 type-body-sm text-fg-secondary md:px-6">
        Ngân sách tháng 10: đã dùng 62% của hạn mức cho xdev-hive.
      </div>
    </PageTabs>
  );
}

// A single tab is no choice, so the bar is not drawn: only the page shows.
export function SingleTab() {
  return (
    <PageTabs page="skills" tabs={["content"] as const} current="content" label="Các phần của trang" name={() => "Nội dung"}>
      <div className="flex flex-col gap-3 px-4 py-4 md:px-6">
        <ListRow title="hive-leader" description="Cách làm leader của một dự án trong trang Chat của xDev Hive" />
      </div>
    </PageTabs>
  );
}
