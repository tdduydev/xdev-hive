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
  color: "#004CFF",
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
  return {
    "orgs/mine": () => ok({ orgs: [myOrg(ORG_A), myOrg(ORG_B)], canCreateOrg: false }),
    "teams/list": () => ok([TEAM]),
    "systems/list": () => ok([SYSTEM]),
    "teamMembers/list": () =>
      ok([
        { ...HA, teamId: TEAM.id, role: "admin" },
        { userId: USER.id, name: USER.name, email: USER.email, image: null, teamId: TEAM.id, role: "viewer" },
      ]),
    "orgMembers/list": (_, call) => ok(orgMembersIn(call.org)),
  };
}

/** Thành viên tổ chức như hub trả; người dùng đang đăng nhập là chủ sở hữu ở A, thành viên ở B. */
function orgMembersIn(org: string | undefined) {
  const roleIn = org === ORG_A.id ? "owner" : "member";
  return [
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
      role: roleIn,
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
  ];
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
  await page.goto("/admin/teams");

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

const INVITES = [
  {
    id: "1a1a1a1a-0000-4000-8000-000000000001",
    email: "vy.ngo@example.com",
    orgRole: "member",
    teamId: TEAM.id,
    teamName: TEAM.name,
    teamRole: "viewer",
    status: "pending",
    expiresAt: "2026-10-18T03:00:00.000Z",
    createdAt: at,
    acceptedAt: null,
  },
  {
    id: "1a1a1a1a-0000-4000-8000-000000000002",
    email: "minh.pham@example.com",
    orgRole: "member",
    teamId: null,
    teamName: null,
    teamRole: null,
    status: "accepted",
    expiresAt: "2026-10-08T03:00:00.000Z",
    createdAt: at,
    acceptedAt: "2026-10-02T03:00:00.000Z",
  },
  {
    id: "1a1a1a1a-0000-4000-8000-000000000003",
    email: "cu@example.com",
    orgRole: "admin",
    teamId: null,
    teamName: null,
    teamRole: null,
    status: "expired",
    expiresAt: "2026-09-20T03:00:00.000Z",
    createdAt: at,
    acceptedAt: null,
  },
];

/** Hub giả có lời mời và người chờ duyệt; thu hồi, duyệt, từ chối đổi dữ liệu thật để trang tải lại thấy kết quả. */
function withInvites(): Record<string, RpcHandler> {
  const base = twoOrgs();
  let invites = [...INVITES];
  const status = new Map<string, string>();
  return {
    ...base,
    "orgMembers/list": (_, call) =>
      ok(orgMembersIn(call.org).map((m) => ({ ...m, status: status.get(m.userId) ?? m.status }))),
    "orgMembers/approve": (input) => {
      const { userId } = input as { userId: string };
      status.set(userId, "active");
      return ok({ userId, role: "member", status: "active" });
    },
    "orgMembers/deny": (input) => {
      const { userId } = input as { userId: string };
      status.set(userId, "blocked");
      return ok({ userId, role: "member", status: "blocked" });
    },
    "invitations/list": () => ok(invites),
    "invitations/revoke": (input) => {
      invites = invites.filter((i) => i.id !== (input as { invitationId: string }).invitationId);
      return ok({ ok: true });
    },
    "invitations/create": (input) => {
      const { emails } = input as { emails: string[] };
      return ok({
        invitations: emails.map((email, i) => ({
          id: `2b2b2b2b-0000-4000-8000-00000000000${i}`,
          email,
          link: `https://hive.example.vn/invite/ma-moi-${i}-0123456789abcdef`,
          expiresAt: "2026-10-18T03:00:00.000Z",
        })),
      });
    },
  };
}

test("thành viên: tab Lời mời thu hồi được, tab Chờ duyệt duyệt và từ chối được", async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_A.id);
  const hub = await fakeHub(page, { signedIn: true, rpc: withInvites() });
  await page.goto("/admin/members");

  await expect(page.getByRole("tab", { name: "Đang hoạt động · 2" })).toHaveAttribute("aria-selected", "true");
  // Người chờ duyệt không nằm trong danh sách chính.
  await expect(page.getByText("khoa.do@example.com")).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Lê Hà/ })).toContainText("quản trị đội");

  await page.getByRole("tab", { name: "Lời mời · 1" }).click();
  await expect(page).toHaveURL("/admin/members?xem=loi-moi");
  const vy = page.getByRole("row", { name: /vy\.ngo@fpt\.com/ });
  await expect(vy).toContainText("Chờ nhận");
  await expect(vy).toContainText("Thanh toán");
  await expect(vy).toContainText("chỉ xem");
  await expect(vy).toContainText("18/10/2026");
  await expect(page.getByRole("row", { name: /minh\.pham@fpt\.com/ })).toContainText("Đã nhận");
  // Lời mời đã dùng thì hub không cho thu hồi.
  await expect(page.getByRole("button", { name: "Thu hồi lời mời cho minh.pham@example.com" })).toHaveCount(0);
  await expect(page.getByRole("row", { name: /cu@fpt\.com/ })).toContainText("Hết hạn");

  await page.getByRole("button", { name: "Thu hồi lời mời cho vy.ngo@example.com" }).click();
  await expect(vy).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Lời mời · 0" })).toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "invitations/revoke")).toMatchObject({
    org: ORG_A.id,
    input: { invitationId: INVITES[0]?.id },
  });

  await page.getByRole("tab", { name: "Chờ duyệt · 1" }).click();
  await expect(page).toHaveURL("/admin/members?xem=cho-duyet");
  const khoa = page.getByRole("row", { name: /Đỗ Khoa/ });
  await expect(khoa).toContainText("Chờ duyệt");
  await page.getByRole("button", { name: "Duyệt Đỗ Khoa" }).click();
  await expect(khoa).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Chờ duyệt · 0" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Đang hoạt động · 3" })).toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "orgMembers/approve")).toMatchObject({
    method: "POST",
    org: ORG_A.id,
    input: { userId: "u3" },
  });

  // Tải lại vẫn ở đúng tab.
  await page.reload();
  await expect(page.getByRole("tab", { name: "Chờ duyệt · 0" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Không có ai đang chờ duyệt.")).toBeVisible();
});

test("từ chối người chờ duyệt: chuyển sang bị khoá trong danh sách chính", async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_A.id);
  const hub = await fakeHub(page, { signedIn: true, rpc: withInvites() });
  await page.goto("/admin/members?xem=cho-duyet");
  await page.getByRole("button", { name: "Từ chối Đỗ Khoa" }).click();
  await expect(page.getByRole("tab", { name: "Chờ duyệt · 0" })).toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "orgMembers/deny")?.input).toEqual({ userId: "u3" });
  await page.getByRole("tab", { name: /Đang hoạt động/ }).click();
  await expect(page.getByRole("row", { name: /Đỗ Khoa/ })).toContainText("Đã khoá");
});

test("mời người: nhiều email, vai trò tổ chức, đội và vai trò đội; link hiện một lần, chép được", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_A.id);
  const hub = await fakeHub(page, { signedIn: true, rpc: withInvites() });
  await page.goto("/admin/members");
  await page.getByRole("button", { name: "Mời người" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Mời người vào tổ chức" })).toBeVisible();
  const emails = dialog.getByLabel("Email");
  await emails.fill("A@example.com, b@example.com\nsai-email");
  await dialog.getByRole("button", { name: "Tạo lời mời" }).click();
  await expect(dialog.getByText("Email không hợp lệ: sai-email.")).toBeVisible();
  await expect(emails).toHaveAttribute("aria-invalid", "true");
  expect(hub.rpcCalls.some((c) => c.path === "invitations/create")).toBe(false);

  await emails.fill("A@example.com, b@example.com\na@example.com");
  // Chủ sở hữu mời được quản trị.
  await dialog.getByLabel("Vai trò tổ chức").selectOption({ label: "Quản trị" });
  await expect(dialog.getByLabel("Vai trò trong đội")).toHaveCount(0);
  await dialog.getByLabel("Thêm vào đội").selectOption({ label: "Thanh toán" });
  await dialog.getByLabel("Vai trò trong đội").selectOption({ label: "Chỉ xem" });
  await dialog.getByRole("button", { name: "Tạo lời mời" }).click();

  await expect(dialog.getByText("Link chỉ hiện một lần")).toBeVisible();
  await expect(dialog.getByText("hết hạn ngày 18/10/2026")).toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "invitations/create")).toMatchObject({
    method: "POST",
    org: ORG_A.id,
    input: { emails: ["a@example.com", "b@example.com"], orgRole: "admin", teamId: TEAM.id, teamRole: "viewer" },
  });
  const linkA = "https://hive.example.vn/invite/ma-moi-0-0123456789abcdef";
  await expect(dialog.getByLabel("Link mời cho a@example.com", { exact: true })).toHaveValue(linkA);
  await expect(dialog.getByLabel("Link mời cho b@example.com", { exact: true })).toHaveValue(
    "https://hive.example.vn/invite/ma-moi-1-0123456789abcdef",
  );
  await dialog.getByRole("button", { name: "Chép link mời cho a@example.com" }).click();
  await expect(dialog.getByRole("button", { name: "Đã chép link mời cho a@example.com" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(linkA);

  // Mời thêm thì về form trống; đóng thì link không còn.
  await dialog.getByRole("button", { name: "Mời thêm" }).click();
  await expect(dialog.getByLabel("Email")).toHaveValue("");
  await dialog.getByRole("button", { name: "Huỷ" }).click();
  await expect(dialog).toBeHidden();
});

test("mời người: lỗi của hub hiện tiếng Việt, quản trị không có lựa chọn mời quản trị", async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_A.id);
  await fakeHub(page, {
    signedIn: true,
    rpc: {
      ...withInvites(),
      "orgs/mine": () => ok({ orgs: [myOrg({ ...ORG_A, role: "admin" })], canCreateOrg: false }),
      "invitations/create": () =>
        fail("BAD_REQUEST", 400, "Dữ liệu không hợp lệ ở trường emails.1: Email không hợp lệ.", {
          issues: [{ path: ["emails", 1], message: "Email không hợp lệ." }],
        }),
    },
  });
  await page.goto("/admin/members");
  await page.getByRole("button", { name: "Mời người" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Vai trò tổ chức").locator("option")).toHaveText(["Thành viên"]);
  await dialog.getByLabel("Email").fill("a@example.com, b@example.vn");
  await dialog.getByRole("button", { name: "Tạo lời mời" }).click();
  await expect(dialog.getByText("Email không hợp lệ.", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
});

test("thành viên thường: không thấy nút Mời người, tab Lời mời, Chờ duyệt và mục Đăng nhập", async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_B.id);
  const hub = await fakeHub(page, { signedIn: true, rpc: withInvites() });
  await page.goto("/admin/members?xem=loi-moi");

  await expect(page.getByRole("tab", { name: "Đang hoạt động · 2" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Mời người" })).toHaveCount(0);
  const nav = page.getByRole("navigation", { name: "Điều hướng chính" });
  await expect(nav.getByText("Đăng nhập")).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Thành viên" })).toHaveAttribute("aria-current", "page");
  expect(hub.rpcCalls.some((c) => c.path === "invitations/list")).toBe(false);

  await page.goto("/admin/sign-in-settings");
  await expect(page.getByText("Chỉ quản trị tổ chức xem và sửa được cài đặt đăng nhập.")).toBeVisible();
  expect(hub.rpcCalls.some((c) => c.path === "ssoProviders/get")).toBe(false);
});

test("đội: quản trị tổ chức mời người mới từ hộp thoại Thêm người, đội chọn sẵn", async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_A.id);
  const hub = await fakeHub(page, { signedIn: true, rpc: withInvites() });
  await page.goto("/admin/teams");
  await page.getByRole("button", { name: "Thêm người" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "mời bằng email" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Mời người vào tổ chức" })).toBeVisible();
  await expect(dialog.getByLabel("Thêm vào đội")).toHaveValue(TEAM.id);
  await expect(dialog.getByLabel("Vai trò trong đội")).toHaveValue("member");
  await dialog.getByLabel("Email").fill("moi@example.com");
  await dialog.getByRole("button", { name: "Tạo lời mời" }).click();
  await expect(dialog.getByLabel("Link mời cho moi@example.com", { exact: true })).toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "invitations/create")?.input).toEqual({
    emails: ["moi@example.com"],
    orgRole: "member",
    teamId: TEAM.id,
    teamRole: "member",
  });
});

const SSO_NONE = {
  providerId: `org-${ORG_A.id}`,
  callbackUrl: `https://hive.example.vn/api/auth/sso/callback/org-${ORG_A.id}`,
  join: "pending",
  provider: null,
};

test("cài đặt đăng nhập: cấu hình SSO lần đầu, chép callback URL, chọn chính sách người mới", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_A.id);
  let settings: unknown = SSO_NONE;
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      ...twoOrgs(),
      "orgs/mine": () => ok({ orgs: [{ ...myOrg(ORG_A), emailDomain: "example.com" }], canCreateOrg: false }),
      "ssoProviders/get": () => ok(settings),
      "ssoProviders/upsert": (input) => {
        const i = input as { issuer: string; domain: string; clientId: string; join: string };
        settings = {
          ...SSO_NONE,
          join: i.join,
          provider: { issuer: i.issuer, domain: i.domain, clientIdLastFour: i.clientId.slice(-4) },
        };
        return ok(settings);
      },
    },
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Điều hướng chính" }).getByRole("link", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/admin/sign-in-settings");

  const methods = page.getByRole("list", { name: "Các cách đăng nhập" });
  await expect(methods.getByRole("listitem").filter({ hasText: "SSO (OIDC)" })).toContainText("Chưa cấu hình");
  await expect(methods.getByRole("listitem").filter({ hasText: "GitHub" })).toContainText("Cấu hình ở hub");
  // Tên miền điền sẵn từ tên miền email của tổ chức.
  await expect(page.getByLabel("Tên miền email")).toHaveValue("example.com");

  const callback = page.getByLabel("Callback URL (dán vào cấu hình app bên nhà cung cấp)");
  await expect(callback).toHaveValue(SSO_NONE.callbackUrl);
  await page.getByRole("button", { name: "Chép callback URL" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SSO_NONE.callbackUrl);

  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Nhập Issuer URL dạng https://")).toBeVisible();
  await expect(page.getByText("Nhập Client ID.")).toBeVisible();
  await expect(page.getByText("Nhập Client secret khi cấu hình SSO lần đầu.")).toBeVisible();
  expect(hub.rpcCalls.some((c) => c.path === "ssoProviders/upsert")).toBe(false);

  await page.getByLabel("Issuer URL").fill("https://login.microsoftonline.com/3f2a/v2.0");
  await page.getByLabel("Client ID").fill("8c1d5e2a-abcd");
  await page.getByLabel("Client secret").fill("bi-mat-cua-idp");
  await page.getByLabel("Khi người mới đăng nhập SSO lần đầu").selectOption({
    label: "Tự thêm vào tổ chức với vai trò Thành viên, chưa thuộc đội nào",
  });
  await page.getByRole("button", { name: "Lưu" }).click();

  await expect(page.getByText("Đã lưu cấu hình SSO.")).toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "ssoProviders/upsert")).toMatchObject({
    method: "PUT",
    org: ORG_A.id,
    input: {
      issuer: "https://login.microsoftonline.com/3f2a/v2.0",
      domain: "example.com",
      clientId: "8c1d5e2a-abcd",
      clientSecret: "bi-mat-cua-idp",
      join: "member",
    },
  });
  await expect(methods.getByRole("listitem").filter({ hasText: "SSO (OIDC)" })).toContainText("Đang bật");
  await expect(methods).toContainText("login.microsoftonline.com · example.com");
  // Secret chỉ ghi: lưu xong thì ô trống, hub không trả secret về.
  await expect(page.getByLabel("Client secret")).toHaveValue("");
  await expect(page.getByText("Để trống nếu không đổi.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Gỡ SSO" })).toBeVisible();
});

test("cài đặt đăng nhập: sửa SSO không gửi secret khi để trống, lỗi của hub gắn vào ô Issuer", async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_A.id);
  const configured = {
    ...SSO_NONE,
    provider: { issuer: "https://idp.example.com", domain: "example.com", clientIdLastFour: "ab12" },
  };
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      ...twoOrgs(),
      "ssoProviders/get": () => ok(configured),
      "ssoProviders/upsert": () =>
        fail("BAD_REQUEST", 400, "Không đọc được cấu hình OIDC từ Issuer URL. Chi tiết: Discovery endpoint not found", {
          code: "SSO_DISCOVERY_FAILED",
        }),
    },
  });
  await page.goto("/admin/sign-in-settings");
  await expect(page.getByLabel("Issuer URL")).toHaveValue("https://idp.example.com");
  await expect(page.getByText("Đang dùng Client ID kết thúc bằng ab12. Nhập lại khi lưu.")).toBeVisible();
  await page.getByLabel("Issuer URL").fill("https://idp-moi.example.com");
  await page.getByLabel("Client ID").fill("client-ab12");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText(/Không đọc được cấu hình OIDC từ Issuer URL/)).toBeVisible();
  await expect(page.getByLabel("Issuer URL")).toHaveAttribute("aria-invalid", "true");
  expect(hub.rpcCalls.find((c) => c.path === "ssoProviders/upsert")?.input).toEqual({
    issuer: "https://idp-moi.example.com",
    domain: "example.com",
    clientId: "client-ab12",
    join: "pending",
  });
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
  await page.goto("/admin/members");
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
  for (const path of ["/orgs/new", "/admin/teams", "/admin/members", "/admin/sign-in-settings"]) {
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
  await expect(page).toHaveURL("/orgs/new");
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
