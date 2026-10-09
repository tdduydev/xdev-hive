import { Badge, Button, ListRow, PrimitiveSwitch } from "@xdev-hive/ui";

export function Integrations() {
  return (
    <div className="grid max-w-xl gap-2 p-4">
      <ListRow title="GitHub" description="Đẩy branch ai/* và mở PR khi task sang review" action={<Button variant="outline" size="sm">Kết nối</Button>} />
      <ListRow title="Slack" description="Báo vào #xdev-hive khi run xong hoặc lỗi" action={<PrimitiveSwitch defaultChecked aria-label="Báo qua Slack" />} />
      <ListRow title="Cloudflare Tunnel" description="hive.example.com trỏ về hub trên máy .52" action={<Badge tone="green">Đang bật</Badge>} />
    </div>
  );
}

export function Profiles() {
  return (
    <div className="grid max-w-xl gap-2 p-4">
      <ListRow title="claude-1" description="Claude Code · mac-mini-01 · 3 run hôm nay" action={<Badge tone="blue">Đang chạy</Badge>} />
      <ListRow title="codex-2" description="Codex CLI · linux-runner · còn 8% quota tuần" action={<Badge tone="warning">Gần ngưỡng</Badge>} />
      <ListRow title="gemini-1" description="Gemini CLI · chưa đăng nhập trên máy nào" action={<Button size="sm">Đăng nhập</Button>} />
    </div>
  );
}

export function TitleOnly() {
  return (
    <div className="grid max-w-xl gap-2 p-4">
      <ListRow title="Tự giao task cho máy rảnh" action={<PrimitiveSwitch defaultChecked aria-label="Tự giao task" />} />
      <ListRow title="Cho phép agent đọc secret" action={<PrimitiveSwitch aria-label="Cho phép đọc secret" />} />
    </div>
  );
}
