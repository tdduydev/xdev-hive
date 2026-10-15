import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ExecResult, exec } from "@/lib/exec.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export async function workspaceProject(
  cwd: string,
  options: {
    workerPath?: string;
    trusted?: boolean;
    hubUrl?: string;
    execute?: (file: string, args: readonly string[]) => Promise<ExecResult>;
  } = {},
): Promise<string | undefined> {
  if (options.workerPath && options.trusted) {
    try {
      const result = await (options.execute ?? exec)(options.workerPath, ["projects", "--json"]);
      const view: unknown = result.code === 0 ? JSON.parse(result.stdout) : undefined;
      if (object(view) && Array.isArray(view.projects)) {
        const matches = view.projects.filter((p): p is { projectId: string; folder: string } => {
          if (!object(p) || typeof p.projectId !== "string" || !uuid.test(p.projectId) || typeof p.folder !== "string")
            return false;
          const rel = relative(resolve(p.folder), resolve(cwd));
          return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
        });
        matches.sort((a, b) => b.folder.length - a.folder.length);
        if (matches[0]) return matches[0].projectId;
      }
    } catch {
      /* Không có worker vẫn đọc được liên kết MCP của workspace. */
    }
  }
  try {
    const config: unknown = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8"));
    if (!object(config) || !object(config.mcpServers)) return;
    const ids = new Set<string>();
    for (const server of Object.values(config.mcpServers)) {
      if (!object(server) || !object(server.headers)) continue;
      if (
        options.hubUrl &&
        (typeof server.url !== "string" || new URL(server.url).origin !== new URL(options.hubUrl).origin)
      )
        continue;
      for (const [key, value] of Object.entries(server.headers)) {
        if (key.toLowerCase() === "x-hive-project" && typeof value === "string" && uuid.test(value)) ids.add(value);
      }
    }
    return ids.size === 1 ? [...ids][0] : undefined;
  } catch {
    return undefined;
  }
}
