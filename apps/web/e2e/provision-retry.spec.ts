import { expect, type Page, test } from "@playwright/test";
import { SYSTEM_ROLE_PERMISSIONS } from "@xdev-hive/contracts";
import { fakeHub, ok, USER } from "./fake-hub.ts";

const at = "2026-10-12T03:00:00.000Z";
const ORG = {
  id: "0a0a0a0a-0000-4000-8000-00000000000a",
  slug: "acme",
  name: "Acme",
  emailDomain: null,
  createdAt: at,
};
const TEAM = {
  id: "7e7e7e7e-0000-4000-8000-000000000001",
  slug: "thanh-toan",
  name: "Thanh toán",
  color: null,
  createdAt: at,
  systemCount: 1,
  memberCount: 1,
};
const SYSTEM = {
  id: "5e5e5e5e-0000-4000-8000-000000000001",
  teamId: TEAM.id,
  slug: "cong",
  name: "Cổng",
  createdAt: at,
};
const PROJECT = {
  id: "9a9a9a9a-0000-4000-8000-000000000001",
  systemId: SYSTEM.id,
  teamId: TEAM.id,
  key: "pay",
  name: "Thanh toán",
  state: "failed",
  repo: { kind: "github", owner: "acme", name: "pay", webUrl: null },
};
const step = (position: number, kind: string, title: string, state: string, over: object = {}) => ({
  id: `5a5a5a5a-0000-4000-8000-00000000000${position}`,
  kind,
  target: null,
  title,
  position,
  state,
  error: null,
  result: null,
  attempts: state === "done" ? 1 : 0,
  startedAt: null,
  finishedAt: null,
  ...over,
});
const FAILED_STEP = step(3, "protect-branch", "Bảo vệ nhánh chính", "failed", {
  target: "acme/pay@main",
  attempts: 2,
  error: {
    code: "forbidden",
    message: "Token không đủ quyền bảo vệ nhánh.",
    fix: "Cấp quyền Administration cho token rồi chạy lại.",
  },
});
const STEPS = () => [
  step(1, "check-access", "Kiểm tra quyền truy cập", "done"),
  step(2, "create-repo", "Tạo repo", "done"),
  { ...FAILED_STEP },
  step(4, "add-webhook", "Thêm webhook", "pending"),
];

async function open(page: Page, opts: { teamRole?: "admin" | "member"; retryFails?: boolean } = {}) {
  const teamRole = opts.teamRole ?? "admin";
  const orgRole = teamRole === "admin" ? "owner" : "member";
  const state = { project: { ...PROJECT } as Record<string, unknown>, steps: STEPS() as Record<string, unknown>[] };
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG.id);
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () => ok({ orgs: [{ ...ORG, role: orgRole }], canCreateOrg: false }),
      "roles/mine": () => ok({ permissions: [...SYSTEM_ROLE_PERMISSIONS[orgRole]] }),
      "inbox/unreadCount": () => ok({ count: 0 }),
      "orgMembers/list": () =>
        ok([
          {
            userId: USER.id,
            name: USER.name,
            email: USER.email,
            image: null,
            role: orgRole,
            status: "active",
            joinedAt: at,
            teams: [{ teamId: TEAM.id, name: TEAM.name, role: teamRole }],
          },
        ]),
      "teams/list": () => ok([TEAM]),
      "systems/list": () => ok([SYSTEM]),
      "scmConnections/list": () => ok([]),
      "projects/list": () => ok([state.project]),
      "projects/provision": () => ok({ project: state.project, steps: state.steps }),
      "projects/retryStep": () => {
        if (opts.retryFails)
          return { status: 409, json: { json: { code: "CONFLICT", status: 409, message: "Bước này đang chạy." } } };
        // Hub chạy lại bước lỗi và các bước sau nó; ở đây coi như xong hết.
        state.steps = state.steps.map((s) => ({ ...s, state: "done", error: null, attempts: 3 }));
        state.project = { ...state.project, state: "active" };
        return ok({ project: state.project, steps: state.steps });
      },
      "tasks/list": () => ok([]),
      "runs/latest": () => ok([]),
    },
  });
  return { hub, state };
}

const card = (page: Page) => page.getByRole("group", { name: "Khởi tạo dự án" });

test("dự án khởi tạo lỗi: hiện lỗi và cách sửa, chạy lại xong thì mở khoá Tạo việc", async ({ page }) => {
  const { hub } = await open(page);
  await page.goto("/projects/pay");
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByRole("listitem")).toHaveCount(4);
  await expect(card(page)).toContainText("Token không đủ quyền bảo vệ nhánh.");
  await expect(card(page)).toContainText("Cấp quyền Administration cho token rồi chạy lại.");
  await expect(card(page)).toContainText("Đã chạy 2 lần");

  // Nút khoá phải nói vì sao.
  const create = page.getByRole("button", { name: "Tạo việc" });
  await expect(create).toBeDisabled();
  await expect(page.getByText("Chưa tạo được việc: khởi tạo dự án bị lỗi.").first()).toBeVisible();

  await card(page).getByRole("button", { name: "Chạy lại: Bảo vệ nhánh chính" }).click();
  await expect.poll(() => hub.rpcCalls.filter((c) => c.path === "projects/retryStep")).toHaveLength(1);
  expect(hub.rpcCalls.find((c) => c.path === "projects/retryStep")?.input).toEqual({
    id: PROJECT.id,
    stepId: FAILED_STEP.id,
  });
  // Dự án đã hoạt động thì thẻ các bước biến mất và nút Tạo việc mở khoá.
  await expect(card(page)).toHaveCount(0);
  await expect(create).toBeEnabled();
});

test("thành viên đội không có nút Chạy lại, chỉ có lời giải thích", async ({ page }) => {
  await open(page, { teamRole: "member" });
  await page.goto("/projects/pay");
  await expect(card(page)).toContainText("Token không đủ quyền bảo vệ nhánh.");
  await expect(card(page).getByRole("button")).toHaveCount(0);
  await expect(card(page)).toContainText("Chỉ quản trị đội sở hữu dự án chạy lại được bước lỗi.");
});

test("chạy lại bị hub từ chối thì hiện lỗi và giữ nút", async ({ page }) => {
  await open(page, { retryFails: true });
  await page.goto("/projects/pay");
  await card(page).getByRole("button", { name: "Chạy lại: Bảo vệ nhánh chính" }).click();
  await expect(card(page)).toContainText("Dữ liệu bị trùng hoặc vừa bị người khác đổi.");
  await expect(card(page).getByRole("button", { name: "Chạy lại: Bảo vệ nhánh chính" })).toBeEnabled();
});

test("dialog tạo dự án khi chưa có kết nối Git: chủ tổ chức thấy đường dẫn tới Kết nối Git", async ({ page }) => {
  await open(page);
  await page.goto("/projects");
  await page.getByRole("button", { name: "Tạo dự án" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Thêm một kết nối để hub tạo hoặc nối repo cho dự án.");
  await dialog.getByRole("link", { name: "Mở Kết nối Git" }).click();
  await expect(page).toHaveURL("/admin/git");
  await expect(dialog).toBeHidden();
});

for (const scheme of ["light", "dark"] as const) {
  test(`khởi tạo dự án lỗi: ${scheme}, không tràn ngang ở 360px`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    await page.goto("/projects/pay");
    await expect(card(page)).toContainText("Token không đủ quyền bảo vệ nhánh.");
    await page.screenshot({ path: testInfo.outputPath(`provision-${scheme}.png`), fullPage: true });
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(card(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`provision-360-${scheme}.png`), fullPage: true });
  });
}
