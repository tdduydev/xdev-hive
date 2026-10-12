import { expect, type Page, test } from "@playwright/test";
import {
  type AgentPolicy,
  type AgentPolicyInput,
  DEFAULT_AGENT_POLICY,
  SYSTEM_ROLE_PERMISSIONS,
} from "@xdev-hive/contracts";
import { fakeHub, ok } from "./fake-hub.ts";

const ORG_ID = "0a0a0a0a-0000-4000-8000-00000000000a";
const DEFAULT_TEMPLATES = {
  agents: "# {{project.name}}\n\nHive project key: `{{project.key}}`\n",
  claude: "@AGENTS.md\n",
  mcp: '{\n  "mcpServers": {}\n}\n',
};

function policyOf(patch: Partial<AgentPolicyInput> = {}): AgentPolicy {
  return {
    ...DEFAULT_AGENT_POLICY,
    allowedModels: { claude: ["claude-sonnet-5-5"], codex: [], gemini: [] },
    hooks: [{ event: "Stop", name: "Test nhanh", command: "pnpm check --affected" }],
    ...patch,
    updatedAt: "2026-10-12T08:00:00.000Z",
    updatedBy: "u1",
    templateSync: { at: "2026-10-12T08:00:00.000Z", opened: 3, unchanged: 5, failed: [] },
    defaultTemplates: DEFAULT_TEMPLATES,
  } as AgentPolicy;
}

async function setup(page: Page, role: "owner" | "admin" | "member", policy: AgentPolicy, mine?: string[]) {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_ID);
  return fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [
            { id: ORG_ID, slug: "acme", name: "Acme", role, emailDomain: null, createdAt: "2026-10-01T00:00:00.000Z" },
          ],
          canCreateOrg: false,
        }),
      "inbox/unreadCount": () => ok({ count: 0 }),
      "roles/mine": () => ok({ permissions: mine ?? [...SYSTEM_ROLE_PERMISSIONS[role]] }),
      "policies/get": () => ok(policy),
      "policies/update": (input) => ok({ ...policy, ...(input as object), updatedAt: "2026-10-12T09:00:00.000Z" }),
      "policies/preview": (input) =>
        ok({
          project: { key: (input as { project?: string }).project ?? "payment-api", name: "payment-api" },
          files: [
            { path: "AGENTS.md", content: "# payment-api\n\nĐọc tài liệu qua MCP." },
            { path: "CLAUDE.md", content: "@AGENTS.md\n" },
            { path: ".mcp.json", content: "{}\n" },
          ],
        }),
      "policies/syncTemplates": () => ok({ queued: true }),
    },
  });
}

test("quản trị sửa model, hook, mẫu file, giới hạn rồi lưu đúng chính sách", async ({ page }) => {
  const hub = await setup(page, "admin", policyOf());
  await page.goto("/admin/policies");
  await expect(page.getByRole("heading", { name: "Chính sách agent", level: 1 })).toBeVisible();
  await expect(page.getByText("Lần gần nhất", { exact: false })).toContainText("mở 3 PR, 5 dự án đã đúng mẫu");

  // Model: thêm cho Claude Code, Codex để trống là mọi model.
  await page.getByRole("button", { name: "Model cho Claude Code" }).click();
  await page.getByRole("textbox", { name: "Model cho Claude Code" }).fill("claude-haiku-5-5");
  await page.getByRole("button", { name: "Thêm", exact: true }).click();
  await expect(page.getByText("claude-haiku-5-5")).toBeVisible();
  await page.getByRole("switch", { name: "Không tự lên model đắt nhất" }).click();

  // Hook mới, PreToolUse có matcher.
  await page.getByRole("button", { name: "Thêm hook" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Tên" }).fill("Chặn xoá ngoài worktree");
  await dialog.getByRole("textbox", { name: "Lệnh" }).fill('hive-guard --deny "rm -rf /"');
  await dialog.getByRole("textbox", { name: "Tool cần khớp" }).fill("Bash");
  await dialog.getByRole("button", { name: "Xong" }).click();
  await expect(page.getByText("Chặn xoá ngoài worktree")).toBeVisible();

  // Mẫu AGENTS.md sửa được; CLAUDE.md vẫn là mẫu chuẩn.
  const agents = page.getByRole("textbox", { name: "AGENTS.md" });
  await expect(agents).toHaveValue(DEFAULT_TEMPLATES.agents);
  await agents.fill("# {{project.key}}\n\nĐọc tài liệu qua MCP.\n");
  await expect(page.getByText("Đã sửa", { exact: true })).toBeVisible();
  await page.getByRole("switch", { name: "Mở PR khi mẫu đổi" }).click();

  await page.getByRole("spinbutton", { name: "Trần mỗi run" }).fill("5");
  await page.getByRole("spinbutton", { name: "Trần mỗi ngày của tổ chức" }).fill("80");
  await page.getByRole("combobox", { name: "Giữ log run" }).selectOption("90");

  await expect(page.getByText("Có thay đổi chưa lưu.")).toBeVisible();
  await page.getByRole("button", { name: "Lưu chính sách" }).click();
  await expect(page.getByText("Đã lưu chính sách.")).toBeVisible();
  const saved = hub.rpcCalls.find((c) => c.path === "policies/update")?.input as AgentPolicyInput;
  expect(saved.allowedModels.claude).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
  expect(saved.neverAutoUpgrade).toBe(true);
  expect(saved.hooks).toEqual([
    { event: "Stop", name: "Test nhanh", command: "pnpm check --affected" },
    { event: "PreToolUse", name: "Chặn xoá ngoài worktree", command: 'hive-guard --deny "rm -rf /"', matcher: "Bash" },
  ]);
  expect(saved.templates).toEqual({ agents: "# {{project.key}}\n\nĐọc tài liệu qua MCP.\n", claude: null, mcp: null });
  expect(saved.autoSyncTemplates).toBe(true);
  expect(saved.limits).toEqual({ perRunUsd: 5, dailyUsd: 80, maxParallelPerMachine: null, runLogRetentionDays: 90 });
});

test("xem file sinh ra theo dự án và mở PR ngay", async ({ page }) => {
  const hub = await setup(page, "admin", policyOf());
  await page.goto("/admin/policies");
  await page.getByRole("button", { name: "Xem file sinh ra" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Đọc tài liệu qua MCP.")).toBeVisible();
  await dialog.getByRole("textbox", { name: "Dự án" }).fill("payment-api");
  await dialog.getByRole("button", { name: "Xem" }).click();
  await dialog.getByRole("tab", { name: ".mcp.json" }).click();
  await expect(dialog.getByText("{}")).toBeVisible();
  expect(hub.rpcCalls.filter((c) => c.path === "policies/preview").at(-1)?.input).toMatchObject({
    project: "payment-api",
  });
  await dialog.getByRole("button", { name: "Đóng" }).click();
  await page.getByRole("button", { name: "Mở PR ngay" }).click();
  await expect(page.getByText("Đã xếp việc mở PR cho các dự án.")).toBeVisible();
});

test("quản trị không có quyền toàn quyền CLI không mở lại được công tắc đã tắt", async ({ page }) => {
  await setup(page, "admin", policyOf({ allowFullPermission: false }));
  await page.goto("/admin/policies");
  await expect(page.getByRole("switch", { name: "Cho dự án bật toàn quyền" })).toBeDisabled();
  await expect(page.getByText("mặc định chỉ owner", { exact: false })).toBeVisible();
});

test("thành viên chỉ xem chính sách", async ({ page }) => {
  await setup(page, "member", policyOf(), []);
  await page.goto("/admin/policies");
  await expect(page.getByText("Bạn chỉ xem được chính sách.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Lưu chính sách" })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Bắt buộc sandbox" })).toBeDisabled();
});

test("tiếng Anh", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
  await setup(page, "owner", policyOf());
  await page.goto("/admin/policies");
  await expect(page.getByRole("heading", { name: "Agent policies", level: 1 })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Only run organization hooks" })).toBeVisible();
  await expect(page.getByText("Global limits")).toBeVisible();
});
