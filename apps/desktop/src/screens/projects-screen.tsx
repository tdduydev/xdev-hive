import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { Project, ProjectCreateInput, ProjectCreateResult } from "@xdev-hive/contracts";
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
import { Label } from "@xdev-hive/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { FolderOpenIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { useLinkedAccount } from "@/lib/account.ts";
import { pickFolder, shortPath } from "@/lib/folder.ts";
import { api, queryClient } from "@/lib/hub-query.tsx";
import { hub } from "@/lib/hub-rpc.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import {
  type BindingState,
  bindingState,
  bindProject,
  connectionFor,
  forgetFolder,
  importLegacyProjects,
  type LocalProject,
  type LocalProjects,
  localProjects,
  matchLegacy,
  projectRepoLabel,
  projectRepoUrls,
  repoHost,
  setProjectFull,
  suggestKey,
  unbindProject,
} from "@/lib/local-projects.ts";
import { errorText, invoke } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{
  lead: string;
  noAccount: string;
  loading: string;
  refresh: string;
  hubProjects: string;
  noProjects: string;
  localOnly: string;
  localOnlyLead: string;
  noLocalOnly: string;
  states: Record<BindingState, string>;
  pick: string;
  change: string;
  pickTitle: (name: string) => string;
  unbind: string;
  unbindLabel: (name: string) => string;
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
  create: string;
  createLabel: (name: string) => string;
  forget: string;
  forgetLabel: (name: string) => string;
  goneFromHub: string;
  confirmTitle: string;
  confirmLead: (name: string) => string;
  risks: string[];
  confirmWarn: string;
  cancel: string;
  confirm: string;
  createTitle: (name: string) => string;
  createLead: string;
  noRemote: string;
  noConnection: (host: string) => string;
  openGit: string;
  system: string;
  key: string;
  name: string;
  protect: string;
  approvals: string;
  approvalsHint: string;
  webhook: string;
  createCheck: string;
  checking: string;
  planTitle: string;
  planLead: (key: string) => string;
  planBack: string;
  planWarnings: string;
  createSubmit: string;
  creating: string;
  created: (name: string) => string;
}> = {
  vi: {
    lead: "Gắn mỗi dự án của hub với thư mục repo trên máy này. Run của dự án đã gắn tạo worktree từ repo đó (nhánh của run hiện trong repo), không chạy trong thư mục bạn đang làm.",
    noAccount: "Liên kết tài khoản ở thẻ người dùng góc dưới bên trái để xem dự án của bạn trên hub.",
    loading: "Đang đọc…",
    refresh: "Làm mới",
    hubProjects: "Dự án trên hub",
    noProjects: "Bạn chưa thấy dự án nào trên hub.",
    localOnly: "Repo trên máy chưa có trên hub",
    localOnlyLead: "Repo nhập từ app cũ mà chưa khớp dự án nào của hub.",
    noLocalOnly: "Không có repo nào chờ.",
    states: { unbound: "Chưa gắn", bound: "Đã gắn", mismatch: "Remote không khớp", missing: "Thư mục mất" },
    pick: "Chọn thư mục",
    change: "Đổi thư mục",
    pickTitle: (name) => `Chọn thư mục repo của ${name}`,
    unbind: "Bỏ gắn",
    unbindLabel: (name) => `Bỏ gắn ${name}`,
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
    create: "Tạo dự án trên hub",
    createLabel: (name) => `Tạo dự án trên hub từ repo ${name}`,
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
    createTitle: (name) => `Tạo dự án trên hub từ ${name}`,
    createLead: "Hub nối dự án với repo này (remote origin), commit file mẫu cho agent rồi máy này gắn thư mục.",
    noRemote: "Repo chưa có remote origin dạng https hoặc ssh; thêm origin rồi thử lại.",
    noConnection: (host) =>
      `Tổ chức chưa có kết nối Git cho ${host}. Quản trị tổ chức thêm kết nối ở trang Kết nối Git trên web rồi quay lại.`,
    openGit: "Mở trang Kết nối Git",
    system: "Hệ thống",
    key: "Project key",
    name: "Tên dự án",
    protect: "Bảo vệ nhánh chính",
    approvals: "Số người duyệt",
    approvalsHint: "Số người phải duyệt PR trước khi merge vào nhánh chính; 0 là không cần.",
    webhook: "Thêm webhook",
    createCheck: "Kiểm tra trước",
    checking: "Đang kiểm tra…",
    planTitle: "Kiểm tra xong, chưa tạo gì",
    planLead: (key) => `Khi bấm Tạo dự án, hub sẽ làm lần lượt các bước sau cho ${key}:`,
    planBack: "Quay lại sửa",
    planWarnings: "Cảnh báo",
    createSubmit: "Tạo dự án",
    creating: "Đang tạo…",
    created: (name) => `Đã tạo dự án ${name} trên hub và gắn thư mục.`,
  },
  en: {
    lead: "Bind each hub project to a repository folder on this machine. Runs of a bound project create their worktree from that repository (the run's branch shows up there), never in the folder you are working in.",
    noAccount: "Link your account from the user card at the bottom left to see your hub projects.",
    loading: "Reading…",
    refresh: "Refresh",
    hubProjects: "Hub projects",
    noProjects: "You cannot see any project on the hub yet.",
    localOnly: "Repositories on this machine without a hub project",
    localOnlyLead: "Repositories imported from the old app that match no hub project.",
    noLocalOnly: "Nothing waiting.",
    states: { unbound: "Not bound", bound: "Bound", mismatch: "Remote mismatch", missing: "Folder missing" },
    pick: "Choose folder",
    change: "Change folder",
    pickTitle: (name) => `Choose the repository folder of ${name}`,
    unbind: "Unbind",
    unbindLabel: (name) => `Unbind ${name}`,
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
    create: "Create hub project",
    createLabel: (name) => `Create a hub project from repository ${name}`,
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
    createTitle: (name) => `Create a hub project from ${name}`,
    createLead:
      "The hub links the project to this repository (origin remote), commits the agent templates, then this machine binds the folder.",
    noRemote: "The repository has no https or ssh origin remote; add one and try again.",
    noConnection: (host) =>
      `The organization has no Git connection for ${host}. An organization admin adds one on the Git connections page of the web, then come back.`,
    openGit: "Open Git connections",
    system: "System",
    key: "Project key",
    name: "Project name",
    protect: "Protect the default branch",
    approvals: "Required approvals",
    approvalsHint: "Reviewers that must approve a PR before it merges into the default branch; 0 means none.",
    webhook: "Add a webhook",
    createCheck: "Check first",
    checking: "Checking…",
    planTitle: "Checked, nothing created yet",
    planLead: (key) => `When you press Create project, the hub runs these steps for ${key}:`,
    planBack: "Back to edit",
    planWarnings: "Warnings",
    createSubmit: "Create project",
    creating: "Creating…",
    created: (name) => `Created project ${name} on the hub and bound the folder.`,
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
  // Vừa nhập danh sách của app cũ: chờ danh sách dự án hub để tự gắn.
  const [imported, setImported] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Project | null>(null);
  const [creating, setCreating] = useState<LocalProject | null>(null);

  const load = useCallback(async () => {
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
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void load();
            void projects.refetch();
            void policy.refetch();
          }}
        >
          <RefreshCwIcon aria-hidden="true" className={cn(projects.isFetching && "animate-spin")} />
          {t.refresh}
        </Button>
      </header>
      {(error || projects.error) && <Alert variant="destructive">{error ?? errorText(projects.error)}</Alert>}
      {notice && <Alert>{notice}</Alert>}

      <section aria-labelledby="projects-hub" className="flex flex-col gap-2">
        <h2 id="projects-hub" className="text-sm font-semibold">
          {t.hubProjects}
        </h2>
        <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
          {!account ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">{t.noAccount}</p>
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

      <section aria-labelledby="projects-local" className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 id="projects-local" className="text-sm font-semibold">
            {t.localOnly}
          </h2>
          <p className="text-xs text-muted-foreground">{t.localOnlyLead}</p>
        </div>
        <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
          {!local ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">{t.loading}</p>
          ) : waiting.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">{t.noLocalOnly}</p>
          ) : (
            <ul className="divide-y">
              {waiting.map((l) => (
                <li key={l.projectId || l.folder} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{l.name}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">{shortPath(l.folder)}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {l.projectId ? t.goneFromHub : l.origin ? t.origin(l.origin) : t.noOrigin}
                    </span>
                  </span>
                  {!l.projectId && account && (
                    <Button size="sm" aria-label={t.createLabel(l.name)} onClick={() => setCreating(l)}>
                      {t.create}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === (l.projectId || l.folder)}
                    aria-label={l.projectId ? t.unbindLabel(l.name) : t.forgetLabel(l.name)}
                    onClick={() =>
                      void act(l.projectId || l.folder, () =>
                        l.projectId ? unbindProject(l.projectId) : forgetFolder(l.folder),
                      )
                    }
                  >
                    {l.projectId ? t.unbind : t.forget}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

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

      {creating && (
        <CreateProjectDialog
          repo={creating}
          t={t}
          onClose={() => setCreating(null)}
          onCreated={(list, name) => {
            setLocal(list);
            setCreating(null);
            setNotice(t.created(name));
            void projects.refetch();
          }}
        />
      )}
    </div>
  );
}

function ProjectRow({
  project: p,
  local,
  t,
  busy,
  allowFull,
  onPick,
  onUnbind,
  onFull,
}: {
  project: Project;
  local: LocalProject | undefined;
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
        </span>
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

function CreateProjectDialog({
  repo,
  t,
  onClose,
  onCreated,
}: {
  repo: LocalProject;
  t: (typeof text)["vi"];
  onClose: () => void;
  onCreated: (list: LocalProjects, name: string) => void;
}) {
  const systems = useQuery(api.systems.list.queryOptions({ input: {} }));
  const connections = useQuery(api.scmConnections.list.queryOptions());
  const [systemId, setSystemId] = useState("");
  const [key, setKey] = useState(() => suggestKey(repo.name));
  const [name, setName] = useState(repo.name);
  const [protect, setProtect] = useState(true);
  const [approvals, setApprovals] = useState("1");
  const [webhook, setWebhook] = useState(true);
  const [plan, setPlan] = useState<{ input: ProjectCreateInput; res: ProjectCreateResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mỗi lần mở hộp thoại một khoá: bấm lại sau lỗi mạng không tạo trùng dự án.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const ids = { system: useId(), key: useId(), name: useId(), approvals: useId() };

  const host = repoHost(repo.origin);
  const connection = connections.data ? connectionFor(connections.data, host) : undefined;
  const system = systemId || systems.data?.[0]?.id || "";
  const blocked = !host ? t.noRemote : connections.data && !connection ? t.noConnection(host) : null;

  // Gọi dry-run như form web: hub chỉ kiểm quyền và trả kế hoạch, người dùng xem rồi mới tạo.
  async function check() {
    if (!connection || !repo.origin || !system) return;
    const count = Number(approvals);
    if (!approvals.trim() || !Number.isInteger(count) || count < 0 || count > 6) {
      setError(t.approvalsHint);
      return;
    }
    const input: ProjectCreateInput = {
      systemId: system,
      key: key.trim(),
      name: name.trim(),
      repo: { mode: "existing", connectionId: connection.id, url: repo.origin },
      protection: { protectDefault: protect, requiredApprovals: count },
      webhook,
      idempotencyKey,
      dryRun: true,
    };
    setBusy(true);
    setError(null);
    try {
      const res = await hub.projects.create(input);
      // Hub cũ không biết dryRun sẽ tạo luôn dự án: gắn thư mục thay vì bắt tạo lại.
      if (!res.dryRun && res.projectId) await bind(res.projectId);
      else setPlan({ input, res });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function bind(projectId: string) {
    onCreated(await bindProject(projectId, repo.folder, name.trim(), repo.origin ?? null), name.trim());
  }

  async function create() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const res = await hub.projects.create({ ...plan.input, dryRun: false });
      if (!res.projectId) throw new Error(t.noRemote);
      await bind(res.projectId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.createTitle(repo.name)}</DialogTitle>
          <DialogDescription>{t.createLead}</DialogDescription>
        </DialogHeader>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {repo.origin ? t.origin(repo.origin) : t.noOrigin}
        </p>
        {(error || systems.error || connections.error) && (
          <Alert variant="destructive">{error ?? errorText(systems.error ?? connections.error)}</Alert>
        )}
        {plan ? (
          <div className="grid gap-3">
            <p className="text-sm font-medium">{t.planTitle}</p>
            <p className="text-sm text-muted-foreground">{t.planLead(plan.input.key)}</p>
            <ol className="m-0 grid list-decimal gap-1 pl-5 text-sm">
              {plan.res.steps.map((step) => (
                <li key={`${step.kind}-${step.target ?? ""}`}>
                  {step.title}
                  {step.target && <span className="font-mono text-xs text-muted-foreground"> {step.target}</span>}
                </li>
              ))}
            </ol>
            {plan.res.warnings.length > 0 && (
              <ul
                aria-label={t.planWarnings}
                className="m-0 grid list-none gap-1 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning"
              >
                {plan.res.warnings.map((w) => (
                  <li key={w.code}>{w.message}</li>
                ))}
              </ul>
            )}
          </div>
        ) : blocked ? (
          <div className="flex flex-col items-start gap-2">
            <Alert>{blocked}</Alert>
            {host && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void invoke("open_hub_page", { path: "/admin/git" }).catch((e) => setError(errorText(e)))
                }
              >
                {t.openGit}
              </Button>
            )}
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.system}>{t.system}</Label>
              <NativeSelect id={ids.system} value={system} onChange={(e) => setSystemId(e.target.value)}>
                {(systems.data ?? []).map((s) => (
                  <NativeSelectOption key={s.id} value={s.id}>
                    {s.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.key}>{t.key}</Label>
              <Input id={ids.key} value={key} onChange={(e) => setKey(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.name}>{t.name}</Label>
              <Input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} />
              {t.protect}
            </label>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.approvals}>{t.approvals}</Label>
              <Input
                id={ids.approvals}
                type="number"
                min={0}
                max={6}
                inputMode="numeric"
                value={approvals}
                disabled={!protect}
                aria-describedby={`${ids.approvals}-hint`}
                onChange={(e) => setApprovals(e.target.value)}
              />
              <span id={`${ids.approvals}-hint`} className="text-xs text-muted-foreground">
                {t.approvalsHint}
              </span>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={webhook} onChange={(e) => setWebhook(e.target.checked)} />
              {t.webhook}
            </label>
          </div>
        )}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={plan ? () => setPlan(null) : onClose}>
            {plan ? t.planBack : t.cancel}
          </Button>
          {plan ? (
            <Button disabled={busy} onClick={() => void create()}>
              {busy ? t.creating : t.createSubmit}
            </Button>
          ) : (
            <Button disabled={busy || !!blocked || !connection || !system} onClick={() => void check()}>
              {busy ? t.checking : t.createCheck}
            </Button>
          )}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
