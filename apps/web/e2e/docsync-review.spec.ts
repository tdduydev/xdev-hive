import { expect, type Page, test } from "@playwright/test";
import { CONFLICT_ID, docsyncReviewScenario, EXTRACT_ID } from "./docsync-review-fixture.ts";
import { inOrg, ORG_ID } from "./reviews-fixture.ts";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});
const openConflict = async (page: Page) => page.goto(`/knowledge/docs/conflicts/${CONFLICT_ID}`);
const openExtract = async (page: Page) => {
  await page.goto("/knowledge/docs/extracts");
  await page.getByRole("button", { name: /docs\/huong-dan.docx/ }).click();
  await expect(page.getByLabel("Nội dung bản trích (Markdown)")).toBeVisible();
};

for (const [label, choice] of [
  ["Giữ bản hub", "hub"],
  ["Giữ bản repo", "repo"],
] as const) {
  test(`xung đột: ${label}, chỉ gửi một quyết định kèm phiên bản đã xem`, async ({ page }) => {
    const fixture = docsyncReviewScenario();
    await inOrg(page, "admin", fixture.rpc);
    await openConflict(page);
    await expect(page.getByText("Nội dung trên hub.", { exact: false })).toBeVisible();
    await expect(page.getByText("Nội dung trong repo.", { exact: false })).toBeVisible();
    if (choice === "hub") await page.screenshot({ path: test.info().outputPath("conflict-1280.png") });
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.getByText("Xung đột này đã được giải quyết.")).toBeVisible();
    expect(fixture.state.resolutions).toEqual([{ id: CONFLICT_ID, choice, baseVersion: 2 }]);
    await expect(page.getByRole("button", { name: label, exact: true })).toBeHidden();
  });
}

test("sửa tay: phải xoá dấu xung đột trước khi lưu", async ({ page }) => {
  const fixture = docsyncReviewScenario();
  await inOrg(page, "admin", fixture.rpc);
  await openConflict(page);
  await page.getByRole("button", { name: "Sửa tay", exact: true }).click();
  await expect(page.getByRole("button", { name: "Lưu bản đã sửa" })).toBeDisabled();
  await page.getByLabel("Bản hợp có đánh dấu", { exact: true }).fill("# Bản hợp\n\nĐã kiểm tra cả hai bên.");
  await page.getByRole("button", { name: "Lưu bản đã sửa" }).click();
  await expect(page.getByText("Xung đột này đã được giải quyết.")).toBeVisible();
  expect(fixture.state.resolutions[0]).toEqual({
    id: CONFLICT_ID,
    choice: "manual",
    baseVersion: 2,
    content: "# Bản hợp\n\nĐã kiểm tra cả hai bên.",
  });
});

test("VERSION_CONFLICT: giữ bản đang xem, chặn lưu và tải bản mới trước khi chọn lại", async ({ page }) => {
  const fixture = docsyncReviewScenario({ conflictStale: true });
  await inOrg(page, "admin", fixture.rpc);
  await openConflict(page);
  await page.getByRole("button", { name: "Giữ bản repo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Giữ bản hub", exact: true })).toBeDisabled();
  await expect(page.getByText("Nội dung trên hub.", { exact: false })).toBeVisible();
  expect(fixture.state.resolutions).toHaveLength(0);
  await page.getByRole("button", { name: "Tải bản mới nhất", exact: true }).click();
  await expect(page.getByText("Hub vừa cập nhật.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Giữ bản hub", exact: true }).click();
  await expect(page.getByText("Xung đột này đã được giải quyết.")).toBeVisible();
  expect(fixture.state.resolutions[0]?.baseVersion).toBe(3);
});

test("bản trích: link gốc đúng tổ chức, lưu sửa rồi duyệt bằng mốc mới", async ({ page }) => {
  const fixture = docsyncReviewScenario();
  await inOrg(page, "admin", fixture.rpc);
  await openExtract(page);
  await expect(page.getByRole("link", { name: "Xem file gốc" })).toHaveAttribute(
    "href",
    `/api/v1/docs/assets/${fixture.state.extracts[0]?.assetId}?org=${ORG_ID}`,
  );
  await expect(page.getByText("Kiểm tra lại định dạng bảng so với file gốc.")).toBeVisible();
  await page.getByLabel("Nội dung bản trích (Markdown)").fill("# Đã sửa\n\nBản đã đối chiếu.");
  await expect(page.getByRole("button", { name: "Duyệt bản trích", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Lưu bản trích", exact: true }).click();
  await expect(page.getByText("Đã lưu bản trích.")).toBeVisible();
  await page.getByRole("button", { name: "Duyệt bản trích", exact: true }).click();
  await expect(page.getByText("Đã duyệt bản trích.")).toBeVisible();
  expect(fixture.state.actions.map((action) => action.kind)).toEqual(["update", "approve"]);
  expect(fixture.state.actions[0]?.content).toBe("# Đã sửa\n\nBản đã đối chiếu.");
  expect(fixture.state.actions[1]?.updatedAt).not.toBe(fixture.state.actions[0]?.updatedAt);
  await expect(page.getByLabel("Nội dung bản trích (Markdown)")).toHaveAttribute("readonly", "");
  await expect(page.getByRole("list", { name: "Danh sách bản trích" })).not.toContainText("docs/huong-dan.docx");
});

test("bản trích: từ chối và xem lại bằng bộ lọc", async ({ page }) => {
  const fixture = docsyncReviewScenario();
  await inOrg(page, "admin", fixture.rpc);
  await openExtract(page);
  await page.getByRole("button", { name: "Từ chối bản trích", exact: true }).click();
  await expect(page.getByText("Đã từ chối bản trích.")).toBeVisible();
  await page.getByLabel("Trạng thái bản trích").selectOption("rejected");
  await page.getByRole("button", { name: /docs\/huong-dan.docx/ }).click();
  await expect(page.getByRole("button", { name: "Duyệt bản trích", exact: true })).toBeHidden();
  expect(fixture.state.actions.map((action) => action.kind)).toEqual(["reject"]);
});

test("bí mật: chặn duyệt, xác nhận từng bản trước khi duyệt", async ({ page }) => {
  const fixture = docsyncReviewScenario({ secret: true });
  await inOrg(page, "admin", fixture.rpc);
  await openExtract(page);
  await expect(page.getByRole("button", { name: "Duyệt bản trích", exact: true })).toBeDisabled();
  await expect(page.getByText("dòng 12 (GitHub token)")).toBeVisible();
  await page.getByRole("button", { name: "Xác nhận không phải bí mật", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Huỷ", exact: true }).click();
  expect(fixture.state.actions).toEqual([]);
  await page.getByRole("button", { name: "Xác nhận không phải bí mật", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Không phải bí mật, xác nhận", exact: true }).click();
  await expect(page.getByText("Đã xác nhận. Bạn có thể duyệt bản trích.")).toBeVisible();
  await page.getByRole("button", { name: "Duyệt bản trích", exact: true }).click();
  await expect(page.getByText("Đã duyệt bản trích.")).toBeVisible();
  expect(fixture.state.actions.map((action) => [action.kind, action.id])).toEqual([
    ["confirmSecret", EXTRACT_ID],
    ["approve", EXTRACT_ID],
  ]);
});

test("hub phát hiện bí mật khi duyệt: yêu cầu xác nhận rồi mới thử lại", async ({ page }) => {
  const fixture = docsyncReviewScenario({ secretOnApprove: true });
  await inOrg(page, "admin", fixture.rpc);
  await openExtract(page);
  await page.getByRole("button", { name: "Duyệt bản trích", exact: true }).click();
  await expect(page.getByRole("button", { name: "Duyệt bản trích", exact: true })).toBeDisabled();
  await expect(page.getByText("dòng 12 (GitHub token)")).toBeVisible();
  await page.getByRole("button", { name: "Xác nhận không phải bí mật", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Không phải bí mật, xác nhận", exact: true }).click();
  await expect(page.getByText("Đã xác nhận. Bạn có thể duyệt bản trích.")).toBeVisible();
  await page.getByRole("button", { name: "Duyệt bản trích", exact: true }).click();
  await expect(page.getByText("Đã duyệt bản trích.")).toBeVisible();
  expect(fixture.state.actions.map((action) => action.kind)).toEqual(["confirmSecret", "approve"]);
});

test("bản trích đổi đồng thời: chặn ghi cho tới khi tải bản mới", async ({ page }) => {
  const fixture = docsyncReviewScenario({ extractStale: true });
  await inOrg(page, "admin", fixture.rpc);
  await openExtract(page);
  await page.getByLabel("Nội dung bản trích (Markdown)").fill("# Phần đang sửa");
  await page.getByRole("button", { name: "Lưu bản trích", exact: true }).click();
  await expect(page.getByLabel("Nội dung bản trích (Markdown)")).toHaveValue("# Phần đang sửa");
  await expect(page.getByRole("button", { name: "Lưu bản trích", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Tải bản mới nhất", exact: true }).click();
  await expect(page.getByLabel("Nội dung bản trích (Markdown)")).toHaveValue("# Bản trích mới nhất");
  expect(fixture.state.actions).toEqual([]);
});

test("phân trang, PDF gốc, bản trích lỗi và danh sách rỗng", async ({ page }) => {
  const fixture = docsyncReviewScenario({ pages: true, failed: true });
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/knowledge/docs/extracts");
  await page.getByLabel("Trạng thái bản trích").selectOption("all");
  await page.getByRole("button", { name: "Tải thêm bản trích", exact: true }).click();
  await page.getByRole("button", { name: /docs\/khao-sat.pdf/ }).click();
  await expect(page.getByText("Không có chữ để trích.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Xem file gốc" })).toHaveAttribute(
    "href",
    /\/api\/v1\/docs\/assets\/.+\?org=/,
  );
  await expect(page.getByRole("button", { name: "Duyệt bản trích", exact: true })).toBeHidden();
  await page.getByLabel("Trạng thái bản trích").selectOption("approved");
  await expect(page.getByText("Không có bản trích", { exact: true })).toBeVisible();
});

test("không có quyền: báo lỗi, không hiện nội dung và thao tác ghi", async ({ page }) => {
  const fixture = docsyncReviewScenario({ forbidden: true });
  await inOrg(page, "member", fixture.rpc);
  await openConflict(page);
  await expect(page.getByText("Bạn không có quyền quản lý tài liệu này.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Giữ bản hub", exact: true })).toBeHidden();
  await page.goto("/knowledge/docs/extracts");
  await expect(page.getByText("Bạn không có quyền quản lý tài liệu này.")).toBeVisible();
  await expect(page.getByRole("button", { name: /docs\/huong-dan.docx/ })).toBeHidden();
});

test("360 px sáng/tối: tab ba bản và thao tác bàn phím, không tràn ngang", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const fixture = docsyncReviewScenario();
  await inOrg(page, "admin", fixture.rpc);
  await openConflict(page);
  await page.getByRole("tab", { name: /Bản repo/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Nội dung trong repo.", { exact: false })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.classList.toggle("dark", value === "dark"), theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`conflict-360-${theme}.png`) });
  }
  await page.getByRole("button", { name: "Sửa tay", exact: true }).click();
  await expect(page.getByLabel("Bản hợp có đánh dấu", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await openExtract(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.classList.toggle("dark", value === "dark"), theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`extract-360-${theme}.png`), fullPage: true });
  }
  await page.getByRole("button", { name: "Duyệt bản trích", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Đã duyệt bản trích.")).toBeVisible();
});
