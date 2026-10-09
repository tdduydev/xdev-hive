import { ListRow, Badge, ScrollArea, ScrollBar } from "@xdev-hive/ui";

const LOG = [
  "14:02:11  run R-73a nhận bởi claude-1 trên mac-mini-01",
  "14:02:12  git worktree add .worktrees/R-73a -b ai/R-73a origin/main",
  "14:02:14  memory_search \"runner push ai/* remote\" → 6 mục",
  "14:02:19  task_claim R-73a → ok",
  "14:03:40  sửa packages/core/src/runner/push.ts",
  "14:05:02  sửa packages/core/src/hub/tasks.ts (ghi branchSha)",
  "14:07:15  thêm packages/core/test/runner-push.test.ts",
  "14:09:31  npm run typecheck → 0 lỗi",
  "14:11:48  npm test → 598 passed, 0 failed",
  "14:12:03  git commit -m \"feat(runner): đẩy ai/* lên remote (R-73a)\"",
  "14:12:05  git push origin ai/R-73a → 3f9c2e1",
  "14:12:06  hub ghi SHA 3f9c2e1 cho R-73a",
  "14:12:07  memory_write \"runner đẩy branch trước khi báo review\"",
  "14:12:09  task_update R-73a → review",
  "14:12:10  run xong sau 10 phút 1 giây",
];

// type="always" keeps the thumb visible; the default "hover" only shows it under the pointer.
export function RunLog() {
  return (
    <div className="max-w-xl p-4">
      <ScrollArea type="always" className="h-48 rounded-lg border border-line-subtle bg-surface">
        <div className="flex flex-col gap-1 p-3 pr-4 font-mono text-xs text-fg-secondary">
          {LOG.map((line) => (
            <div key={line} className="whitespace-pre">{line}</div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

export function RunList() {
  const runs = [
    { id: "R-73a", who: "claude-1 · mac-mini-01", tone: "blue" as const, label: "Đang chạy" },
    { id: "R-72n", who: "codex-2 · hc-duytd20-linux", tone: "blue" as const, label: "Đang chạy" },
    { id: "BUG-windows-cli", who: "codex-1 · win-qa-02", tone: "green" as const, label: "Thành công" },
    { id: "R-41c", who: "claude-4 · mac-mini-01", tone: "danger" as const, label: "Lỗi" },
    { id: "R-54b", who: "codex-2 · hc-duytd20-linux", tone: "green" as const, label: "Thành công" },
    { id: "QA-9", who: "claude-1 · mac-mini-01", tone: "neutral" as const, label: "Đã huỷ" },
  ];
  return (
    <div className="max-w-md p-4">
      <ScrollArea type="always" className="h-48 rounded-lg border border-line-subtle">
        <div className="flex flex-col gap-2 p-3 pr-4">
          {runs.map((r) => (
            <ListRow key={r.id} title={r.id} description={r.who} action={<Badge tone={r.tone}>{r.label}</Badge>} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

// Wide content scrolls sideways with a horizontal ScrollBar inside the area.
export function Horizontal() {
  const machines = ["mac-mini-01", "hc-duytd20-linux", "win-qa-02", "mac-studio-02", "ubuntu-ci-03", "win-build-04"];
  return (
    <div className="max-w-md p-4">
      <ScrollArea type="always" className="w-full rounded-lg border border-line-subtle">
        <div className="flex w-fit gap-3 p-3 pb-4">
          {machines.map((m) => (
            <div key={m} className="flex w-40 flex-col gap-1 rounded-md border border-line-subtle bg-surface p-3">
              <span className="truncate font-mono text-sm text-fg-strong">{m}</span>
              <span className="text-xs text-fg-muted">2 gói · app 0.152.0</span>
            </div>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}
