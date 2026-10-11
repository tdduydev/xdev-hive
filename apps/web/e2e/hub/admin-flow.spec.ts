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

/** Đăng ký qua API của Better Auth, cho người không đi qua link mời (người đầu tiên, người chờ duyệt). */
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
  await page.getByLabel("Tên miền email (không bắt buộc)").fill("fpt.com");
  await page.getByRole("button", { name: "Tiếp: tạo đội" }).click();

  await expect(page).toHaveURL("/tao-to-chuc?buoc=doi");
  await expect(page.getByRole("heading", { name: "Tạo đội đầu tiên" })).toBeVisible();
  await page.getByLabel("Tên đội").fill("Thanh toán");
  await expect(page.getByLabel("Định danh")).toHaveValue("thanh-toan");
  await page.getByRole("button", { name: "Tiếp: mời người" }).click();

  // Bước 3 dùng cùng form với hộp thoại Mời người, đội vừa tạo chọn sẵn.
  await expect(page.getByRole("heading", { name: "Mời người" })).toBeVisible();
  await expect(page.getByLabel("Thêm vào đội")).toHaveValue(/.+/);
  await expect(page.getByLabel("Thêm vào đội").locator("option:checked")).toHaveText("Thanh toán");
  await page.getByRole("button", { name: "Để sau" }).click();

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
  // Đưa người thứ hai vào tổ chức thẳng bằng SQL để thử đổi vai trò; luồng lời mời có test riêng ở dưới.
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
  await expect(page.getByRole("tab", { name: "Lời mời · 0" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Chờ duyệt · 0" })).toBeVisible();

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

const INVITEE = { name: "Ngô Vy", email: "vy.ngo@e2e.test", password: "mat-khau-e2e-8910" };

test("mời người: tạo lời mời, mở link ở phiên khác, đăng ký bằng email rồi vào tổ chức", async ({ page, browser }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, OWNER);
  await page.locator("aside").getByRole("link", { name: "Thành viên" }).click();
  await page.getByRole("button", { name: "Mời người" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill(INVITEE.email.toUpperCase());
  await dialog.getByLabel("Thêm vào đội").selectOption({ label: "Thanh toán" });
  await dialog.getByLabel("Vai trò trong đội").selectOption({ label: "Chỉ xem" });
  await dialog.getByRole("button", { name: "Tạo lời mời" }).click();

  const linkField = dialog.getByLabel(`Link mời cho ${INVITEE.email}`, { exact: true });
  await expect(linkField).toHaveValue(new RegExp(`^${WEB_URL}/moi/[A-Za-z0-9_-]{43}$`));
  const link = await linkField.inputValue();
  await dialog.getByRole("button", { name: `Chép link mời cho ${INVITEE.email}` }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await dialog.getByRole("button", { name: "Đóng" }).click();

  await page.getByRole("tab", { name: "Lời mời · 1" }).click();
  const row = page.getByRole("row", { name: new RegExp(INVITEE.email) });
  await expect(row).toContainText("Chờ nhận");
  await expect(row).toContainText("Thanh toán");

  // Người được mời mở link trong trình duyệt khác (phiên riêng, chưa đăng nhập).
  const other = await browser.newContext({ locale: "vi-VN" });
  const guest = await other.newPage();
  await guest.goto(link);
  await expect(guest.getByRole("heading", { name: "Lời mời vào FPT Software xDev" })).toBeVisible();
  await expect(guest.getByLabel("Email")).toHaveValue(INVITEE.email);
  await guest.getByLabel("Họ và tên").fill(INVITEE.name);
  await guest.getByLabel("Mật khẩu").fill(INVITEE.password);
  await guest.getByRole("button", { name: "Tạo tài khoản và vào tổ chức" }).click();

  await expect(guest).toHaveURL("/");
  await expect(guest.getByRole("heading", { name: `Chào ${INVITEE.name}` })).toBeVisible();
  await expect(switcher(guest)).toContainText("FPT Software xDev");
  await expect(switcher(guest)).toContainText("Thành viên");
  // Thành viên thường không thấy cài đặt đăng nhập của tổ chức.
  await expect(guest.locator("aside").getByRole("link", { name: "Đăng nhập" })).toHaveCount(0);

  // Link chỉ dùng một lần.
  await guest.goto(link);
  await expect(guest.getByRole("heading", { name: "Lời mời đã được dùng" })).toBeVisible();
  await other.close();

  await page.reload();
  await expect(row).toContainText("Đã nhận");
  await expect(page.getByRole("button", { name: `Thu hồi lời mời cho ${INVITEE.email}` })).toHaveCount(0);
  await page.getByRole("tab", { name: /Đang hoạt động/ }).click();
  const member = page.getByRole("row", { name: new RegExp(INVITEE.name) });
  await expect(member).toContainText("Thanh toán");
  await expect(page.getByLabel(`Vai trò tổ chức của ${INVITEE.name}`)).toHaveValue("member");
});

test("thu hồi lời mời: link cũ báo không tìm thấy", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto("/quan-tri/thanh-vien");
  await page.getByRole("button", { name: "Mời người" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill("thu-hoi@e2e.test");
  await dialog.getByRole("button", { name: "Tạo lời mời" }).click();
  const link = await dialog.getByLabel("Link mời cho thu-hoi@e2e.test", { exact: true }).inputValue();
  await dialog.getByRole("button", { name: "Đóng" }).click();

  await page.getByRole("tab", { name: /Lời mời/ }).click();
  await page.getByRole("button", { name: "Thu hồi lời mời cho thu-hoi@e2e.test" }).click();
  await expect(page.getByRole("row", { name: /thu-hoi@e2e\.test/ })).toHaveCount(0);

  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Không tìm thấy lời mời" })).toBeVisible();
  await expect(page.getByText("Link có thể sai hoặc đã bị thu hồi.")).toBeVisible();
});

test("duyệt người chờ: duyệt thì thành thành viên, từ chối thì bị khoá", async ({ page, request }) => {
  const khoa = { name: "Đỗ Khoa", email: "khoa.do@e2e.test", password: "mat-khau-e2e-1112" };
  const long = { name: "Phan Long", email: "long.phan@e2e.test", password: "mat-khau-e2e-1314" };
  // Trạng thái chờ duyệt có khi người dùng đăng nhập SSO lần đầu; dựng thẳng bằng SQL vì e2e không có IdP.
  for (const user of [khoa, long]) {
    const id = await signUp(request, user);
    await db.query(
      "insert into hive.org_members (org_id, user_id, status) select id, $2, 'pending' from hive.orgs where slug = $1",
      ["fpt-xdev", id],
    );
  }

  await signIn(page, OWNER);
  await page.goto("/quan-tri/thanh-vien");
  await expect(page.getByText(khoa.email)).toHaveCount(0);
  await page.getByRole("tab", { name: "Chờ duyệt · 2" }).click();
  await expect(page.getByRole("row", { name: new RegExp(khoa.name) })).toContainText("Chờ duyệt");

  await page.getByRole("button", { name: `Duyệt ${khoa.name}` }).click();
  await expect(page.getByRole("tab", { name: "Chờ duyệt · 1" })).toBeVisible();
  await page.getByRole("button", { name: `Từ chối ${long.name}` }).click();
  await expect(page.getByRole("tab", { name: "Chờ duyệt · 0" })).toBeVisible();
  await expect(page.getByText("Không có ai đang chờ duyệt.")).toBeVisible();

  await page.getByRole("tab", { name: /Đang hoạt động/ }).click();
  await expect(page.getByRole("row", { name: new RegExp(khoa.name) })).not.toContainText("Đã khoá");
  await expect(page.getByRole("row", { name: new RegExp(long.name) })).toContainText("Đã khoá");
  const { rows } = await db.query<{ email: string; status: string }>(
    `select u.email, m.status from hive.org_members m join auth."user" u on u.id = m.user_id
     where u.email = any($1) order by u.email`,
    [[khoa.email, long.email]],
  );
  expect(rows).toEqual([
    { email: khoa.email, status: "active" },
    { email: long.email, status: "blocked" },
  ]);
});

test("cài đặt đăng nhập: callback URL theo tổ chức, lỗi Issuer của hub hiện tiếng Việt", async ({ page }) => {
  await signIn(page, OWNER);
  await page.locator("aside").getByRole("link", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/quan-tri/dang-nhap");
  const { rows } = await db.query<{ id: string }>("select id from hive.orgs where slug = 'fpt-xdev'");
  await expect(page.getByLabel("Callback URL (dán vào cấu hình app bên nhà cung cấp)")).toHaveValue(
    `${WEB_URL}/api/auth/sso/callback/org-${rows[0]?.id}`,
  );
  await expect(
    page.getByRole("list", { name: "Các cách đăng nhập" }).getByRole("listitem").filter({ hasText: "SSO (OIDC)" }),
  ).toContainText("Chưa cấu hình");
  await expect(page.getByLabel("Tên miền email")).toHaveValue("fpt.com");

  // Hub không đọc được discovery của issuer này (địa chỉ nội bộ, không có IdP): lỗi gắn vào ô Issuer.
  await page.getByLabel("Issuer URL").fill("http://127.0.0.1:9/oidc");
  await page.getByLabel("Client ID").fill("client-e2e");
  await page.getByLabel("Client secret").fill("bi-mat-e2e");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText(/Không đọc được cấu hình OIDC từ Issuer URL/)).toBeVisible();
  await expect(page.getByLabel("Issuer URL")).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByRole("list", { name: "Các cách đăng nhập" }).getByRole("listitem").filter({ hasText: "SSO (OIDC)" }),
  ).toContainText("Chưa cấu hình");
});
