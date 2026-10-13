import { expect, type Page, test } from "@playwright/test";
import { fail, fakeHub, ok, type RpcHandler } from "./fake-hub.ts";

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
  accountId: null,
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
  ownerUserId: "u1",
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
  await page
    .getByRole("link", { name: /payment-api|PAY/ })
    .first()
    .click();
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
  await page.getByRole("textbox", { name: "Mỗi run" }).fill("3.5");

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
  await expect
    .poll(() => h.rpcCalls.find((c) => c.path === "projects/updateSettings")?.input)
    .toMatchObject({
      key: "PAY",
      settings: { budget: { perRunUsd: 3.5 }, runPermissions: { mode: "full" } },
    });
});

test("cấu hình dự án: Tiết kiệm token hiện mặc định, sửa và lưu đúng bản vá, số sai báo ở ô", async ({ page }) => {
  const h = await open(page, "admin", {
    "projects/updateSettings": (input) => {
      const patch = (input as { settings: Record<string, unknown> }).settings;
      return ok({ ...PROJECT.settings, ...patch });
    },
  });
  await page.goto("/projects/PAY/settings");
  // Dự án lưu trước khi có mục này: form hiện mặc định (bật, 15.000 ký tự, 70%, sonnet, 5 phút).
  await expect(page.getByRole("switch", { name: "Bật tiết kiệm token" })).toBeChecked();
  await expect(page.getByRole("textbox", { name: "Output lệnh tối đa" })).toHaveValue("15000");
  await expect(page.getByRole("textbox", { name: "Tự nén ngữ cảnh khi đầy" })).toHaveValue("70");
  await expect(page.getByRole("textbox", { name: "Model của subagent" })).toHaveValue("sonnet");
  await expect(page.getByLabel("Thời gian giữ cache")).toHaveValue("5m");

  await page.getByRole("textbox", { name: "Output lệnh tối đa" }).fill("500");
  await page.getByRole("button", { name: "Lưu cấu hình" }).click();
  await expect(page.getByText("Tối thiểu 1.000 ký tự.")).toBeVisible();
  expect(h.rpcCalls.some((c) => c.path === "projects/updateSettings")).toBe(false);

  await page.getByRole("textbox", { name: "Output lệnh tối đa" }).fill("8000");
  await page.getByRole("textbox", { name: "Model của subagent" }).fill("haiku");
  await page.getByLabel("Thời gian giữ cache").selectOption("1h");
  await page.getByRole("button", { name: "Lưu cấu hình" }).click();
  await expect
    .poll(() => h.rpcCalls.find((c) => c.path === "projects/updateSettings")?.input)
    .toMatchObject({
      key: "PAY",
      settings: { tokenSaving: { enabled: true, bashMaxChars: 8000, subagentModel: "haiku", cacheTtl: "1h" } },
    });

  // Tắt cả nhóm thì các ô khoá lại.
  await page.getByRole("switch", { name: "Bật tiết kiệm token" }).click();
  await expect(page.getByRole("textbox", { name: "Output lệnh tối đa" })).toBeDisabled();
});

test("cấu hình dự án: chính sách tổ chức khoá toàn quyền", async ({ page }) => {
  await open(page, "admin", { "policies/get": () => ok({ allowFullPermission: false }) });
  await page.goto("/projects/PAY/settings");
  await expect(page.getByText("Chính sách agent của tổ chức không cho dự án bật toàn quyền")).toBeVisible();
  await expect(page.getByLabel(/Toàn quyền/)).toBeDisabled();
  await expect(page.getByLabel(/Trong worktree/)).toBeEnabled();
});

test("cấu hình dự án: thành viên thường chỉ xem", async ({ page }) => {
  await open(page, "member");
  await page.goto("/projects/PAY/settings");
  await expect(page.getByRole("note")).toContainText("chế độ chỉ đọc");
  await expect(page.getByRole("textbox", { name: "Mỗi run" })).toBeDisabled();
});

test("danh sách run: lọc theo trạng thái gửi đúng tham số và giữ trên URL", async ({ page }) => {
  const h = await open(page, "member", {
    "runs/search": (input) => {
      const status = (input as { status?: string }).status;
      const items = status === "failed" ? [run(2, { state: "failed" })] : [run(1, {}), run(2, { state: "failed" })];
      return ok({ items, nextCursor: null, machines: [] });
    },
  });
  await page.goto("/runs?status=failed");
  await expect(page).toHaveURL(/status=failed/);
  await expect(page.getByText("PAY-1", { exact: false })).toHaveCount(0);
  await expect(page.getByText("PAY-2", { exact: false })).toBeVisible();
  expect(h.rpcCalls.filter((c) => c.path === "runs/search").at(-1)?.input).toMatchObject({
    status: "failed",
    limit: 50,
  });
  await expect(page.getByRole("status").filter({ hasText: "Đang lọc" })).toContainText("Lỗi");
  await page.getByRole("button", { name: "Bỏ lọc Trạng thái", exact: true }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await expect(page.getByText("PAY-1", { exact: false })).toBeVisible();
});

const MACHINE_ID = "3c3c3c3c-0000-4000-8000-000000000001";
function tableItems() {
  return Array.from({ length: 23 }, (_, index) => {
    const n = index + 1;
    return run(n, {
      id: `2b2b2b2b-0000-4000-8000-${String(n).padStart(12, "0")}`,
      state: n % 3 === 0 ? "failed" : "running",
      cli: n % 2 === 0 ? "codex" : "claude",
      machineId: MACHINE_ID,
      machineName: "mac-mini-lan",
      cost: cost(n),
      startedAt: "2026-10-11T06:00:00.000Z",
    });
  });
}
async function openTable(page: Page, rpc: Record<string, RpcHandler> = {}) {
  const items = tableItems();
  const h = await open(page, "member", {
    "runs/search": () => ok({ items, nextCursor: null, machines: [{ id: MACHINE_ID, name: "mac-mini-lan" }] }),
    "runs/cancel": (input) => {
      const item = items.find((row) => row.id === (input as { id: string }).id);
      if (item) item.state = "cancelling";
      return ok(item);
    },
    "runs/get": (input) => ok(items.find((row) => row.id === (input as { id: string }).id)),
    "runs/events": () => ok([]),
    "runs/logs": () => ok([]),
    ...rpc,
  });
  await page.route("**/api/v1/runs/*/stream?*", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: "" }),
  );
  await page.goto("/runs");
  await expect(page.getByRole("table")).toBeVisible();
  return h;
}

test("bảng run: facet nhiều lựa chọn, đếm theo bộ lọc khác, xoá từng bộ lọc và xoá hết", async ({ page }) => {
  await openTable(page);
  await page.getByRole("button", { name: "Trạng thái", exact: true }).click();
  const status = page.getByRole("dialog", { name: "Trạng thái", exact: true });
  await expect(
    status.locator("label").filter({ has: page.getByRole("checkbox", { name: "Lỗi", exact: true }) }),
  ).toContainText("7");
  await status.getByRole("checkbox", { name: "Lỗi", exact: true }).check();
  await status.getByRole("checkbox", { name: "Đang chạy", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(page.getByText("1–10 trên 23", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Đang lọc" })).toContainText("Lỗi, Đang chạy");
  await page
    .locator('[data-slot="popover-trigger"]')
    .filter({ hasText: /^Agent$/ })
    .click();
  const agent = page.getByRole("dialog", { name: "Agent", exact: true });
  await expect(agent.locator("label").filter({ hasText: "Codex" })).toContainText("11");
  await agent.getByRole("checkbox", { name: "Codex", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(page.getByText("1–10 trên 11", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Bỏ lọc Trạng thái", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đang lọc" })).not.toContainText("Trạng thái:");
  await page.getByRole("button", { name: "Xoá hết bộ lọc", exact: true }).click();
  await expect(page.getByText("1–10 trên 23", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Đang lọc" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Tìm theo mã run, việc, tiêu đề…" }).fill("Việc số 23");
  await expect(page.getByText("1–1 trên 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Bỏ lọc Từ khoá", exact: true }).click();
  await expect(page.getByText("1–10 trên 23", { exact: true })).toBeVisible();
});

test("bảng run: sắp xếp số, ẩn cột, chọn trang, phân trang và mở bằng dòng/bàn phím", async ({ page }) => {
  const h = await openTable(page);
  const bodyRows = page.getByRole("table").locator("tbody tr");
  await page.getByRole("button", { name: "Chi phí", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "Chi phí" })).toHaveAttribute("aria-sort", "ascending");
  await page.getByRole("button", { name: "Chi phí", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "Chi phí" })).toHaveAttribute("aria-sort", "descending");
  await expect(bodyRows.first()).toContainText("Việc số 23");
  await page.getByRole("button", { name: "Cột", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Máy", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("columnheader", { name: "Máy", exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Chọn PAY-23", exact: true }).check();
  await expect(page.getByRole("checkbox", { name: "Chọn cả trang" })).toHaveAttribute("aria-checked", "mixed");
  await page.getByRole("checkbox", { name: "Chọn cả trang" }).check();
  await expect(page.getByRole("toolbar", { name: "Thao tác hàng loạt" })).toContainText("Đã chọn 10 dòng");
  await expect(page.getByRole("button", { name: "Huỷ run", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Trang sau", exact: true }).click();
  await expect(page.getByText("11–20 trên 23", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Chọn cả trang" })).not.toBeChecked();
  await page.getByRole("button", { name: "Trang sau", exact: true }).click();
  await expect(page.getByText("21–23 trên 23", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Trang sau", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "Số dòng", exact: true }).selectOption("20");
  await expect(bodyRows).toHaveCount(20);
  await expect(page.getByText("1–20 trên 23", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Bỏ chọn", exact: true }).click();
  await bodyRows.first().getByText("Việc số 23", { exact: true }).click();
  await expect(page).toHaveURL(/\/runs\/2b2b2b2b-0000-4000-8000-000000000023$/);
  expect(h.rpcCalls.some((call) => call.path === "runs/cancel")).toBe(false);
  await page.goto("/runs");
  const openRow = page.getByRole("button", { name: "Mở dòng PAY-1", exact: true });
  await openRow.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/runs\/2b2b2b2b-0000-4000-8000-000000000001$/);
});

test("bảng run: huỷ hàng loạt có xác nhận, chỉ gửi các dòng đã chọn", async ({ page }) => {
  const h = await openTable(page);
  await page.getByRole("checkbox", { name: "Chọn PAY-1", exact: true }).check();
  await page.getByRole("checkbox", { name: "Chọn PAY-2", exact: true }).check();
  await page
    .getByRole("toolbar", { name: "Thao tác hàng loạt" })
    .getByRole("button", { name: "Huỷ run", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Huỷ các run đã chọn?" });
  await expect(dialog).toContainText("PAY-1, PAY-2");
  await dialog.getByRole("button", { name: "Không huỷ" }).click();
  expect(h.rpcCalls.filter((call) => call.path === "runs/cancel")).toHaveLength(0);
  await page
    .getByRole("toolbar", { name: "Thao tác hàng loạt" })
    .getByRole("button", { name: "Huỷ run", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Huỷ run", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(h.rpcCalls.filter((call) => call.path === "runs/cancel").map((call) => call.input)).toEqual([
    { id: "2b2b2b2b-0000-4000-8000-000000000001" },
    { id: "2b2b2b2b-0000-4000-8000-000000000002" },
  ]);
});

test("bảng run: giữ các phạm vi URL và gọi con trỏ khi tải thêm", async ({ page }) => {
  const h = await open(page, "member", {
    "runs/search": (input) => {
      const cursor = (input as { cursor?: string }).cursor;
      return ok({
        items: cursor ? [run(2, { state: "failed" })] : [run(1, { state: "failed" })],
        nextCursor: cursor ? null : "2b2b2b2b-0000-4000-8000-000000000001",
        machines: [{ id: MACHINE_ID, name: "mac-mini-lan" }],
      });
    },
  });
  await page.goto(`/runs?status=failed&project=PAY&cli=codex&machine=${MACHINE_ID}`);
  await expect(page.getByRole("table")).toBeVisible();
  const first = { status: "failed", projectId: PROJECT.id, cli: "codex", machineId: MACHINE_ID, limit: 50 };
  expect(h.rpcCalls.filter((call) => call.path === "runs/search").at(-1)?.input).toEqual(first);
  await page.getByRole("button", { name: "Xem thêm", exact: true }).click();
  await expect(page.getByText("1–2 trên 2", { exact: true })).toBeVisible();
  expect(h.rpcCalls.filter((call) => call.path === "runs/search").at(-1)?.input).toEqual({
    ...first,
    cursor: "2b2b2b2b-0000-4000-8000-000000000001",
  });
  await page.getByRole("button", { name: "Xoá hết bộ lọc", exact: true }).click();
  await expect(page).toHaveURL(/\/runs$/);
});

for (const scheme of ["light", "dark"] as const) {
  test(`bảng run: ảnh ${scheme}, 360px không tràn và facet dùng bàn phím`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openTable(page);
    await page.screenshot({ path: testInfo.outputPath(`runs-${scheme}.png`), fullPage: true });
    await page.setViewportSize({ width: 360, height: 800 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const container = page.locator('[data-slot="table-container"]');
    expect(await container.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await page
      .locator('[data-slot="popover-trigger"]')
      .filter({ hasText: /^Agent$/ })
      .focus();
    await page.keyboard.press("Enter");
    const option = page
      .getByRole("dialog", { name: "Agent", exact: true })
      .getByRole("checkbox", { name: "Claude", exact: true });
    await option.focus();
    await page.keyboard.press("Space");
    await expect(option).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /^Agent/ }).first()).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`runs-360-${scheme}.png`), fullPage: true });
    await page.getByRole("checkbox", { name: "Chọn PAY-1", exact: true }).check();
    await expect(page.getByRole("checkbox", { name: "Chọn cả trang" })).toHaveAttribute("aria-checked", "mixed");
    await page.screenshot({ path: testInfo.outputPath(`runs-selected-360-${scheme}.png`), fullPage: true });
  });
}

test("bảng run: tiếng Anh và trạng thái trống vẫn dùng được bộ lọc", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
  await openTable(page);
  await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Search run, task or title…" }).fill("no-such-task");
  await expect(page.getByText("No rows match these filters.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
  await page
    .getByRole("status")
    .filter({ hasText: "Filtering" })
    .getByRole("button", { name: "Clear all filters", exact: true })
    .click();
  await expect(page.getByText("1–10 of 23", { exact: true })).toBeVisible();
});

test("bảng run: huỷ thành công một phần thì chỉ thử lại các run bị lỗi", async ({ page }) => {
  let first = true;
  const h = await openTable(page, {
    "runs/cancel": (input) => {
      const id = (input as { id: string }).id;
      if (id.endsWith("2") && first) {
        first = false;
        return fail("CONFLICT", 409, "Run đã đổi trạng thái.");
      }
      return ok(tableItems().find((row) => row.id === id));
    },
  });
  await page.getByRole("checkbox", { name: "Chọn PAY-1", exact: true }).check();
  await page.getByRole("checkbox", { name: "Chọn PAY-2", exact: true }).check();
  await page
    .getByRole("toolbar", { name: "Thao tác hàng loạt" })
    .getByRole("button", { name: "Huỷ run", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Huỷ các run đã chọn?" });
  await dialog.getByRole("button", { name: "Huỷ run", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("PAY-2: Run đã đổi trạng thái.");
  await expect(dialog.getByText(/Máy đang chạy sẽ dừng/)).not.toContainText("PAY-1");
  await dialog.getByRole("button", { name: "Huỷ run", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(h.rpcCalls.filter((call) => call.path === "runs/cancel").map((call) => call.input)).toEqual([
    { id: "2b2b2b2b-0000-4000-8000-000000000001" },
    { id: "2b2b2b2b-0000-4000-8000-000000000002" },
    { id: "2b2b2b2b-0000-4000-8000-000000000002" },
  ]);
});
