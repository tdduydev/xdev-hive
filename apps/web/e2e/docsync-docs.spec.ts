import { expect, type Page, test } from "@playwright/test";
import { docsyncDocsScenario, GUIDE_KEY } from "./docsync-docs-fixture.ts";
import { fail, ok } from "./fake-hub.ts";
import { inOrg } from "./reviews-fixture.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQXYAAAAASUVORK5CYII=",
  "base64",
);

const tree = (page: Page) => page.getByRole("list", { name: "Cây tài liệu theo repo" });
const choose = (page: Page, name = "Hướng dẫn cài đặt") =>
  tree(page)
    .getByRole("button", { name: new RegExp(name) })
    .click();

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/docs/assets/image?**", (route) => route.fulfill({ contentType: "image/png", body: PNG }));
  page.on("pageerror", (error) => {
    throw error;
  });
});

for (const provider of ["github", "gitlab"] as const) {
  test(`${provider}: cây theo repo, nhãn PR, link file/commit, lọc và thử lại`, async ({ page }) => {
    const fixture = docsyncDocsScenario({ provider });
    await inOrg(page, "admin", fixture.rpc);
    await page.goto("/knowledge/docs");
    await expect(tree(page)).toBeVisible({ timeout: 20_000 });
    await expect(tree(page).getByText("PR #128 đang mở")).toBeVisible();
    await expect(tree(page).getByText("Chưa có nhà", { exact: true }).first()).toBeVisible();
    await choose(page);
    await expect(page.getByRole("link", { name: "PR #128", exact: true })).toHaveAttribute(
      "href",
      new RegExp(provider === "gitlab" ? "/-/merge_requests/128$" : "/pull/128$"),
    );
    await expect(page.getByRole("link", { name: "Commit aaaaaaaa" })).toHaveAttribute(
      "href",
      new RegExp(provider === "gitlab" ? "/-/commit/a+$" : "/commit/a+$"),
    );
    await page.getByLabel("Trạng thái đồng bộ", { exact: true }).selectOption("failed");
    await expect(tree(page).getByText("Hướng dẫn cài đặt")).toBeHidden();
    await choose(page, "Tài liệu lỗi");
    await expect(page.getByRole("alert")).toContainText("Không kết nối được repo.");
    await page.getByRole("button", { name: "Thử lại", exact: true }).click();
    await expect(page.getByText("Đã xếp đồng bộ lại.")).toBeVisible();
    expect(fixture.state.retries).toHaveLength(1);
  });
}

test("di chuyển giữ key, lưu trữ và khôi phục dùng phiên bản đang xem", async ({ page }) => {
  const fixture = docsyncDocsScenario();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/knowledge/docs");
  await choose(page);
  await page.getByRole("button", { name: "Di chuyển", exact: true }).click();
  await page.getByLabel("Đường dẫn mới", { exact: true }).fill("../escape.md");
  await expect(page.getByRole("button", { name: "Xác nhận", exact: true })).toBeDisabled();
  await page.getByLabel("Đường dẫn mới", { exact: true }).fill("docs/cai-dat/huong-dan.md");
  await page.getByRole("button", { name: "Xác nhận", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(fixture.state.moves).toEqual([{ key: GUIDE_KEY, repoPath: "docs/cai-dat/huong-dan.md", baseVersion: 3 }]);
  await expect(page.getByText("docs/cai-dat/huong-dan.md", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Lưu trữ", exact: true }).click();
  await page.getByRole("button", { name: "Xác nhận", exact: true }).click();
  await expect(tree(page).getByText("Hướng dẫn cài đặt")).toBeHidden();
  await page.getByLabel("Danh sách tài liệu").selectOption("archived");
  await choose(page);
  await page.getByRole("button", { name: "Khôi phục", exact: true }).click();
  await page.getByRole("button", { name: "Xác nhận", exact: true }).click();
  await expect(tree(page).getByText("Hướng dẫn cài đặt")).toBeHidden();
  await page.getByLabel("Danh sách tài liệu").selectOption("active");
  await expect(tree(page).getByText("Hướng dẫn cài đặt")).toBeVisible();
});

test("tìm theo đoạn hiện đường tiêu đề và báo dùng tìm theo từ", async ({ page }) => {
  const fixture = docsyncDocsScenario();
  await inOrg(page, "member", fixture.rpc);
  await page.goto("/knowledge/docs");
  await page.getByLabel("Tìm theo nghĩa", { exact: true }).fill("khởi động database");
  await page.getByRole("button", { name: "Tìm tài liệu", exact: true }).click();
  const results = page.getByRole("region", { name: "Kết quả tìm tài liệu" });
  await expect(results.getByText("Đang tìm theo từ", { exact: true })).toBeVisible();
  await expect(results.getByText(/Cài đặt › Postgres/)).toBeVisible();
  await expect(results.getByText("Khởi động cơ sở dữ liệu bằng Docker.")).toBeVisible();
  await expect(results.getByRole("link", { name: "Hướng dẫn cài đặt" })).toHaveAttribute("href", /huong-dan.*edit$/);
  expect(fixture.state.searches).toEqual([expect.objectContaining({ query: "khởi động database" })]);
});

test("phân trang cây và 360 px sáng/tối, đóng mở bằng bàn phím", async ({ page }) => {
  const fixture = docsyncDocsScenario({ many: true });
  const hub = await inOrg(page, "admin", fixture.rpc);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/knowledge/docs");
  await expect(tree(page).getByText("Tài liệu 204", { exact: true })).toBeVisible();
  expect(hub.rpcCalls.filter((call) => call.path === "docTree/list")).toHaveLength(2);
  const folder = tree(page).getByRole("button", { name: "Thu thư mục docs", exact: true });
  await folder.focus();
  await page.keyboard.press("Enter");
  await expect(tree(page).getByText("Tài liệu 204", { exact: true })).toBeHidden();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.classList.toggle("dark", value === "dark"), theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("lỗi phiên bản khi di chuyển và lỗi thử lại giữ nội dung và thông báo", async ({ page }) => {
  const fixture = docsyncDocsScenario({ failMove: true, failRetry: true });
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/knowledge/docs");
  await choose(page);
  await page.getByRole("button", { name: "Di chuyển", exact: true }).click();
  await page.getByLabel("Đường dẫn mới").fill("docs/new.md");
  await page.getByRole("button", { name: "Xác nhận", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Tải lại rồi thử lại.");
  await page.getByRole("button", { name: "Huỷ", exact: true }).click();
  await choose(page, "Tài liệu lỗi");
  await page.getByRole("button", { name: "Thử lại", exact: true }).click();
  await expect(page.getByText("Kết nối đã mất quyền ghi repo.")).toBeVisible();
});

test("thành viên không có thao tác quản trị", async ({ page }) => {
  const fixture = docsyncDocsScenario();
  await inOrg(page, "member", fixture.rpc);
  await page.goto("/knowledge/docs");
  await choose(page, "Tài liệu lỗi");
  await expect(page.getByRole("button", { name: "Thử lại", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Di chuyển", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Lưu trữ", exact: true })).toBeHidden();
});

test("editor phân giải ảnh theo lô và tải file kèm tổ chức, lưu đường dẫn tương đối", async ({ page }) => {
  const fixture = docsyncDocsScenario();
  await inOrg(page, "admin", fixture.rpc);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQXYAAAAASUVORK5CYII=",
    "base64",
  );
  let uploaded = "";
  await page.route("**/api/v1/docs/assets**", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().headers()["x-hive-org"]).toBeTruthy();
      uploaded = route.request().postData() ?? "";
      await route.fulfill({
        json: { assetId: "22222222-0000-4000-8000-0000000000aa", relativePath: "assets/new.png" },
      });
    } else await route.fulfill({ contentType: "image/png", body: png });
  });
  await page.goto(`/knowledge/docs/${encodeURIComponent(GUIDE_KEY)}/edit`);
  await expect(page.getByRole("img", { name: "Sơ đồ", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("img", { name: "Logo", exact: true })).toBeVisible();
  await expect
    .poll(() => page.locator('img[alt="Sơ đồ"]').evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(1);
  await page.getByRole("link", { name: "Báo cáo", exact: true }).click();
  await expect(page.getByRole("link", { name: "Mở file đính kèm", exact: true })).toHaveAttribute(
    "href",
    /api\/v1\/docs\/assets/,
  );
  await page.getByRole("button", { name: "Đóng thông báo", exact: true }).click();
  await page.getByRole("link", { name: "Tài liệu khác", exact: true }).click();
  await expect(page.getByRole("link", { name: "Mở tài liệu org/khac", exact: true })).toHaveAttribute(
    "href",
    /khac.*edit$/,
  );
  await page.getByRole("button", { name: "Đóng thông báo", exact: true }).click();
  expect(
    fixture.state.resolves.some(
      (call) => call.hrefs.includes("assets/so-do.png") && call.hrefs.includes("assets/logo.png"),
    ),
  ).toBe(true);
  await page.getByTestId("insert-image-input").setInputFiles({ name: "new.png", mimeType: "image/png", buffer: png });
  await expect.poll(() => fixture.state.draft.draft.content).toContain("assets/new.png");
  expect(uploaded).toContain(GUIDE_KEY);
  expect(uploaded).toContain('filename="new.png"');
  expect(fixture.state.draft.draft.content).not.toContain("/api/v1/docs/assets");
});

for (const role of ["admin", "member"] as const) {
  test(`bí mật: ${role} thấy loại và dòng, chỉ quản trị được vẫn lưu`, async ({ page }) => {
    const fixture = docsyncDocsScenario({ secret: true });
    await inOrg(page, role, fixture.rpc);
    await page.goto(`/knowledge/docs/${encodeURIComponent(GUIDE_KEY)}/edit`);
    await page.getByRole("button", { name: "Gửi duyệt", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Gửi duyệt", exact: true }).click();
    const warning = page.getByRole("dialog", { name: "Phát hiện dấu hiệu bí mật" });
    await expect(warning.getByText("GitHub token · dòng 12")).toBeVisible();
    if (role === "admin") {
      await warning.getByRole("button", { name: "Vẫn lưu", exact: true }).click();
      await expect(warning).toBeHidden();
      await expect(page.getByRole("dialog")).toBeHidden();
      expect(fixture.state.submissions).toEqual([
        expect.objectContaining({ revision: 2 }),
        expect.objectContaining({ revision: 2, acknowledgeSecrets: true }),
      ]);
    } else {
      await expect(warning.getByRole("button", { name: "Vẫn lưu", exact: true })).toBeHidden();
      await warning.getByRole("button", { name: "Quay lại sửa" }).click();
      expect(fixture.state.submissions).toHaveLength(1);
    }
  });
}

test("lỗi tải cây cho thử lại và danh sách trống có hướng dẫn", async ({ page }) => {
  const fixture = docsyncDocsScenario();
  let broken = true;
  await inOrg(page, "admin", {
    ...fixture.rpc,
    "docs/list": () => ok([]),
    "docTree/list": () =>
      broken ? fail("FORBIDDEN", 403, "Không có quyền đọc kho tài liệu.") : ok({ items: [], nextCursor: null }),
  });
  await page.goto("/knowledge/docs");
  await expect(page.getByRole("alert")).toContainText("Không có quyền đọc kho tài liệu.");
  broken = false;
  await page.getByRole("button", { name: "Tải lại", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Chưa có tài liệu nào", exact: true })).toBeVisible();
});
