import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  DEPLOY_CREATED,
  DEPLOY_PAY_DEV_OK,
  DEPLOY_PAY_PROD_RUNNING,
  type DeliveryDeploysOptions,
  deliveryDeploysFixture,
  SYSTEM_ID,
  TARGET_PAY_DEV,
  TARGET_RPT_DEV,
} from "./delivery-deploys-fixture.ts";
import { inOrg } from "./reviews-fixture.ts";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

/** Quyền theo đội: xem CI và bấm Triển khai. Vai trò hệ thống `member` không tự có `deploy.run`. */
const OPERATOR = ["ci.view", "deploy.run"];
const boardUrl = `/systems/${SYSTEM_ID}/deploys`;

async function openBoard(page: Page, options: DeliveryDeploysOptions = {}, mine: string[] = OPERATOR) {
  const fixture = deliveryDeploysFixture(options);
  await inOrg(page, "member", fixture.rpc, mine);
  await page.goto(boardUrl);
  await expect(page.getByRole("heading", { name: "Triển khai", exact: true, level: 1 })).toBeVisible();
  return fixture;
}

const running = (page: Page) => page.getByRole("region", { name: "Đang chạy" });
const history = (page: Page) => page.getByRole("region", { name: "Lịch sử" });
const payRow = (page: Page) => running(page).getByRole("row").filter({ hasText: "Cổng thanh toán" });
const dialog = (page: Page) => page.getByRole("dialog", { name: /^Triển khai .* lên / });
const deployButton = (page: Page, project: string, env: string) =>
  page.getByRole("button", { name: `Triển khai ${project} lên ${env}` });

const hasHorizontalScroll = (locator: Locator) => locator.evaluate((el) => el.scrollWidth > el.clientWidth + 1);

test("bảng cho thấy bản đang chạy của từng dự án theo môi trường", async ({ page }) => {
  await openBoard(page, { prodLocked: true });
  const table = running(page);
  await expect(table.getByRole("columnheader", { name: /dev/ })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: /prod/ })).toContainText("Khoá");

  const dev = payRow(page).getByRole("cell").nth(1);
  await expect(dev).toContainText("3f9c2ab");
  await expect(dev).toContainText("v1.4.2");
  await expect(dev).toContainText("Trần Đức Duy");
  await expect(dev.getByText("Khoẻ", { exact: true })).toBeVisible();

  // Lần đang chạy ở prod hiện kèm người bấm, bấm vào đi tới trang lần triển khai.
  const prod = payRow(page).getByRole("cell").nth(2);
  await expect(prod.getByText("Đang triển khai", { exact: true })).toBeVisible();
  await expect(prod.getByText("Chưa triển khai", { exact: true })).toBeHidden();

  const report = table.getByRole("row").filter({ hasText: "Báo cáo" });
  await expect(report.getByRole("cell").nth(1)).toContainText("Ngoài Hive · lan.tran");
  await expect(report.getByRole("cell").nth(1)).toContainText("#482");
  await expect(report.getByRole("cell").nth(1)).toContainText("registry.example.com/rpt:482");
  await expect(report.getByRole("cell").nth(2)).toContainText("Chưa có đích");
});

test("người chỉ xem không thấy nút Triển khai", async ({ page }) => {
  await openBoard(page, {}, ["ci.view"]);
  await expect(payRow(page)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Triển khai .* lên / })).toHaveCount(0);
});

test("ở 360 px bảng cuộn ngang trong chính nó, trang không tràn", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openBoard(page);
  await expect(payRow(page)).toBeVisible();
  const scroller = running(page).locator("div.overflow-x-auto").first();
  expect(await hasHorizontalScroll(scroller)).toBe(true);
  expect(await hasHorizontalScroll(page.locator("html"))).toBe(false);
  // Cột đầu dính trái nên tên dự án vẫn thấy khi cuộn tới cột cuối.
  await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect(
    running(page)
      .getByRole("cell", { name: /Cổng thanh toán/ })
      .first(),
  ).toBeInViewport();
});

test("bàn phím: mở dialog bằng Enter, Triển khai commit mới nhất rồi tới trang lần triển khai", async ({ page }) => {
  const fixture = await openBoard(page);
  const button = deployButton(page, "Cổng thanh toán", "dev");
  await button.focus();
  await page.keyboard.press("Enter");
  const form = dialog(page);
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Commit SHA")).toHaveAttribute("placeholder", "Commit mới nhất…");
  await expect(form.getByText(/commit mới nhất của nhánh main/)).toBeVisible();
  await expect(form.getByRole("radio", { name: "Commit" })).toBeChecked();

  await form.getByRole("button", { name: "Triển khai", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/deploys/${DEPLOY_CREATED}$`));
  expect(fixture.state.calls.filter((c) => c.path === "deploys/create")).toEqual([
    { path: "deploys/create", input: { targetId: TARGET_PAY_DEV, version: { kind: "commit" } } },
  ]);
});

test("chọn tag, và SHA sai bị chặn ngay ở form", async ({ page }) => {
  const fixture = await openBoard(page);
  await deployButton(page, "Cổng thanh toán", "dev").click();
  const form = dialog(page);
  await form.getByLabel("Commit SHA").fill("xyz");
  await form.getByRole("button", { name: "Triển khai", exact: true }).click();
  await expect(form.getByText("Commit SHA gồm 7 đến 64 ký tự 0-9 và a-f.")).toBeVisible();
  expect(fixture.state.calls.filter((c) => c.path === "deploys/create")).toHaveLength(0);

  await form.getByRole("radio", { name: "Tag" }).check();
  await form.getByRole("button", { name: "Triển khai", exact: true }).click();
  await expect(form.getByText("Nhập tag.")).toBeVisible();
  await form.getByRole("textbox", { name: "Tag" }).fill("v1.5.0");
  await form.getByRole("button", { name: "Triển khai", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/deploys/${DEPLOY_CREATED}$`));
  expect(fixture.state.calls.find((c) => c.path === "deploys/create")?.input).toEqual({
    targetId: TARGET_PAY_DEV,
    version: { kind: "tag", tag: "v1.5.0" },
  });
});

test("bỏ qua sao lưu phải kèm lý do", async ({ page }) => {
  const fixture = await openBoard(page);
  await deployButton(page, "Cổng thanh toán", "dev").click();
  const form = dialog(page);
  await form.getByLabel("Bỏ qua sao lưu lần này").check();
  await form.getByRole("button", { name: "Triển khai", exact: true }).click();
  await expect(form.getByText("Ghi lý do bỏ qua sao lưu.")).toBeVisible();
  expect(fixture.state.calls.filter((c) => c.path === "deploys/create")).toHaveLength(0);

  await form.getByLabel("Lý do bỏ qua sao lưu").fill("Đĩa sao lưu đầy, đã sao lưu tay");
  await form.getByRole("button", { name: "Triển khai", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/deploys/${DEPLOY_CREATED}$`));
  expect(fixture.state.calls.find((c) => c.path === "deploys/create")?.input).toEqual({
    targetId: TARGET_PAY_DEV,
    version: { kind: "commit" },
    skipBackup: { reason: "Đĩa sao lưu đầy, đã sao lưu tay" },
  });
  await expect(page.getByText("Đĩa sao lưu đầy, đã sao lưu tay")).toBeVisible();
});

test("đích Jenkins không có sao lưu để bỏ qua", async ({ page }) => {
  await openBoard(page);
  await deployButton(page, "Báo cáo", "dev").click();
  const form = dialog(page);
  await expect(form.getByLabel("Commit SHA")).toBeVisible();
  await expect(form.getByLabel("Bỏ qua sao lưu lần này")).toHaveCount(0);
  expect(TARGET_RPT_DEV).toBeTruthy();
});

test("đích đang có lần chạy: nói rõ ai bắt đầu và dẫn tới lần đó", async ({ page }) => {
  await openBoard(page, {
    createFailure: {
      code: "DEPLOY_IN_PROGRESS",
      status: 409,
      message: "Đích đang có lần chạy.",
      data: {
        code: "DEPLOY_IN_PROGRESS",
        deployId: DEPLOY_PAY_PROD_RUNNING,
        by: { userId: "u1", name: "Trần Đức Duy" },
        since: "2026-10-20T02:55:00.000Z",
      },
    },
  });
  await deployButton(page, "Cổng thanh toán", "dev").click();
  const form = dialog(page);
  await form.getByRole("button", { name: "Triển khai", exact: true }).click();
  const alert = form.getByRole("alert");
  await expect(alert).toContainText("do Trần Đức Duy bắt đầu");
  await alert.getByRole("link", { name: "Xem lần đang chạy" }).click();
  await expect(page).toHaveURL(new RegExp(`/deploys/${DEPLOY_PAY_PROD_RUNNING}$`));
});

test("môi trường bị khoá: hiện lý do khoá", async ({ page }) => {
  await openBoard(page, {
    createFailure: {
      code: "ENV_LOCKED",
      status: 423,
      message: "Môi trường đang khoá.",
      data: { code: "ENV_LOCKED", reason: "Đóng băng phát hành tuần lễ" },
    },
  });
  await deployButton(page, "Cổng thanh toán", "dev").click();
  await dialog(page).getByRole("button", { name: "Triển khai", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("Môi trường đang khoá (Đóng băng phát hành tuần lễ)");
});

test("thiếu token Jenkins: dẫn tới trang token", async ({ page }) => {
  await openBoard(page, {
    createFailure: {
      code: "JENKINS_NO_TOKEN",
      status: 412,
      message: "Chưa có token Jenkins.",
      data: { code: "JENKINS_NO_TOKEN", connectionId: "30303030-0000-4000-8000-000000000001" },
    },
  });
  await deployButton(page, "Báo cáo", "dev").click();
  const form = dialog(page);
  await form.getByRole("button", { name: "Triển khai", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("chưa có token Jenkins");
  await expect(form.getByRole("link", { name: "Thêm token Jenkins" })).toHaveAttribute(
    "href",
    "/settings/jenkins-tokens",
  );
});

test("lịch sử lọc theo nguồn, trạng thái và có trạng thái rỗng", async ({ page }) => {
  const fixture = await openBoard(page);
  const table = history(page);
  await expect(table.getByRole("row")).toHaveCount(5);

  await table.getByLabel("Nguồn").selectOption("external");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("row").nth(1)).toContainText("Ngoài Hive · lan.tran");
  expect(fixture.state.calls.at(-1)?.input).toMatchObject({ systemId: SYSTEM_ID, origin: "external" });

  await table.getByLabel("Nguồn").selectOption("");
  await table.getByLabel("Trạng thái").selectOption("failed");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("row").nth(1)).toContainText("Lỗi");

  await table.getByLabel("Trạng thái").selectOption("canceled");
  await expect(table.getByText("Không có lần triển khai khớp bộ lọc")).toBeVisible();
});

test("chưa có lần triển khai nào", async ({ page }) => {
  await openBoard(page, { empty: true });
  await expect(page.getByText("Chưa có lần triển khai nào", { exact: true })).toBeVisible();
  await expect(payRow(page).getByText("Chưa triển khai")).toHaveCount(2);
});

test("trang lần triển khai: các bước và log trực tiếp", async ({ page }) => {
  const fixture = deliveryDeploysFixture();
  await inOrg(page, "member", fixture.rpc, OPERATOR);
  await page.goto(`/deploys/${DEPLOY_PAY_DEV_OK}`);
  await expect(page.getByRole("heading", { name: "Cổng thanh toán → dev", level: 1 })).toBeVisible();

  const steps = page.getByRole("list").filter({ hasText: "Sao lưu" });
  await expect(steps.getByRole("listitem")).toHaveCount(4);
  await expect(steps.getByRole("listitem").first()).toContainText("mã thoát 0");
  await expect(page.getByText("deploy xong")).toBeVisible();
  await expect(page.getByText("Lần triển khai đã xong")).toBeVisible();
  // Lần đã xong thì không còn nút huỷ.
  await expect(page.getByRole("button", { name: "Huỷ lần triển khai" })).toHaveCount(0);

  const details = page.getByRole("complementary", { name: "Chi tiết" });
  await expect(details).toContainText("3f9c2ab");
  await expect(details).toContainText("v1.4.2");
});

test("huỷ lần đang chạy phải qua hộp xác nhận", async ({ page }) => {
  const fixture = deliveryDeploysFixture();
  await inOrg(page, "member", fixture.rpc, OPERATOR);
  await page.goto(`/deploys/${DEPLOY_PAY_PROD_RUNNING}`);
  await expect(page.getByText("docker compose pull")).toBeVisible();

  await page.getByRole("button", { name: "Huỷ lần triển khai" }).click();
  const confirm = page.getByRole("dialog", { name: "Huỷ lần triển khai này?" });
  await confirm.getByRole("button", { name: "Không huỷ" }).click();
  await expect(confirm).toBeHidden();
  expect(fixture.state.calls.filter((c) => c.path === "deploys/cancel")).toHaveLength(0);

  await page.getByRole("button", { name: "Huỷ lần triển khai" }).click();
  await page
    .getByRole("dialog", { name: "Huỷ lần triển khai này?" })
    .getByRole("button", { name: "Huỷ lần triển khai" })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(fixture.state.calls.filter((c) => c.path === "deploys/cancel")).toEqual([
    { path: "deploys/cancel", input: { id: DEPLOY_PAY_PROD_RUNNING } },
  ]);
  await expect(page.getByText("Đã huỷ", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Huỷ lần triển khai" })).toHaveCount(0);
});

test("lần triển khai không tồn tại hiện lỗi và cho tải lại", async ({ page }) => {
  const fixture = deliveryDeploysFixture();
  await inOrg(page, "member", fixture.rpc, OPERATOR);
  await page.goto("/deploys/bf1f1f1f-0000-4000-8000-0000000000ff");
  await expect(page.getByRole("alert")).toContainText("Không tìm thấy lần triển khai.");
  await expect(page.getByRole("button", { name: "Tải lại" })).toBeVisible();
});
