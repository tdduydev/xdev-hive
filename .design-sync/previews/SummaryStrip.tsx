import { SummaryStrip } from "@xdev-hive/ui";

// Only the abnormal number gets a tone.
export function ProjectOverview() {
  return (
    <div className="p-4">
      <SummaryStrip
        label="Tổng quan dự án xdev-hive"
        items={[
          { id: "doing", label: "Đang làm", value: 7, href: "#/board?status=doing" },
          { id: "review", label: "Chờ review", value: 3, sub: "lâu nhất 2 giờ · R-73a", href: "#/board?status=review" },
          { id: "blocked", label: "Bị chặn", value: 1, sub: "BUG-windows-cli", tone: "danger", href: "#/board?status=blocked" },
        ]}
      />
    </div>
  );
}

export function Runs() {
  return (
    <div className="p-4">
      <SummaryStrip
        label="Lượt chạy hôm nay"
        items={[
          { id: "running", label: "Đang chạy", value: 3, sub: "trên 2 máy", href: "#/runs?status=running" },
          { id: "queued", label: "Đang chờ", value: 5, href: "#/runs?status=queued" },
          { id: "rate_limited", label: "Hết quota", value: 2, sub: "codex-1, codex-2", tone: "warning", href: "#/runs?status=rate_limited" },
          { id: "failed", label: "Lỗi", value: 4, sub: "3 trên win-qa-02", tone: "danger", href: "#/runs?status=failed" },
        ]}
      />
    </div>
  );
}

// A calm page: no tones at all.
export function Calm() {
  return (
    <div className="p-4">
      <SummaryStrip
        label="Máy và agent"
        items={[
          { id: "online", label: "Máy trực tuyến", value: "2 / 3", href: "#/machines?state=online" },
          { id: "agents", label: "Agent rảnh", value: 4, sub: "claude-4, codex-3, …", href: "#/agents?state=idle" },
        ]}
      />
    </div>
  );
}
