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
