import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Page, PageHeader, StatTile } from "@xdev-hive/ui";
import { Plus } from "lucide-react";

// Page pads itself with the gutter (24px), so the story needs no extra wrapper padding.
export function Standard() {
  return (
    <Page>
      <PageHeader
        title="Tổng quan"
        subtitle="Việc đang chạy, việc chờ bạn và các máy của dự án xdev-hive."
        actions={<Button variant="solid" size="sm"><Plus />Giao việc cho agent</Button>}
      />
      <div className="grid grid-cols-3 gap-4">
        <StatTile label="Run đang chạy" value="3" detail="trên 2 máy" />
        <StatTile label="Task chờ review" value="7" detail="lâu nhất 2 giờ · R-73a" />
        <StatTile label="Chi phí tuần" value="$42,80" detail="còn $57,20 trong ngân sách" />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Chờ bạn duyệt</CardTitle>
          <CardDescription>Agent đã xong và đẩy branch lên remote.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col">
          {[
            { id: "R-73a", title: "Runner đẩy ai/* lên remote, hub ghi SHA", who: "claude-1" },
            { id: "BUG-windows-cli", title: "App Windows không chạy được CLI cài bằng npm", who: "codex-2" },
          ].map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3 border-b border-line-subtle py-2.5 last:border-b-0">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-fg-strong">{t.title}</span>
                <span className="font-mono text-xs text-fg-muted">{t.id} · {t.who}</span>
              </div>
              <Badge tone="warning">Chờ review</Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </Page>
  );
}

// wide drops the content max width, for boards and wide tables.
export function Wide() {
  return (
    <Page wide>
      <PageHeader title="Bảng task" subtitle="Task của xdev-hive theo trạng thái. Kéo task sang cột khác để đổi trạng thái." />
      <div className="grid grid-cols-3 gap-4">
        {[
          { col: "Cần làm", n: 4 },
          { col: "Đang làm", n: 2 },
          { col: "Chờ review", n: 7 },
        ].map((c) => (
          <Card key={c.col}>
            <CardHeader>
              <CardTitle>{c.col}</CardTitle>
              <CardDescription>{c.n} task</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </Page>
  );
}
