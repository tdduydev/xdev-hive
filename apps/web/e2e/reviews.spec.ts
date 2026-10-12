import { expect, type Page, test } from "@playwright/test";
import { inOrg, REVIEW_DESIGN, REVIEW_PRD, reviewsFixture } from "./reviews-fixture.ts";

async function setup(page: Page) {
  const fixture = reviewsFixture();
  const hub = await inOrg(page, "admin", fixture.rpc);
  return { ...fixture, hub };
}

const table = (page: Page) => page.getByRole("table", { name: /Hàng chờ duyệt|Review queue/ });
const pane = (page: Page) => page.getByRole("region", { name: "Chi tiết phiên duyệt" });

test("hàng chờ: bảng, thay đổi so với bản đã duyệt, AI tự kiểm, truy vết; duyệt thì làm mới", async ({ page }) => {
  const { state, hub } = await setup(page);
  await page.goto("/knowledge/reviews");
  await expect(page.getByRole("heading", { name: "Chờ tôi duyệt", level: 1 })).toBeVisible();
  const prdRow = table(page).getByRole("row").filter({ hasText: "Hoàn tiền một phần" });
  await expect(prdRow).toContainText("project/payment-api/prd");
  await expect(prdRow).toContainText("Product owner duyệt");
  await expect(prdRow).toContainText("còn 14 giờ");
  await expect(prdRow).toContainText("8,5");
  await expect(prdRow).toContainText("+5 −1");
  await expect(table(page).getByRole("row").filter({ hasText: "Thiết kế kênh WebSocket" })).toContainText(
    "Quá hạn 3 giờ",
  );
  expect(hub.rpcCalls.find((c) => c.path === "reviews/list")?.input).toMatchObject({ scope: "mine" });

  // Chưa chọn thì mở tài liệu đầu hàng.
  const detail = pane(page);
  await expect(detail.getByRole("heading", { name: "Hoàn tiền một phần", level: 2 })).toBeVisible();
  await expect(detail).toContainText("v2 → v3");
  await expect(detail.getByRole("list", { name: "Các checkpoint" })).toContainText("Product owner duyệt: đang chờ");
  await expect(detail.getByRole("list", { name: "Các checkpoint" })).toContainText("AI kiểm đủ mục PRD: đã qua");

  const diff = detail.getByRole("region", { name: "Thay đổi so với bản đã duyệt" });
  await expect(diff).toContainText("+5 / −1 dòng");
  await expect(diff.locator('[data-diff="removed"]')).toHaveText(/phải nhỏ hơn số tiền gốc/);
  await expect(diff.locator('[data-diff="added"]').first()).toHaveText(/không được vượt số tiền gốc trừ phí đã thu/);
  await expect(diff.locator('[data-diff="added"]')).toHaveCount(5);
  await expect(diff).toContainText("dòng không đổi");

  const ai = detail.getByRole("region", { name: "AI tự kiểm · AI kiểm đủ mục PRD" });
  await expect(ai).toContainText("8,5 / 10");
  await expect(ai).toContainText("! Chưa nêu giới hạn số lần hoàn trong một ngày");

  const trace = detail.getByRole("region", { name: "Truy vết yêu cầu" });
  await expect(trace).toContainText("2 / 3");
  await expect(trace.getByRole("row").filter({ hasText: "R-2" })).toContainText("TASK-45TASK-47");
  await expect(trace.getByRole("row").filter({ hasText: "R-3" })).toContainText("Chưa có tiêu chí");

  const decision = detail.getByRole("region", { name: "Quyết định của bạn" });
  await expect(decision).toContainText("Người duyệt ở checkpoint này: Quản trị đội, Đội Thanh toán, Phạm Hà");
  await expect(decision).toContainText("Đã duyệt 1/2: Trần Lan");
  // Mặc định theo cấu hình của checkpoint (agent sửa); gate trước không có người duyệt nên không có "về checkpoint trước".
  await expect(decision.getByRole("combobox", { name: "Nếu yêu cầu sửa" })).toHaveValue("agent");
  await expect(decision.getByRole("combobox", { name: "Nếu yêu cầu sửa" }).locator("option")).toHaveText([
    "Trả về người viết",
    "Agent sửa theo góp ý, rồi quay lại checkpoint này",
  ]);
  const listCalls = hub.rpcCalls.filter((c) => c.path === "reviews/list").length;
  await decision.getByRole("button", { name: "Duyệt" }).click();
  await expect(decision.getByRole("status")).toHaveText("Đã duyệt. Tài liệu sang checkpoint tiếp theo.");
  expect(state.decisions).toEqual([{ id: REVIEW_PRD, decision: "approve" }]);
  await expect.poll(() => hub.rpcCalls.filter((c) => c.path === "reviews/list").length).toBeGreaterThan(listCalls);
  // Tài liệu rời hàng "chờ tôi" nhưng vẫn đang mở, stepper đã sang Pháp chế.
  await expect(table(page).getByRole("row").filter({ hasText: "Hoàn tiền một phần" })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`id=${REVIEW_PRD}`));
  await expect(detail.getByRole("list", { name: "Các checkpoint" })).toContainText("Pháp chế: đang chờ");
  await expect(decision.getByRole("button", { name: "Duyệt" })).toHaveCount(0);
  await expect(decision).toContainText("Người duyệt ở checkpoint này: Quản trị tổ chức");
  await expect(decision).toContainText("Đã duyệt 0/1");
});

test("đường dẫn ?id= mở đúng tài liệu; yêu cầu sửa cần góp ý và trả về checkpoint trước", async ({ page }) => {
  const { state } = await setup(page);
  await page.goto(`/knowledge/reviews?id=${REVIEW_DESIGN}`);
  const detail = pane(page);
  await expect(detail.getByRole("heading", { name: "Thiết kế kênh WebSocket qua proxy", level: 2 })).toBeVisible();
  await expect(table(page).getByRole("row").filter({ hasText: "Thiết kế kênh" })).toHaveAttribute(
    "data-state",
    "selected",
  );
  await expect(detail).toContainText("tài liệu mới → v1");
  // Tài liệu mới: mọi dòng là dòng thêm.
  const diff = detail.getByRole("region", { name: "Thay đổi so với bản đã duyệt" });
  await expect(diff.locator('[data-diff="removed"]')).toHaveCount(0);
  await expect(diff.locator('[data-diff="added"]').first()).toHaveText(/Thiết kế kênh WebSocket qua proxy/);
  await expect(detail.getByRole("region", { name: "Truy vết yêu cầu" })).toContainText(
    "Tài liệu chưa có yêu cầu đánh mã R-n.",
  );

  const decision = detail.getByRole("region", { name: "Quyết định của bạn" });
  await decision.getByRole("button", { name: "Yêu cầu sửa" }).click();
  await expect(decision.getByRole("alert")).toHaveText("Ghi góp ý khi trả lại.");
  await expect(decision.getByRole("textbox", { name: "Góp ý cho người viết" })).toBeFocused();
  expect(state.decisions).toHaveLength(0);

  await decision
    .getByRole("textbox", { name: "Góp ý cho người viết" })
    .fill("Thiếu phần thử lại khi proxy cắt kết nối.");
  // Checkpoint này cấu hình trả về checkpoint trước, nên đó là lựa chọn mặc định.
  await expect(decision.getByRole("combobox", { name: "Nếu yêu cầu sửa" })).toHaveValue("previous");
  await expect(decision.getByRole("combobox", { name: "Nếu yêu cầu sửa" }).locator("option:checked")).toHaveText(
    "Về checkpoint trước (Product owner duyệt)",
  );
  await decision.getByRole("button", { name: "Yêu cầu sửa" }).click();
  await expect(decision.getByRole("status")).toHaveText("Đã trả lại: Về checkpoint trước (Product owner duyệt).");
  expect(state.decisions).toEqual([
    {
      id: REVIEW_DESIGN,
      decision: "changes",
      note: "Thiếu phần thử lại khi proxy cắt kết nối.",
      route: "previous",
    },
  ]);
  await expect(detail.getByRole("list", { name: "Các checkpoint" })).toContainText(
    "Kiến trúc sư duyệt thiết kế: bị trả lại",
  );
  await expect(detail).toContainText("Kiến trúc sư duyệt thiết kế · Trần Đức Duy: Thiếu phần thử lại khi proxy");
});

test("lỗi của hub khi quyết định hiện ra, góp ý giữ nguyên", async ({ page }) => {
  const { state } = await setup(page);
  state.decideConflict = "Checkpoint này vừa có người quyết. Tải lại để xem bản mới.";
  await page.goto(`/knowledge/reviews?id=${REVIEW_PRD}`);
  const decision = pane(page).getByRole("region", { name: "Quyết định của bạn" });
  await decision.getByRole("textbox", { name: "Góp ý cho người viết" }).fill("Ổn.");
  await decision.getByRole("button", { name: "Duyệt" }).click();
  await expect(decision.getByRole("alert")).toHaveText("Checkpoint này vừa có người quyết. Tải lại để xem bản mới.");
  await expect(decision.getByRole("textbox", { name: "Góp ý cho người viết" })).toHaveValue("Ổn.");
  expect(state.decisions).toEqual([{ id: REVIEW_PRD, decision: "approve", note: "Ổn." }]);
});

test("Tất cả, lọc trạng thái, lọc SLA và tải thêm", async ({ page }) => {
  const { hub } = await setup(page);
  await page.goto("/knowledge/reviews");
  await expect(table(page).getByRole("row").filter({ hasText: "Hoàn tiền một phần" })).toBeVisible();

  await page.getByRole("button", { name: "Tải thêm" }).click();
  await expect(table(page).getByRole("row").filter({ hasText: "Runbook sự cố VNPAY" })).toContainText("còn 5 giờ");
  expect(hub.rpcCalls.filter((c) => c.path === "reviews/list").at(-1)?.input).toMatchObject({ cursor: "p2" });
  await expect(page.getByRole("button", { name: "Tải thêm" })).toHaveCount(0);

  // SLA lọc trong trang trên những dòng đã tải.
  // Nút lọc SLA đứng trước nút sắp xếp cột SLA cùng tên.
  await page.getByRole("button", { name: "SLA", exact: true }).first().click();
  await page.getByRole("checkbox", { name: "Quá hạn" }).check();
  await page.keyboard.press("Escape");
  await expect(table(page).getByRole("row")).toHaveCount(2);
  await page.getByRole("button", { name: "Xoá hết bộ lọc" }).click();

  await page.getByRole("button", { name: "Tất cả", exact: true }).click();
  const adr = table(page).getByRole("row").filter({ hasText: "ADR-012" });
  await expect(adr).toContainText("Đã duyệt");
  expect(hub.rpcCalls.filter((c) => c.path === "reviews/list").at(-1)?.input).toMatchObject({ scope: "all" });

  await page.getByRole("combobox", { name: "Trạng thái" }).selectOption({ label: "Đã duyệt" });
  await expect(table(page).getByRole("row")).toHaveCount(2);
  expect(hub.rpcCalls.filter((c) => c.path === "reviews/list").at(-1)?.input).toMatchObject({
    scope: "all",
    status: "approved",
  });
});

test("English: queue, SLA and the decision form follow the language", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
  await setup(page);
  await page.goto("/knowledge/reviews");
  await expect(page.getByRole("heading", { name: "Awaiting my review", level: 1 })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "AI score" })).toBeVisible();
  await expect(table(page).getByRole("row").filter({ hasText: "Thiết kế kênh" })).toContainText("3 h overdue");
  const detail = page.getByRole("region", { name: "Review details" });
  await expect(detail.getByRole("region", { name: "Changes since the approved version" })).toContainText(
    "+5 / −1 lines",
  );
  await expect(detail.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Request changes" })).toBeVisible();
  await expect(detail.getByRole("list", { name: "Checkpoints" })).toContainText("Product owner duyệt: waiting");
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const scheme of ["light", "dark"] as const) {
  test(`ảnh màn chờ duyệt 1440×1000, ${scheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: scheme });
    await setup(page);
    await page.goto("/knowledge/reviews");
    await expect(pane(page).getByRole("heading", { name: "Hoàn tiền một phần", level: 2 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`reviews-${scheme}.png`), fullPage: true });
  });
}
