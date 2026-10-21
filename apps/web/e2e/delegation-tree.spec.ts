import { expect, type Page, test } from "@playwright/test";
import { fakeHub, ok, type RpcHandler } from "./fake-hub.ts";

// Cây giao việc của phiên Leader (specs/028): tab trên trang Leader, poll khi còn việc chạy, lối mở từ trang run.
const ORG_ID = "0a0a0a0a-0000-4000-8000-00000000000a";
const TEAM_ID = "7e7e7e7e-0000-4000-8000-000000000001";
const PROJECT = { id: "9a9a9a9a-0000-4000-8000-000000000001", key: "PAY", name: "payment-api" };
const THREAD = {
  id: "4d4d4d4d-0000-4000-8000-000000000001",
  projectId: PROJECT.id,
  title: "Phân quyền menu",
  createdAt: "2026-10-21T01:00:00.000Z",
  updatedAt: "2026-10-21T01:05:00.000Z",
};
const TASK_ID = "1a1a1a1a-0000-4000-8000-000000000001";
const CODE_RUN = "2b2b2b2b-0000-4000-8000-000000000001";
const REVIEW_RUN = "2b2b2b2b-0000-4000-8000-000000000002";
const MACHINE = { id: "3c3c3c3c-0000-4000-8000-000000000001", name: "mac-mini-lan" };

const treeRun = (over: Record<string, unknown>) => ({
  kind: "code",
  state: "succeeded",
  attempt: 1,
  parentRunId: null,
  machine: MACHINE,
  cli: "claude",
  account: "Pro",
  startedAt: "2026-10-21T01:00:00.000Z",
  endedAt: "2026-10-21T01:04:00.000Z",
  costUsd: 0.42,
  error: null,
  subagents: [],
  subagentsUnsupported: false,
  ...over,
});

/** Cây theo lượt hỏi: lượt đầu run code đang chạy với một sub-agent, từ lượt hai thì xong. */
function tree(done: boolean) {
  return {
    thread: { id: THREAD.id, title: THREAD.title, createdAt: THREAD.createdAt },
    hidden: 2,
    active: !done,
    tasks: [
      {
        id: TASK_ID,
        key: "PAY-1",
        title: "Bảng quyền theo vai trò",
        status: done ? "review" : "running",
        projectKey: "PAY",
        createdBy: "leader",
        runs: [
          treeRun({
            id: CODE_RUN,
            state: done ? "succeeded" : "running",
            endedAt: done ? "2026-10-21T01:04:00.000Z" : null,
            subagents: [
              {
                id: "toolu_1",
                parentId: null,
                type: "Explore",
                description: "Tìm chỗ kiểm quyền",
                status: done ? "completed" : "running",
                depth: 1,
                tokens: done ? 15_300 : null,
                toolUses: 4,
                durationMs: done ? 42_000 : null,
              },
            ],
          }),
          treeRun({ id: REVIEW_RUN, kind: "review", parentRunId: CODE_RUN }),
        ],
      },
      {
        id: "1a1a1a1a-0000-4000-8000-000000000002",
        key: "PAY-2",
        title: "Ẩn menu khi không có quyền",
        status: "running",
        projectKey: "PAY",
        createdBy: "user",
        runs: [
          treeRun({
            id: "2b2b2b2b-0000-4000-8000-000000000003",
            state: "failed",
            cli: "codex",
            error: "Test hỏng: menu.spec.ts",
            subagents: null,
            subagentsUnsupported: true,
          }),
        ],
      },
    ],
  };
}

const RUN = {
  id: CODE_RUN,
  taskId: TASK_ID,
  projectId: PROJECT.id,
  teamId: TEAM_ID,
  kind: "code",
  parentRunId: null,
  state: "succeeded",
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
  cost: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.42, turns: null },
  explore: null,
  rtk: null,
  createdBy: "u1",
  ownerUserId: "u1",
  createdAt: "2026-10-21T01:00:00.000Z",
  startedAt: "2026-10-21T01:00:00.000Z",
  finishedAt: "2026-10-21T01:04:00.000Z",
  updatedAt: "2026-10-21T01:04:00.000Z",
};

async function open(page: Page, rpc: Record<string, RpcHandler> = {}) {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_ID);
  // Trang run mở luồng log SSE; trả luồng rỗng để không chạm hub thật.
  await page.route("**/api/v1/runs/*/stream**", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "" }),
  );
  let polls = 0;
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [
            { id: ORG_ID, slug: "acme", name: "Acme", role: "admin", emailDomain: null, createdAt: THREAD.createdAt },
          ],
          canCreateOrg: false,
        }),
      "projects/list": () => ok([PROJECT]),
      "leader/threads/list": () => ok([THREAD]),
      "leader/threads/get": () => ok({ thread: THREAD, messages: [] }),
      "leader/approvals/list": () => ok([]),
      "terminal/list": () => ok([]),
      "leader/tree/get": () => {
        polls += 1;
        return ok(tree(polls > 1));
      },
      ...rpc,
    },
  });
  return { hub, polls: () => polls };
}

test("cây giao việc: tab trên trang Leader, cập nhật khi run đổi trạng thái, mở trang run", async ({ page }) => {
  const { hub, polls } = await open(page);
  await page.goto("/leader");
  await page.getByRole("tab", { name: "Cây giao việc" }).click();
  await expect(page).toHaveURL(/view=tree/);

  const tree = page.getByRole("tree", { name: "Cây giao việc: Phân quyền menu" });
  await expect(tree.getByRole("treeitem", { name: "Phiên Leader: Phân quyền menu" })).toBeVisible();
  await expect(page.getByText("2 mục bị ẩn do quyền")).toBeVisible();
  const task = tree.getByRole("treeitem", { name: /^PAY-1 Bảng quyền theo vai trò/ });
  await expect(task).toContainText("Leader tạo");
  await expect(tree.getByRole("treeitem", { name: /^PAY-2 / })).toContainText("Người tạo, Leader giao");
  await expect(tree.getByRole("treeitem", { name: /^Run Viết code, Lỗi/ })).toContainText("Test hỏng: menu.spec.ts");
  await expect(tree.getByRole("treeitem", { name: /^Run Viết code, Lỗi/ })).toContainText(
    "Không theo dõi được sub-agent của CLI này",
  );
  // Run review nằm dưới run code, không ngang hàng.
  await expect(tree.getByRole("treeitem", { name: /^Run Review chéo/ })).toHaveAttribute("aria-level", "4");
  await expect(tree.getByRole("treeitem", { name: /^Sub-agent Explore: Tìm chỗ kiểm quyền, Đang chạy/ })).toBeVisible();

  // Còn việc chạy thì hỏi lại sau 3 giây: run và sub-agent chuyển xong trong 5 giây, không tải lại trang.
  await expect(tree.getByRole("treeitem", { name: /^Run Viết code, Thành công/ })).toBeVisible({ timeout: 5000 });
  await expect(tree.getByRole("treeitem", { name: /^Sub-agent Explore: .*, Xong/ })).toContainText("15,3k token");
  expect(polls()).toBeGreaterThanOrEqual(2);

  // Lọc chỉ đang chạy hoặc lỗi: còn task có run lỗi.
  await page.getByRole("button", { name: "Chỉ đang chạy hoặc lỗi" }).click();
  await expect(tree.getByRole("treeitem", { name: /^PAY-1 / })).toHaveCount(0);
  await expect(tree.getByRole("treeitem", { name: /^PAY-2 / })).toBeVisible();
  await page.getByRole("button", { name: "Chỉ đang chạy hoặc lỗi" }).click();

  // Tìm theo tên task, gõ không dấu.
  await page.getByRole("searchbox", { name: "Tìm theo tên hoặc mã task" }).fill("an menu");
  await expect(tree.getByRole("treeitem", { name: /^PAY-1 / })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Tìm theo tên hoặc mã task" }).fill("");

  // Bàn phím: xuống tới task, trái thu gọn, phải mở lại, phải nữa vào run, Enter mở trang run.
  await tree.getByRole("treeitem", { name: /^Phiên Leader/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(task).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(task).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  await expect(task).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowRight");
  await expect(tree.getByRole("treeitem", { name: /^Run Viết code, Thành công/ })).toBeFocused();

  await page.route("**/rpc/runs/get**", (route) => route.fulfill({ status: 200, json: { json: RUN } }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/runs/${CODE_RUN}$`));
  expect(hub.rpcCalls.find((c) => c.path === "leader/tree/get")?.input).toEqual({ id: THREAD.id });
});

test("cây giao việc: trang run có lối mở cây của phiên đã giao run", async ({ page }) => {
  const { hub } = await open(page, {
    "runs/get": () => ok(RUN),
    "leader/tree/links": () => ok([{ threadId: THREAD.id, title: THREAD.title }]),
  });
  await page.goto(`/runs/${CODE_RUN}`);
  await page.getByRole("link", { name: "Xem trong cây giao việc" }).click();
  await expect(page).toHaveURL(new RegExp(`/leader\\?thread=${THREAD.id}&view=tree`));
  await expect(page.getByRole("tab", { name: "Cây giao việc" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tree", { name: "Cây giao việc: Phân quyền menu" })).toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "leader/tree/links")?.input).toEqual({ runId: CODE_RUN });
});

for (const scheme of ["light", "dark"] as const) {
  test(`cây giao việc: 360 px, ${scheme}, không cuộn ngang`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    await page.goto(`/leader?thread=${THREAD.id}&view=tree`);
    await expect(page.getByRole("tree", { name: "Cây giao việc: Phân quyền menu" })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: /^Sub-agent Explore/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`delegation-tree-360-${scheme}.png`), fullPage: true });
  });
}
