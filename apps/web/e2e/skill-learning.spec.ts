import { expect, type Page, test } from "@playwright/test";
import type { LearnedSkillProposal } from "@xdev-hive/contracts";
import { fail, fakeHub, ok, type RpcHandler } from "./fake-hub.ts";

// Tab “Đề xuất từ agent” của trang Skills (specs/014): số liệu, duyệt, từ chối kèm lý do, quyền theo đội.

const at = "2026-10-14T03:00:00.000Z";
const ORG_ID = "0a0a0a0a-0000-4000-8000-00000000000a";
const TEAM_ID = "7e7e7e7e-0000-4000-8000-000000000001";
const PROJECT_ID = "9a9a9a9a-0000-4000-8000-000000000001";
const RUN_ID = "2b2b2b2b-0000-4000-8000-000000000001";

const proposal = (over: Partial<LearnedSkillProposal> = {}): LearnedSkillProposal => ({
  id: "3c3c3c3c-0000-4000-8000-000000000001",
  kind: "new",
  name: "lam-tron-tien",
  description: "Dùng khi tính tiền: làm tròn theo đơn vị nhỏ nhất.",
  content: "## Khi nào dùng\nTính tiền, chia hoá đơn.\n\n- Lưu số nguyên đơn vị nhỏ nhất.",
  reason: "Task HD-12 thử lại 3 lần vì làm tròn số thực.",
  status: "pending",
  projectId: PROJECT_ID,
  projectKey: "hive",
  scope: { level: "project", teamId: TEAM_ID, projectId: PROJECT_ID },
  baseVersion: 0,
  triggers: ["retries", "cost"],
  sourceRunIds: [RUN_ID],
  runId: "4d4d4d4d-0000-4000-8000-000000000001",
  createdAt: at,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  delivery: null,
  ...over,
});

const stats = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  days: 30,
  batches: 4,
  candidateRuns: 9,
  proposals: 5,
  pending: 2,
  approved: 2,
  rejected: 1,
  duplicates: 3,
  approvalRate: 2 / 3,
  costUsd: 0.84,
  tokens: 120_000,
  today: { used: 2, limit: 5 },
  ...over,
});

async function open(
  page: Page,
  opts: { teamRole?: "admin" | "member"; role?: string; rpc?: Record<string, RpcHandler> } = {},
) {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_ID);
  return fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [
            { id: ORG_ID, slug: "acme", name: "Acme", role: opts.role ?? "member", emailDomain: null, createdAt: at },
          ],
          canCreateOrg: false,
        }),
      "orgMembers/list": () =>
        ok([
          {
            userId: "u1",
            name: "Trần Đức Duy",
            email: "duy@example.com",
            image: null,
            role: "member",
            status: "active",
            joinedAt: at,
            teams: [{ teamId: TEAM_ID, name: "Platform", role: opts.teamRole ?? "admin" }],
          },
        ]),
      "teams/list": () =>
        ok([
          {
            id: TEAM_ID,
            name: "Platform",
            slug: "platform",
            color: null,
            createdAt: at,
            systemCount: 0,
            memberCount: 1,
          },
        ]),
      "projects/list": () => ok([{ id: PROJECT_ID, teamId: TEAM_ID, name: "Hive", key: "hive", createdAt: at }]),
      "notifications/unreadCount": () => ok({ count: 0 }),
      "skills/list": () => ok([]),
      "skills/pack": () => ok({ source: { repo: "tdduydev/xdev-skills", commit: "a".repeat(40) }, skills: [] }),
      "skillRepo/get": () => ok(null),
      ...opts.rpc,
    },
  });
}

/** Danh sách theo bộ lọc trạng thái như hub: mặc định tab lọc `pending`. */
function listOf(rows: LearnedSkillProposal[]): RpcHandler {
  return (input) => {
    const { status } = input as { status?: string };
    return ok(rows.filter((r) => !status || r.status === status));
  };
}

test("tab đề xuất từ agent: số liệu, lý do đáng học và nội dung SKILL.md", async ({ page }) => {
  await open(page, { rpc: { "skillLearning/list": listOf([proposal()]), "skillLearning/stats": () => ok(stats()) } });
  await page.goto("/knowledge/skills");
  const tab = page.getByRole("tab", { name: /Đề xuất từ agent/ });
  await expect(tab).toContainText("1");
  await tab.click();

  const metrics = page.getByRole("region", { name: "Số liệu việc học skill" });
  await expect(metrics).toContainText("67%");
  await expect(metrics).toContainText("Hôm nay 2/5");
  await expect(metrics).toContainText("0.84 USD");
  await expect(metrics).toContainText("120.000 token");

  await page.getByRole("button", { name: "Mở dòng lam-tron-tien" }).click();
  await expect(page.getByText("Task HD-12 thử lại 3 lần")).toBeVisible();
  await expect(page.getByText("Thử lại nhiều lần", { exact: true })).toBeVisible();
  await expect(page.getByText("Chi phí vượt p90", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "2b2b2b2b" })).toBeVisible();
  await expect(page.getByText("Lưu số nguyên đơn vị nhỏ nhất.")).toBeVisible();
});

test("tính năng tắt thì có chỉ dẫn bật ở Chính sách agent", async ({ page }) => {
  await open(page, {
    rpc: {
      "skillLearning/list": listOf([]),
      "skillLearning/stats": () => ok(stats({ enabled: false, proposals: 0, approvalRate: null })),
    },
  });
  await page.goto("/knowledge/skills");
  await page.getByRole("tab", { name: /Đề xuất từ agent/ }).click();
  await expect(page.getByText("Tính năng đang tắt")).toBeVisible();
  await expect(page.getByText("Chưa có đề xuất nào từ agent.")).toBeVisible();
});

test("duyệt: chọn phạm vi skill mới, gửi ghi chú, hiện kết quả lưu skill", async ({ page }) => {
  let rows = [proposal()];
  const hub = await open(page, {
    rpc: {
      "skillLearning/list": (input, call, h) => listOf(rows)(input, call, h),
      "skillLearning/stats": () => ok(stats()),
      "skillLearning/approve": (input) => {
        const { id } = input as { id: string };
        const done = proposal({
          id,
          status: "approved",
          decidedBy: "u1",
          decisionNote: "Hay",
          delivery: {
            mode: "saved",
            prNumber: null,
            prUrl: null,
            error: null,
            skillId: "5e5e5e5e-0000-4000-8000-000000000001",
            version: 1,
          },
        });
        rows = [done];
        return ok(done);
      },
    },
  });
  await page.goto("/knowledge/skills");
  await page.getByRole("tab", { name: /Đề xuất từ agent/ }).click();
  await page.getByRole("button", { name: "Mở dòng lam-tron-tien" }).click();
  await page.getByLabel("Lưu skill ở phạm vi").selectOption("team");
  await page.getByLabel("Ghi chú khi duyệt").fill("Hay");
  await page.getByRole("button", { name: "Duyệt và lưu skill" }).click();
  await expect(page.getByText("Đã lưu thành skill, phiên bản 1")).toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "skillLearning/approve")?.input).toEqual({
    id: proposal().id,
    scope: "team",
    note: "Hay",
  });
  // Quyết xong thì không còn nút quyết.
  await expect(page.getByRole("button", { name: "Duyệt và lưu skill" })).toHaveCount(0);
});

test("đã nối kho Git: nút là Duyệt và mở PR; PR chưa có thì báo lỗi và sẽ thử lại", async ({ page }) => {
  const repo = {
    id: "r1",
    connectionId: "c1",
    owner: "acme",
    name: "xdev-skills",
    branch: "main",
    status: "ok",
    lastSha: null,
    lastSyncedAt: null,
    error: null,
    webhookUrl: null,
    hubOnly: 0,
  };
  await open(page, {
    rpc: {
      "skillRepo/get": () => ok(repo),
      "skillLearning/list": listOf([proposal()]),
      "skillLearning/stats": () => ok(stats()),
      "skillLearning/approve": (input) =>
        ok(
          proposal({
            id: (input as { id: string }).id,
            status: "approved",
            delivery: { mode: "pr", prNumber: null, prUrl: null, error: "Git đang bận", skillId: null, version: null },
          }),
        ),
    },
  });
  await page.goto("/knowledge/skills");
  await page.getByRole("tab", { name: /Đề xuất từ agent/ }).click();
  await page.getByRole("button", { name: "Mở dòng lam-tron-tien" }).click();
  await page.getByRole("button", { name: "Duyệt và mở PR" }).click();
  await expect(page.getByRole("alert")).toContainText("Chưa mở được PR, hub sẽ thử lại: Git đang bận");
});

test("từ chối bắt buộc có lý do và gửi lý do cho hub", async ({ page }) => {
  const hub = await open(page, {
    rpc: {
      "skillLearning/list": listOf([proposal()]),
      "skillLearning/stats": () => ok(stats()),
      "skillLearning/reject": (input) =>
        ok(
          proposal({
            id: (input as { id: string }).id,
            status: "rejected",
            decisionNote: (input as { reason: string }).reason,
          }),
        ),
    },
  });
  await page.goto("/knowledge/skills");
  await page.getByRole("tab", { name: /Đề xuất từ agent/ }).click();
  await page.getByRole("button", { name: "Mở dòng lam-tron-tien" }).click();
  await page.getByRole("button", { name: "Từ chối", exact: true }).click();
  await expect(page.getByText("Cần ghi lý do từ chối.")).toBeVisible();
  expect(hub.rpcCalls.some((c) => c.path === "skillLearning/reject")).toBe(false);
  await page.getByLabel("Lý do từ chối").fill("Quá riêng cho một task");
  await page.getByRole("button", { name: "Từ chối", exact: true }).click();
  await expect(page.getByText("Ghi chú: Quá riêng cho một task")).toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "skillLearning/reject")?.input).toEqual({
    id: proposal().id,
    reason: "Quá riêng cho một task",
  });
});

test("xung đột phiên bản: giữ nguyên ghi chú và không giả vờ đã duyệt", async ({ page }) => {
  await open(page, {
    rpc: {
      "skillLearning/list": listOf([proposal()]),
      "skillLearning/stats": () => ok(stats()),
      "skillLearning/approve": () =>
        fail("CONFLICT", 409, "Skill lam-tron-tien đã ở phiên bản 2.", { code: "VERSION_CONFLICT" }),
    },
  });
  await page.goto("/knowledge/skills");
  await page.getByRole("tab", { name: /Đề xuất từ agent/ }).click();
  await page.getByRole("button", { name: "Mở dòng lam-tron-tien" }).click();
  await page.getByLabel("Ghi chú khi duyệt").fill("Giữ ghi chú");
  await page.getByRole("button", { name: "Duyệt và lưu skill" }).click();
  await expect(page.getByRole("alert")).toContainText("đã ở phiên bản 2");
  await expect(page.getByLabel("Ghi chú khi duyệt")).toHaveValue("Giữ ghi chú");
});

test("đề xuất sửa skill hiện diff với bản hiện tại", async ({ page }) => {
  const existing = {
    id: "6f6f6f6f-0000-4000-8000-000000000001",
    name: "lam-tron-tien",
    description: "cũ",
    scope: { level: "project", teamId: TEAM_ID, projectId: PROJECT_ID },
    version: 1,
    updatedAt: at,
    updatedBy: { userId: "u1", runId: null },
  };
  await open(page, {
    rpc: {
      "skills/list": () => ok([existing]),
      "skills/get": () => ok({ ...existing, content: "## Khi nào dùng\nTính tiền." }),
      "skillLearning/list": listOf([
        proposal({ kind: "edit", baseVersion: 1, content: "## Khi nào dùng\nTính tiền.\n- Thêm bước kiểm tổng." }),
      ]),
      "skillLearning/stats": () => ok(stats()),
    },
  });
  await page.goto("/knowledge/skills");
  await page.getByRole("tab", { name: /Đề xuất từ agent/ }).click();
  await page.getByRole("button", { name: "Mở dòng lam-tron-tien" }).click();
  const diff = page.getByRole("region", { name: "Thay đổi so với bản hiện tại" });
  await expect(diff.locator(".bg-success-soft")).toContainText("Thêm bước kiểm tổng.");
  // Skill sửa giữ phạm vi của skill đang sửa: không hỏi phạm vi mới.
  await expect(page.getByLabel("Lưu skill ở phạm vi")).toHaveCount(0);
});

test("thành viên thường của đội không có nút duyệt hay từ chối", async ({ page }) => {
  await open(page, {
    teamRole: "member",
    rpc: { "skillLearning/list": listOf([proposal()]), "skillLearning/stats": () => ok(stats()) },
  });
  await page.goto("/knowledge/skills");
  await page.getByRole("tab", { name: /Đề xuất từ agent/ }).click();
  await page.getByRole("button", { name: "Mở dòng lam-tron-tien" }).click();
  await expect(page.getByText("Task HD-12 thử lại 3 lần")).toBeVisible();
  await expect(page.getByRole("button", { name: "Duyệt và lưu skill" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Từ chối", exact: true })).toHaveCount(0);
});
