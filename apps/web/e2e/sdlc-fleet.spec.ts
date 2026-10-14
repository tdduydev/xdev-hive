import { expect, type Page, test } from "@playwright/test";
import type { SdlcFleetMachine } from "@xdev-hive/contracts";
import { fail, ok } from "./fake-hub.ts";
import { inOrg, TEAM_ID } from "./reviews-fixture.ts";

const machineId = "8e8e8e8e-0000-4000-8000-000000000001";
const at = "2026-10-14T08:00:00.000Z";
async function setup(page: Page, readOnly = false) {
  let machine: SdlcFleetMachine = {
    id: machineId,
    teamId: TEAM_ID,
    teamName: "Thanh toán",
    kind: "worker",
    name: "sdlc-box-01",
    os: "linux",
    version: "1.3.0",
    clis: ["codex"],
    capacity: 2,
    status: "online",
    lastSeenAt: at,
    createdAt: at,
    shared: true,
    registeredBy: "u1",
    labels: ["sdlc"],
    labelsOnly: true,
    accounts: [
      {
        id: "codex-1",
        cli: "codex",
        label: "Nhóm BA",
        enabled: true,
        loggedIn: true,
        roles: [],
        sessionPct: 32,
        weekPct: 85,
        resetsAt: null,
        stopAtSession: 90,
        stopAtWeek: 90,
        inUse: 1,
      },
    ],
    accountsAt: at,
    slotsUsed: 1,
    runs: [
      {
        runId: "6e6e6e6e-0000-4000-8000-000000000001",
        kind: "sdlc",
        projectKey: "payment-api",
        item: { id: "6e6e6e6e-0000-4000-8000-000000000002", ref: "012", title: "Hoàn tiền" },
        step: "draft",
        startedAt: at,
      },
    ],
    quotaResetsAt: null,
    canSetAccounts: !readOnly,
  };
  let fleetFails = false;
  const hub = await inOrg(
    page,
    readOnly ? "member" : "admin",
    {
      "machines/sdlc": () =>
        fleetFails ? fail("INTERNAL_SERVER_ERROR", 500, "Chưa tải được đội máy.") : ok([machine]),
      "machines/list": () => ok([machine]),
      "machines/workerRelease": () => ok(null),
      "runs/search": () => ok({ items: [], nextCursor: null, machines: [] }),
      "machines/setAccount": (input) => {
        const i = input as { enabled: boolean };
        machine = { ...machine, accounts: machine.accounts?.map((a) => ({ ...a, enabled: i.enabled })) };
        return ok(machine);
      },
      "machines/setLabels": (input) => {
        const i = input as { labels: string[]; labelsOnly: boolean };
        machine = { ...machine, ...i };
        return ok(machine);
      },
      "machines/createRegistration": () =>
        ok({
          token: "registration-test-only",
          expiresAt: "2099-01-01T00:00:00.000Z",
          command: "hive-worker register",
          installCommand: "curl https://example.test/install.sh | sh -s -- --registration-token registration-test-only",
          installCommandWindows: "powershell -File install.ps1 -RegistrationToken registration-test-only",
        }),
    },
    readOnly ? ["machines.read", "sdlc.read"] : undefined,
  );
  return {
    hub,
    failFleet: (value: boolean) => {
      fleetFails = value;
    },
  };
}

test("đội máy: run, quota, bật/tắt gói và lọc đội", async ({ page }) => {
  const { hub } = await setup(page);
  await page.goto("/sdlc/fleet");
  await expect(page.getByRole("heading", { level: 1, name: "Đội máy AI SDLC" })).toBeVisible();
  await expect(page.getByRole("region", { name: "sdlc-box-01" })).toContainText("Phiên: 32% · Tuần: 85%");
  await expect(page.getByRole("link", { name: /payment-api · 012 · Hoàn tiền · draft/ })).toHaveAttribute(
    "href",
    /runs/,
  );
  await page.getByRole("button", { name: "Tắt Nhóm BA" }).click();
  await expect(page.getByRole("button", { name: "Bật Nhóm BA" })).toBeVisible();
  await page.getByLabel("Đội", { exact: true }).selectOption(TEAM_ID);
  await expect
    .poll(() => hub.rpcCalls.filter((c) => c.path === "machines/sdlc").at(-1)?.input)
    .toEqual({ teamId: TEAM_ID });
});

test("thêm máy dùng chung: nhãn sdlc, chỉ run có nhãn và lệnh cài một dòng cho ba OS", async ({ page }) => {
  const { hub } = await setup(page);
  await page.goto("/sdlc/fleet");
  await expect(page.getByRole("button", { name: "Thêm máy" })).toBeDisabled();
  await page.getByLabel("Đội", { exact: true }).selectOption(TEAM_ID);
  await page.getByRole("button", { name: "Thêm máy" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Nhãn máy")).toHaveValue("sdlc");
  await expect(dialog.getByRole("checkbox", { name: "Chỉ nhận run có nhãn" })).toBeChecked();
  await dialog.getByRole("button", { name: "Tạo mã đăng ký" }).click();
  await expect(dialog.getByText(/curl https/)).toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "machines/createRegistration")?.input).toMatchObject({
    teamId: TEAM_ID,
    labels: ["sdlc"],
    labelsOnly: true,
    shared: true,
  });
  await dialog.getByRole("button", { name: "Linux", exact: true }).click();
  await expect(dialog.getByText(/curl https/)).toBeVisible();
  await dialog.getByRole("button", { name: "Windows", exact: true }).click();
  await expect(dialog.getByText(/powershell -File/)).toBeVisible();
});

test("trang Máy: sửa nhãn và cờ qua menu phụ", async ({ page }) => {
  const { hub } = await setup(page);
  await page.goto("/machines");
  const row = page.getByRole("row", { name: /sdlc-box-01/ });
  await expect(row).toContainText("Chỉ nhận run có nhãn");
  await row.getByRole("button", { name: "Thao tác khác cho sdlc-box-01" }).click();
  await page.getByRole("menuitem", { name: "Nhãn · sdlc-box-01" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nhãn", { exact: true }).fill("sdlc, docs");
  await dialog.getByRole("checkbox", { name: "Chỉ nhận run có nhãn" }).uncheck();
  await dialog.getByRole("button", { name: "Lưu nhãn" }).click();
  await expect(dialog).not.toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "machines/setLabels")?.input).toEqual({
    machineId,
    labels: ["sdlc", "docs"],
    labelsOnly: false,
  });
  await expect(row).toContainText("docs");
});

test("chỉ đọc không hiện điều khiển; tải lỗi thử lại được", async ({ page }) => {
  const { failFleet } = await setup(page, true);
  failFleet(true);
  await page.goto("/sdlc/fleet");
  await expect(page.getByRole("button", { name: "Thêm máy" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tải lại" })).toBeVisible();
  failFleet(false);
  await page.getByRole("button", { name: "Tải lại" }).click();
  await expect(page.getByRole("region", { name: "sdlc-box-01" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tắt Nhóm BA" })).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`đội máy 360 px, ${scheme}`, async ({ page }, testInfo) => {
    await setup(page);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/sdlc/fleet");
    await expect(page.getByRole("region", { name: "sdlc-box-01" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
      .toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`sdlc-fleet-360-${scheme}.png`), fullPage: true });
  });
}
