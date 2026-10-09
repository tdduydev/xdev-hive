import { Label, Switch } from "@xdev-hive/ui";

export function States() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Switch id="sw-on" defaultChecked />
        <Label htmlFor="sw-on" className="font-normal">Tự giao task cho máy rảnh</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="sw-off" />
        <Label htmlFor="sw-off" className="font-normal">Nhận run từ hub</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="sw-dis-on" defaultChecked disabled />
        <Label htmlFor="sw-dis-on" className="font-normal">Tự tải bản mới (do admin khoá)</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="sw-dis-off" disabled />
        <Label htmlFor="sw-dis-off" className="font-normal">Máy gác cổng merge</Label>
      </div>
    </div>
  );
}

export function Sizes() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Switch id="sw-sm" size="sm" defaultChecked />
        <Label htmlFor="sw-sm" className="font-normal">Nhỏ (sm), dùng trong bảng</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="sw-md" defaultChecked />
        <Label htmlFor="sw-md" className="font-normal">Mặc định, dùng trong form</Label>
      </div>
    </div>
  );
}

const PROFILES = [
  { id: "claude-4", on: true, note: "Ưu tiên 1" },
  { id: "codex-2", on: true, note: "Ưu tiên 2" },
  { id: "claude-1", on: false, note: "Đang chờ máy báo lại · duytd20 yêu cầu lúc 09:12" },
];

// Agent map profile list: the switch is labelled by aria-label, the profile id sits beside it in mono.
export function ProfileList() {
  return (
    <div className="p-4">
      <div className="flex max-w-md flex-col gap-1.5 rounded-md border border-dashed border-line-default p-2">
        {PROFILES.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Switch defaultChecked={p.on} aria-label={`Bật gói ${p.id}`} />
            <span className="min-w-20 font-mono text-xs">{p.id}</span>
            <span className={p.on ? "text-xs text-fg-muted" : "text-xs text-warning"}>{p.note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
