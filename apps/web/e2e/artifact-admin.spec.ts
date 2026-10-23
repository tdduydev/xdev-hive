import { expect, type Page, test } from "@playwright/test";
import { ARTIFACT_ORG, ARTIFACT_PROJECT, artifactsFixture, COLLEAGUE, fakeHub, ok, USER } from "./fake-hub.ts";

const GIB = 1024 ** 3;

async function open(page: Page, role: "member" | "admin", usedBytes = 1.7 * GIB) {
  const fixture = artifactsFixture();
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ARTIFACT_ORG.id);
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      ...fixture.rpcFor(USER, role),
      "artifacts/usage": () =>
        ok({
          usedBytes: Math.round(usedBytes),
          quotaBytes: 2 * GIB,
          artifacts: 42,
          byProject: [{ project: ARTIFACT_PROJECT, bytes: Math.round(usedBytes / 2), artifacts: 30 }],
          byUser: [
            { user: USER, bytes: Math.round(usedBytes / 4), artifacts: 20 },
            { user: COLLEAGUE, bytes: Math.round(usedBytes / 4), artifacts: 22 },
          ],
        }),
    },
  });
  return { fixture, hub };
}

test("dung lượng artifact: số liệu theo dự án và người, cảnh báo từ 80%, thành viên bị chặn (T067)", async ({
  page,
}) => {
  await open(page, "admin");
  await page.goto("/admin/artifact-usage");
  await expect(page.getByRole("heading", { name: "Dung lượng artifact", level: 1 })).toBeVisible();
  await expect(page.getByText("1,7 GB", { exact: true })).toBeVisible();
  await expect(page.getByText("85% hạn mức", { exact: false })).toBeVisible();
  await expect(page.getByText("Đã dùng từ 80% hạn mức", { exact: false })).toBeVisible();
  const projects = page.getByRole("region", { name: "Theo dự án" });
  await expect(projects).toContainText("payment-api (PAY)");
  const people = page.getByRole("region", { name: "Theo người" });
  await expect(people).toContainText(USER.name);
  await expect(people).toContainText(COLLEAGUE.name);
});

test("dung lượng artifact: hết hạn mức thì báo lỗi", async ({ page }) => {
  await open(page, "admin", 2 * GIB);
  await page.goto("/admin/artifact-usage");
  await expect(page.getByText("Đã hết hạn mức", { exact: false })).toBeVisible();
});

test("dung lượng artifact: thành viên không xem được", async ({ page }) => {
  const { hub } = await open(page, "member");
  await page.goto("/admin/artifact-usage");
  await expect(page.getByText("Chỉ quản trị tổ chức xem được dung lượng artifact.")).toBeVisible();
  expect(hub.rpcCalls.filter((c) => c.path === "artifacts/usage")).toHaveLength(0);
});

test("chính sách: mục Artifact bật loại ảnh, đổi hạn mức, giữ link công khai vừa đổi ở trang khác (T067)", async ({
  page,
}) => {
  const { fixture } = await open(page, "admin");
  await page.goto("/admin/policies");
  const section = page.getByRole("group", { name: "Artifact", exact: true });
  await expect(section).toBeVisible();
  await expect(section.getByRole("checkbox", { name: "Ảnh" })).not.toBeChecked();
  await expect(section.getByRole("checkbox", { name: "Cá nhân" })).toBeDisabled();
  await expect(section.getByRole("button", { name: "Lưu" })).toBeDisabled();

  const quota = section.getByLabel("Hạn mức dung lượng của tổ chức");
  await quota.fill("0");
  await expect(section.getByText("Nhập số từ 0.001", { exact: false })).toBeVisible();
  await expect(section.getByRole("button", { name: "Lưu" })).toBeDisabled();

  await section.getByRole("checkbox", { name: "Ảnh" }).check();
  await section.getByRole("checkbox", { name: "Đội" }).check();
  await quota.fill("4");
  // Quản trị khác vừa đổi hạn link công khai; mục này không sở hữu trường đó nên lưu xong vẫn giữ.
  fixture.state.policy.artifacts.publicLinks.maxDays = 3;
  await section.getByRole("button", { name: "Lưu" }).click();
  await expect(section.getByText("Đã lưu")).toBeVisible();
  const saved = fixture.state.policy.artifacts;
  expect([...saved.types].sort()).toEqual(["code", "html", "image", "markdown", "mermaid", "react"]);
  expect([...saved.scopes].sort()).toEqual(["private", "project", "team"]);
  expect(saved).toMatchObject({ orgQuotaBytes: 4 * GIB, publicLinks: { maxDays: 3 } });
});
