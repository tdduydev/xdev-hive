import { PrimitiveSwitch } from "@xdev-hive/ui";

export function States() {
  return (
    <div className="flex flex-col gap-1 p-4">
      <PrimitiveSwitch defaultChecked>Nhận thông báo khi run xong</PrimitiveSwitch>
      <PrimitiveSwitch>Tự giao task cho máy rảnh</PrimitiveSwitch>
      <PrimitiveSwitch defaultChecked disabled>Bật hàng đợi merge (do biến môi trường đặt)</PrimitiveSwitch>
      <PrimitiveSwitch disabled>Cho phép agent đọc secret</PrimitiveSwitch>
    </div>
  );
}

const PROFILES = [
  { id: "claude-4", hint: "Claude Code · mac-mini-01", on: true },
  { id: "codex-2", hint: "Codex CLI · hc-duytd20-linux", on: true },
  { id: "claude-1", hint: "Claude Code · mac-mini-01 · hết quota tuần", on: false },
];

// A cosmic settings panel: one switch per agent profile, the label carries the profile and where it runs.
export function SettingsPanel() {
  return (
    <div className="p-4">
      <div className="flex max-w-md flex-col gap-1 rounded-[24px] bg-card p-5 shadow-[var(--ring-glass)]">
        <h3 className="m-0 mb-1 type-heading-sm text-fg-strong">Gói agent nhận task</h3>
        {PROFILES.map((p) => (
          <PrimitiveSwitch key={p.id} defaultChecked={p.on} name={`profile-${p.id}`}>
            <span className="flex flex-col">
              <span className="font-mono">{p.id}</span>
              <span className="text-xs font-normal text-fg-muted">{p.hint}</span>
            </span>
          </PrimitiveSwitch>
        ))}
      </div>
    </div>
  );
}
