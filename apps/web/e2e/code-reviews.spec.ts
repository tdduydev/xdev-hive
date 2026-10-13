import { expect, type Page, test } from "@playwright/test";
import {
  BIG_FILE_COUNT,
  codeReviewsFixture,
  HEAD_PAY,
  NEW_HEAD_PAY,
  REVIEW_BIG,
  REVIEW_DONE,
  REVIEW_LEGACY,
  REVIEW_PAY,
} from "./code-reviews-fixture.ts";
import { inOrg, type Role, reviewsFixture } from "./reviews-fixture.ts";

async function setup(page: Page, role: Role = "admin") {
  const code = codeReviewsFixture();
  const hub = await inOrg(page, role, { ...reviewsFixture().rpc, ...code.rpc });
  return { ...code, hub };
}

const table = (page: Page) => page.getByRole("table", { name: "Hàng chờ review code" });
const pane = (page: Page) => page.getByRole("region", { name: "Chi tiết PR" });

test("hai tab có số đếm; tab Code mở bằng ?tab=code và URL cũ ?id= vẫn là tài liệu", async ({ page }) => {
  await setup(page);
  await page.goto("/knowledge/reviews");
  const tabs = page.getByRole("tablist", { name: "Loại duyệt" });
  await expect(tabs.getByRole("tab", { name: /Tài liệu/ })).toHaveAttribute("aria-selected", "true");
  // Hai phiên tài liệu chờ tôi, hai PR chờ tôi (PAY-142 và PAY-160).
  await expect(tabs.getByRole("tab", { name: /Tài liệu/ })).toContainText("2");
  await expect(tabs.getByRole("tab", { name: /Code/ })).toContainText("2");
  await expect(page.getByRole("table", { name: /Hàng chờ duyệt|Review queue/ })).toBeVisible();

  await tabs.getByRole("tab", { name: /Code/ }).click();
  await expect(page).toHaveURL(/tab=code/);
  await expect(table(page)).toBeVisible();
  await tabs.getByRole("tab", { name: /Tài liệu/ }).click();
  await expect(page).not.toHaveURL(/tab=code/);
});

test("menu có badge số PR chờ tôi duyệt", async ({ page }) => {
  await setup(page);
  await page.goto("/knowledge/reviews");
  const item = page.getByRole("link", { name: /Chờ tôi duyệt/ });
  await expect(item).toContainText("2 PR đang chờ bạn duyệt");
});

test("hàng chờ: bảng PR, mở PR đầu hàng, diff gắn phát hiện AI, các checkpoint", async ({ page }) => {
  const { hub } = await setup(page);
  await page.goto("/knowledge/reviews?tab=code");
  const pay = table(page).getByRole("row").filter({ hasText: "Hoàn tiền một phần" });
  await expect(pay).toContainText("#128");
  await expect(pay).toContainText("payment-api");
  await expect(pay).toContainText("Product owner duyệt");
  await expect(pay).toContainText("3/3");
  await expect(pay).toContainText("còn 14 giờ");
  await expect(pay).toContainText("8,0");
  await expect(pay).toContainText("+4 −2");
  await expect(table(page).getByRole("row").filter({ hasText: "Tách module thanh toán" })).toBeVisible();
  // Mặc định chỉ phiên chờ tôi: PAY-150 của người khác chưa hiện.
  await expect(table(page).getByRole("row").filter({ hasText: "Đối soát ngày công" })).toHaveCount(0);
  expect(hub.rpcCalls.find((c) => c.path === "codeReviews/list")?.input).toMatchObject({ scope: "mine" });

  const detail = pane(page);
  await expect(detail).toContainText("Hoàn tiền một phần");
  await expect(detail.getByRole("list", { name: "Các bước của quy trình" })).toContainText(
    "Product owner duyệt(đang chờ)",
  );
  await expect(detail.getByRole("list", { name: "Các bước của quy trình" })).toContainText("Review AI(đã qua)");
  await expect(detail.getByRole("link", { name: "Mở PR" })).toHaveAttribute("href", /pull\/128$/);
  await expect(detail.getByRole("link", { name: "Mở run" })).toHaveAttribute("href", /\/runs\//);

  // Diff của PR đầu hàng: file đầu được chọn, dòng thêm/xoá, phát hiện AI gắn vào file.
  const files = detail.getByRole("navigation", { name: "Danh sách file" });
  await expect(files.getByRole("button", { name: /src\/refund\.ts/ })).toHaveAttribute("aria-current", "true");
  await expect(files.getByRole("button", { name: /src\/refund\.ts/ })).toContainText("+2");
  await expect(
    files.getByRole("button", { name: /src\/refund\.ts/ }).getByLabel("1 phát hiện của AI trong file này"),
  ).toBeVisible();
  await expect(detail.getByText("const left = order.total - order.fee;")).toBeVisible();
  // File quá lớn không có patch: dẫn ra PR thay vì để trống.
  await files.getByRole("button", { name: /src\/big\.ts/ }).click();
  await expect(detail.getByText("File quá lớn để hiện ở đây")).toBeVisible();
  await expect(detail.getByRole("link", { name: "Mở trên GitHub" })).toHaveAttribute("href", /pull\/128/);
  expect(hub.rpcCalls.find((c) => c.path === "codeReviews/files")?.input).toEqual({ id: REVIEW_PAY });
});

test("chọn hàng khác thì mở PR đó và đặt ?id= vào URL", async ({ page }) => {
  await setup(page);
  await page.goto("/knowledge/reviews?tab=code");
  await table(page).getByRole("row").filter({ hasText: "Tách module thanh toán" }).click();
  await expect(page).toHaveURL(new RegExp(`tab=code.*id=${REVIEW_BIG}|id=${REVIEW_BIG}.*tab=code`));
  await expect(pane(page)).toContainText("Tách module thanh toán");
  await expect(table(page).getByRole("row").filter({ hasText: "Tách module thanh toán" })).toHaveAttribute(
    "data-state",
    "selected",
  );
});

test("duyệt: quorum 2 nên lần đầu PR vẫn chờ, gửi kèm headSha, badge và hàng chờ làm mới", async ({ page }) => {
  const { state, hub } = await setup(page);
  await page.goto("/knowledge/reviews?tab=code");
  const detail = pane(page);
  await expect(detail).toContainText("Đã duyệt 0/2");
  const listCalls = hub.rpcCalls.filter((c) => c.path === "codeReviews/list").length;
  await detail.getByRole("button", { name: "Duyệt", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã duyệt. PR sang bước tiếp theo." })).toBeVisible();
  expect(state.decisions).toEqual([{ id: REVIEW_PAY, headSha: HEAD_PAY, decision: "approve" }]);
  await expect.poll(() => hub.rpcCalls.filter((c) => c.path === "codeReviews/list").length).toBeGreaterThan(listCalls);
  // PR rời hàng "chờ tôi" nhưng vẫn mở, người duyệt thấy kết quả; menu đếm lại còn một PR.
  await expect(table(page).getByRole("row").filter({ hasText: "Hoàn tiền một phần" })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(REVIEW_PAY));
  await expect(detail).toContainText("Đã duyệt 1/2");
  await expect(page.getByRole("link", { name: /Chờ tôi duyệt/ })).toContainText("1 PR đang chờ bạn duyệt");
});

test("trả lại cần góp ý, rồi đi đúng hướng: agent sửa, người giao việc, checkpoint trước", async ({ page }) => {
  const { state } = await setup(page);
  await page.goto(`/knowledge/reviews?tab=code&id=${REVIEW_PAY}`);
  const detail = pane(page);
  const route = detail.getByRole("combobox", { name: "Nếu trả lại" });
  // Mặc định theo cấu hình checkpoint; "về checkpoint trước" có tên checkpoint đứng trước.
  await expect(route).toHaveValue("agent");
  await expect(route.locator("option")).toHaveText([
    "Agent sửa rồi quay lại đây",
    "Người giao việc sửa",
    "Về checkpoint trước (Review AI)",
  ]);

  await detail.getByRole("button", { name: "Trả lại" }).click();
  await expect(detail.getByText("Ghi góp ý khi trả lại.")).toBeVisible();
  expect(state.decisions).toEqual([]);

  await detail.getByLabel("Góp ý").fill("Chặn tổng hoàn vượt số tiền gốc.");
  await route.selectOption("previous");
  await detail.getByRole("button", { name: "Trả lại" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã trả lại: Về checkpoint trước." })).toBeVisible();
  expect(state.decisions).toEqual([
    {
      id: REVIEW_PAY,
      headSha: HEAD_PAY,
      decision: "changes",
      note: "Chặn tổng hoàn vượt số tiền gốc.",
      route: "previous",
    },
  ]);
  await expect(detail).toContainText("PR đã được trả lại, đang chờ bản sửa.");
});

for (const [value, label] of [
  ["agent", "Agent sửa rồi quay lại đây"],
  ["author", "Người giao việc sửa"],
] as const) {
  test(`trả lại theo hướng ${value} gửi đúng route`, async ({ page }) => {
    const { state } = await setup(page);
    await page.goto(`/knowledge/reviews?tab=code&id=${REVIEW_PAY}`);
    const detail = pane(page);
    await detail.getByLabel("Góp ý").fill("Cần sửa.");
    await detail.getByRole("combobox", { name: "Nếu trả lại" }).selectOption(value);
    await detail.getByRole("button", { name: "Trả lại" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Đã trả lại: ${label}.` })).toBeVisible();
    expect(state.decisions.at(-1)).toMatchObject({ decision: "changes", route: value, note: "Cần sửa." });
  });
}

test("PR cấu hình trả về checkpoint trước thì chọn sẵn hướng đó", async ({ page }) => {
  await setup(page);
  await page.goto(`/knowledge/reviews?tab=code&id=${REVIEW_BIG}`);
  await expect(pane(page).getByRole("combobox", { name: "Nếu trả lại" })).toHaveValue("previous");
});

test("người không đủ quyền: thấy PR, nút quyết định bị khoá và có giải thích", async ({ page }) => {
  const { state } = await setup(page, "member");
  await page.goto(`/knowledge/reviews?tab=code&id=${REVIEW_LEGACY}`);
  // PR này chỉ hiện ở "Tất cả": người duyệt khác đang được chờ.
  await expect(table(page).getByRole("row").filter({ hasText: "Đối soát ngày công" })).toHaveCount(0);
  await page.getByRole("button", { name: "Tất cả" }).click();
  const row = table(page).getByRole("row").filter({ hasText: "Đối soát ngày công" });
  await expect(row).toContainText("Quá hạn 3 giờ");
  await row.click();
  const detail = pane(page);
  await expect(detail.getByText("Bạn không có quyền quyết định ở checkpoint này.")).toBeVisible();
  await expect(detail.getByRole("button", { name: "Duyệt", exact: true })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "Trả lại" })).toBeDisabled();
  expect(state.decisions).toEqual([]);
});

test("hub từ chối quyết định (mất quyền giữa chừng): hiện lỗi, PR vẫn chờ", async ({ page }) => {
  const { state } = await setup(page);
  state.rejectDecision = { code: "FORBIDDEN", status: 403, message: "Bạn không phải người duyệt ở checkpoint này." };
  await page.goto(`/knowledge/reviews?tab=code&id=${REVIEW_PAY}`);
  await pane(page).getByRole("button", { name: "Duyệt", exact: true }).click();
  await expect(pane(page).getByRole("alert")).toContainText("Bạn không phải người duyệt ở checkpoint này.");
  await expect(pane(page).getByRole("button", { name: "Duyệt", exact: true })).toBeEnabled();
  expect(state.decisions).toEqual([]);
});

test("hub từ chối headSha cũ: hiện lỗi, PR vẫn chờ và nút còn dùng được", async ({ page }) => {
  const { state } = await setup(page);
  await page.goto(`/knowledge/reviews?tab=code&id=${REVIEW_PAY}`);
  await expect(pane(page)).toContainText("Hoàn tiền một phần");
  state.headMoved = true;
  await pane(page).getByRole("button", { name: "Duyệt", exact: true }).click();
  await expect(pane(page).getByRole("alert")).toContainText("PR đã có commit mới");
  await expect(pane(page).getByRole("button", { name: "Duyệt", exact: true })).toBeEnabled();
  expect(state.decisions).toEqual([]);
});

test("PR có commit mới: chặn quyết định cho tới khi Tải lại, rồi duyệt gửi kèm đầu mới", async ({ page }) => {
  const { state, sessions } = await setup(page);
  state.latestHead = NEW_HEAD_PAY;
  await page.goto(`/knowledge/reviews?tab=code&id=${REVIEW_PAY}`);
  const detail = pane(page);
  await expect(detail).toContainText("PR đã có commit mới (bbbbbbb)");
  await expect(detail.getByRole("button", { name: "Duyệt", exact: true })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "Trả lại" })).toBeDisabled();

  // Hub đã mở vòng 2 ở đầu mới; Tải lại lấy phiên và diff mới.
  const current = sessions[REVIEW_PAY];
  if (!current) throw new Error("thiếu phiên");
  sessions[REVIEW_PAY] = { ...current, pr: { ...current.pr, headSha: NEW_HEAD_PAY }, round: 2 };
  state.latestHead = null;
  await detail.getByRole("button", { name: "Tải lại" }).click();
  await expect(detail.getByText("PR đã có commit mới")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Duyệt", exact: true })).toBeEnabled();
  await detail.getByRole("button", { name: "Duyệt", exact: true }).click();
  await expect.poll(() => state.decisions.at(-1)?.headSha).toBe(NEW_HEAD_PAY);
});

test("PR đã duyệt, merge thủ công: đưa vào hàng merge", async ({ page }) => {
  const { state } = await setup(page);
  await page.goto(`/knowledge/reviews?tab=code&id=${REVIEW_DONE}`);
  await expect(page.getByRole("button", { name: "Tất cả" })).toBeVisible();
  await expect(pane(page)).toContainText("PR đã qua mọi checkpoint.");
  await pane(page).getByRole("button", { name: "Đưa vào hàng merge" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã đưa PR vào hàng merge." })).toBeVisible();
  expect(state.enqueued).toEqual([REVIEW_DONE]);
  await expect(pane(page)).toContainText("PR đang ở hàng merge.");
});

test("PR 100 file mở được ngay: đủ danh sách, chuyển file không chậm (SC-007)", async ({ page }) => {
  await setup(page);
  const started = Date.now();
  await page.goto(`/knowledge/reviews?tab=code&id=${REVIEW_BIG}`);
  const files = pane(page).getByRole("navigation", { name: "Danh sách file" });
  await expect(files.getByRole("button")).toHaveCount(BIG_FILE_COUNT);
  await expect(pane(page).getByText("const left = order.total - order.fee;")).toBeVisible();
  const last = files.getByRole("button").last();
  await last.click();
  await expect(last).toHaveAttribute("aria-current", "true");
  await expect(pane(page).getByText("const left = order.total - order.fee;")).toBeVisible();
  // Ngưỡng rộng cho máy CI chậm; SC-007 đòi vài giây, còn chặn hồi quy kiểu vẽ lại cả trăm patch mỗi lần chọn file.
  expect(Date.now() - started).toBeLessThan(8000);
});

test("360 px không tràn ngang và chuyển diff/quyết định xuống dưới", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/knowledge/reviews?tab=code&id=${REVIEW_PAY}`);
  await expect(pane(page)).toContainText("Hoàn tiền một phần");
  await expect(pane(page).getByRole("button", { name: "Duyệt", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("giao diện tối: tab Code đọc được và không tràn ngang", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("hive.theme", "dark"));
  await setup(page);
  await page.goto(`/knowledge/reviews?tab=code&id=${REVIEW_PAY}`);
  await expect(pane(page)).toContainText("Hoàn tiền một phần");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(pane(page).getByRole("button", { name: "Duyệt", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("tiếng Anh: tab, bảng và khung quyết định đổi chữ theo ngôn ngữ", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
  await setup(page);
  await page.goto(`/knowledge/reviews?tab=code&id=${REVIEW_PAY}`);
  await expect(page.getByRole("tablist", { name: "Review type" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Code review queue" })).toBeVisible();
  await expect(page.getByRole("region", { name: "PR details" })).toBeVisible();
});
