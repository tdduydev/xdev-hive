import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import pg from "pg";
import { DATABASE_URL_ENV, MEMBER, OWNER, WEB_URL } from "./env.ts";

// Các bước nối tiếp nhau trên cùng một hub: người đầu tiên tạo tổ chức rồi mới có đội, có người để đổi vai trò.
test.describe.configure({ mode: "serial" });

type User = typeof OWNER;

let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env[DATABASE_URL_ENV] });
});
test.afterAll(() => db.end());

/** Đăng ký qua API của Better Auth: web chưa có form đăng ký (người mới vào bằng lời mời hoặc SSO). */
async function signUp(request: APIRequestContext, user: User): Promise<string> {
  const res = await request.post("/api/auth/sign-up/email", {
    data: { name: user.name, email: user.email, password: user.password },
    headers: { origin: WEB_URL },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { user: { id: string } }).user.id;
}

async function signIn(page: Page, user: User) {
  await page.goto("/");
  await expect(page).toHaveURL("/dang-nhap");
  await page.getByText("Đăng nhập bằng email và mật khẩu").click();
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Mật khẩu").fill(user.password);
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await page.waitForURL((url) => url.pathname !== "/dang-nhap");
}

const teamList = (page: Page) => page.getByRole("navigation", { name: "Danh sách đội" });
const switcher = (page: Page) => page.locator("aside").getByRole("button").first();

test("người đầu tiên: tạo tổ chức, đội đầu tiên, rồi thêm hệ thống", async ({ page, request }) => {
  await signUp(request, OWNER);
  await signIn(page, OWNER);

  // Hub chưa có tổ chức nào nên người đầu tiên vào thẳng màn tạo tổ chức.
  await expect(page).toHaveURL("/tao-to-chuc");
  await expect(page.getByRole("heading", { name: "Tạo tổ chức" })).toBeVisible();
  await page.getByLabel("Tên tổ chức").fill("FPT Software xDev");
  const orgSlug = page.getByLabel("Định danh");
  await expect(orgSlug).toHaveValue("fpt-software-xdev");
  await orgSlug.fill("fpt-xdev");
  await page.getByLabel("Tên miền email (không bắt buộc)").fill("example.com");
  await page.getByRole("button", { name: "Tiếp: tạo đội" }).click();

  await expect(page).toHaveURL("/tao-to-chuc?buoc=doi");
  await expect(page.getByRole("heading", { name: "Tạo đội đầu tiên" })).toBeVisible();
  await page.getByLabel("Tên đội").fill("Thanh toán");
  await expect(page.getByLabel("Định danh")).toHaveValue("thanh-toan");
  await page.getByRole("button", { name: "Tiếp: mời người" }).click();

  await expect(page.getByRole("heading", { name: /Mời người/ })).toContainText("Sắp có");
  await page.getByRole("link", { name: "Vào trang Đội và hệ thống" }).click();

  await expect(page).toHaveURL(/\/quan-tri\/doi\?doi=/);
  await expect(switcher(page)).toContainText("FPT Software xDev");
  await expect(switcher(page)).toContainText("Chủ sở hữu");
  await expect(teamList(page).getByRole("link", { name: /Thanh toán/ })).toContainText("0 hệ thống · 1 người");
  // Người tạo là quản trị của đội đầu tiên.
  await expect(page.getByLabel(`Vai trò của ${OWNER.name} trong đội`)).toHaveValue("admin");

  await page.getByRole("button", { name: "Hệ thống", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Thêm hệ thống vào đội Thanh toán" })).toBeVisible();
  await dialog.getByLabel("Tên hệ thống").fill("Cổng thanh toán");
  await dialog.getByLabel("Định danh").fill("cong");
  await dialog.getByLabel("Mô tả").fill("Nhận thanh toán thẻ và ví");
  await dialog.getByRole("button", { name: "Thêm", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Cổng thanh toán")).toBeVisible();
  await expect(page.getByText("thanh-toan/cong")).toBeVisible();
  await expect(teamList(page).getByRole("link", { name: /Thanh toán/ })).toContainText("1 hệ thống · 1 người");
});

test("trùng định danh đội: hiện lỗi tiếng Việt của hub ngay ở ô định danh", async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.getByRole("heading", { name: `Chào ${OWNER.name}` })).toBeVisible();
  await page.locator("aside").getByRole("link", { name: "Đội và hệ thống" }).click();

  await page.getByRole("button", { name: "Tạo đội" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Tên đội").fill("Thanh toán");
  await dialog.getByRole("button", { name: "Tạo đội" }).click();
  await expect(dialog.getByText('Định danh "thanh-toan" đã được đội khác dùng.')).toBeVisible();
  await expect(dialog.getByLabel("Định danh")).toHaveAttribute("aria-invalid", "true");

  await dialog.getByLabel("Tên đội").fill("CRM");
  await dialog.getByLabel("Định danh").fill("crm");
  await dialog.getByRole("button", { name: "Tạo đội" }).click();
  await expect(dialog).toBeHidden();
  await expect(teamList(page).getByRole("link", { name: /CRM/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Hệ thống của đội CRM" })).toBeVisible();
});

test("thêm người vào đội, đổi vai trò trong đội và vai trò tổ chức, khoá rồi mở khoá", async ({ page, request }) => {
  const memberId = await signUp(request, MEMBER);
  // API lời mời đang làm ở task M1c-invite-sso; tạm đưa người thứ hai vào tổ chức thẳng bằng SQL.
  await db.query("insert into hive.org_members (org_id, user_id) select id, $2 from hive.orgs where slug = $1", [
    "fpt-xdev",
    memberId,
  ]);

  await signIn(page, OWNER);
  await page.goto("/quan-tri/doi");
  await teamList(page)
    .getByRole("link", { name: /Thanh toán/ })
    .click();
  await page.getByRole("button", { name: "Thêm người" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Người").selectOption({ label: `${MEMBER.name} · ${MEMBER.email}` });
  await expect(dialog.getByLabel("Vai trò trong đội")).toHaveValue("member");
  await dialog.getByRole("button", { name: "Thêm", exact: true }).click();
  await expect(dialog).toBeHidden();

  const teamRole = page.getByLabel(`Vai trò của ${MEMBER.name} trong đội`);
  await expect(teamRole).toHaveValue("member");
  await teamRole.selectOption({ label: "Chỉ xem" });
  await expect(teamRole).toBeEnabled();
  await expect(teamList(page).getByRole("link", { name: /Thanh toán/ })).toContainText("2 người");
  await page.reload();
  await expect(page.getByLabel(`Vai trò của ${MEMBER.name} trong đội`)).toHaveValue("viewer");

  await page.locator("aside").getByRole("link", { name: "Thành viên" }).click();
  await expect(page).toHaveURL("/quan-tri/thanh-vien");
  await expect(page.getByRole("tab", { name: "Đang hoạt động · 2" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: /Lời mời/ })).toContainText("Sắp có");
  await expect(page.getByRole("tab", { name: /Chờ duyệt/ })).toContainText("Sắp có");

  const row = page.getByRole("row", { name: new RegExp(MEMBER.name) });
  await expect(row).toContainText("Thanh toán");
  const orgRole = page.getByLabel(`Vai trò tổ chức của ${MEMBER.name}`);
  await expect(orgRole).toHaveValue("member");
  await orgRole.selectOption({ label: "Quản trị" });
  await expect(orgRole).toBeEnabled();
  // Không tự đổi vai trò hay tự khoá mình.
  await expect(page.getByLabel(`Vai trò tổ chức của ${OWNER.name}`)).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Khoá ${OWNER.name}` })).toHaveCount(0);

  await page.getByRole("button", { name: `Khoá ${MEMBER.name}` }).click();
  await expect(row).toContainText("Đã khoá");
  await expect(page.getByRole("tab", { name: "Đang hoạt động · 1" })).toBeVisible();
  await page.getByRole("button", { name: `Mở khoá ${MEMBER.name}` }).click();
  await expect(row).not.toContainText("Đã khoá");

  await page.reload();
  await expect(page.getByLabel(`Vai trò tổ chức của ${MEMBER.name}`)).toHaveValue("admin");
  await page.getByLabel("Tìm thành viên").fill("le ha");
  await expect(page.getByRole("row", { name: new RegExp(OWNER.name) })).toHaveCount(0);
  await expect(page.getByRole("row", { name: new RegExp(MEMBER.name) })).toBeVisible();
});

test("quản trị không phải chủ sở hữu: không thấy nút đổi vai trò tổ chức, không khoá được chủ sở hữu", async ({
  page,
}) => {
  await signIn(page, MEMBER);
  await expect(switcher(page)).toContainText("Quản trị");
  await page.locator("aside").getByRole("link", { name: "Đội và hệ thống" }).click();
  // Quản trị tổ chức là quản trị mọi đội.
  await expect(page.getByRole("button", { name: "Tạo đội" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Thêm người" })).toBeVisible();

  await page.locator("aside").getByRole("link", { name: "Thành viên" }).click();
  await expect(page.getByRole("row", { name: new RegExp(OWNER.name) })).toContainText("Chủ sở hữu");
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Khoá ${OWNER.name}` })).toHaveCount(0);
});

test("đổi tổ chức ở sidebar: gửi header của tổ chức mới và nhớ sau khi tải lại", async ({ page }) => {
  await signIn(page, OWNER);
  await switcher(page).click();
  await page.getByRole("menuitem", { name: "Tạo tổ chức" }).click();
  await page.getByLabel("Tên tổ chức").fill("Phòng thí nghiệm");
  await page.getByRole("button", { name: "Tiếp: tạo đội" }).click();
  await expect(page.getByRole("heading", { name: "Tạo đội đầu tiên" })).toBeVisible();
  await page.getByRole("link", { name: "Để sau" }).click();

  const { rows } = await db.query<{ id: string; slug: string }>(
    "select id, slug from hive.orgs where slug in ('fpt-xdev', 'phong-thi-nghiem')",
  );
  const idOf = (slug: string) => rows.find((r) => r.slug === slug)?.id;
  const sent: (string | undefined)[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/rpc/teams/list")) sent.push(req.headers()["x-hive-org"]);
  });

  await expect(switcher(page)).toContainText("Phòng thí nghiệm");
  await expect(page.getByRole("heading", { name: "Chưa có đội nào" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("hive.org"))).toBe(idOf("phong-thi-nghiem"));

  await switcher(page).click();
  await page.getByRole("menuitemradio", { name: /FPT Software xDev/ }).click();
  await expect(teamList(page).getByRole("link")).toHaveText([/CRM/, /Thanh toán/]);
  expect(sent.at(-1)).toBe(idOf("fpt-xdev"));
  expect(await page.evaluate(() => localStorage.getItem("hive.org"))).toBe(idOf("fpt-xdev"));

  await page.reload();
  await expect(switcher(page)).toContainText("FPT Software xDev");
  await expect(teamList(page).getByRole("link")).toHaveText([/CRM/, /Thanh toán/]);
});
