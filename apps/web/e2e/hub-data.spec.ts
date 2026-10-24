import { expect, test } from "@playwright/test";
import { fakeHub, ok } from "./fake-hub.ts";

for (const width of [360, 1280]) {
  test(`Dữ liệu hub giữ: nguồn, thời hạn và ngoại lệ ở ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fakeHub(page, {
      signedIn: true,
      rpc: {
        "orgs/mine": () =>
          ok({
            orgs: [
              {
                id: "0a0a0a0a-0000-4000-8000-00000000000a",
                slug: "acme",
                name: "Acme",
                role: "owner",
                emailDomain: null,
                createdAt: "2026-10-01T00:00:00.000Z",
              },
            ],
            canCreateOrg: false,
          }),
      },
    });
    await page.goto("/admin/hub-data");
    await expect(page.getByRole("heading", { name: "Dữ liệu hub giữ", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Terminal từ xa (ngoại lệ spec 010)", exact: true })).toBeVisible();
    await expect(page.getByText(/Ngoại lệ spec 010: terminal_chunks/)).toBeVisible();
    await expect(page.getByText("30 ngày.", { exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
      .toBeLessThanOrEqual(1);
  });
}
