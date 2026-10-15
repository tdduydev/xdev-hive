import { expect, type Page, test } from "@playwright/test";
import { docsyncSettingsFixture, fail } from "./fake-hub.ts";
import { inOrg } from "./reviews-fixture.ts";

const settings = (page: Page) => page.getByRole("group", { name: "Tài liệu", exact: true });
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("same key")) throw new Error(message.text());
  });
});

const status = (page: Page) => page.getByRole("group", { name: "Trạng thái đồng bộ", exact: true });

for (const provider of ["github", "gitlab"] as const) {
  test(`${provider}: lưu cấu hình riêng, giữ mẫu và hiển thị trạng thái`, async ({ page }) => {
    const fixture = docsyncSettingsFixture({ provider });
    const hub = await inOrg(page, "admin", fixture.rpc);
    await page.goto("/projects/payment-api/settings#docs");
    const form = settings(page);
    await expect(form.getByLabel("Thư mục tài liệu", { exact: true })).toBeEnabled();
    await expect(form.getByText("Người có quyền đọc repo", { exact: false })).toBeVisible();
    await form.getByLabel("Thư mục tài liệu", { exact: true }).fill("handbook/");
    await form.getByLabel("Ghi từ hub vào repo").selectOption("direct");
    await form.getByRole("switch", { name: "Thay đổi từ repo phải qua duyệt" }).click();
    await form.getByLabel("Mẫu lấy").fill("docs/**\nspecs/**");
    await form.getByRole("button", { name: "Lưu", exact: true }).click();
    await expect(form.getByText("Đã lưu", { exact: true })).toBeVisible();
    expect(fixture.state.project.settings.docs).toMatchObject({
      root: "handbook/",
      repoSync: "direct",
      include: ["docs/**", "specs/**"],
      repoChangesNeedReview: true,
    });
    expect(hub.rpcCalls.filter((call) => call.path === "projects/updateSettings")).toHaveLength(0);
    await expect(status(page).getByText("128", { exact: true })).toBeVisible();
    await expect(status(page).getByRole("link", { name: "PR #128 · Đồng bộ tài liệu" })).toHaveAttribute(
      "href",
      fixture.state.home?.prUrl ?? "",
    );
    await page.reload();
    await expect(settings(page).getByLabel("Thư mục tài liệu", { exact: true })).toHaveValue("handbook/");
  });
}

test("360 px, sáng/tối và bàn phím: lưu, đồng bộ, tạm dừng và bật lại", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const fixture = docsyncSettingsFixture();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/projects/payment-api/settings#docs");
  const root = settings(page).getByLabel("Thư mục tài liệu", { exact: true });
  await root.fill("manual/");
  await root.press("Enter");
  await expect(settings(page).getByText("Đã lưu", { exact: true })).toBeVisible();
  await status(page).getByRole("button", { name: "Đồng bộ ngay", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(status(page).getByRole("status")).toHaveText("Đã xếp đồng bộ.");
  await status(page).getByRole("button", { name: "Tạm dừng", exact: true }).click();
  await expect(status(page).getByRole("button", { name: "Bật lại", exact: true })).toBeVisible();
  await expect(status(page).getByRole("button", { name: "Đồng bộ ngay", exact: true })).toBeDisabled();
  await status(page).getByRole("button", { name: "Bật lại", exact: true }).click();
  await expect(status(page).getByText("Đang hoạt động", { exact: true })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.classList.toggle("dark", value === "dark"), theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("đường dẫn không hợp lệ bị chặn; huỷ chỉ khôi phục mục tài liệu", async ({ page }) => {
  const fixture = docsyncSettingsFixture();
  const hub = await inOrg(page, "admin", fixture.rpc);
  await page.goto("/projects/payment-api/settings#docs");
  const form = settings(page);
  await form.getByLabel("Thư mục tài liệu", { exact: true }).fill("../private");
  await form.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(form.getByText("Cấu hình tài liệu không hợp lệ.", { exact: false })).toBeVisible();
  expect(hub.rpcCalls.some((call) => call.path === "docHomes/configureProject")).toBe(false);
  await form.getByRole("button", { name: "Huỷ", exact: true }).click();
  await expect(form.getByLabel("Thư mục tài liệu", { exact: true })).toHaveValue("docs/");
});

for (const error of ["overlap", "permission", "protected"] as const) {
  test(`báo lỗi ${error} và giữ nội dung đã nhập`, async ({ page }) => {
    const fixture = docsyncSettingsFixture({ error });
    await inOrg(page, "admin", fixture.rpc);
    await page.goto("/projects/payment-api/settings#docs");
    if (error === "protected") {
      await status(page).getByRole("button", { name: "Đồng bộ ngay" }).click();
      await expect(status(page).getByText("Nhánh được bảo vệ.", { exact: false })).toBeVisible();
    } else {
      await settings(page).getByLabel("Thư mục tài liệu", { exact: true }).fill("handbook/");
      await settings(page).getByRole("button", { name: "Lưu", exact: true }).click();
      await expect(
        settings(page).getByText(
          error === "overlap" ? "Thư mục chồng với kho SDLC." : "Kết nối không có quyền đọc và ghi repo tài liệu.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(settings(page).getByLabel("Thư mục tài liệu", { exact: true })).toHaveValue("handbook/");
    }
  });
}

test("xác nhận nhánh mới, xem trước nhiều trang và chỉ đưa tài liệu đã chọn vào PR riêng", async ({ page }) => {
  const fixture = docsyncSettingsFixture({ pages: true });
  const hub = await inOrg(page, "admin", fixture.rpc);
  await page.goto("/projects/payment-api/settings#docs");
  await status(page).getByRole("button", { name: "Dùng nhánh mới" }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Xác nhận nhánh mới" })).toBeDisabled();
  await dialog.getByLabel("Nhánh mặc định mới").fill("trunk");
  await dialog.getByRole("button", { name: "Xác nhận nhánh mới" }).click();
  await expect(status(page).getByText("Đã chuyển sang nhánh mới.", { exact: true })).toBeVisible();
  expect(fixture.state.home?.branch).toBe("trunk");
  await status(page).getByRole("button", { name: "Đưa tài liệu hub vào repo" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Đường dẫn đã tồn tại trong repo.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Tạo PR riêng (0)" })).toBeDisabled();
  expect(hub.rpcCalls.some((call) => call.path === "docHomes/adopt")).toBe(false);
  await dialog.getByRole("checkbox", { name: "project/payment-api/guide", exact: false }).check();
  await dialog.getByRole("button", { name: "Xem thêm tài liệu" }).click();
  await expect(dialog.getByText("project/payment-api/second", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Tạo PR riêng (1)" }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.state.adopted).toEqual(["project/payment-api/guide"]);
});

for (const create of [false, true]) {
  test(`kho tổ chức: ${create ? "tạo repo riêng tư" : "chọn repo có sẵn"}, mặc định direct và nhánh của provider`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const fixture = docsyncSettingsFixture({ provider: create ? "gitlab" : "github" });
    await inOrg(page, "admin", fixture.rpc);
    await page.goto("/knowledge/skills");
    const card = page.getByRole("group", { name: "Kho tài liệu tổ chức", exact: true });
    await expect(card.getByLabel("Ghi từ hub vào repo")).toHaveValue("direct");
    await card.getByLabel("Cách chọn repo").selectOption(create ? "new" : "existing");
    await card.getByLabel("Chủ sở hữu").fill("acme");
    await card.getByLabel("Tên repo", { exact: true }).fill("org-docs");
    await card.getByRole("button", { name: "Lưu", exact: true }).click();
    await expect(status(page).getByText("Đang hoạt động", { exact: true })).toBeVisible();
    expect(fixture.state.configured).toContainEqual(
      expect.objectContaining({ create, mode: "direct", root: "", owner: "acme", name: "org-docs" }),
    );
    expect(fixture.state.orgHome?.branch).toBe("trunk");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("chỉ đọc: không sửa cấu hình hoặc gọi thao tác quản trị", async ({ page }) => {
  const fixture = docsyncSettingsFixture();
  const hub = await inOrg(page, "member", fixture.rpc);
  await page.goto("/projects/payment-api/settings#docs");
  await expect(settings(page).getByLabel("Thư mục tài liệu", { exact: true })).toBeDisabled();
  await expect(settings(page).getByRole("button", { name: "Lưu", exact: true })).toHaveCount(0);
  await expect(status(page).getByRole("button")).toHaveCount(0);
  await page.goto("/knowledge/skills");
  const card = page.getByRole("group", { name: "Kho tài liệu tổ chức", exact: true });
  await expect(card.getByLabel("Tên repo", { exact: true })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Lưu", exact: true })).toHaveCount(0);
  expect(
    hub.rpcCalls.some((call) => /docHomes\/(configure|pause|resume|syncNow|acceptBranch|adopt$)/.test(call.path)),
  ).toBe(false);
});

test("lỗi tải nhà có nút thử lại và không cho ghi đè cấu hình", async ({ page }) => {
  const fixture = docsyncSettingsFixture();
  await inOrg(page, "admin", {
    ...fixture.rpc,
    "docHomes/get": () => fail("FORBIDDEN", 403, "Bạn không có quyền đọc nhà tài liệu."),
  });
  await page.goto("/projects/payment-api/settings#docs");
  await expect(settings(page).getByText("Bạn không có quyền đọc nhà tài liệu.")).toBeVisible();
  await expect(settings(page).getByLabel("Thư mục tài liệu", { exact: true })).toBeDisabled();
});

test("khung route cho nhập, xung đột và bản trích", async ({ page }) => {
  await inOrg(page, "admin", docsyncSettingsFixture().rpc);
  for (const [path, title] of [
    ["import", "Nhập tài liệu từ repo"],
    ["conflicts/conflict-id", "Giải quyết xung đột tài liệu"],
    ["extracts", "Bản trích tài liệu"],
  ] as const) {
    await page.goto(`/knowledge/docs/${path}`);
    await expect(page.getByRole("heading", { name: title, exact: true, level: 1 })).toBeVisible();
  }
});

test("bật nhà chưa có, tắt ghi repo và giữ cấu hình khi rời trang còn bản nháp", async ({ page }) => {
  const fixture = docsyncSettingsFixture({ home: false });
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/projects/payment-api/settings#docs");
  const form = settings(page);
  await expect(form.getByRole("switch", { name: "Bật tài liệu gắn repo" })).not.toBeChecked();
  await form.getByRole("switch", { name: "Bật tài liệu gắn repo" }).click();
  await form.getByLabel("Ghi từ hub vào repo").selectOption("off");
  await form.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(form.getByText("Đã lưu", { exact: true })).toBeVisible();
  expect(fixture.state.project.settings.docs).toMatchObject({ enabled: true, repoSync: "off" });
  await expect(status(page).getByRole("button", { name: "Đồng bộ ngay" })).toBeDisabled();
  await form.getByLabel("Thư mục tài liệu", { exact: true }).fill("draft/");
  await status(page).getByRole("link", { name: "Nhập từ repo" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Rời trang khi còn thay đổi chưa lưu?")).toBeVisible();
  await dialog.getByRole("button", { name: "Ở lại" }).click();
  await expect(form.getByLabel("Thư mục tài liệu", { exact: true })).toHaveValue("draft/");
});
