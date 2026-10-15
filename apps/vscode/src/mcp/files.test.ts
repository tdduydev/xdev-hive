import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpFiles, type Tool } from "@/mcp/files.ts";

let home: string;
let files: McpFiles;
const server = { command: "/opt/Hive CLI/hive", args: ["mcp"] };
const paths: Record<Tool, string[]> = {
  ClaudeCode: [".claude.json"],
  Cursor: [".cursor", "mcp.json"],
  Windsurf: [".codeium", "windsurf", "mcp_config.json"],
};
beforeEach(async () => {
  const root = join(process.cwd(), "node_modules", ".cache");
  await mkdir(root, { recursive: true });
  home = await mkdtemp(join(root, "mcp-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  files = new McpFiles(home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe("MCP config ownership", () => {
  for (const tool of Object.keys(paths) as Tool[]) {
    it(`${tool}: preserves keys and restores original bytes`, async () => {
      const path = join(home, ...paths[tool]);
      await mkdir(join(path, ".."), { recursive: true });
      const original = '{\r\n "theme":"dark", "mcpServers": {"other": {"command":"other"}}\r\n}\r\n';
      await writeFile(path, original);
      await files.add(tool, server);
      const installed = await readFile(path, "utf8");
      expect(JSON.parse(installed)).toEqual({
        theme: "dark",
        mcpServers: { other: { command: "other" }, "xdev-hive": server },
      });
      expect(installed).not.toContain("hive_pat_");
      expect(await readFile(`${path}.xdev-hive.bak`, "utf8")).toBe(original);
      await files.add(tool, server);
      await files.remove(tool);
      expect(await readFile(path, "utf8")).toBe(original);
    });
  }
  it("removes a newly created config and supports reinstall", async () => {
    await files.add("Cursor", server);
    await files.remove("Cursor");
    await expect(readFile(join(home, ...paths.Cursor))).rejects.toMatchObject({ code: "ENOENT" });
    await files.add("Cursor", server);
    await files.remove("Cursor");
  });
  it("retains edits made after installation", async () => {
    await files.add("Cursor", server);
    const path = join(home, ...paths.Cursor);
    const data = JSON.parse(await readFile(path, "utf8"));
    data.extra = "new";
    data.mcpServers.other = { command: "other" };
    await writeFile(path, JSON.stringify(data));
    await files.remove("Cursor");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      extra: "new",
      mcpServers: { other: { command: "other" } },
    });
  });
  it("never overwrites a preexisting Hive entry or malformed JSON", async () => {
    const path = join(home, ...paths.ClaudeCode);
    for (const original of ['{"mcpServers":{"xdev-hive":{"command":"mine"}}}', "{bad", '{"mcpServers":[]}']) {
      await writeFile(path, original);
      await expect(files.add("ClaudeCode", server)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(original);
    }
  });
  it("does not remove an externally changed Hive entry", async () => {
    await files.add("ClaudeCode", server);
    const path = join(home, ...paths.ClaudeCode);
    const edited = '{"mcpServers":{"xdev-hive":{"command":"mine"}}}';
    await writeFile(path, edited);
    await expect(files.remove("ClaudeCode")).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(edited);
  });
  it("wraps Claude CLI installation with backup and exact removal", async () => {
    const path = join(home, ...paths.ClaudeCode);
    const original = '{ "other":true }';
    await writeFile(path, original);
    await files.add("ClaudeCode", server, async () => {
      expect(await readFile(`${path}.xdev-hive.bak`, "utf8")).toBe(original);
      await writeFile(path, JSON.stringify({ other: true, mcpServers: { "xdev-hive": { type: "stdio", ...server } } }));
    });
    await files.add("ClaudeCode", server);
    await files.remove("ClaudeCode");
    expect(await readFile(path, "utf8")).toBe(original);
  });
  it("tracks partial CLI writes even when the CLI reports failure", async () => {
    const path = join(home, ...paths.ClaudeCode);
    const original = '{ "other": true }';
    await writeFile(path, original);
    await expect(
      files.add("ClaudeCode", server, async () => {
        await writeFile(
          path,
          JSON.stringify({ other: true, mcpServers: { "xdev-hive": { type: "stdio", ...server } } }),
        );
        throw new Error("failed after write");
      }),
    ).rejects.toThrow("failed after write");
    await files.remove("ClaudeCode");
    expect(await readFile(path, "utf8")).toBe(original);
  });
  it("does not persist a failed CLI install as owned configuration", async () => {
    await expect(
      files.add("ClaudeCode", server, async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow();
    await files.add("ClaudeCode", server);
    await files.remove("ClaudeCode");
  });
  it("never reuses a stale backup from an earlier install", async () => {
    const path = join(home, ...paths.ClaudeCode);
    await writeFile(path, "{}");
    await files.add("ClaudeCode", server);
    await files.remove("ClaudeCode");
    const original = '{ "new": true }\n';
    await writeFile(path, original);
    await files.add("ClaudeCode", server);
    await files.remove("ClaudeCode");
    expect(await readFile(path, "utf8")).toBe(original);
  });
});
