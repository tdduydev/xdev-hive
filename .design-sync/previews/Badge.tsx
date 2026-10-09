import { Badge } from "@xdev-hive/ui";
import { GitBranch, Timer } from "lucide-react";

// The dot carries the tone; the pill itself stays glass, so a row of badges reads calm.
export function Tones() {
  return (
    <div className="flex flex-wrap items-center gap-2 p-4">
      <Badge tone="green">Trực tuyến</Badge>
      <Badge tone="blue">Đang chạy</Badge>
      <Badge tone="violet">Leader</Badge>
      <Badge tone="warning">Gần ngưỡng quota</Badge>
      <Badge tone="danger">Lỗi</Badge>
      <Badge>Ngoại tuyến</Badge>
    </div>
  );
}

export function Variants() {
  return (
    <div className="flex flex-wrap items-center gap-2 p-4">
      <Badge variant="default" tone="green">Xong</Badge>
      <Badge variant="secondary">Đã huỷ</Badge>
      <Badge variant="destructive" tone="danger">Lỗi</Badge>
      <Badge variant="outline">0.138.0</Badge>
      <Badge variant="ghost">claude-1</Badge>
      <Badge variant="link" dot={false}>Xem lượt chạy</Badge>
    </div>
  );
}

// dot={false} for a plain label; an icon takes the dot's place.
export function WithIcons() {
  return (
    <div className="flex flex-wrap items-center gap-2 p-4">
      <Badge dot={false}><GitBranch />ai/R-73a</Badge>
      <Badge dot={false}><Timer />12 phút</Badge>
      <Badge dot={false} variant="outline">macOS 27</Badge>
    </div>
  );
}

export function BesideTitle() {
  return (
    <div className="flex flex-col gap-3 p-4">
      {[
        { name: "mac-mini-01", tone: "green" as const, label: "Trực tuyến", meta: "3 run đang chạy" },
        { name: "linux-runner", tone: "warning" as const, label: "Gần ngưỡng quota", meta: "codex-2 còn 8% tuần" },
        { name: "win-qa-02", tone: "neutral" as const, label: "Ngoại tuyến", meta: "lần cuối 4 ngày trước" },
      ].map((m) => (
        <div key={m.name} className="flex items-center gap-2">
          <span className="font-mono text-sm text-fg-strong">{m.name}</span>
          <Badge tone={m.tone}>{m.label}</Badge>
          <span className="text-xs text-fg-muted">{m.meta}</span>
        </div>
      ))}
    </div>
  );
}
