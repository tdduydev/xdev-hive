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
const CONNECTION = {
  id: "c0c0c0c0-0000-4000-8000-000000000001",
  kind: "github",
  name: "GitHub công ty",
  baseUrl: null,
  defaultOwner: "acme",
  authMode: "token",
  appId: null,
  installationId: null,
  createdAt: at,
};
const PROJECT = {
  id: "9a9a9a9a-0000-4000-8000-000000000001",
  systemId: SYSTEM.id,
  teamId: TEAM.id,
  key: "pay",
  name: "Thanh toán",
  state: "active",
  repo: { kind: "github", owner: "acme", name: "pay", webUrl: null },
};
const machine = (shared: boolean) => ({
  id: "8e8e8e8e-0000-4000-8000-000000000001",
  teamId: TEAM.id,
  kind: "worker",
  name: "mac-mini-01",
  os: "darwin",
  version: "1.3.0",
  clis: ["claude"],
  capacity: 2,
  status: "online",
  lastSeenAt: at,
  createdAt: at,
  shared,
  registeredBy: USER.id,
});
const TASK = {
  id: "1a1a1a1a-0000-4000-8000-000000000001",
  projectId: PROJECT.id,
  teamId: TEAM.id,
  key: "pay-1",
  number: 1,
  title: "Việc đầu tiên",
  body: "",
  type: null,
  status: "todo",
  preferredCli: null,
  source: { kind: "web" },
  createdBy: USER.id,
  createdAt: at,
  updatedAt: at,
};

interface State {
  orgRole: "owner" | "member";
  teamRole: "admin" | "member";
  connections: unknown[];
  systems: unknown[];
  projects: unknown[];
  machines: ReturnType<typeof machine>[];
  tasks: unknown[];
}

/** Hub vừa cài như ngoài thực tế: một tổ chức, một đội, một máy cá nhân, chưa có dự án, chưa kết nối Git. */
async function open(page: Page, over: Partial<State> = {}) {
  const state: State = {
    orgRole: "owner",
    teamRole: "admin",
    connections: [],
    systems: [SYSTEM],
    projects: [],
    machines: [machine(false)],
    tasks: [],
    ...over,
  };
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG.id);
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () => ok({ orgs: [{ ...ORG, role: state.orgRole }], canCreateOrg: false }),
      "roles/mine": () => ok({ permissions: [...SYSTEM_ROLE_PERMISSIONS[state.orgRole]] }),
      "inbox/unreadCount": () => ok({ count: 0 }),
      "orgMembers/list": () =>
        ok([
          {
            userId: USER.id,
            name: USER.name,
            email: USER.email,
            image: null,
            role: state.orgRole,
            status: "active",
            joinedAt: at,
            teams: [{ teamId: TEAM.id, name: TEAM.name, role: state.teamRole }],
          },
        ]),
      "teams/list": () => ok([TEAM]),
      "systems/list": () => ok(state.systems),
      "scmConnections/list": () => ok(state.connections),
      "scmConnections/create": (input) => {
        const created = { ...CONNECTION, ...(input as object), id: CONNECTION.id, createdAt: at };
        state.connections.push(created);
        return ok(created);
      },
      "projects/list": () => ok(state.projects),
      "tasks/list": () => ok(state.tasks),
      "runs/latest": () => ok([]),
      "machines/list": () => ok(state.machines),
      "machines/workerRelease": () => ok(null),
      "machines/setShared": (input) => {
        const { machineId, shared } = input as { machineId: string; shared: boolean };
        state.machines = state.machines.map((m) => (m.id === machineId ? { ...m, shared } : m));
        return ok(state.machines.find((m) => m.id === machineId));
      },
      "machines/createRegistration": () =>
        ok({
          token: "reg-once-token",
          expiresAt: at,
          command: "hive-worker register --token reg-once-token",
          installCommand: "curl -fsSL https://dl.test/install.sh | sh",
          installCommandWindows: "irm https://dl.test/install.ps1",
        }),
    },
  });
  return { hub, state };
}

const card = (page: Page) => page.getByRole("list", { name: "Các bước bắt đầu" });
const step = (page: Page, name: string) => card(page).getByRole("listitem", { name });

test("chủ tổ chức trên hub mới cài: thẻ Bắt đầu chỉ đúng bước còn thiếu và nút dẫn đúng chỗ", async ({ page }) => {
  await open(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bắt đầu" })).toBeVisible();
  await expect(page.getByText("1/5 bước xong")).toBeVisible();
  await expect(card(page).getByRole("listitem")).toHaveCount(5);

  await expect(step(page, "Đăng ký một máy")).toContainText("Đã xong");
  await expect(step(page, "Đăng ký một máy").getByRole("link")).toHaveCount(0);
  // Dự án cần kết nối Git, việc cần dự án: chưa có nút, chỉ báo bước phải làm trước.
  await expect(step(page, "Tạo hệ thống và dự án đầu tiên")).toContainText(
    "Làm bước “Kết nối GitHub hoặc GitLab” trước.",
  );
  await expect(step(page, "Tạo hệ thống và dự án đầu tiên").getByRole("button")).toHaveCount(0);
  await expect(step(page, "Giao task đầu tiên")).toContainText("Làm bước “Tạo hệ thống và dự án đầu tiên” trước.");
  await expect(
    step(page, "Cho đội dùng chung một máy").getByRole("link", { name: "Chọn máy dùng chung" }),
  ).toHaveAttribute("href", "/machines");

  // (a) Kết nối GitHub: tới trang Kết nối Git, thêm bằng token.
  await step(page, "Kết nối GitHub hoặc GitLab").getByRole("link", { name: "Kết nối GitHub/GitLab" }).click();
  await expect(page).toHaveURL("/admin/git");
  await page.getByRole("button", { name: "Thêm kết nối" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Tên kết nối").fill("GitHub công ty");
  await dialog.getByLabel("Tổ chức GitHub").fill("acme");
  await dialog.getByRole("textbox", { name: "Token" }).fill("github_pat_test_only");
  await dialog.getByRole("button", { name: "Thêm kết nối" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("row", { name: /GitHub công ty/ })).toBeVisible();

  // (b) Quay về trang chủ: bước kết nối đã xong, bước dự án mở hộp thoại tạo dự án.
  await page.getByRole("navigation", { name: "Điều hướng chính" }).getByRole("link", { name: "Tổng quan" }).click();
  await expect(step(page, "Kết nối GitHub hoặc GitLab")).toContainText("Đã xong");
  await step(page, "Tạo hệ thống và dự án đầu tiên").getByRole("button", { name: "Tạo dự án" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Tạo dự án" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Huỷ" }).click();

  // (d) Cho đội dùng chung: trang Máy cảnh báo và bật ở máy phù hợp.
  await step(page, "Cho đội dùng chung một máy").getByRole("link").click();
  await expect(page).toHaveURL("/machines");
  const warning = page.getByRole("region", { name: "Đội chưa có máy dùng chung" });
  await expect(warning).toContainText("Run của đội chỉ chạy trên máy dùng chung");
  await warning.getByRole("button", { name: "Cho đội dùng chung máy mac-mini-01" }).click();
  await expect(warning).toBeHidden();
  await expect(page.getByRole("row", { name: /mac-mini-01/ })).toContainText("Dùng chung");
});

test("đội chưa có hệ thống: bước dự án dẫn tới trang Đội và hệ thống", async ({ page }) => {
  await open(page, { connections: [CONNECTION], systems: [] });
  await page.goto("/");
  const project = step(page, "Tạo hệ thống và dự án đầu tiên");
  await expect(project).toContainText("Đội chưa có hệ thống");
  await expect(project.getByRole("link", { name: "Thêm hệ thống" })).toHaveAttribute("href", "/admin/teams");
});

test("chưa có máy: bước đăng ký máy mở sẵn hộp thoại Thêm máy", async ({ page }) => {
  await open(page, { machines: [] });
  await page.goto("/");
  await expect(step(page, "Cho đội dùng chung một máy")).toContainText("Làm bước “Đăng ký một máy” trước.");
  await step(page, "Đăng ký một máy").getByRole("link", { name: "Đăng ký máy" }).click();
  await expect(page).toHaveURL(/\/machines\?them=/);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Thêm máy" })).toBeVisible();
  await dialog.getByRole("button", { name: "Đóng" }).click();
  // Đóng thì bỏ ?them, trang Máy còn lại hướng dẫn và nút đăng ký.
  await expect(page).toHaveURL("/machines");
  await expect(page.getByRole("heading", { name: "Đội chưa đăng ký máy nào" })).toBeVisible();
  await page.getByRole("button", { name: "Đăng ký máy" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Tạo mã đăng ký" })).toBeVisible();
});

test("xong hết thì thẻ Bắt đầu ẩn", async ({ page }) => {
  const { hub } = await open(page, {
    connections: [CONNECTION],
    projects: [PROJECT],
    machines: [machine(true)],
    tasks: [TASK],
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: ORG.name, exact: true })).toBeVisible();
  await expect.poll(() => hub.rpcCalls.some((c) => c.path === "machines/list")).toBe(true);
  await expect(page.getByRole("heading", { name: "Bắt đầu" })).toHaveCount(0);
});

test("thành viên đội chỉ thấy bước mình làm được", async ({ page }) => {
  await open(page, { orgRole: "member", teamRole: "member", projects: [PROJECT] });
  await page.goto("/");
  await expect(card(page).getByRole("listitem")).toHaveCount(1);
  await step(page, "Giao task đầu tiên").getByRole("button", { name: "Giao task" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("trang Dự án rỗng: chưa kết nối Git thì chỉ tới trang Kết nối Git", async ({ page }) => {
  await open(page);
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Chưa có dự án nào" })).toBeVisible();
  await expect(page.getByText("Bước đầu: kết nối GitHub hoặc GitLab")).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "Kết nối GitHub/GitLab" }).click();
  await expect(page).toHaveURL("/admin/git");
  await expect(page.getByRole("heading", { name: "Chưa có kết nối Git" })).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`thẻ Bắt đầu: tiếng Anh, 360px, ${scheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
    await open(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Get started" })).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Getting started steps" }).getByRole("link", { name: "Connect GitHub/GitLab" }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`getting-started-360-${scheme}.png`), fullPage: true });
    for (const path of ["/machines", "/admin/git", "/projects"]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow, `${path} cuộn ngang ở 360px`).toBeLessThanOrEqual(0);
    }
  });
}
