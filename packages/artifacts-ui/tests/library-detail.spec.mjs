import { createRequire } from "node:module";
import { detail, ID_A, ID_B, NOW, summary } from "./browser-fixtures.ts";

const webRequire = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { test, expect } = webRequire("@playwright/test");

async function mockHub(page) {
  const calls = [];
  let restored = false;
  await page.route("**/rpc/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/rpc/", "");
    const input = route.request().postDataJSON()?.json ?? {};
    calls.push({ path, input });
    let value;
    switch (path) {
      case "projects/list":
        value = [{ id: ID_B, key: "payment-api", name: "Thanh toán" }];
        break;
      case "artifacts/list":
        value = input.trash
          ? { items: restored ? [] : [{ ...summary(), deletedAt: NOW }], nextCursor: null }
          : input.query
            ? { items: [summary(ID_B)], nextCursor: null }
            : input.cursor
              ? { items: [summary(ID_B)], nextCursor: null }
              : { items: [summary()], nextCursor: "page-2" };
        break;
      case "artifacts/restore":
        restored = true;
        value = summary();
        break;
      case "artifacts/get":
        value = detail(input.id, input.version);
        break;
      case "artifacts/versions/list":
        value = [detail(input.id, 2).version, detail(input.id, 1).version];
        break;
      case "artifacts/links/list":
        value = [
          {
            targetKind: "chat_thread",
            targetId: ID_B,
            title: "Cuộc trò chuyện hoàn tiền",
            createdByUserId: "u1",
            createdByRunId: null,
            createdAt: NOW,
          },
        ];
        break;
      case "audit/list":
        value = {
          items: [
            {
              id: ID_A,
              createdAt: NOW,
              actorId: "u1",
              actor: "An",
              actorType: "user",
              action: "artifact.create",
              area: "other",
              targetType: "artifact",
              targetId: input.q,
              result: "ok",
              source: "web",
              ip: null,
            },
          ],
          nextCursor: null,
        };
        break;
      default:
        throw new Error(`Chưa giả lập thủ tục ${path}`);
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ json: value }) });
  });
  return calls;
}

test("lọc, con trỏ, mở chi tiết, tab liên kết/hoạt động và ghim phiên bản", async ({ page }) => {
  const calls = await mockHub(page);
  await page.goto("/");
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("button", { name: "Tải thêm" }).click();
  await expect(page.getByRole("button", { name: "Checklist release", exact: true })).toBeVisible();
  expect(calls.some((call) => call.input.cursor === "page-2")).toBe(true);
  await page.getByLabel("Tìm theo tiêu đề hoặc nội dung").fill("  checklist  ");
  await page.getByRole("combobox", { name: "Phạm vi", exact: true }).selectOption("project");
  await page.getByRole("combobox", { name: "Loại", exact: true }).selectOption("markdown");
  await page.getByRole("combobox", { name: "Nguồn", exact: true }).selectOption("mcp");
  await page.getByRole("combobox", { name: "Dự án", exact: true }).selectOption("payment-api");
  await expect
    .poll(() => calls.at(-1)?.input)
    .toEqual({
      query: "checklist",
      scope: "project",
      type: "markdown",
      origin: "mcp",
      projectKey: "payment-api",
      mine: false,
      trash: false,
      limit: 30,
    });
  await expect(page.getByRole("button", { name: "Luồng hoàn tiền", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Checklist release", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Nội dung bản 2" })).toBeVisible();
  await page.getByRole("tab", { name: "Liên kết" }).click();
  await expect(page.getByRole("link", { name: "Cuộc trò chuyện hoàn tiền" })).toBeVisible();
  await page.getByRole("tab", { name: "Hoạt động" }).click();
  await expect(page.getByText("Tạo artifact · An · Thành công")).toBeVisible();
  await page.goto(`/?id=${ID_A}&v=1`);
  await expect(page.getByRole("heading", { name: "Nội dung bản 1" })).toBeVisible();
  await expect(page.getByText("Có bản mới hơn (v2)")).toBeVisible();
});

test("360 px dùng thẻ, không cuộn ngang; khôi phục thùng rác", async ({ page }) => {
  const calls = await mockHub(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/");
  await expect(page.getByRole("table")).toBeHidden();
  await expect(page.getByRole("article")).toBeVisible();
  await expect(page.getByRole("button", { name: "Luồng hoàn tiền", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Thùng rác" }).click();
  await page.getByRole("button", { name: "Khôi phục", exact: true }).click();
  await expect(page.getByText("Đã khôi phục artifact.")).toBeVisible();
  await expect(page.getByText("Thùng rác trống", { exact: true })).toBeVisible();
  expect(calls.find((call) => call.path === "artifacts/restore")?.input).toEqual({ id: ID_A });
});

test("bản đệm offline đọc được và không gửi yêu cầu hub", async ({ page }) => {
  const calls = await mockHub(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(`/?id=${ID_A}&v=1&offline=1`);
  await expect(page.getByRole("heading", { name: "Nội dung bản 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sửa", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "Hoạt động" }).click();
  await expect(page.getByRole("tabpanel").getByText("Cần kết nối hub để mở.")).toBeVisible();
  expect(calls).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
