import { expect, type Page, test } from "@playwright/test";
import { SDLC_PRESETS, type SdlcModeSaveInput, type SdlcModeView } from "@xdev-hive/contracts";
import { ok } from "./fake-hub.ts";
import { inOrg } from "./reviews-fixture.ts";

async function setup(page: Page, readOnly = false) {
  let modes: SdlcModeView[] = (["speckit", "bugfix", "small"] as const).map((ref) => {
    const definition = SDLC_PRESETS[ref];
    if (!definition) throw new Error(`Thiếu preset ${ref}`);
    return {
      ref,
      preset: true,
      slug: ref,
      teamId: null,
      basePreset: null,
      version: 1,
      enabled: true,
      definition,
      openItems: 0,
      updatedAt: null,
    };
  });
  const hub = await inOrg(
    page,
    readOnly ? "member" : "admin",
    {
      "sdlc/modes/list": () => ok(modes),
      "sdlc/modes/save": (input) => {
        const i = input as SdlcModeSaveInput;
        const saved: SdlcModeView = {
          ...i,
          basePreset: i.basePreset ?? null,
          enabled: i.enabled ?? true,
          ref: i.id ?? "5d5d5d5d-0000-4000-8000-000000000001",
          definition: i.definition as SdlcModeView["definition"],
          preset: false,
          version: 2,
          openItems: 2,
          updatedAt: "2026-10-14T08:00:00.000Z",
        };
        modes = [...modes.filter((m) => m.ref !== saved.ref), saved];
        return ok(saved);
      },
      "sdlc/modes/remove": (input) => {
        modes = modes.filter((m) => m.ref !== (input as { id: string }).id);
        return ok({ ok: true });
      },
      "sdlc/modes/dryRun": () =>
        ok({
          phases: [
            {
              id: "specify",
              name: "Specify",
              kind: "requirements",
              skipped: false,
              artifacts: [
                {
                  artifactId: "spec",
                  path: "specs/013-hoan-tien/spec.md",
                  docKey: "project/payment-api/sdlc/013-hoan-tien/spec",
                },
              ],
              gates: [{ gateId: "po", name: "BA/PO duyệt", runs: true, reason: "Cần người duyệt", autoApprove: false }],
            },
          ],
          warnings: [],
        }),
    },
    readOnly ? ["sdlc.read"] : undefined,
  );
  return { hub };
}

test("sao chép preset, dùng lại checkpoint, chạy thử, lưu rồi xoá chế độ", async ({ page }) => {
  const { hub } = await setup(page);
  await page.goto("/admin/sdlc-modes");
  await expect(page.getByRole("heading", { name: "Chế độ AI SDLC", level: 1 })).toBeVisible();
  await page.getByLabel("Chế độ", { exact: true }).selectOption("bugfix");
  await page.getByLabel("Mã chế độ", { exact: true }).fill("bugfix-team");
  const name = page.getByLabel("Tên chế độ", { exact: true }).first();
  await name.fill("Sửa lỗi của đội");
  await page.getByRole("button", { name: "Thêm checkpoint" }).first().click();
  await expect(page.locator('input[value="BA/PO duyệt"]').first()).toBeVisible();
  await page.getByRole("button", { name: "Chạy thử", exact: true }).click();
  await expect(page.getByText(/specs\/013-hoan-tien\/spec.md/)).toBeVisible();
  await page.getByRole("button", { name: "Lưu chế độ" }).click();
  await expect(page.getByRole("button", { name: "Xoá chế độ" })).toBeVisible();
  const saved = hub.rpcCalls.find((c) => c.path === "sdlc/modes/save")?.input as SdlcModeSaveInput;
  expect(saved).toMatchObject({ slug: "bugfix-team", basePreset: "bugfix", definition: { name: "Sửa lỗi của đội" } });
  expect(saved).not.toHaveProperty("id");
  expect(
    saved.definition.phases
      .flatMap((p) => p.gate ?? [])
      .flatMap((g) => g.gates)
      .some((g) => g.reviewers?.roles?.includes("team-ba")),
  ).toBe(true);
  await page.getByRole("button", { name: "Xoá chế độ" }).click();
  await expect(page.getByRole("dialog")).toContainText("2 hạng mục đang mở giữ bản chụp hiện tại");
  await page.getByRole("button", { name: "Xác nhận xoá" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(hub.rpcCalls.some((c) => c.path === "sdlc/modes/remove")).toBe(true);
});

test("FR-056: lỗi tự duyệt yêu cầu của chế độ nặng hiện tại giai đoạn, không gọi lưu", async ({ page }) => {
  const { hub } = await setup(page);
  await page.goto("/admin/sdlc-modes");
  const phase = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /Giai đoạn 1/ }) })
    .first();
  await phase.getByRole("checkbox", { name: "Tự duyệt AI", exact: true }).check();
  await page.getByRole("button", { name: "Lưu chế độ" }).click();
  await expect(phase.getByRole("alert").filter({ hasText: "Giai đoạn yêu cầu" })).toContainText(
    "Giai đoạn yêu cầu của chế độ nặng luôn cần người duyệt",
  );
  expect(hub.rpcCalls.some((c) => c.path === "sdlc/modes/save")).toBe(false);
});

test("người chỉ đọc không sửa hoặc xoá chế độ", async ({ page }) => {
  const { hub } = await setup(page, true);
  await page.goto("/admin/sdlc-modes");
  await expect(page.getByRole("button", { name: "Lưu chế độ" })).toBeDisabled();
  await expect(page.getByLabel("Mã chế độ", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Xoá chế độ" })).toHaveCount(0);
  expect(hub.rpcCalls.some((c) => c.path === "sdlc/modes/save")).toBe(false);
});

for (const scheme of ["light", "dark"] as const) {
  test(`cấu hình chế độ 360 px, ${scheme}`, async ({ page }, testInfo) => {
    await setup(page);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/admin/sdlc-modes");
    await expect(page.getByRole("button", { name: "Lưu chế độ" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
      .toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`sdlc-modes-360-${scheme}.png`), fullPage: true });
  });
}
