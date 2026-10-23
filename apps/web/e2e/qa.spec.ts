import { expect, test } from "@playwright/test";
import { type QaView, SDLC_PRESETS, SYSTEM_ROLE_PERMISSIONS } from "@xdev-hive/contracts";
import { ok } from "./fake-hub.ts";
import { inOrg } from "./reviews-fixture.ts";
import { sdlcFixture } from "./sdlc-fixture.ts";

for (const canWaive of [true, false]) {
  test(`cổng QA hiển thị TC, FR/AC và quyền miễn ${canWaive}`, async ({ page }) => {
    const fixture = sdlcFixture();
    fixture.state.item.mode = SDLC_PRESETS["qa-automation"];
    const data: QaView = {
      canWaive,
      cases: [
        {
          id: "9d9d9d9d-0000-4000-8000-000000000001",
          code: "TC-001",
          title: "Đăng nhập hợp lệ",
          priority: "P1",
          automation: "automated",
          requirementIds: ["FR-001", "AC-1.1"],
          scriptPath: "tests/login.spec.ts",
          testKey: null,
          required: true,
          retired: false,
          lastStatus: "failed",
          waivedBy: null,
          waiverReason: null,
        },
      ],
      report: null,
      checks: [{ code: "TC-001", passed: false, note: "Chưa đạt" }],
    };
    const decisions: unknown[] = [];
    await inOrg(
      page,
      "member",
      {
        ...fixture.rpc,
        "sdlc/qa/view": () => ok(data),
        "sdlc/qa/waive": (input) => {
          decisions.push(input);
          data.cases[0]!.waivedBy = "admin";
          data.cases[0]!.waiverReason = "Chấp nhận rủi ro bản thử";
          data.checks[0]!.passed = true;
          return ok({ ok: true });
        },
      },
      [...SYSTEM_ROLE_PERMISSIONS.member],
    );
    await page.goto("/sdlc/payment-api/12");
    const panel = page.getByRole("region", { name: "Cổng QA" });
    await expect(panel.getByText("QA đang chặn")).toBeVisible();
    await expect(panel.getByText(/FR-001, AC-1.1/)).toBeVisible();
    if (canWaive) {
      await panel.getByRole("button", { name: "Miễn TC" }).click();
      await expect(panel.getByRole("button", { name: "Lưu quyết định" })).toBeDisabled();
      await panel.getByLabel("Lý do quyết định QA").fill("Chấp nhận rủi ro bản thử");
      await panel.getByRole("button", { name: "Lưu quyết định" }).click();
      await expect.poll(() => decisions.length).toBe(1);
      await expect(panel.getByText("Đủ điều kiện QA")).toBeVisible();
      await expect(panel.getByRole("button", { name: "Thu hồi miễn" })).toBeVisible();
    } else await expect(panel.getByRole("button", { name: "Miễn TC" })).toHaveCount(0);
  });
}
