import { invoke } from "@/lib/tauri.ts";

/*
 * Cầu nối tới `hive-worker context` (spec 029). Kiểu khớp fixture của worker Go
 * (worker/internal/ctxsync/testdata/context-project.json) và contracts/sidecar-cli.md.
 */

export type ContextTargetId = "claude" | "codex" | "gemini" | "antigravity";
export type ContextTargetStatus = "ok" | "stale" | "conflict" | "skipped";

export interface ContextTarget {
  id: ContextTargetId;
  /** Tương đối với thư mục dự án. */
  path: string;
  status: ContextTargetStatus;
  /** Tiếng Việt, do sidecar viết. */
  reason: string | null;
  conflict?: { file: string; source: string } | null;
}

export interface ContextHub {
  syncedAt: string | null;
  items: number;
  omitted: { budget: number; secret: number };
  lastError: string | null;
}

export interface ContextProject {
  key: string;
  projectId: string | null;
  folder: string;
  enabled: boolean;
  sourceTokens: number;
  blockTokens: number;
  targets: ContextTarget[];
  hub: ContextHub | null;
  autoSync: { enabled: boolean; minutes: number; source: "machine" | "policy" };
  /** true khi optimize.lock đang bận nên sidecar không ghi. */
  locked?: boolean;
}

/** Kết quả của `context enable`: kèm bản nháp chuyển từ chia sẻ memory kiểu cũ khi có. */
export interface ContextEnabled extends ContextProject {
  migration?: ContextMigration;
}

export interface ContextMigration {
  draft: string;
  files: string[];
}

export interface ContextStatus {
  projects: ContextProject[];
}

export interface ContextDisabled {
  removed: string[];
  trashed: string[];
}

/** Memory đã duyệt của dự án, lấy từ hub (qua hub_tool) rồi đưa cho sidecar. */
export interface HubSnapshot {
  projectId: string;
  items: { id: string; kind: string; pinned: boolean; createdAt: string; content: string }[];
}

export type ContextKeep = "file" | "source";

const TARGET_IDS: readonly string[] = ["claude", "codex", "gemini", "antigravity"];
const TARGET_STATUSES: readonly string[] = ["ok", "stale", "conflict", "skipped"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

function isContextTarget(v: unknown): v is ContextTarget {
  if (!isRecord(v)) return false;
  const conflict = v.conflict;
  return (
    typeof v.id === "string" &&
    TARGET_IDS.includes(v.id) &&
    typeof v.path === "string" &&
    typeof v.status === "string" &&
    TARGET_STATUSES.includes(v.status) &&
    isStringOrNull(v.reason) &&
    (conflict === undefined ||
      conflict === null ||
      (isRecord(conflict) && typeof conflict.file === "string" && typeof conflict.source === "string"))
  );
}

function isContextHub(v: unknown): v is ContextHub {
  if (!isRecord(v)) return false;
  const omitted = v.omitted;
  return (
    isStringOrNull(v.syncedAt) &&
    isNumber(v.items) &&
    isRecord(omitted) &&
    isNumber(omitted.budget) &&
    isNumber(omitted.secret) &&
    isStringOrNull(v.lastError)
  );
}

/** Kiểm hình dữ liệu sidecar trả về trước khi giao diện dùng; test so với fixture của Go. */
export function isContextProject(v: unknown): v is ContextProject {
  if (!isRecord(v)) return false;
  const auto = v.autoSync;
  return (
    typeof v.key === "string" &&
    isStringOrNull(v.projectId) &&
    typeof v.folder === "string" &&
    typeof v.enabled === "boolean" &&
    isNumber(v.sourceTokens) &&
    isNumber(v.blockTokens) &&
    Array.isArray(v.targets) &&
    v.targets.every(isContextTarget) &&
    (v.hub === null || isContextHub(v.hub)) &&
    isRecord(auto) &&
    typeof auto.enabled === "boolean" &&
    isNumber(auto.minutes) &&
    (auto.source === "machine" || auto.source === "policy") &&
    (v.locked === undefined || typeof v.locked === "boolean")
  );
}

export const contextStatus = (project?: string) =>
  invoke<ContextStatus>("context_status", { project: project ?? null });
export const contextEnable = (folder: string, projectId?: string) =>
  invoke<ContextEnabled>("context_enable", { folder, projectId: projectId ?? null });
export const contextDisable = (project: string) => invoke<ContextDisabled>("context_disable", { project });
export const contextSaveSource = (project: string, content: string) =>
  invoke<ContextProject>("context_save_source", { project, content });
export const contextSync = (project: string, hub?: HubSnapshot | null, policy?: unknown) =>
  invoke<ContextProject>("context_sync", { project, hub: hub ?? null, policy: policy ?? null });
export const contextResolve = (project: string, target: ContextTargetId, keep: ContextKeep) =>
  invoke<ContextProject>("context_resolve", { project, target, keep });
export const contextMigrate = (project: string, apply = false) =>
  invoke<ContextMigration>("context_migrate", { project, apply });
