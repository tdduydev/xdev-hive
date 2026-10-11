import { expect, type Page, test } from "@playwright/test";
import { fakeHub, ok, type RpcHandler } from "./fake-hub.ts";

const NOW = "2026-10-11T07:10:00.000Z";
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
    budget: { perRunUsd: 2 },
  },
  createdBy: "u1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const cost = (costUsd: number | null) => ({
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd,
  turns: null,
});

const run = (n: number, over: Record<string, unknown>) => ({
  id: `2b2b2b2b-0000-4000-8000-00000000000${n}`,
  taskId: `1a1a1a1a-0000-4000-8000-00000000000${n}`,
  projectId: PROJECT.id,
  teamId: TEAM_ID,
  kind: "code",
  parentRunId: null,
  state: "running",
  attempt: 1,
  maxAttempts: 3,
  machineId: null,
  machineName: null,
  cli: "claude",
  model: null,
  pinnedMachineId: null,
  branch: `ai/PAY-${n}`,
  policySnapshot: [],
  result: null,
  headSha: null,
  prUrl: null,
  timeoutSec: 3600,
  cost: cost(null),
  createdBy: "u1",
  createdAt: "2026-10-11T06:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  updatedAt: "2026-10-11T06:00:00.000Z",
  taskKey: `PAY-${n}`,
  taskTitle: `Việc số ${n}`,
  ...over,
});

function hub(role: "admin" | "member"): Record<string, RpcHandler> {
  return {
    "orgs/mine": () =>
      ok({
        orgs: [
          {
            id: "0a0a0a0a-0000-4000-8000-00000000000a",
            slug: "acme",
            name: "Acme",
            role,
            emailDomain: null,
            createdAt: PROJECT.createdAt,
          },
        ],
        canCreateOrg: false,
      }),
    "projects/list": () => ok([PROJECT]),
    "projects/get": () => ok(PROJECT),
    "orgMembers/list": () => ok([]),
    "teams/list": () => ok([]),
    "systems/list": () => ok([]),
    "scmConnections/list": () => ok([]),
    "runs/latest": () => ok([]),
    "costs/summary": () => ok({ totalUsd: 0, byDay: [], byTask: [], byCli: [], byMachine: [] }),
  };
}

async function open(page: Page, role: "admin" | "member", rpc: Record<string, RpcHandler> = {}) {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(() => localStorage.setItem("hive.org", "0a0a0a0a-0000-4000-8000-00000000000a"));
  return fakeHub(page, { signedIn: true, rpc: { ...hub(role), ...rpc } });
}

test("danh sách dự án: hiện dự án và dẫn tới bảng việc của dự án", async ({ page }) => {
  await open(page, "member");
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Dự án", exact: true })).toBeVisible();
  await expect(page.getByText("payment-api").first()).toBeVisible();
  await page.getByRole("link", { name: /payment-api|PAY/ }).first().click();
  await expect(page).toHaveURL(/\/projects\/PAY/);
});

test("cấu hình dự án: quản trị sửa ngân sách, bật toàn quyền phải xác nhận, lưu đúng bản vá", async ({ page }) => {
  const h = await open(page, "admin", {
    "projects/updateSettings": (input) => {
      const patch = (input as { settings: Record<string, unknown> }).settings;
      return ok({ ...PROJECT.settings, ...patch });
    },
  });
  await page.goto("/projects/PAY/settings");
  await page.getByLabel("Mỗi run").fill("3.5");

  await page.getByLabel(/Toàn quyền/).click();
  const dialog = page.getByRole("dialog", { name: "Cho agent toàn quyền?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Giữ trong worktree" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel(/Toàn quyền/)).not.toBeChecked();

  await page.getByLabel(/Toàn quyền/).click();
  await page.getByRole("dialog").getByRole("button", { name: "Bật toàn quyền" }).click();
  await expect(page.getByLabel(/Toàn quyền/)).toBeChecked();

  await page.getByRole("button", { name: "Lưu cấu hình" }).click();
  await expect.poll(() => h.rpcCalls.find((c) => c.path === "projects/updateSettings")?.input).toMatchObject({
    key: "PAY",
    settings: { budget: { perRunUsd: 3.5 }, runPermissions: { mode: "full" } },
  });
});

test("cấu hình dự án: thành viên thường chỉ xem", async ({ page }) => {
  await open(page, "member");
  await page.goto("/projects/PAY/settings");
  await expect(page.getByRole("note")).toContainText("chế độ chỉ đọc");
  await expect(page.getByLabel("Mỗi run")).toBeDisabled();
});

test("danh sách run: lọc theo trạng thái gửi đúng tham số và giữ trên URL", async ({ page }) => {
  const h = await open(page, "member", {
    "runs/search": (input) => {
      const status = (input as { status?: string }).status;
      const items = status === "failed" ? [run(2, { state: "failed" })] : [run(1, {}), run(2, { state: "failed" })];
      return ok({ items, nextCursor: null, machines: [] });
    },
  });
  await page.goto("/runs");
  await expect(page.getByText("PAY-1")).toBeVisible();
  await expect(page.getByText("PAY-2")).toBeVisible();

  await page.getByRole("button", { name: "Lỗi", exact: true }).click();
  await expect(page).toHaveURL(/status=failed/);
  await expect(page.getByText("PAY-1")).toHaveCount(0);
  await expect(page.getByText("PAY-2")).toBeVisible();
  expect(h.rpcCalls.filter((c) => c.path === "runs/search").at(-1)?.input).toMatchObject({ status: "failed" });
});
