import { expect, type Page, test } from "@playwright/test";
import { fail, fakeHub, ok, type RpcHandler } from "./fake-hub.ts";

// Khung Lịch sử của task trên trang run (specs/027 FR-006): nguồn, máy, người, giờ tạo, giờ nhận, lý do từ chối.
const ORG = { id: "0a0a0a0a-0000-4000-8000-00000000000a", slug: "acme", name: "Acme", role: "member" };
const TEAM_ID = "7e7e7e7e-0000-4000-8000-000000000001";
const PROJECT_ID = "9a9a9a9a-0000-4000-8000-000000000001";
const TASK = {
  id: "1a1a1a1a-0000-4000-8000-000000000001",
  projectId: PROJECT_ID,
  teamId: TEAM_ID,
  key: "PAY-1",
  number: 1,
  title: "Sửa làm tròn tiền trong hoá đơn VAT",
  body: "",
  type: null,
  status: "running",
  preferredCli: null,
  source: { kind: "web" },
  createdBy: "u1",
  createdAt: "2026-10-22T01:00:00.000Z",
  updatedAt: "2026-10-22T01:00:00.000Z",
};
const MACHINE = { id: "3c3c3c3c-0000-4000-8000-000000000001", name: "mac-mini-lan" };
const RUN = {
  id: "2b2b2b2b-0000-4000-8000-000000000001",
  taskId: TASK.id,
  projectId: PROJECT_ID,
  teamId: TEAM_ID,
  kind: "code",
  parentRunId: null,
  state: "running",
  attempt: 1,
  maxAttempts: 3,
  machineId: MACHINE.id,
  machineName: MACHINE.name,
  cli: "claude",
  model: null,
  pinnedMachineId: null,
  branch: "ai/PAY-1",
  policySnapshot: [],
  result: null,
  headSha: null,
  prUrl: null,
  timeoutSec: 3600,
  cost: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, turns: null },
  explore: null,
  rtk: null,
  createdBy: "u1",
  ownerUserId: "u1",
  createdAt: "2026-10-22T01:00:00.000Z",
  startedAt: "2026-10-22T01:01:00.000Z",
  finishedAt: null,
  updatedAt: "2026-10-22T01:01:00.000Z",
};

const HISTORY = [
  {
    at: "2026-10-22T01:00:30.000Z",
    clientCreatedAt: null,
    kind: "run.queued",
    outcome: "accepted",
    source: "worker-run",
    machine: MACHINE,
    actor: { id: "u1", name: "Lan Anh" },
    reasonCode: null,
    reason: null,
  },
  {
    // Gửi lại từ hộp thư đi: client tạo lúc mất mạng, hub nhận sau 20 phút.
    at: "2026-10-22T01:30:00.000Z",
    clientCreatedAt: "2026-10-22T01:10:00.000Z",
    kind: "task_update",
    outcome: "accepted",
    source: "mcp-local",
    machine: MACHINE,
    actor: { id: "u1", name: "Lan Anh" },
    reasonCode: null,
    reason: null,
  },
  {
    at: "2026-10-22T01:31:00.000Z",
    clientCreatedAt: "2026-10-22T01:12:00.000Z",
    kind: "task_update",
    outcome: "rejected",
    source: "hive-cli",
    machine: null,
    actor: null,
    reasonCode: "TASK_CANCELLED",
    reason: "Task đã huỷ.",
  },
];

async function open(page: Page, rpc: Record<string, RpcHandler> = {}) {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG.id);
  await page.route("**/api/v1/runs/*/stream**", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "" }),
  );
  return fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () => ok({ orgs: [{ ...ORG, emailDomain: null, createdAt: TASK.createdAt }], canCreateOrg: false }),
      "runs/get": () => ok(RUN),
      "tasks/get": () => ok(TASK),
      "tasks/history": () => ok(HISTORY),
      ...rpc,
    },
  });
}

test("lịch sử task: nguồn, máy, người, giờ tạo và giờ nhận, lý do từ chối", async ({ page }) => {
  const hub = await open(page);
  await page.goto(`/runs/${RUN.id}`);

  const history = page.getByRole("region", { name: "Lịch sử" });
  const items = history.getByRole("listitem");
  await expect(items).toHaveCount(3);

  await expect(items.nth(0)).toContainText("Run: ");
  await expect(items.nth(0)).toContainText("Nguồn: Worker (run)");
  await expect(items.nth(0)).toContainText("Máy: mac-mini-lan");

  const resent = items.nth(1);
  await expect(resent).toContainText("Cập nhật tiến độ");
  await expect(resent).toContainText("Nguồn: MCP tại máy");
  await expect(resent).toContainText("Người: Lan Anh");
  await expect(resent.locator(`time[datetime="${HISTORY[1]?.clientCreatedAt}"]`)).toBeVisible();
  await expect(resent.locator(`time[datetime="${HISTORY[1]?.at}"]`)).toBeVisible();
  await expect(resent).not.toContainText("Bị từ chối");

  const rejected = items.nth(2);
  await expect(rejected).toContainText("Bị từ chối");
  await expect(rejected).toContainText("Nguồn: Lệnh hive");
  await expect(rejected).toContainText("Lý do: Task đã huỷ. (TASK_CANCELLED)");
  await expect(rejected).not.toContainText("Máy:");

  expect(hub.rpcCalls.find((c) => c.path === "tasks/history")?.input).toEqual({ id: TASK.id });
});

test("lịch sử task: chưa có lần ghi", async ({ page }) => {
  await open(page, { "tasks/history": () => ok([]) });
  await page.goto(`/runs/${RUN.id}`);
  await expect(page.getByRole("region", { name: "Lịch sử" })).toContainText("Chưa có lần ghi nào.");
});

test("lịch sử task: lỗi hub hiện bằng tiếng Việt, trang run vẫn dùng được", async ({ page }) => {
  await open(page, { "tasks/history": () => fail("FORBIDDEN", 403, "Bạn không xem được task này.") });
  await page.goto(`/runs/${RUN.id}`);
  await expect(page.getByRole("region", { name: "Lịch sử" })).toContainText("Bạn không xem được task này.");
  await expect(page.getByRole("heading", { name: TASK.title })).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`lịch sử task: 360 px, ${scheme}, không cuộn ngang`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    await page.goto(`/runs/${RUN.id}`);
    await expect(page.getByRole("region", { name: "Lịch sử" }).getByRole("listitem")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`task-history-360-${scheme}.png`), fullPage: true });
  });
}
