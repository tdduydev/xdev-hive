import { expect, type Page, test } from "@playwright/test";
import { APPROVAL_PAY, APPROVAL_RPT, deliveryApprovalsFixture } from "./delivery-approvals-fixture.ts";
import { inOrg } from "./reviews-fixture.ts";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

const APPROVER = ["ci.view", "deploy.approve"];
const card = (page: Page, name: string) => page.getByRole("article", { name });
const PAY = "Cổng thanh toán → prod";
const RPT = "Báo cáo → prod";

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("danh sách chờ duyệt; duyệt kèm ghi chú thì lần đó rời danh sách", async ({ page }) => {
  const fixture = deliveryApprovalsFixture();
  await inOrg(page, "member", fixture.rpc, APPROVER);
  await page.goto("/deploy-approvals");
  await expect(page.getByRole("heading", { name: "Duyệt triển khai", level: 1 })).toBeVisible();

  await expect(card(page, PAY)).toContainText("Lê Thị Lan yêu cầu");
  await expect(card(page, PAY)).toContainText("0/1 lượt duyệt");
  await expect(card(page, RPT)).toContainText("1/2 lượt duyệt");
  const commits = card(page, PAY).getByRole("list", { name: "Commit thay đổi" });
  await expect(commits).toContainText("3f9c2ab");
  await expect(commits).toContainText("Sửa lỗi thanh toán");
  await expect(commits).toContainText("Lê Thị Lan");
  await expect(commits.locator("time")).toHaveAttribute("datetime", "2026-10-20T02:45:00.000Z");

  await page.getByRole("button", { name: `Duyệt ${PAY}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Duyệt ${PAY}?` });
  await dialog.getByLabel("Ghi chú").fill("Đã xem changelog");
  await dialog.getByRole("button", { name: "Duyệt", exact: true }).click();
  await expect(dialog).toBeHidden();

  expect(fixture.state.calls.findLast((c) => c.path === "deploys/approvals/approve")?.input).toEqual({
    id: APPROVAL_PAY,
    comment: "Đã xem changelog",
  });
  await expect(card(page, PAY)).toBeHidden();
  await expect(card(page, RPT)).toBeVisible();
});

test("từ chối phải ghi lý do", async ({ page }) => {
  const fixture = deliveryApprovalsFixture();
  await inOrg(page, "member", fixture.rpc, APPROVER);
  await page.goto("/deploy-approvals");

  await page.getByRole("button", { name: `Từ chối ${RPT}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Từ chối ${RPT}?` });
  await dialog.getByRole("button", { name: "Từ chối", exact: true }).click();
  await expect(dialog.getByText("Ghi lý do từ chối.")).toBeVisible();
  expect(fixture.state.calls.some((c) => c.path === "deploys/approvals/reject")).toBe(false);

  await dialog.getByLabel("Lý do").fill("Chưa qua staging");
  await dialog.getByRole("button", { name: "Từ chối", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.state.calls.findLast((c) => c.path === "deploys/approvals/reject")?.input).toEqual({
    id: APPROVAL_RPT,
    reason: "Chưa qua staging",
  });
  await expect(card(page, RPT)).toBeHidden();
});

test("người khác vừa quyết: báo lỗi và tải lại danh sách", async ({ page }) => {
  const fixture = deliveryApprovalsFixture({
    failNext: { code: "CONFLICT", status: 409, message: "Lần triển khai không còn chờ duyệt." },
  });
  await inOrg(page, "member", fixture.rpc, APPROVER);
  await page.goto("/deploy-approvals");

  await page.getByRole("button", { name: `Duyệt ${PAY}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Duyệt", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("không còn chờ duyệt");
  await expect(card(page, PAY)).toBeHidden();
});

test("không có lần nào chờ duyệt; vừa màn hình hẹp", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await inOrg(page, "member", {}, APPROVER);
  await page.goto("/deploy-approvals");
  await expect(page.getByText("Không có lần nào chờ bạn duyệt")).toBeVisible();
  await noHorizontalScroll(page);
});

test("commit chưa đầy đủ vẫn hiện danh sách và cảnh báo trên thẻ duyệt", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const fixture = deliveryApprovalsFixture({ compare: { incomplete: true } });
  await inOrg(page, "member", fixture.rpc, APPROVER);
  await page.goto("/deploy-approvals");
  await expect(card(page, PAY).getByRole("status")).toContainText("Danh sách bị cắt bớt");
  await expect(card(page, PAY).getByRole("list", { name: "Commit thay đổi" })).toContainText("Sửa lỗi thanh toán");
  await noHorizontalScroll(page);
});

test("trang lần triển khai hiện commit và cảnh báo chưa đủ danh sách", async ({ page }) => {
  const fixture = deliveryApprovalsFixture({ compare: { incomplete: true } });
  await inOrg(page, "member", fixture.rpc, APPROVER);
  await page.goto(`/deploys/${APPROVAL_PAY}`);
  await expect(page.getByRole("list", { name: "Commit thay đổi" })).toContainText("Sửa lỗi thanh toán");
  await expect(page.getByText("Danh sách bị cắt bớt hoặc chưa lấy đủ từ nguồn Git.")).toBeVisible();
});

test("không có bản trước hiển thị trạng thái rỗng", async ({ page }) => {
  const fixture = deliveryApprovalsFixture({ compare: { from: null, commits: [], incomplete: true } });
  await inOrg(page, "member", fixture.rpc, APPROVER);
  await page.goto("/deploy-approvals");
  await expect(card(page, PAY)).toContainText("Chưa có bản triển khai thành công trước đó để so sánh.");
  await expect(card(page, PAY).getByRole("list", { name: "Commit thay đổi" })).toHaveCount(0);
});

test("hai bản không có commit mới hiển thị danh sách rỗng", async ({ page }) => {
  const fixture = deliveryApprovalsFixture({ compare: { commits: [], incomplete: false } });
  await inOrg(page, "member", fixture.rpc, APPROVER);
  await page.goto("/deploy-approvals");
  await expect(card(page, PAY)).toContainText("Không có commit để hiển thị.");
  await expect(card(page, PAY).getByText("Danh sách bị cắt bớt", { exact: false })).toHaveCount(0);
});

test("hiện trạng thái đang tải commit trước khi nguồn trả lời", async ({ page }) => {
  const fixture = deliveryApprovalsFixture();
  await inOrg(page, "member", fixture.rpc, APPROVER);
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/deploys/approvals/compare**", async (route) => {
    await ready;
    await route.fallback();
  });
  await page.goto("/deploy-approvals");
  await expect(card(page, PAY).getByRole("status")).toContainText("Đang tải commit thay đổi");
  release();
  await expect(card(page, PAY).getByRole("list", { name: "Commit thay đổi" })).toBeVisible();
});

test("lỗi quyền so sánh hiện thông báo và cho tải lại", async ({ page }) => {
  const fixture = deliveryApprovalsFixture();
  await inOrg(
    page,
    "member",
    {
      ...fixture.rpc,
      "deploys/approvals/compare": () => ({
        status: 403,
        json: { json: { defined: true, code: "FORBIDDEN", status: 403, message: "Token không có quyền đọc commit." } },
      }),
    },
    APPROVER,
  );
  await page.goto("/deploy-approvals");
  await expect(card(page, PAY).getByRole("alert")).toContainText("Token không có quyền đọc commit.");
  await expect(card(page, PAY).getByRole("button", { name: "Tải lại" })).toBeVisible();
});
