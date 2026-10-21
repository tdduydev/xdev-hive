import { expect, type Page, test } from "@playwright/test";
import { ACCOUNTS_ORG, fakeHub, machineAccountsFixture, ok, SHARED_MACHINE_ID } from "./fake-hub.ts";

const reportedAt = "2026-10-13T07:00:00.000Z";

/** Điểm token (specs/025 US6): máy dùng chung đã gửi điểm, máy cá nhân chưa bật gửi. */
async function setup(page: Page) {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ACCOUNTS_ORG.id);
  const { rpc } = machineAccountsFixture();
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      ...rpc,
      "runs/search": () => ok({ items: [], nextCursor: null, machines: [] }),
      "machines/list": (input, call, hub) => {
        const base = rpc["machines/list"]?.(input, call, hub);
        const list = (base?.json as { json: Record<string, unknown>[] } | undefined)?.json ?? [];
        return ok(
          list.map((machine) =>
            machine.id === SHARED_MACHINE_ID
              ? { ...machine, tokenScore: { score: 81.6, level: "good", coverage: 92, provisional: true, reportedAt } }
              : { ...machine, tokenScore: null },
          ),
        );
      },
      "machines/tokenScore": (input) =>
        ok({
          machineId: (input as { machineId: string }).machineId,
          latest: {
            reportedAt,
            report: {
              scoreVersion: 1,
              generatedAt: reportedAt,
              days: 7,
              machine: { score: 81.6, level: "good", coverage: 92, provisional: true },
              profiles: [
                {
                  cli: "claude",
                  score: 78,
                  coverage: 90,
                  share: 0.7,
                  groups: { A: { earned: 48, max: 60 }, B: { earned: 30, max: 40 } },
                  criteria: [
                    { id: "A1", status: "ok", earned: 10, max: 10, value: 12.5, unit: "%" },
                    { id: "A6", status: "partial", earned: 4, max: 8, reason: "windows_rtk_unsupported" },
                    { id: "B2", status: "unknown", earned: 0, max: 8, reason: "not_enough_sessions" },
                  ],
                },
              ],
            },
          },
          history: [
            { reportedAt: "2026-09-20T07:00:00.000Z", score: 64, coverage: 80 },
            { reportedAt: "2026-10-01T07:00:00.000Z", score: 70, coverage: 85 },
            { reportedAt, score: 81.6, coverage: 92 },
          ],
        }),
    },
  });
  return hub;
}

test("danh sách máy: cột Điểm token, bấm điểm mở chi tiết theo tiêu chí", async ({ page }) => {
  const hub = await setup(page);
  await page.goto("/machines");
  await expect(page.getByRole("columnheader", { name: /Điểm token/ })).toBeVisible();
  const row = page.getByRole("row", { name: /sdlc-box-01/ });
  await expect(row).toContainText("tạm tính");
  await expect(page.getByRole("row", { name: /dev-ha/ }).getByTitle("Máy chưa bật gửi điểm")).toHaveText("—");

  await row.getByRole("button", { name: "Xem điểm token của sdlc-box-01: 82, Tốt" }).click();
  const dialog = page.getByRole("dialog", { name: "Điểm token · sdlc-box-01" });
  await expect(dialog).toBeVisible();
  // Bấm điểm mở hộp thoại, không đi sang trang máy như bấm dòng.
  await expect(page).toHaveURL("/machines");
  const criteria = dialog.getByRole("table", { name: "Tiêu chí của Claude" });
  await expect(criteria.getByRole("row", { name: /A1/ })).toContainText("Đạt");
  await expect(criteria.getByRole("row", { name: /B2/ })).toContainText("Chưa đủ phiên");
  await expect(dialog.getByText("Nhóm A · 48/60")).toBeVisible();
  await expect(dialog.getByRole("img", { name: /qua 3 lần gửi, từ 64 tới 82/ })).toBeVisible();
  expect(hub.rpcCalls.find((call) => call.path === "machines/tokenScore")?.input).toEqual({
    machineId: SHARED_MACHINE_ID,
  });

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("trang máy ở 360 px: điểm token trong Thông tin máy, hộp thoại không tràn ngang", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await setup(page);
  await page.goto(`/machines/${SHARED_MACHINE_ID}`);
  const button = page.getByRole("button", { name: /Xem điểm token của sdlc-box-01/ });
  await button.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Điểm token · sdlc-box-01" });
  await expect(dialog.getByRole("table", { name: "Tiêu chí của Claude" })).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});
