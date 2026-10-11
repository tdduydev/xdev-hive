import type { ChatMessage, Project } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { awaitingLeader, describeAction } from "./leader.ts";

const project = { id: "9a9a9a9a-0000-4000-8000-000000000001", key: "PAY" } as Project;
const msg = (role: ChatMessage["role"]): ChatMessage => ({
  id: "1",
  role,
  content: "x",
  runId: null,
  createdAt: "2026-10-12T00:00:00.000Z",
});

describe("describeAction", () => {
  it("tạo việc ghi tiêu đề và mã dự án", () => {
    expect(describeAction({ type: "task.create", projectId: project.id, title: "Sửa lỗi", body: "" }, [project])).toBe(
      'Tạo việc "Sửa lỗi" trong dự án PAY',
    );
  });
  it("dự án không thấy trong danh sách thì nói rõ", () => {
    expect(describeAction({ type: "task.create", projectId: project.id, title: "A", body: "" }, [])).toContain(
      "không rõ",
    );
  });
  it("giao việc và huỷ run dùng id ngắn", () => {
    expect(
      describeAction({ type: "run.dispatch", taskId: "1a1a1a1a-0000-4000-8000-000000000001", cli: "codex" }, []),
    ).toBe("Giao việc 1a1a1a1a cho Codex");
    expect(describeAction({ type: "run.cancel", runId: "2b2b2b2b-0000-4000-8000-000000000001" }, [])).toBe(
      "Huỷ run 2b2b2b2b",
    );
  });
  it("đổi cấu hình liệt kê mục bằng tiếng Việt", () => {
    expect(
      describeAction({ type: "project.settings", projectKey: "PAY", patch: { budget: { perRunUsd: 3 } } }, []),
    ).toBe("Đổi cấu hình dự án PAY: ngân sách");
  });
});

describe("awaitingLeader", () => {
  it("chỉ chờ khi tin cuối là của người dùng", () => {
    expect(awaitingLeader([msg("user")])).toBe(true);
    expect(awaitingLeader([msg("user"), msg("leader")])).toBe(false);
    expect(awaitingLeader([msg("user"), msg("system")])).toBe(false);
    expect(awaitingLeader([])).toBe(false);
    expect(awaitingLeader(undefined)).toBe(false);
  });
});
