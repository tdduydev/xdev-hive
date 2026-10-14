import { readLocalFile } from "@/lib/agent.ts";
import { invoke } from "@/lib/tauri.ts";

export interface MemoryFile {
  cli: string;
  profile: string;
  projectKey?: string;
  projectPath?: string;
  path: string;
  name: string;
  kind: string;
  size: number;
  tokens: number;
  modifiedAt: string;
  flags: { code: string; message: string; related: string[] | null }[] | null;
}

export interface MemorySession {
  cli: string;
  profile: string;
  projectKey: string;
  projectPath?: string;
  sessionTokens: number;
  paths: string[];
}

export interface MemoryEntry {
  id: string;
  op: string;
  createdAt: string;
  trash: boolean;
  paths: string[];
}

export interface SharedMemory {
  key: string;
  projectPath: string;
  sharedDir: string;
  sharedAt: string;
  profiles: { profile: string; configDir: string; memoryDir: string }[];
}

export interface MemoryInventory {
  files: MemoryFile[];
  sessions: MemorySession[];
  warnings: string[];
  shared: SharedMemory[];
  entries: MemoryEntry[];
}

export interface MemoryConflict {
  name: string;
  candidates: { profile: string; path: string; tokens: number; modifiedAt: string }[];
}

export type MemoryOperation =
  | { action: "edit"; path: string; content: string }
  | { action: "delete"; path: string }
  | { action: "restore"; id: string }
  | { action: "merge"; sources: string[]; target: string; content: string }
  | { action: "share"; project: string; folder?: string; picks?: Record<string, string> }
  | { action: "unshare"; project: string };

export interface MemoryResult {
  applied: boolean;
  entry?: string;
  changed: string[] | null;
  warnings: string[] | null;
  conflicts: MemoryConflict[] | null;
}

export async function scanMemory(): Promise<MemoryInventory> {
  // Go trả null cho slice chưa có phần tử (lần đầu chưa có sao lưu hay dự án dùng chung).
  const raw = await invoke<{ [K in keyof MemoryInventory]: MemoryInventory[K] | null }>("memory_scan");
  return {
    files: raw.files ?? [],
    sessions: raw.sessions ?? [],
    warnings: raw.warnings ?? [],
    shared: raw.shared ?? [],
    entries: raw.entries ?? [],
  };
}

export const applyMemory = (operation: MemoryOperation) => invoke<MemoryResult>("memory_apply", { operation });

export function readMemory(path: string): Promise<string> {
  // Tái dùng bộ đọc UTF-8 có giới hạn cỡ file; mọi lần ghi vẫn qua sidecar để có sao lưu và cập nhật chỉ mục.
  const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (split < 0) return Promise.reject(new Error("Đường dẫn memory không hợp lệ."));
  const folder = split === 0 ? "/" : /^[A-Za-z]:\\/.test(path) && split === 2 ? path.slice(0, 3) : path.slice(0, split);
  return readLocalFile(folder, path.slice(split + 1)).then((file) => file.content);
}

export const canMergeMemory = (file: MemoryFile) => file.kind === "memory" && file.name !== "MEMORY.md";

export interface MemoryProject {
  key: string;
  path?: string;
  profiles: { id: string; files: MemoryFile[] }[];
}

export function memoryTree(files: MemoryFile[]): { cli: string; projects: MemoryProject[] }[] {
  const clis = new Map<string, Map<string, MemoryProject>>();
  for (const file of files) {
    const projects = clis.get(file.cli) ?? new Map<string, MemoryProject>();
    clis.set(file.cli, projects);
    const key = file.projectKey ?? "";
    const project = projects.get(key) ?? { key, ...(file.projectPath ? { path: file.projectPath } : {}), profiles: [] };
    projects.set(key, project);
    let profile = project.profiles.find((p) => p.id === file.profile);
    if (!profile) {
      profile = { id: file.profile, files: [] };
      project.profiles.push(profile);
    }
    profile.files.push(file);
  }
  return [...clis]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cli, projects]) => ({
      cli,
      projects: [...projects.values()].sort((a, b) => a.key.localeCompare(b.key)),
    }));
}
