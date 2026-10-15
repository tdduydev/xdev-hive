import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Tool = "ClaudeCode" | "Cursor" | "Windsurf";
export type Stdio = { command: string; args: string[]; env?: Record<string, string> };
const paths: Record<Tool, string[]> = {
  ClaudeCode: [".claude.json"],
  Cursor: [".cursor", "mcp.json"],
  Windsurf: [".codeium", "windsurf", "mcp_config.json"],
};
type Entry = { original: string | null; installed: string; server: Stdio };
type State = Partial<Record<Tool, Entry>>;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function read(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, body, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function parse(text: string | null): Record<string, unknown> {
  const value: unknown = JSON.parse(text ?? "{}");
  if (!object(value) || (value.mcpServers !== undefined && !object(value.mcpServers))) {
    throw new Error("Cấu hình MCP không hợp lệ.");
  }
  return value;
}

export class McpFiles {
  private readonly manifest: string;
  private readonly home: string;
  constructor(home: string) {
    this.home = home;
    this.manifest = join(home, ".xdev-hive", "vscode", "mcp-state.json");
  }
  private async state(): Promise<State> {
    const value: unknown = JSON.parse((await read(this.manifest)) ?? "{}");
    if (!object(value)) throw new Error("Không đọc được trạng thái MCP.");
    for (const [tool, entry] of Object.entries(value)) {
      if (
        !Object.hasOwn(paths, tool) ||
        !object(entry) ||
        (entry.original !== null && typeof entry.original !== "string") ||
        typeof entry.installed !== "string" ||
        !object(entry.server)
      ) {
        throw new Error("Không đọc được trạng thái MCP.");
      }
    }
    return value as State;
  }
  async add(tool: Tool, server: Stdio, install?: () => Promise<void>): Promise<void> {
    const path = join(this.home, ...paths[tool]);
    const original = await read(path);
    const value = parse(original);
    const servers = (value.mcpServers ?? {}) as Record<string, unknown>;
    const state = await this.state();
    const previous = state[tool];
    if (previous) {
      if (
        JSON.stringify(servers["xdev-hive"]) === JSON.stringify(previous.server) &&
        previous.server.command === server.command &&
        JSON.stringify(previous.server.args) === JSON.stringify(server.args)
      )
        return;
      throw new Error("Cấu hình Hive đã thay đổi. Hãy gỡ cấu hình cũ trước.");
    }
    if (Object.hasOwn(servers, "xdev-hive"))
      throw new Error("Đã có cấu hình xdev-hive. Không ghi đè cấu hình hiện có.");
    if (original !== null) {
      try {
        await writeFile(`${path}.xdev-hive.bak`, original, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    value.mcpServers = { ...servers, "xdev-hive": server };
    const installed = `${JSON.stringify(value, null, 2)}\n`;
    state[tool] = { original, installed, server };
    // Ghi ý định trước để vẫn gỡ được mục Hive nếu editor đóng giữa chừng.
    await atomic(this.manifest, JSON.stringify(state, null, 2));
    if (install) {
      let installError: unknown;
      try {
        await install();
      } catch (error) {
        installError = error;
      }
      const actual = await read(path);
      if (installError && actual === original) {
        delete state[tool];
        await atomic(this.manifest, JSON.stringify(state, null, 2));
        throw installError;
      }
      const actualServers = parse(actual).mcpServers;
      if (
        !object(actualServers) ||
        !object(actualServers["xdev-hive"]) ||
        actualServers["xdev-hive"].command !== server.command ||
        JSON.stringify(actualServers["xdev-hive"].args) !== JSON.stringify(server.args)
      ) {
        throw new Error("Công cụ chưa lưu cấu hình MCP của Hive.");
      }
      state[tool] = { original, installed: actual as string, server: actualServers["xdev-hive"] as Stdio };
      await atomic(this.manifest, JSON.stringify(state, null, 2));
      if (installError) throw installError;
    } else {
      await atomic(path, installed);
    }
  }
  async remove(tool: Tool): Promise<void> {
    const state = await this.state();
    const entry = state[tool];
    if (!entry) return;
    const path = join(this.home, ...paths[tool]);
    const current = await read(path);
    if (current === entry.installed) {
      if (entry.original === null) await rm(path, { force: true });
      else await atomic(path, entry.original);
    } else if (current !== null) {
      const value = parse(current);
      const servers = value.mcpServers as Record<string, unknown> | undefined;
      if (servers && Object.hasOwn(servers, "xdev-hive")) {
        if (JSON.stringify(servers["xdev-hive"]) !== JSON.stringify(entry.server)) {
          throw new Error("Mục Hive đã được sửa bên ngoài. Không thể tự động gỡ.");
        }
        delete servers["xdev-hive"];
        if (Object.keys(servers).length === 0 && !Object.hasOwn(parse(entry.original), "mcpServers"))
          delete value.mcpServers;
        await atomic(path, `${JSON.stringify(value, null, 2)}\n`);
      }
    }
    delete state[tool];
    await atomic(this.manifest, JSON.stringify(state, null, 2));
  }
}
