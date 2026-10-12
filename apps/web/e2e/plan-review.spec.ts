import { expect, type Page, test } from "@playwright/test";
import { fail, fakeHub, ok, type RpcHandler } from "./fake-hub.ts";

// Plan mode trên web: bảng việc lọc "Chờ duyệt kế hoạch", màn kế hoạch, sửa theo form, duyệt, từ chối và lập lại.
const NOW = "2026-10-11T07:10:00.000Z";
const ORG = { id: "0a0a0a0a-0000-4000-8000-00000000000a", slug: "acme", name: "Acme", role: "member" };
const TEAM_ID = "7e7e7e7e-0000-4000-8000-000000000001";
const PROJECT_ID = "9a9a9a9a-0000-4000-8000-000000000001";
const PROJECT = {
  id: PROJECT_ID,
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
    features: { planMode: true, crossReview: false, mergeQueue: false, leaderChat: false, sandbox: false },
    issueIntake: { enabled: false, label: "hive", mention: "hive" },
    budget: { perRunUsd: 2 },
  },
  createdBy: "u1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const task = (n: number, title: string, status: string) => ({
  id: `1a1a1a1a-0000-4000-8000-00000000000${n}`,
  projectId: PROJECT_ID,
  teamId: TEAM_ID,
  key: `PAY-${n}`,
  number: n,
  title,
  body: "",
  type: null,
  status,
  preferredCli: null,
  source: { kind: "web" },
  createdBy: "u1",
  createdAt: `2026-10-11T0${n}:00:00.000Z`,
  updatedAt: `2026-10-11T0${n}:00:00.000Z`,
});

const AWAITING = task(3, "Làm tròn VAT theo từng dòng hoá đơn", "awaiting_plan");
const PLANNING = task(2, "Thêm phân trang cho API giao dịch", "queued");
const TODO = task(1, "Hướng dẫn cài worker trên Windows", "todo");
const TASKS = [TODO, PLANNING, AWAITING];

const run = (id: string, over: Record<string, unknown>) => ({
  id,
  taskId: AWAITING.id,
  projectId: PROJECT_ID,
  teamId: TEAM_ID,
  kind: "code",
  parentRunId: null,
  state: "queued",
  attempt: 1,
  maxAttempts: 3,
  machineId: null,
  machineName: null,
  cli: "claude",
  model: null,
  pinnedMachineId: null,
  branch: "ai/PAY-3",
  policySnapshot: [],
  result: null,
  headSha: null,
  prUrl: null,
  timeoutSec: 3600,
  cost: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, turns: null },
  createdBy: "u1",
  createdAt: "2026-10-11T06:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  updatedAt: "2026-10-11T06:00:00.000Z",
  ...over,
});

const CODE_RUN = run("2b2b2b2b-0000-4000-8000-000000000003", { state: "awaiting_plan" });
const PLAN_RUN = run("4d4d4d4d-0000-4000-8000-000000000002", {
  kind: "plan",
  parentRunId: CODE_RUN.id,
  state: "succeeded",
  startedAt: "2026-10-11T06:01:00.000Z",
  finishedAt: "2026-10-11T06:04:00.000Z",
});
const OLD_PLAN_RUN_ID = "4d4d4d4d-0000-4000-8000-000000000001";
const PLANNING_RUN = run("2b2b2b2b-0000-4000-8000-000000000002", {
  taskId: PLANNING.id,
  branch: "ai/PAY-2",
  state: "planning",
});
const PLANNING_CHILD = run("4d4d4d4d-0000-4000-8000-000000000003", {
  taskId: PLANNING.id,
  kind: "plan",
  parentRunId: PLANNING_RUN.id,
  state: "running",
});
const RUNS = [PLANNING_RUN, CODE_RUN];

const CONTENT = {
  summary: "Đổi làm tròn sang từng dòng hoá đơn rồi mới cộng tổng, theo Thông tư 78.",
  steps: [
    { title: "Sửa hàm roundVat()", detail: "Làm tròn từng dòng theo đồng trước khi cộng." },
    { title: "Thêm migration đánh dấu hoá đơn cũ" },
    { title: "Viết test cho số âm và hoá đơn nhiều dòng" },
  ],
  files: [
    { path: "src/vat/round.ts", change: "modify", reason: "Hàm làm tròn" },
    { path: "db/migrations/0042_vat_rounding.sql", change: "add" },
    { path: "src/vat/legacy.ts", change: "delete", reason: "Không còn dùng" },
  ],
  risks: ["Hoá đơn cũ có thể lệch 1 đồng so với bản in."],
  questions: ["Có cần làm tròn lại các hoá đơn đã xuất không?"],
};

const PLAN_ID = "5f5f5f5f-0000-4000-8000-000000000002";
const PLANS = [
  {
    id: PLAN_ID,
    taskId: AWAITING.id,
    runId: CODE_RUN.id,
    planRunId: PLAN_RUN.id,
    revision: 2,
    status: "awaiting",
    content: CONTENT,
    editedContent: null,
    note: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: "2026-10-11T06:04:00.000Z",
    updatedAt: "2026-10-11T06:04:00.000Z",
  },
  {
    id: "5f5f5f5f-0000-4000-8000-000000000001",
    taskId: AWAITING.id,
    runId: "2b2b2b2b-0000-4000-8000-0000000000a1",
    planRunId: OLD_PLAN_RUN_ID,
    revision: 1,
    status: "rejected",
    content: {
      summary: "Làm tròn tổng hoá đơn.",
      steps: [{ title: "Sửa roundVat()" }],
      files: [],
      risks: [],
      questions: [],
    },
    editedContent: null,
    note: "Thiếu bước migration cho hoá đơn cũ.",
    decidedBy: "u2",
    decidedAt: "2026-10-11T05:30:00.000Z",
    createdAt: "2026-10-11T05:20:00.000Z",
    updatedAt: "2026-10-11T05:30:00.000Z",
  },
];

const MEMBERS = [
  { userId: "u1", name: "Trần Đức Duy", email: "duy@example.com", image: null, role: "member", status: "active" },
  { userId: "u2", name: "Lê Minh Anh", email: "anh@example.com", image: null, role: "member", status: "active" },
].map((m) => ({
  ...m,
  joinedAt: "2026-10-01T00:00:00.000Z",
  teams: [{ teamId: TEAM_ID, name: "Thanh toán", role: "member" }],
}));

function hub(canDecide = true): Record<string, RpcHandler> {
  return {
    "orgs/mine": () => ok({ orgs: [{ ...ORG, emailDomain: null, createdAt: PROJECT.createdAt }], canCreateOrg: false }),
    "projects/list": () => ok([PROJECT]),
    "projects/get": () => ok(PROJECT),
    "tasks/list": () => ok(TASKS),
    "tasks/get": (input) => ok(TASKS.find((t) => t.id === (input as { id: string }).id)),
    "runs/latest": () => ok(RUNS),
    "runs/list": (input) =>
      ok((input as { taskId: string }).taskId === PLANNING.id ? [PLANNING_CHILD, PLANNING_RUN] : [PLAN_RUN, CODE_RUN]),
    "runs/get": (input) => {
      const found = [...RUNS, PLAN_RUN].find((r) => r.id === (input as { id: string }).id);
      return found ? ok(found) : fail("NOT_FOUND", 404, "Không tìm thấy run trong tổ chức.", { code: "RUN_NOT_FOUND" });
    },
    "tasks/plans/list": () => ok({ plans: PLANS, canDecide }),
    "orgMembers/list": () => ok(MEMBERS),
  };
}

async function open(page: Page, rpc: Record<string, RpcHandler> = {}, canDecide = true) {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG.id);
  // Màn run mở SSE; trả `end` ngay để test không chờ luồng log.
  await page.route("**/api/v1/runs/*/stream**", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: `event: end\ndata: ${JSON.stringify({ state: "awaiting_plan" })}\n\n`,
    }),
  );
  return fakeHub(page, { signedIn: true, rpc: { ...hub(canDecide), ...rpc } });
}

const decision = (status: string, runOver: Record<string, unknown> = {}) =>
  ok({ plan: { ...PLANS[0], status }, run: { ...CODE_RUN, ...runOver } });

test("bảng việc: nhãn lập kế hoạch, chờ duyệt và lọc “Chờ duyệt kế hoạch”", async ({ page }) => {
  await open(page);
  await page.goto("/tasks");
  const rows = page.getByRole("table", { name: "Danh sách việc" }).locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "PAY-2" })).toContainText("Đang lập kế hoạch");
  await expect(rows.filter({ hasText: "PAY-3" })).toContainText("Chờ duyệt kế hoạch");

  const filters = page.getByRole("group", { name: "Lọc theo trạng thái" });
  await filters.getByRole("button", { name: /Chờ duyệt kế hoạch/ }).click();
  await expect(page).toHaveURL(/status=plan/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("PAY-3");

  await page.getByRole("link", { name: "Xem và duyệt kế hoạch của PAY-3" }).click();
  await expect(page).toHaveURL("/tasks/PAY-3/plan");
  await expect(page.getByRole("heading", { name: AWAITING.title })).toBeVisible();
});

test("màn kế hoạch: các bước, file, rủi ro, câu hỏi, run đã lập, lịch sử bị từ chối kèm lý do", async ({ page }) => {
  const fake = await open(page);
  await page.goto("/tasks/PAY-3/plan");
  await expect(page.getByText("Chờ duyệt", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Lần lập 2")).toBeVisible();
  await expect(page.getByRole("region", { name: "Thông tin", exact: true })).toContainText("Claude");
  await expect(page.getByText(CONTENT.summary)).toBeVisible();
  const steps = page.getByRole("region", { name: "Các bước" }).getByRole("listitem");
  await expect(steps).toHaveCount(3);
  await expect(steps.first()).toContainText("Sửa hàm roundVat()Làm tròn từng dòng");
  const files = page.getByRole("region", { name: "File dự kiến đụng" });
  await expect(files).toContainText("Sửasrc/vat/round.ts");
  await expect(files).toContainText("Thêmdb/migrations/0042_vat_rounding.sql");
  await expect(files).toContainText("Xoásrc/vat/legacy.ts");
  await expect(page.getByRole("region", { name: "Rủi ro" })).toContainText("lệch 1 đồng");
  await expect(page.getByRole("region", { name: "Câu hỏi cho người duyệt" })).toContainText("hoá đơn đã xuất");
  await expect(page.getByRole("link", { name: /Log run lập kế hoạch 4d4d4d4d/ })).toHaveAttribute(
    "href",
    `/runs/${PLAN_RUN.id}`,
  );

  const history = page.getByRole("region", { name: "Các lần lập" });
  await expect(history.getByRole("listitem").filter({ hasText: "Lần 1" }).first()).toContainText(
    "từ chối bởi Lê Minh Anh",
  );
  await expect(history).toContainText("Lý do: Thiếu bước migration cho hoá đơn cũ.");
  await history.getByText("Xem kế hoạch lần 1").click();
  await expect(history).toContainText("Làm tròn tổng hoá đơn.");
  await expect(history.getByRole("link", { name: "Log run lập kế hoạch" }).last()).toHaveAttribute(
    "href",
    `/runs/${OLD_PLAN_RUN_ID}`,
  );
  expect(fake.rpcCalls.find((c) => c.path === "tasks/plans/list")).toMatchObject({
    org: ORG.id,
    input: { id: AWAITING.id },
  });
});

test("sửa kế hoạch theo form rồi duyệt kèm ghi chú", async ({ page }) => {
  const fake = await open(page, { "tasks/plans/approve": () => decision("approved", { state: "queued" }) });
  await page.goto("/tasks/PAY-3/plan");
  await page.getByRole("button", { name: "Sửa kế hoạch" }).click();
  const form = page.getByRole("form", { name: "Sửa kế hoạch" });
  await expect(form.getByLabel("Tóm tắt")).toHaveValue(CONTENT.summary);

  // Lỗi hiện ngay cạnh ô sai, không gửi gì lên hub.
  await form.getByLabel("Tóm tắt").fill(" ");
  await form.getByRole("button", { name: "Thêm bước" }).click();
  await form.getByRole("group", { name: "Bước 4" }).getByLabel("Chi tiết (không bắt buộc)").fill("Chạy lại test");
  await form.getByRole("button", { name: "Dùng bản sửa" }).click();
  await expect(form.getByText("Tóm tắt kế hoạch không được để trống.")).toBeVisible();
  await expect(form.getByText("Bước cần có tiêu đề.")).toBeVisible();
  await expect(form.getByLabel("Tóm tắt")).toBeFocused();

  await form.getByLabel("Tóm tắt").fill("Làm tròn từng dòng, có migration.");
  await form.getByRole("group", { name: "Bước 4" }).getByLabel("Tiêu đề").fill("Chạy toàn bộ test VAT");
  await form.getByRole("button", { name: "Đưa bước 4 lên" }).click();
  await form.getByRole("button", { name: "Xoá file 3" }).click();
  await form.getByRole("group", { name: "File 2" }).getByLabel("Thay đổi").selectOption({ label: "Sửa" });
  await form.getByRole("button", { name: "Thêm câu hỏi" }).click();
  await form.getByRole("group", { name: "Câu hỏi 2" }).getByLabel("Nội dung").fill("Giữ API cũ không?");
  await form.getByRole("button", { name: "Dùng bản sửa" }).click();

  await expect(page.getByRole("button", { name: "Bản bạn vừa sửa (chưa gửi)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("Làm tròn từng dòng, có migration.")).toBeVisible();
  await page.getByRole("button", { name: "Bản agent nộp" }).click();
  await expect(page.getByText(CONTENT.summary)).toBeVisible();
  await page.getByRole("button", { name: "Bản bạn vừa sửa (chưa gửi)" }).click();

  await page.getByRole("button", { name: "Duyệt kế hoạch" }).click();
  const dialog = page.getByRole("dialog", { name: "Duyệt kế hoạch lần 2?" });
  await expect(dialog).toContainText("bản bạn vừa sửa");
  await expect(dialog).toContainText("Agent có 2 câu hỏi");
  await dialog.getByLabel("Ghi chú cho agent (không bắt buộc)").fill("Không làm tròn lại hoá đơn đã xuất.");
  await dialog.getByRole("button", { name: "Duyệt và chạy" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Đã duyệt kế hoạch" })).toBeVisible();

  const approve = fake.rpcCalls.find((c) => c.path === "tasks/plans/approve");
  expect(approve).toMatchObject({
    method: "POST",
    org: ORG.id,
    input: {
      id: AWAITING.id,
      planId: PLAN_ID,
      note: "Không làm tròn lại hoá đơn đã xuất.",
      content: {
        summary: "Làm tròn từng dòng, có migration.",
        steps: [
          CONTENT.steps[0],
          CONTENT.steps[1],
          { title: "Chạy toàn bộ test VAT", detail: "Chạy lại test" },
          CONTENT.steps[2],
        ],
        files: [CONTENT.files[0], { ...CONTENT.files[1], change: "modify" }],
        risks: CONTENT.risks,
        questions: [...CONTENT.questions, "Giữ API cũ không?"],
      },
    },
  });
});

test("duyệt nguyên bản: không gửi content; hub báo kế hoạch đã được quyết thì báo tiếng Việt", async ({ page }) => {
  let calls = 0;
  const fake = await open(page, {
    "tasks/plans/approve": () =>
      ++calls === 1
        ? fail("CONFLICT", 409, "Kế hoạch không còn chờ duyệt.", { code: "PLAN_DECIDED" })
        : decision("approved", { state: "queued" }),
  });
  await page.goto("/tasks/PAY-3/plan");
  await page.getByRole("button", { name: "Duyệt kế hoạch" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("kế hoạch agent nộp");
  await dialog.getByRole("button", { name: "Duyệt và chạy" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Kế hoạch này không còn chờ duyệt");
  await expect(dialog.getByRole("alert")).toContainText("Tải lại để xem bản mới nhất.");
  await dialog.getByRole("button", { name: "Duyệt và chạy" }).click();
  await expect(dialog).toBeHidden();
  const input = fake.rpcCalls.filter((c) => c.path === "tasks/plans/approve").at(-1)?.input;
  expect(input).toEqual({ id: AWAITING.id, planId: PLAN_ID });
});

test("từ chối: lý do bắt buộc; chọn lập lại thì agent lập kế hoạch mới", async ({ page }) => {
  const fake = await open(page, {
    "tasks/plans/reject": (input) =>
      decision("rejected", {
        id: "2b2b2b2b-0000-4000-8000-0000000000b1",
        state: (input as { replan: boolean }).replan ? "planning" : "cancelled",
      }),
  });
  await page.goto("/tasks/PAY-3/plan");
  await page.getByRole("button", { name: "Từ chối" }).click();
  const dialog = page.getByRole("dialog", { name: "Từ chối kế hoạch lần 2?" });
  await expect(dialog.getByLabel("Lý do từ chối")).toBeFocused();
  await dialog.getByRole("button", { name: "Từ chối kế hoạch" }).click();
  await expect(dialog.getByText("Cần ghi lý do từ chối")).toBeVisible();
  await expect(dialog.getByLabel("Lý do từ chối")).toHaveAttribute("aria-invalid", "true");
  expect(fake.rpcCalls.some((c) => c.path === "tasks/plans/reject")).toBe(false);

  await dialog.getByLabel("Lý do từ chối").fill("Tách migration thành PR riêng.");
  await dialog.getByLabel("Lập lại kế hoạch").check();
  await dialog.getByRole("button", { name: "Từ chối kế hoạch" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Agent đang lập lại kế hoạch" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Mở run 2b2b2b2b" })).toHaveAttribute(
    "href",
    "/runs/2b2b2b2b-0000-4000-8000-0000000000b1",
  );
  expect(fake.rpcCalls.find((c) => c.path === "tasks/plans/reject")?.input).toEqual({
    id: AWAITING.id,
    planId: PLAN_ID,
    reason: "Tách migration thành PR riêng.",
    replan: true,
  });
});

test("từ chối không lập lại: việc về chưa giao", async ({ page }) => {
  const fake = await open(page, { "tasks/plans/reject": () => decision("rejected", { state: "cancelled" }) });
  await page.goto("/tasks/PAY-3/plan");
  await page.getByRole("button", { name: "Từ chối" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Lý do từ chối").fill("Không cần làm nữa.");
  await dialog.getByRole("button", { name: "Từ chối kế hoạch" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Việc quay về chưa giao" })).toBeVisible();
  expect(fake.rpcCalls.find((c) => c.path === "tasks/plans/reject")?.input).toMatchObject({ replan: false });
});

test("người chỉ xem: không có nút duyệt, từ chối hay sửa", async ({ page }) => {
  await open(page, {}, false);
  await page.goto("/tasks/PAY-3/plan");
  await expect(page.getByText(CONTENT.summary)).toBeVisible();
  await expect(page.getByText("Bạn chỉ có quyền xem việc của đội này.")).toBeVisible();
  for (const name of ["Duyệt kế hoạch", "Từ chối", "Sửa kế hoạch"]) {
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  }
});

test("đang tải, lỗi tải, việc không thấy được, chưa có kế hoạch", async ({ page }) => {
  await open(page);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/tasks/plans/list**", async (route) => {
    await gate;
    await route.fallback();
  });
  await page.goto("/tasks/PAY-3/plan");
  await expect(page.locator("[aria-busy=true]")).toBeVisible();
  release();
  await expect(page.getByText(CONTENT.summary)).toBeVisible();

  await page.unroute("**/rpc/**");
  await fakeHub(page, {
    signedIn: true,
    rpc: { ...hub(), "tasks/plans/list": () => fail("FORBIDDEN", 403, "Bạn không có quyền làm việc này.") },
  });
  await page.reload();
  await expect(page.getByRole("alert")).toHaveText("Bạn không có quyền làm việc này.");

  await page.goto("/tasks/PAY-99/plan");
  await expect(page.getByRole("alert")).toContainText("Không tìm thấy việc PAY-99");

  await page.unroute("**/rpc/**");
  await fakeHub(page, {
    signedIn: true,
    rpc: { ...hub(), "tasks/plans/list": () => ok({ plans: [], canDecide: true }) },
  });
  await page.goto("/tasks/PAY-2/plan");
  await expect(page.getByRole("heading", { name: "Chưa có kế hoạch" })).toBeVisible();
  await expect(page.getByText("Agent đang lập kế hoạch")).toBeVisible();
});

test("chi tiết run: run code chờ duyệt dẫn tới màn kế hoạch; run plan có nhãn và link về run cha", async ({ page }) => {
  await open(page);
  await page.goto(`/runs/${CODE_RUN.id}`);
  await expect(page.getByText("Chờ duyệt kế hoạch").first()).toBeVisible();
  await expect(page.getByText("Kế hoạch đang chờ duyệt. Run này chỉ chạy tiếp")).toBeVisible();
  await page.getByRole("link", { name: "Xem và duyệt kế hoạch" }).click();
  await expect(page).toHaveURL("/tasks/PAY-3/plan");

  await page.goto(`/runs/${PLAN_RUN.id}`);
  await expect(page.getByText("Lập kế hoạch (chỉ đọc)")).toBeVisible();
  await expect(page.getByRole("link", { name: "Xem kế hoạch" })).toHaveAttribute("href", "/tasks/PAY-3/plan");
  await expect(page.getByRole("link", { name: /Run cha 2b2b2b2b/ })).toHaveAttribute("href", `/runs/${CODE_RUN.id}`);

  await page.goto(`/runs/${PLANNING_RUN.id}`);
  await expect(page.getByText("Agent đang lập kế hoạch trong một run riêng")).toBeVisible();
  await expect(page.getByRole("link", { name: "Xem log lập kế hoạch" })).toHaveAttribute(
    "href",
    `/runs/${PLANNING_CHILD.id}`,
  );
});

for (const scheme of ["light", "dark"] as const) {
  test(`chụp màn hình ${scheme}; rộng 360px không cuộn ngang`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/tasks?status=plan");
    await expect(page.getByRole("table", { name: "Danh sách việc" })).toBeVisible();
    await page.screenshot({ path: `test-results/screens/plan-board-${scheme}.png`, fullPage: true });
    await page.goto("/tasks/PAY-3/plan");
    await expect(page.getByText(CONTENT.summary)).toBeVisible();
    await page.screenshot({ path: `test-results/screens/plan-view-${scheme}.png`, fullPage: true });
    await page.getByRole("button", { name: "Sửa kế hoạch" }).click();
    await page.screenshot({ path: `test-results/screens/plan-edit-${scheme}.png`, fullPage: true });
    await page.getByRole("button", { name: "Huỷ sửa" }).click();
    await page.getByRole("button", { name: "Từ chối" }).click();
    await page.getByRole("dialog").getByLabel("Lý do từ chối").fill("Tách migration thành PR riêng.");
    await page.getByRole("dialog").getByLabel("Lập lại kế hoạch").check();
    await page.screenshot({ path: `test-results/screens/plan-reject-${scheme}.png` });
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 360, height: 800 });
    const noOverflow = async (what: string) => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${what} cuộn ngang ở 360px`).toBeLessThanOrEqual(0);
    };
    await page.goto("/tasks/PAY-3/plan");
    await expect(page.getByText(CONTENT.summary)).toBeVisible();
    await noOverflow("màn kế hoạch");
    await page.screenshot({ path: `test-results/screens/plan-view-360-${scheme}.png`, fullPage: true });
    await page.getByRole("button", { name: "Sửa kế hoạch" }).click();
    await expect(page.getByRole("form", { name: "Sửa kế hoạch" })).toBeVisible();
    await noOverflow("form sửa kế hoạch");
    await page.getByRole("button", { name: "Huỷ sửa" }).click();
    await page.getByRole("button", { name: "Duyệt kế hoạch" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await noOverflow("dialog duyệt");
    await page.screenshot({ path: `test-results/screens/plan-approve-360-${scheme}.png` });
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`kế hoạch: bản tiếng Anh, lịch sử, form sửa và dialog (${scheme})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
    await open(page);
    await page.goto("/tasks/PAY-3/plan");
    await expect(page.getByRole("region", { name: "Summary", exact: true })).toContainText(CONTENT.summary);
    await expect(page.getByRole("region", { name: "Steps", exact: true }).getByRole("listitem")).toHaveCount(3);
    const history = page.getByRole("region", { name: "Versions", exact: true });
    await expect(history).toContainText("Rejected");
    await history.getByText("View version 1", { exact: true }).click();
    await expect(history).toContainText("Làm tròn tổng hoá đơn.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`plan-en-360-${scheme}.png`), fullPage: true });
    await page.getByRole("button", { name: "Edit plan", exact: true }).click();
    const editor = page.getByRole("form", { name: "Edit plan", exact: true });
    await expect(editor.getByLabel("Summary", { exact: true })).toHaveValue(CONTENT.summary);
    await editor.getByLabel("Summary", { exact: true }).fill("");
    await editor.getByRole("button", { name: "Use edited version" }).click();
    await expect(editor.getByText("Plan summary cannot be empty.")).toBeVisible();
    await expect(editor.getByLabel("Summary", { exact: true })).toBeFocused();
    await editor.getByRole("button", { name: "Cancel edits" }).click();
    await page.getByRole("button", { name: "Approve plan", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Approve version 2?" });
    await expect(dialog.getByLabel("Note for the agent (optional)")).toBeVisible();
    await expect(dialog).toContainText("questions; answer them in the note:");
    await dialog.getByRole("button", { name: "Back", exact: true }).click();
    await expect(dialog).toBeHidden();
  });
}
