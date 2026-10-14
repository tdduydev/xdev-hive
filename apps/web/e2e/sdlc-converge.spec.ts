import { expect, type Page, test } from "@playwright/test";
import { type SdlcItemDetail, SYSTEM_ROLE_PERMISSIONS } from "@xdev-hive/contracts";
import { ok } from "./fake-hub.ts";
import { inOrg } from "./reviews-fixture.ts";
import { sdlcFixture } from "./sdlc-fixture.ts";

const NOW = "2026-10-14T03:42:00.000Z";

const run = (round: number, findings: Record<string, unknown>[]): SdlcItemDetail["steps"][number] => ({
  id: `7a7a7a7a-0000-4000-8000-00000000000${round}`,
  phaseId: "converge",
  stepId: "converge-spec",
  action: "converge",
  round,
  status: "succeeded",
  run: { id: `8a8a8a8a-0000-4000-8000-00000000000${round}`, state: "succeeded" },
  waitingReason: null,
  instructions: null,
  result: { findings },
  error: null,
  createdBy: "u1",
  createdAt: NOW,
  finishedAt: NOW,
});

const ROUND_1 = [
  { requirementId: "FR-001", status: "met", evidence: "refund.ts:40 kiểm số tiền hoàn không vượt số đã trả" },
  {
    requirementId: "FR-002",
    status: "missing",
    evidence: "Không thấy giới hạn số lần hoàn cho một giao dịch",
    suggestedTask: "Thêm giới hạn 3 lần hoàn mỗi giao dịch",
  },
  {
    requirementId: "FR-003",
    status: "contradicts",
    evidence: "Spec nói hoàn trong 30 ngày, refund-policy.ts:12 cho 60 ngày",
    suggestedTask: "Sửa hạn hoàn về 30 ngày",
  },
];

async function setup(page: Page, steps: SdlcItemDetail["steps"], convergeRound: number) {
  const sdlc = sdlcFixture();
  sdlc.state.item = { ...sdlc.state.item, steps, convergeRound };
  const started: unknown[] = [];
  await inOrg(
    page,
    "member",
    {
      ...sdlc.rpc,
      "sdlc/items/step": (input) => {
        started.push(input);
        return ok(sdlc.state.item);
      },
    },
    [...SYSTEM_ROLE_PERMISSIONS.member],
  );
  return { started };
}

test("tab Hội tụ: chạy hội tụ, xem kết quả vòng, mâu thuẫn có hai hướng sửa", async ({ page }) => {
  const { started } = await setup(page, [], 0);
  await page.goto("/sdlc/payment-api/12");
  const tabs = page.getByRole("tablist", { name: "Các mục của hạng mục" });
  await tabs.getByRole("tab", { name: "Hội tụ" }).click();
  await expect(page).toHaveURL(/\/sdlc\/payment-api\/12\/converge$/);
  await page.getByRole("button", { name: "Chạy hội tụ" }).click();
  await expect.poll(() => started).toEqual([expect.objectContaining({ phaseId: "converge", stepId: "converge-spec" })]);
});

test("chưa hội tụ vòng 1/2 hiện thiếu và mâu thuẫn", async ({ page }) => {
  await setup(page, [run(1, ROUND_1)], 1);
  await page.goto("/sdlc/payment-api/12/converge");
  await expect(page.getByText("Chưa hội tụ (vòng 1/2)")).toBeVisible();
  const contradicts = page.getByRole("listitem").filter({ hasText: "FR-003" });
  await expect(contradicts).toContainText("Mâu thuẫn");
  await expect(contradicts.getByRole("link", { name: "Sửa tài liệu" })).toBeVisible();
  await expect(contradicts.getByRole("link", { name: "Sửa code: thêm task" })).toBeVisible();
  await expect(page.getByText("FR-001")).toBeHidden();
  await page.getByLabel("Ẩn yêu cầu đạt").uncheck();
  await expect(page.getByText("FR-001")).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`hội tụ 360 px, ${scheme}`, async ({ page }, testInfo) => {
    await setup(page, [run(1, ROUND_1)], 1);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/sdlc/payment-api/12/converge");
    await expect(page.getByText("Chưa hội tụ (vòng 1/2)")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
      .toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`sdlc-converge-360-${scheme}.png`), fullPage: true });
  });
}
