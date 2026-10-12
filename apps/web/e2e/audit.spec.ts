import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import type { AuditLogItem, AuditQueryInput, AuditRetention, AuditRetentionInput } from "@xdev-hive/contracts";
import { fail, fakeAuditExport, fakeHub, ok, type RpcHandler } from "./fake-hub.ts";

const ORG = {
  id: "0a0a0a0a-0000-4000-8000-00000000000a",
  slug: "audit",
  name: "Audit Org",
  role: "owner",
  emailDomain: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};
const rows: AuditLogItem[] = Array.from({ length: 25 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  createdAt: new Date(Date.UTC(2026, 9, 12, 9, i)).toISOString(),
  actorId: i % 2 ? "run-audit" : "u1",
  actor: i % 2 ? "run audit" : "Trần Lan",
  actorType: i % 2 ? "run" : "user",
  action: i % 2 ? "memory.write" : "team.create",
  area: i % 2 ? "know" : "people",
  targetType: "project",
  targetId: `payment-api-${i}`,
  result: i === 3 ? "denied" : "ok",
  source: i % 2 ? "mcp" : "web",
  ip: "10.0.0.7",
}));
const list: RpcHandler = (raw) => {
  const input = raw as AuditQueryInput;
  const matching = rows.filter(
    (row) =>
      (!input.actorType || row.actorType === input.actorType) &&
      (!input.area || row.area === input.area) &&
      (!input.source || row.source === input.source) &&
      (!input.result || row.result === input.result) &&
      (!input.action || row.action === input.action) &&
      (!input.actorId || row.actorId === input.actorId) &&
      (!input.q || `${row.actor} ${row.targetId} ${row.ip}`.includes(input.q)),
  );
  const start = input.cursor ? 20 : 0;
  return ok({
    items: matching.slice(start, start + 20),
    nextCursor: matching.length > start + 20 ? "next-page" : null,
  });
};
async function setup(
  page: Page,
  opts: { role?: string; list?: RpcHandler; setRetention?: RpcHandler; rpc?: Record<string, RpcHandler> } = {},
) {
  let retention: AuditRetention = { retentionDays: 365, updatedAt: null };
  return fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () => ok({ orgs: [{ ...ORG, role: opts.role ?? ORG.role }], canCreateOrg: false }),
      "audit/list": opts.list ?? list,
      "audit/retention": () => ok(retention),
      "audit/setRetention":
        opts.setRetention ??
        ((input) => {
          retention = { ...(input as AuditRetentionInput), updatedAt: "2026-10-12T10:00:00.000Z" };
          return ok(retention);
        }),
      "inbox/unreadCount": () => ok({ count: 0 }),
      ...opts.rpc,
    },
  });
}

test("server filters compose and cursor navigation sends the selected organization", async ({ page }) => {
  const hub = await setup(page);
  await page.goto("/admin/audit");
  await expect(page.getByRole("heading", { name: "Nhật ký" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "payment-api" })).toHaveCount(20);
  await page.getByRole("button", { name: "Trang sau của nhật ký" }).click();
  await expect(page.getByRole("row").filter({ hasText: "payment-api" })).toHaveCount(5);
  expect(hub.rpcCalls.filter((c) => c.path === "audit/list").at(-1)).toMatchObject({
    org: ORG.id,
    input: { cursor: "next-page" },
  });
  await expect(page.getByRole("button", { name: "Trang sau của nhật ký" })).toBeDisabled();
  await page.getByRole("button", { name: "Trang trước của nhật ký" }).click();
  await expect(page.getByRole("row").filter({ hasText: "payment-api" })).toHaveCount(20);
  await expect(page.getByRole("button", { name: "Trang trước của nhật ký" })).toBeDisabled();
  await page.getByLabel("Loại người làm", { exact: true }).selectOption("run");
  await expect(page.getByRole("row").filter({ hasText: "payment-api" })).toHaveCount(12);
  await page.getByLabel("Nhóm", { exact: true }).selectOption("know");
  await page.getByLabel("Nguồn", { exact: true }).selectOption("mcp");
  await page.getByLabel("Kết quả", { exact: true }).selectOption("denied");
  await expect(page.getByRole("row").filter({ hasText: "payment-api" })).toHaveCount(1);
  await expect(page.getByRole("row").filter({ hasText: "payment-api" })).toContainText("Bị từ chối");
  await page.getByLabel("Người làm", { exact: true }).fill("run-audit");
  await page.getByLabel("Hành động", { exact: true }).fill("memory.write");
  await page.getByLabel("Tìm đối tượng, người làm, IP…", { exact: true }).fill("10.0.0.7");
  await page.getByRole("button", { name: "30 ngày", exact: true }).click();
  await expect
    .poll(() => hub.rpcCalls.filter((c) => c.path === "audit/list").at(-1)?.input)
    .toEqual({
      range: 30,
      limit: 20,
      actorType: "run",
      area: "know",
      source: "mcp",
      result: "denied",
      actorId: "run-audit",
      action: "memory.write",
      q: "10.0.0.7",
    });
  await page.getByRole("button", { name: "Xoá hết bộ lọc", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "payment-api" })).toHaveCount(20);
});

test("exports CSV and JSON with the current server filters", async ({ page }, testInfo) => {
  const hub = await setup(page);
  await fakeAuditExport(
    page,
    hub,
    ({ format }) =>
      new File(
        [format === "json" ? JSON.stringify([rows[0]]) : "timestamp,actor\r\n2026-10-12,Trần Lan\r\n"],
        `audit.${format}`,
        { type: format === "json" ? "application/json" : "text/csv" },
      ),
  );
  await page.goto("/admin/audit");
  await page.getByLabel("Tìm đối tượng, người làm, IP…", { exact: true }).fill("payment-api-0");
  for (const format of ["CSV", "JSON"]) {
    const waiting = page.waitForEvent("download");
    await page.getByRole("button", { name: `Xuất ${format}`, exact: true }).click();
    const download = await waiting;
    expect(download.suggestedFilename()).toBe(`audit.${format.toLowerCase()}`);
    const path = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(path);
    const content = await readFile(path, "utf8");
    if (format === "JSON") expect(JSON.parse(content)).toEqual([rows[0]]);
    else expect(content).toBe("timestamp,actor\r\n2026-10-12,Trần Lan\r\n");
    expect(hub.rpcCalls.filter((c) => c.path === "audit/export").at(-1)?.input).toMatchObject({
      q: "payment-api-0",
      format: format.toLowerCase(),
      range: 7,
    });
  }
});

test("administrator sees loading state and export errors", async ({ page }) => {
  await setup(page, { role: "admin" });
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/audit/list**", async (route) => {
    await pending;
    await route.fulfill(ok({ items: rows.slice(0, 20), nextCursor: "next-page" }));
  });
  await page.goto("/admin/audit");
  await expect(page.getByRole("status").filter({ hasText: "Đang tải…" })).toBeVisible();
  release();
  await expect(page.getByRole("row").filter({ hasText: "payment-api" })).toHaveCount(20);
  await page.route("**/rpc/audit/export", (route) =>
    route.fulfill(fail("FORBIDDEN", 403, "Bạn không có quyền xuất nhật ký.")),
  );
  await page.getByRole("button", { name: "Xuất CSV", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Bạn không có quyền xuất nhật ký.");
});

test("owner shortens retention after a warning and the change goes to the selected organization", async ({ page }) => {
  const hub = await setup(page);
  await page.goto("/admin/audit");
  await expect(page.getByText("Mọi thao tác của người, agent và hub. Chỉ đọc, giữ 365 ngày.")).toBeVisible();
  const save = page.getByRole("button", { name: "Lưu thời hạn", exact: true });
  await expect(page.getByLabel("Thời hạn lưu", { exact: true })).toHaveValue("365");
  await expect(save).toBeDisabled();
  await page.getByLabel("Thời hạn lưu", { exact: true }).selectOption("90");
  await expect(page.getByText("Nhật ký cũ hơn 90 ngày sẽ bị xoá vĩnh viễn ở lần dọn tiếp theo")).toBeVisible();
  const listCalls = hub.rpcCalls.filter((c) => c.path === "audit/list").length;
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "Đã lưu thời hạn lưu." })).toBeVisible();
  expect(hub.rpcCalls.filter((c) => c.path === "audit/setRetention")).toEqual([
    expect.objectContaining({ org: ORG.id, input: { retentionDays: 90 } }),
  ]);
  await expect(page.getByText("Mọi thao tác của người, agent và hub. Chỉ đọc, giữ 90 ngày.")).toBeVisible();
  await expect(page.getByText("Nhật ký cũ hơn 90 ngày")).toHaveCount(0);
  await expect(save).toBeDisabled();
  // Lần đổi ghi một dòng nhật ký mới, nên danh sách được tải lại.
  await expect.poll(() => hub.rpcCalls.filter((c) => c.path === "audit/list").length).toBeGreaterThan(listCalls);
  await page.getByLabel("Thời hạn lưu", { exact: true }).selectOption("730");
  await expect(page.getByText("Nhật ký cũ hơn")).toHaveCount(0);
});

test("retention errors from the hub are shown and nothing changes", async ({ page }) => {
  await setup(page, {
    role: "admin",
    setRetention: () => fail("BAD_REQUEST", 400, "Thời hạn lưu tối thiểu 90 ngày."),
  });
  await page.goto("/admin/audit");
  await page.getByLabel("Thời hạn lưu", { exact: true }).selectOption("180");
  await page.getByRole("button", { name: "Lưu thời hạn", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Thời hạn lưu tối thiểu 90 ngày.");
  await expect(page.getByText("Chỉ đọc, giữ 365 ngày.")).toBeVisible();
});

test("auditors with audit.read see the retention but cannot change it", async ({ page }) => {
  const hub = await setup(page, {
    role: "member",
    rpc: { "roles/mine": () => ok({ permissions: ["audit.read"] }) },
  });
  await page.goto("/admin/audit");
  await expect(page.getByText("Chỉ đọc, giữ 365 ngày.")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "payment-api" })).toHaveCount(20);
  await expect(page.getByLabel("Thời hạn lưu", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Xuất CSV" })).toHaveCount(0);
  expect(hub.rpcCalls.some((c) => c.path === "audit/setRetention")).toBe(false);
});

test("members see a permission message without audit requests or export controls", async ({ page }) => {
  const hub = await setup(page, { role: "member" });
  await page.goto("/admin/audit");
  await expect(page.getByRole("alert")).toContainText("Chỉ chủ sở hữu và quản trị tổ chức");
  await expect(page.getByRole("button", { name: "Xuất CSV" })).toHaveCount(0);
  expect(hub.rpcCalls.some((c) => c.path.startsWith("audit/"))).toBe(false);
  await expect(page.getByRole("navigation").getByRole("link", { name: "Nhật ký", exact: true })).toHaveCount(0);
});

test("empty, API denial, failure and retry", async ({ page }) => {
  let status = "empty";
  await setup(page, {
    list: () =>
      status === "empty"
        ? ok({ items: [], nextCursor: null })
        : status === "denied"
          ? fail("FORBIDDEN", 403, "Bạn không có quyền xem nhật ký.")
          : status === "error"
            ? fail("INTERNAL_SERVER_ERROR", 500, "Không tải được nhật ký.")
            : list({ range: 7, limit: 20 }, {} as never, {} as never),
  });
  await page.goto("/admin/audit");
  await expect(page.getByText("Không có dòng nào khớp bộ lọc.", { exact: true })).toBeVisible();
  status = "denied";
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Bạn không có quyền xem nhật ký.");
  status = "error";
  await page.getByRole("button", { name: "Thử lại" }).click();
  await expect(page.getByRole("alert")).toContainText("Không tải được nhật ký.");
  status = "ok";
  await page.getByRole("button", { name: "Thử lại" }).click();
  await expect(page.getByRole("row").filter({ hasText: "payment-api" })).toHaveCount(20);
});

for (const theme of ["light", "dark"] as const) {
  test(`360px ${theme}: Vietnamese/English, keyboard and screenshot`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ colorScheme: theme });
    await setup(page);
    await page.goto("/admin/audit");
    await expect(page.getByRole("row").filter({ hasText: "payment-api" })).toHaveCount(20);
    await expect(page.getByRole("heading", { name: "Nhật ký" })).toBeVisible();
    await page.getByRole("button", { name: "30 ngày", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "30 ngày", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`audit-${theme}-vi.png`), fullPage: true });
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Export CSV" })).toBeVisible();
    await expect(page.getByLabel("Actor type", { exact: true })).toBeVisible();
    await expect(page.getByText("Read-only, kept for 365 days.")).toBeVisible();
    await expect(page.getByLabel("Retention", { exact: true })).toHaveValue("365");
    await expect(page.getByRole("button", { name: "Save retention", exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`audit-${theme}-en.png`), fullPage: true });
  });
}
