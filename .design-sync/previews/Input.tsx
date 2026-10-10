import { Input, Label } from "@xdev-hive/ui";
import { FolderGit2, Search } from "lucide-react";

export function Basic() {
  return (
    <div className="flex max-w-sm flex-col gap-4 p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="in-title">Tiêu đề task</Label>
        <Input id="in-title" defaultValue="Thêm bộ lọc theo máy cho trang Lượt chạy" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="in-branch">Branch</Label>
        <Input id="in-branch" placeholder="vd. ai/R-73a" />
      </div>
    </div>
  );
}

export function Sizes() {
  return (
    <div className="flex max-w-sm flex-col gap-3 p-4">
      <Input controlSize="sm" defaultValue="claude-4" aria-label="Gói agent (sm)" />
      <Input controlSize="md" defaultValue="codex-2" aria-label="Gói agent (md)" />
      <Input controlSize="lg" defaultValue="hc-duytd20-linux" aria-label="Máy (lg)" />
    </div>
  );
}

// icon/trailing switch the input into the cosmic-input-group wrapper (the glass ring moves to the wrapper).
export function WithIcon() {
  return (
    <div className="flex max-w-sm flex-col gap-4 p-4">
      <Input
        aria-label="Tìm"
        placeholder="Tìm task, tài liệu, run…"
        icon={<Search className="size-4 shrink-0 text-fg-muted" />}
        trailing={<kbd className="rounded-xs border border-line-default bg-surface px-1.5 py-0.5 font-mono text-[10px] font-medium text-fg-secondary">⌘K</kbd>}
      />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="in-project">Mã dự án</Label>
        <Input id="in-project" defaultValue="ehospital-ai" icon={<FolderGit2 className="size-4 shrink-0 text-fg-muted" />} />
      </div>
    </div>
  );
}

export function States() {
  return (
    <div className="flex max-w-sm flex-col gap-4 p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="in-pass">Nhập lại mật khẩu</Label>
        <Input id="in-pass" type="password" defaultValue="khongkhop" aria-invalid />
        <p className="m-0 text-xs text-danger">Hai mật khẩu chưa khớp.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="in-hub">Địa chỉ hub</Label>
        <Input id="in-hub" defaultValue="https://hive.xdev.asia" disabled />
      </div>
    </div>
  );
}
