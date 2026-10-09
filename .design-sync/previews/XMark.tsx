import { Card, CardDescription, CardHeader, CardTitle, XMark } from "@xdev-hive/ui";
import { FolderGit2, LayoutDashboard, ListTodo, Server } from "lucide-react";

export function Sizes() {
  return (
    <div className="flex items-end gap-6 p-4">
      {[22, 30, 48].map((s) => (
        <div key={s} className="flex flex-col items-center gap-2">
          <XMark size={s} />
          <span className="font-mono text-xs text-fg-muted">size={s}</span>
        </div>
      ))}
    </div>
  );
}

// The collapsed icon rail: no room for the wordmark, so the X sits on top (ClientShell uses size 24).
export function InIconRail() {
  return (
    <div className="p-4">
      <div className="flex w-16 flex-col items-center gap-2 rounded-lg border border-line-subtle bg-surface py-3">
        <div className="grid size-10 place-items-center"><XMark size={24} /></div>
        {[LayoutDashboard, ListTodo, Server, FolderGit2].map((Icon, i) => (
          <div key={i} className="grid size-10 place-items-center rounded-md text-fg-secondary"><Icon className="size-4" aria-hidden="true" /></div>
        ))}
      </div>
    </div>
  );
}

// Ported from Account.tsx: the X beside a card title.
export function BesideTitle() {
  return (
    <div className="max-w-sm p-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl"><XMark size={26} />Đặt mật khẩu mới</CardTitle>
          <CardDescription>Chào Duy. Bạn đang dùng mật khẩu tạm do admin cấp: đặt mật khẩu của riêng bạn để tiếp tục.</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
