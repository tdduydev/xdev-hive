import { expect, test } from "@playwright/test";
import { fail, fakeHub, ok, USER } from "./fake-hub.ts";

const TOKEN = "7Hk2pQ9xLm4vRt8sWb3nZc6yJd1fGh5kAe0uIo2qXy4";
const ORG = {
  id: "0a0a0a0a-0000-4000-8000-00000000000a",
  slug: "fpt-xdev",
  name: "FPT Software xDev",
  emailDomain: "fpt.com",
  createdAt: "2026-10-01T03:00:00.000Z",
  role: "member",
};
const preview = (over: object = {}) =>
  ok({ orgName: ORG.name, email: USER.email, status: "pending", expiresAt: "2026-10-18T03:00:00.000Z", ...over });

test("chưa đăng nhập: xem trước lời mời, đăng ký bằng email kèm mã mời rồi vào tổ chức", async ({ page }) => {
  const hub = await fakeHub(page, {
    auth: {
      "/sign-up/email": (_, h) => {
        h.signedIn = true;
        return { status: 200, json: { token: "t", user: USER } };
      },
    },
    rpc: {
      "invitations/preview": () => preview(),
      "orgs/mine": (_, __, h) => ok({ orgs: h.signedIn ? [ORG] : [], canCreateOrg: false }),
    },
  });
  await page.goto(`/moi/${TOKEN}`);

  // Trang lời mời mở được khi chưa đăng nhập.
  await expect(page).toHaveURL(`/moi/${TOKEN}`);
  await expect(page.getByRole("heading", { name: `Lời mời vào ${ORG.name}` })).toBeVisible();
  await expect(page.getByText(USER.email).first()).toBeVisible();
  await expect(page.getByText("Dùng trước ngày 18/10/2026, một lần")).toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "invitations/preview")).toMatchObject({
    method: "POST",
    org: undefined,
    input: { token: TOKEN },
  });

  // Email cố định theo lời mời; kiểm tên và mật khẩu trên máy trước khi gửi.
  await expect(page.getByLabel("Email")).toHaveValue(USER.email);
  await expect(page.getByLabel("Email")).toHaveAttribute("readonly");
  await page.getByLabel("Mật khẩu").fill("ngan");
  await page.getByRole("button", { name: "Tạo tài khoản và vào tổ chức" }).click();
  await expect(page.getByText("Nhập họ và tên.")).toBeVisible();
  await expect(page.getByText("Mật khẩu cần ít nhất 10 ký tự.")).toBeVisible();
  expect(hub.authCalls).toEqual([]);

  await page.getByLabel("Họ và tên").fill(USER.name);
  await page.getByLabel("Mật khẩu").fill("mat-khau-du-dai");
  await page.getByRole("button", { name: "Tạo tài khoản và vào tổ chức" }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: ORG.name })).toBeVisible();
  expect(hub.authCalls).toEqual([
    {
      path: "/sign-up/email",
      body: { name: USER.name, email: USER.email, password: "mat-khau-du-dai", inviteToken: TOKEN },
    },
  ]);
  // Hub đã tự nhận lời mời lúc đăng ký nên không gọi accept nữa.
  expect(hub.rpcCalls.some((c) => c.path === "invitations/accept")).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem("hive.org"))).toBe(ORG.id);
});

for (const [name, token, reply, title, text] of [
  [
    "mã sai hoặc đã thu hồi",
    "ma-khong-co-trong-hub-0123456789",
    fail("NOT_FOUND", 404, "Không tìm thấy lời mời. Link có thể sai hoặc đã bị thu hồi.", { code: "INVITE_NOT_FOUND" }),
    "Không tìm thấy lời mời",
    "Không tìm thấy lời mời. Link có thể sai hoặc đã bị thu hồi.",
  ],
  ["hết hạn", TOKEN, preview({ status: "expired" }), "Lời mời đã hết hạn", "đã hết hạn ngày 18/10/2026"],
  ["đã dùng", TOKEN, preview({ status: "accepted" }), "Lời mời đã được dùng", "Mỗi link chỉ dùng được một lần"],
] as const) {
  test(`lời mời ${name}: báo rõ, không cho đăng ký`, async ({ page }) => {
    await fakeHub(page, { rpc: { "invitations/preview": () => reply } });
    await page.goto(`/moi/${token}`);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByText(text)).toBeVisible();
    await expect(page.getByRole("button", { name: "Tạo tài khoản và vào tổ chức" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Đăng nhập" })).toBeVisible();
  });
}

test("link thiếu ký tự: báo ngay, không hỏi hub", async ({ page }) => {
  const hub = await fakeHub(page);
  await page.goto("/moi/abc");
  await expect(page.getByRole("heading", { name: "Link mời không hợp lệ" })).toBeVisible();
  expect(hub.rpcCalls.some((c) => c.path === "invitations/preview")).toBe(false);
});

test("đăng ký lỗi: email đã có tài khoản thì báo tiếng Việt và chỉ sang đăng nhập", async ({ page }) => {
  await fakeHub(page, {
    auth: {
      "/sign-up/email": () => ({
        status: 422,
        json: { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", message: "User already exists. Use another email." },
      }),
    },
    rpc: { "invitations/preview": () => preview() },
  });
  await page.goto(`/moi/${TOKEN}`);
  await page.getByLabel("Họ và tên").fill(USER.name);
  await page.getByLabel("Mật khẩu").fill("mat-khau-du-dai");
  await page.getByRole("button", { name: "Tạo tài khoản và vào tổ chức" }).click();
  await expect(page.getByRole("alert")).toHaveText("Email này đã có tài khoản trên hub. Đăng nhập để nhận lời mời.");

  await page.getByRole("link", { name: "Đã có tài khoản: đăng nhập để nhận lời mời" }).click();
  await expect(page).toHaveURL(`/dang-nhap?redirect=${encodeURIComponent(`/moi/${TOKEN}`)}`);
});

test("đã đăng nhập đúng email: nhận lời mời rồi vào tổ chức", async ({ page }) => {
  let joined = false;
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      "invitations/preview": () => preview({ email: USER.email.toUpperCase() }),
      "invitations/accept": () => {
        joined = true;
        return ok(ORG);
      },
      "orgs/mine": () => ok({ orgs: joined ? [ORG] : [], canCreateOrg: false }),
    },
  });
  await page.goto(`/moi/${TOKEN}`);
  await expect(page.getByText(`Bạn đang đăng nhập bằng ${USER.email}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Tạo tài khoản và vào tổ chức" })).toHaveCount(0);
  await page.getByRole("button", { name: "Nhận lời mời và vào tổ chức" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: ORG.name })).toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "invitations/accept")).toMatchObject({
    org: undefined,
    input: { token: TOKEN },
  });
});

test("nhận lời mời bị hub từ chối: hiện câu tiếng Việt của hub", async ({ page }) => {
  await fakeHub(page, {
    signedIn: true,
    rpc: {
      "invitations/preview": () => preview(),
      "invitations/accept": () =>
        fail("FORBIDDEN", 403, "Tài khoản của bạn đang bị khoá trong tổ chức này.", { code: "MEMBER_BLOCKED" }),
    },
  });
  await page.goto(`/moi/${TOKEN}`);
  await page.getByRole("button", { name: "Nhận lời mời và vào tổ chức" }).click();
  await expect(page.getByRole("alert")).toHaveText("Tài khoản của bạn đang bị khoá trong tổ chức này.");
  await expect(page).toHaveURL(`/moi/${TOKEN}`);
});

test("đã đăng nhập bằng email khác: báo sai email, đăng xuất để đăng ký bằng đúng email", async ({ page }) => {
  const hub = await fakeHub(page, {
    signedIn: true,
    auth: {
      "/sign-out": (_, h) => {
        h.signedIn = false;
        return { status: 200, json: { success: true } };
      },
    },
    rpc: { "invitations/preview": () => preview({ email: "vy.ngo@fpt.com" }) },
  });
  await page.goto(`/moi/${TOKEN}`);
  await expect(page.getByRole("alert")).toContainText(
    `Lời mời này dành cho vy.ngo@fpt.com, nhưng bạn đang đăng nhập bằng ${USER.email}.`,
  );
  await expect(page.getByRole("button", { name: "Nhận lời mời và vào tổ chức" })).toHaveCount(0);

  await page.getByRole("button", { name: "Đăng xuất" }).click();
  await expect(page.getByLabel("Email")).toHaveValue("vy.ngo@fpt.com");
  await expect(page).toHaveURL(`/moi/${TOKEN}`);
  expect(hub.authCalls.map((c) => c.path)).toEqual(["/sign-out"]);
});
