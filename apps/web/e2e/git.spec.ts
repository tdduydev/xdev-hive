import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ScmConnection, ScmConnectionTestResult } from "@xdev-hive/contracts";
import { fail, fakeHub, ok, type RpcHandler } from "./fake-hub.ts";

const at = "2026-10-01T03:00:00.000Z";
const ORG = {
  id: "0a0a0a0a-0000-4000-8000-00000000000a",
  slug: "acme",
  name: "Acme",
  role: "owner",
  emailDomain: null,
  createdAt: at,
};
const GITHUB: ScmConnection = {
  id: "c1c1c1c1-0000-4000-8000-000000000001",
  kind: "github",
  name: "GitHub Acme",
  baseUrl: null,
  defaultOwner: "acme",
  authMode: "app",
  appId: "123456",
  installationId: 987654,
  createdAt: at,
};
const GITLAB: ScmConnection = {
  id: "c1c1c1c1-0000-4000-8000-000000000002",
  kind: "gitlab",
  name: "GitLab nội bộ",
  baseUrl: "https://gitlab.acme.vn",
  defaultOwner: "platform",
  authMode: "token",
  appId: null,
  installationId: null,
  createdAt: at,
};
const TESTED: ScmConnectionTestResult = {
  ok: false,
  owner: "platform",
  canCreate: false,
  missingScopes: ["api"],
  unverifiedScopes: [],
  message: "Token thiếu quyền tạo repo trong group platform.",
};

async function open(page: Page, opts: { role?: string; rpc?: Record<string, RpcHandler> } = {}) {
  let connections = [GITHUB, GITLAB];
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () => ok({ orgs: [{ ...ORG, role: opts.role ?? ORG.role }], canCreateOrg: false }),
      "inbox/unreadCount": () => ok({ count: 0 }),
      "scmConnections/list": () => ok(connections),
      "scmConnections/test": (input) =>
        ok(
          (input as { id: string }).id === GITHUB.id
            ? { ...TESTED, ok: true, canCreate: true, missingScopes: [], message: "" }
            : TESTED,
        ),
      "scmConnections/remove": (input) => {
        connections = connections.filter((c) => c.id !== (input as { id: string }).id);
        return ok({ removed: true });
      },
      ...opts.rpc,
    },
  });
  return hub;
}

test("danh sách kết nối: kiểm tra hiện kết quả dưới dòng, xoá qua menu ⋯ có xác nhận", async ({ page }) => {
  const hub = await open(page);
  await page.goto("/admin/git");
  await expect(page.getByRole("heading", { name: "Kết nối Git", exact: true })).toBeVisible();
  await expect(page.getByText("Hub dùng kết nối GitHub hoặc GitLab để tạo repo")).toBeVisible();
  const table = page.getByRole("table", { name: "Kết nối Git" });
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByRole("row").filter({ hasText: "GitLab nội bộ" })).toContainText("https://gitlab.acme.vn");

  await page.getByRole("button", { name: "Kiểm tra GitLab nội bộ", exact: true }).click();
  const result = page.getByRole("status").filter({ hasText: "Kiểm tra GitLab nội bộ" });
  await expect(result).toContainText("Kết nối chưa dùng được");
  await expect(result).toContainText("Thiếu quyền: api.");
  expect(hub.rpcCalls.find((c) => c.path === "scmConnections/test")?.input).toEqual({ id: GITLAB.id });
  await page.getByRole("button", { name: "Kiểm tra GitHub Acme", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Kiểm tra GitHub Acme" })).toContainText("Kết nối dùng được");

  // Không có nút Xoá đứng cạnh Kiểm tra: xoá nằm trong menu ⋯ và luôn hỏi lại.
  await expect(page.getByRole("button", { name: "Xoá GitHub Acme" })).toHaveCount(0);
  await page.getByRole("button", { name: "Thao tác khác cho kết nối GitHub Acme", exact: true }).click();
  await page.getByRole("menuitem", { name: "Xoá kết nối…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Xoá kết nối GitHub Acme?" })).toBeVisible();
  await dialog.getByRole("button", { name: "Huỷ", exact: true }).click();
  expect(hub.rpcCalls.some((c) => c.path === "scmConnections/remove")).toBe(false);

  await page.getByRole("button", { name: "Thao tác khác cho kết nối GitHub Acme", exact: true }).click();
  await page.getByRole("menuitem", { name: "Xoá kết nối…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Xoá kết nối", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(hub.rpcCalls.find((c) => c.path === "scmConnections/remove")?.input).toEqual({ id: GITHUB.id });
  await expect(table.getByRole("row").filter({ hasText: "GitHub Acme" })).toHaveCount(0);
  await expect(table.getByRole("row").filter({ hasText: "https://gitlab.acme.vn" })).toHaveCount(1);
});

test("xoá kết nối bị hub từ chối thì báo trong hộp thoại và giữ dòng", async ({ page }) => {
  await open(page, {
    rpc: {
      "scmConnections/remove": () => fail("CONFLICT", 409, "Kết nối đang được dự án PAY dùng, không xoá được."),
    },
  });
  await page.goto("/admin/git");
  await page.getByRole("button", { name: "Thao tác khác cho kết nối GitLab nội bộ", exact: true }).click();
  await page.getByRole("menuitem", { name: "Xoá kết nối…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Xoá kết nối", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Kết nối đang được dự án PAY dùng");
  await dialog.getByRole("button", { name: "Huỷ", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "GitLab nội bộ" })).toHaveCount(1);
});

test("thành viên chỉ xem: có ghi chú, không có nút thêm, kiểm tra hay ⋯", async ({ page }) => {
  await open(page, { role: "member" });
  await page.goto("/admin/git");
  await expect(page.getByRole("row").filter({ hasText: "GitHub Acme" })).toHaveCount(1);
  await expect(page.getByRole("note")).toContainText("Chỉ quản trị tổ chức thêm, kiểm tra và xoá được kết nối.");
  await expect(page.getByRole("button", { name: "Thêm kết nối" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Kiểm tra|Thao tác khác/ })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Thao tác" })).toHaveCount(0);
});

test("rỗng có nút thêm trong khung trống; lỗi tải có Tải lại", async ({ page }) => {
  let state: "empty" | "error" | "ok" = "empty";
  await open(page, {
    rpc: {
      "scmConnections/list": () =>
        state === "empty"
          ? ok([])
          : state === "error"
            ? fail("INTERNAL_SERVER_ERROR", 500, "Không đọc được kết nối Git.")
            : ok([GITHUB]),
    },
  });
  await page.goto("/admin/git");
  await expect(page.getByRole("heading", { name: "Chưa có kết nối Git" })).toBeVisible();
  // Chỉ một nút "Thêm kết nối" khi rỗng: nút ở đầu trang ẩn để khỏi trùng tên.
  await expect(page.getByRole("button", { name: "Thêm kết nối" })).toHaveCount(1);
  await page.getByRole("button", { name: "Thêm kết nối" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Thêm kết nối Git" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Huỷ", exact: true }).click();

  state = "error";
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Không đọc được kết nối Git.");
  state = "ok";
  await page.getByRole("button", { name: "Tải lại", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "GitHub Acme" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Thêm kết nối" })).toHaveCount(1);
});

for (const width of [1440, 1100, 360]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Kết nối Git ${width} ${theme}: bảng vừa khung, không tràn trang`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem("hive.theme", value), theme);
      await open(page);
      await page.goto("/admin/git");
      const table = page.getByRole("table", { name: "Kết nối Git" });
      await expect(table.getByRole("row")).toHaveCount(3);
      if (width >= 1100)
        await expect
          .poll(() =>
            table.evaluate((el) =>
              el.parentElement ? el.parentElement.scrollWidth - el.parentElement.clientWidth : 0,
            ),
          )
          .toBeLessThanOrEqual(1);
      await page.getByRole("button", { name: "Kiểm tra GitLab nội bộ", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Kiểm tra GitLab nội bộ" })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
        .toBeLessThanOrEqual(1);
      await shot(page, `git-${width}-${theme}-vi`);
      await page.getByRole("button", { name: "EN", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Git connections", exact: true })).toBeVisible();
      await shot(page, `git-${width}-${theme}-en`);
    });
  }
}

/** Ảnh trước/sau cho người duyệt UI; chỉ chụp khi đặt HIVE_ADMINUI_SHOTS_DIR, CI không ghi file. */
async function shot(page: Page, name: string) {
  const dir = process.env.HIVE_ADMINUI_SHOTS_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: true });
}
