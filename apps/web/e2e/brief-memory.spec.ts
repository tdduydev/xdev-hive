import { expect, type Page, test } from "@playwright/test";
import { fail, fakeHub, ok, type RpcHandler } from "./fake-hub.ts";

const at = "2026-10-12T03:00:00.000Z";
const ORG_ID = "0a0a0a0a-0000-4000-8000-00000000000a";
const TEAM_ID = "7e7e7e7e-0000-4000-8000-000000000001";
const PROJECT = {
  id: "9a9a9a9a-0000-4000-8000-000000000001",
  systemId: "5e5e5e5e-0000-4000-8000-000000000001",
  teamId: TEAM_ID,
  key: "PAY",
  name: "payment-api",
  state: "active",
  repo: {
    mode: "existing",
    connectionId: "c0c0c0c0-0000-4000-8000-000000000001",
    kind: "github",
    owner: "acme",
    name: "payment-api",
    defaultBranch: "main",
    visibility: "private",
    httpUrl: null,
    sshUrl: null,
    webUrl: null,
  },
  settings: {
    merge: { mode: "review", requiredApprovals: 1 },
    outcome: { default: [], byType: {} },
    features: { planMode: false, crossReview: false, mergeQueue: false, leaderChat: false, sandbox: false },
    issueIntake: { enabled: false, label: "hive", mention: "hive" },
    brief: { auto: true, refreshCommits: 50, refreshDays: 7 },
  },
  createdBy: "u1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const brief = (over: Record<string, unknown> = {}) => ({
  projectId: PROJECT.id,
  content: "# payment-api\n\nTóm tắt repo.",
  version: 3,
  commitSha: "a".repeat(40),
  source: "agent",
  updatedBy: { userId: null, runId: "2b2b2b2b-0000-4000-8000-000000000001" },
  updatedAt: at,
  headSha: "b".repeat(40),
  commitsBehind: 12,
  refreshRunId: null as string | null,
  ...over,
});

async function open(page: Page, rpc: Record<string, RpcHandler>) {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_ID);
  return fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [{ id: ORG_ID, slug: "acme", name: "Acme", role: "admin", emailDomain: null, createdAt: at }],
          canCreateOrg: false,
        }),
      "projects/list": () => ok([PROJECT]),
      "orgMembers/list": () => ok([]),
      "teams/list": () => ok([]),
      "notifications/unreadCount": () => ok({ count: 0 }),
      ...rpc,
    },
  });
}

test("brief dự án: xem, báo lệch, lưu lệch phiên bản thì báo, sửa lại và làm mới", async ({ page }) => {
  let current = brief();
  const runId = "4d4d4d4d-0000-4000-8000-000000000009";
  const hub = await open(page, {
    "briefs/get": () => ok(current),
    "briefs/save": (input) => {
      const { content, baseVersion } = input as { content: string; baseVersion: number };
      if (baseVersion !== current.version) {
        return fail("CONFLICT", 409, "Phiên bản brief đã đổi.", { code: "VERSION_CONFLICT" });
      }
      current = brief({
        content,
        version: current.version + 1,
        source: "user",
        commitSha: null,
        commitsBehind: null,
        updatedBy: { userId: "u1", runId: null },
      });
      return ok(current);
    },
    "briefs/refresh": () => {
      current = { ...current, refreshRunId: runId };
      return ok({ runId });
    },
  });
  await page.goto("/projects/PAY/settings");

  const card = page.getByRole("group", { name: "Brief dự án" });
  await expect(card.getByText("Tóm tắt repo.")).toBeVisible();
  await expect(card).toContainText("v3");
  await expect(card).toContainText("aaaaaaa");
  await expect(card).toContainText("Agent");
  await expect(card.getByRole("status")).toContainText("Nhánh chính đã đi trước 12 commit");

  // Có người lưu trước: lưu từ phiên bản cũ phải báo bằng tiếng Việt và giữ nguyên chữ đang gõ.
  await card.getByRole("button", { name: "Sửa", exact: true }).click();
  const editor = card.getByRole("textbox", { name: "Nội dung brief (Markdown)" });
  await editor.fill("# payment-api\n\nBản sửa tay.");
  current = brief({ version: 4, content: "# payment-api\n\nAgent vừa viết lại." });
  await card.getByRole("button", { name: "Lưu brief" }).click();
  await expect(card.getByRole("alert")).toContainText("Brief vừa được người khác hoặc agent cập nhật");
  await expect(editor).toHaveValue("# payment-api\n\nBản sửa tay.");
  await card.getByRole("button", { name: "Huỷ" }).click();
  await expect(card).toContainText("Agent vừa viết lại.");
  expect(hub.rpcCalls.filter((c) => c.path === "briefs/save").at(-1)?.input).toMatchObject({
    project: "PAY",
    baseVersion: 3,
  });

  await card.getByRole("button", { name: "Sửa", exact: true }).click();
  await card.getByRole("textbox", { name: "Nội dung brief (Markdown)" }).fill("# payment-api\n\nBản sửa tay.");
  await card.getByRole("button", { name: "Lưu brief" }).click();
  await expect(card).toContainText("Bản sửa tay.");
  await expect(card).toContainText("v5");
  await expect(card).toContainText("Người");
  await expect(card.getByRole("status")).toHaveCount(0);
  expect(hub.rpcCalls.filter((c) => c.path === "briefs/save").at(-1)?.input).toMatchObject({ baseVersion: 4 });

  await card.getByRole("button", { name: "Làm mới" }).click();
  await expect(card.getByRole("button", { name: "Làm mới" })).toBeDisabled();
  await expect(card.getByRole("link", { name: "4d4d4d4d" })).toHaveAttribute("href", `/runs/${runId}`);
  expect(hub.rpcCalls.find((c) => c.path === "briefs/refresh")?.input).toEqual({ project: "PAY" });
});

test("brief dự án: chưa có thì viết tay từ phiên bản 0 và lưu ngưỡng làm mới", async ({ page }) => {
  let current: ReturnType<typeof brief> | null = null;
  const hub = await open(page, {
    "briefs/get": () => ok(current),
    "briefs/save": (input) => {
      current = brief({
        content: (input as { content: string }).content,
        version: 1,
        source: "user",
        commitsBehind: null,
      });
      return ok(current);
    },
    "projects/updateSettings": (input) => ok({ ...PROJECT.settings, ...(input as { settings: object }).settings }),
  });
  await page.goto("/projects/PAY/settings");

  const card = page.getByRole("group", { name: "Brief dự án" });
  await expect(card).toContainText("Dự án chưa có brief.");
  await card.getByRole("button", { name: "Viết tay" }).click();
  await card.getByRole("textbox", { name: "Nội dung brief (Markdown)" }).fill("# Brief tay");
  await card.getByRole("button", { name: "Lưu brief" }).click();
  await expect(card).toContainText("v1");
  expect(hub.rpcCalls.find((c) => c.path === "briefs/save")?.input).toMatchObject({
    project: "PAY",
    content: "# Brief tay",
    baseVersion: 0,
  });

  await card.getByRole("switch", { name: "Tự cập nhật brief" }).click();
  await card.getByRole("textbox", { name: "Làm mới sau số commit" }).fill("20");
  await card.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect
    .poll(() => hub.rpcCalls.find((c) => c.path === "projects/updateSettings")?.input)
    .toMatchObject({ key: "PAY", settings: { brief: { auto: false, refreshCommits: 20, refreshDays: 7 } } });
});

test("memory: duyệt hoặc bỏ memory agent đề xuất ở tab Chờ duyệt", async ({ page }) => {
  const scope = { level: "org", teamId: null, projectId: null };
  const pending = (n: number, content: string, runId: string | null) => ({
    id: `0a0a0a0a-0000-4000-8000-00000000010${n}`,
    kind: "gotcha",
    status: "pending",
    content,
    files: ["src/money.ts"],
    scope,
    author: { userId: null, runId },
    createdAt: at,
    supersededBy: null,
  });
  const runId = "2b2b2b2b-0000-4000-8000-000000000001";
  let queue = [
    pending(1, "Làm tròn theo dòng, không theo tổng.", runId),
    pending(2, "Đừng gọi API thật trong test.", null),
  ];
  const hub = await open(page, {
    "memory/list": (input) => ok((input as { status?: string }).status === "pending" ? queue : []),
    "memory/approve": (input) => {
      const found = queue.find((item) => item.id === (input as { id: string }).id);
      queue = queue.filter((item) => item !== found);
      return ok({ ...found, status: "approved" });
    },
    "memory/reject": (input) => {
      queue = queue.filter((item) => item.id !== (input as { id: string }).id);
      return ok({ ok: true });
    },
  });
  await page.goto("/knowledge/memory");

  const tab = page.getByRole("tab", { name: /Chờ duyệt/ });
  await expect(tab).toContainText("2");
  await tab.click();
  const panel = page.getByRole("tabpanel");
  await expect(panel).toContainText("Làm tròn theo dòng, không theo tổng.");
  await expect(panel.getByRole("link", { name: /Run 2b2b2b2b/ })).toHaveAttribute("href", `/runs/${runId}`);

  await panel.getByRole("button", { name: "Duyệt" }).first().click();
  await expect(panel).not.toContainText("Làm tròn theo dòng, không theo tổng.");
  expect(hub.rpcCalls.find((c) => c.path === "memory/approve")?.input).toEqual({
    id: "0a0a0a0a-0000-4000-8000-000000000101",
  });

  await panel.getByRole("button", { name: "Bỏ" }).click();
  // Bỏ memory hỏi lại: hộp thoại nêu nội dung sẽ bị bỏ.
  const confirm = page.getByRole("dialog", { name: "Bỏ memory này?" });
  await expect(confirm).toContainText("Đừng gọi API thật trong test.");
  await confirm.getByRole("button", { name: "Bỏ memory" }).click();
  await expect(panel).toContainText("Không có memory nào chờ duyệt.");
  expect(hub.rpcCalls.find((c) => c.path === "memory/reject")?.input).toEqual({
    id: "0a0a0a0a-0000-4000-8000-000000000102",
  });
  expect(
    hub.rpcCalls.some((c) => c.path === "memory/list" && (c.input as { status?: string }).status === "pending"),
  ).toBe(true);
});
