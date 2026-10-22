import { expect, type Page, test } from "@playwright/test";
import { projectTokenUsageFixture, type TokenUsageMode } from "./project-token-usage-fixture.ts";
import { inOrg } from "./reviews-fixture.ts";

async function open(page: Page, mode: TokenUsageMode = "rows", width = 1280) {
  await page.setViewportSize({ width, height: 800 });
  const fixture = projectTokenUsageFixture(mode);
  await inOrg(page, "member", fixture.rpc);
  await page.goto("/projects/PAY/token-usage");
  return fixture;
}

const table = (page: Page) => page.getByRole("table", { name: "Token theo người và máy của dự án" });
const rowOf = (page: Page, text: string) => page.getByRole("row").filter({ hasText: text });

test("có dữ liệu: tổng ở đầu bảng, mỗi máy một dòng đủ cột", async ({ page }) => {
  const fixture = await open(page);

  for (const col of ["Người", "Máy", "Token quy đổi", "Phiên", "Điểm", "Lệch chính sách", "Gửi lần cuối"]) {
    await expect(table(page).getByRole("columnheader", { name: col })).toBeVisible();
  }
  // Dòng đầu của thân bảng là tổng: 1.250.000 + 480.500 token, 18 + 7 phiên.
  const total = table(page).getByRole("row").nth(1);
  await expect(total).toContainText("Tổng (2 máy)");
  await expect(total).toContainText("1.730.500");
  await expect(total).toContainText("25");

  const lan = rowOf(page, "lan-macbook");
  await expect(lan).toContainText("Trần Lan");
  await expect(lan).toContainText("1.250.000");
  await expect(lan).toContainText("82");
  await expect(lan.getByRole("list", { name: "Lệch chính sách" }).getByRole("listitem")).toHaveText([
    "Mức tối ưu",
    "RTK",
  ]);

  const ha = rowOf(page, "ha-thinkpad");
  await expect(ha).toContainText("Phạm Hà");
  await expect(ha).toContainText("480.500");
  // Chưa có điểm thì gạch ngang, máy đúng chính sách thì nói rõ không lệch.
  await expect(ha.getByRole("cell").nth(4)).toHaveText("—");
  await expect(ha).toContainText("Không lệch");

  expect(fixture.state.calls[0]).toEqual({ key: "PAY", days: 7 });
});

test("đổi kỳ sang 30 ngày gửi days=30 và hiện thêm máy gửi từ trước", async ({ page }) => {
  const fixture = await open(page);
  await expect(rowOf(page, "minh-desktop")).toHaveCount(0);

  const week = page.getByRole("button", { name: "7 ngày" });
  const month = page.getByRole("button", { name: "30 ngày" });
  await expect(week).toHaveAttribute("aria-pressed", "true");
  await month.click();

  await expect(month).toHaveAttribute("aria-pressed", "true");
  await expect(rowOf(page, "minh-desktop")).toContainText("Cửa sổ tự nén");
  await expect(table(page).getByRole("row").nth(1)).toContainText("Tổng (3 máy)");
  expect(fixture.state.calls.some((c) => c.days === 30)).toBe(true);
});

test("trống: giải thích cách bật gửi số liệu trên app desktop, không hiện bảng", async ({ page }) => {
  await open(page, "empty");

  await expect(page.getByRole("heading", { name: "Chưa có máy nào gửi số liệu" })).toBeVisible();
  await expect(page.getByText('bật "Gửi số liệu token" ở màn Memory của app desktop')).toBeVisible();
  await expect(table(page)).toHaveCount(0);
});

for (const mode of ["outside", "notFound"] as const) {
  test(`người ngoài dự án (${mode}): câu rõ ràng, không hiện bảng`, async ({ page }) => {
    await open(page, mode);

    await expect(page.getByRole("heading", { name: "Bạn không xem được số liệu này" })).toBeVisible();
    await expect(page.getByText("Chỉ thành viên đội sở hữu dự án xem được token của dự án.")).toBeVisible();
    await expect(table(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "30 ngày" })).toHaveCount(0);
  });
}

test("360 px: bảng cuộn trong khung, trang không tràn ngang", async ({ page }) => {
  await open(page, "rows", 360);
  await expect(rowOf(page, "lan-macbook")).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole("button", { name: "30 ngày" })).toBeVisible();
});

test("bàn phím: Tab tới chip kỳ xem, Enter đổi kỳ", async ({ page }) => {
  const fixture = await open(page);
  await expect(rowOf(page, "lan-macbook")).toBeVisible();

  const month = page.getByRole("button", { name: "30 ngày" });
  await month.focus();
  await expect(month).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(month).toHaveAttribute("aria-pressed", "true");
  await expect(rowOf(page, "minh-desktop")).toBeVisible();
  expect(fixture.state.calls.some((c) => c.days === 30)).toBe(true);
});
