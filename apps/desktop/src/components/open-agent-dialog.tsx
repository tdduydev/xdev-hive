import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { BotIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { GitActionDialog } from "@/components/git-operation-panel.tsx";
import { type CliProfile, cliProfiles } from "@/lib/agent.ts";
import { shortPath } from "@/lib/folder.ts";
import type { BranchStatus } from "@/lib/git-branches.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { openTerminal, selectFolder, TERM_CLI_LABEL, type TermCli, termLabel } from "@/lib/pty.ts";
import { pickPlan, termDefault, usablePlans } from "@/lib/term-defaults.ts";
import { cn } from "@/lib/utils.ts";

type AgentCli = Exclude<TermCli, "shell">;
const AGENT_CLIS: readonly AgentCli[] = ["claude", "codex", "antigravity"];

type NoPull = "unknown" | "detached" | "noUpstream" | "gone" | "operation";

const text: Dict<{
  open: string;
  openLabel: (name: string) => string;
  title: (name: string) => string;
  run: string;
  plan: string;
  planDefault: string;
  noPlan: string;
  willPull: (branch: string, upstream: string) => string;
  noPull: Record<NoPull, string>;
  lead: string;
  flag: Record<AgentCli, string>;
  cancel: string;
  pullAndOpen: string;
  openNow: string;
}> = {
  vi: {
    open: "Mở bằng agent",
    openLabel: (name) => `Pull rồi mở ${name} bằng agent không hỏi quyền`,
    title: (name) => `Mở ${name} bằng agent`,
    run: "Chạy",
    plan: "Gói agent",
    planDefault: "Đăng nhập mặc định của CLI",
    noPlan: "Máy chưa có gói nào của CLI này đã đăng nhập và đang bật; terminal mở bằng đăng nhập mặc định của CLI.",
    willPull: (branch, upstream) => `Pull ${branch} từ ${upstream} trước khi mở.`,
    noPull: {
      unknown: "Không pull: chưa đọc được nhánh của repo.",
      detached: "Không pull: repo không đứng trên nhánh nào.",
      noUpstream: "Không pull: nhánh chưa theo dõi nhánh remote nào.",
      gone: "Không pull: nhánh remote của nhánh này đã bị xoá.",
      operation: "Không pull: repo đang dở merge hay rebase.",
    },
    lead: "Agent sẽ tự chạy lệnh, sửa và xoá file mà không hỏi lại. Lệnh sai hay lời nhắc độc giấu trong code có thể làm mất dữ liệu hoặc lộ bí mật trên máy. Chỉ mở khi thư mục đã commit hoặc có bản sao.",
    flag: {
      claude: "Claude Code chạy với --dangerously-skip-permissions.",
      codex: "Codex chạy với --dangerously-bypass-approvals-and-sandbox: không hỏi và không có sandbox.",
      antigravity: "Antigravity chạy với --dangerously-skip-permissions.",
    },
    cancel: "Huỷ",
    pullAndOpen: "Pull rồi mở không hỏi quyền",
    openNow: "Mở không hỏi quyền",
  },
  en: {
    open: "Open with agent",
    openLabel: (name) => `Pull, then open ${name} with an agent without permission prompts`,
    title: (name) => `Open ${name} with an agent`,
    run: "Run",
    plan: "Agent plan",
    planDefault: "CLI's default sign-in",
    noPlan: "This machine has no signed-in, enabled plan for this CLI; the terminal uses the CLI's default sign-in.",
    willPull: (branch, upstream) => `Pull ${branch} from ${upstream} before opening.`,
    noPull: {
      unknown: "No pull: could not read the repository's branch.",
      detached: "No pull: the repository is not on a branch.",
      noUpstream: "No pull: the branch does not track a remote branch.",
      gone: "No pull: the remote branch of this branch was deleted.",
      operation: "No pull: a merge or rebase is in progress.",
    },
    lead: "The agent will run commands, edit and delete files without asking. A wrong command or a prompt injection hidden in the code can lose data or leak secrets on this machine. Only open it when the folder is committed or backed up.",
    flag: {
      claude: "Claude Code runs with --dangerously-skip-permissions.",
      codex: "Codex runs with --dangerously-bypass-approvals-and-sandbox: no prompts and no sandbox.",
      antigravity: "Antigravity runs with --dangerously-skip-permissions.",
    },
    cancel: "Cancel",
    pullAndOpen: "Pull, then open without prompts",
    openNow: "Open without prompts",
  },
};

/** Nhánh để pull trước khi mở; lý do khi không pull được (pull sẽ bị sidecar từ chối, mở luôn thay vì kẹt ở lỗi). */
export function pullTarget(status: BranchStatus | undefined): { branch: string; upstream: string } | NoPull {
  if (!status || status.error) return "unknown";
  if (status.operation) return "operation";
  if (status.detached || !status.branch) return "detached";
  if (status.upstreamGone) return "gone";
  if (!status.upstream) return "noUpstream";
  return { branch: status.branch, upstream: status.upstream };
}

const select = "h-8 w-full rounded-md border bg-background px-2 text-sm";

/**
 * Nút "Mở bằng agent" của một dự án: chọn CLI và gói đã đăng nhập, đang bật trên máy, pull nhánh đang đứng rồi mở tab
 * terminal bỏ hỏi quyền ở màn Terminal. Bỏ hỏi quyền phải xác nhận mỗi lần mở, như ô "Bỏ hỏi quyền" của màn Terminal.
 */
export function OpenAgentButton({
  name,
  folder,
  branch,
  onPulled,
}: {
  name: string;
  folder: string;
  branch: BranchStatus | undefined;
  onPulled?: (() => void) | undefined;
}) {
  const t = useT(text);
  const [open, setOpen] = useState(false);
  const [pulling, setPulling] = useState<string | null>(null);
  const [plans, setPlans] = useState<CliProfile[]>([]);
  const [cli, setCli] = useState<AgentCli>("claude");
  const [planId, setPlanId] = useState("");

  useEffect(() => {
    if (!open) return;
    let live = true;
    // Bản worker cũ chưa có `accounts --json` thì chỉ có đăng nhập mặc định.
    cliProfiles().then(
      (p) => live && setPlans(p.accounts),
      () => live && setPlans([]),
    );
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const d = termDefault(folder);
    const next = d && d.cli !== "shell" ? d.cli : "claude";
    setCli(next);
    setPlanId(pickPlan(plans, next, d && d.cli === next ? d.planId : undefined) ?? "");
  }, [open, folder, plans]);

  const cliPlans = usablePlans(plans, cli);
  const target = pullTarget(branch);

  function launch() {
    const plan = cliPlans.find((p) => p.id === planId);
    selectFolder(folder);
    openTerminal({ cli, planId: plan?.id ?? null, bypass: true, folder, label: termLabel(cli, plan) });
    setPulling(null);
    setOpen(false);
    location.hash = "#/terminal";
  }

  function confirm() {
    if (typeof target === "string") return launch();
    setOpen(false);
    setPulling(target.branch);
  }

  return (
    <>
      <Button size="sm" variant="outline" aria-label={t.openLabel(name)} onClick={() => setOpen(true)}>
        <BotIcon aria-hidden="true" />
        {t.open}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="break-words">{t.title(name)}</DialogTitle>
            <DialogDescription className="truncate font-mono text-xs">{shortPath(folder)}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t.run}
              <select
                value={cli}
                onChange={(e) => {
                  const next = e.target.value as AgentCli;
                  setCli(next);
                  setPlanId(pickPlan(plans, next, undefined) ?? "");
                }}
                className={select}
              >
                {AGENT_CLIS.map((c) => (
                  <option key={c} value={c}>
                    {TERM_CLI_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t.plan}
              <select value={planId} onChange={(e) => setPlanId(e.target.value)} className={select}>
                <option value="">{t.planDefault}</option>
                {cliPlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label || p.id}
                    {p.email ? ` · ${p.email}` : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {cliPlans.length === 0 && <p className="text-xs text-muted-foreground">{t.noPlan}</p>}
          <p className={cn("text-sm", typeof target === "string" && "text-muted-foreground")}>
            {typeof target === "string" ? t.noPull[target] : t.willPull(target.branch, target.upstream)}
          </p>
          <p className="text-sm text-muted-foreground">{t.lead}</p>
          <p className="font-mono text-xs text-destructive">{t.flag[cli]}</p>
          <DialogActions>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t.cancel}
            </Button>
            <Button type="button" variant="destructive-solid" onClick={confirm}>
              {typeof target === "string" ? t.openNow : t.pullAndOpen}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
      {pulling && (
        <GitActionDialog
          folder={folder}
          action={{ kind: "pull", branch: pulling }}
          onClose={() => setPulling(null)}
          onDone={(r) => {
            onPulled?.();
            // Pull lệch nhánh rồi merge/rebase dừng vì xung đột: không mở agent lên repo đang dở thao tác.
            if (r.kind === "pull" || r.operation.state === "done") launch();
            else setPulling(null);
          }}
        />
      )}
    </>
  );
}
