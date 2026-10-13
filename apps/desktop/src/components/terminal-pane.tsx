import "@xterm/xterm/css/xterm.css";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { FolderOpenIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type CliProfile, cliProfiles } from "@/lib/agent.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { attachTerminal, closeTerminal, openTerminal, selectTerminal, type TermCli, useTerminals } from "@/lib/pty.ts";
import { cn } from "@/lib/utils.ts";

const CLIS: { id: TermCli; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity (agy)" },
  { id: "shell", label: "Shell" },
];

const text: Dict<{
  run: string;
  plan: string;
  planDefault: string;
  bypass: string;
  bypassHint: string;
  open: string;
  newTab: string;
  tabs: string;
  close: (label: string) => string;
  empty: string;
  needFolder: string;
  openFolder: string;
  bypassTitle: string;
  bypassLead: string;
  bypassFlag: Record<Exclude<TermCli, "shell">, string>;
  bypassOk: string;
  cancel: string;
  starting: string;
  exited: string;
  failed: string;
  bypassBadge: string;
  signedOut: string;
}> = {
  vi: {
    run: "Chạy",
    plan: "Gói agent",
    planDefault: "Đăng nhập mặc định của CLI",
    bypass: "Bỏ hỏi quyền",
    bypassHint: "CLI tự chạy lệnh và sửa file không hỏi lại. App hỏi xác nhận mỗi lần mở.",
    open: "Mở terminal",
    newTab: "Terminal mới",
    tabs: "Terminal đang mở",
    close: (label) => `Đóng ${label}`,
    empty:
      "Mở terminal để chạy Claude Code, Codex, Antigravity hay shell ngay trong thư mục dự án, bằng đăng nhập của gói agent bạn chọn.",
    needFolder: "Chọn thư mục dự án để mở terminal trong thư mục đó.",
    openFolder: "Mở thư mục…",
    bypassTitle: "Mở CLI không hỏi quyền?",
    bypassLead:
      "CLI sẽ tự chạy lệnh, sửa và xoá file mà không hỏi lại. Lệnh sai hay lời nhắc độc giấu trong code có thể làm mất dữ liệu hoặc lộ bí mật trên máy. Chỉ bật khi thư mục đã commit hoặc có bản sao.",
    bypassFlag: {
      claude: "Claude Code chạy với --dangerously-skip-permissions.",
      codex: "Codex chạy với --dangerously-bypass-approvals-and-sandbox: không hỏi và không có sandbox.",
      antigravity: "Antigravity chạy với --dangerously-skip-permissions.",
    },
    bypassOk: "Mở không hỏi quyền",
    cancel: "Huỷ",
    starting: "đang mở",
    exited: "đã thoát",
    failed: "lỗi",
    bypassBadge: "bỏ hỏi quyền",
    signedOut: "chưa đăng nhập",
  },
  en: {
    run: "Run",
    plan: "Agent plan",
    planDefault: "CLI's default sign-in",
    bypass: "Skip permission prompts",
    bypassHint: "The CLI runs commands and edits files without asking. The app asks you to confirm each time.",
    open: "Open terminal",
    newTab: "New terminal",
    tabs: "Open terminals",
    close: (label) => `Close ${label}`,
    empty:
      "Open a terminal to run Claude Code, Codex, Antigravity or a shell right in the project folder, signed in with the agent plan you pick.",
    needFolder: "Choose a project folder to open a terminal in it.",
    openFolder: "Open folder…",
    bypassTitle: "Open the CLI without permission prompts?",
    bypassLead:
      "The CLI will run commands, edit and delete files without asking. A wrong command or a prompt injection hidden in the code can lose data or leak secrets on this machine. Only do this when the folder is committed or backed up.",
    bypassFlag: {
      claude: "Claude Code runs with --dangerously-skip-permissions.",
      codex: "Codex runs with --dangerously-bypass-approvals-and-sandbox: no prompts and no sandbox.",
      antigravity: "Antigravity runs with --dangerously-skip-permissions.",
    },
    bypassOk: "Open without prompts",
    cancel: "Cancel",
    starting: "starting",
    exited: "exited",
    failed: "error",
    bypassBadge: "no prompts",
    signedOut: "signed out",
  },
};

const select = "h-6.5 rounded-md border bg-background text-xs disabled:opacity-50";

function TermView({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current ? attachTerminal(id, ref.current) : undefined), [id]);
  return <div ref={ref} data-testid="terminal" className="min-h-0 flex-1 overflow-hidden bg-card px-2 py-1.5" />;
}

/**
 * Tab Terminal của khung phải màn Tài liệu: chọn CLI và gói agent, mở PTY trong thư mục dự án (lib/pty.ts). Nhiều
 * terminal là tab con; đóng tab thì giết tiến trình.
 */
export function TerminalPane({ folder, onPickFolder }: { folder: string; onPickFolder: () => void }) {
  const t = useT(text);
  const { sessions, active } = useTerminals();
  const [cli, setCli] = useState<TermCli>("claude");
  const [planId, setPlanId] = useState("");
  const [bypass, setBypass] = useState(false);
  const [asking, setAsking] = useState(false);
  const [plans, setPlans] = useState<CliProfile[]>([]);

  useEffect(() => {
    // Bản worker cũ chưa có `accounts --json` thì chỉ có đăng nhập mặc định.
    cliProfiles().then(
      (p) => setPlans(p.accounts),
      () => setPlans([]),
    );
  }, []);

  const shell = cli === "shell";
  const cliPlans = plans.filter((p) => p.cli === cli);
  const current = sessions.find((s) => s.key === active) ?? null;

  function pickCli(next: TermCli) {
    setCli(next);
    setPlanId("");
    setBypass(false);
  }

  function open() {
    if (!folder) return;
    const plan = cliPlans.find((p) => p.id === planId);
    const name = CLIS.find((c) => c.id === cli)?.label ?? cli;
    openTerminal({
      cli,
      planId: plan?.id ?? null,
      bypass: bypass && !shell,
      folder,
      label: plan ? `${name} · ${plan.label || plan.id}` : name,
    });
    // Mỗi terminal bỏ hỏi quyền phải xác nhận lại.
    setBypass(false);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2 text-xs">
        <select
          aria-label={t.run}
          value={cli}
          onChange={(e) => pickCli(e.target.value as TermCli)}
          className={cn(select, "max-w-36")}
        >
          {CLIS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          aria-label={t.plan}
          value={planId}
          disabled={shell}
          onChange={(e) => setPlanId(e.target.value)}
          className={cn(select, "max-w-44")}
        >
          <option value="">{t.planDefault}</option>
          {cliPlans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label || p.id}
              {p.email ? ` · ${p.email}` : ""}
              {p.loggedIn === false ? ` (${t.signedOut})` : ""}
            </option>
          ))}
        </select>
        <label
          title={t.bypassHint}
          className={cn("inline-flex items-center gap-1.5", shell ? "opacity-50" : "cursor-pointer")}
        >
          <input
            type="checkbox"
            checked={bypass}
            disabled={shell}
            onChange={(e) => (e.target.checked ? setAsking(true) : setBypass(false))}
            className="size-3.5 cursor-pointer accent-destructive"
          />
          {t.bypass}
        </label>
        <span className="flex-1" />
        <Button size="sm" className="h-6.5" disabled={!folder} onClick={open}>
          <PlusIcon aria-hidden="true" />
          {sessions.length ? t.newTab : t.open}
        </Button>
      </div>

      {sessions.length > 0 && (
        <div
          role="tablist"
          aria-label={t.tabs}
          className="flex gap-0.5 overflow-x-auto border-b bg-muted/50 px-1.5 pt-1"
        >
          {sessions.map((s) => (
            <div
              key={s.key}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1 rounded-t-md border border-b-0 pr-1 pl-2 text-xs",
                s.key === active ? "bg-card font-semibold text-foreground" : "border-transparent text-muted-foreground",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={s.key === active}
                onClick={() => selectTerminal(s.key)}
                className="inline-flex max-w-48 cursor-pointer items-center gap-1.5"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    s.status === "running"
                      ? "bg-success"
                      : s.status === "failed"
                        ? "bg-destructive"
                        : s.status === "starting"
                          ? "animate-pulse bg-muted-foreground"
                          : "bg-muted-foreground",
                  )}
                />
                <span className="truncate">{s.label}</span>
                {s.bypass && <span className="font-normal text-destructive">· {t.bypassBadge}</span>}
                {s.status !== "running" && (
                  <span className="font-normal text-muted-foreground">
                    · {s.status === "starting" ? t.starting : s.status === "failed" ? t.failed : t.exited}
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-label={t.close(s.label)}
                title={t.close(s.label)}
                onClick={() => closeTerminal(s.key)}
                className="inline-flex size-4.5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <XIcon aria-hidden="true" className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {current ? (
        <TermView key={current.key} id={current.key} />
      ) : (
        <div className="flex flex-col items-start gap-2.5 px-3.5 py-3">
          <p className="text-sm text-muted-foreground">{folder ? t.empty : t.needFolder}</p>
          {folder ? (
            <Button size="sm" onClick={open}>
              <PlusIcon aria-hidden="true" />
              {t.open}
            </Button>
          ) : (
            <Button size="sm" onClick={onPickFolder}>
              <FolderOpenIcon aria-hidden="true" />
              {t.openFolder}
            </Button>
          )}
        </div>
      )}

      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.bypassTitle}</DialogTitle>
            <DialogDescription>{t.bypassLead}</DialogDescription>
          </DialogHeader>
          {!shell && <p className="font-mono text-xs text-destructive">{t.bypassFlag[cli]}</p>}
          <DialogActions>
            <Button type="button" variant="outline" onClick={() => setAsking(false)}>
              {t.cancel}
            </Button>
            <Button
              type="button"
              variant="destructive-solid"
              onClick={() => {
                setBypass(true);
                setAsking(false);
              }}
            >
              {t.bypassOk}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}
