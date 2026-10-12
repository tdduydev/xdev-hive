import { expect, type Page, test } from "@playwright/test";
import { fail, fakeHub, ok, type RpcHandler, USER } from "./fake-hub.ts";

const at = "2026-10-01T03:00:00.000Z";
const ORG_A = {
  id: "0a0a0a0a-0000-4000-8000-00000000000a",
  slug: "acme-dev",
  name: "Acme Software xDev",
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
  await expect(page.getByRole("combobox")).toHaveCount(1);
  await expect(page.getByLabel("Số dòng")).toBeVisible();
  const orgsOf = (path: string) => hub.rpcCalls.filter((c) => c.path === path).map((c) => c.org);
  expect(new Set(orgsOf("teams/list"))).toEqual(new Set([ORG_B.id]));
  // Danh sách tổ chức của mình không cần chọn tổ chức.
  expect(orgsOf("orgs/mine")).toEqual([undefined]);

  await switcher(page).click();
  await page.getByRole("menuitemradio", { name: /Acme Software xDev/ }).click();
  await expect(switcher(page)).toContainText("Chủ sở hữu");
  await expect(page.getByRole("button", { name: "Tạo đội" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hệ thống", exact: true })).toBeVisible();
  await expect(page.getByLabel("Vai trò của Lê Hà trong đội")).toHaveValue("admin");
  expect(orgsOf("teams/list")).toContain(ORG_A.id);
  expect(await page.evaluate(() => localStorage.getItem("hive.org"))).toBe(ORG_A.id);

  await page.reload();
  await expect(switcher(page)).toContainText("Acme Software xDev");
});

const PROJECT = {
  id: "6e6e6e6e-0000-4000-8000-000000000001",
  systemId: SYSTEM.id,
  teamId: TEAM.id,
  key: "web",
  name: "Web",
  state: "active",
  repo: {
    mode: "existing",
    connectionId: "6e6e6e6e-0000-4000-8000-000000000002",
    kind: "github",
    owner: "acme",
    name: "web",
    defaultBranch: "main",
    visibility: null,
    httpUrl: "https://github.com/acme/web",
    sshUrl: "git@github.com:acme/web.git",
    webUrl: "https://github.com/acme/web",
  },
  settings: {
    merge: { mode: "review", requiredApprovals: 1 },
    outcome: { default: [{ check: "changes", required: true }], byType: {} },
    features: { planMode: false, crossReview: false, mergeQueue: false, leaderChat: false, sandbox: false },
    issueIntake: { enabled: false, label: "hive", mention: "hive" },
  },
  createdBy: USER.id,
  createdAt: at,
  updatedAt: at,
};

test("màn Máy: thêm máy bằng mã dùng một lần, chép lệnh nền và xác nhận thu hồi", async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_A.id);
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () => ok({ orgs: [myOrg(ORG_A)], canCreateOrg: false }),
      "teams/list": () => ok([TEAM]),
      "projects/list": () => ok([]),
      "machines/list": () =>
        ok([
          {
            id: "8e8e8e8e-0000-4000-8000-000000000001",
            teamId: TEAM.id,
            name: "mac-mini-01",
            os: "darwin",
            version: "1.2.3",
            clis: ["claude", "codex"],
            capacity: 2,
            status: "online",
            lastSeenAt: at,
            createdAt: at,
          },
        ]),
      "machines/createRegistration": (input) =>
        ok({
          token: "reg-once-token",
          expiresAt: "2026-10-11T17:00:00.000Z",
          command: "hive-worker register --hub https://hive.test --token reg-once-token",
          installCommand: `curl -fsSL https://dl.test/install.sh | sh -s -- --hub https://hive.test --token reg-once-token${(input as { kind: string }).kind === "host" ? " --no-service" : ""}`,
          installCommandWindows:
            'irm https://dl.test/install.ps1 -OutFile "$env:TEMP\\hive-install.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\hive-install.ps1" -Hub https://hive.test -Token reg-once-token',
        }),
      "machines/workerRelease": () =>
        ok({ version: "1.3.0", url: "https://github.com/tdduydev/xdev-hive/releases/tag/v1.3.0", publishedAt: at }),
      "machines/update": (input) =>
        ok({
          id: (input as { machineId: string }).machineId,
          teamId: TEAM.id,
          name: "mac-mini-01",
          os: "darwin",
          version: "1.2.3",
          clis: ["claude", "codex"],
          capacity: 2,
          status: "online",
          lastSeenAt: at,
          createdAt: at,
        }),
      "machines/revoke": (input) =>
        ok({
          id: (input as { machineId: string }).machineId,
          teamId: TEAM.id,
          name: "mac-mini-01",
          os: "darwin",
          version: "1.2.3",
          clis: ["claude", "codex"],
          capacity: 2,
          status: "revoked",
          lastSeenAt: at,
          createdAt: at,
        }),
      "machines/pause": (input) =>
        ok({
          id: (input as { machineId: string }).machineId,
          teamId: TEAM.id,
          name: "mac-mini-01",
          os: "darwin",
          version: "1.2.3",
          clis: ["claude", "codex"],
          capacity: 2,
          status: "paused",
          lastSeenAt: at,
          createdAt: at,
        }),
      "machines/resume": (input) =>
        ok({
          id: (input as { machineId: string }).machineId,
          teamId: TEAM.id,
          name: "mac-mini-01",
          os: "darwin",
          version: "1.2.3",
          clis: ["claude", "codex"],
          capacity: 2,
          status: "online",
          lastSeenAt: at,
          createdAt: at,
        }),
    },
  });
  await page.goto("/machines");
  await expect(page.getByRole("heading", { name: "Máy", exact: true })).toBeVisible();
  await expect(page.getByRole("row", { name: /mac-mini-01/ })).toContainText("Sẵn sàng");
  await expect(page.getByRole("row", { name: /mac-mini-01/ })).toContainText("Có bản 1.3.0");
  await page.screenshot({ path: "e2e/screenshots/machines.png", fullPage: true });
  await page.getByRole("button", { name: "Cập nhật worker trên mac-mini-01" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã gửi lệnh cập nhật" })).toContainText("mac-mini-01");
  expect(hub.rpcCalls.find((call) => call.path === "machines/update")?.input).toEqual({
    machineId: "8e8e8e8e-0000-4000-8000-000000000001",
  });
  await page.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  expect(hub.rpcCalls.find((call) => call.path === "machines/pause")).toMatchObject({
    org: ORG_A.id,
    input: { machineId: "8e8e8e8e-0000-4000-8000-000000000001" },
  });
  await page.getByRole("button", { name: "Thêm máy" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Tạo mã đăng ký" }).click();
  await expect(dialog.getByRole("status", { name: "Mã đăng ký dùng một lần" })).toHaveText("reg-once-token");
  await expect(
    dialog.getByText(
      "curl -fsSL https://dl.test/install.sh | sh -s -- --hub https://hive.test --token reg-once-token",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(
    dialog.getByText("hive-worker register --hub https://hive.test --token reg-once-token", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Windows" }).click();
  await expect(dialog.getByText(/irm https:\/\/dl\.test\/install\.ps1 -OutFile/)).toBeVisible();
  await dialog.getByRole("button", { name: "Linux" }).click();
  await expect(dialog.getByText(/loginctl enable-linger/)).toBeVisible();
  await dialog.getByRole("button", { name: "Đóng" }).click();
  await expect(dialog).toBeHidden();
  expect(hub.rpcCalls.find((call) => call.path === "machines/createRegistration")?.input).toMatchObject({
    kind: "worker",
  });

  // Runner host: chọn loại trước khi tạo mã; lệnh cuối là hive-worker host, không có chọn hệ điều hành.
  await page.getByRole("button", { name: "Thêm máy" }).click();
  await page
    .getByRole("dialog")
    .getByLabel(/Runner host/)
    .check();
  await page.getByRole("dialog").getByRole("button", { name: "Tạo mã đăng ký" }).click();
  await expect(page.getByRole("dialog").getByText(/--token reg-once-token --no-service$/)).toBeVisible();
  await expect(page.getByRole("dialog").getByText(/^hive-worker host --image/)).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Linux" })).toHaveCount(0);
  expect(hub.rpcCalls.filter((call) => call.path === "machines/createRegistration").at(-1)?.input).toMatchObject({
    kind: "host",
  });
  await page.getByRole("dialog").getByRole("button", { name: "Đóng" }).click();

  await page.getByRole("button", { name: "Thu hồi", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Thu hồi máy" }).click();
  expect(hub.rpcCalls.find((call) => call.path === "machines/revoke")).toMatchObject({
    org: ORG_A.id,
    input: { machineId: "8e8e8e8e-0000-4000-8000-000000000001" },
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("màn Chi phí: chọn khoảng ngày, nhóm dữ liệu và cập nhật ngân sách dự án", async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_A.id);
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () => ok({ orgs: [myOrg(ORG_A)], canCreateOrg: false }),
      "projects/list": () => ok([PROJECT]),
      "costs/summary": (input) => {
        const groupBy = (input as { groupBy: string }).groupBy;
        return ok({
          groupBy,
          groups: [
            {
              key: groupBy === "day" ? "2026-10-11" : "claude",
              runs: 2,
              tokensIn: 900,
              tokensOut: 400,
              cacheRead: 10,
              cacheWrite: 0,
              costUsd: 1.25,
            },
          ],
          total: { runs: 2, tokensIn: 900, tokensOut: 400, cacheRead: 10, cacheWrite: 0, costUsd: 1.25 },
        });
      },
      "costs/budgetStopped": () =>
        ok([
          {
            runId: "6a6a6a6a-0000-4000-8000-000000000001",
            taskId: "7a7a7a7a-0000-4000-8000-000000000001",
            taskKey: "PAY-31",
            taskTitle: "Xử lý thanh toán",
            reason: "per_run_usd",
            measured: 2.03,
            limit: 2,
            stoppedAt: at,
          },
        ]),
      "projects/updateSettings": (input) => {
        const settings = (
          input as {
            settings: { budget: { perRunUsd: number | null; perTaskUsd: number | null; maxTurns: number | null } };
          }
        ).settings;
        return ok({ ...PROJECT.settings, budget: settings.budget });
      },
    },
  });
  await page.goto("/admin/costs");
  await expect(page.getByRole("heading", { name: "Chi phí và token", exact: true })).toBeVisible();
  await expect(page.getByText("1,25 US$", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Vượt trần USD/run")).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/costs.png", fullPage: true });
  await page.getByLabel("Khoảng thời gian").selectOption("7");
  await page.getByLabel("Nhóm theo").selectOption("machine");
  await expect(page.getByRole("columnheader", { name: "Mã máy" })).toBeVisible();

  await page.getByLabel("USD mỗi run").fill("5");
  await page.getByLabel("USD mỗi việc").fill("20");
  await page.getByLabel("Lượt agent tối đa").fill("12");
  await page.getByRole("button", { name: "Lưu ngân sách" }).click();
  await expect.poll(() => hub.rpcCalls.some((call) => call.path === "projects/updateSettings")).toBe(true);
  expect(hub.rpcCalls.find((call) => call.path === "projects/updateSettings")).toMatchObject({
    org: ORG_A.id,
    input: { key: PROJECT.key, settings: { budget: { perRunUsd: 5, perTaskUsd: 20, maxTurns: 12 } } },
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
  const vy = page.getByRole("row", { name: /vy\.ngo@example\.com/ });
  await expect(vy).toContainText("Chờ nhận");
  await expect(vy).toContainText("Thanh toán");
  await expect(vy).toContainText("chỉ xem");
  await expect(vy).toContainText("18/10/2026");
  await expect(page.getByRole("row", { name: /minh\.pham@example\.com/ })).toContainText("Đã nhận");
  // Lời mời đã dùng thì hub không cho thu hồi.
  await expect(page.getByRole("button", { name: "Thu hồi lời mời cho minh.pham@example.com" })).toHaveCount(0);
  await expect(page.getByRole("row", { name: /cu@example\.com/ })).toContainText("Hết hạn");

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
  await dialog.getByLabel("Email").fill("a@example.com, b@example.org");
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
          provider: {
            issuer: i.issuer,
            domain: i.domain,
            domainVerified: false,
            clientIdLastFour: i.clientId.slice(-4),
          },
        };
        return ok(settings);
      },
    },
  });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Điều hướng chính" });
  // Nhóm "Người và quyền" đóng khi đang ở trang chủ: mở rồi mới bấm.
  await nav.getByRole("button", { name: "Người và quyền" }).click();
  await nav.getByRole("link", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/admin/sign-in-settings");

  const methods = page.getByRole("list", { name: "Cách đăng nhập" });
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
  // Tên miền mới khai luôn chưa xác minh: hub chưa cho SSO tạo tài khoản, chính sách người mới chưa áp dụng.
  await expect(methods).toContainText(
    "login.microsoftonline.com · example.com (chưa xác minh) · người mới: cần lời mời",
  );
  await expect(page.getByText(/Tên miền chưa được xác minh nên SSO chưa tạo tài khoản mới/)).toBeVisible();
  // Secret chỉ ghi: lưu xong thì ô trống, hub không trả secret về.
  await expect(page.getByLabel("Client secret")).toHaveValue("");
  await expect(page.getByText("Để trống nếu không đổi.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Gỡ SSO" })).toBeVisible();
});

test("cài đặt đăng nhập: sửa SSO không gửi secret khi để trống, lỗi của hub gắn vào ô Issuer", async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_A.id);
  const configured = {
    ...SSO_NONE,
    provider: {
      issuer: "https://idp.example.com",
      domain: "example.com",
      domainVerified: true,
      clientIdLastFour: "ab12",
    },
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
  await expect(page.getByRole("list", { name: "Cách đăng nhập" })).toContainText(
    "idp.example.com · example.com · người mới: chờ duyệt",
  );
  await expect(page.getByText("Người có email tên miền này đăng nhập bằng SSO của tổ chức.")).toBeVisible();
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

test("cài đặt đăng nhập: tên miền đã có tổ chức khác khai thì lỗi của hub gắn vào ô tên miền", async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_A.id);
  const message =
    "Tên miền example.com đã được một tổ chức khác trên hub khai cho SSO. Mỗi tên miền chỉ thuộc một tổ chức; nếu tên miền là của tổ chức bạn, hãy báo quản trị hub.";
  await fakeHub(page, {
    signedIn: true,
    rpc: {
      ...twoOrgs(),
      "orgs/mine": () => ok({ orgs: [{ ...myOrg(ORG_A), emailDomain: "example.com" }], canCreateOrg: false }),
      "ssoProviders/get": () => ok(SSO_NONE),
      "ssoProviders/upsert": () => fail("CONFLICT", 409, message, { code: "SSO_DOMAIN_TAKEN" }),
    },
  });
  await page.goto("/admin/sign-in-settings");
  await page.getByLabel("Issuer URL").fill("https://login.microsoftonline.com/3f2a/v2.0");
  await page.getByLabel("Client ID").fill("8c1d5e2a-abcd");
  await page.getByLabel("Client secret").fill("bi-mat-cua-idp");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText(message)).toBeVisible();
  await expect(page.getByLabel("Tên miền email")).toHaveAttribute("aria-invalid", "true");
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

const manyMembers = () =>
  Array.from({ length: 25 }, (_, i) => ({
    ...HA,
    userId: `person-${i}`,
    name: `Person ${String(i).padStart(2, "0")}`,
    email: `person-${i}@example.com`,
    role: i < 5 ? "admin" : "member",
    status: i === 24 ? "blocked" : "active",
    joinedAt: at,
    teams: i % 2 ? [] : [{ teamId: TEAM.id, name: TEAM.name, role: "member" }],
  }));

async function openPeople(page: Page, rpc: Record<string, RpcHandler> = {}) {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_A.id);
  return fakeHub(page, { signedIn: true, rpc: { ...withInvites(), ...rpc } });
}

test("thành viên v2: tìm, đếm facet, phân trang, sắp xếp và ẩn cột", async ({ page }) => {
  await openPeople(page, { "orgMembers/list": () => ok(manyMembers()) });
  await page.goto("/admin/members");
  await expect(page.getByRole("row")).toHaveCount(11);
  await expect(page.getByText("1–10 trên 25", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Trang sau" }).click();
  await expect(page.getByText("11–20 trên 25", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Người", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "Người" })).toHaveAttribute("aria-sort", "ascending");
  await page.getByRole("button", { name: "Vai trò", exact: true }).click();
  const roles = page.getByRole("dialog", { name: "Vai trò", exact: true });
  await expect(roles.locator("label").filter({ hasText: "Quản trị" })).toContainText("5");
  await expect(roles.locator("label").filter({ hasText: "Thành viên" })).toContainText("20");
  await roles.getByRole("checkbox", { name: "Quản trị", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(page.getByText("5 / 25 dòng khớp")).toBeVisible();
  await page.getByRole("button", { name: "Trạng thái", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Trạng thái", exact: true }).locator("label").filter({ hasText: "Đã khoá" }),
  ).toContainText("0");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Xoá hết bộ lọc" }).click();
  await page.getByRole("textbox", { name: "Tìm tên, email…" }).fill("person-24@example.com");
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("row", { name: /Person 24/ })).toContainText("Đã khoá");
  await page.getByRole("button", { name: "Cột", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Hoạt động gần nhất" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("columnheader", { name: "Hoạt động gần nhất" })).toHaveCount(0);
});

for (const mode of ["role", "team", "lock"] as const) {
  test(`thành viên v2: ${mode} hàng loạt có xác nhận và gửi đúng người`, async ({ page }) => {
    const hub = await openPeople(page, {
      "orgMembers/list": () => ok(manyMembers()),
      "orgMembers/setRole": (input) => ok(input),
      "orgMembers/setStatus": (input) => ok(input),
      "teamMembers/add": (input) => ok(input),
    });
    await page.goto("/admin/members");
    await page.getByRole("checkbox", { name: "Chọn Person 01", exact: true }).check();
    await page.getByRole("checkbox", { name: "Chọn Person 03", exact: true }).check();
    await page
      .getByRole("toolbar")
      .getByRole("button", { name: { role: "Đổi vai trò", team: "Thêm vào đội", lock: "Khoá" }[mode], exact: true })
      .click();
    const path = { role: "orgMembers/setRole", team: "teamMembers/add", lock: "orgMembers/setStatus" }[mode];
    expect(hub.rpcCalls.filter((call) => call.path === path)).toHaveLength(0);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Áp dụng cho 2 người đã chọn.");
    if (mode === "role") await dialog.getByLabel("Vai trò", { exact: true }).selectOption("member");
    if (mode === "team") await dialog.getByLabel("Đội", { exact: true }).selectOption(TEAM.id);
    await dialog.getByRole("button", { name: "Xác nhận" }).click();
    await expect(dialog).toBeHidden();
    const calls = hub.rpcCalls.filter((call) => call.path === path);
    expect(calls.map((call) => (call.input as { userId: string }).userId).sort()).toEqual(["person-1", "person-3"]);
    expect(calls.every((call) => call.org === ORG_A.id)).toBe(true);
    if (mode === "team") expect(calls[0]?.input).toMatchObject({ teamId: TEAM.id, role: "member" });
  });
}

for (const mode of ["approve", "deny"] as const) {
  test(`thành viên v2: ${mode} hàng loạt trong hàng chờ`, async ({ page }) => {
    const hub = await openPeople(page);
    await page.goto("/admin/members?xem=cho-duyet");
    await page.getByRole("checkbox", { name: "Chọn Đỗ Khoa", exact: true }).check();
    await page
      .getByRole("toolbar")
      .getByRole("button", { name: mode === "approve" ? "Duyệt" : "Từ chối", exact: true })
      .click();
    await page.getByRole("dialog").getByRole("button", { name: "Xác nhận" }).click();
    await expect(page.getByRole("row", { name: /Đỗ Khoa/ })).toHaveCount(0);
    expect(hub.rpcCalls.filter((call) => call.path === `orgMembers/${mode}`).map((call) => call.input)).toEqual([
      { userId: "u3" },
    ]);
  });
}

test("lời mời v2: chặn lời mời đã nhận, lỗi một phần chỉ thử lại mục lỗi", async ({ page }) => {
  let rejectExpired = true;
  let invites = [...INVITES];
  const hub = await openPeople(page, {
    "invitations/list": () => ok(invites),
    "invitations/revoke": (input) => {
      const id = (input as { invitationId: string }).invitationId;
      if (id === INVITES[2]?.id && rejectExpired) return fail("CONFLICT", 409, "Chưa thu hồi được lời mời này.");
      invites = invites.filter((inv) => inv.id !== id);
      return ok({ ok: true });
    },
  });
  await page.goto("/admin/members?xem=loi-moi");
  await page.getByRole("checkbox", { name: "Chọn cả trang" }).check();
  await expect(page.getByRole("toolbar").getByRole("button", { name: "Thu hồi", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Chọn minh.pham@example.com", exact: true }).uncheck();
  await page.getByRole("toolbar").getByRole("button", { name: "Thu hồi", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Thu hồi", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Chưa thu hồi được lời mời này.");
  await expect(dialog).toContainText("Thu hồi 1 lời mời đã chọn?");
  rejectExpired = false;
  await dialog.getByRole("button", { name: "Thu hồi", exact: true }).click();
  await expect(dialog).toBeHidden();
  const calls = hub.rpcCalls.filter((call) => call.path === "invitations/revoke");
  expect(calls.filter((call) => (call.input as { invitationId: string }).invitationId === INVITES[0]?.id)).toHaveLength(
    1,
  );
  expect(calls.filter((call) => (call.input as { invitationId: string }).invitationId === INVITES[2]?.id)).toHaveLength(
    2,
  );
});

for (const mode of ["role", "remove"] as const) {
  test(`đội v2: tìm, lọc vai trò và ${mode} hàng loạt`, async ({ page }) => {
    const hub = await openPeople(page, {
      "teamMembers/setRole": (input) => ok(input),
      "teamMembers/remove": () => ok({ ok: true }),
    });
    await page.goto("/admin/teams");
    await page.getByRole("textbox", { name: "Tìm người…" }).fill("ha.le");
    await expect(page.getByRole("row")).toHaveCount(2);
    await page.getByRole("button", { name: "Vai trò", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Vai trò", exact: true })
      .getByRole("checkbox", { name: "Quản trị đội", exact: true })
      .check();
    await page.keyboard.press("Escape");
    await page.getByRole("checkbox", { name: "Chọn Lê Hà", exact: true }).check();
    await page
      .getByRole("toolbar")
      .getByRole("button", { name: mode === "role" ? "Đổi vai trò" : "Gỡ khỏi đội", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    if (mode === "role") await dialog.getByLabel("Vai trò trong đội").selectOption("viewer");
    await dialog.getByRole("button", { name: "Xác nhận" }).click();
    await expect(dialog).toBeHidden();
    const path = mode === "role" ? "teamMembers/setRole" : "teamMembers/remove";
    expect(hub.rpcCalls.filter((call) => call.path === path).map((call) => call.input)).toEqual([
      { teamId: TEAM.id, userId: HA.userId, ...(mode === "role" ? { role: "viewer" } : {}) },
    ]);
  });
}

const SSO_CONFIGURED = {
  ...SSO_NONE,
  provider: {
    issuer: "https://idp.example.com",
    domain: "example.com",
    domainVerified: false,
    clientIdLastFour: "ab12",
  },
  domainVerification: null,
};
const TXT_RECORD = {
  domain: "example.com",
  recordName: "_xdev-hive-verification.example.com",
  recordValue: "hive-domain=test-verification-value",
  expiresAt: "2026-10-18T03:00:00.000Z",
  verified: false,
};

test("cài đặt đăng nhập v2: lấy và chép TXT, lỗi DNS, xác minh rồi gỡ SSO", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  let settings: unknown = SSO_CONFIGURED;
  let matches = false;
  const hub = await openPeople(page, {
    "ssoProviders/get": () => ok(settings),
    "ssoProviders/requestDomainVerification": () => {
      settings = { ...SSO_CONFIGURED, domainVerification: TXT_RECORD };
      return ok(settings);
    },
    "ssoProviders/checkDomainVerification": () => {
      if (!matches) return fail("BAD_REQUEST", 400, "Chưa tìm thấy bản ghi TXT khớp.");
      settings = { ...SSO_CONFIGURED, provider: { ...SSO_CONFIGURED.provider, domainVerified: true } };
      return ok(settings);
    },
    "ssoProviders/remove": () => {
      settings = SSO_NONE;
      return ok(settings);
    },
  });
  await page.goto("/admin/sign-in-settings");
  await page.getByRole("button", { name: "Lấy bản ghi TXT cho example.com" }).click();
  await expect(page.getByLabel("Tên bản ghi (TXT)")).toHaveValue(TXT_RECORD.recordName);
  await page.getByRole("button", { name: "Chép giá trị bản ghi TXT" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TXT_RECORD.recordValue);
  await page.getByRole("button", { name: "Kiểm tra", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Chưa tìm thấy bản ghi TXT khớp.");
  matches = true;
  await page.getByRole("button", { name: "Kiểm tra", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Đã xác minh tên miền example.com.");
  await page.getByRole("button", { name: "Gỡ SSO", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Gỡ SSO", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(hub.rpcCalls.filter((call) => call.path === "ssoProviders/remove")).toHaveLength(1);
});

for (const scheme of ["light", "dark"] as const) {
  test(`người và quyền v2: ảnh ${scheme}, song ngữ, bàn phím và 360px`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openPeople(page, {
      "orgMembers/list": () => ok(manyMembers()),
      "ssoProviders/get": () => ok({ ...SSO_CONFIGURED, domainVerification: TXT_RECORD }),
    });
    for (const [screen, route, title] of [
      ["members", "/admin/members", "Thành viên"],
      ["teams", "/admin/teams", "Đội và hệ thống"],
      ["sign-in-settings", "/admin/sign-in-settings", "Cài đặt đăng nhập"],
    ] as const) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(route);
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      if (screen === "members") await expect(page.getByRole("row")).toHaveCount(11);
      if (screen === "teams") await expect(page.getByRole("row", { name: /Lê Hà/ })).toBeVisible();
      if (screen === "sign-in-settings")
        await expect(page.getByLabel("Giá trị", { exact: true })).toHaveValue(TXT_RECORD.recordValue);
      await page.screenshot({ path: testInfo.outputPath(`${screen}-${scheme}.png`), fullPage: true });
      await page.setViewportSize({ width: 360, height: 800 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${screen}-360-${scheme}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/admin/members");
    const facet = page.locator('[data-slot="popover-trigger"]').filter({ hasText: /^Vai trò/ });
    await facet.focus();
    await page.keyboard.press("Enter");
    const option = page
      .getByRole("dialog", { name: "Vai trò", exact: true })
      .getByRole("checkbox", { name: "Quản trị", exact: true });
    await option.focus();
    await page.keyboard.press("Space");
    await expect(option).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(facet).toBeFocused();
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
    await expect(page.getByText("5 / 25 rows match")).toBeVisible();
    await page.getByRole("button", { name: "Invite people", exact: true }).click();
    await expect(page.getByRole("dialog").getByLabel("Email")).toBeFocused();
    await expect(page.getByRole("dialog").getByLabel("Organization role")).toHaveValue("member");
    await page.getByRole("dialog").getByRole("button", { name: "Create invitations" }).click();
    await expect(page.getByRole("dialog").getByText("Enter at least one email.")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto("/admin/teams");
    await expect(page.getByRole("heading", { name: "Teams & systems", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create team", exact: true }).click();
    await expect(page.getByRole("dialog").getByLabel("Slug")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Create team", exact: true }).click();
    await expect(page.getByRole("dialog").getByText("Enter a name.")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto("/admin/sign-in-settings");
    await expect(page.getByRole("heading", { name: "Sign-in settings", exact: true })).toBeVisible();
    await expect(page.getByLabel("Email domain")).toHaveValue("example.com");
    await expect(page.getByRole("button", { name: "Copy TXT record value" })).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Enter a Client ID.")).toBeVisible();
    await expect(page.getByLabel("When someone signs in with SSO for the first time")).toContainText(
      "Queue for approval (recommended)",
    );
  });
}
