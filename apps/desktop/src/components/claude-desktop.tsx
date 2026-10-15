import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { AppWindowIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cleanupDesktopCache,
  type DesktopProfile,
  type DesktopProfiles,
  desktopProfiles,
  formatBytes,
  openClaudeDesktop,
  resetDesktopProfile,
} from "@/lib/claude-desktop.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

/** Đọc lại để thấy Claude Desktop vừa mở hay vừa tắt (PID); rẻ: chỉ đọc danh sách gói và dung lượng thư mục. */
export const DESKTOP_POLL_MS = 10_000;
/** App cần vài giây mới có tiến trình sau khi `open` trả về. */
export const DESKTOP_SETTLE_MS = 4000;

const text: Dict<{
  open: string;
  firstLogin: string;
  running: string;
  runningTitle: (pid: number) => string;
  size: (total: string, cache: string) => string;
  clean: string;
  cleanTitle: string;
  closeFirst: string;
  reset: string;
  resetTitle: string;
  resetBody: (plan: string) => string;
  resetConfirm: string;
  cancel: string;
  opened: (plan: string) => string;
  openedFirst: (plan: string) => string;
  already: (plan: string) => string;
  cleaned: (freed: string) => string;
  resetDone: (plan: string) => string;
}> = {
  vi: {
    open: "Claude Desktop",
    firstLogin: "Đăng nhập Claude Desktop cho gói này",
    running: "Đang mở",
    runningTitle: (pid) => `Claude Desktop của gói đang chạy (PID ${pid})`,
    size: (total, cache) => `Hồ sơ ${total} · cache ${cache}`,
    clean: "Dọn cache",
    cleanTitle: "Xoá cache của hồ sơ Claude Desktop này; vẫn giữ đăng nhập",
    closeFirst: "Thoát Claude Desktop của gói này trước (Cmd+Q)",
    reset: "Xoá hồ sơ",
    resetTitle: "Xoá hồ sơ Claude Desktop của gói?",
    resetBody: (plan) =>
      `Hồ sơ Claude Desktop riêng của ${plan} (đăng nhập, lịch sử trên máy, cache) sẽ bị xoá; lần mở sau phải đăng nhập lại. Claude Desktop thường của bạn và gói CLI không bị đụng tới.`,
    resetConfirm: "Xoá hồ sơ",
    cancel: "Huỷ",
    opened: (plan) => `Đã mở Claude Desktop bằng hồ sơ của ${plan}.`,
    openedFirst: (plan) =>
      `Đã mở Claude Desktop cho ${plan}: đăng nhập một lần bằng tài khoản Claude của gói này, các lần sau mở thẳng vào tài khoản đó. Lần đầu macOS có thể hỏi quyền dùng khoá "Claude Safe Storage" trong Keychain: chọn Luôn cho phép.`,
    already: (plan) => `Claude Desktop của ${plan} đang mở: chuyển sang cửa sổ đó bằng Dock hoặc Cmd+Tab.`,
    cleaned: (freed) => `Đã dọn ${freed} cache.`,
    resetDone: (plan) => `Đã xoá hồ sơ Claude Desktop của ${plan}.`,
  },
  en: {
    open: "Claude Desktop",
    firstLogin: "Sign in to Claude Desktop for this plan",
    running: "Open",
    runningTitle: (pid) => `This plan's Claude Desktop is running (PID ${pid})`,
    size: (total, cache) => `Profile ${total} · cache ${cache}`,
    clean: "Clean cache",
    cleanTitle: "Delete this Claude Desktop profile's cache; keeps the sign-in",
    closeFirst: "Quit this plan's Claude Desktop first (Cmd+Q)",
    reset: "Delete profile",
    resetTitle: "Delete this plan's Claude Desktop profile?",
    resetBody: (plan) =>
      `The separate Claude Desktop profile of ${plan} (sign-in, local history, cache) will be deleted; you sign in again next time. Your regular Claude Desktop and the CLI plan are not touched.`,
    resetConfirm: "Delete profile",
    cancel: "Cancel",
    opened: (plan) => `Opened Claude Desktop with ${plan}'s profile.`,
    openedFirst: (plan) =>
      `Opened Claude Desktop for ${plan}: sign in once with this plan's Claude account; later it opens straight into that account. The first time macOS may ask to use the "Claude Safe Storage" Keychain item: choose Always Allow.`,
    already: (plan) => `${plan}'s Claude Desktop is already open: switch to it from the Dock or with Cmd+Tab.`,
    cleaned: (freed) => `Cleaned ${freed} of cache.`,
    resetDone: (plan) => `Deleted ${plan}'s Claude Desktop profile.`,
  },
};

/**
 * Hồ sơ Claude Desktop của mọi gói Claude, đọc lại định kỳ để thấy app mở hay tắt. Lỗi (worker cũ, ngoài Tauri) thì
 * trả null và màn không hiện phần Claude Desktop.
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

/** Dòng Claude Desktop trên thẻ một gói Claude: mở (hay đăng nhập lần đầu), đang mở, dung lượng, dọn cache, xoá hồ sơ. */
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
  const lang = useLang();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirming, setConfirming] = useState(false);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (settle.current && clearTimeout(settle.current)), []);

  const running = profile.pid !== null;
  const canOpen = !!view.app;

  async function run(job: () => Promise<void>) {
    setBusy(true);
    try {
      await job();
    } catch (e) {
      setNotice({ tone: "bad", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const open = () =>
    run(async () => {
      const opened = await openClaudeDesktop(profile.id);
      if (opened.already) {
        setNotice({ tone: "info", text: t.already(plan) });
        return;
      }
      setNotice({ tone: "ok", text: profile.used ? t.opened(plan) : t.openedFirst(plan) });
      settle.current = setTimeout(() => onChanged(), DESKTOP_SETTLE_MS);
    });

  const clean = () =>
    run(async () => {
      const freed = await cleanupDesktopCache(profile.id);
      setNotice({ tone: "ok", text: t.cleaned(formatBytes(freed, lang)) });
      onChanged();
    });

  const reset = () =>
    run(async () => {
      setConfirming(false);
      await resetDesktopProfile(profile.id);
      onChanged();
      setNotice({ tone: "ok", text: t.resetDone(plan) });
    });

  return (
    <div data-claude-desktop={profile.id} className="flex flex-col gap-1 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !canOpen}
          title={view.note ?? undefined}
          onClick={() => void open()}
        >
          <AppWindowIcon aria-hidden="true" />
          {profile.used ? t.open : t.firstLogin}
        </Button>
        {running && (
          <Pill tone="ok" title={t.runningTitle(profile.pid ?? 0)}>
            {t.running}
          </Pill>
        )}
        {profile.used && (
          <>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={profile.dir}>
              {t.size(formatBytes(profile.bytes, lang), formatBytes(profile.cacheBytes, lang))}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || running || profile.cacheBytes === 0}
              title={running ? t.closeFirst : t.cleanTitle}
              onClick={() => void clean()}
            >
              {t.clean}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={busy || running}
              title={running ? t.closeFirst : undefined}
              onClick={() => setConfirming(true)}
            >
              {t.reset}
            </Button>
          </>
        )}
      </div>
      {!canOpen && view.note && <span className="text-xs text-muted-foreground">{view.note}</span>}
      {notice && (
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
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{t.resetTitle}</DialogTitle>
          <DialogDescription>{t.resetBody(plan)}</DialogDescription>
          <DialogActions>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {t.cancel}
            </Button>
            <Button variant="destructive-solid" onClick={() => void reset()}>
              {t.resetConfirm}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}
