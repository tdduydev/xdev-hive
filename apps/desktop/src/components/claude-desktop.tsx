import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { AppWindowIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  adoptClaudeDesktop,
  type DesktopProfile,
  type DesktopProfiles,
  desktopProfiles,
  forgetClaudeDesktop,
  migrateClaudeDesktopProfiles,
  restoreClaudeDesktop,
  type Switched,
  switchClaudeDesktop,
} from "@/lib/claude-desktop.ts";
import { openFolder } from "@/lib/git-groups.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

/** Đọc lại để thấy Claude Desktop vừa mở hay vừa tắt; rẻ: chỉ đọc danh sách gói và trạng thái. */
export const DESKTOP_POLL_MS = 10_000;

const text: Dict<{
  switch: string;
  switchTitle: string;
  open: string;
  inUse: string;
  inUseTitle: string;
  notSaved: string;
  adopt: string;
  adoptTitle: string;
  forget: string;
  forgetTitle: string;
  forgetBody: (plan: string) => string;
  confirmTitle: string;
  confirmBody: (plan: string) => string;
  confirmLogin: string;
  confirmSwitch: string;
  forceTitle: string;
  forceBody: string;
  force: string;
  cancel: string;
  switched: (plan: string) => string;
  switchedLogin: (plan: string) => string;
  already: (plan: string) => string;
  adopted: (plan: string) => string;
  forgotten: (plan: string) => string;
  backupTitle: string;
  backupBody: string;
  openBackup: string;
  restore: string;
  restoreTitle: string;
  restoreBody: (dir: string) => string;
  restoreConfirm: string;
  restored: string;
  legacyTitle: (n: number) => string;
  legacyBody: string;
  migrate: string;
  migrateTitle: string;
  migrateBody: (ids: string) => string;
  migrated: string;
}> = {
  vi: {
    switch: "Chuyển Claude Desktop sang gói này",
    switchTitle: "Claude Desktop thoát rồi mở lại bằng tài khoản của gói này; bộ nhớ, sessions trên máy giữ nguyên",
    open: "Mở Claude Desktop",
    inUse: "Đang dùng",
    inUseTitle: "Claude Desktop đang đăng nhập bằng tài khoản của gói này",
    notSaved: "Chưa lưu đăng nhập Claude Desktop: lần đầu chuyển sang sẽ phải đăng nhập.",
    adopt: "Claude Desktop đang đăng nhập gói này",
    adoptTitle:
      "Bấm nếu Claude Desktop hiện đang đăng nhập đúng tài khoản của gói này: lần chuyển sau Hive lưu đăng nhập đó cho gói, không phải đăng nhập lại",
    forget: "Quên đăng nhập đã lưu",
    forgetTitle: "Quên đăng nhập Claude Desktop của gói?",
    forgetBody: (plan) =>
      `Đăng nhập Claude Desktop đã lưu của ${plan} bị xoá; lần sau chuyển sang gói này phải đăng nhập lại. Sessions và dữ liệu trên máy không bị đụng tới.`,
    confirmTitle: "Khởi động lại Claude Desktop?",
    confirmBody: (plan) =>
      `Claude Desktop sẽ thoát rồi mở lại bằng tài khoản của ${plan}. Việc đang chạy trong Claude Desktop sẽ dừng. Bộ nhớ, sessions, MCP và cấu hình trên máy giữ nguyên; đăng nhập hiện tại được lưu cho gói đang dùng.`,
    confirmLogin:
      "Gói này chưa lưu đăng nhập: Claude Desktop mở ở màn đăng nhập, bạn đăng nhập bằng tài khoản của gói. Lần chuyển sau Hive tự lưu đăng nhập đó.",
    confirmSwitch: "Khởi động lại và chuyển",
    forceTitle: "Claude Desktop chưa thoát",
    forceBody:
      "Claude Desktop không tự thoát sau 20 giây (có thể đang hỏi lại, đang bận, hay chỉ thu xuống khay hệ thống). Chưa có gì bị đổi. Buộc thoát có thể mất việc chưa lưu trong Claude Desktop.",
    force: "Buộc thoát và chuyển",
    cancel: "Huỷ",
    switched: (plan) => `Đã chuyển Claude Desktop sang ${plan}.`,
    switchedLogin: (plan) =>
      `Đã chuyển Claude Desktop sang ${plan}: đăng nhập bằng tài khoản Claude của gói này. Lần chuyển sau Hive tự lưu đăng nhập đó.`,
    already: (plan) => `Claude Desktop đang dùng ${plan}.`,
    adopted: (plan) => `Đã ghi nhận Claude Desktop đang dùng ${plan}.`,
    forgotten: (plan) => `Đã quên đăng nhập Claude Desktop của ${plan}.`,
    backupTitle: "Bản sao lưu Claude Desktop ban đầu",
    backupBody: "Chép cả hồ sơ Claude Desktop (trừ cache) lúc mới dùng tính năng chuyển gói.",
    openBackup: "Mở thư mục",
    restore: "Khôi phục như ban đầu",
    restoreTitle: "Khôi phục Claude Desktop như ban đầu?",
    restoreBody: (dir) =>
      `Claude Desktop sẽ thoát rồi mở lại bằng tài khoản lúc chưa dùng tính năng chuyển gói. Đăng nhập hiện tại được lưu cho gói đang dùng. Sessions và dữ liệu mới trên máy giữ nguyên; bản sao lưu đầy đủ vẫn ở ${dir}.`,
    restoreConfirm: "Khôi phục",
    restored: "Đã khôi phục đăng nhập Claude Desktop ban đầu.",
    legacyTitle: (n) => `${n} hồ sơ Claude Desktop riêng kiểu cũ`,
    legacyBody:
      "Bản trước mở mỗi gói một Claude Desktop riêng. Giờ mọi gói dùng chung Claude Desktop của bạn và chỉ đổi đăng nhập.",
    migrate: "Đổi sang cách mới",
    migrateTitle: "Đổi hồ sơ riêng kiểu cũ?",
    migrateBody: (ids) =>
      `Hồ sơ riêng của ${ids}: giữ lại đăng nhập để chuyển gói không phải đăng nhập lại, xoá phần còn lại (lịch sử chat trên máy, cache) của các hồ sơ riêng đó. Claude Desktop thường của bạn không bị đụng tới.`,
    migrated: "Đã đổi hồ sơ riêng kiểu cũ sang đăng nhập đã lưu.",
  },
  en: {
    switch: "Switch Claude Desktop to this plan",
    switchTitle:
      "Claude Desktop quits and reopens with this plan's account; local memory and sessions stay as they are",
    open: "Open Claude Desktop",
    inUse: "In use",
    inUseTitle: "Claude Desktop is signed in with this plan's account",
    notSaved: "No saved Claude Desktop sign-in: the first switch asks you to sign in.",
    adopt: "Claude Desktop is on this plan",
    adoptTitle:
      "Click if Claude Desktop is currently signed in with this plan's account: the next switch saves that sign-in for the plan, no need to sign in again",
    forget: "Forget saved sign-in",
    forgetTitle: "Forget this plan's Claude Desktop sign-in?",
    forgetBody: (plan) =>
      `The saved Claude Desktop sign-in of ${plan} is deleted; switching to it later asks you to sign in again. Sessions and local data are not touched.`,
    confirmTitle: "Restart Claude Desktop?",
    confirmBody: (plan) =>
      `Claude Desktop quits and reopens with ${plan}'s account. Work running in Claude Desktop stops. Memory, sessions, MCP and local settings stay as they are; the current sign-in is saved for the plan in use.`,
    confirmLogin:
      "This plan has no saved sign-in: Claude Desktop opens at the sign-in screen, sign in with the plan's account. The next switch saves that sign-in.",
    confirmSwitch: "Restart and switch",
    forceTitle: "Claude Desktop did not quit",
    forceBody:
      "Claude Desktop did not quit within 20 seconds (it may be asking something, busy, or only minimized to the system tray). Nothing was changed. Forcing it to quit may lose unsaved work in Claude Desktop.",
    force: "Force quit and switch",
    cancel: "Cancel",
    switched: (plan) => `Claude Desktop is now on ${plan}.`,
    switchedLogin: (plan) =>
      `Claude Desktop is now on ${plan}: sign in with this plan's Claude account. The next switch saves that sign-in.`,
    already: (plan) => `Claude Desktop is already on ${plan}.`,
    adopted: (plan) => `Noted that Claude Desktop is on ${plan}.`,
    forgotten: (plan) => `Forgot ${plan}'s Claude Desktop sign-in.`,
    backupTitle: "Original Claude Desktop backup",
    backupBody: "A copy of the whole Claude Desktop profile (without cache) taken when plan switching was first used.",
    openBackup: "Open folder",
    restore: "Restore original",
    restoreTitle: "Restore Claude Desktop to the original?",
    restoreBody: (dir) =>
      `Claude Desktop quits and reopens with the account it had before plan switching. The current sign-in is saved for the plan in use. Sessions and newer local data stay; the full backup remains at ${dir}.`,
    restoreConfirm: "Restore",
    restored: "Restored the original Claude Desktop sign-in.",
    legacyTitle: (n) => `${n} old separate Claude Desktop profile${n === 1 ? "" : "s"}`,
    legacyBody:
      "The previous version opened a separate Claude Desktop per plan. Now all plans share your Claude Desktop and only the sign-in changes.",
    migrate: "Convert",
    migrateTitle: "Convert the old separate profiles?",
    migrateBody: (ids) =>
      `Separate profiles of ${ids}: the sign-in is kept so switching needs no new sign-in, the rest (local chat history, cache) of those profiles is deleted. Your regular Claude Desktop is not touched.`,
    migrated: "Converted the old separate profiles into saved sign-ins.",
  },
};

/**
 * Trạng thái Claude Desktop của mọi gói Claude, đọc lại định kỳ để thấy app mở hay tắt. Lỗi (worker cũ, ngoài Tauri)
 * thì trả null và màn không hiện phần Claude Desktop.
 */
export function useClaudeDesktop(): { view: DesktopProfiles | null; reload: () => Promise<void> } {
  const [view, setView] = useState<DesktopProfiles | null>(null);
  const reload = useCallback(async () => {
    try {
      setView(await desktopProfiles());
    } catch {
      setView(null);
    }
  }, []);
  useEffect(() => {
    void reload();
    const h = setInterval(() => void reload(), DESKTOP_POLL_MS);
    return () => clearInterval(h);
  }, [reload]);
  return { view, reload };
}

type Notice = { tone: "ok" | "info" | "bad"; text: string };

function NoticeLine({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <p
      role="status"
      className={cn(
        "rounded-md px-2 py-1 text-xs",
        notice.tone === "ok" && "bg-success-soft text-success",
        notice.tone === "info" && "bg-muted text-foreground",
        notice.tone === "bad" && "bg-destructive-soft text-destructive",
      )}
    >
      {notice.text}
    </p>
  );
}

function Confirm({
  open,
  title,
  body,
  extra,
  action,
  destructive,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  body: string;
  extra?: string | undefined;
  action: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT(text);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent showCloseButton={false}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{body}</DialogDescription>
        {extra && <p className="text-sm text-muted-foreground">{extra}</p>}
        <DialogActions>
          <Button variant="outline" onClick={onCancel}>
            {t.cancel}
          </Button>
          <Button variant={destructive ? "destructive-solid" : "default"} onClick={onConfirm}>
            {action}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Chuyển (hay khôi phục) có bước hỏi: Claude Desktop đang chạy thì xác nhận trước khi nó bị thoát; nó không chịu thoát
 * thì hỏi có buộc thoát không.
 */
function useRestart(
  job: (force: boolean) => Promise<Switched>,
  done: (s: Switched) => void,
  fail: (e: unknown) => void,
) {
  const [asking, setAsking] = useState<"confirm" | "force" | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (force: boolean) => {
    setAsking(null);
    setBusy(true);
    try {
      const s = await job(force);
      if (s.status === "stillRunning") setAsking("force");
      else done(s);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return {
    asking,
    busy,
    /** `ask`: hỏi trước (Claude Desktop đang chạy sẽ bị thoát). */
    start: (ask: boolean) => (ask ? setAsking("confirm") : void run(false)),
    confirm: () => void run(false),
    force: () => void run(true),
    cancel: () => setAsking(null),
  };
}

/** Dòng Claude Desktop trên thẻ một gói Claude: đang dùng, chuyển sang, ghi nhận đăng nhập hiện tại, quên đăng nhập. */
export function ClaudeDesktopRow({
  plan,
  profile,
  view,
  onChanged,
}: {
  /** Tên gói để hiện trong thông báo. */
  plan: string;
  profile: DesktopProfile;
  view: DesktopProfiles;
  onChanged: () => void;
}) {
  const t = useT(text);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const restart = useRestart(
    (force) => switchClaudeDesktop(profile.id, force),
    (s) => {
      if (s.status === "already") setNotice({ tone: "info", text: t.already(plan) });
      else setNotice({ tone: "ok", text: s.needsLogin ? t.switchedLogin(plan) : t.switched(plan) });
      onChanged();
    },
    (e) => setNotice({ tone: "bad", text: errorText(e) }),
  );

  const canSwitch = !!view.app;
  const running = view.running !== null;
  const noneActive = !view.profiles.some((p) => p.active);
  const working = busy || restart.busy;

  async function run(job: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await job();
      setNotice({ tone: "ok", text: ok });
      onChanged();
    } catch (e) {
      setNotice({ tone: "bad", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-claude-desktop={profile.id} className="flex flex-col gap-1 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2">
        {profile.active ? (
          <>
            <Pill tone="ok" dot title={t.inUseTitle}>
              {t.inUse}
            </Pill>
            {!running && (
              <Button size="sm" variant="outline" disabled={working || !canSwitch} onClick={() => restart.start(false)}>
                {t.open}
              </Button>
            )}
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={working || !canSwitch}
            title={view.note ?? t.switchTitle}
            onClick={() => restart.start(running)}
          >
            <AppWindowIcon aria-hidden="true" />
            {t.switch}
          </Button>
        )}
        {noneActive && !profile.saved && canSwitch && (
          <Button
            size="sm"
            variant="ghost"
            disabled={working}
            title={t.adoptTitle}
            onClick={() => void run(() => adoptClaudeDesktop(profile.id), t.adopted(plan))}
          >
            {t.adopt}
          </Button>
        )}
        {profile.saved && !profile.active && (
          <Button size="sm" variant="ghost" disabled={working} onClick={() => setForgetting(true)}>
            {t.forget}
          </Button>
        )}
      </div>
      {!profile.saved && !profile.active && canSwitch && (
        <span className="text-xs text-muted-foreground">{t.notSaved}</span>
      )}
      {!canSwitch && view.note && <span className="text-xs text-muted-foreground">{view.note}</span>}
      <NoticeLine notice={notice} />
      <Confirm
        open={restart.asking === "confirm"}
        title={t.confirmTitle}
        body={t.confirmBody(plan)}
        extra={profile.saved ? undefined : t.confirmLogin}
        action={t.confirmSwitch}
        onCancel={restart.cancel}
        onConfirm={restart.confirm}
      />
      <Confirm
        open={restart.asking === "force"}
        title={t.forceTitle}
        body={t.forceBody}
        action={t.force}
        destructive
        onCancel={restart.cancel}
        onConfirm={restart.force}
      />
      <Confirm
        open={forgetting}
        title={t.forgetTitle}
        body={t.forgetBody(plan)}
        action={t.forget}
        destructive
        onCancel={() => setForgetting(false)}
        onConfirm={() => {
          setForgetting(false);
          void run(() => forgetClaudeDesktop(profile.id), t.forgotten(plan));
        }}
      />
    </div>
  );
}

/**
 * Phần chung của Claude Desktop trên màn gói: hồ sơ riêng kiểu cũ cần đổi, bản sao lưu ban đầu và nút khôi phục. Không
 * hiện gì khi chưa có hai thứ đó.
 */
export function ClaudeDesktopPanel({ view, onChanged }: { view: DesktopProfiles; onChanged: () => void }) {
  const t = useT(text);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const restart = useRestart(
    (force) => restoreClaudeDesktop(force),
    () => {
      setNotice({ tone: "ok", text: t.restored });
      onChanged();
    },
    (e) => setNotice({ tone: "bad", text: errorText(e) }),
  );
  const { backup, legacy } = view;
  if (!view.supported || (!backup && legacy.length === 0)) return null;

  async function migrate() {
    setMigrating(false);
    setBusy(true);
    try {
      await migrateClaudeDesktopProfiles();
      setNotice({ tone: "ok", text: t.migrated });
      onChanged();
    } catch (e) {
      setNotice({ tone: "bad", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Claude Desktop" className="flex flex-col gap-2 rounded-xl border px-4 py-2.5 text-sm">
      {legacy.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <AppWindowIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-56 flex-1">
            <strong className="font-semibold">{t.legacyTitle(legacy.length)}</strong> {t.legacyBody}
          </span>
          <Button size="sm" disabled={busy} onClick={() => setMigrating(true)}>
            {t.migrate}
          </Button>
        </div>
      )}
      {backup && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <AppWindowIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-56 flex-1">
            <strong className="font-semibold">{t.backupTitle}</strong> {t.backupBody}{" "}
            <span className="break-all text-xs text-muted-foreground">{backup}</span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void openFolder(backup).catch((e) => setNotice({ tone: "bad", text: errorText(e) }))}
          >
            {t.openBackup}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || restart.busy || !view.app}
            onClick={() => restart.start(true)}
          >
            {t.restore}
          </Button>
        </div>
      )}
      <NoticeLine notice={notice} />
      <Confirm
        open={migrating}
        title={t.migrateTitle}
        body={t.migrateBody(legacy.join(", "))}
        action={t.migrate}
        destructive
        onCancel={() => setMigrating(false)}
        onConfirm={() => void migrate()}
      />
      <Confirm
        open={restart.asking === "confirm"}
        title={t.restoreTitle}
        body={t.restoreBody(backup ?? "")}
        action={t.restoreConfirm}
        onCancel={restart.cancel}
        onConfirm={restart.confirm}
      />
      <Confirm
        open={restart.asking === "force"}
        title={t.forceTitle}
        body={t.forceBody}
        action={t.force}
        destructive
        onCancel={restart.cancel}
        onConfirm={restart.force}
      />
    </section>
  );
}
