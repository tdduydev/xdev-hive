import { expect, type Page, test } from "@playwright/test";
import { fail, fakeHub, ok, type RpcHandler, USER } from "./fake-hub.ts";

const at = "2026-10-01T03:00:00.000Z";
const ORG_A = {
  id: "0a0a0a0a-0000-4000-8000-00000000000a",
  slug: "fpt-xdev",
  name: "FPT Software xDev",
  role: "owner",
};
const ORG_B = { id: "0b0b0b0b-0000-4000-8000-00000000000b", slug: "noi-bo", name: "Nội bộ", role: "member" };
const myOrg = (o: typeof ORG_A) => ({ ...o, emailDomain: null, createdAt: at });
const TEAM = {
  id: "7e7e7e7e-0000-4000-8000-000000000001",
  slug: "thanh-toan",
  name: "Thanh toán",
  color: "#7B61FF",
  createdAt: at,
  systemCount: 1,
  memberCount: 2,
};
const SYSTEM = {
  id: "5e5e5e5e-0000-4000-8000-000000000001",
  teamId: TEAM.id,
  slug: "cong",
  name: "Cổng thanh toán",
  description: "Nhận thanh toán thẻ",
  createdAt: at,
};
const HA = { userId: "u2", name: "Lê Hà", email: "ha.le@example.com", image: null };

/** Hub giả có hai tổ chức: ở A người dùng là chủ sở hữu, ở B chỉ là thành viên (chỉ xem trong đội). */
function twoOrgs(): Record<string, RpcHandler> {
  const roleIn = (org: string | undefined) => (org === ORG_A.id ? "owner" : "member");
  return {
    "orgs/mine": () => ok({ orgs: [myOrg(ORG_A), myOrg(ORG_B)], canCreateOrg: false }),
    "teams/list": () => ok([TEAM]),
    "systems/list": () => ok([SYSTEM]),
    "teamMembers/list": () =>
      ok([
        { ...HA, teamId: TEAM.id, role: "admin" },
        { userId: USER.id, name: USER.name, email: USER.email, image: null, teamId: TEAM.id, role: "viewer" },
      ]),
    "orgMembers/list": (_, call) =>
      ok([
        {
          ...HA,
          role: "member",
          status: "active",
          joinedAt: at,
          teams: [{ teamId: TEAM.id, name: TEAM.name, role: "admin" }],
        },
        {
          userId: USER.id,
          name: USER.name,
          email: USER.email,
          image: null,
          role: roleIn(call.org),
          status: "active",
          joinedAt: at,
          teams: [{ teamId: TEAM.id, name: TEAM.name, role: "viewer" }],
        },
        {
          userId: "u3",
          name: "Đỗ Khoa",
          email: "khoa.do@example.com",
          image: null,
          role: "member",
          status: "pending",
          joinedAt: at,
          teams: [],
        },
      ]),
  };
}

const switcher = (page: Page) => page.locator("aside").getByRole("button").first();

test("đổi tổ chức: nhớ lựa chọn, gửi x-hive-org của tổ chức đang chọn, nút theo vai trò", async ({ page }) => {
  await page.addInitScript((id) => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("hive.org", id);
      sessionStorage.setItem("seeded", "1");
    }
  }, ORG_B.id);
  const hub = await fakeHub(page, { signedIn: true, rpc: twoOrgs() });
  await page.goto("/quan-tri/doi");

  // Tổ chức B đã nhớ từ lần trước; ở B chỉ là thành viên, chỉ xem trong đội.
  await expect(switcher(page)).toContainText("Nội bộ");
  await expect(switcher(page)).toContainText("Thành viên");
  await expect(page.getByRole("heading", { name: "Hệ thống của đội Thanh toán" })).toBeVisible();
  await expect(page.getByText("thanh-toan/cong")).toBeVisible();
  await expect(page.getByRole("row", { name: /Lê Hà/ })).toContainText("Quản trị đội");
  await expect(page.getByRole("button", { name: "Tạo đội" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Hệ thống", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Thêm người" })).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  const orgsOf = (path: string) => hub.rpcCalls.filter((c) => c.path === path).map((c) => c.org);
  expect(new Set(orgsOf("teams/list"))).toEqual(new Set([ORG_B.id]));
  // Danh sách tổ chức của mình không cần chọn tổ chức.
  expect(orgsOf("orgs/mine")).toEqual([undefined]);

  await switcher(page).click();
  await page.getByRole("menuitemradio", { name: /FPT Software xDev/ }).click();
  await expect(switcher(page)).toContainText("Chủ sở hữu");
  await expect(page.getByRole("button", { name: "Tạo đội" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hệ thống", exact: true })).toBeVisible();
  await expect(page.getByLabel("Vai trò của Lê Hà trong đội")).toHaveValue("admin");
  expect(orgsOf("teams/list")).toContain(ORG_A.id);
  expect(await page.evaluate(() => localStorage.getItem("hive.org"))).toBe(ORG_A.id);

  await page.reload();
  await expect(switcher(page)).toContainText("FPT Software xDev");
});

test("thành viên: tab Lời mời, Chờ duyệt và mục Đăng nhập để Sắp có; người chờ duyệt chưa hiện", async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_A.id);
  await fakeHub(page, { signedIn: true, rpc: twoOrgs() });
  await page.goto("/quan-tri/thanh-vien");

  await expect(page.getByRole("heading", { name: "Thành viên" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Đang hoạt động · 2" })).toHaveAttribute("aria-selected", "true");
  for (const name of ["Lời mời", "Chờ duyệt"]) {
    const tab = page.getByRole("tab", { name: new RegExp(name) });
    await expect(tab).toContainText("Sắp có");
    await expect(tab).toBeDisabled();
  }
  await expect(page.getByRole("button", { name: /Mời người/ })).toBeDisabled();
  await expect(page.getByText("khoa.do@example.com")).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Lê Hà/ })).toContainText("Thanh toán");
  await expect(page.getByRole("row", { name: /Lê Hà/ })).toContainText("quản trị đội");

  const nav = page.getByRole("navigation", { name: "Điều hướng chính" });
  await expect(nav.locator("[aria-disabled=true]").filter({ hasText: "Đăng nhập" })).toContainText("Sắp có");
  await expect(nav.getByRole("link", { name: "Thành viên" })).toHaveAttribute("aria-current", "page");
});

test("lỗi khi đổi vai trò: hiện câu tiếng Việt của hub, ô chọn quay về vai trò cũ", async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_A.id);
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      ...twoOrgs(),
      "orgMembers/setRole": () =>
        fail("CONFLICT", 409, "Tổ chức phải còn ít nhất một chủ sở hữu đang hoạt động.", { code: "LAST_OWNER" }),
    },
  });
  await page.goto("/quan-tri/thanh-vien");
  const role = page.getByLabel("Vai trò tổ chức của Lê Hà");
  await role.selectOption({ label: "Quản trị" });
  await expect(page.getByRole("alert")).toHaveText("Tổ chức phải còn ít nhất một chủ sở hữu đang hoạt động.");
  await expect(role).toHaveValue("member");
  expect(hub.rpcCalls.find((c) => c.path === "orgMembers/setRole")).toMatchObject({
    method: "PATCH",
    org: ORG_A.id,
    input: { userId: HA.userId, role: "admin" },
  });
});

test("chưa thuộc tổ chức, không được tạo: trang quản trị và màn tạo tổ chức về trang chủ", async ({ page }) => {
  await fakeHub(page, { signedIn: true });
  for (const path of ["/tao-to-chuc", "/quan-tri/doi", "/quan-tri/thanh-vien"]) {
    await page.goto(path);
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: "Chưa thuộc tổ chức nào" })).toBeVisible();
  }
  const nav = page.getByRole("navigation", { name: "Điều hướng chính" });
  await expect(nav.locator("[aria-disabled=true]").filter({ hasText: "Đội và hệ thống" })).toBeVisible();
});

test("tạo tổ chức: lỗi kiểm tra của hub hiện ngay dưới ô bị sai", async ({ page }) => {
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () => ok({ orgs: [], canCreateOrg: true }),
      "orgs/create": () =>
        fail("BAD_REQUEST", 400, "Dữ liệu không hợp lệ ở trường emailDomain: Tên miền không hợp lệ.", {
          issues: [{ path: ["emailDomain"], message: "Tên miền không hợp lệ." }],
        }),
    },
  });
  await page.goto("/");
  await expect(page).toHaveURL("/tao-to-chuc");
  await page.getByRole("button", { name: "Tiếp: tạo đội" }).click();
  // Kiểm trên máy trước khi gửi.
  await expect(page.getByText("Nhập tên.")).toBeVisible();
  expect(hub.rpcCalls.some((c) => c.path === "orgs/create")).toBe(false);

  await page.getByLabel("Tên tổ chức").fill("Đội Ứng dụng");
  await expect(page.getByLabel("Định danh")).toHaveValue("doi-ung-dung");
  await page.getByLabel("Tên miền email (không bắt buộc)").fill("khong-hop-le");
  await page.getByRole("button", { name: "Tiếp: tạo đội" }).click();
  await expect(page.getByText("Tên miền không hợp lệ.")).toBeVisible();
  await expect(page.getByLabel("Tên miền email (không bắt buộc)")).toHaveAttribute("aria-invalid", "true");
  expect(hub.rpcCalls.find((c) => c.path === "orgs/create")?.input).toEqual({
    name: "Đội Ứng dụng",
    slug: "doi-ung-dung",
    emailDomain: "khong-hop-le",
  });
});
