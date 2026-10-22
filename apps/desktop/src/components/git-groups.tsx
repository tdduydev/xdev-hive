import { useQuery } from "@tanstack/react-query";
import type { ScmConnection } from "@xdev-hive/contracts";
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
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { FolderOpenIcon, PlusIcon, RefreshCwIcon, SettingsIcon, SquareTerminalIcon } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { OpenAgentButton } from "@/components/open-agent-dialog.tsx";
import { useLinkedAccount } from "@/lib/account.ts";
import { pickFolder, shortPath } from "@/lib/folder.ts";
import {
  addGitGroup,
  addGitHost,
  cancelSync,
  candidateRepos,
  discoverGitHosts,
  filterError,
  type GitGroup,
  type GitGroups,
  type GitHost,
  type GitKind,
  gitGroups,
  groupStatus,
  openFolder,
  openFolderTerminal,
  probeGitHost,
  type RepoState,
  type RepoStatus,
  refreshGitGroup,
  removeGitGroup,
  removeGitHost,
  type SyncAction,
  type SyncResult,
  selectedRepos,
  startSync,
  suggestGroups,
  updateGitGroup,
  useAutoFetched,
  useSyncJob,
} from "@/lib/git-groups.ts";
import { api } from "@/lib/hub-query.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

type T = {
  title: string;
  lead: string;
  addHost: string;
  addGroup: string;
  loading: string;
  noHosts: string;
  noGroups: string;
  hosts: string;
  removeHost: (name: string) => string;
  kind: string;
  url: string;
  urlHint: (kind: GitKind) => string;
  name: string;
  token: string;
  authMode: string;
  gitLogin: string;
  gitLoginHint: string;
  gitAccount: (name: string) => string;
  checkingGit: string;
  discovered: string;
  tokenHint: (kind: GitKind) => string;
  fromOrg: string;
  fromOrgNone: string;
  fromOrgNote: string;
  hostTitle: string;
  hostLead: string;
  save: string;
  cancel: string;
  groupTitle: string;
  groupLead: string;
  host: string;
  groupPath: (kind: GitKind) => string;
  suggest: string;
  root: string;
  pickRoot: string;
  protocol: string;
  filter: string;
  filterHint: string;
  includeArchived: string;
  repoCount: (selected: number, total: number) => string;
  cloneMissing: string;
  fetch: string;
  pullAll: string;
  refreshList: string;
  settings: string;
  unfollow: string;
  unfollowLabel: (path: string) => string;
  running: (action: SyncAction, done: number, total: number) => string;
  stop: string;
  summary: (s: Partial<Record<SyncResult, number>>) => string;
  states: Record<RepoState, string>;
  results: Record<SyncResult, string>;
  openDir: (path: string) => string;
  openTerm: (path: string) => string;
  cloneTo: (dir: string) => string;
  autoFetch: string;
  autoFetchOff: string;
  autoFetchEvery: (n: number) => string;
  pickRepos: string;
  noRepos: string;
  branch: (b: string) => string;
  ahead: (n: number) => string;
  behind: (n: number) => string;
  listedAt: (when: string) => string;
};

const text: Dict<T> = {
  vi: {
    title: "Nhóm Git theo dõi",
    lead: "Clone và pull cả group GitLab (gồm subgroup) hay org GitHub về một thư mục gốc, theo đường dẫn của repo trên máy chủ. Không cần đăng nhập Hive.",
    addHost: "Thêm kết nối",
    addGroup: "Thêm nhóm",
    loading: "Đang đọc…",
    noHosts: "Chưa có kết nối Git. Dùng đăng nhập Git trên máy hoặc personal access token để theo dõi group.",
    noGroups: "Chưa theo dõi group nào.",
    hosts: "Kết nối",
    removeHost: (n) => `Xoá kết nối ${n}`,
    kind: "Loại",
    url: "Địa chỉ máy chủ",
    urlHint: (k) =>
      k === "gitlab" ? "Để trống là gitlab.com. GitLab tự host: https://git.congty.vn" : "Để trống là github.com.",
    name: "Tên gợi nhớ",
    authMode: "Cách đăng nhập",
    gitLogin: "Dùng đăng nhập Git có sẵn trên máy",
    gitLoginHint:
      "Đọc lại credential helper mỗi lần gọi API; Hive không lưu mật khẩu hay token này. HTTPS dùng Git và helper của máy.",
    gitAccount: (name) => `Tài khoản Git: ${name}`,
    checkingGit: "Đang kiểm tra đăng nhập Git…",
    discovered: "Thêm bằng đăng nhập Git trên máy",
    token: "Personal access token",
    tokenHint: (k) =>
      k === "gitlab"
        ? "Cần quyền read_api và read_repository. Token lưu trong keychain của máy, không ghi ra file."
        : "Cần quyền repo (hoặc fine-grained: Contents read). Token lưu trong keychain của máy, không ghi ra file.",
    fromOrg: "Dùng thông tin kết nối của tổ chức",
    fromOrgNone: "Không dùng",
    fromOrgNote:
      "Chỉ điền sẵn loại, máy chủ và group. Đăng nhập dùng thông tin cá nhân trên máy: hub không gửi token của tổ chức xuống máy.",
    hostTitle: "Thêm kết nối Git",
    hostLead: "App kiểm tra tài khoản với API máy chủ trước khi lưu.",
    save: "Lưu",
    cancel: "Huỷ",
    groupTitle: "Theo dõi group",
    groupLead: "Repo clone vào <thư mục gốc>/<đường dẫn repo>, ví dụ ~/Code/acme/payments/api.",
    host: "Kết nối",
    groupPath: (k) => (k === "gitlab" ? "Đường dẫn group (có thể dán URL)" : "Org hoặc tài khoản"),
    suggest: "Gợi ý",
    root: "Thư mục gốc",
    pickRoot: "Chọn thư mục gốc",
    protocol: "Cách clone",
    filter: "Lọc theo regex (đường dẫn đầy đủ)",
    filterHint: "Ví dụ ^acme/(api|web). Để trống là mọi repo.",
    includeArchived: "Gồm cả repo đã archive",
    repoCount: (s, t) => `${s}/${t} repo được chọn`,
    cloneMissing: "Clone thiếu",
    fetch: "Fetch",
    pullAll: "Pull tất cả",
    refreshList: "Cập nhật danh sách",
    settings: "Cài đặt nhóm",
    unfollow: "Bỏ theo dõi",
    unfollowLabel: (p) => `Bỏ theo dõi ${p} (thư mục đã clone giữ nguyên)`,
    running: (a, d, t) => `Đang ${a === "clone" ? "clone" : a === "fetch" ? "fetch" : "pull"} ${d}/${t} repo…`,
    stop: "Huỷ",
    summary: (s) =>
      `Xong: ${s.done ?? 0} đã chạy, ${s.unchanged ?? 0} không đổi, ${s.skipped ?? 0} bỏ qua, ${s.failed ?? 0} lỗi${s.cancelled ? `, ${s.cancelled} đã huỷ` : ""}.`,
    states: {
      missing: "Chưa clone",
      clean: "Sạch",
      dirty: "Có thay đổi",
      ahead: "Ahead",
      behind: "Behind",
      diverged: "Lệch",
      error: "Lỗi",
    },
    results: {
      done: "Đã chạy",
      unchanged: "Không đổi",
      skipped: "Bỏ qua",
      failed: "Lỗi",
      cancelled: "Đã huỷ",
    },
    openDir: (p) => `Mở thư mục ${p}`,
    openTerm: (p) => `Mở terminal tại ${p}`,
    cloneTo: (d) => `sẽ clone vào ${d}`,
    autoFetch: "Tự fetch",
    autoFetchOff: "Tắt",
    autoFetchEvery: (n) => (n >= 60 ? `Mỗi ${n / 60} giờ` : `Mỗi ${n} phút`),
    pickRepos: "Chọn repo",
    noRepos: "Không có repo nào khớp bộ lọc.",
    branch: (b) => `nhánh ${b}`,
    ahead: (n) => `${n} commit chưa đẩy`,
    behind: (n) => `thiếu ${n} commit`,
    listedAt: (w) => `Danh sách đọc lúc ${w}`,
  },
  en: {
    title: "Tracked Git groups",
    lead: "Clone and pull a whole GitLab group (with subgroups) or GitHub org into one root folder, following each repository's path on the server. No Hive sign-in needed.",
    addHost: "Add connection",
    addGroup: "Add group",
    loading: "Loading…",
    noHosts: "No Git connection yet. Use your Git sign-in or a personal access token to track groups.",
    noGroups: "No tracked groups yet.",
    hosts: "Connections",
    removeHost: (n) => `Remove connection ${n}`,
    kind: "Kind",
    url: "Server address",
    urlHint: (k) =>
      k === "gitlab"
        ? "Leave empty for gitlab.com. Self-hosted GitLab: https://git.company.com"
        : "Leave empty for github.com.",
    name: "Display name",
    authMode: "Sign-in method",
    gitLogin: "Use this machine's existing Git sign-in",
    gitLoginHint:
      "Reads the credential helper for each API call; Hive does not store this password or token. HTTPS uses your Git and helper.",
    gitAccount: (name) => `Git account: ${name}`,
    checkingGit: "Checking Git sign-in…",
    discovered: "Add using this machine's Git sign-in",
    token: "Personal access token",
    tokenHint: (k) =>
      k === "gitlab"
        ? "Needs read_api and read_repository. Stored in this machine's keychain, never in a file."
        : "Needs repo (or fine-grained: Contents read). Stored in this machine's keychain, never in a file.",
    fromOrg: "Use an organization connection",
    fromOrgNone: "None",
    fromOrgNote:
      "Only fills in kind, server and group. Sign-in uses your personal credentials: the hub never sends organization tokens to machines.",
    hostTitle: "Add Git connection",
    hostLead: "The app checks your account with the server API before saving.",
    save: "Save",
    cancel: "Cancel",
    groupTitle: "Track a group",
    groupLead: "Repositories are cloned to <root>/<repository path>, e.g. ~/Code/acme/payments/api.",
    host: "Connection",
    groupPath: (k) => (k === "gitlab" ? "Group path (URL works too)" : "Org or account"),
    suggest: "Suggest",
    root: "Root folder",
    pickRoot: "Choose root folder",
    protocol: "Clone over",
    filter: "Regex filter (full path)",
    filterHint: "E.g. ^acme/(api|web). Empty means every repository.",
    includeArchived: "Include archived repositories",
    repoCount: (s, t) => `${s}/${t} repositories selected`,
    cloneMissing: "Clone missing",
    fetch: "Fetch",
    pullAll: "Pull all",
    refreshList: "Refresh list",
    settings: "Group settings",
    unfollow: "Stop tracking",
    unfollowLabel: (p) => `Stop tracking ${p} (cloned folders stay)`,
    running: (a, d, t) => `Running ${a} on ${d}/${t} repositories…`,
    stop: "Cancel",
    summary: (s) =>
      `Done: ${s.done ?? 0} ran, ${s.unchanged ?? 0} unchanged, ${s.skipped ?? 0} skipped, ${s.failed ?? 0} failed${s.cancelled ? `, ${s.cancelled} cancelled` : ""}.`,
    states: {
      missing: "Not cloned",
      clean: "Clean",
      dirty: "Uncommitted changes",
      ahead: "Ahead",
      behind: "Behind",
      diverged: "Diverged",
      error: "Error",
    },
    results: { done: "Ran", unchanged: "Unchanged", skipped: "Skipped", failed: "Failed", cancelled: "Cancelled" },
    openDir: (p) => `Open folder ${p}`,
    openTerm: (p) => `Open a terminal in ${p}`,
    cloneTo: (d) => `will clone into ${d}`,
    autoFetch: "Auto fetch",
    autoFetchOff: "Off",
    autoFetchEvery: (n) => (n >= 60 ? `Every ${n / 60} h` : `Every ${n} min`),
    pickRepos: "Repositories",
    noRepos: "No repository matches the filter.",
    branch: (b) => `branch ${b}`,
    ahead: (n) => `${n} unpushed commits`,
    behind: (n) => `${n} commits behind`,
    listedAt: (w) => `List read at ${w}`,
  },
};

const STATE_TONE: Record<RepoState, "neutral" | "ok" | "warn" | "bad" | "sel"> = {
  missing: "neutral",
  clean: "ok",
  dirty: "warn",
  ahead: "sel",
  behind: "sel",
  diverged: "warn",
  error: "bad",
};

const AUTO_FETCH = [0, 15, 30, 60, 180];

/** GitHub Enterprise của hub lưu địa chỉ API (…/api/v3); kết nối tại máy cần địa chỉ web. */
const webUrl = (c: ScmConnection) => (c.baseUrl ?? "").replace(/\/api\/v[34]\/?$/, "");

/**
 * Mục Nhóm Git theo dõi của màn Dự án trên máy. Chạy được khi chưa đăng nhập Hive; đã đăng nhập thì form kết nối gợi ý
 * kết nối Git của tổ chức để điền sẵn. Clone xong thì gọi onCloned để danh sách Dự án trên máy đọc lại; fetch/pull xong
 * thì gọi onSynced vì ref của repo đã đổi.
 */
export function GitGroupsSection({
  onCloned,
  onSynced,
}: {
  onCloned: () => void;
  onSynced?: (() => void) | undefined;
}) {
  const t = useT(text);
  const [data, setData] = useState<GitGroups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<"host" | "group" | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await gitGroups());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const hosts = data?.hosts ?? [];
  const byId = new Map(hosts.map((h) => [h.id, h]));

  return (
    <section aria-labelledby="git-groups" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex min-w-72 flex-1 flex-col gap-0.5">
          <h2 id="git-groups" className="text-sm font-semibold">
            {t.title}
          </h2>
          <p className="text-xs text-muted-foreground">{t.lead}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding("host")}>
          <PlusIcon aria-hidden="true" />
          {t.addHost}
        </Button>
        <Button size="sm" variant="outline" disabled={hosts.length === 0} onClick={() => setAdding("group")}>
          <PlusIcon aria-hidden="true" />
          {t.addGroup}
        </Button>
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
      {!data ? (
        <p className="text-sm text-muted-foreground">{t.loading}</p>
      ) : hosts.length === 0 ? (
        <p className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">{t.noHosts}</p>
      ) : (
        <>
          <ul aria-label={t.hosts} className="flex flex-wrap gap-2">
            {hosts.map((h) => (
              <li key={h.id} className="flex items-center gap-2 rounded-lg border bg-card px-2.5 py-1 text-xs">
                <span className="font-medium">{h.name}</span>
                <span className="text-muted-foreground">
                  {h.kind === "gitlab" ? "GitLab" : "GitHub"} · {h.username}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={t.removeHost(h.name)}
                  onClick={async () => {
                    try {
                      setData(await removeGitHost(h.id));
                      setError(null);
                    } catch (e) {
                      setError(errorText(e));
                    }
                  }}
                >
                  ×
                </Button>
              </li>
            ))}
          </ul>
          {data.groups.length === 0 ? (
            <p className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">{t.noGroups}</p>
          ) : (
            data.groups.map((g) => (
              <GroupCard
                key={g.id}
                group={g}
                host={byId.get(g.hostId)}
                t={t}
                onChanged={(next) => setData(next)}
                onRemoved={() => void load()}
                onCloned={onCloned}
                onSynced={onSynced}
                onError={setError}
              />
            ))
          )}
        </>
      )}
      <HostDialog
        open={adding === "host"}
        t={t}
        onClose={() => setAdding(null)}
        onSaved={(next) => {
          setData(next);
          setAdding(null);
        }}
      />
      {adding === "group" && (
        <GroupDialog
          hosts={hosts}
          t={t}
          onClose={() => setAdding(null)}
          onSaved={(next) => {
            setData(next);
            setAdding(null);
          }}
        />
      )}
    </section>
  );
}

function GroupCard({
  group: g,
  host,
  t,
  onChanged,
  onRemoved,
  onCloned,
  onSynced,
  onError,
}: {
  group: GitGroup;
  host: GitHost | undefined;
  t: T;
  onChanged: (next: GitGroups) => void;
  onRemoved: () => void;
  onCloned: () => void;
  onSynced: (() => void) | undefined;
  onError: (e: string | null) => void;
}) {
  const [statuses, setStatuses] = useState<Record<string, RepoStatus>>({});
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const job = useSyncJob(jobId);
  const running = !!jobId && !job?.finished;
  const selected = selectedRepos(g);

  const readStatus = useCallback(async () => {
    try {
      const v = await groupStatus(g.id);
      setStatuses(Object.fromEntries((v.status ?? []).map((s) => [s.path, s])));
    } catch (e) {
      onError(errorText(e));
    }
  }, [g.id, onError]);
  // Đọc lại khi danh sách repo hay bộ lọc đổi (listedAt, excluded…), không chỉ lúc mở màn.
  const shape = `${g.listedAt}|${g.filter}|${g.includeArchived}|${(g.excluded ?? []).join(",")}|${g.root}`;
  useEffect(() => {
    void shape;
    void readStatus();
  }, [readStatus, shape]);
  useAutoFetched(readStatus);

  const finished = job?.finished;
  useEffect(() => {
    if (!finished || !job) return;
    setStatuses((s) => ({ ...s, ...job.statuses }));
    if (job.error) onError(job.error);
    if (job.action === "clone") onCloned();
    // Lượt bị huỷ hay lỗi giữa chừng vẫn có thể đã fetch được vài repo.
    else onSynced?.();
  }, [finished, job, onCloned, onSynced, onError]);

  async function run(action: SyncAction) {
    onError(null);
    try {
      setJobId(await startSync(g, action));
    } catch (e) {
      onError(errorText(e));
    }
  }

  async function change(fn: () => Promise<GitGroups>) {
    setBusy(true);
    try {
      onChanged(await fn());
      onError(null);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const live = { ...statuses, ...(job?.statuses ?? {}) };
  const disabled = running || busy;
  // Thư mục gốc chỉ có thật khi đã clone ít nhất một repo.
  const cloned = selected.some((r) => live[r.path] && live[r.path]?.state !== "missing");

  return (
    <article
      aria-label={g.path}
      className="flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground"
    >
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">
            {g.path} <span className="font-normal text-muted-foreground">· {host?.name ?? "?"}</span>
          </span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {shortPath(g.root)} · {t.repoCount(selected.length, g.repos.length)}
            {g.autoFetchMinutes ? ` · ${t.autoFetch}: ${t.autoFetchEvery(g.autoFetchMinutes)}` : ""}
          </span>
        </span>
        {cloned && <OpenAgentButton name={g.path} folder={g.root} group />}
        <Button size="sm" disabled={disabled} onClick={() => void run("clone")}>
          {t.cloneMissing}
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => void run("fetch")}>
          {t.fetch}
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => void run("pull")}>
          {t.pullAll}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          aria-label={t.refreshList}
          title={g.listedAt ? t.listedAt(new Date(g.listedAt).toLocaleString()) : t.refreshList}
          onClick={() => void change(() => refreshGitGroup(g))}
        >
          <RefreshCwIcon aria-hidden="true" className={cn(busy && "animate-spin")} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t.settings}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <SettingsIcon aria-hidden="true" />
        </Button>
      </header>
      {jobId && job && (
        <div className="flex items-center gap-3 border-b px-4 py-2 text-xs" aria-live="polite">
          {running ? (
            <>
              <progress
                className="h-1.5 flex-1 accent-primary"
                value={job.done}
                max={Math.max(job.total, 1)}
                aria-label={t.running(job.action ?? "pull", job.done, job.total)}
              />
              <span>{t.running(job.action ?? "pull", job.done, job.total)}</span>
              <Button size="xs" variant="outline" onClick={() => void cancelSync(jobId)}>
                {t.stop}
              </Button>
            </>
          ) : (
            <span>{job.summary ? t.summary(job.summary) : job.error}</span>
          )}
        </div>
      )}
      {open && (
        <GroupSettings
          group={g}
          t={t}
          disabled={disabled}
          onChange={(patch) => void change(() => updateGitGroup(g.id, patch))}
          onRemove={() =>
            void (async () => {
              try {
                await removeGitGroup(g.id);
                onRemoved();
              } catch (e) {
                onError(errorText(e));
              }
            })()
          }
        />
      )}
      {selected.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t.noRepos}</p>
      ) : (
        <ul className="max-h-96 divide-y overflow-y-auto">
          {selected.map((r) => {
            const s = live[r.path];
            const result = job?.results[r.path];
            const detail = [
              result?.message !== s?.reason ? result?.message : null,
              s?.reason,
              // Nói rõ chỗ Hive tìm repo, để người đã clone tay thấy ngay vì sao repo vẫn "chưa clone".
              s?.state === "missing" && s.dir ? t.cloneTo(s.dir) : null,
              s?.branch && s.state !== "missing" ? t.branch(s.branch) : null,
              s?.ahead ? t.ahead(s.ahead) : null,
              s?.behind ? t.behind(s.behind) : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={r.path} className="flex flex-wrap items-center gap-2 px-4 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-xs">{r.path}</span>
                  {detail && (
                    <span className="truncate text-xs text-muted-foreground" title={detail}>
                      {detail}
                    </span>
                  )}
                </span>
                {result && <span className="text-xs text-muted-foreground">{t.results[result.result]}</span>}
                {s && (
                  <Pill tone={STATE_TONE[s.state]} small>
                    {t.states[s.state]}
                  </Pill>
                )}
                {s?.dir && s.state !== "missing" && (
                  <>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={t.openDir(r.path)}
                      onClick={() => s.dir && openFolder(s.dir).catch((e) => onError(errorText(e)))}
                    >
                      <FolderOpenIcon aria-hidden="true" />
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={t.openTerm(r.path)}
                      onClick={() => s.dir && openFolderTerminal(s.dir).catch((e) => onError(errorText(e)))}
                    >
                      <SquareTerminalIcon aria-hidden="true" />
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

function GroupSettings({
  group: g,
  t,
  disabled,
  onChange,
  onRemove,
}: {
  group: GitGroup;
  t: T;
  disabled: boolean;
  onChange: (patch: Parameters<typeof updateGitGroup>[1]) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const [filter, setFilter] = useState(g.filter ?? "");
  const bad = filter ? filterError(filter) : null;
  const excluded = new Set((g.excluded ?? []).map((p) => p.toLowerCase()));
  const candidates = candidateRepos(g);
  return (
    <div className="flex flex-col gap-3 border-b bg-muted/40 px-4 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <Label htmlFor={`${id}-filter`}>{t.filter}</Label>
          <Input
            id={`${id}-filter`}
            value={filter}
            aria-invalid={!!bad}
            placeholder="^acme/(api|web)"
            onChange={(e) => setFilter(e.target.value)}
            onBlur={() => !bad && filter !== (g.filter ?? "") && onChange({ filter })}
          />
          <span className={cn("text-xs", bad ? "text-destructive" : "text-muted-foreground")}>
            {bad ?? t.filterHint}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-protocol`}>{t.protocol}</Label>
          <NativeSelect
            id={`${id}-protocol`}
            value={g.protocol}
            disabled={disabled}
            onChange={(e) => onChange({ protocol: e.target.value as "https" | "ssh" })}
          >
            <option value="https">HTTPS</option>
            <option value="ssh">SSH</option>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-auto`}>{t.autoFetch}</Label>
          <NativeSelect
            id={`${id}-auto`}
            value={String(g.autoFetchMinutes ?? 0)}
            disabled={disabled}
            onChange={(e) => onChange({ autoFetchMinutes: Number(e.target.value) })}
          >
            {AUTO_FETCH.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? t.autoFetchOff : t.autoFetchEvery(n)}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <Label>
        <input
          type="checkbox"
          checked={!!g.includeArchived}
          disabled={disabled}
          onChange={(e) => onChange({ includeArchived: e.target.checked })}
        />
        {t.includeArchived}
      </Label>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs font-medium">{t.pickRepos}</legend>
        <div className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
          {candidates.map((r) => (
            <Label key={r.path} className="font-mono text-xs font-normal">
              <input
                type="checkbox"
                checked={!excluded.has(r.path.toLowerCase())}
                disabled={disabled}
                onChange={(e) => {
                  const rest = (g.excluded ?? []).filter((p) => p.toLowerCase() !== r.path.toLowerCase());
                  onChange({ excluded: e.target.checked ? rest : [...rest, r.path] });
                }}
              />
              {r.path}
            </Label>
          ))}
        </div>
      </fieldset>
      <Button size="sm" variant="ghost" className="self-start" aria-label={t.unfollowLabel(g.path)} onClick={onRemove}>
        {t.unfollow}
      </Button>
    </div>
  );
}

function HostDialog({
  open,
  t,
  onClose,
  onSaved,
}: {
  open: boolean;
  t: T;
  onClose: () => void;
  onSaved: (next: GitGroups) => void;
}) {
  const id = useId();
  const account = useLinkedAccount();
  // Tuỳ chọn: tổ chức có kết nối Git thì điền sẵn. Không đăng nhập hay không có quyền xem thì bỏ qua, không báo lỗi.
  const org = useQuery({ ...api.scmConnections.list.queryOptions(), enabled: open && !!account, retry: false });
  const [kind, setKind] = useState<GitKind>("gitlab");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [choice, setChoice] = useState<"git" | "token" | null>(null);
  const [probeTarget, setProbeTarget] = useState({ kind, url });
  useEffect(() => {
    const timer = setTimeout(() => setProbeTarget({ kind, url }), 400);
    return () => clearTimeout(timer);
  }, [kind, url]);
  const probe = useQuery({
    queryKey: ["git-host-probe", probeTarget.kind, probeTarget.url],
    queryFn: () => probeGitHost(probeTarget.kind, probeTarget.url),
    enabled: open,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const detected = probeTarget.kind === kind && probeTarget.url === url && probe.data;
  const authMode = choice ?? (detected ? "git" : "token");
  const discovered = useQuery({
    queryKey: ["git-host-discover"],
    queryFn: discoverGitHosts,
    enabled: open,
    retry: false,
  });

  function address(nextKind: GitKind, nextUrl: string) {
    setKind(nextKind);
    setUrl(nextUrl);
    setChoice(null);
    setToken("");
    setError(null);
  }

  async function quickAdd(candidate: { kind: GitKind; url: string }) {
    setSaving(true);
    address(candidate.kind, candidate.url);
    setChoice("git");
    try {
      const next = await addGitHost(candidate.kind, candidate.url, "", "", "git");
      reset();
      onSaved(next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setChoice(null);
    setUrl("");
    setName("");
    setToken("");
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  async function save() {
    setSaving(true);
    try {
      const next = await addGitHost(kind, url, name, authMode === "git" ? "" : token, authMode);
      reset();
      onSaved(next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
      // Không giữ token trong bộ nhớ của form lâu hơn cần.
      setToken("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !saving && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.hostTitle}</DialogTitle>
          <DialogDescription>{t.hostLead}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {discovered.data && discovered.data.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t.discovered}</span>
              {discovered.data.map((candidate) => (
                <Button
                  key={candidate.url}
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => void quickAdd(candidate)}
                >
                  {candidate.url}
                </Button>
              ))}
            </div>
          )}
          {org.data && org.data.length > 0 && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-org`}>{t.fromOrg}</Label>
              <NativeSelect
                id={`${id}-org`}
                defaultValue=""
                onChange={(e) => {
                  const c = org.data.find((x) => x.id === e.target.value);
                  if (!c) return;
                  address(c.kind, webUrl(c));
                  setName(c.name);
                }}
              >
                <option value="">{t.fromOrgNone}</option>
                {org.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
              <span className="text-xs text-muted-foreground">{t.fromOrgNote}</span>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-kind`}>{t.kind}</Label>
            <NativeSelect id={`${id}-kind`} value={kind} onChange={(e) => address(e.target.value as GitKind, url)}>
              <option value="gitlab">GitLab</option>
              <option value="github">GitHub</option>
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-url`}>{t.url}</Label>
            <Input
              id={`${id}-url`}
              value={url}
              placeholder={kind === "gitlab" ? "https://gitlab.com" : "https://github.com"}
              onChange={(e) => address(kind, e.target.value)}
            />
            <span className="text-xs text-muted-foreground">{t.urlHint(kind)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-name`}>{t.name}</Label>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-auth`}>{t.authMode}</Label>
            <NativeSelect
              id={`${id}-auth`}
              value={authMode}
              disabled={saving}
              onChange={(e) => {
                setChoice(e.target.value as "git" | "token");
                setToken("");
              }}
            >
              <option value="git">{t.gitLogin}</option>
              <option value="token">{t.token}</option>
            </NativeSelect>
            {probe.isFetching && <span role="status">{t.checkingGit}</span>}
            {detected && <span role="status">{t.gitAccount(detected.username)}</span>}
            {authMode === "git" && <span className="text-xs text-muted-foreground">{t.gitLoginHint}</span>}
            {(authMode === "git" || errorText(probe.error).includes("API")) &&
              probe.isError &&
              probeTarget.kind === kind &&
              probeTarget.url === url && <Alert variant="destructive">{errorText(probe.error)}</Alert>}
          </div>
          {authMode === "token" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-token`}>{t.token}</Label>
              <Input
                id={`${id}-token`}
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">{t.tokenHint(kind)}</span>
            </div>
          )}
          {error && <Alert variant="destructive">{error}</Alert>}
          <DialogActions>
            <Button type="button" variant="outline" disabled={saving} onClick={close}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={saving || (authMode === "token" && !token.trim())}>
              {t.save}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GroupDialog({
  hosts,
  t,
  onClose,
  onSaved,
}: {
  hosts: GitHost[];
  t: T;
  onClose: () => void;
  onSaved: (next: GitGroups) => void;
}) {
  const id = useId();
  const [host, setHost] = useState(hosts[0]?.id ?? "");
  const [path, setPath] = useState("");
  const [root, setRoot] = useState("");
  const [protocol, setProtocol] = useState<"https" | "ssh">("https");
  const [filter, setFilter] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const kind = hosts.find((h) => h.id === host)?.kind ?? "gitlab";
  const bad = filter ? filterError(filter) : null;

  async function save() {
    setSaving(true);
    try {
      onSaved(await addGitGroup({ host, path, root, protocol, filter, includeArchived }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.groupTitle}</DialogTitle>
          <DialogDescription>{t.groupLead}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-host`}>{t.host}</Label>
            <NativeSelect id={`${id}-host`} value={host} onChange={(e) => setHost(e.target.value)}>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} ({h.username})
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-path`}>{t.groupPath(kind)}</Label>
            <div className="flex gap-2">
              <Input
                id={`${id}-path`}
                list={`${id}-suggest`}
                value={path}
                placeholder={kind === "gitlab" ? "acme/payments" : "acme"}
                onChange={(e) => setPath(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    setSuggestions((await suggestGroups(host, path)).items ?? []);
                    setError(null);
                  } catch (e) {
                    setError(errorText(e));
                  }
                }}
              >
                {t.suggest}
              </Button>
            </div>
            <datalist id={`${id}-suggest`}>
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-root`}>{t.root}</Label>
            <div className="flex gap-2">
              <Input
                id={`${id}-root`}
                value={root}
                placeholder="/Users/ban/Code"
                onChange={(e) => setRoot(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={t.pickRoot}
                onClick={async () => {
                  const picked = await pickFolder(t.pickRoot).catch(() => null);
                  if (picked) setRoot(picked);
                }}
              >
                <FolderOpenIcon aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-protocol`}>{t.protocol}</Label>
              <NativeSelect
                id={`${id}-protocol`}
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as "https" | "ssh")}
              >
                <option value="https">HTTPS</option>
                <option value="ssh">SSH</option>
              </NativeSelect>
            </div>
            <div className="flex min-w-48 flex-1 flex-col gap-1">
              <Label htmlFor={`${id}-filter`}>{t.filter}</Label>
              <Input
                id={`${id}-filter`}
                value={filter}
                aria-invalid={!!bad}
                onChange={(e) => setFilter(e.target.value)}
              />
              <span className={cn("text-xs", bad ? "text-destructive" : "text-muted-foreground")}>
                {bad ?? t.filterHint}
              </span>
            </div>
          </div>
          <Label>
            <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
            {t.includeArchived}
          </Label>
          {error && <Alert variant="destructive">{error}</Alert>}
          <DialogActions>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={saving || !host || !path.trim() || !root.trim() || !!bad}>
              {t.save}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}
