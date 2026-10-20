import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { Project } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
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
import { Pill } from "@xdev-hive/ui/pill";
import {
  BrushCleaningIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  RefreshCwIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { BranchesSheet, RepoBranchStatus } from "@/components/branches-sheet.tsx";
import { CleanupDialog } from "@/components/cleanup-dialog.tsx";
import { ConnectHive } from "@/components/connect-hive.tsx";
import { GitGroupsSection } from "@/components/git-groups.tsx";
import { useLinkedAccount } from "@/lib/account.ts";
import { folderKey, pickFolder, shortPath } from "@/lib/folder.ts";
import { type BranchStatus, branchStatus } from "@/lib/git-branches.ts";
import { type GitGroups, gitGroups } from "@/lib/git-groups.ts";
import { api, queryClient } from "@/lib/hub-query.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import {
  type BindingState,
  bindingState,
  bindProject,
  filterRepoSections,
  forgetFolder,
  groupLocalRepos,
  importLegacyProjects,
  type LocalProject,
  type LocalProjects,
  localProjects,
  matchLegacy,
  projectRepoLabel,
  projectRepoUrls,
  setProjectFull,
  unbindProject,
} from "@/lib/local-projects.ts";
import { openProjectTerminal } from "@/lib/pty.ts";
import { errorText } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{
  lead: string;
  noAccount: string;
  loading: string;
  refresh: string;
  cleanup: string;
  cleanupHint: string;
  hubProjects: string;
  noProjects: string;
  localOnly: string;
  localOnlyLead: string;
  noLocalOnly: string;
  filter: string;
  filterHint: string;
  noMatch: string;
  repoCount: (n: number) => string;
  states: Record<BindingState, string>;
  pick: string;
  change: string;
  pickTitle: (name: string) => string;
  unbind: string;
  unbindLabel: (name: string) => string;
  terminal: string;
  terminalLabel: (name: string) => string;
  origin: (url: string) => string;
  noOrigin: string;
  full: string;
  fullLabel: (name: string) => string;
  lockedPolicy: string;
  lockedUnknown: string;
  lockedUnbound: string;
  imported: (n: number, bound: number) => string;
  bound: (name: string) => string;
  fullOn: (name: string) => string;
  fullOff: (name: string) => string;
  forget: string;
  forgetLabel: (name: string) => string;
  goneFromHub: string;
  confirmTitle: string;
  confirmLead: (name: string) => string;
  risks: string[];
  confirmWarn: string;
  cancel: string;
  confirm: string;
}> = {
  vi: {
    lead: "Gắn mỗi dự án của hub với thư mục repo trên máy này. Run của dự án đã gắn tạo worktree từ repo đó (nhánh của run hiện trong repo), không chạy trong thư mục bạn đang làm.",
    noAccount: "Kết nối Hive để xem và gắn dự án của bạn trên hub. Repo trên máy bên dưới vẫn quản lý được.",
    loading: "Đang đọc…",
    refresh: "Làm mới",
    cleanup: "Dọn nhánh",
    cleanupHint: "Dọn nhánh đã merge ở mọi repo trên máy",
    hubProjects: "Dự án trên hub",
    noProjects: "Bạn chưa thấy dự án nào trên hub.",
    localOnly: "Repo trên máy chưa có trên hub",
    localOnlyLead:
      "Repo nhập từ app cũ mà chưa khớp dự án nào của hub. Dự án mới tạo trên web của Hive, rồi bấm Làm mới để gắn.",
    noLocalOnly: "Không có repo nào chờ.",
    filter: "Lọc repo trên máy",
    filterHint: "Lọc theo tên, nhóm, thư mục…",
    noMatch: "Không có repo nào khớp.",
    repoCount: (n) => `${n} repo`,
    states: { unbound: "Chưa gắn", bound: "Đã gắn", mismatch: "Remote không khớp", missing: "Thư mục mất" },
    pick: "Chọn thư mục",
    change: "Đổi thư mục",
    pickTitle: (name) => `Chọn thư mục repo của ${name}`,
    unbind: "Bỏ gắn",
    unbindLabel: (name) => `Bỏ gắn ${name}`,
    terminal: "Terminal",
    terminalLabel: (name) => `Mở terminal ở ${name}`,
    origin: (url) => `origin: ${url}`,
    noOrigin: "không có remote origin",
    full: "Cho toàn quyền trên máy này",
    fullLabel: (name) => `Cho toàn quyền trên máy này với ${name}`,
    lockedPolicy: "Tổ chức không cho toàn quyền CLI (Chính sách agent trên web).",
    lockedUnknown: "Chưa đọc được chính sách của tổ chức.",
    lockedUnbound: "Gắn thư mục repo trước.",
    imported: (n, bound) => `Đã nhập ${n} repo từ app cũ, tự gắn ${bound} dự án.`,
    bound: (name) => `Đã gắn ${name}.`,
    fullOn: (name) => `Đã cho toàn quyền với ${name} trên máy này.`,
    fullOff: (name) => `Đã tắt toàn quyền với ${name}.`,
    forget: "Bỏ khỏi danh sách",
    forgetLabel: (name) => `Bỏ ${name} khỏi danh sách`,
    goneFromHub: "Không còn thấy dự án này trên hub.",
    confirmTitle: "Cho toàn quyền trên máy này?",
    confirmLead: (name) =>
      `Run của ${name} trên máy này sẽ chạy CLI không sandbox và không hỏi duyệt, chỉ khi tổ chức cũng cho phép:`,
    risks: [
      "Claude Code: --permission-mode bypassPermissions",
      "Codex: --dangerously-bypass-approvals-and-sandbox (bỏ sandbox)",
      "Gemini CLI: --approval-mode yolo",
      "Antigravity: --dangerously-skip-permissions",
    ],
    confirmWarn:
      "Agent có quyền như tài khoản của bạn trên máy: đọc, sửa, xoá file ngoài worktree, chạy mọi lệnh, dùng mạng và thông tin đăng nhập của bạn. Chỉ bật cho dự án bạn tin mã nguồn và việc giao cho agent.",
    cancel: "Huỷ",
    confirm: "Bật toàn quyền",
  },
  en: {
    lead: "Bind each hub project to a repository folder on this machine. Runs of a bound project create their worktree from that repository (the run's branch shows up there), never in the folder you are working in.",
    noAccount: "Connect to Hive to see and bind your hub projects. The repositories below still work.",
    loading: "Reading…",
    refresh: "Refresh",
    cleanup: "Clean up branches",
    cleanupHint: "Clean up merged branches in every repo on this machine",
    hubProjects: "Hub projects",
    noProjects: "You cannot see any project on the hub yet.",
    localOnly: "Repositories on this machine without a hub project",
    localOnlyLead:
      "Repositories imported from the old app that match no hub project. Create new projects on the Hive web, then press Refresh to bind.",
    noLocalOnly: "Nothing waiting.",
    filter: "Filter repositories on this machine",
    filterHint: "Filter by name, group, folder…",
    noMatch: "No repository matches.",
    repoCount: (n) => `${n} ${n === 1 ? "repository" : "repositories"}`,
    states: { unbound: "Not bound", bound: "Bound", mismatch: "Remote mismatch", missing: "Folder missing" },
    pick: "Choose folder",
    change: "Change folder",
    pickTitle: (name) => `Choose the repository folder of ${name}`,
    unbind: "Unbind",
    unbindLabel: (name) => `Unbind ${name}`,
    terminal: "Terminal",
    terminalLabel: (name) => `Open a terminal in ${name}`,
    origin: (url) => `origin: ${url}`,
    noOrigin: "no origin remote",
    full: "Full permission on this machine",
    fullLabel: (name) => `Full permission on this machine for ${name}`,
    lockedPolicy: "The organization does not allow full CLI permission (Agent policy on the web).",
    lockedUnknown: "Could not read the organization policy.",
    lockedUnbound: "Bind a repository folder first.",
    imported: (n, bound) => `Imported ${n} repositories from the old app and bound ${bound} projects.`,
    bound: (name) => `Bound ${name}.`,
    fullOn: (name) => `Full permission on for ${name} on this machine.`,
    fullOff: (name) => `Full permission off for ${name}.`,
    forget: "Remove from list",
    forgetLabel: (name) => `Remove ${name} from the list`,
    goneFromHub: "This project is no longer visible on the hub.",
    confirmTitle: "Allow full permission on this machine?",
    confirmLead: (name) =>
      `Runs of ${name} on this machine will run the CLI without sandbox and without asking, only if the organization allows it too:`,
    risks: [
      "Claude Code: --permission-mode bypassPermissions",
      "Codex: --dangerously-bypass-approvals-and-sandbox (no sandbox)",
      "Gemini CLI: --approval-mode yolo",
      "Antigravity: --dangerously-skip-permissions",
    ],
    confirmWarn:
      "The agent gets your account's rights on this machine: read, change and delete files outside the worktree, run any command, use the network and your credentials. Only enable it for projects whose code and tasks you trust.",
    cancel: "Cancel",
    confirm: "Allow full permission",
  },
};

const STATE_TONE: Record<BindingState, "neutral" | "ok" | "warn" | "bad"> = {
  unbound: "neutral",
  bound: "ok",
  mismatch: "warn",
  missing: "bad",
};

/**
 * Màn Dự án trên máy (nhóm Máy này, ADR 0020): dự án hub người dùng thấy, thư mục repo đã gắn trên máy, công tắc toàn
 * quyền theo dự án, và repo trên máy chưa có dự án trên hub. Lần đầu mở thì nhập danh sách của app cũ và tự gắn theo
 * remote origin rồi theo tên.
 */
export function ProjectsScreen() {
  return (
    <QueryClientProvider client={queryClient}>
      <ProjectsView />
    </QueryClientProvider>
  );
}

function ProjectsView() {
  const t = useT(text);
  const account = useLinkedAccount();
  const projects = useQuery({ ...api.projects.list.queryOptions({ input: {} }), enabled: !!account });
  const policy = useQuery({ ...api.policies.get.queryOptions(), enabled: !!account });
  const [local, setLocal] = useState<LocalProjects | null>(null);
  const [tracked, setTracked] = useState<GitGroups | null>(null);
  // Vừa nhập danh sách của app cũ: chờ danh sách dự án hub để tự gắn.
  const [imported, setImported] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Project | null>(null);
  // Nhánh, sạch/bẩn, trước/sau của từng repo trên máy (FR-001), theo folderKey; thiếu thì repo không hiện nhánh.
  const [branches, setBranches] = useState<Record<string, BranchStatus>>({});
  const [sheet, setSheet] = useState<{ folder: string; name: string } | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const load = useCallback(async () => {
    // Chỉ để đặt tên mục của repo chưa có trên hub; đọc lỗi thì vẫn gom theo remote, mục Nhóm Git tự báo lỗi.
    void gitGroups().then(setTracked, () => setTracked(null));
    try {
      let list = await localProjects();
      if (!list.exists) {
        list = await importLegacyProjects();
        setImported(list.imported);
      }
      setLocal(list);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Chuỗi thay vì mảng: mảng tạo lại mỗi lần `local` đổi và sẽ bắt đọc lại trạng thái dù danh sách repo không đổi.
  const repoKey = useMemo(
    () => [...new Set((local?.projects ?? []).filter((l) => l.exists && l.isGit).map((l) => l.folder))].join("\n"),
    [local],
  );
  const loadBranches = useCallback(async () => {
    if (repoKey === "") return setBranches({});
    // Sidecar cũ hay lệnh chưa có: màn vẫn dùng được, chỉ không có cột nhánh.
    const list = await branchStatus(repoKey.split("\n")).catch(() => []);
    setBranches(Object.fromEntries(list.map((s) => [folderKey(s.folder), s])));
  }, [repoKey]);
  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  const hubList = projects.data;
  useEffect(() => {
    if (imported === null || !hubList || !local) return;
    setImported(null);
    const matches = matchLegacy(hubList, local.projects);
    void (async () => {
      let last = local;
      for (const m of matches) {
        try {
          last = await bindProject(m.project.id, m.folder, m.project.name, null);
        } catch (e) {
          setError(errorText(e));
        }
      }
      setLocal(last);
      if (imported > 0) setNotice(t.imported(imported, matches.length));
    })();
  }, [imported, hubList, local, t]);

  async function act(id: string, run: () => Promise<LocalProjects>, done?: string) {
    setBusy(id);
    try {
      setLocal(await run());
      setError(null);
      setNotice(done ?? null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function choose(p: Project) {
    const folder = await pickFolder(t.pickTitle(p.name)).catch((e: unknown) => {
      setError(errorText(e));
      return null;
    });
    if (folder)
      await act(p.id, () => bindProject(p.id, folder, p.name, projectRepoUrls(p)[0] ?? null), t.bound(p.name));
  }

  const entries = local?.projects ?? [];
  const byId = new Map(entries.filter((l) => l.projectId).map((l) => [l.projectId, l]));
  const visible = new Set((hubList ?? []).map((p) => p.id));
  const waiting = entries.filter((l) => !l.projectId || (hubList && !visible.has(l.projectId)));
  const allowFull = policy.data?.allowFullPermission;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-72 flex-1 flex-col gap-1">
          <p className="text-sm text-muted-foreground">{t.lead}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={repoKey === ""}
            title={t.cleanupHint}
            onClick={() => setCleaning(true)}
          >
            <BrushCleaningIcon aria-hidden="true" />
            {t.cleanup}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void load();
              void loadBranches();
              void projects.refetch();
              void policy.refetch();
            }}
          >
            <RefreshCwIcon aria-hidden="true" className={cn(projects.isFetching && "animate-spin")} />
            {t.refresh}
          </Button>
        </div>
      </header>
      {(error || projects.error) && <Alert variant="destructive">{error ?? errorText(projects.error)}</Alert>}
      {notice && <Alert>{notice}</Alert>}

      <section aria-labelledby="projects-hub" className="flex flex-col gap-2">
        <h2 id="projects-hub" className="text-sm font-semibold">
          {t.hubProjects}
        </h2>
        <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
          {!account ? (
            <ConnectHive inline note={t.noAccount} />
          ) : !hubList || !local ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">{t.loading}</p>
          ) : hubList.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">{t.noProjects}</p>
          ) : (
            <ul className="divide-y">
              {hubList.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  local={byId.get(p.id)}
                  branch={byId.get(p.id) && branches[folderKey(byId.get(p.id)?.folder ?? "")]}
                  onBranches={(folder) => setSheet({ folder, name: p.name })}
                  t={t}
                  busy={busy === p.id}
                  allowFull={allowFull}
                  onPick={() => void choose(p)}
                  onUnbind={() => void act(p.id, () => unbindProject(p.id))}
                  onFull={(on) =>
                    on ? setConfirming(p) : void act(p.id, () => setProjectFull(p.id, false), t.fullOff(p.name))
                  }
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      <LocalRepoList
        entries={local ? waiting : null}
        tracked={tracked}
        branches={branches}
        onBranches={(l) => setSheet({ folder: l.folder, name: l.name })}
        t={t}
        busy={busy}
        onRemove={(l) =>
          void act(l.projectId || l.folder, () => (l.projectId ? unbindProject(l.projectId) : forgetFolder(l.folder)))
        }
      />

      <GitGroupsSection onCloned={load} />

      {cleaning && (
        <CleanupDialog
          folders={repoKey.split("\n")}
          onClose={() => setCleaning(false)}
          onChanged={() => void loadBranches()}
        />
      )}

      {sheet && (
        <BranchesSheet
          folder={sheet.folder}
          name={sheet.name}
          onClose={() => setSheet(null)}
          onChanged={() => void loadBranches()}
        />
      )}

      <Dialog open={confirming !== null} onOpenChange={(o) => !o && busy === null && setConfirming(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t.confirmTitle}</DialogTitle>
            <DialogDescription>{confirming ? t.confirmLead(confirming.name) : ""}</DialogDescription>
          </DialogHeader>
          <ul className="list-disc pl-5 font-mono text-xs">
            {t.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="text-sm text-destructive">{t.confirmWarn}</p>
          <DialogActions>
            <Button variant="outline" disabled={busy !== null} onClick={() => setConfirming(null)}>
              {t.cancel}
            </Button>
            <Button
              variant="destructive-solid"
              disabled={busy !== null}
              onClick={() => {
                const p = confirming;
                if (!p) return;
                void act(p.id, () => setProjectFull(p.id, true), t.fullOn(p.name)).then(() => setConfirming(null));
              }}
            >
              {t.confirm}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Repo trên máy chưa có trên hub, gom theo namespace của remote (hoặc thư mục cha): clone cả group lớn như ehospital-ai
 * thì danh sách phẳng quá dài, khó đọc. Nhiều mục thì thu gọn, chỉ hiện tên và số repo.
 */
function LocalRepoList({
  entries,
  tracked,
  branches,
  onBranches,
  t,
  busy,
  onRemove,
}: {
  /** null khi chưa đọc xong danh sách trên máy. */
  entries: LocalProject[] | null;
  tracked: GitGroups | null;
  branches: Record<string, BranchStatus>;
  onBranches: (l: LocalProject) => void;
  t: (typeof text)["vi"];
  busy: string | null;
  onRemove: (l: LocalProject) => void;
}) {
  const [query, setQuery] = useState("");
  // Mục đã bấm mở hoặc thu; mục chưa bấm thì mở khi đang lọc hoặc khi chỉ có một mục. Đổi chữ lọc thì bỏ các lần bấm.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const sections = groupLocalRepos(entries ?? [], tracked);
  const shown = filterRepoSections(sections, query);
  const filtering = query.trim() !== "";

  return (
    <section aria-labelledby="projects-local" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex min-w-72 flex-1 flex-col gap-0.5">
          <h2 id="projects-local" className="text-sm font-semibold">
            {t.localOnly}
          </h2>
          <p className="text-xs text-muted-foreground">{t.localOnlyLead}</p>
        </div>
        {/* Còn chữ lọc thì giữ ô để xoá được, dù vừa bỏ bớt repo. */}
        {entries && (entries.length > 1 || query !== "") && (
          <Input
            className="h-7.5 max-w-60 text-sm"
            placeholder={t.filterHint}
            aria-label={t.filter}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen({});
            }}
          />
        )}
      </div>
      <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
        {!entries ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t.loading}</p>
        ) : entries.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t.noLocalOnly}</p>
        ) : shown.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t.noMatch}</p>
        ) : (
          <ul className="divide-y">
            {shown.map((s) => {
              const expanded = open[s.key] ?? (filtering || sections.length === 1);
              const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
              return (
                <li key={s.key}>
                  {/* Khoảng trắng giữa các phần để tên của nút đọc được: "ehospital-ai/his · GitLab FIS 2 repo". */}
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen((o) => ({ ...o, [s.key]: !expanded }))}
                    className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left hover:bg-muted"
                  >
                    <Chevron aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate text-sm font-medium">{s.title}</span>{" "}
                    {s.host && (
                      <>
                        <span className="min-w-0 truncate text-xs text-muted-foreground">· {s.host}</span>{" "}
                      </>
                    )}
                    <Pill className="ml-auto">{t.repoCount(s.repos.length)}</Pill>
                  </button>
                  {expanded && (
                    <ul className="divide-y border-t">
                      {s.repos.map((l) => (
                        <li key={l.projectId || l.folder} className="flex flex-wrap items-center gap-3 py-3 pr-4 pl-10">
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-sm font-medium">{l.name}</span>
                            <span className="truncate font-mono text-xs text-muted-foreground">
                              {shortPath(l.folder)}
                            </span>
                            <span className="truncate text-xs text-muted-foreground">
                              {l.projectId ? t.goneFromHub : l.origin ? t.origin(l.origin) : t.noOrigin}
                            </span>
                            {branches[folderKey(l.folder)] && (
                              <span className="mt-1">
                                <RepoBranchStatus
                                  status={branches[folderKey(l.folder)] as BranchStatus}
                                  name={l.name}
                                  onOpen={() => onBranches(l)}
                                />
                              </span>
                            )}
                          </span>
                          {l.exists && <TerminalButton name={l.name} folder={l.folder} />}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === (l.projectId || l.folder)}
                            aria-label={l.projectId ? t.unbindLabel(l.name) : t.forgetLabel(l.name)}
                            onClick={() => onRemove(l)}
                          >
                            {l.projectId ? t.unbind : t.forget}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Mở màn Terminal ở thư mục dự án, bằng CLI và gói dùng lần cuối ở đó (lib/term-defaults.ts). */
function TerminalButton({ name, folder }: { name: string; folder: string }) {
  const t = useT(text);
  return (
    <Button
      size="sm"
      variant="outline"
      aria-label={t.terminalLabel(name)}
      onClick={() => {
        openProjectTerminal(folder);
        location.hash = "#/terminal";
      }}
    >
      <SquareTerminalIcon aria-hidden="true" />
      {t.terminal}
    </Button>
  );
}

function ProjectRow({
  project: p,
  local,
  branch,
  onBranches,
  t,
  busy,
  allowFull,
  onPick,
  onUnbind,
  onFull,
}: {
  project: Project;
  local: LocalProject | undefined;
  branch: BranchStatus | undefined;
  onBranches: (folder: string) => void;
  t: (typeof text)["vi"];
  busy: boolean;
  allowFull: boolean | undefined;
  onPick: () => void;
  onUnbind: () => void;
  onFull: (on: boolean) => void;
}) {
  const state = bindingState(p, local);
  const reasonId = useId();
  const locked =
    allowFull === undefined ? t.lockedUnknown : !allowFull ? t.lockedPolicy : !local ? t.lockedUnbound : null;
  // Tổ chức cấm thì công tắc hiện tắt dù máy đã bật: worker không chạy toàn quyền.
  const on = !!local?.fullPermission && allowFull === true;
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{p.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{p.key}</span>
          </span>
          <span className="truncate text-xs text-muted-foreground">{projectRepoLabel(p)}</span>
        </span>
        <Pill tone={STATE_TONE[state]}>{t.states[state]}</Pill>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-xs">{local ? shortPath(local.folder) : "—"}</span>
          {state === "mismatch" && (
            <span className="truncate text-xs text-warning">{local?.origin ? t.origin(local.origin) : t.noOrigin}</span>
          )}
          {local && branch && (
            <span className="mt-1">
              <RepoBranchStatus status={branch} name={p.name} onOpen={() => onBranches(local.folder)} />
            </span>
          )}
        </span>
        {local?.exists && <TerminalButton name={p.name} folder={local.folder} />}
        <Button size="sm" variant="outline" disabled={busy} aria-label={t.pickTitle(p.name)} onClick={onPick}>
          <FolderOpenIcon aria-hidden="true" />
          {local ? t.change : t.pick}
        </Button>
        {local && (
          <Button size="sm" variant="ghost" disabled={busy} aria-label={t.unbindLabel(p.name)} onClick={onUnbind}>
            {t.unbind}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t.fullLabel(p.name)}
          aria-describedby={locked ? reasonId : undefined}
          disabled={busy || locked !== null}
          onClick={() => onFull(!on)}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            on ? "bg-destructive" : "bg-input",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "block size-4 rounded-full bg-background shadow-sm transition-transform",
              on ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
        <span className="text-sm">{t.full}</span>
        {locked && (
          <span id={reasonId} className="text-xs text-muted-foreground">
            {locked}
          </span>
        )}
      </div>
    </li>
  );
}
