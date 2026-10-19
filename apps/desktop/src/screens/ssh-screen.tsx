import { Alert, AlertDescription, AlertTitle } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import { CopyIcon, KeyRoundIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { SshAddDialog } from "@/components/ssh-add-dialog.tsx";
import { SshPasswordOffDialog } from "@/components/ssh-password-off-dialog.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import {
  SSH_STATUS_TEXT,
  type SshCheck,
  type SshHost,
  type SshList,
  type SshTarget,
  sshCheck,
  sshList,
  sshRemove,
  sshTone,
} from "@/lib/ssh.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  lead: string;
  add: string;
  checkAll: string;
  loading: string;
  noSshTitle: string;
  noSsh: string;
  keyTitle: string;
  noKey: (path: string) => string;
  encrypted: string;
  wsl: string;
  copyKey: string;
  copied: string;
  empty: string;
  colAlias: string;
  colServer: string;
  colKind: string;
  colStatus: string;
  managed: string;
  handWritten: string;
  checking: string;
  check: string;
  convert: string;
  reinstall: string;
  remove: string;
  passwordOff: string;
  proxyReason: string;
  keyReason: string;
  removeTitle: (alias: string) => string;
  removeLead: string;
  cancel: string;
  removedTitle: (alias: string) => string;
  removed: (comment: string, target: string) => string;
}> = {
  vi: {
    lead: "Chuyển đăng nhập SSH từ mật khẩu sang khoá. App chép khoá công khai lên máy chủ bằng mật khẩu bạn gõ một lần, rồi chỉ dùng khoá.",
    add: "Thêm máy chủ",
    checkAll: "Kiểm tra tất cả",
    loading: "Đang đọc ~/.ssh…",
    noSshTitle: "Máy chưa có OpenSSH client",
    noSsh:
      "Windows: Cài đặt → Hệ thống → Tính năng tuỳ chọn → thêm OpenSSH Client. macOS có sẵn. Linux: cài gói openssh-client.",
    keyTitle: "Khoá của máy",
    noKey: (path) => `Chưa có khoá ${path}. Lần cài khoá đầu tiên, app tạo khoá ed25519 không passphrase ở đó.`,
    encrypted: "Khoá có passphrase: ssh chỉ dùng được khi ssh-agent đã nạp khoá.",
    wsl: "WSL có ~/.ssh riêng. Muốn dùng khoá này trong WSL thì chép id_ed25519 và id_ed25519.pub sang ~/.ssh của WSL rồi chmod 600 ~/.ssh/id_ed25519.",
    copyKey: "Chép khoá công khai",
    copied: "Đã chép",
    empty: "Chưa có máy chủ nào trong ~/.ssh/config.",
    colAlias: "Tên gợi nhớ",
    colServer: "Máy chủ",
    colKind: "Loại",
    colStatus: "Trạng thái",
    managed: "Do app quản lý",
    handWritten: "Tự viết",
    checking: "Đang kiểm tra…",
    check: "Kiểm tra",
    convert: "Chuyển sang khoá",
    reinstall: "Cài lại khoá",
    remove: "Xoá",
    passwordOff: "Tắt đăng nhập bằng mật khẩu…",
    proxyReason: "Đi qua máy trung gian (ProxyJump): app chưa cài khoá được.",
    keyReason: "Khối này không dùng khoá của máy (IdentityFile khác hoặc tắt khoá). Thêm máy chủ mới do app quản lý.",
    removeTitle: (alias) => `Xoá ${alias} khỏi ~/.ssh/config?`,
    removeLead:
      "App sao lưu file trước khi sửa. Khoá công khai vẫn còn trên máy chủ, file khoá trên máy này giữ nguyên.",
    cancel: "Huỷ",
    removedTitle: (alias) => `Đã xoá ${alias} khỏi ~/.ssh/config`,
    removed: (comment, target) =>
      `Để thu hồi hẳn quyền vào máy chủ, xoá dòng có comment "${comment}" trong ~/.ssh/authorized_keys của ${target}.`,
  },
  en: {
    lead: "Move SSH sign-in from passwords to keys. The app copies the public key to the server with a password you type once, then uses only the key.",
    add: "Add server",
    checkAll: "Check all",
    loading: "Reading ~/.ssh…",
    noSshTitle: "This machine has no OpenSSH client",
    noSsh:
      "Windows: Settings → System → Optional features → add OpenSSH Client. macOS has it. Linux: install openssh-client.",
    keyTitle: "This machine's key",
    noKey: (path) => `No key at ${path} yet. The first install creates an ed25519 key there, without a passphrase.`,
    encrypted: "The key has a passphrase: ssh can only use it once ssh-agent has loaded it.",
    wsl: "WSL has its own ~/.ssh. To use this key in WSL, copy id_ed25519 and id_ed25519.pub into WSL's ~/.ssh, then chmod 600 ~/.ssh/id_ed25519.",
    copyKey: "Copy public key",
    copied: "Copied",
    empty: "No servers in ~/.ssh/config yet.",
    colAlias: "Alias",
    colServer: "Server",
    colKind: "Kind",
    colStatus: "Status",
    managed: "Managed by the app",
    handWritten: "Hand-written",
    checking: "Checking…",
    check: "Check",
    convert: "Switch to key",
    reinstall: "Reinstall key",
    remove: "Remove",
    passwordOff: "Turn off password sign-in…",
    proxyReason: "Goes through a jump host (ProxyJump): the app cannot install the key yet.",
    keyReason:
      "This block does not use this machine's key (another IdentityFile, or keys off). Add a new app-managed server.",
    removeTitle: (alias) => `Remove ${alias} from ~/.ssh/config?`,
    removeLead:
      "The app backs up the file first. The public key stays on the server and the key file on this machine is kept.",
    cancel: "Cancel",
    removedTitle: (alias) => `Removed ${alias} from ~/.ssh/config`,
    removed: (comment, target) =>
      `To fully revoke access, delete the line with comment "${comment}" from ~/.ssh/authorized_keys of ${target}.`,
  },
};

type CheckState = SshCheck | "checking";

const target = (h: SshHost): SshTarget => ({ host: h.hostName, port: h.port, user: h.user, alias: h.alias });

export function SshScreen() {
  const t = useT(text);
  const statusText = useT(SSH_STATUS_TEXT);
  const [list, setList] = useState<SshList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [adding, setAdding] = useState<{ initial: SshTarget | null } | null>(null);
  const [removing, setRemoving] = useState<SshHost | null>(null);
  const [removed, setRemoved] = useState<SshHost | null>(null);
  const [passwordOff, setPasswordOff] = useState<SshHost | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const check = useCallback(async (alias: string) => {
    setChecks((c) => ({ ...c, [alias]: "checking" }));
    let result: SshCheck;
    try {
      result = await sshCheck(alias);
    } catch (e) {
      result = { status: "error", detail: errorText(e) };
    }
    setChecks((c) => ({ ...c, [alias]: result }));
  }, []);

  const checkAll = useCallback(
    (hosts: SshHost[]) => {
      for (const h of hosts) void check(h.alias);
    },
    [check],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await sshList();
      setList(next);
      // Khối đi qua máy trung gian chỉ kiểm khi người dùng bấm: lệnh proxy (cloudflared, SSM…) có thể mở trình duyệt
      // hay gửi yêu cầu MFA ngay khi vừa mở màn.
      checkAll(next.hosts.filter((h) => !h.proxy));
    } catch (e) {
      setError(errorText(e));
    }
  }, [checkAll]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(h: SshHost) {
    setBusy(true);
    try {
      setList(await sshRemove(h.alias));
      setRemoved(h);
      setRemoving(null);
    } catch (e) {
      setError(errorText(e));
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  }

  async function copyKey(publicKey: string) {
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const key = list?.key;
  return (
    <div className="flex flex-col gap-3.5">
      <header className="flex flex-wrap items-center gap-4">
        <p className="min-w-60 flex-1 text-sm text-muted-foreground">{t.lead}</p>
        <Button
          variant="outline"
          disabled={!list || list.hosts.length === 0}
          onClick={() => list && checkAll(list.hosts)}
        >
          <RefreshCwIcon aria-hidden="true" />
          {t.checkAll}
        </Button>
        <Button onClick={() => setAdding({ initial: null })}>
          <PlusIcon aria-hidden="true" />
          {t.add}
        </Button>
      </header>

      {error && (
        <p role="alert" className="rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {!list && !error && <p className="text-sm text-muted-foreground">{t.loading}</p>}

      {list && list.ssh === "" && (
        <Alert variant="destructive">
          <AlertTitle>{t.noSshTitle}</AlertTitle>
          <AlertDescription>{t.noSsh}</AlertDescription>
        </Alert>
      )}

      {removed && (
        <Alert>
          <AlertTitle>{t.removedTitle(removed.alias)}</AlertTitle>
          <AlertDescription>
            {t.removed(key?.comment ?? "xdev-hive", `${removed.user}@${removed.hostName}`)}
          </AlertDescription>
        </Alert>
      )}

      {key && (
        <section aria-label={t.keyTitle} className="flex flex-col gap-1.5 rounded-lg border px-3.5 py-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <KeyRoundIcon aria-hidden="true" className="size-4" />
            {t.keyTitle}
          </h2>
          {key.exists ? (
            <>
              <p className="font-mono text-sm break-all">{key.path}</p>
              <p className="text-sm text-muted-foreground">
                {key.type} · <span className="font-mono text-foreground">{key.fingerprint}</span>
                {key.comment ? ` · ${key.comment}` : ""}
              </p>
              {key.encrypted && <p className="text-sm text-warning">{t.encrypted}</p>}
              {key.publicKey && (
                <div>
                  <Button variant="outline" size="sm" onClick={() => key.publicKey && void copyKey(key.publicKey)}>
                    <CopyIcon aria-hidden="true" />
                    {copied ? t.copied : t.copyKey}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t.noKey(key.path)}</p>
          )}
          {/* Đường dẫn có ổ đĩa là Windows: chỉ ở đó mới có WSL. */}
          {/^[A-Za-z]:[\\/]/.test(list.configPath) && <p className="text-xs text-muted-foreground">{t.wsl}</p>}
        </section>
      )}

      {list && list.hosts.length === 0 && <p className="text-sm text-muted-foreground">{t.empty}</p>}
      {list && list.hosts.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <Th>{t.colAlias}</Th>
                <Th>{t.colServer}</Th>
                <Th>{t.colKind}</Th>
                <Th>{t.colStatus}</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.hosts.map((h) => {
                const state = checks[h.alias];
                const done = state && state !== "checking" ? state : null;
                const canSetup = done?.status === "auth" || done?.status === "hostkey_unknown";
                const reason = h.managed ? null : h.proxy ? t.proxyReason : h.keyUsable ? null : t.keyReason;
                return (
                  <TableRow key={h.alias}>
                    <Td className="font-mono">{h.alias}</Td>
                    <Td className="font-mono">{`${h.user}@${h.hostName}:${h.port}`}</Td>
                    <Td>
                      <Pill small>{h.managed ? t.managed : t.handWritten}</Pill>
                    </Td>
                    {/* Trạng thái và việc cần làm với nó nằm chung một ô để bảng vừa cửa sổ hẹp. */}
                    <Td className="min-w-64">
                      <div className="flex flex-col items-start gap-1">
                        {state === "checking" && <span className="text-sm text-muted-foreground">{t.checking}</span>}
                        {done && (
                          <Pill dot tone={sshTone(done.status)}>
                            {statusText[done.status].label}
                          </Pill>
                        )}
                        {done && done.status !== "ok" && (
                          <span className="text-xs text-muted-foreground">{statusText[done.status].hint}</span>
                        )}
                        {done?.status === "error" && done.detail && (
                          <span className="font-mono text-xs break-all text-muted-foreground">{done.detail}</span>
                        )}
                        {canSetup && reason && <span className="text-xs text-muted-foreground">{reason}</span>}
                        <div className="flex flex-wrap gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={state === "checking"}
                            onClick={() => void check(h.alias)}
                          >
                            {t.check}
                          </Button>
                          {canSetup && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={reason !== null}
                              onClick={() => setAdding({ initial: target(h) })}
                            >
                              {h.managed ? t.reinstall : t.convert}
                            </Button>
                          )}
                          {done?.status === "ok" && (
                            <Button variant="ghost" size="sm" onClick={() => setPasswordOff(h)}>
                              {t.passwordOff}
                            </Button>
                          )}
                          {h.managed && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive"
                              onClick={() => setRemoving(h)}
                            >
                              {t.remove}
                            </Button>
                          )}
                        </div>
                      </div>
                    </Td>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <SshAddDialog
        open={adding !== null}
        initial={adding?.initial ?? null}
        onClose={() => setAdding(null)}
        onChanged={() => void load()}
      />
      <SshPasswordOffDialog host={passwordOff} onClose={() => setPasswordOff(null)} />
      <Dialog open={removing !== null} onOpenChange={(o) => !o && !busy && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{removing ? t.removeTitle(removing.alias) : ""}</DialogTitle>
            <DialogDescription>{t.removeLead}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
              {t.cancel}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => removing && void remove(removing)}>
              {t.remove}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
