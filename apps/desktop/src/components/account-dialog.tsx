import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Label } from "@xdev-hive/ui/label";
import { type FormEvent, useId, useState } from "react";
import { type AccountStatus, linkAccount, unlinkAccount } from "@/lib/account.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  title: string;
  lead: string;
  noHub: string;
  token: string;
  howTo: string;
  link: string;
  linking: string;
  close: string;
  linkedAs: (name: string, org: string) => string;
  unlink: string;
  role: string;
  orgRoles: Record<"owner" | "admin" | "member", string>;
  teamRoles: Record<"admin" | "member" | "viewer", string>;
  noTeams: string;
  broken: string;
}> = {
  vi: {
    title: "Tài khoản",
    lead: "Liên kết tài khoản hub để app biết bạn là ai: menu theo quyền, tài liệu và skill của đội bạn.",
    noHub: "Máy chưa đăng ký với hub nào. Đăng ký máy trước rồi mới liên kết tài khoản.",
    token: "Token MCP cá nhân",
    howTo:
      "Tạo ở web: MCP và công cụ → Token MCP → Tạo token. Token lưu trong keychain của máy, không ghi ra file và không gửi đi đâu ngoài hub.",
    link: "Liên kết",
    linking: "Đang kiểm token…",
    close: "Đóng",
    linkedAs: (name, org) => `Đang dùng tài khoản ${name} ở ${org}.`,
    unlink: "Gỡ liên kết",
    role: "Vai trò",
    orgRoles: { owner: "Chủ sở hữu", admin: "Quản trị", member: "Thành viên" },
    teamRoles: { admin: "Quản trị đội", member: "Thành viên", viewer: "Chỉ xem" },
    noTeams: "Chưa ở đội nào.",
    broken: "Token đã lưu không dùng được nữa:",
  },
  en: {
    title: "Account",
    lead: "Link your hub account so the app knows who you are: menus by permission, your team's docs and skills.",
    noHub: "This machine is not registered with a hub yet. Register it first, then link your account.",
    token: "Personal MCP token",
    howTo:
      "Create one on the web: MCP & tools → MCP tokens → Create token. The token stays in this machine's keychain, never in a file, and goes nowhere but the hub.",
    link: "Link",
    linking: "Checking the token…",
    close: "Close",
    linkedAs: (name, org) => `Using ${name}'s account in ${org}.`,
    unlink: "Unlink",
    role: "Role",
    orgRoles: { owner: "Owner", admin: "Admin", member: "Member" },
    teamRoles: { admin: "Team admin", member: "Member", viewer: "Viewer" },
    noTeams: "Not in any team yet.",
    broken: "The saved token no longer works:",
  },
};

/** Liên kết tài khoản người dùng bằng token MCP cá nhân (DESK-09). */
export function AccountDialog({
  open,
  status,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  status: AccountStatus | null;
  onOpenChange: (open: boolean) => void;
  onChanged: (status: AccountStatus) => void;
}) {
  const t = useT(text);
  const id = useId();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = status?.account ?? null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onChanged(await linkAccount(token));
      setToken("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    try {
      onChanged(await unlinkAccount());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.lead}</DialogDescription>
        </DialogHeader>
        {!status?.hub ? (
          <p className="text-[13px] text-muted-foreground">{t.noHub}</p>
        ) : account ? (
          <div className="flex flex-col gap-2 text-[13px]">
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
        ) : (
          <form id={`${id}-form`} onSubmit={submit} className="flex flex-col gap-2">
            {status.linked && status.error && (
              <p role="alert" className="rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning">
                {t.broken} {status.error}
              </p>
            )}
            <Label htmlFor={`${id}-token`}>{t.token}</Label>
            <Input
              id={`${id}-token`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="hive_pat_…"
              className="font-mono text-[13px] md:text-[13px]"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t.howTo}</p>
          </form>
        )}
        {error && (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        )}
        <DialogActions>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.close}
          </Button>
          {status?.hub && (account || status.linked) && (
            <Button variant="outline" disabled={busy} onClick={unlink}>
              {t.unlink}
            </Button>
          )}
          {status?.hub && !account && (
            <Button type="submit" form={`${id}-form`} disabled={busy || !token.trim()}>
              {busy ? t.linking : t.link}
            </Button>
          )}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
