import { expect, type Page, test } from "@playwright/test";
import {
  CI_CONNECTION_ID,
  CI_JOB_ID,
  CI_NEW_JOB_ID,
  CI_PROJECT_ID,
  deliveryCiFixture,
  GITLAB_FAILED,
  GITLAB_RUNNING,
  JENKINS_BUILT,
  JENKINS_JOB_PATH,
  JENKINS_WAITING,
} from "./delivery-ci-fixture.ts";
import { type FakeHub, ok, type RpcHandler } from "./fake-hub.ts";
import { inOrg, TEAM_ID } from "./reviews-fixture.ts";

const PROJECT = {
  id: CI_PROJECT_ID,
  systemId: "5e5e5e5e-0000-4000-8000-000000000001",
  teamId: TEAM_ID,
  key: "PAY",
  name: "payment-api",
  state: "active",
  repo: null,
  settings: {
    merge: { mode: "review", requiredApprovals: 1 },
    outcome: { default: [], byType: {} },
    features: { planMode: false, crossReview: false, mergeQueue: false, leaderChat: false, sandbox: false },
    issueIntake: { enabled: false, label: "hive", mention: "hive" },
    brief: { auto: true, refreshCommits: 50, refreshDays: 7 },
    budget: { perRunUsd: 2 },
  },
  createdBy: "u1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const VIEW = ["ci.view"];
const OPERATE = ["ci.view", "ci.operate"];
const ADMIN = ["ci.view", "ci.operate", "projects.settings"];

/** Quyền theo đội: `roles/mine` có `teamId` thì trả đúng tập này, nên quyền chỉ đến từ đội của dự án. */
async function open(
  page: Page,
  fixture: ReturnType<typeof deliveryCiFixture>,
  permissions: string[],
): Promise<FakeHub> {
  await page.setViewportSize({ width: 360, height: 800 });
  const rpc: Record<string, RpcHandler> = { ...fixture.rpc, "projects/list": () => ok([PROJECT]) };
  const hub = await inOrg(page, "member", rpc, permissions);
  await page.goto("/projects/PAY/cicd");
  return hub;
}

const rowOf = (page: Page, title: string) => page.getByRole("row").filter({ hasText: title });
const callsOf = (fixture: ReturnType<typeof deliveryCiFixture>, path: string) =>
  fixture.state.calls.filter((c) => c.path === path).map((c) => c.input);

test("danh sách gộp hiện đủ cột và không tràn ngang ở 360 px", async ({ page }) => {
  const fixture = deliveryCiFixture();
  await open(page, fixture, OPERATE);

  const table = page.getByRole("table", { name: "Các lần chạy CI của dự án" });
  for (const col of ["Nguồn", "Nhánh", "Commit", "Trạng thái", "Thời lượng", "Người kích hoạt", "Link gốc"]) {
    await expect(table.getByRole("columnheader", { name: col })).toBeVisible();
  }
  const failed = rowOf(page, "Pipeline #100");
  await expect(failed).toContainText("GitLab");
  await expect(failed).toContainText("main");
  await expect(failed).toContainText("bbbbbbbb");
  await expect(failed).toContainText("6 phút 12 giây");
  await expect(failed).toContainText("lan");
  await expect(rowOf(page, `${JENKINS_JOB_PATH} #42`)).toContainText("Jenkins");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByRole("button", { name: "Tải thêm" }).click();
  await expect(rowOf(page, "Pipeline #99")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tải thêm" })).toHaveCount(0);
});

test("lọc theo nguồn, trạng thái và nhánh gửi đúng điều kiện lên hub", async ({ page }) => {
  const fixture = deliveryCiFixture();
  await open(page, fixture, OPERATE);
  await expect(rowOf(page, "Pipeline #101")).toBeVisible();

  await page.getByRole("button", { name: "Jenkins", exact: true }).click();
  await expect(rowOf(page, "Pipeline #101")).toHaveCount(0);
  await expect(rowOf(page, `${JENKINS_JOB_PATH} #42`)).toBeVisible();
  await page.getByRole("button", { name: "Tất cả", exact: true }).click();

  await page.getByRole("combobox", { name: "Trạng thái" }).selectOption({ label: "Lỗi" });
  await expect(rowOf(page, "Pipeline #100")).toBeVisible();
  await expect(rowOf(page, "Pipeline #101")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Trạng thái" }).selectOption({ label: "Mọi trạng thái" });

  await page.getByRole("textbox", { name: "Nhánh" }).fill("feature/login");
  await expect(rowOf(page, "Pipeline #101")).toBeVisible();
  await expect(rowOf(page, "Pipeline #100")).toHaveCount(0);

  const inputs = callsOf(fixture, "ci/feed") as { source?: string; status?: string; branch?: string }[];
  expect(inputs.some((i) => i.source === "jenkins")).toBe(true);
  expect(inputs.some((i) => i.status === "failed")).toBe(true);
  expect(inputs.some((i) => i.branch === "feature/login")).toBe(true);
});

test("nguồn lỗi: báo dữ liệu cũ kèm giờ, và thiếu token Jenkins kèm nút thêm token", async ({ page }) => {
  const fixture = deliveryCiFixture({ sources: "degraded" });
  await open(page, fixture, OPERATE);

  const notices = page.getByRole("list", { name: "Tình trạng nguồn" });
  await expect(notices).toContainText("Dữ liệu cũ, đọc lần cuối lúc");
  await expect(notices).toContainText("GitLab không trả lời.");
  await expect(notices).toContainText("Chưa có token để đọc Jenkins");
  const addToken = notices.getByRole("link", { name: "Thêm token" });
  await expect(addToken).toHaveAttribute("href", "/settings/jenkins-tokens");
  // Dữ liệu cũ vẫn hiện, không thay bằng trang trống.
  await expect(rowOf(page, "Pipeline #101")).toBeVisible();
});

test("không có ci.view thì ẩn danh sách và không gọi hub", async ({ page }) => {
  const fixture = deliveryCiFixture();
  await open(page, fixture, ["projects.read"]);

  await expect(page.getByText("Bạn chưa có quyền xem CI")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  expect(callsOf(fixture, "ci/feed")).toHaveLength(0);
});

test("chi tiết lần chạy: giai đoạn, log, tìm trong log và hỏi lại khi đang chạy", async ({ page }) => {
  const fixture = deliveryCiFixture();
  await open(page, fixture, OPERATE);

  // Bàn phím: tới nút mở chi tiết rồi Enter.
  const openButton = page.getByRole("button", { name: "Xem chi tiết Pipeline #101" });
  await openButton.focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("button", { name: "Xem log unit-test" })).toBeVisible();
  await expect(page.getByText("poll 1: đang biên dịch")).toBeVisible();
  // Lần chạy còn chạy nên log dài thêm khi hỏi lại, không cần tải lại trang.
  await expect(page.getByText("poll 2: đang biên dịch")).toBeVisible({ timeout: 15_000 });

  await page.getByRole("searchbox", { name: "Tìm trong log" }).fill("poll 2");
  await expect(page.getByRole("status").filter({ hasText: "dòng khớp" })).toBeVisible();
  await expect(page.getByText("poll 1: đang biên dịch")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Tìm trong log" }).fill("");

  const stepButton = page.getByRole("button", { name: "Xem log unit-test" });
  await stepButton.focus();
  await page.keyboard.press("Enter");
  await expect(stepButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("[j2] bước chạy")).toBeVisible();
  const stepCalls = callsOf(fixture, "ci/log") as { stepId?: string }[];
  expect(stepCalls.some((c) => c.stepId === "j2")).toBe(true);

  await page.getByRole("button", { name: "Chạy deploy-dev" }).click();
  await expect
    .poll(() => callsOf(fixture, "ci/play"))
    .toEqual([{ projectId: CI_PROJECT_ID, runId: GITLAB_RUNNING, stepId: "j3" }]);
  await page.getByRole("button", { name: "Huỷ lần chạy" }).click();
  await expect.poll(() => callsOf(fixture, "ci/cancel")).toEqual([{ projectId: CI_PROJECT_ID, runId: GITLAB_RUNNING }]);

  await page.getByRole("button", { name: "Về danh sách" }).click();
  await expect(rowOf(page, "Pipeline #100")).toBeVisible();
});

test("chạy lại pipeline lỗi và đọc log đã xong", async ({ page }) => {
  const fixture = deliveryCiFixture();
  await open(page, fixture, OPERATE);

  await page.getByRole("button", { name: "Xem chi tiết Pipeline #100" }).click();
  await expect(page.getByText("ERROR: build lỗi ở bước lint")).toBeVisible();
  await page.getByRole("button", { name: "Chạy lại", exact: true }).click();
  await expect.poll(() => callsOf(fixture, "ci/retry")).toEqual([{ projectId: CI_PROJECT_ID, runId: GITLAB_FAILED }]);
});

test("không có ci.operate thì không có nút thao tác", async ({ page }) => {
  const fixture = deliveryCiFixture();
  await open(page, fixture, VIEW);

  await page.getByRole("button", { name: "Xem chi tiết Pipeline #100" }).click();
  await expect(page.getByText("ERROR: build lỗi ở bước lint")).toBeVisible();
  await expect(page.getByRole("button", { name: "Chạy lại", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Huỷ lần chạy" })).toHaveCount(0);
});

test("chưa có token Jenkins: nút Jenkins tắt và kèm lý do", async ({ page }) => {
  const fixture = deliveryCiFixture({ sources: "degraded" });
  await open(page, fixture, OPERATE);

  const reason = "Thêm token Jenkins của bạn ở Cài đặt cá nhân";
  const build = page.getByRole("button", { name: `Build ${JENKINS_JOB_PATH}` });
  await expect(build).toBeDisabled();
  await expect(build).toHaveAccessibleDescription(new RegExp(reason));

  await page.getByRole("button", { name: `Xem chi tiết ${JENKINS_JOB_PATH} #43` }).click();
  const retry = page.getByRole("button", { name: "Chạy lại", exact: true });
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveAccessibleDescription(new RegExp(reason));
  await expect(page.getByRole("button", { name: "Tiếp tục" })).toBeDisabled();
  expect(callsOf(fixture, "ci/retry")).toHaveLength(0);
});

test("build Jenkins có tham số: form sinh từ parameterDefinitions", async ({ page }) => {
  const fixture = deliveryCiFixture();
  await open(page, fixture, OPERATE);

  await page.getByRole("button", { name: `Build ${JENKINS_JOB_PATH}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("BRANCH")).toHaveValue("main");
  await expect(dialog.getByLabel("TARGET_ENV")).toHaveValue("dev");
  await expect(dialog.getByLabel("API_SECRET")).toHaveAttribute("type", "password");

  await dialog.getByLabel("BRANCH").fill("release/1.2");
  await dialog.getByLabel("DEPLOY").check();
  await dialog.getByLabel("TARGET_ENV").selectOption("stage");
  await dialog.getByRole("button", { name: "Build", exact: true }).click();

  await expect
    .poll(() => callsOf(fixture, "ci/build"))
    .toEqual([
      {
        projectId: CI_PROJECT_ID,
        jobId: CI_JOB_ID,
        // Mật khẩu để trống thì không gửi, Jenkins dùng giá trị khai ở job.
        params: { BRANCH: "release/1.2", DEPLOY: true, TARGET_ENV: "stage", NOTES: "" },
      },
    ]);
  // Build xong mở thẳng lần chạy mới.
  await expect(page.getByText(`${JENKINS_JOB_PATH} #44`).first()).toBeVisible();
  expect(JENKINS_BUILT).toContain(":44");
});

test("trả lời bước input của Jenkins", async ({ page }) => {
  const fixture = deliveryCiFixture();
  await open(page, fixture, OPERATE);

  await page.getByRole("button", { name: `Xem chi tiết ${JENKINS_JOB_PATH} #43` }).click();
  await expect(page.getByText("Duyệt đẩy lên stage?")).toBeVisible();
  await page.getByRole("button", { name: "Tiếp tục" }).click();
  await expect
    .poll(() => callsOf(fixture, "ci/input"))
    .toEqual([{ projectId: CI_PROJECT_ID, runId: JENKINS_WAITING, inputId: "in1", action: "proceed" }]);
});

test("người có projects.settings gắn và gỡ job Jenkins", async ({ page }) => {
  const fixture = deliveryCiFixture({ attached: false });
  await open(page, fixture, ADMIN);

  await expect(page.getByText("Chưa gắn job Jenkins nào.")).toBeVisible();
  await page.getByRole("button", { name: "Gắn job Jenkins" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Kết nối Jenkins").selectOption({ label: "Jenkins công ty" });
  await dialog.getByLabel("Đường dẫn job").fill(JENKINS_JOB_PATH);
  await dialog.getByRole("button", { name: "Gắn job" }).click();

  await expect
    .poll(() => callsOf(fixture, "ciJobs/add"))
    .toEqual([{ projectId: CI_PROJECT_ID, connectionId: CI_CONNECTION_ID, jobPath: JENKINS_JOB_PATH }]);
  const detach = page.getByRole("button", { name: `Gỡ ${JENKINS_JOB_PATH}` });
  await expect(detach).toBeVisible();

  await detach.click();
  await page.getByRole("dialog").getByRole("button", { name: "Gỡ job" }).click();
  await expect
    .poll(() => callsOf(fixture, "ciJobs/remove"))
    .toEqual([{ projectId: CI_PROJECT_ID, jobId: CI_NEW_JOB_ID }]);
  await expect(page.getByText("Chưa gắn job Jenkins nào.")).toBeVisible();
});

test("thiếu projects.settings thì không có nút gắn hay gỡ job", async ({ page }) => {
  const fixture = deliveryCiFixture();
  await open(page, fixture, OPERATE);

  await expect(page.getByRole("button", { name: `Build ${JENKINS_JOB_PATH}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Gắn job Jenkins" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Gỡ ${JENKINS_JOB_PATH}` })).toHaveCount(0);
});
