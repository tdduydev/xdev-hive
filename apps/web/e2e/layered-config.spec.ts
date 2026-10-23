import { expect, test } from "@playwright/test";
import {
  defaultProjectSettings,
  type EffectiveSetting,
  type OrgEntry,
  SYSTEM_ROLE_PERMISSIONS,
} from "@xdev-hive/contracts";
import { fail, fakeHub, ok } from "./fake-hub.ts";

const orgId = "0a0a0a0a-0000-4000-8000-00000000000a";
const projectId = "9a9a9a9a-0000-4000-8000-000000000001";
const teamId = "7e7e7e7e-0000-4000-8000-000000000001";
const at = "2026-10-23T00:00:00.000Z";

test("tổ chức đặt và khoá cấu hình; dự án thấy nguồn và trở về kế thừa", async ({ page }) => {
  let entry: OrgEntry = {
    key: "merge.mode",
    value: "review",
    locked: false,
    version: 1,
    updatedAt: at,
    updatedBy: null,
  };
  let own: unknown = "auto";
  const setting = (): EffectiveSetting => ({
    key: "merge.mode",
    value: entry.locked || own === null ? entry.value : own,
    locked: entry.locked,
    source: {
      layer: entry.locked || own === null ? "org" : "project",
      targetId: entry.locked || own === null ? orgId : projectId,
    },
    chain: [
      { layer: "org", targetId: orgId, value: entry.value, locked: entry.locked, applied: true },
      ...(own === null
        ? []
        : [{ layer: "project" as const, targetId: projectId, value: own, locked: false, applied: !entry.locked }]),
    ],
  });
  const snapshot = () => ({
    orgId,
    projectId,
    schemaVersion: 1,
    generatedAt: at,
    configVersion: JSON.stringify(setting()),
    settings: [setting()],
  });
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), orgId);
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [{ id: orgId, slug: "acme", name: "Acme", role: "owner", emailDomain: null, createdAt: at }],
          canCreateOrg: false,
        }),
      "roles/mine": () => ok({ permissions: [...SYSTEM_ROLE_PERMISSIONS.owner] }),
      "inbox/unreadCount": () => ok({ count: 0 }),
      "projects/list": () =>
        ok([{ id: projectId, key: "pay", name: "Payments", teamId, settings: defaultProjectSettings() }]),
      "layeredConfig/orgGet": () => ok({ entries: [entry] }),
      "layeredConfig/orgSet": (input) => {
        entry = { ...entry, ...(input as object), version: entry.version + 1 };
        return ok(entry);
      },
      "layeredConfig/effective": () => ok(snapshot()),
      "layeredConfig/projectSet": (input) => {
        own = (input as { value: unknown }).value;
        return ok(snapshot());
      },
    },
  });
  await page.goto("/admin/config");
  await page.getByRole("switch", { name: "Khoá: merge.mode" }).check();
  await page.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect.poll(() => entry.locked).toBe(true);
  await page.goto("/projects/pay/config");
  await expect(page.getByText("Bị tổ chức khoá", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Giá trị: merge.mode")).toBeDisabled();
  await expect(page.getByText("Giá trị riêng đang tạm ngưng: Tự động")).toBeVisible();
  await page.goto("/admin/config");
  await page.getByRole("switch", { name: "Khoá: merge.mode" }).uncheck();
  await page.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect.poll(() => entry.locked).toBe(false);
  await page.goto("/projects/pay/config");
  await expect(page.getByText("Được ghi đè", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Dùng giá trị kế thừa" }).click();
  await expect(page.getByText("Kế thừa tổ chức", { exact: true })).toBeVisible();
  await page.getByLabel("Giá trị: merge.mode").selectOption("auto");
  await page.getByRole("button", { name: "Lưu giá trị riêng" }).click();
  await expect(page.getByText("Được ghi đè", { exact: true })).toBeVisible();
  expect(hub.rpcCalls.filter((c) => c.path.startsWith("layeredConfig/")).every((c) => c.org === orgId)).toBe(true);
});

test("thành viên chỉ xem cấu hình; form cũ báo xung đột phiên bản", async ({ page }) => {
  let editable = false;
  let submitted: unknown;
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), orgId);
  await fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [
            {
              id: orgId,
              slug: "acme",
              name: "Acme",
              role: editable ? "owner" : "member",
              emailDomain: null,
              createdAt: at,
            },
          ],
          canCreateOrg: false,
        }),
      "roles/mine": () => ok({ permissions: editable ? [...SYSTEM_ROLE_PERMISSIONS.owner] : [] }),
      "inbox/unreadCount": () => ok({ count: 0 }),
      "projects/list": () =>
        ok([{ id: projectId, key: "pay", name: "Payments", teamId, settings: defaultProjectSettings() }]),
      "layeredConfig/orgGet": () =>
        ok({
          entries: [{ key: "merge.mode", value: "review", locked: false, version: 3, updatedAt: at, updatedBy: null }],
        }),
      "layeredConfig/effective": () =>
        ok({
          orgId,
          projectId,
          schemaVersion: 1,
          generatedAt: at,
          configVersion: "read-only",
          settings: [
            { key: "merge.mode", value: "review", locked: false, source: { layer: "org", targetId: orgId }, chain: [] },
          ],
        }),
      "layeredConfig/orgSet": (input) => {
        submitted = input;
        return fail("CONFLICT", 409, "Cấu hình vừa được người khác sửa. Hãy tải lại rồi thử lại.", {
          code: "CONFIG_VERSION_CONFLICT",
        });
      },
    },
  });
  await page.goto("/admin/config");
  await expect(page.getByRole("switch", { name: "Khoá: merge.mode" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Lưu", exact: true })).toHaveCount(0);
  await page.goto("/projects/pay/config");
  await expect(page.getByLabel("Giá trị: merge.mode")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Lưu giá trị riêng" })).toHaveCount(0);
  editable = true;
  await page.goto("/admin/config");
  await page.getByLabel("Giá trị: merge.mode").selectOption("auto");
  await page.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Cấu hình vừa được người khác sửa");
  expect(submitted).toMatchObject({ key: "merge.mode", value: "auto", expectedVersion: 3 });
});
