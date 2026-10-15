import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@/lib/tauri.ts";

/**
 * Nhóm Git theo dõi (specs/016-desktop-git-groups): kết nối GitLab/GitHub bằng đăng nhập Git hoặc token cá nhân và các group clone về máy,
 * đọc và ghi qua `hive-worker gitgroups` (gitgroups.json cạnh worker.json). Token nhập tay nằm trong keychain; giao diện chỉ gửi
 * token một lần lúc thêm kết nối và không bao giờ nhận lại.
 */
export type GitKind = "gitlab" | "github";

export interface GitHost {
  id: string;
  kind: GitKind;
  url: string;
  name: string;
  username?: string | undefined;
  authMode?: "git" | "token" | undefined;
}

export interface GitRepo {
  path: string;
  name: string;
  defaultBranch?: string | undefined;
  archived?: boolean | undefined;
  empty?: boolean | undefined;
  httpUrl: string;
  sshUrl?: string | undefined;
  webUrl?: string | undefined;
}

export interface GitGroup {
  id: string;
  hostId: string;
  path: string;
  root: string;
  protocol: "https" | "ssh";
  filter?: string | undefined;
  includeArchived?: boolean | undefined;
  excluded?: string[] | undefined;
  autoFetchMinutes?: number | undefined;
  lastAutoFetchAt?: string | undefined;
  listedAt?: string | undefined;
  repos: GitRepo[];
}

export type RepoState = "missing" | "clean" | "dirty" | "ahead" | "behind" | "diverged" | "error";

export interface RepoStatus {
  path: string;
  dir?: string | undefined;
  state: RepoState;
  branch?: string | undefined;
  ahead?: number | undefined;
  behind?: number | undefined;
  reason?: string | undefined;
}

export interface GitGroups {
  path: string;
  hosts: GitHost[];
  groups: GitGroup[];
  host?: GitHost | undefined;
  group?: GitGroup | undefined;
  items?: string[] | undefined;
  status?: RepoStatus[] | undefined;
}

export type SyncAction = "clone" | "fetch" | "pull";
export type SyncResult = "done" | "unchanged" | "skipped" | "failed" | "cancelled";

/** Một dòng tiến độ của sidecar; `exit` là sidecar dừng mà không báo xong (kèm lỗi). */
export interface SyncEvent {
  type: "start" | "repo" | "done" | "exit";
  action?: SyncAction | undefined;
  total?: number | undefined;
  done?: number | undefined;
  path?: string | undefined;
  result?: SyncResult | undefined;
  message?: string | undefined;
  status?: RepoStatus | undefined;
  summary?: Partial<Record<SyncResult, number>> | undefined;
}

export interface GroupPatch {
  root?: string;
  protocol?: "https" | "ssh";
  filter?: string;
  includeArchived?: boolean;
  excluded?: string[];
  autoFetchMinutes?: number;
}

export const gitGroups = () => invoke<GitGroups>("git_groups");
export const addGitHost = (
  kind: GitKind,
  url: string,
  name: string,
  token: string,
  authMode: "git" | "token" = "token",
) => invoke<GitGroups>("git_host_add", { kind, url, name, token, authMode });
export const probeGitHost = (kind: GitKind, url: string) =>
  invoke<{ username: string }>("git_host_probe", { kind, url });
export const discoverGitHosts = () => invoke<{ kind: GitKind; url: string }[]>("git_host_discover");
export const removeGitHost = (id: string) => invoke<GitGroups>("git_host_remove", { id });
export const suggestGroups = (host: string, search: string) => invoke<GitGroups>("git_group_suggest", { host, search });
export const addGitGroup = (g: {
  host: string;
  path: string;
  root: string;
  protocol: "https" | "ssh";
  filter: string;
  includeArchived: boolean;
}) => invoke<GitGroups>("git_group_add", g);
export const updateGitGroup = (id: string, patch: GroupPatch) => invoke<GitGroups>("git_group_update", { id, patch });
export const refreshGitGroup = (g: GitGroup) => invoke<GitGroups>("git_group_refresh", { id: g.id, host: g.hostId });
export const removeGitGroup = (id: string) => invoke<GitGroups>("git_group_remove", { id });
export const groupStatus = (id: string) => invoke<GitGroups>("git_group_status", { id });
/** Chạy thao tác cho cả nhóm; trả id, tiến độ đến qua useSyncJob. */
export const startSync = (g: GitGroup, action: SyncAction) =>
  invoke<string>("git_group_sync", { id: g.id, host: g.hostId, action });
export const cancelSync = (jobId: string) => invoke<void>("git_group_cancel", { jobId });
export const openFolder = (folder: string) => invoke<void>("open_folder", { folder });
export const openFolderTerminal = (folder: string) => invoke<void>("open_folder_terminal", { folder });

/** Repo được chọn theo cách worker chọn (gitgroups.Selected): bỏ archived trừ khi bật, lọc regex, bỏ repo đã bỏ chọn. */
export function selectedRepos(g: GitGroup): GitRepo[] {
  let re: RegExp | null = null;
  try {
    re = g.filter ? new RegExp(g.filter) : null;
  } catch {
    return [];
  }
  const excluded = new Set((g.excluded ?? []).map((p) => p.toLowerCase()));
  return g.repos.filter(
    (r) => !(r.archived && !g.includeArchived) && !excluded.has(r.path.toLowerCase()) && (!re || re.test(r.path)),
  );
}

/** Repo khớp bộ lọc (archived, regex) mà chưa tính phần bỏ chọn: danh sách để người dùng chọn/bỏ. */
export function candidateRepos(g: GitGroup): GitRepo[] {
  return selectedRepos({ ...g, excluded: [] });
}

/** Lỗi regex của bộ lọc, null khi hợp lệ; regex của Go (RE2) chặt hơn, worker vẫn kiểm lần nữa. */
export function filterError(filter: string): string | null {
  try {
    new RegExp(filter);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Tiến độ của một lượt chạy, gom từ các sự kiện. */
export interface SyncJob {
  action?: SyncAction | undefined;
  total: number;
  done: number;
  finished: boolean;
  results: Record<string, { result: SyncResult; message?: string | undefined }>;
  statuses: Record<string, RepoStatus>;
  summary?: Partial<Record<SyncResult, number>> | undefined;
  error?: string | undefined;
}

export const emptyJob = (): SyncJob => ({ total: 0, done: 0, finished: false, results: {}, statuses: {} });
// Cùng một đối tượng cho mọi lần đọc khi chưa có sự kiện: useSyncExternalStore so bằng ===.
const NO_EVENTS = emptyJob();

export function applySync(job: SyncJob, e: SyncEvent): SyncJob {
  switch (e.type) {
    case "start":
      return { ...job, action: e.action, total: e.total ?? 0 };
    case "repo": {
      if (!e.path) return job;
      const results = { ...job.results, [e.path]: { result: e.result ?? "done", message: e.message } };
      const statuses = e.status ? { ...job.statuses, [e.path]: e.status } : job.statuses;
      return { ...job, done: e.done ?? job.done + 1, total: e.total ?? job.total, results, statuses };
    }
    case "done":
      return { ...job, finished: true, done: e.done ?? job.done, summary: e.summary };
    case "exit":
      return { ...job, finished: true, error: e.message || "Worker dừng giữa chừng." };
  }
  return job;
}

// Sự kiện có thể đến trước khi git_group_sync trả id (repo đầu xong rất nhanh): gom theo id ở cấp module, màn đọc theo
// id khi đã biết.
let jobs: Record<string, SyncJob> = {};
const listeners = new Set<() => void>();
let listeningOn: unknown = null;

function ensureListening() {
  const tauri = window.__TAURI__;
  if (!tauri?.event || listeningOn === tauri) return;
  listeningOn = tauri;
  tauri.event
    .listen<{ jobId: string; event: SyncEvent }>("git-groups:event", (e) => {
      const { jobId, event } = e.payload;
      jobs = { ...jobs, [jobId]: applySync(jobs[jobId] ?? emptyJob(), event) };
      for (const l of listeners) l();
    })
    .catch(() => {
      listeningOn = null;
    });
}

/** Tiến độ của lượt chạy jobId; null khi chưa chạy. */
export function useSyncJob(jobId: string | null): SyncJob | null {
  useEffect(ensureListening, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (jobId ? (jobs[jobId] ?? NO_EVENTS) : null),
  );
}

/** Lượt tự fetch định kỳ xong (Rust): đọc lại trạng thái. */
export function useAutoFetched(onChange: () => void) {
  useEffect(() => {
    const tauri = window.__TAURI__;
    if (!tauri?.event) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void tauri.event
      .listen("git-groups:changed", () => onChange())
      .then((un) => {
        if (gone) un();
        else stop = un;
      })
      .catch(() => {});
    return () => {
      gone = true;
      stop?.();
    };
  }, [onChange]);
}
