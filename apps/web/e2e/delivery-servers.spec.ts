import { expect, type Page, test } from "@playwright/test";
import {
  deliveryServersFixture,
  ENV_DEV_ID,
  ENV_PROD_ID,
  FAKE_SECRET,
  FINGERPRINT,
  JENKINS_ID,
  PROJECT_API_ID,
  RUNNER_A_ID,
  RUNNER_B_ID,
  SERVER_PROD_ID,
  SERVER_STAGING_ID,
  SERVERS_SYSTEM_ID,
  SERVERS_TEAM2_ID,
} from "./delivery-servers-fixture.ts";
import { inOrg } from "./reviews-fixture.ts";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.setViewportSize({ width: 360, height: 780 });
});

const row = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function pickRowAction(page: Page, name: string, item: string) {
  await page.getByRole("button", { name: `Thao tác khác cho máy chủ ${name}` }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test("danh sách máy chủ nhóm theo đội; thêm máy chủ rồi chép khoá và lệnh cài", async ({ page }) => {
  const fixture = deliveryServersFixture();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/admin/servers");
  await expect(page.getByRole("heading", { name: "Máy chủ", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Thanh toán", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hạ tầng", exact: true })).toBeVisible();
  await expect(row(page, "app-staging")).toContainText("deploy@staging.example.com:22");
  await expect(row(page, "app-staging")).toContainText("Chưa xác nhận dấu vân tay");
  await expect(row(page, "app-prod")).toContainText("Đã xác nhận dấu vân tay");
  await noHorizontalScroll(page);

  await page.getByRole("button", { name: "Thêm máy chủ cho đội Hạ tầng", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Thêm máy chủ" });
  await dialog.getByLabel("Tên", { exact: true }).fill("app-infra");
  await dialog.getByLabel("Địa chỉ").fill("infra.example.com");
  await dialog.getByLabel("User SSH").fill("deploy");
  await dialog.getByLabel("Nhãn").fill("infra, docker");
  await dialog.getByRole("button", { name: "Lưu", exact: true }).click();

  const key = page.getByRole("dialog", { name: /Khoá SSH của app-infra/ });
  await expect(key).toBeVisible();
  await expect(key.getByRole("button", { name: "Chép khoá công khai", exact: true })).toBeVisible();
  await expect(key.getByRole("button", { name: "Chép lệnh cài khoá", exact: true })).toBeVisible();
  expect(fixture.state.calls.findLast((c) => c.path === "servers/create")?.input).toMatchObject({
    teamId: SERVERS_TEAM2_ID,
    port: 22,
    labels: ["infra", "docker"],
  });
});

test("Kiểm kết nối lần đầu: xác nhận dấu vân tay rồi kiểm lại", async ({ page }) => {
  const fixture = deliveryServersFixture();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/admin/servers");
  await page.getByRole("button", { name: "Kiểm kết nối app-staging", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Chưa xác nhận dấu vân tay của máy chủ" })).toBeVisible();

  await page.getByRole("button", { name: "Xác nhận dấu vân tay của app-staging", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(FINGERPRINT);
  await dialog.getByRole("button", { name: "Xác nhận dấu vân tay này", exact: true }).click();
  await expect(dialog).toBeHidden();

  const status = page.getByRole("status").filter({ hasText: "Kết nối được" });
  await expect(status).toContainText("Ubuntu 24.04");
  expect(fixture.state.calls.filter((c) => c.path === "servers/test")).toHaveLength(2);
  expect(fixture.state.calls.find((c) => c.path === "servers/confirmHostKey")?.input).toEqual({
    id: SERVER_STAGING_ID,
    fingerprint: FINGERPRINT,
  });
});

test("lỗi kiểm kết nối: mỗi loại một câu tiếng Việt", async ({ page }) => {
  const fixture = deliveryServersFixture();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/admin/servers");
  const check = page.getByRole("button", { name: "Kiểm kết nối app-prod", exact: true });

  fixture.state.nextTest = { result: "error", kind: "network", message: "ETIMEDOUT" };
  await check.click();
  await expect(page.getByRole("alert")).toContainText("Hub không kết nối được máy chủ.");

  fixture.state.nextTest = { result: "error", kind: "auth", message: "denied" };
  await check.click();
  await expect(page.getByRole("alert")).toContainText("Máy chủ không nhận khoá SSH của hub.");

  fixture.state.nextTest = { result: "error", kind: "hostkey_changed", message: "changed", fingerprint: "SHA256:x" };
  await check.click();
  await expect(page.getByRole("alert")).toContainText("Host key của máy chủ đã đổi. Hub dừng, không chạy lệnh nào.");
});

test("đổi khoá hai bước: sinh khoá mới rồi kiểm và thay", async ({ page }) => {
  const fixture = deliveryServersFixture();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/admin/servers");
  await pickRowAction(page, "app-prod", "Đổi khoá…");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Sinh khoá mới", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Chép khoá công khai mới", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Kiểm khoá mới và thay", exact: true }).click();
  await expect(row(page, "app-prod")).not.toContainText("Đang đổi khoá");
  expect(fixture.state.servers.find((s) => s.id === SERVER_PROD_ID)?.publicKey).toMatch(/FAKEKEY90/);
});

test("bàn phím: Enter trên nút Kiểm kết nối chạy kiểm", async ({ page }) => {
  const fixture = deliveryServersFixture();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/admin/servers");
  const check = page.getByRole("button", { name: "Kiểm kết nối app-prod", exact: true });
  await check.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Thao tác khác cho máy chủ app-prod" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Kết nối được" })).toBeVisible();
});

test("môi trường: thêm và sắp thứ tự", async ({ page }) => {
  const fixture = deliveryServersFixture();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto(`/systems/${SERVERS_SYSTEM_ID}/environments`);
  await expect(row(page, "prod").first()).toContainText("1 người duyệt");
  await noHorizontalScroll(page);

  await page.getByRole("button", { name: "Thêm môi trường", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Tên", { exact: true }).fill("staging");
  await dialog.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.state.calls.findLast((c) => c.path === "environments/create")?.input).toMatchObject({
    name: "staging",
  });

  await page.getByRole("button", { name: "Đưa staging lên trước", exact: true }).click();
  await expect.poll(() => fixture.state.envs.find((e) => e.name === "staging")?.position).toBe(1);
});

test("môi trường: chọn máy chạy deploy theo thứ tự ưu tiên", async ({ page }) => {
  const fixture = deliveryServersFixture();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto(`/systems/${SERVERS_SYSTEM_ID}/environments`);
  await expect(row(page, "prod").first()).toContainText("máy nào của đội cũng được");

  await page.getByRole("button", { name: "Chọn máy chạy cho prod", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Credential: jenkins-ci, argocd-prod")).toBeVisible();
  await dialog.getByRole("button", { name: "Chọn máy runner-hn-01", exact: true }).click();
  await dialog.getByRole("button", { name: "Chọn máy runner-hcm-02", exact: true }).click();
  await dialog.getByRole("button", { name: "Đưa máy runner-hcm-02 lên trước", exact: true }).click();
  await dialog.getByLabel("Chỉ máy có nhãn deploy-runner").check();
  await dialog.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(dialog).toBeHidden();

  expect(fixture.state.calls.findLast((c) => c.path === "environments/setRunner")?.input).toEqual({
    id: ENV_PROD_ID,
    runner: { mode: "worker", machines: [RUNNER_B_ID, RUNNER_A_ID], requireLabel: true },
  });
  await expect(row(page, "prod").first()).toContainText("2 máy đã chọn, cần nhãn deploy-runner");
  await noHorizontalScroll(page);
});

test("môi trường: khoá cần lý do, hiện người khoá và lý do, rồi mở khoá", async ({ page }) => {
  const fixture = deliveryServersFixture();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto(`/systems/${SERVERS_SYSTEM_ID}/environments`);

  await page.getByRole("button", { name: "Khoá môi trường prod", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Khoá môi trường prod" });
  await dialog.getByRole("button", { name: "Khoá", exact: true }).click();
  await expect(dialog.getByText("Ghi lý do khoá môi trường.")).toBeVisible();
  expect(fixture.state.calls.some((c) => c.path === "environments/lock")).toBe(false);

  await dialog.getByLabel("Lý do").fill("Đóng băng cuối năm");
  await dialog.getByRole("button", { name: "Khoá", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.state.calls.findLast((c) => c.path === "environments/lock")?.input).toEqual({
    id: ENV_PROD_ID,
    reason: "Đóng băng cuối năm",
  });
  await expect(row(page, "prod").first()).toContainText("Đã khoá");
  await expect(row(page, "prod").first()).toContainText("Quản trị khoá: Đóng băng cuối năm");
  await noHorizontalScroll(page);

  await page.getByRole("button", { name: "Mở khoá môi trường prod", exact: true }).click();
  await expect(page.getByRole("button", { name: "Khoá môi trường prod", exact: true })).toBeVisible();
  expect(fixture.state.calls.findLast((c) => c.path === "environments/unlock")?.input).toEqual({ id: ENV_PROD_ID });
  await expect(row(page, "prod").first()).not.toContainText("Đã khoá");
});

test("đích Jenkins: ghi tên credential trên máy chạy", async ({ page }) => {
  const fixture = deliveryServersFixture();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto(`/systems/${SERVERS_SYSTEM_ID}/environments`);
  await page.getByRole("button", { name: "Thêm đích Api ở dev", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Cách triển khai").selectOption("jenkins-job");
  await dialog.getByLabel("Kết nối", { exact: true }).selectOption(JENKINS_ID);
  await dialog.getByLabel("Đường dẫn job Jenkins").fill("api/deploy-dev");
  await dialog.getByLabel("Credential trên máy chạy").fill("jenkins-ci");
  await dialog.getByRole("button", { name: "Lưu đích", exact: true }).click();
  await expect(dialog).toBeHidden();

  const sent = fixture.state.calls.findLast((c) => c.path === "deployTargets/upsert")?.input as {
    config: Record<string, unknown>;
  };
  expect(sent.config).toMatchObject({ method: "jenkins-job", connectionId: JENKINS_ID, credential: "jenkins-ci" });
});

test("đích: mẫu Hub xDev Hive, biến bí mật chỉ ghi", async ({ page }) => {
  const fixture = deliveryServersFixture();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto(`/systems/${SERVERS_SYSTEM_ID}/environments`);
  await noHorizontalScroll(page);

  await page.getByRole("button", { name: "Thêm đích Api ở dev", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Mẫu").selectOption({ label: "Hub xDev Hive (docker compose)" });
  await dialog
    .getByLabel("Máy chủ", { exact: true })
    .selectOption({ label: "app-staging (deploy@staging.example.com)" });
  await dialog.getByRole("button", { name: "Thêm biến", exact: true }).click();
  await dialog.getByLabel("Tên biến").last().fill("API_TOKEN");
  await dialog.getByLabel("Bí mật").last().check();
  await dialog.getByLabel("Giá trị", { exact: true }).last().fill(FAKE_SECRET);
  await dialog.getByRole("button", { name: "Lưu đích", exact: true }).click();
  await expect(dialog).toBeHidden();

  const sent = fixture.state.calls.findLast((c) => c.path === "deployTargets/upsert")?.input as {
    projectId: string;
    expectedConfigVersion: number | null;
    config: { method: string; serverId: string; variables: unknown[] };
  };
  expect(sent.projectId).toBe(PROJECT_API_ID);
  expect(sent.expectedConfigVersion).toBeNull();
  expect(sent.config).toMatchObject({ method: "ssh-script", serverId: SERVER_STAGING_ID });
  expect(sent.config.variables).toContainEqual({ name: "API_TOKEN", secret: true, value: FAKE_SECRET });

  await page.getByRole("button", { name: "Sửa đích Api ở dev", exact: true }).click();
  const edit = page.getByRole("dialog");
  await expect(edit.getByText("Đã lưu. Bỏ trống để giữ giá trị này.")).toBeVisible();
  expect(await edit.innerHTML()).not.toContain(FAKE_SECRET);
});

test("đích bị người khác sửa: báo xung đột và tải cấu hình mới", async ({ page }) => {
  const fixture = deliveryServersFixture();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto(`/systems/${SERVERS_SYSTEM_ID}/environments`);
  await page.getByRole("button", { name: "Sửa đích Web ở dev", exact: true }).click();
  const dialog = page.getByRole("dialog");
  fixture.state.conflictNext = true;
  await dialog.getByRole("button", { name: "Lưu đích", exact: true }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "vừa được người khác sửa" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Lưu đích", exact: true })).toBeDisabled();

  await dialog.getByRole("button", { name: "Tải cấu hình mới", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Lưu đích", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Lưu đích", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.state.calls.findLast((c) => c.path === "deployTargets/upsert")?.input).toMatchObject({
    environmentId: ENV_DEV_ID,
    expectedConfigVersion: 5,
  });
});
