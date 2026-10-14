import { expect, type Page, test } from "@playwright/test";
import {
  type AgentPolicy,
  type AgentPolicyInput,
  DEFAULT_AGENT_POLICY,
  SYSTEM_ROLE_PERMISSIONS,
} from "@xdev-hive/contracts";
import { fail, fakeHub, ok } from "./fake-hub.ts";

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
  // Hub giả giữ bản đã lưu như hub thật: lần lưu sau ghép trên bản của lần trước.
  let current = policy;
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
      "policies/get": () => ok(current),
      "policies/update": (input) => {
        current = { ...current, ...(input as object), updatedAt: "2026-10-12T09:00:00.000Z" };
        return ok(current);
      },
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

const section = (page: Page, name: string) => page.getByRole("group", { name, exact: true });

test("quản trị sửa từng mục và lưu riêng: mỗi lần lưu chỉ gửi ô của mục đó", async ({ page }) => {
  const hub = await setup(page, "admin", policyOf());
  await page.goto("/admin/policies");
  await expect(page.getByRole("heading", { name: "Chính sách agent", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Các mục chính sách" })).toBeVisible();
  // Không còn nút lưu chung ở đầu trang.
  await expect(page.getByRole("button", { name: "Lưu chính sách" })).toHaveCount(0);
  await expect(page.getByText("Lần gần nhất", { exact: false })).toContainText("mở 3 PR, 5 dự án đã đúng mẫu");
  const updates = () =>
    hub.rpcCalls.filter((c) => c.path === "policies/update").map((c) => c.input as AgentPolicyInput);

  // Giới hạn sửa dở, chưa lưu: lưu mục Model không được gửi kèm.
  const limits = section(page, "Giới hạn chung");
  await limits.getByRole("spinbutton", { name: "Trần mỗi run" }).fill("5");
  await expect(limits.getByText("Có thay đổi chưa lưu")).toBeVisible();

  // Model: thêm cho Claude Code bằng Enter (không lưu cả mục), Codex để trống là mọi model.
  const model = section(page, "Model");
  await expect(model.getByRole("button", { name: "Lưu" })).toBeDisabled();
  await model.getByRole("button", { name: "Model cho Claude Code" }).click();
  await model.getByRole("textbox", { name: "Model cho Claude Code" }).fill("claude-haiku-5-5");
  await model.getByRole("textbox", { name: "Model cho Claude Code" }).press("Enter");
  await expect(model.getByText("claude-haiku-5-5")).toBeVisible();
  expect(updates()).toHaveLength(0);
  await model.getByRole("switch", { name: "Không tự lên model đắt nhất" }).click();
  await model.getByRole("button", { name: "Lưu" }).click();
  await expect(model.getByText("Đã lưu.", { exact: false })).toBeVisible();
  expect(updates()).toHaveLength(1);
  expect(updates()[0]?.allowedModels.claude).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
  expect(updates()[0]?.neverAutoUpgrade).toBe(true);
  expect(updates()[0]?.limits.perRunUsd).toBeNull();
  // Mục Giới hạn vẫn giữ bản nháp sau khi mục khác lưu.
  await expect(limits.getByRole("spinbutton", { name: "Trần mỗi run" })).toHaveValue("5");

  // Hook mới, PreToolUse có matcher.
  const hooks = section(page, "Hooks");
  await hooks.getByRole("button", { name: "Thêm hook" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Tên" }).fill("Chặn xoá ngoài worktree");
  await dialog.getByRole("textbox", { name: "Lệnh" }).fill('hive-guard --deny "rm -rf /"');
  await dialog.getByRole("textbox", { name: "Tool cần khớp" }).fill("Bash");
  await dialog.getByRole("textbox", { name: "Tool cần khớp" }).press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(hooks.getByText("Chặn xoá ngoài worktree")).toBeVisible();
  // Enter trong hộp thoại chỉ đóng hộp, không lưu mục Hooks.
  expect(updates()).toHaveLength(1);
  await hooks.getByRole("button", { name: "Lưu" }).click();
  await expect(hooks.getByText("Đã lưu.", { exact: false })).toBeVisible();
  expect(updates()[1]?.hooks).toEqual([
    { event: "Stop", name: "Test nhanh", command: "pnpm check --affected" },
    { event: "PreToolUse", name: "Chặn xoá ngoài worktree", command: 'hive-guard --deny "rm -rf /"', matcher: "Bash" },
  ]);

  // Mẫu AGENTS.md sửa được; CLAUDE.md vẫn là mẫu chuẩn. Tab file đi bằng phím mũi tên.
  const templates = section(page, "File hướng dẫn agent");
  const agents = templates.getByRole("textbox", { name: "AGENTS.md" });
  await expect(agents).toHaveValue(DEFAULT_TEMPLATES.agents);
  await agents.fill("# {{project.key}}\n\nĐọc tài liệu qua MCP.\n");
  await expect(templates.getByText("Đã sửa", { exact: true })).toBeVisible();
  await templates.getByRole("tab", { name: "AGENTS.md" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(templates.getByRole("tab", { name: "CLAUDE.md" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(templates.getByRole("tab", { name: "CLAUDE.md" })).toHaveAttribute("aria-selected", "true");
  await expect(templates.getByText("Mẫu chuẩn", { exact: true })).toBeVisible();
  await templates.getByRole("switch", { name: "Mở PR khi mẫu đổi" }).click();
  await expect(templates.getByRole("button", { name: "Mở PR ngay" })).toBeDisabled();
  await templates.getByRole("button", { name: "Lưu" }).click();
  await expect(templates.getByText("Đã lưu.", { exact: false })).toBeVisible();
  expect(updates()[2]?.templates).toEqual({
    agents: "# {{project.key}}\n\nĐọc tài liệu qua MCP.\n",
    claude: null,
    mcp: null,
  });
  expect(updates()[2]?.autoSyncTemplates).toBe(true);

  // Giới hạn: đơn vị nằm trong ô; lưu gửi cả bản nháp đã gõ từ đầu.
  await limits.getByRole("spinbutton", { name: "Trần mỗi ngày của tổ chức" }).fill("80");
  await limits.getByRole("combobox", { name: "Giữ log run" }).selectOption("90");
  await limits.getByRole("button", { name: "Lưu" }).click();
  await expect(limits.getByText("Đã lưu.", { exact: false })).toBeVisible();
  expect(updates()[3]?.limits).toEqual({
    perRunUsd: 5,
    dailyUsd: 80,
    maxParallelPerMachine: null,
    runLogRetentionDays: 90,
  });
  // Mục lưu trước vẫn còn trong bản gửi sau (ghép trên bản hub đang giữ).
  expect(updates()[3]?.neverAutoUpgrade).toBe(true);

  // Memory agent ghi: mặc định đề xuất chờ duyệt, đổi sang ghi thẳng và nâng trần mỗi run.
  const memory = section(page, "Memory do agent ghi");
  await expect(memory.getByRole("radio", { name: /Đề xuất chờ duyệt/ })).toBeChecked();
  await memory.getByRole("radio", { name: /Ghi thẳng/ }).check();
  await memory.getByRole("spinbutton", { name: "Số memory tối đa mỗi run" }).fill("80");
  await expect(memory.getByText("Nhập số nguyên từ 1 đến 50", { exact: false })).toBeVisible();
  await memory.getByRole("spinbutton", { name: "Số memory tối đa mỗi run" }).fill("8");
  await memory.getByRole("button", { name: "Lưu" }).click();
  await expect(memory.getByText("Đã lưu.", { exact: false })).toBeVisible();
  expect(updates()[4]?.agentMemory).toEqual({ mode: "direct", maxPerRun: 8 });

  // Học skill từ việc khó: mặc định tắt (tốn token); bật rồi đặt hạn mức đề xuất mỗi ngày.
  const learning = section(page, "Học skill từ việc khó");
  await expect(learning.getByRole("switch", { name: "Bật học skill" })).not.toBeChecked();
  await expect(learning.getByRole("spinbutton", { name: "Số đề xuất tối đa mỗi ngày" })).toBeDisabled();
  await learning.getByRole("switch", { name: "Bật học skill" }).click();
  await learning.getByRole("spinbutton", { name: "Số đề xuất tối đa mỗi ngày" }).fill("3");
  await learning.getByRole("button", { name: "Lưu" }).click();
  await expect(learning.getByText("Đã lưu.", { exact: false })).toBeVisible();
  expect(updates()[5]?.skillLearning).toEqual({ enabled: true, maxPerDay: 3 });
  expect(updates()).toHaveLength(6);
});

test("Huỷ chỉ trả lại mục đó; rời trang khi còn mục chưa lưu thì hỏi lại", async ({ page }) => {
  const hub = await setup(page, "admin", policyOf());
  await page.goto("/admin/policies");
  const perm = section(page, "Quyền CLI");
  await perm.getByRole("switch", { name: "Bắt buộc sandbox" }).click();
  const limits = section(page, "Giới hạn chung");
  await limits.getByRole("spinbutton", { name: "Trần mỗi run" }).fill("7");
  await limits.getByRole("button", { name: "Huỷ" }).click();
  await expect(limits.getByRole("spinbutton", { name: "Trần mỗi run" })).toHaveValue("");
  await expect(perm.getByRole("switch", { name: "Bắt buộc sandbox" })).toBeChecked();

  await page
    .getByRole("navigation", { name: "Điều hướng quản trị" })
    .getByRole("link", { name: "Vai trò và quyền" })
    .click();
  const leave = page.getByRole("dialog", { name: "Rời trang khi còn thay đổi chưa lưu?" });
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Ở lại" }).click();
  await expect(page).toHaveURL(/\/admin\/policies$/);
  await perm.getByRole("button", { name: "Lưu" }).click();
  await expect(perm.getByText("Đã lưu.", { exact: false })).toBeVisible();
  expect(hub.rpcCalls.filter((c) => c.path === "policies/update")).toHaveLength(1);
});

test("chọn toàn quyền làm mặc định phải xác nhận", async ({ page }) => {
  const hub = await setup(page, "owner", policyOf());
  await page.goto("/admin/policies");
  const perm = section(page, "Quyền CLI");
  await perm.getByRole("radio", { name: /Toàn quyền/ }).click();
  const confirm = page.getByRole("dialog", { name: "Để dự án mới chạy toàn quyền?" });
  await confirm.getByRole("button", { name: "Giữ trong worktree" }).click();
  await expect(perm.getByRole("radio", { name: /Trong worktree/ })).toBeChecked();
  await perm.getByRole("radio", { name: /Toàn quyền/ }).click();
  await confirm.getByRole("button", { name: "Chọn toàn quyền" }).click();
  await expect(perm.getByRole("radio", { name: /Toàn quyền/ })).toBeChecked();
  await perm.getByRole("button", { name: "Lưu" }).click();
  await expect(perm.getByText("Đã lưu.", { exact: false })).toBeVisible();
  const saved = hub.rpcCalls.find((c) => c.path === "policies/update")?.input as AgentPolicyInput;
  expect(saved.defaultPermissionMode).toBe("full");
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
  await expect(page.getByRole("radio", { name: /Toàn quyền/ })).toBeDisabled();
});

test("thành viên chỉ xem chính sách", async ({ page }) => {
  await setup(page, "member", policyOf(), []);
  await page.goto("/admin/policies");
  await expect(page.getByRole("note")).toContainText("Bạn chỉ xem được chính sách.");
  await expect(page.getByRole("button", { name: "Lưu", exact: true })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Bắt buộc sandbox" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Thêm hook" })).toHaveCount(0);
});

test("lỗi tải hiện nút tải lại", async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_ID);
  let broken = true;
  await fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [
            {
              id: ORG_ID,
              slug: "acme",
              name: "Acme",
              role: "admin",
              emailDomain: null,
              createdAt: "2026-10-01T00:00:00.000Z",
            },
          ],
          canCreateOrg: false,
        }),
      "inbox/unreadCount": () => ok({ count: 0 }),
      "roles/mine": () => ok({ permissions: [...SYSTEM_ROLE_PERMISSIONS.admin] }),
      "policies/get": () => {
        if (broken) {
          broken = false;
          return fail("FORBIDDEN", 403, "Hub từ chối đọc chính sách.");
        }
        return ok(policyOf());
      },
    },
  });
  await page.goto("/admin/policies");
  await expect(page.getByText("Hub từ chối đọc chính sách.")).toBeVisible();
  await page.getByRole("button", { name: "Tải lại" }).click();
  await expect(page.getByRole("group", { name: "Model", exact: true })).toBeVisible();
});

test("tiếng Anh", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
  await setup(page, "owner", policyOf());
  await page.goto("/admin/policies");
  await expect(page.getByRole("heading", { name: "Agent policies", level: 1 })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Only run organization hooks" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Global limits" })).toBeVisible();
});

for (const width of [1440, 1100, 360] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`chính sách: ${width}px ${scheme}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      if (width === 1100) await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
      await setup(page, "admin", policyOf());
      await page.goto("/admin/policies");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`policies-${width}-${scheme}.png`), fullPage: true });
    });
  }
}
