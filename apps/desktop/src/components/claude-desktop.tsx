import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { AppWindowIcon, LogOutIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  adoptClaudeDesktop,
  cancelSwitch,
  type DesktopProfile,
  type DesktopProfiles,
  desktopProfiles,
  diagnoseClaudeDesktop,
  dismissClaudeDesktopMismatch,
  forgetClaudeDesktop,
  migrateClaudeDesktopProfiles,
  restoreClaudeDesktop,
  type Switched,
  type SwitchProgress,
  type SwitchStep,
  signOutClaudeDesktop,
  switchClaudeDesktop,
  switchProgress,
} from "@/lib/claude-desktop.ts";
import { openFolder } from "@/lib/git-groups.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

/** Đọc lại để thấy Claude Desktop vừa mở hay vừa tắt; rẻ: chỉ đọc danh sách gói và trạng thái. */
export const DESKTOP_POLL_MS = 10_000;
/** Lúc đang chuyển: đủ dày để thấy phần trăm sao lưu chạy, chỉ đọc một biến trong bộ nhớ. */
export const PROGRESS_POLL_MS = 1_000;

const text: Dict<{
  switch: string;
  switchTitle: string;
  open: string;
  inUse: string;
  inUseTitle: string;
  notSaved: string;
  waitingLogin: string;
  adopt: string;
  adoptTitle: string;
  forget: string;
  forgetHint: string;
  forgetTitle: string;
  forgetBody: (plan: string) => string;
  signOut: string;
  signOutHint: string;
  signOutTitle: string;
  signOutBody: (plan: string) => string;
  signOutConfirm: string;
  signOutForce: string;
  signedOut: (plan: string) => string;
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
  signedIn: (account: string) => string;
  signedInPlan: (plan: string) => string;
  signedInNoPlan: string;
  mismatch: (account: string, expected: string) => string;
  mismatchAdopted: (plan: string) => string;
  mismatchNotSaved: (expected: string) => string;
  dismiss: string;
  steps: Record<SwitchStep, string>;
  elapsed: (s: number) => string;
  cancelling: string;
  cancelSwitch: string;
  cancelSwitchTitle: string;
  diagnose: string;
  diagnoseTitle: string;
  diagnosed: string;
  diagnoseFailed: string;
}> = {
  vi: {
    switch: "Chuyển Claude Desktop sang gói này",
    switchTitle: "Claude Desktop thoát rồi mở lại bằng tài khoản của gói này; bộ nhớ, sessions trên máy giữ nguyên",
    open: "Mở Claude Desktop",
    inUse: "Đang dùng",
    inUseTitle: "Claude Desktop đang đăng nhập bằng tài khoản của gói này",
    notSaved:
      "Chưa lưu đăng nhập Claude Desktop, cần đăng nhập 1 lần: lần đầu chuyển sang, đăng nhập bằng tài khoản của gói này; Hive tự lưu để lần sau không hỏi lại.",
    waitingLogin:
      "Claude Desktop chưa đăng nhập: đăng nhập bằng tài khoản của gói này, Hive tự lưu ngay khi bạn đăng nhập xong.",
    adopt: "Claude Desktop đang đăng nhập gói này",
    adoptTitle:
      "Hive không đọc được tài khoản Claude của gói này nên không tự nhận ra. Bấm nếu Claude Desktop đang đăng nhập đúng tài khoản của gói: Hive lưu đăng nhập đó cho gói",
    forget: "Quên đăng nhập",
    forgetHint:
      "Xoá đăng nhập Claude Desktop đã lưu của gói này. Gói không đang dùng nên Claude Desktop đang mở không bị đụng tới",
    forgetTitle: "Quên đăng nhập Claude Desktop của gói?",
    forgetBody: (plan) =>
      `Đăng nhập Claude Desktop đã lưu của ${plan} bị xoá; lần sau chuyển sang gói này phải đăng nhập lại. Sessions và dữ liệu trên máy không bị đụng tới.`,
    signOut: "Đăng xuất Claude Desktop",
    signOutHint: "Claude Desktop thoát, bỏ đăng nhập của gói này rồi mở lại ở màn đăng nhập",
    signOutTitle: "Đăng xuất Claude Desktop?",
    signOutBody: (plan) =>
      `Claude Desktop sẽ thoát, đăng nhập của ${plan} (trong Claude Desktop và bản Hive đã lưu) bị xoá, rồi Claude Desktop mở lại ở màn đăng nhập. Việc đang chạy trong Claude Desktop sẽ dừng. Bộ nhớ, sessions, MCP và cấu hình trên máy giữ nguyên; gói khác không bị đụng tới.`,
    signOutConfirm: "Đăng xuất",
    signOutForce: "Buộc thoát và đăng xuất",
    signedOut: (plan) =>
      `Đã đăng xuất Claude Desktop khỏi ${plan}. Đăng nhập lại trong Claude Desktop khi cần; Hive tự lưu cho gói này.`,
    confirmTitle: "Khởi động lại Claude Desktop?",
    confirmBody: (plan) =>
      `Claude Desktop sẽ thoát rồi mở lại bằng tài khoản của ${plan}. Việc đang chạy trong Claude Desktop sẽ dừng. Bộ nhớ, sessions, MCP và cấu hình trên máy giữ nguyên; đăng nhập hiện tại được lưu cho gói đang dùng.`,
    confirmLogin:
      "Gói này chưa lưu đăng nhập: Claude Desktop mở ở màn đăng nhập, bạn đăng nhập bằng tài khoản của gói. Hive tự lưu ngay khi bạn đăng nhập xong.",
    confirmSwitch: "Khởi động lại và chuyển",
    forceTitle: "Claude Desktop chưa thoát",
    forceBody:
      "Claude Desktop chưa tự thoát (có thể đang hỏi lại, đang bận, hay chỉ thu xuống khay hệ thống). Chưa có gì bị đổi. Buộc thoát có thể mất việc chưa lưu trong Claude Desktop.",
    force: "Buộc thoát và chuyển",
    cancel: "Huỷ",
    switched: (plan) => `Đã chuyển Claude Desktop sang ${plan}.`,
    switchedLogin: (plan) =>
      `Đã chuyển Claude Desktop sang ${plan}: đăng nhập bằng tài khoản Claude của gói này. Hive tự lưu ngay khi bạn đăng nhập xong.`,
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
    signedIn: (account) => `Claude Desktop đang đăng nhập ${account}`,
    signedInPlan: (plan) => `của ${plan}`,
    signedInNoPlan: "không thuộc gói nào trên máy",
    mismatch: (account, expected) => `Bạn vừa đăng nhập tài khoản ${account}, không phải của ${expected}.`,
    mismatchAdopted: (plan) => `Hive đã lưu đăng nhập này cho ${plan}, gói của tài khoản đó.`,
    mismatchNotSaved: (expected) =>
      `Đăng nhập này chưa được lưu cho gói nào. Đăng xuất trong Claude Desktop rồi đăng nhập tài khoản của ${expected}.`,
    dismiss: "Đã hiểu",
    steps: {
      preparing: "Đang chuẩn bị chuyển Claude Desktop",
      quitting: "Đang chờ Claude Desktop thoát",
      forceQuitting: "Đang buộc Claude Desktop thoát",
      backingUp: "Đang sao lưu hồ sơ Claude Desktop (lần đầu)",
      swapping: "Đang đổi đăng nhập",
      launching: "Đang mở lại Claude Desktop",
    },
    elapsed: (s) => `${s} giây`,
    cancelling: "Đang huỷ, trả lại đăng nhập cũ…",
    cancelSwitch: "Huỷ",
    cancelSwitchTitle: "Dừng lần chuyển này; Claude Desktop giữ đăng nhập như trước",
    diagnose: "Chép thông tin chẩn đoán",
    diagnoseTitle:
      "Chép đường dẫn, cỡ hồ sơ và tiến trình Claude Desktop để gửi người hỗ trợ; không có token hay nội dung đăng nhập",
    diagnosed: "Đã chép thông tin chẩn đoán; dán vào tin nhắn gửi người hỗ trợ.",
    diagnoseFailed: "Không chép được thông tin chẩn đoán vào clipboard.",
  },
  en: {
    switch: "Switch Claude Desktop to this plan",
    switchTitle:
      "Claude Desktop quits and reopens with this plan's account; local memory and sessions stay as they are",
    open: "Open Claude Desktop",
    inUse: "In use",
    inUseTitle: "Claude Desktop is signed in with this plan's account",
    notSaved:
      "No saved Claude Desktop sign-in, sign in once: on the first switch, sign in with this plan's account; Hive saves it so you are not asked again.",
    waitingLogin:
      "Claude Desktop is signed out: sign in with this plan's account, Hive saves it as soon as you are done.",
    adopt: "Claude Desktop is on this plan",
    adoptTitle:
      "Hive cannot read this plan's Claude account, so it cannot tell on its own. Click if Claude Desktop is signed in with this plan's account: Hive saves that sign-in for the plan",
    forget: "Forget sign-in",
    forgetHint:
      "Delete this plan's saved Claude Desktop sign-in. The plan is not in use, so the running Claude Desktop is not touched",
    forgetTitle: "Forget this plan's Claude Desktop sign-in?",
    forgetBody: (plan) =>
      `The saved Claude Desktop sign-in of ${plan} is deleted; switching to it later asks you to sign in again. Sessions and local data are not touched.`,
    signOut: "Sign out of Claude Desktop",
    signOutHint: "Claude Desktop quits, drops this plan's sign-in and reopens at the sign-in screen",
    signOutTitle: "Sign out of Claude Desktop?",
    signOutBody: (plan) =>
      `Claude Desktop quits, ${plan}'s sign-in (in Claude Desktop and the copy Hive saved) is deleted, then Claude Desktop reopens at the sign-in screen. Work running in Claude Desktop stops. Memory, sessions, MCP and local settings stay as they are; other plans are not touched.`,
    signOutConfirm: "Sign out",
    signOutForce: "Force quit and sign out",
    signedOut: (plan) =>
      `Signed Claude Desktop out of ${plan}. Sign in again in Claude Desktop when needed; Hive saves it for this plan.`,
    confirmTitle: "Restart Claude Desktop?",
    confirmBody: (plan) =>
      `Claude Desktop quits and reopens with ${plan}'s account. Work running in Claude Desktop stops. Memory, sessions, MCP and local settings stay as they are; the current sign-in is saved for the plan in use.`,
    confirmLogin:
      "This plan has no saved sign-in: Claude Desktop opens at the sign-in screen, sign in with the plan's account. Hive saves it as soon as you are done.",
    confirmSwitch: "Restart and switch",
    forceTitle: "Claude Desktop did not quit",
    forceBody:
      "Claude Desktop has not quit (it may be asking something, busy, or only minimized to the system tray). Nothing was changed. Forcing it to quit may lose unsaved work in Claude Desktop.",
    force: "Force quit and switch",
    cancel: "Cancel",
    switched: (plan) => `Claude Desktop is now on ${plan}.`,
    switchedLogin: (plan) =>
      `Claude Desktop is now on ${plan}: sign in with this plan's Claude account. Hive saves it as soon as you are done.`,
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
    signedIn: (account) => `Claude Desktop is signed in as ${account}`,
    signedInPlan: (plan) => `of ${plan}`,
    signedInNoPlan: "not of any plan on this machine",
    mismatch: (account, expected) => `You just signed in as ${account}, which is not ${expected}'s account.`,
    mismatchAdopted: (plan) => `Hive saved this sign-in for ${plan}, the plan of that account.`,
    mismatchNotSaved: (expected) =>
      `This sign-in is not saved for any plan. Sign out in Claude Desktop, then sign in with ${expected}'s account.`,
    dismiss: "Got it",
    steps: {
      preparing: "Preparing to switch Claude Desktop",
      quitting: "Waiting for Claude Desktop to quit",
      forceQuitting: "Forcing Claude Desktop to quit",
      backingUp: "Backing up the Claude Desktop profile (first time)",
      swapping: "Swapping the sign-in",
      launching: "Reopening Claude Desktop",
    },
    elapsed: (s) => `${s}s`,
    cancelling: "Cancelling, putting the previous sign-in back…",
    cancelSwitch: "Cancel",
    cancelSwitchTitle: "Stop this switch; Claude Desktop keeps its previous sign-in",
    diagnose: "Copy diagnostics",
    diagnoseTitle:
      "Copy the Claude Desktop paths, profile sizes and processes to send to support; no tokens or sign-in contents",
    diagnosed: "Copied the diagnostics; paste them into your message to support.",
    diagnoseFailed: "Could not copy the diagnostics to the clipboard.",
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

/** Uuid dài vô nghĩa với người dùng; đủ 8 ký tự đầu để đối chiếu. */
function shortUuid(uuid: string): string {
  return uuid.length > 8 ? `${uuid.slice(0, 8)}…` : uuid;
}

/** Tên gói để hiện; gói không còn trong danh sách thì hiện id. */
function planName(view: DesktopProfiles, id: string): string {
  return view.profiles.find((p) => p.id === id)?.label || id;
}

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

/**
 * Tiến độ của lần chuyển đang chạy và nút Huỷ. Lần chuyển chạy nền bên Rust nên hỏi tiến độ riêng thay vì chờ lệnh
 * chuyển trả về: bản 0.2.16 chỉ chờ, và một bước treo trên Windows làm nút quay mãi không biết đang làm gì.
 */
function SwitchProgressLine({
  initial,
  onGone,
}: {
  initial: SwitchProgress | null;
  onGone?: (() => void) | undefined;
}) {
  const t = useT(text);
  const [progress, setProgress] = useState(initial);
  const [cancelling, setCancelling] = useState(false);
  // Giây đếm thêm tại chỗ từ lần đọc tiến độ gần nhất: lần hỏi chậm hay không trả lời thì bộ đếm vẫn chạy (0.2.17 đứng
  // ở "8 giây" khiến người dùng tưởng app treo hẳn).
  const [since, setSince] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    let alive = true;
    let asking = false;
    const h = setInterval(() => {
      setNow(Date.now());
      if (asking) return;
      asking = true;
      void switchProgress()
        .then((p) => {
          if (!alive) return;
          setProgress(p);
          setSince(Date.now());
          setNow(Date.now());
          if (!p) gone.current?.();
        })
        .catch(() => {})
        .finally(() => {
          asking = false;
        });
    }, PROGRESS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  const step = progress?.step ?? "preparing";
  const stopping = cancelling || !!progress?.cancelling;
  return (
    <div data-switch-progress aria-live="polite" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className="min-w-48 flex-1">
        {stopping ? t.cancelling : t.steps[step]}
        {progress?.percent != null && ` ${progress.percent}%`}
        {progress && (
          <span className="text-muted-foreground">
            {" "}
            · {t.elapsed(progress.elapsed + Math.max(0, Math.floor((now - since) / 1000)))}
          </span>
        )}
      </span>
      {progress?.percent != null && (
        <progress className="h-1.5 w-24" max={100} value={progress.percent} aria-label={t.steps[step]} />
      )}
      <Button
        size="sm"
        variant="ghost"
        title={t.cancelSwitchTitle}
        disabled={stopping || progress?.cancellable === false}
        onClick={() =>
          void cancelSwitch().then(
            (ok) => ok && setCancelling(true),
            () => {},
          )
        }
      >
        {t.cancelSwitch}
      </Button>
    </div>
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

/**
 * Dòng Claude Desktop trên thẻ một gói Claude: đang dùng, chuyển sang, ghi nhận đăng nhập hiện tại, đăng xuất (gói đang
 * dùng) hay quên đăng nhập đã lưu (gói không dùng).
 */
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
  const signOut = useRestart(
    (force) => signOutClaudeDesktop(profile.id, force),
    () => {
      setNotice({ tone: "ok", text: t.signedOut(plan) });
      onChanged();
    },
    (e) => setNotice({ tone: "bad", text: errorText(e) }),
  );

  const canSwitch = !!view.app;
  const running = view.running !== null;
  const noneActive = !view.profiles.some((p) => p.active);
  // Một lần chuyển chạy ở chỗ khác (dòng khác, khay) thì Rust cũng từ chối; tắt nút cho khỏi bấm vào lỗi.
  const working = busy || restart.busy || signOut.busy || !!view.switching;
  // Lần chuyển (hay đăng xuất) của gói này: bấm ở đây, hay bắt đầu trước khi cửa sổ mở lại.
  const switchingHere = restart.busy || signOut.busy || view.switching?.target === profile.id;
  // Có gì để đăng xuất: Claude Desktop đang đăng nhập, hay Hive còn giữ bản đã lưu của gói.
  const canSignOut = profile.active && canSwitch && (!!view.signedIn || profile.saved);
  // Gói biết tài khoản thì Hive tự gắn đăng nhập; nút ghi nhận tay chỉ còn cho gói không đọc được tài khoản, khi Claude
  // Desktop đang đăng nhập một tài khoản chưa gói nào nhận.
  const canAdopt =
    noneActive && !profile.accountKnown && !profile.saved && canSwitch && !!view.signedIn && !view.signedIn.plan;

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
        {canAdopt && (
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
        {canSignOut && (
          <Button
            size="sm"
            variant="ghost"
            disabled={working}
            title={t.signOutHint}
            onClick={() => signOut.start(true)}
          >
            <LogOutIcon aria-hidden="true" />
            {t.signOut}
          </Button>
        )}
        {profile.saved && !profile.active && (
          <Button size="sm" variant="ghost" disabled={working} title={t.forgetHint} onClick={() => setForgetting(true)}>
            {t.forget}
          </Button>
        )}
      </div>
      {!profile.saved && canSwitch && (
        <span className="text-xs text-muted-foreground">
          {profile.active && !view.signedIn ? t.waitingLogin : t.notSaved}
        </span>
      )}
      {!canSwitch && view.note && <span className="text-xs text-muted-foreground">{view.note}</span>}
      {switchingHere && (
        <SwitchProgressLine
          initial={view.switching?.target === profile.id ? view.switching : null}
          onGone={restart.busy || signOut.busy ? undefined : onChanged}
        />
      )}
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
        open={signOut.asking === "confirm"}
        title={t.signOutTitle}
        body={t.signOutBody(plan)}
        action={t.signOutConfirm}
        destructive
        onCancel={signOut.cancel}
        onConfirm={signOut.confirm}
      />
      <Confirm
        open={signOut.asking === "force"}
        title={t.forceTitle}
        body={t.forceBody}
        action={t.signOutForce}
        destructive
        onCancel={signOut.cancel}
        onConfirm={signOut.force}
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
 * Phần chung của Claude Desktop trên màn gói: tài khoản đang đăng nhập, thông báo đăng nhập nhầm tài khoản, hồ sơ riêng
 * kiểu cũ cần đổi, bản sao lưu ban đầu và nút khôi phục, tiến độ khôi phục, và nút chép thông tin chẩn đoán (luôn có:
 * chuyển hỏng trên máy người dùng thì đây là thứ người hỗ trợ cần đầu tiên).
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
  const { backup, legacy, signedIn, mismatch, switching } = view;
  if (!view.supported) return null;
  // Khôi phục, hay lần chuyển sang gói đã bị xoá khỏi danh sách: không dòng gói nào hiện tiến độ của nó.
  const switchingHere = restart.busy || (!!switching && !view.profiles.some((p) => p.id === switching.target));

  async function diagnose() {
    setBusy(true);
    try {
      const report = await diagnoseClaudeDesktop();
      try {
        await navigator.clipboard.writeText(report);
        setNotice({ tone: "ok", text: t.diagnosed });
      } catch {
        setNotice({ tone: "bad", text: t.diagnoseFailed });
      }
    } catch (e) {
      setNotice({ tone: "bad", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    setBusy(true);
    try {
      await dismissClaudeDesktopMismatch();
      onChanged();
    } catch (e) {
      setNotice({ tone: "bad", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

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
      {signedIn && (
        <div data-signed-in className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <AppWindowIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-56 flex-1">
            {t.signedIn(signedIn.email ?? shortUuid(signedIn.account))}{" "}
            <span className="text-muted-foreground">
              {signedIn.plan ? t.signedInPlan(planName(view, signedIn.plan)) : t.signedInNoPlan}
            </span>
          </span>
        </div>
      )}
      {mismatch && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-warning-soft px-2 py-1">
          <span className="min-w-56 flex-1">
            {t.mismatch(mismatch.account, planName(view, mismatch.expected))}{" "}
            {mismatch.adopted
              ? t.mismatchAdopted(planName(view, mismatch.adopted))
              : t.mismatchNotSaved(planName(view, mismatch.expected))}
          </span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void dismiss()}>
            {t.dismiss}
          </Button>
        </div>
      )}
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
            disabled={busy || restart.busy || !!switching || !view.app}
            onClick={() => restart.start(true)}
          >
            {t.restore}
          </Button>
        </div>
      )}
      {switchingHere && (
        <SwitchProgressLine initial={restart.busy ? null : switching} onGone={restart.busy ? undefined : onChanged} />
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" disabled={busy} title={t.diagnoseTitle} onClick={() => void diagnose()}>
          {t.diagnose}
        </Button>
      </div>
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
