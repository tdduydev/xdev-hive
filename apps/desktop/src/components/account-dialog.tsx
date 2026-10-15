import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { useState } from "react";
import { ConnectForm } from "@/components/connect-form.tsx";
import { type AccountStatus, accountStatus } from "@/lib/account.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  title: string;
  lead: string;
  local: string;
  close: string;
  linkedAs: (name: string, org: string) => string;
  unlink: string;
  role: string;
  orgRoles: Record<"owner" | "admin" | "member", string>;
  teamRoles: Record<"admin" | "member" | "viewer" | "ba", string>;
  noTeams: string;
  broken: string;
}> = {
  vi: {
    title: "Tài khoản",
    lead: "Đăng nhập Hive để dùng việc, duyệt, tài liệu và skill của đội bạn.",
    local:
      "Không đăng nhập vẫn dùng được các mục trên máy: gói agent, dự án, môi trường, skills, token và tài liệu từ code.",
    close: "Đóng",
    linkedAs: (name, org) => `Đang dùng tài khoản ${name} ở ${org}.`,
    unlink: "Đăng xuất",
    role: "Vai trò",
    orgRoles: { owner: "Chủ sở hữu", admin: "Quản trị", member: "Thành viên" },
    teamRoles: { admin: "Quản trị đội", member: "Thành viên", viewer: "Chỉ xem", ba: "BA/PO" },
    noTeams: "Chưa ở đội nào.",
    broken: "Token đã lưu không dùng được nữa:",
  },
  en: {
    title: "Account",
    lead: "Sign in to Hive to use your team's work, reviews, docs and skills.",
    local:
      "Everything on this machine works without signing in: agent plans, projects, environment, skills, tokens and docs from code.",
    close: "Close",
    linkedAs: (name, org) => `Using ${name}'s account in ${org}.`,
    unlink: "Sign out",
    role: "Role",
    orgRoles: { owner: "Owner", admin: "Admin", member: "Member" },
    teamRoles: { admin: "Team admin", member: "Member", viewer: "Viewer", ba: "BA/PO" },
    noTeams: "Not in any team yet.",
    broken: "The saved token no longer works:",
  },
};

/**
 * Đăng nhập Hive, tuỳ chọn (DESK-09). Luôn có ô địa chỉ hub (ConnectForm): máy chưa đăng ký thì kết nối máy ngay tại
 * đây, đã đăng ký thì đăng nhập lại bằng trình duyệt hay token MCP cá nhân, và đổi được địa chỉ khi hub dời chỗ. Đăng
 * xuất (SignOutDialog) chỉ gỡ token cá nhân; máy vẫn đăng ký và worker vẫn nhận việc.
 */
export function AccountDialog({
  open,
  status,
  onOpenChange,
  onChanged,
  onSignOut,
}: {
  open: boolean;
  status: AccountStatus | null;
  onOpenChange: (open: boolean) => void;
  onChanged: (status: AccountStatus) => void;
  /** Mở hộp hỏi lại đăng xuất (AppShell): đăng xuất ở đây hay ở thẻ người dùng đều qua cùng một bước xác nhận. */
  onSignOut: () => void;
}) {
  const t = useT(text);
  const [error, setError] = useState<string | null>(null);
  const account = status?.account ?? null;

  function done(next?: AccountStatus) {
    setError(null);
    if (next) return onChanged(next);
    void accountStatus()
      .then(onChanged)
      .catch((e: unknown) => setError(errorText(e)));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.lead}</DialogDescription>
        </DialogHeader>
        {!account && <p className="text-xs text-muted-foreground">{t.local}</p>}
        {account && (
          <div className="flex flex-col gap-2 text-sm">
            <p>{t.linkedAs(account.name || account.email, account.orgName)}</p>
            <p className="text-muted-foreground">
              {t.role}: {account.orgRole ? t.orgRoles[account.orgRole] : "—"}
            </p>
            {account.teams.length === 0 ? (
              <p className="text-muted-foreground">{t.noTeams}</p>
            ) : (
              <ul className="list-disc pl-5">
                {account.teams.map((team) => (
                  <li key={team.id}>
                    {team.name}: {t.teamRoles[team.role]}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {!account && status?.linked && status.error && (
          <p role="alert" className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
            {t.broken} {status.error}
          </p>
        )}
        {/* Chưa đọc được trạng thái (lỗi, ngoài Tauri) vẫn cho nhập địa chỉ để có lối kết nối. */}
        <ConnectForm current={status?.hub ?? null} linked={!!account} onDone={done} />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogActions>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.close}
          </Button>
          {status?.hub && (account || status.linked) && (
            <Button variant="outline" onClick={onSignOut}>
              {t.unlink}
            </Button>
          )}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
