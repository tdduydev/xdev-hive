import { Badge, Button, Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, StatusDot } from "@xdev-hive/ui";
import { Plus, RefreshCw } from "lucide-react";

const PROFILES = [
  { id: "claude-1", tone: "running", state: "đang chạy R-72n" },
  { id: "codex-2", tone: "running", state: "đang chạy R-73a" },
  { id: "claude-4", tone: "ok", state: "rảnh" },
  { id: "codex-1", tone: "warn", state: "nghỉ đến 14:30" },
];

export function MachineCard() {
  return (
    <div className="max-w-md p-4">
      <Card>
        <CardHeader>
          <CardTitle>mac-mini-01</CardTitle>
          <CardDescription>macOS 27 · app 0.138.0 · 2 run đang chạy</CardDescription>
          <CardAction><Badge tone="green">Trực tuyến</Badge></CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {PROFILES.map((p) => (
            <div key={p.id} className="flex items-center gap-2 type-body-sm">
              <StatusDot tone={p.tone} />
              <span className="font-mono text-fg-strong">{p.id}</span>
              <span className="text-fg-muted">{p.state}</span>
            </div>
          ))}
        </CardContent>
        <CardFooter className="gap-2 border-t">
          <Button variant="outline" size="xs"><RefreshCw />Đọc lại quota</Button>
          <Button variant="ghost" size="xs">Xem lượt chạy</Button>
        </CardFooter>
      </Card>
    </div>
  );
}

// border-b on the header draws the divider; CardAction holds the corner button.
export function WithDivider() {
  return (
    <div className="max-w-xl p-4">
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Máy chạy agent</CardTitle>
          <CardDescription>2 trực tuyến · 1 ngoại tuyến</CardDescription>
          <CardAction><Button variant="outline" size="sm"><Plus />Thêm máy</Button></CardAction>
        </CardHeader>
        <CardContent className="flex flex-col">
          {[
            { name: "mac-mini-01", os: "macOS 27", tone: "green" as const, label: "Trực tuyến" },
            { name: "hc-duytd20-linux", os: "Ubuntu 24.04", tone: "green" as const, label: "Trực tuyến" },
            { name: "win-qa-02", os: "Windows 11", tone: "neutral" as const, label: "Ngoại tuyến" },
          ].map((m) => (
            <div key={m.name} className="flex items-center justify-between gap-3 border-b border-line-subtle py-2.5 last:border-b-0">
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-sm text-fg-strong">{m.name}</span>
                <span className="text-xs text-fg-muted">{m.os}</span>
              </div>
              <Badge tone={m.tone}>{m.label}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function TextOnly() {
  return (
    <div className="max-w-md p-4">
      <Card>
        <CardHeader>
          <CardTitle>Agent phụ trách</CardTitle>
          <CardDescription>Task chưa gán sẽ đi tới máy rảnh đầu tiên có gói phù hợp.</CardDescription>
        </CardHeader>
        <CardContent className="type-body-sm text-fg-secondary">
          R-73a đang chờ ở vị trí 2 trong hàng của hc-duytd20-linux. Gán cho codex-2 để chạy ngay khi máy rảnh.
        </CardContent>
      </Card>
    </div>
  );
}
