import { expect, test } from "@playwright/test";
import { fakeHub, ok, USER } from "./fake-hub.ts";

test("chưa đăng nhập: chuyển về /login; hub chưa cấu hình gì thì chỉ có email và mật khẩu", async ({ page }) => {
  const hub = await fakeHub(page, {
    rpc: {
      "hubSetup/get": () => ok({ firstAdminSignUp: false, loginMethods: { sso: false, github: false, gitlab: false } }),
    },
  });
  await page.goto("/projects/abc");
  await expect(page).toHaveURL("/login?redirect=%2Fprojects%2Fabc");
  expect(hub.meMethods).toContain("GET");

  await expect(page.getByRole("heading", { name: "Đăng nhập" })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Mật khẩu", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Đăng nhập", exact: true })).toBeVisible();
  await expect(page.getByText("Dùng email và mật khẩu.")).toBeVisible();
  await expect(page.getByLabel("Email công ty")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "GitHub" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "GitLab" })).toHaveCount(0);
  await expect(page.getByText("hoặc", { exact: true })).toHaveCount(0);
});

test("hub đã cấu hình SSO và GitHub: hiện thêm đúng hai cách đó dưới email và mật khẩu", async ({ page }) => {
  await fakeHub(page, {
    rpc: {
      "hubSetup/get": () => ok({ firstAdminSignUp: false, loginMethods: { sso: true, github: true, gitlab: false } }),
    },
  });
  await page.goto("/login");
  await expect(page.getByLabel("Mật khẩu", { exact: true })).toBeVisible();
  await expect(page.getByText("Dùng email và mật khẩu, hoặc SSO, GitHub.")).toBeVisible();
  await expect(page.getByLabel("Email công ty")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tiếp tục với SSO" })).toBeVisible();
  await expect(page.getByRole("button", { name: "GitHub" })).toBeVisible();
  await expect(page.getByRole("button", { name: "GitLab" })).toHaveCount(0);
});

test("SSO: gọi sign-in/sso theo tên miền rồi chuyển sang trang của IdP", async ({ page }) => {
  const hub = await fakeHub(page, {
    auth: {
      "/sign-in/sso": () => ({ status: 200, json: { url: "https://idp.example.test/authorize", redirect: true } }),
    },
  });
  await page.route("https://idp.example.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "IdP giả" }),
  );
  await page.goto("/login");
  await page.getByLabel("Email công ty").fill("Duy@Example.COM");
  await page.getByRole("button", { name: "Tiếp tục với SSO" }).click();
  await expect(page).toHaveURL("https://idp.example.test/authorize");
  expect(hub.authCalls).toEqual([
    {
      path: "/sign-in/sso",
      body: { domain: "example.com", loginHint: "Duy@Example.COM", callbackURL: "/", errorCallbackURL: "/login" },
    },
  ]);
});

test("SSO: báo lỗi tiếng Việt khi email sai và khi tên miền chưa có SSO", async ({ page }) => {
  await fakeHub(page, {
    auth: { "/sign-in/sso": () => ({ status: 404, json: { message: "No provider found for the issuer" } }) },
  });
  await page.goto("/login");
  const email = page.getByLabel("Email công ty");
  await page.getByRole("button", { name: "Tiếp tục với SSO" }).click();
  await expect(page.getByText("Nhập email công ty, ví dụ ten@congty.vn.")).toBeVisible();
  await expect(email).toHaveAttribute("aria-invalid", "true");

  await email.fill("an@khong-co-sso.vn");
  await page.getByRole("button", { name: "Tiếp tục với SSO" }).click();
  await expect(page.getByText(/Chưa có SSO cho tên miền email này/)).toBeVisible();
});

test("GitHub chưa bật trên hub thì báo rõ", async ({ page }) => {
  const hub = await fakeHub(page, {
    auth: {
      "/sign-in/social": () => ({ status: 404, json: { code: "PROVIDER_NOT_FOUND", message: "Provider not found" } }),
    },
  });
  await page.goto("/login");
  await page.getByRole("button", { name: "GitHub" }).click();
  await expect(page.getByRole("alert")).toHaveText(/Hub chưa bật cách đăng nhập này/);
  expect(hub.authCalls[0]?.body).toMatchObject({ provider: "github", callbackURL: "/" });
});

test("lỗi hub gửi về qua ?error= sau OAuth hiện bằng tiếng Việt", async ({ page }) => {
  await fakeHub(page);
  await page.goto("/login?error=access_denied");
  await expect(page.getByRole("alert")).toHaveText("Bạn đã huỷ hoặc chưa cấp quyền ở trang của nhà cung cấp.");
});

test("email: sai mật khẩu báo lỗi, đúng thì vào trang chủ", async ({ page }) => {
  await fakeHub(page, {
    auth: {
      "/sign-in/email": (body, hub) => {
        if ((body as { password: string }).password !== "mat-khau-dung-123") {
          return { status: 401, json: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" } };
        }
        hub.signedIn = true;
        return { status: 200, json: { redirect: false, token: "t", user: USER } };
      },
    },
  });
  await page.goto("/");
  await expect(page).toHaveURL("/login");
  await page.getByLabel("Email", { exact: true }).fill(USER.email);
  await page.getByLabel("Mật khẩu", { exact: true }).fill("sai-mat-khau");
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Email hoặc mật khẩu không đúng.");

  await page.getByLabel("Mật khẩu", { exact: true }).fill("mat-khau-dung-123");
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: `Chào ${USER.name}` })).toBeVisible();
});

test("hub không trả lời thì hiện màn lỗi có nút thử lại", async ({ page }) => {
  await page.route("**/rpc/me/get**", (route) => route.abort("connectionrefused"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Không kết nối được hub" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Thử lại" })).toBeVisible();
});

test("hub chưa có tổ chức: form tạo quản trị đầu tiên, từ chối email ngoài danh sách rồi tạo được", async ({
  page,
}) => {
  const hub = await fakeHub(page, {
    rpc: {
      "hubSetup/get": () => ok({ firstAdminSignUp: true, loginMethods: { sso: false, github: false, gitlab: false } }),
    },
    auth: {
      "/sign-up/email": (body, hub) => {
        if ((body as { email: string }).email !== USER.email) {
          return { status: 403, json: { code: "SIGN_UP_INVITE_REQUIRED", message: "Invite required" } };
        }
        hub.signedIn = true;
        return { status: 200, json: { token: "t", user: USER } };
      },
    },
  });
  await page.goto("/login");
  const form = page.getByRole("region", { name: "Tạo tài khoản quản trị đầu tiên" });
  await expect(form).toBeVisible();

  await form.getByLabel("Tên hiển thị").fill(USER.name);
  await form.getByLabel("Email").fill(USER.email);
  await form.getByLabel("Mật khẩu").fill("ngan");
  await form.getByRole("button", { name: "Tạo tài khoản quản trị" }).click();
  await expect(form.getByRole("alert")).toHaveText("Mật khẩu cần ít nhất 10 ký tự.");
  expect(hub.authCalls.filter((c) => c.path === "/sign-up/email")).toHaveLength(0);

  await form.getByLabel("Email").fill("nguoi-khac@example.com");
  await form.getByLabel("Mật khẩu").fill("mat-khau-quan-tri-123");
  await form.getByRole("button", { name: "Tạo tài khoản quản trị" }).click();
  await expect(form.getByRole("alert")).toContainText("Dùng đúng email đã khai khi cài hub");

  await form.getByLabel("Email").fill(USER.email);
  await form.getByRole("button", { name: "Tạo tài khoản quản trị" }).click();
  await expect(page).toHaveURL("/");
  expect(hub.authCalls.filter((c) => c.path === "/sign-up/email").at(-1)?.body).toEqual({
    name: USER.name,
    email: USER.email,
    password: "mat-khau-quan-tri-123",
  });
});

test("hub đã có tổ chức: không hiện form tạo quản trị", async ({ page }) => {
  await fakeHub(page);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Đăng nhập" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Tạo tài khoản quản trị đầu tiên" })).toHaveCount(0);
});
