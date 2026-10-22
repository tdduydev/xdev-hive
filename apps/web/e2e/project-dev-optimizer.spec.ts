import { expect, type Page, test } from "@playwright/test";
import { ok, type RpcHandler, USER } from "./fake-hub.ts";
import { inOrg, TEAM_ID } from "./reviews-fixture.ts";

const NOW = "2026-10-22T03:00:00.000Z";
const PROJECT = {
  id: "9a9a9a9a-0000-4000-8000-000000000001",
  systemId: "5e5e5e5e-0000-4000-8000-000000000001",
  teamId: TEAM_ID,
  key: "PAY",
  name: "payment-api",
  state: "active",
  repo: {
    mode: "existing",
    connectionId: "c0c0c0c0-0000-4000-8000-000000000001",
    kind: "github",
    owner: "acme",
    name: "payment-api",
    defaultBranch: "main",
    visibility: "private",
    httpUrl: null,
    sshUrl: null,
    webUrl: null,
  },
  settings: {
    merge: { mode: "review", requiredApprovals: 1 },
    outcome: { default: [], byType: {} },
    features: { planMode: false, crossReview: false, mergeQueue: false, leaderChat: false, sandbox: false },
    issueIntake: { enabled: false, label: "hive", mention: "hive" },
    brief: { auto: true, refreshCommits: 50, refreshDays: 7 },
  },
  createdBy: "u1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

/** Người đăng nhập là `role` của đội sở hữu dự án; vai trò tổ chức là member để quyền chỉ đến từ đội. */
const orgMembers = (role: "admin" | "member") => [
  {
    userId: USER.id,
    name: USER.name,
    email: USER.email,
    image: USER.image,
    role: "member",
    status: "active",
    joinedAt: NOW,
    teams: [{ teamId: TEAM_ID, name: "Thanh toán", role }],
  },
];

const POLICY = {
  level: "aggressive",
  rtk: true,
  codegraph: false,
  autoCompactWindow: 200_000,
  contextBudgetTokens: 3_000,
  memoryAutoSync: true,
  memorySyncMinutes: 30,
};

function scenario(role: "admin" | "member", devOptimizer: unknown = null) {
  let settings: Record<string, unknown> = { ...PROJECT.settings, devOptimizer };
  const rpc: Record<string, RpcHandler> = {
    "orgMembers/list": () => ok(orgMembers(role)),
    "projects/list": () => ok([{ ...PROJECT, settings }]),
    "projects/updateSettings": (input) => {
      settings = { ...settings, ...(input as { settings: object }).settings };
      return ok(settings);
    },
  };
  return rpc;
}

const section = (page: Page) => page.getByRole("group", { name: "Tối ưu máy dev" });

test("quản trị đặt chính sách máy dev, lưu cả khối rồi bỏ chính sách", async ({ page }) => {
  const hub = await inOrg(page, "member", scenario("admin"));
  await page.goto("/projects/PAY/settings#devOptimizer");

  const policy = section(page);
  await expect(policy).toContainText("chỉ áp cho máy dev");
  await expect(policy).toContainText("Run hub dùng mục Tiết kiệm token");
  // Chưa đặt chính sách: các ô khoá cho tới khi bật công tắc.
  await expect(policy.getByLabel("Mức tối ưu")).toBeDisabled();
  await expect(policy.getByRole("button", { name: "Lưu", exact: true })).toBeDisabled();

  await policy.getByRole("switch", { name: "Đặt chính sách cho dự án" }).click();
  await policy.getByLabel("Mức tối ưu").selectOption("aggressive");
  await policy.getByRole("switch", { name: "Dùng RTK trên máy dev" }).click();
  await policy.getByRole("textbox", { name: "Ngân sách ngữ cảnh từ hub" }).fill("9000");
  await policy.getByRole("button", { name: "Lưu", exact: true }).click();
  // Ngoài khoảng của hợp đồng: báo ở ô, không gọi hub.
  await expect(policy).toContainText("Tối đa 8.000 token.");
  expect(hub.rpcCalls.filter((c) => c.path === "projects/updateSettings")).toHaveLength(0);

  await policy.getByRole("textbox", { name: "Ngân sách ngữ cảnh từ hub" }).fill("3000");
  await policy.getByRole("textbox", { name: "Cửa sổ ngữ cảnh trước khi nén" }).fill("200000");
  await policy.getByRole("switch", { name: "Tự đồng bộ memory từ hub" }).click();
  await policy.getByRole("textbox", { name: "Chu kỳ đồng bộ memory" }).fill("30");
  await policy.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect
    .poll(() => hub.rpcCalls.find((c) => c.path === "projects/updateSettings")?.input)
    .toEqual({
      key: "PAY",
      settings: { devOptimizer: POLICY },
    });
  await expect(policy.getByText("Đã lưu")).toBeVisible();

  await policy.getByRole("switch", { name: "Đặt chính sách cho dự án" }).click();
  await policy.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect
    .poll(() => hub.rpcCalls.filter((c) => c.path === "projects/updateSettings").at(-1)?.input)
    .toEqual({ key: "PAY", settings: { devOptimizer: null } });
});

test("người không phải quản trị thấy chính sách ở dạng chỉ đọc", async ({ page }) => {
  const hub = await inOrg(page, "member", scenario("member", POLICY));
  await page.goto("/projects/PAY/settings#devOptimizer");

  const policy = section(page);
  await expect(policy).toContainText("Chỉ quản trị đội hoặc tổ chức đổi được chính sách này.");
  await expect(policy.getByRole("switch", { name: "Đặt chính sách cho dự án" })).toBeChecked();
  await expect(policy.getByRole("switch", { name: "Đặt chính sách cho dự án" })).toBeDisabled();
  await expect(policy.getByLabel("Mức tối ưu")).toHaveValue("aggressive");
  await expect(policy.getByLabel("Mức tối ưu")).toBeDisabled();
  await expect(policy.getByRole("textbox", { name: "Ngân sách ngữ cảnh từ hub" })).toHaveValue("3000");
  await expect(policy.getByRole("textbox", { name: "Ngân sách ngữ cảnh từ hub" })).toBeDisabled();
  await expect(policy.getByRole("button", { name: "Lưu", exact: true })).toHaveCount(0);
  expect(hub.rpcCalls.filter((c) => c.path === "projects/updateSettings")).toHaveLength(0);
});
