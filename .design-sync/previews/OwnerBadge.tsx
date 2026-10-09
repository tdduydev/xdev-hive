import { CommonBadge, OwnerBadge, STATUS_TONE } from "@xdev-hive/ui";

// owner={null} renders the accent "Chung" (i18n common.shared); a key renders the mono outline badge.
export function SharedAndProject() {
  return (
    <div className="flex flex-wrap items-center gap-2 p-4">
      <OwnerBadge owner={null} />
      <OwnerBadge owner="xdev-hive" />
      <OwnerBadge owner="customer-ai" />
      <OwnerBadge owner="xdev-mindmap-ai-ios" />
    </div>
  );
}

const MEMORY = [
  { id: 1, owner: null, kind: "Quy ước", text: "Không bao giờ ghi secret, token hay mật khẩu vào memory.", author: "duythq", time: "02/10 09:12" },
  { id: 2, owner: "xdev-hive", kind: "Lưu ý", text: "Không có GitHub CI: chạy npm run typecheck và npm test tại máy trước khi merge.", author: "claude-1", time: "07/10 16:40" },
  { id: 3, owner: "customer-ai", kind: "Quyết định", text: "Danh mục thuốc đồng bộ từ HIS mỗi đêm lúc 02:00.", author: "codex-2", time: "03/10 11:05", pending: true },
];

// The Overview's memory list: owner + kind on top, the entry, then who wrote it and when.
export function MemoryList() {
  return (
    <div className="max-w-xl p-4">
      <ul className="m-0 flex list-none flex-col divide-y rounded-lg border border-line-default bg-surface p-4">
        {MEMORY.map((m) => (
          <li key={m.id} className="flex min-w-0 flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <OwnerBadge owner={m.owner} />
              <span className="text-xs text-muted-foreground">{m.kind}</span>
              {m.pending ? <CommonBadge tone={STATUS_TONE.pending}>Chờ duyệt</CommonBadge> : null}
            </div>
            <p className="m-0 text-sm break-words">{m.text}</p>
            <p className="m-0 text-xs text-muted-foreground">{m.author} · {m.time}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

// In a task card the project key sits at the right of the id, truncated when long.
export function OnTaskCards() {
  const tasks = [
    { id: "R-73a", project: "xdev-hive", title: "Runner đẩy ai/* lên remote, hub ghi SHA" },
    { id: "R-38e", project: "customer-ai", title: "Đồng bộ danh mục thuốc từ HIS" },
    { id: "M-12", project: "xdev-mindmap-ai-ios", title: "Xuất sơ đồ tư duy ra PNG" },
  ];
  return (
    <div className="grid max-w-xs gap-2 p-4">
      {tasks.map((t) => (
        <div key={t.id} className="flex flex-col gap-[7px] rounded-md border border-line-default bg-surface px-2.5 py-[9px]">
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]/none font-medium text-fg-muted">
            <span className="shrink-0">{t.id}</span>
            <OwnerBadge owner={t.project} className="ml-auto max-w-[60%] truncate" />
          </div>
          <span className="text-[13px]/[18px] font-medium text-fg-strong">{t.title}</span>
        </div>
      ))}
    </div>
  );
}
