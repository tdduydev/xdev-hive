import { useState } from "react";
import { ChevronsUpDown, KeyRound, LogOut } from "lucide-react";
import { LEVEL_LABEL, type Me, type Role } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@xdev-hive/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@xdev-hive/ui/components/ui/dropdown-menu";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@xdev-hive/ui/components/ui/sidebar";
import type { HiveClient } from "../client.ts";
import { useAction } from "../hooks.ts";
import { useSystemTheme } from "../lib/theme.ts";
import { Badge, ErrorNote, HiveLogo, Notice, STATUS_TONE } from "./common.tsx";

export const MIN_PASSWORD = 10;

export const ROLE_LABEL: Record<Role, string> = { viewer: "chỉ xem", agent: "agent", member: "thành viên", admin: "admin" };

/** Current + new password (twice). The hub checks the rules again. */
export function PasswordForm({ onSubmit, submitLabel }: { onSubmit: (current: string, next: string) => Promise<unknown>; submitLabel: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const action = useAction();
  const problem =
    next && next.length < MIN_PASSWORD
      ? `Mật khẩu mới cần ít nhất ${MIN_PASSWORD} ký tự.`
      : again && next !== again
        ? "Hai lần nhập mật khẩu mới chưa khớp."
        : null;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem || !current || !next || next !== again) return;
        void action.run(() => onSubmit(current, next));
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="pw-current">Mật khẩu hiện tại</Label>
        <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="pw-next">Mật khẩu mới</Label>
        <Input id="pw-next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="pw-again">Nhập lại mật khẩu mới</Label>
        <Input id="pw-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </div>
      <p className="text-xs text-muted-foreground">Ít nhất {MIN_PASSWORD} ký tự, không chứa tên đăng nhập. Đổi xong, các trình duyệt khác đang đăng nhập sẽ bị đăng xuất.</p>
      <ErrorNote error={problem ?? action.error} />
      <Button type="submit" disabled={Boolean(problem) || !current || !next || next !== again || action.busy}>
        {action.busy ? "Đang lưu…" : submitLabel}
      </Button>
    </form>
  );
}

/** First sign-in with a temporary password: nothing else is reachable until it is changed. */
export function ChangePasswordScreen({ client, me, onDone, onSignOut }: { client: HiveClient; me: Me; onDone: () => void; onSignOut?: () => void }) {
  useSystemTheme();
  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <HiveLogo size={26} />
            Đặt mật khẩu mới
          </CardTitle>
          <CardDescription>
            Chào {me.user?.displayName ?? me.name}. Bạn đang dùng mật khẩu tạm do admin cấp: đặt mật khẩu của riêng bạn để tiếp tục.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <PasswordForm
            submitLabel="Lưu và vào hub"
            onSubmit={async (current, next) => {
              await client.account!.changePassword(current, next);
              onDone();
            }}
          />
          {onSignOut ? (
            <Button variant="ghost" size="sm" onClick={onSignOut}>
              Đăng xuất
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

/** Sidebar footer: who is signed in, what they may see, change password, sign out. */
export function AccountMenu({ client, me, onSignOut }: { client: HiveClient; me: Me; onSignOut?: () => void }) {
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState(false);
  const grants = Object.entries(me.access?.projects ?? {});
  const where = me.mode === "hub" ? "Hub dùng chung" : "Cục bộ trên máy này";
  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton size="lg" tooltip={me.user?.displayName ?? me.name} className="data-[state=open]:bg-sidebar-accent">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-soft text-sm font-semibold text-brand-soft-foreground uppercase">
                  {(me.user?.displayName ?? me.name).slice(0, 1)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
                  <span className="truncate font-medium">{me.user?.displayName ?? me.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {me.user ? `@${me.user.username}` : where} · {ROLE_LABEL[me.role]}
                  </span>
                </span>
                <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-64">
              <DropdownMenuLabel className="flex flex-col gap-1.5 font-normal">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{me.user?.displayName ?? me.name}</span>
                  <Badge tone={STATUS_TONE[me.role]}>{ROLE_LABEL[me.role]}</Badge>
                </span>
                <span className="text-xs text-muted-foreground">{where}</span>
                {me.access ? (
                  <span className="flex flex-wrap gap-1 pt-1">
                    {grants.length ? (
                      grants.map(([p, l]) => (
                        <Badge key={p} tone="neutral" className="font-mono text-[11px]">
                          {p} · {LEVEL_LABEL[l]}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">Chưa được cấp dự án nào: chỉ thấy dữ liệu Chung.</span>
                    )}
                  </span>
                ) : me.mode === "hub" && me.role === "admin" ? (
                  <span className="text-xs text-muted-foreground">Admin: thấy và quản trị mọi dự án.</span>
                ) : null}
              </DropdownMenuLabel>
              {client.account || onSignOut ? <DropdownMenuSeparator /> : null}
              {client.account ? (
                <DropdownMenuItem onSelect={() => setChanging(true)}>
                  <KeyRound />
                  Đổi mật khẩu
                </DropdownMenuItem>
              ) : null}
              {onSignOut ? (
                <DropdownMenuItem onSelect={onSignOut}>
                  <LogOut />
                  Đăng xuất
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      <Dialog
        open={changing}
        onOpenChange={(open) => {
          setChanging(open);
          if (!open) setChanged(false);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Đổi mật khẩu</DialogTitle>
            <DialogDescription>Tài khoản {me.user?.username}</DialogDescription>
          </DialogHeader>
          {changed ? (
            <Notice tone="ok" title="Đã đổi mật khẩu." />
          ) : (
            <PasswordForm
              submitLabel="Đổi mật khẩu"
              onSubmit={async (current, next) => {
                await client.account!.changePassword(current, next);
                setChanged(true);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
