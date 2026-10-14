import { describe, expect, it } from "vitest";
import { desktopConnectApproveInput, desktopConnectExchangeOutput } from "./desktop-connect.ts";
import { approval, LEADER_TIER_GUIDE, leaderAction } from "./leader.ts";
import { inboxItem, notificationChannelCreateInput, PERSONAL_NOTIFICATION_EVENTS } from "./notify.ts";
import { agentPolicyInput, DEFAULT_AGENT_POLICY } from "./policies.ts";
import { TASK_TIERS } from "./projects.ts";
import { DANGEROUS_PERMISSIONS, SYSTEM_ROLE_PERMISSIONS } from "./roles.ts";
import {
  REMOTE_AUDIT_ACTIONS,
  remoteClientFrame,
  remoteContract,
  remoteErrors,
  remotePairCompleteInput,
  remoteServerFrame,
  remoteStartInput,
  terminalClientFrame,
  terminalContract,
  terminalServerFrame,
} from "./terminal.ts";
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

// ---- Phiên trên máy cá nhân và điều khiển từ xa (specs/010 T002) ----

const machineId = "0a0a0a0a-0000-4000-8000-000000000001";
const ephPub = `B${"A".repeat(86)}`;
const totp = { kind: "totp", code: "123456", ephPub, ts: 1_791_999_990, nonce: "rh92dopMeUqiZuhXLhBUxQ" } as const;
const mac = "A".repeat(22);

describe("mở phiên từ điện thoại", () => {
  const base = { machineId, cli: "claude", rootId: "root-code01", cols: 44, rows: 30, auth: totp };

  it("TOTP không cần thiết bị đã ghép", () => {
    expect(remoteStartInput.parse(base)).not.toHaveProperty("deviceId");
    expect(remoteStartInput.safeParse({ ...base, deviceId: "dev-iphone01" }).success).toBe(true);
  });

  it("không nhận model hay mức quyền từ trình duyệt, chặn yêu cầu lạ", () => {
    expect(remoteStartInput.parse({ ...base, model: "opus", permissions: "full" })).not.toHaveProperty("model");
    expect(remoteStartInput.safeParse({ ...base, rootId: "/home/an/code" }).success).toBe(false);
    expect(remoteStartInput.safeParse({ ...base, auth: { ...totp, code: "12345" } }).success).toBe(false);
    expect(remoteStartInput.safeParse({ ...base, prompt: "x".repeat(20_001) }).success).toBe(false);
  });
});

describe("khung WebSocket điều khiển từ xa", () => {
  it("phím và đổi cỡ luôn mang seq và HMAC", () => {
    const data = b64("ls\r");
    expect(remoteClientFrame.safeParse({ t: "in", seq: 0, data, mac }).success).toBe(true);
    expect(remoteClientFrame.safeParse({ t: "in", data }).success).toBe(false);
    expect(remoteClientFrame.safeParse({ t: "in", seq: 1, data, mac: "ngắn" }).success).toBe(false);
    expect(remoteClientFrame.safeParse({ t: "resize", seq: 2, cols: 44, rows: 30, mac }).success).toBe(true);
    expect(remoteClientFrame.safeParse({ t: "resize", seq: -1, cols: 44, rows: 30, mac }).success).toBe(false);
    const big = b64("x".repeat(TERMINAL_LIMITS.inputBytes + 1));
    expect(remoteClientFrame.safeParse({ t: "in", seq: 3, data: big, mac }).success).toBe(false);
  });

  it("xin quyền gõ bằng TOTP hoặc passkey, không có cách nào khác", () => {
    expect(remoteClientFrame.safeParse({ t: "control", auth: totp }).success).toBe(true);
    expect(remoteClientFrame.safeParse({ t: "control", auth: { kind: "password", code: "x" } }).success).toBe(false);
  });

  it("hub chỉ chuyển mã từ chối và lý do thu quyền đã khai", () => {
    expect(remoteServerFrame.safeParse({ t: "revoked", reason: "idle" }).success).toBe(true);
    expect(remoteServerFrame.safeParse({ t: "revoked", reason: "boom" }).success).toBe(false);
    expect(remoteServerFrame.safeParse({ t: "denied", code: "TOTP_LOCKED", message: "Khoá" }).success).toBe(true);
    expect(remoteServerFrame.safeParse({ t: "denied", code: "NOPE", message: "x" }).success).toBe(false);
    expect(remoteServerFrame.safeParse({ t: "sync", after: -1 }).success).toBe(true);
  });
});

describe("route điều khiển từ xa", () => {
  it("mọi route dưới /v1/remote, không có route bật từ xa hay thêm thiết bị ngoài ghép (FR-012)", () => {
    const paths = Object.values(remoteContract).map((r) => r["~orpc"].route.path ?? "");
    expect(paths.every((p) => p.startsWith("/v1/remote/"))).toBe(true);
    expect(paths.some((p) => /enable|roots/.test(p))).toBe(false);
  });

  it("ghép cần tên thiết bị và tag đủ 32 byte", () => {
    const pair = {
      machineId,
      pairId: "pair-0001aa",
      label: "iPhone",
      credentialId: "Y3JlZA",
      spki: "c3BraQ",
      tag: "A".repeat(43),
    };
    expect(remotePairCompleteInput.parse(pair).synced).toBe(false);
    const empty = remotePairCompleteInput.safeParse({ ...pair, label: "  " });
    expect(empty.error?.issues[0]?.message).toBe("Đặt tên cho thiết bị.");
    expect(remotePairCompleteInput.safeParse({ ...pair, tag: "A".repeat(42) }).success).toBe(false);
  });

  it("có câu tiếng Việt cho mọi mã lỗi, audit không trùng", () => {
    for (const message of Object.values(remoteErrors)) expect(message.length).toBeGreaterThan(5);
    expect(new Set(REMOTE_AUDIT_ACTIONS).size).toBe(REMOTE_AUDIT_ACTIONS.length);
    expect(REMOTE_AUDIT_ACTIONS).toEqual(expect.arrayContaining(["terminal.totp_fail", "cli.connect.exchange"]));
  });
});

describe("đăng nhập CLI qua desktop-connect", () => {
  const approve = { machine: "may-cua-an", port: 51_234, state: "s".repeat(16), challenge: "c".repeat(43) };
  const teamId = "0a0a0a0a-0000-4000-8000-000000000002";

  it("app desktop cũ không gửi purpose vẫn là desktop và phải chọn đội", () => {
    expect(desktopConnectApproveInput.parse({ ...approve, teamId })).toMatchObject({ purpose: "desktop", teamId });
    expect(desktopConnectApproveInput.safeParse(approve).success).toBe(false);
  });

  it("cli không cần đội", () => {
    expect(desktopConnectApproveInput.parse({ ...approve, purpose: "cli" })).toEqual({ ...approve, purpose: "cli" });
  });

  it("cli chỉ nhận token cá nhân, không có mã đăng ký máy", () => {
    const common = {
      hubUrl: "http://hub.local",
      machine: "may-cua-an",
      personalToken: "hive_pat_x",
      personalTokenExpiresAt: "2026-12-01T00:00:00.000Z",
    };
    const cli = desktopConnectExchangeOutput.parse({ ...common, purpose: "cli", registrationToken: "hwr_x", teamId });
    expect(cli).not.toHaveProperty("registrationToken");
    expect(desktopConnectExchangeOutput.safeParse({ ...common, purpose: "desktop" }).success).toBe(false);
  });
});

describe("thông báo và chính sách của phần từ xa", () => {
  it("sự kiện phiên riêng chỉ vào hộp thư, kênh của tổ chức không chọn được", () => {
    for (const event of PERSONAL_NOTIFICATION_EVENTS) {
      const item = { id: machineId, event, title: "t", body: "b", link: null, createdAt: "2026-10-14T00:00:00.000Z" };
      expect(inboxItem.safeParse({ ...item, readAt: null }).success).toBe(true);
      const channel = { name: "Đội", events: [event], config: { kind: "telegram", botToken: "x", chatId: "1" } };
      const parsed = notificationChannelCreateInput.safeParse(channel);
      expect(parsed.error?.issues.some((i) => i.path[0] === "events")).toBe(true);
    }
  });

  it("chính sách cũ không có mục remote vẫn cho TOTP", () => {
    const { remote: _, ...old } = DEFAULT_AGENT_POLICY;
    expect(agentPolicyInput.parse(old).remote).toEqual({ totpFallback: true });
    expect(agentPolicyInput.parse({ ...old, remote: { totpFallback: false } }).remote.totpFallback).toBe(false);
  });
});
