import { describe, expect, it } from "vitest";
import type { CliProfile } from "@/lib/agent.ts";
import type { LocalProject } from "@/lib/local-projects.ts";
import { formatBytes, type MachineAgent, normPath, planOf, projectOf } from "@/lib/machine-agents.ts";

const agent = (over: Partial<MachineAgent>): MachineAgent => ({
  pid: 4242,
  cli: "claude",
  background: false,
  bypass: false,
  startedAt: 1_792_000_000,
  cpu: 3.5,
  memory: 734_003_200,
  cwd: "C:\\Users\\ha\\Code\\shop\\src",
  configDir: null,
  hiveProject: null,
  source: { kind: "terminal" },
  own: true,
  children: 0,
  activity: null,
  ...over,
});

const project = (folder: string, name: string, exists = true): LocalProject => ({
  projectId: "",
  name,
  folder,
  fullPermission: false,
  exists,
  isGit: true,
});

const plan = (id: string, cli: string, configDir?: string): CliProfile => ({
  id,
  label: id,
  cli,
  ...(configDir ? { configDir } : {}),
  enabled: true,
  priority: 1,
  maxConcurrent: 1,
  cooldownMinutes: 0,
  supported: true,
  loggedIn: true,
});

const HOME = "C:\\Users\\ha";

describe("machine agents", () => {
  it("normPath mở ~, bỏ dấu phân cách cuối, chữ thường với đường dẫn Windows", () => {
    expect(normPath("~/.xdev-hive/accounts/claude-2/", HOME)).toBe("c:/users/ha/.xdev-hive/accounts/claude-2");
    expect(normPath("/Users/Ha/Code/", "/Users/Ha")).toBe("/Users/Ha/Code");
    expect(normPath("~", "/home/ha")).toBe("/home/ha");
  });

  it("projectOf chọn thư mục dự án dài nhất chứa thư mục làm việc", () => {
    const projects = [
      project("C:\\Users\\ha\\Code", "code"),
      project("c:\\users\\ha\\code\\shop", "shop"),
      project("C:\\Users\\ha\\Code\\sho", "sho"),
      project("C:\\Users\\ha\\Code\\shop\\src", "gone", false),
    ];
    expect(projectOf(agent({}), projects, HOME)?.name).toBe("shop");
    expect(projectOf(agent({ cwd: "C:\\Users\\ha\\Codex" }), projects, HOME)).toBeNull();
    expect(projectOf(agent({ cwd: null }), projects, HOME)).toBeNull();
  });

  it("planOf khớp thư mục gói với biến môi trường, mặc định khi không có biến", () => {
    const plans = [
      plan("claude-2", "claude", "~/.xdev-hive/accounts/claude-2"),
      plan("codex-2", "codex", "~/.xdev-hive/accounts/claude-2"),
    ];
    const env = "C:\\Users\\ha\\.xdev-hive\\accounts\\claude-2\\";
    expect(planOf(agent({ configDir: env }), plans, HOME)).toMatchObject({ id: "claude-2" });
    expect(planOf(agent({ configDir: null }), plans, HOME)).toBe("default");
    expect(planOf(agent({ configDir: "D:\\other" }), plans, HOME)).toBeNull();
    // Gói của CLI khác không khớp dù cùng thư mục.
    expect(planOf(agent({ cli: "codex", configDir: env }), plans.slice(0, 1), HOME)).toBeNull();
  });

  it("formatBytes", () => {
    expect(formatBytes(734_003_200)).toBe("700 MB");
    expect(formatBytes(2_147_483_648)).toBe("2,0 GB");
    expect(formatBytes(512_000)).toBe("500 KB");
  });
});
