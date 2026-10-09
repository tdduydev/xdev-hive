import { StatusDot } from "@xdev-hive/ui";

const TONES = [
  { tone: "ok", profile: "claude-1", label: "sẵn sàng" },
  { tone: "running", profile: "codex-2", label: "đang chạy" },
  { tone: "warn", profile: "claude-2", label: "nghỉ đến 14:30" },
  { tone: "danger", profile: "codex-1", label: "chưa đăng nhập" },
  { tone: "neutral", profile: "gemini-1", label: "tắt" },
];

export function Tones() {
  return (
    <div className="flex flex-col gap-2 p-4">
      {TONES.map(({ tone, profile, label }) => (
        <span key={tone} className="inline-flex items-center gap-1.5">
          <StatusDot tone={tone} />
          <span className="font-mono text-xs">{profile}</span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </span>
      ))}
    </div>
  );
}

export function InlineWithName() {
  return (
    <div className="flex flex-wrap items-center gap-4 p-4 type-body-sm text-fg-primary">
      <span className="inline-flex items-center gap-2"><StatusDot tone="ok" />mac-mini-01</span>
      <span className="inline-flex items-center gap-2"><StatusDot tone="neutral" />linux-runner</span>
      <span className="inline-flex items-center gap-2">
        <StatusDot tone="info" className="animate-pulse motion-reduce:animate-none" />Leader đang trả lời
      </span>
    </div>
  );
}
