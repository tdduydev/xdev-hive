import { describe, expect, it } from "vitest";
import { approval, LEADER_TIER_GUIDE, leaderAction } from "./leader.ts";
import { TASK_TIERS } from "./projects.ts";
import { DANGEROUS_PERMISSIONS, SYSTEM_ROLE_PERMISSIONS } from "./roles.ts";
import { terminalClientFrame, terminalContract, terminalServerFrame } from "./terminal.ts";
import { TERMINAL_LIMITS, termOpen } from "./worker-protocol.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("khung WebSocket terminal", () => {
  it("nhận phím trong giới hạn, chặn gói nhập quá lớn", () => {
    expect(terminalClientFrame.parse({ t: "in", data: b64("ls\r") })).toEqual({ t: "in", data: b64("ls\r") });
    const big = b64("x".repeat(TERMINAL_LIMITS.inputBytes + 1));
    expect(terminalClientFrame.safeParse({ t: "in", data: big }).success).toBe(false);
    expect(terminalClientFrame.safeParse({ t: "in", data: "không phải base64" }).success).toBe(false);
  });

  it("đổi cỡ trong khoảng hợp lệ và nối lại theo seq", () => {
    expect(terminalClientFrame.safeParse({ t: "resize", cols: 10, rows: 30 }).success).toBe(false);
    expect(terminalClientFrame.parse({ t: "resume", after: -1 })).toEqual({ t: "resume", after: -1 });
  });

  it("hub chỉ gửi loại khung đã khai", () => {
    expect(terminalServerFrame.parse({ t: "out", seq: 3, data: b64("hi") }).t).toBe("out");
    expect(terminalServerFrame.safeParse({ t: "shell", cmd: "rm" }).success).toBe(false);
  });
});

describe("mở phiên", () => {
  it("mặc định sonnet, Bypass mang cờ xác nhận", () => {
    const input = terminalContract.open["~orpc"].inputSchema;
    const parsed = input?.["~standard"].validate({
      projectId: "0a0a0a0a-0000-4000-8000-000000000003",
      machineId: "0a0a0a0a-0000-4000-8000-000000000004",
      mode: "bypass",
      confirmBypass: true,
      cols: 120,
      rows: 32,
    });
    expect(parsed).toMatchObject({ value: { model: "sonnet", mode: "bypass", confirmBypass: true } });
  });

  it("term_open chỉ chạy claude", () => {
    const base = {
      type: "term_open",
      v: 1,
      id: "x",
      sessionId: "0a0a0a0a-0000-4000-8000-0000000000a1",
      projectId: "p",
      mode: "propose",
      cols: 80,
      rows: 24,
      repoUrl: "https://github.com/a/b.git",
      baseBranch: "main",
      projectKey: "B",
      model: "sonnet",
      runPermissions: "workspace",
      fullAllowed: false,
      mcpToken: "t",
      systemPrompt: "",
    };
    expect(termOpen.safeParse({ ...base, cli: "claude" }).success).toBe(true);
    expect(termOpen.safeParse({ ...base, cli: "codex" }).success).toBe(false);
  });
});

describe("cấp độ của Leader", () => {
  it("đề xuất task và run mang cấp độ và lý do; đề xuất cũ vẫn hợp lệ", () => {
    const task = leaderAction.parse({
      type: "task.create",
      projectId: "0a0a0a0a-0000-4000-8000-000000000003",
      title: "Sửa chữ",
      tier: "light",
      tierReason: "Chỉ đổi chữ giao diện.",
    });
    expect(task).toMatchObject({ tier: "light", tierReason: "Chỉ đổi chữ giao diện." });
    const old = leaderAction.parse({ type: "run.dispatch", taskId: "0a0a0a0a-0000-4000-8000-000000000003" });
    expect(old).not.toHaveProperty("tier");
    expect(
      leaderAction.safeParse({ type: "run.dispatch", taskId: "0a0a0a0a-0000-4000-8000-000000000003", tier: "huge" })
        .success,
    ).toBe(false);
    expect(approval.shape.action).toBe(leaderAction);
  });

  it("bảng ý nghĩa phủ đủ ba cấp theo thứ tự", () => {
    expect(LEADER_TIER_GUIDE.map((t) => t.tier)).toEqual([...TASK_TIERS]);
  });
});

describe("quyền leader.terminal", () => {
  it("quản trị đội và BA/PO có, thành viên thường không; là quyền nguy hiểm", () => {
    expect(SYSTEM_ROLE_PERMISSIONS["team-admin"]).toContain("leader.terminal");
    expect(SYSTEM_ROLE_PERMISSIONS["team-ba"]).toContain("leader.terminal");
    expect(SYSTEM_ROLE_PERMISSIONS["team-member"]).not.toContain("leader.terminal");
    expect(SYSTEM_ROLE_PERMISSIONS.member).not.toContain("leader.terminal");
    expect(DANGEROUS_PERMISSIONS).toContain("leader.terminal");
  });
});
