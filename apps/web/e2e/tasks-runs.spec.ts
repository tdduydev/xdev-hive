import { expect, type Page, test } from "@playwright/test";
import { fail, fakeHub, ok, type RpcHandler, USER } from "./fake-hub.ts";

// Giờ cố định để chữ "chạy được …", "xong … trước" và ô "Lỗi trong 24 giờ" không đổi theo ngày chạy test.
const NOW = "2026-10-11T07:10:00.000Z";
const ORG = { id: "0a0a0a0a-0000-4000-8000-00000000000a", slug: "acme", name: "Acme", role: "member" };
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

const task = (n: number, title: string, status: string, createdAt: string) => ({
  id: `1a1a1a1a-0000-4000-8000-00000000000${n}`,
  projectId: PROJECT.id,
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
  createdAt,
  updatedAt: createdAt,
});

const TASKS = [
  task(1, "Hướng dẫn cài worker trên Windows", "todo", "2026-10-11T01:00:00.000Z"),
  task(2, "Viết test cho webhook GitLab", "todo", "2026-10-11T02:00:00.000Z"),
  task(3, "Thêm phân trang cho API giao dịch", "review", "2026-10-11T03:00:00.000Z"),
  task(4, "Sửa làm tròn tiền trong hoá đơn VAT", "running", "2026-10-11T04:00:00.000Z"),
];

const cost = (costUsd: number | null, extra: Record<string, number> = {}) => ({
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd,
  turns: null,
  ...extra,
});

const run = (n: number, over: Record<string, unknown>) => ({
  id: `2b2b2b2b-0000-4000-8000-00000000000${n}`,
  taskId: TASKS[n - 1]?.id,
  projectId: PROJECT.id,
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
  ...over,
});

const MACHINE = "3c3c3c3c-0000-4000-8000-000000000001";
const RUNNING = run(4, {
  state: "running",
  machineId: MACHINE,
  machineName: "mac-mini-lan",
  model: "claude-sonnet-5-5",
  startedAt: "2026-10-11T07:04:00.000Z",
  cost: cost(0.42, { tokensIn: 182400, cacheRead: 141050, tokensOut: 9850, turns: 14 }),
  policySnapshot: [
    { check: "changes", required: true, deny: ["infra/prod/**"] },
    { check: "agentReport", required: true },
  ],
});
const RUNS = [
  run(2, { state: "failed", cli: "codex", attempt: 3, finishedAt: "2026-10-11T06:10:00.000Z", cost: cost(0.31) }),
  run(3, {
    state: "succeeded",
    cli: "codex",
    machineId: MACHINE,
    machineName: "linux-build-01",
    prUrl: "https://github.com/acme/payment-api/pull/128",
    finishedAt: "2026-10-11T06:58:00.000Z",
    cost: cost(1.18),
  }),
  RUNNING,
];

function board(): Record<string, RpcHandler> {
  return {
    "orgs/mine": () => ok({ orgs: [{ ...ORG, emailDomain: null, createdAt: PROJECT.createdAt }], canCreateOrg: false }),
    "projects/list": () => ok([PROJECT]),
    "projects/get": () => ok(PROJECT),
    "tasks/list": () => ok(TASKS),
    "runs/latest": () => ok(RUNS),
    "runs/get": (input) => {
      const found = RUNS.find((r) => r.id === (input as { id: string }).id);
      return found ? ok(found) : fail("NOT_FOUND", 404, "Không tìm thấy run trong tổ chức.", { code: "RUN_NOT_FOUND" });
    },
    "tasks/get": (input) => ok(TASKS.find((t) => t.id === (input as { id: string }).id)),
  };
}

async function open(page: Page, rpc: Record<string, RpcHandler> = {}) {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG.id);
  return fakeHub(page, { signedIn: true, rpc: { ...board(), ...rpc } });
}

/** Luồng SSE giả của hub: sự kiện, log rồi `end` như runs/stream.ts. */
async function fakeStream(page: Page, frames: { event: string; id?: string; data: unknown }[]) {
  const urls: string[] = [];
  await page.route("**/api/v1/runs/*/stream**", (route) => {
    urls.push(route.request().url());
    const body = frames
      .map((f) => `${f.id ? `id: ${f.id}\n` : ""}event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`)
      .join("");
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
  });
  return urls;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");
const stateEvent = (id: number, to: string, at: string) => ({
  event: "run_event",
  id: `${id}.0`,
  data: { id, attempt: 1, seq: null, type: "state", data: { to }, createdAt: at },
});

test("bảng việc: số liệu, lọc, tìm, mở run gần nhất", async ({ page }) => {
  const hub = await open(page);
  await page.goto("/tasks");

  await expect(page.getByRole("heading", { name: "Bảng việc" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Điều hướng chính" });
  await expect(nav.getByRole("link", { name: "Bảng việc" })).toHaveAttribute("aria-current", "page");
  // Mục chưa có màn vẫn trỏ tới route sẽ có.
  await expect(nav.getByRole("link", { name: "Máy", includeHidden: true })).toHaveAttribute("href", "/machines");
  await expect(nav.getByRole("link", { name: "Chi phí và token", includeHidden: true })).toHaveAttribute(
    "href",
    "/admin/costs",
  );
  await expect(nav.getByRole("link", { name: "Thông báo", includeHidden: true })).toHaveAttribute(
    "href",
    "/notifications",
  );

  const stats = page.getByRole("region", { name: "Số liệu" });
  await expect(stats).toContainText("Đang chạy1trên 1 máy");
  await expect(stats).toContainText("Chờ review và merge11 việc đã có PR");
  await expect(stats).toContainText("Lỗi trong 24 giờ1PAY-2");
  await expect(stats).toContainText("1,91 USD");

  const rows = page.getByRole("table", { name: "Danh sách việc" }).locator("tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText("PAY-4");
  await expect(rows.first()).toContainText("Đang chạy");
  await expect(rows.first()).toContainText("mac-mini-lan");
  await expect(rows.first()).toContainText("chạy được 6 phút");
  await expect(rows.nth(1)).toContainText("Chờ review PR");
  await expect(rows.nth(1).getByRole("link", { name: /#128/ })).toHaveAttribute(
    "href",
    "https://github.com/acme/payment-api/pull/128",
  );
  await expect(rows.nth(2)).toContainText("Lỗi");
  await expect(rows.nth(2)).toContainText("thử 3/3");
  await expect(rows.nth(3)).toContainText("Chưa giao");
  // Bảng chung gọi một lần cho mọi dự án, không gọi runs.list cho từng task.
  expect(hub.rpcCalls.find((c) => c.path === "tasks/list")?.input).toEqual({});
  expect(hub.rpcCalls.some((c) => c.path === "runs/list")).toBe(false);

  const filters = page.getByRole("group", { name: "Lọc theo trạng thái" });
  await filters.getByRole("button", { name: /Lỗi/ }).click();
  await expect(filters.getByRole("button", { name: /Lỗi/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/status=failed/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("PAY-2");

  await filters.getByRole("button", { name: /Tất cả/ }).click();
  await page.getByRole("searchbox", { name: "Tìm việc" }).fill("hoa don");
  await expect(rows).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Tìm việc" }).fill("không có");
  await expect(page.getByText("Không có việc nào khớp bộ lọc.")).toBeVisible();
  await page.getByRole("searchbox", { name: "Tìm việc" }).fill("");

  await fakeStream(page, [{ event: "end", data: { state: "running" } }]);
  await page.getByRole("link", { name: "PAY-4: mở run gần nhất" }).click();
  await expect(page).toHaveURL(`/runs/${RUNNING.id}`);
  await expect(page.getByRole("heading", { name: "Sửa làm tròn tiền trong hoá đơn VAT" })).toBeVisible();
});

test("tạo việc và giao ngay cho agent", async ({ page }) => {
  const hub = await open(page, {
    "tasks/create": (input) => ok({ ...task(5, (input as { title: string }).title, "todo", NOW) }),
    "runs/start": (input) => ok(run(5, { taskId: (input as { taskId: string }).taskId })),
  });
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Tạo việc" }).click();
  const dialog = page.getByRole("dialog", { name: "Tạo việc" });
  await dialog.getByRole("button", { name: "Tạo việc" }).click();
  await expect(dialog.getByText("Tiêu đề không được để trống.")).toBeVisible();
  expect(hub.rpcCalls.some((c) => c.path === "tasks/create")).toBe(false);

  await dialog.getByLabel("Tiêu đề").fill("Thêm log cho webhook");
  await dialog.getByLabel("Mô tả").fill("Ghi id delivery");
  await dialog.getByLabel("Agent", { exact: true }).selectOption({ label: "Codex" });
  await dialog.getByRole("button", { name: "Tạo việc" }).click();
  await expect(dialog).toBeHidden();
  expect(hub.rpcCalls.find((c) => c.path === "tasks/create")).toMatchObject({
    org: ORG.id,
    input: { projectId: PROJECT.id, title: "Thêm log cho webhook", body: "Ghi id delivery", preferredCli: "codex" },
  });
  expect(hub.rpcCalls.find((c) => c.path === "runs/start")?.input).toEqual({
    taskId: "1a1a1a1a-0000-4000-8000-000000000005",
  });
});

test("tạo được việc nhưng không giao được: báo rõ, không tạo lại", async ({ page }) => {
  await open(page, {
    "tasks/create": () => ok(task(5, "Việc mới", "todo", NOW)),
    "runs/start": () => fail("CONFLICT", 409, "Dự án chưa có máy nào của đội.", { code: "NO_MACHINE" }),
  });
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Tạo việc" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Tiêu đề").fill("Việc mới");
  await dialog.getByRole("button", { name: "Tạo việc" }).click();
  await expect(dialog.getByRole("heading", { name: "Đã tạo PAY-5" })).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("Dự án chưa có máy nào của đội.");
});

test("bảng việc của một dự án; dự án không thấy được thì báo", async ({ page }) => {
  const hub = await open(page);
  await page.goto("/projects/PAY");
  await expect(page.getByText("payment-api", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("table", { name: "Danh sách việc" }).locator("tbody tr")).toHaveCount(4);
  expect(hub.rpcCalls.find((c) => c.path === "tasks/list")?.input).toEqual({ projectId: PROJECT.id });
  expect(hub.rpcCalls.find((c) => c.path === "runs/latest")?.input).toEqual({ projectId: PROJECT.id });

  await page.goto("/projects/KHAC");
  await expect(page.getByRole("alert")).toContainText("Không tìm thấy dự án KHAC");
});

test("bảng việc rỗng và lỗi tải", async ({ page }) => {
  await open(page, { "tasks/list": () => ok([]), "runs/latest": () => ok([]) });
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "Chưa có việc nào" })).toBeVisible();

  await page.unroute("**/rpc/**");
  await fakeHub(page, {
    signedIn: true,
    rpc: { ...board(), "tasks/list": () => fail("FORBIDDEN", 403, "Bạn không có quyền làm việc này.") },
  });
  await page.reload();
  await expect(page.getByRole("alert")).toHaveText("Bạn không có quyền làm việc này.");
});

test("chi tiết run: pha, log trực tiếp qua SSE, chi phí, chính sách, gửi chỉ dẫn, huỷ", async ({ page }) => {
  const hub = await open(page, {
    "runs/steer": () => ok({ status: "sent" }),
    "runs/cancel": () => ok({ ...RUNNING, state: "cancelling" }),
  });
  const streams = await fakeStream(page, [
    stateEvent(1, "leased", "2026-10-11T07:02:03.000Z"),
    stateEvent(2, "preparing", "2026-10-11T07:02:11.000Z"),
    stateEvent(3, "running", "2026-10-11T07:04:00.000Z"),
    {
      event: "run_event",
      id: "4.0",
      data: {
        id: 4,
        attempt: 1,
        seq: 1,
        type: "steer",
        data: { input: "Thêm test số âm" },
        createdAt: "2026-10-11T07:05:00.000Z",
      },
    },
    {
      event: "log",
      id: "4.1",
      data: {
        id: 1,
        attempt: 1,
        offset: 0,
        bytes: b64("\u001b[32m✓ vat.test.ts\u001b[0m (14 tests)\n"),
        createdAt: NOW,
      },
    },
    { event: "end", data: { state: "running" } },
  ]);
  await page.goto(`/runs/${RUNNING.id}`);

  await expect(page.getByRole("heading", { name: "Sửa làm tròn tiền trong hoá đơn VAT" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Bảng việc" }).first()).toBeVisible();
  expect(streams[0]).toContain(`/api/v1/runs/${RUNNING.id}/stream?org=${ORG.id}`);

  const phases = page.getByRole("list", { name: "Các pha của run" });
  await expect(phases.getByRole("listitem")).toHaveCount(6);
  await expect(phases.locator("[aria-current=step]")).toContainText("Đang chạy");
  await expect(phases.getByRole("listitem").first()).toContainText("đã xong");

  await expect(page.getByRole("region", { name: "Nội dung log" })).toHaveText("✓ vat.test.ts (14 tests)");
  await expect(page.getByText("Chỉ dẫn: Thêm test số âm")).toBeVisible();

  const info = page.getByRole("complementary", { name: "Thông tin run" });
  await expect(info).toContainText("Claude · claude-sonnet-5-5");
  await expect(info).toContainText("mac-mini-lan");
  await expect(info).toContainText("0,42 USD");
  await expect(info).toContainText("182.400");
  await expect(page.getByRole("meter", { name: "Đã dùng 21% trần chi phí của run" })).toBeVisible();
  await expect(info).toContainText("Có commit mới, không đụng infra/prod/**");
  await expect(info).toContainText("Chờ run kết thúc");

  const steerButton = page.getByRole("button", { name: "Gửi chỉ dẫn" });
  await expect(steerButton).toHaveAttribute("aria-expanded", "false");
  await steerButton.click();
  await expect(steerButton).toHaveAttribute("aria-expanded", "true");
  const steer = page.getByLabel("Chỉ dẫn cho agent đang chạy");
  await expect(steer).toBeFocused();
  await page.getByRole("button", { name: "Gửi", exact: true }).click();
  await expect(page.getByText("Chỉ dẫn không được để trống.")).toBeVisible();
  await steer.fill("Giữ nguyên chữ ký hàm round()");
  await page.getByRole("button", { name: "Gửi", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã gửi" })).toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "runs/steer")).toMatchObject({
    method: "POST",
    org: ORG.id,
    input: { id: RUNNING.id, input: "Giữ nguyên chữ ký hàm round()" },
  });

  await page.getByRole("button", { name: "Huỷ run" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText("Huỷ run 2b2b2b2b?");
  await confirm.getByRole("button", { name: "Huỷ run" }).click();
  await expect(confirm).toBeHidden();
  expect(hub.rpcCalls.find((c) => c.path === "runs/cancel")?.input).toEqual({ id: RUNNING.id });
});

test("run đã xong: không có nút gửi chỉ dẫn và huỷ; có PR và kết quả kiểm tra", async ({ page }) => {
  const done = {
    ...RUNS[1],
    policySnapshot: [{ check: "changes", required: true }],
    result: {
      exit: 0,
      commitCount: 1,
      changedFiles: ["a.ts"],
      reasons: [],
      checks: [{ check: "changes", required: true, passed: true, message: "1 commit, 1 file." }],
    },
  };
  await open(page, { "runs/get": () => ok(done) });
  await fakeStream(page, [{ event: "end", data: { state: "succeeded" } }]);
  await page.goto(`/runs/${done.id}`);
  await expect(page.getByText("Đạt · 1 commit, 1 file.")).toBeVisible();
  await expect(page.getByRole("link", { name: "PR #128" })).toBeVisible();
  await expect(page.getByText("Run đã xong")).toBeVisible();
  await expect(page.getByRole("button", { name: "Gửi chỉ dẫn" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Huỷ run" })).toHaveCount(0);
});

test("run không thấy được: báo lỗi tiếng Việt", async ({ page }) => {
  await open(page);
  await fakeStream(page, []);
  await page.goto("/runs/2b2b2b2b-0000-4000-8000-0000000000ff");
  await expect(page.getByRole("alert")).toHaveText("Không tìm thấy run trong tổ chức.");
});

for (const scheme of ["light", "dark"] as const) {
  test(`chụp màn hình ${scheme}; rộng 360px không cuộn ngang`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    await fakeStream(page, [
      stateEvent(1, "leased", "2026-10-11T07:02:03.000Z"),
      stateEvent(2, "preparing", "2026-10-11T07:02:11.000Z"),
      stateEvent(3, "running", "2026-10-11T07:04:00.000Z"),
      {
        event: "log",
        id: "3.1",
        data: {
          id: 1,
          attempt: 1,
          offset: 0,
          bytes: b64("14:02:11  prepare   git fetch origin main\n14:04:31  agent     Đổi sang làm tròn theo đồng\n"),
          createdAt: NOW,
        },
      },
      { event: "end", data: { state: "running" } },
    ]);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/tasks");
    await expect(page.getByRole("table", { name: "Danh sách việc" })).toBeVisible();
    await page.screenshot({ path: `test-results/screens/tasks-${scheme}.png`, fullPage: true });
    await page.goto(`/runs/${RUNNING.id}`);
    await expect(page.getByRole("region", { name: "Nội dung log" })).toContainText("git fetch");
    await page.screenshot({ path: `test-results/screens/run-${scheme}.png`, fullPage: true });

    await page.setViewportSize({ width: 360, height: 800 });
    for (const path of ["/tasks", `/runs/${RUNNING.id}`]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} cuộn ngang ở 360px`).toBeLessThanOrEqual(0);
    }
  });
}

test("trang chủ: thẻ tổ chức, số liệu thật và đường dẫn theo thiết kế v2", async ({ page }, testInfo) => {
  await open(page, {
    "teams/list": () => ok([{ id: TEAM_ID, name: "Thanh toán" }]),
    "machines/list": () =>
      ok([
        { id: MACHINE, status: "online" },
        { id: "offline", status: "offline" },
      ]),
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: `Chào ${USER.name}` })).toBeVisible();
  await expect(page.getByRole("heading", { name: ORG.name, exact: true })).toBeVisible();
  const stats = page.getByRole("region", { name: "Số liệu" });
  await expect(stats).toContainText("1run đang chạy");
  await expect(stats).toContainText("1việc chờ bạn");
  await expect(stats).toContainText("1máy trực tuyến");
  await expect(page.getByText("Bạn là thành viên của tổ chức này.", { exact: false })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Trang chủ", exact: true });
  await expect(nav.getByRole("link", { name: "Bảng việc" })).toHaveAttribute("href", "/tasks");
  await expect(nav.getByRole("link", { name: "Đội và hệ thống" })).toHaveAttribute("href", "/admin/teams");
  await expect(nav.getByRole("link", { name: "Thành viên" })).toHaveAttribute("href", "/admin/members");
  await page.screenshot({ path: testInfo.outputPath("home.png"), fullPage: true });
});

for (const scheme of ["light", "dark"] as const) {
  test(`trang chủ: tiếng Anh, rộng 360px (${scheme})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
    await open(page, { "teams/list": () => ok([]) });
    await page.goto("/");
    const stats = page.getByRole("region", { name: "Statistics" });
    await expect(stats).toContainText("0machines online");
    await expect(page.getByRole("heading", { name: `Hi, ${USER.name}` })).toBeVisible();
    await expect(page.getByText("You are a member of this organization.", { exact: false })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Home", exact: true }).getByRole("link", { name: "Board" }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`home-360-${scheme}.png`), fullPage: true });
  });
}

test("trang chủ: không báo số 0 khi tra máy lỗi", async ({ page }) => {
  await open(page, { "teams/list": () => fail("FORBIDDEN", 403, "Không có quyền đọc đội.") });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Số liệu" })).toContainText("—máy trực tuyến");
  await expect(page.getByText("Không tải được số máy trực tuyến.")).toBeVisible();
});

test("chuyển giữa trang chủ và bảng việc không tải lại danh sách vừa tải", async ({ page }) => {
  const hub = await open(page, {
    "teams/list": () => ok([{ id: TEAM_ID, name: "Thanh toán" }]),
    "machines/list": () => ok([{ id: MACHINE, status: "online" }]),
  });
  const calls = (path: string) => hub.rpcCalls.filter((c) => c.path === path).length;
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Số liệu" })).toContainText("1run đang chạy");
  await page
    .getByRole("navigation", { name: "Trang chủ", exact: true })
    .getByRole("link", { name: "Bảng việc" })
    .click();
  await expect(page.getByRole("heading", { name: "Bảng việc" })).toBeVisible();
  await expect(page.getByText("Hướng dẫn cài worker trên Windows")).toBeVisible();
  await page.locator('a[href="/"]:visible').first().click();
  await expect(page.getByRole("region", { name: "Số liệu" })).toContainText("1run đang chạy");
  expect({ tasks: calls("tasks/list"), runs: calls("runs/latest") }).toEqual({ tasks: 1, runs: 1 });
});

test("chunk của trang tải cùng lúc với me.get, không chờ me.get và orgs.mine xong", async ({ page }) => {
  await open(page);
  const order: string[] = [];
  let chunkRequested = () => {};
  const chunk = new Promise<void>((resolve) => {
    chunkRequested = resolve;
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/src/pages/tasks-page.tsx")) {
      order.push("chunk");
      chunkRequested();
    }
  });
  // Giữ me.get tới khi trang xin chunk (tối đa 3 giây): trước đây chunk chỉ tải sau khi me.get và orgs.mine trả về.
  await page.route(
    (url) => url.pathname === "/rpc/me/get",
    async (route) => {
      await Promise.race([chunk, new Promise((resolve) => setTimeout(resolve, 3000))]);
      order.push("me");
      await route.fallback();
    },
  );
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "Bảng việc" })).toBeVisible();
  expect(order.slice(0, 2)).toEqual(["chunk", "me"]);
});
