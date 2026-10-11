import { expect, test } from "@playwright/test";
import { fakeHub, USER } from "./fake-hub.ts";

test("chưa đăng nhập: trang khác chuyển về /login và hiện đủ ba cách đăng nhập", async ({ page }) => {
  const hub = await fakeHub(page);
  await page.goto("/projects/abc");
  await expect(page).toHaveURL("/login?redirect=%2Fprojects%2Fabc");
  expect(hub.meMethods).toContain("GET");

  await expect(page.getByRole("heading", { name: "Đăng nhập" })).toBeVisible();
  // SSO
  await expect(page.getByLabel("Email công ty")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tiếp tục với SSO" })).toBeVisible();
  // GitHub, GitLab
  await expect(page.getByRole("button", { name: "GitHub" })).toBeVisible();
  await expect(page.getByRole("button", { name: "GitLab" })).toBeVisible();
  // Email + mật khẩu: ẩn tới khi bấm mở
  const password = page.getByLabel("Mật khẩu");
  await expect(password).toBeHidden();
  await page.getByText("Đăng nhập bằng email và mật khẩu").click();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(password).toBeVisible();
  await expect(page.getByRole("button", { name: "Đăng nhập", exact: true })).toBeVisible();
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
  await page.getByLabel("Email công ty").fill("Duy@example.com");
  await page.getByRole("button", { name: "Tiếp tục với SSO" }).click();
  await expect(page).toHaveURL("https://idp.example.test/authorize");
  expect(hub.authCalls).toEqual([
    {
      path: "/sign-in/sso",
      body: { domain: "example.com", loginHint: "Duy@example.com", callbackURL: "/", errorCallbackURL: "/login" },
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
  await page.getByText("Đăng nhập bằng email và mật khẩu").click();
  await page.getByLabel("Email", { exact: true }).fill(USER.email);
  await page.getByLabel("Mật khẩu").fill("sai-mat-khau");
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Email hoặc mật khẩu không đúng.");

  await page.getByLabel("Mật khẩu").fill("mat-khau-dung-123");
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
