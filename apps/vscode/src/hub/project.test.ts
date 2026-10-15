import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { workspaceProject } from "@/hub/project.ts";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
it("chọn liên kết worker gần workspace nhất", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-project-"));
  dirs.push(dir);
  const execute = vi.fn(async () => ({
    code: 0,
    stderr: "",
    stdout: JSON.stringify({
      projects: [
        { projectId: first, folder: dir },
        { projectId: second, folder: join(dir, "app") },
      ],
    }),
  }));
  expect(await workspaceProject(join(dir, "app", "src"), { workerPath: "worker", trusted: true, execute })).toBe(
    second,
  );
  expect(execute).toHaveBeenCalledWith("worker", ["projects", "--json"]);
});
it("không chạy binary trong workspace chưa tin cậy; dùng header MCP và bỏ liên kết mơ hồ", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-project-"));
  dirs.push(dir);
  const execute = vi.fn();
  const server = (id: string) => ({ url: "https://hub.test/mcp", headers: { "X-Hive-Project": id } });
  await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { hive: server(first) } }));
  expect(await workspaceProject(dir, { workerPath: "worker", execute })).toBe(first);
  expect(execute).not.toHaveBeenCalled();
  expect(await workspaceProject(dir, { hubUrl: "https://other.test" })).toBeUndefined();
  await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { a: server(first), b: server(second) } }));
  expect(await workspaceProject(dir)).toBeUndefined();
});
