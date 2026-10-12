import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { Pill } from "@/components/ui/pill.tsx";
import { type CliAccount, cliAccounts, type Engine } from "@/lib/agent.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";
import { claudeUsage, type Limit, sessionStats } from "@/lib/usage.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{
  title: string;
  lead: string;
  close: string;
  isDefault: string;
  makeDefault: string;
  connected: string;
  notConnected: string;
  notInstalled: string;
  sessionLeft: string;
  weekLeft: string;
  used: (pct: number, resets: string) => string;
  noQuota: string;
  claudeMeta: (method: string, email: string, version: string) => string;
  codexMeta: (method: string, version: string) => string;
  notSignedIn: (cli: string) => string;
  howTo: string;
  installHint: string;
  toSetup: string;
  recheck: string;
  loading: string;
  note: string;
}> = {
  vi: {
    title: "Tài khoản AI trên máy này",
    lead: "App dùng CLI đã đăng nhập bằng gói thuê bao của bạn để đọc code và viết tài liệu. Lượt dùng tính vào gói của bạn, không vào ngân sách tổ chức.",
    close: "Đóng",
    isDefault: "Mặc định",
    makeDefault: "Đặt mặc định",
    connected: "Đã kết nối",
    notConnected: "Chưa kết nối",
    notInstalled: "Chưa cài",
    sessionLeft: "Phiên hiện tại còn",
    weekLeft: "Tuần này còn",
    used: (pct, resets) => `đã dùng ${pct}%${resets ? ` · làm mới ${resets}` : ""}`,
    noQuota: "Chưa đọc được hạn mức của gói.",
    claudeMeta: (method, email, version) => `Gói ${method}${email ? ` · ${email}` : ""} · Claude Code ${version}`,
    codexMeta: (method, version) => `Đăng nhập bằng ${method} · codex-cli ${version}`,
    notSignedIn: (cli) => `Chưa đăng nhập · ${cli}`,
    howTo: "Mở Terminal, chạy lệnh dưới đây và đăng nhập bằng gói của bạn trong trình duyệt, rồi bấm Kiểm tra lại.",
    installHint: "CLI chưa cài trên máy.",
    toSetup: "Cài ở màn Môi trường",
    recheck: "Kiểm tra lại",
    loading: "Đang hỏi CLI trên máy…",
    note: "Đăng nhập theo luồng của từng CLI trên máy này. App không đọc hay lưu mật khẩu, token của gói; tài liệu và code không rời máy trừ khi bạn đẩy lên hub.",
  },
  en: {
    title: "AI accounts on this machine",
    lead: "The app uses CLIs signed in with your own subscription to read code and write docs. Usage counts against your plan, not the organization budget.",
    close: "Close",
    isDefault: "Default",
    makeDefault: "Make default",
    connected: "Connected",
    notConnected: "Not connected",
    notInstalled: "Not installed",
    sessionLeft: "Session left",
    weekLeft: "Week left",
    used: (pct, resets) => `${pct}% used${resets ? ` · resets ${resets}` : ""}`,
    noQuota: "Could not read the plan limits yet.",
    claudeMeta: (method, email, version) => `${method} plan${email ? ` · ${email}` : ""} · Claude Code ${version}`,
    codexMeta: (method, version) => `Logged in using ${method} · codex-cli ${version}`,
    notSignedIn: (cli) => `Not signed in · ${cli}`,
    howTo: "Open a terminal, run the command below and sign in with your plan in the browser, then press Check again.",
    installHint: "The CLI is not installed on this machine.",
    toSetup: "Install it on the Environment screen",
    recheck: "Check again",
    loading: "Asking the CLIs on this machine…",
    note: "Sign-in uses each CLI’s own flow on this machine. The app never reads or stores plan passwords or tokens; docs and code stay on this machine until you push to the hub.",
  },
};

const LOOK: Record<Engine, { name: string; mark: string; logo: string; login: string }> = {
  claude: { name: "Claude", mark: "C", logo: "bg-[#F5E6DD] text-[#B4532A]", login: "claude auth login" },
  codex: { name: "ChatGPT (Codex)", mark: "O", logo: "bg-[#E5E7EB] text-[#111827]", login: "codex login" },
};

interface Quota {
  session: Limit | null;
  week: Limit | null;
}

function Bar({ label, limit, resets }: { label: string; limit: Limit; resets: string }) {
  const t = useT(text);
  const left = Math.max(0, Math.round(100 - limit.percent));
  return (
    <div className="flex flex-col gap-1">
      <span className="flex justify-between text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{left}%</span>
      </span>
      <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full", left < 30 ? "bg-warning" : "bg-primary")} style={{ width: `${left}%` }} />
      </div>
      <span className="text-[11px] text-muted-foreground">{t.used(Math.round(limit.percent), resets)}</span>
    </div>
  );
}

/**
 * Hộp "Tài khoản AI" của màn Tài liệu (AppDocs.dc.html, specs/008-desktop-v2 T012): CLI nào đã đăng nhập, hạn mức
 * phiên và tuần của gói, agent mặc định. Đăng nhập do CLI tự làm trong Terminal; app chỉ hỏi trạng thái.
 */
export function AiAccountsDialog({
  open,
  onOpenChange,
  defaultEngine,
  onDefault,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultEngine: Engine;
  onDefault: (engine: Engine) => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const [accounts, setAccounts] = useState<CliAccount[] | null>(null);
  const [quota, setQuota] = useState<Partial<Record<Engine, Quota>>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setAccounts(null);
    setError(null);
    try {
      const list = await cliAccounts();
      setAccounts(list);
      const next: Partial<Record<Engine, Quota>> = {};
      await Promise.all(
        list
          .filter((a) => a.loggedIn)
          .map(async (a) => {
            try {
              if (a.engine === "claude") {
                const u = await claudeUsage();
                next.claude = { session: u.session, week: u.week };
              } else {
                const s = await sessionStats("codex", "");
                next.codex = { session: s.primary, week: s.secondary };
              }
            } catch {
              /* Không đọc được hạn mức thì vẫn hiện tài khoản. */
            }
          }),
      );
      setQuota(next);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const resets = (engine: Engine, limit: Limit | null) =>
    !limit?.resets
      ? ""
      : engine === "codex"
        ? new Date(Number(limit.resets) * 1000).toLocaleString(lang, {
            weekday: "short",
            hour: "numeric",
            minute: "2-digit",
          })
        : limit.resets;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3.5 p-5 sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-[17px] font-semibold">{t.title}</DialogTitle>
          <DialogDescription className="text-[13px]">{t.lead}</DialogDescription>
        </DialogHeader>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        {!accounts && !error && <p className="text-[13px] text-muted-foreground">{t.loading}</p>}
        {accounts?.map((a) => {
          const look = LOOK[a.engine];
          const q = quota[a.engine];
          const isDefault = defaultEngine === a.engine;
          const meta = !a.installed
            ? t.installHint
            : !a.loggedIn
              ? t.notSignedIn(`${a.engine === "claude" ? "Claude Code" : "codex-cli"} ${a.version ?? ""}`.trim())
              : a.engine === "claude"
                ? t.claudeMeta([a.method, a.plan].filter(Boolean).join(" ") || "Claude", a.email ?? "", a.version ?? "")
                : t.codexMeta(a.method ?? "ChatGPT", a.version ?? "");
          return (
            <section
              key={a.engine}
              aria-label={look.name}
              className={cn(
                "flex min-w-0 flex-col gap-2.5 rounded-[10px] border p-3",
                isDefault && a.loggedIn && "border-primary",
              )}
            >
              <div className="flex items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex size-8.5 shrink-0 items-center justify-center rounded-lg font-mono text-sm font-semibold",
                    look.logo,
                  )}
                >
                  {look.mark}
                </span>
                <span className="flex min-w-0 flex-1 flex-col leading-snug">
                  <span className="flex items-center gap-1.5">
                    <strong className="font-semibold">{look.name}</strong>
                    {isDefault && a.loggedIn && (
                      <Pill tone="sel" className="h-5 text-[11.5px]">
                        {t.isDefault}
                      </Pill>
                    )}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{meta}</span>
                </span>
                <Pill dot tone={a.loggedIn ? "ok" : "neutral"} className="h-5 text-[11.5px]">
                  {a.loggedIn ? t.connected : a.installed ? t.notConnected : t.notInstalled}
                </Pill>
              </div>
              {a.loggedIn && (
                <>
                  {q?.session || q?.week ? (
                    <div className="grid grid-cols-2 gap-2.5 text-xs">
                      {q.session && (
                        <Bar label={t.sessionLeft} limit={q.session} resets={resets(a.engine, q.session)} />
                      )}
                      {q.week && <Bar label={t.weekLeft} limit={q.week} resets={resets(a.engine, q.week)} />}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t.noQuota}</p>
                  )}
                  {!isDefault && (
                    <div className="flex justify-end">
                      <Button variant="outline" size="sm" onClick={() => onDefault(a.engine)}>
                        {t.makeDefault}
                      </Button>
                    </div>
                  )}
                </>
              )}
              {a.installed && !a.loggedIn && (
                <div className="flex flex-col gap-1.5 rounded-lg bg-muted px-3 py-2.5 text-[12.5px]">
                  <span className="text-muted-foreground">{t.howTo}</span>
                  <span className="rounded-md border bg-card px-2 py-1 font-mono text-[11.5px]">{look.login}</span>
                  <div className="flex justify-end">
                    <Button size="sm" onClick={() => void load()}>
                      {t.recheck}
                    </Button>
                  </div>
                </div>
              )}
              {!a.installed && (
                <a href="#/setup" className="self-end text-xs text-primary">
                  {t.toSetup}
                </a>
              )}
            </section>
          );
        })}
        <p className="text-xs text-muted-foreground">{t.note}</p>
      </DialogContent>
    </Dialog>
  );
}
