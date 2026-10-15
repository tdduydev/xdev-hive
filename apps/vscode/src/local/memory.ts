import { basename } from "node:path";
import { runWorker } from "@/local/worker.ts";

export type MemoryFlag = { code: string; message: string };
export type MemoryFile = {
  profile: string;
  projectKey?: string;
  projectPath?: string;
  path: string;
  name: string;
  kind: string;
  tokens: number;
  flags: MemoryFlag[] | null;
};
type MemorySession = {
  profile: string;
  projectKey: string;
  projectPath?: string;
  sessionTokens: number;
  paths: string[] | null;
};
export type MemoryInventory = {
  files: MemoryFile[] | null;
  sessions: MemorySession[] | null;
  warnings?: string[] | null;
};

export type MemoryProject = {
  id: string;
  label: string;
  path?: string;
  tokens: number;
  files: MemoryFile[];
};

export const memoryScan = () => runWorker<MemoryInventory>(["memory", "scan"], { timeoutMs: 120_000 });

const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();

/**
 * Gom file theo phiên của từng dự án (hive-worker đã tính token mỗi phiên). Có dự án khớp workspace thì chỉ hiện
 * những dự án đó, vì view này nói về thư mục đang mở; không khớp cái nào thì hiện hết để khỏi trống vô cớ.
 */
export function memoryProjects(inv: MemoryInventory, workspaces: readonly string[]): MemoryProject[] {
  const files = inv.files ?? [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const placed = new Set<string>();
  const projects: MemoryProject[] = [];
  for (const s of inv.sessions ?? []) {
    const own = (s.paths ?? []).flatMap((p) => byPath.get(p) ?? []);
    for (const f of own) placed.add(f.path);
    projects.push({
      id: `${s.profile}/${s.projectKey}`,
      label: s.projectPath ? basename(s.projectPath) : s.projectKey,
      ...(s.projectPath ? { path: s.projectPath } : {}),
      tokens: s.sessionTokens,
      files: own,
    });
  }
  const loose = files.filter((f) => !placed.has(f.path) && f.kind !== "database");
  if (loose.length > 0) {
    projects.push({
      id: "shared",
      label: "",
      tokens: loose.reduce((sum, f) => sum + f.tokens, 0),
      files: loose,
    });
  }
  const roots = new Set(workspaces.map(norm));
  const mine = projects.filter((p) => p.path && roots.has(norm(p.path)));
  return mine.length > 0 ? mine : projects;
}
