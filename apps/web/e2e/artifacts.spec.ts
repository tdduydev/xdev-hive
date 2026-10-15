import { expect, type Page, test } from "@playwright/test";
import {
  ARTIFACT_ORG,
  ARTIFACT_PROJECT,
  ARTIFACT_THREAD_ID,
  type ArtifactsFixture,
  artifactsFixture,
  COLLEAGUE,
  fakeArtifactFrames,
  fakeHub,
  USER,
} from "./fake-hub.ts";

const MARKDOWN = "# Luồng thanh toán\n\n1. Khách đặt hàng\n2. Cổng thanh toán xác nhận\n";
const MERMAID = "flowchart TD\n  A[Đặt hàng] --> B[Thanh toán]\n  B --> C[Giao hàng]\n";
const HTML =
  '<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Bảng giá</title></head><body><h1>Bảng giá</h1><p>Gói cơ bản</p></body></html>';
const REACT_SOURCE = "export default function App() {\n  return <h1>Bảng điều khiển</h1>;\n}\n";
// Bản biên dịch như `compileReact` của hub trả (sucrase, JSX runtime tự động).
const REACT_COMPILED =
  'import { jsx as _jsx } from "react/jsx-runtime";\nexport default function App() {\n  return _jsx("h1", { children: "Bảng điều khiển" });\n}\n';
const REACT_BROKEN = 'export default function App() {\n  throw new Error("Không đọc được bảng giá");\n}\n';

async function openAs(page: Page, fixture: ArtifactsFixture, user = USER) {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ARTIFACT_ORG.id);
  const hub = await fakeHub(page, { signedIn: true, user, rpc: fixture.rpcFor(user) });
  const frames = await fakeArtifactFrames(page, fixture);
  return { hub, frames };
}

const panelOf = (page: Page) => page.getByRole("region", { name: "Artifact", exact: true });
const frameOf = (page: Page, title: string) => page.frameLocator(`iframe[title="Trang của artifact ${title}"]`);

function seedFour(fixture: ArtifactsFixture) {
  fixture.message({ role: "user", content: "Làm tài liệu luồng thanh toán" });
  const md = fixture.leaderSave({ type: "markdown", title: "Luồng thanh toán", content: MARKDOWN });
  fixture.leaderSave({ type: "mermaid", title: "Sơ đồ thanh toán", content: MERMAID });
  fixture.leaderSave({ type: "html", title: "Bảng giá", content: HTML });
  fixture.leaderSave({ type: "react", title: "Bảng điều khiển", content: REACT_SOURCE, compiled: REACT_COMPILED });
  fixture.message({ role: "leader", content: "Đã tạo bốn artifact." });
  return md;
}

test("artifact: Leader tạo bốn loại → khung tự mở; sửa, so sánh, khôi phục, chia sẻ dự án, đồng nghiệp mở (SC-003, SC-008)", async ({
  page,
  browser,
}) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = artifactsFixture();
  fixture.message({ role: "user", content: "Làm tài liệu luồng thanh toán" });
  const { hub } = await openAs(page, fixture);
  await page.goto(`/leader?thread=${ARTIFACT_THREAD_ID}`);
  const messages = page.getByRole("list", { name: "Tin nhắn" });
  await expect(messages).toContainText("Làm tài liệu luồng thanh toán");
  const panel = panelOf(page);
  await expect(panel).toHaveCount(0);

  // SC-003: thẻ hiện và khung mở trong 3 giây sau khi tool trả kết quả (thăm dò của trang chờ leader).
  const started = Date.now();
  const md = fixture.leaderSave({ type: "markdown", title: "Luồng thanh toán", content: MARKDOWN });
  await expect(panel.getByRole("heading", { name: "Luồng thanh toán", level: 3 })).toBeVisible({ timeout: 3000 });
  await expect(messages.getByRole("article", { name: "Artifact Luồng thanh toán, phiên bản 1" })).toBeVisible();
  const elapsed = Date.now() - started;
  test.info().annotations.push({ type: "SC-003", description: `${elapsed} ms` });
  expect(elapsed).toBeLessThanOrEqual(3000);
  await expect(panel.getByText("Cổng thanh toán xác nhận")).toBeVisible();

  // Thẻ mới tự mở trong khung; tab giữ cả bốn artifact của cuộc trò chuyện.
  fixture.leaderSave({ type: "mermaid", title: "Sơ đồ thanh toán", content: MERMAID });
  fixture.leaderSave({ type: "html", title: "Bảng giá", content: HTML });
  fixture.leaderSave({ type: "react", title: "Bảng điều khiển", content: REACT_SOURCE, compiled: REACT_COMPILED });
  fixture.message({ role: "leader", content: "Đã tạo bốn artifact." });
  await expect(messages).toContainText("Đã tạo bốn artifact.");
  await expect(frameOf(page, "Bảng điều khiển").getByRole("heading", { name: "Bảng điều khiển" })).toBeVisible();
  const tabs = panel.getByRole("navigation", { name: "Artifact của cuộc trò chuyện" }).getByRole("button");
  await expect(tabs).toHaveCount(4);
  await expect(page.getByText("Nội dung do agent tạo — không nhập mật khẩu hay dữ liệu bí mật.")).toBeVisible();

  await tabs.filter({ hasText: "Sơ đồ thanh toán" }).click();
  await expect(frameOf(page, "Sơ đồ thanh toán").locator("svg").first()).toBeVisible();
  await expect(frameOf(page, "Sơ đồ thanh toán").getByText("Thanh toán", { exact: true })).toBeVisible();
  await tabs.filter({ hasText: "Bảng giá" }).click();
  await expect(frameOf(page, "Bảng giá").getByRole("heading", { name: "Bảng giá" })).toBeVisible();

  // Thẻ "Mở" mở đúng phiên bản của thẻ trong khung.
  await messages.getByRole("article", { name: "Artifact Luồng thanh toán, phiên bản 1" }).getByRole("button").click();
  await expect(panel.getByRole("heading", { name: "Luồng thanh toán", level: 3 })).toBeVisible();

  // Sửa tay tạo v2.
  await panel.getByRole("button", { name: "Sửa" }).click();
  await panel.getByRole("textbox", { name: "Nội dung" }).fill(`${MARKDOWN}3. Gửi email xác nhận\n`);
  await panel.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(panel.getByText("Gửi email xác nhận")).toBeVisible();
  await expect(panel.getByLabel("Phiên bản", { exact: true })).toHaveValue("2");
  expect(hub.rpcCalls.find((c) => c.path === "artifacts/update")?.input).toMatchObject({ id: md.id, baseVersion: 1 });

  // Toàn màn → trang chi tiết của phiên bản; so sánh v1 với v2 rồi khôi phục v1 thành v3.
  await panel.getByRole("link", { name: "Mở toàn màn" }).click();
  await expect(page).toHaveURL(new RegExp(`/artifacts/${md.id}/v/2$`));
  await expect(page.getByRole("heading", { name: "Luồng thanh toán", level: 1 }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Phiên bản" }).click();
  const compare = page.getByRole("region", { name: "So sánh" });
  await compare.getByLabel("Bản trước").selectOption("1");
  await compare.getByLabel("Bản sau").selectOption("2");
  await expect(compare).toContainText("Gửi email xác nhận");
  const v1 = page.getByRole("listitem").filter({ has: page.getByText("v1", { exact: true }) });
  await v1.getByRole("button", { name: "Khôi phục bản này" }).click();
  await page.getByRole("button", { name: "Khôi phục", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/artifacts/${md.id}/v/3$`));
  expect(fixture.state.artifacts[0]?.versions.at(-1)).toMatchObject({ version: 3, restoredFrom: 1, content: MARKDOWN });

  // Chia sẻ cho dự án: cảnh báo phiên bản cũ phải được xác nhận trước khi lưu.
  await page.getByRole("tab", { name: "Nội dung" }).click();
  await page.getByRole("button", { name: "Chia sẻ" }).click();
  const share = page.getByRole("dialog", { name: "Chia sẻ" });
  await share.getByRole("radio", { name: /^Dự án/ }).check();
  await share.getByRole("combobox").selectOption(ARTIFACT_PROJECT.key);
  const save = share.getByRole("button", { name: "Lưu thay đổi" });
  await expect(save).toBeDisabled();
  await share.getByRole("checkbox", { name: "Tôi đã kiểm tra các phiên bản cũ." }).check();
  await save.click();
  await expect(share.getByText("Đã đổi phạm vi.")).toBeVisible();
  expect(fixture.state.artifacts[0]).toMatchObject({ scope: "project", project: { key: ARTIFACT_PROJECT.key } });

  // Đồng nghiệp ở trình duyệt khác thấy artifact đã chia sẻ, không thấy bản cá nhân của chủ; sửa được, không chia sẻ được.
  const other = await browser.newContext({ locale: "vi-VN" });
  const colleague = await other.newPage();
  await openAs(colleague, fixture, COLLEAGUE);
  await colleague.goto("/artifacts");
  const library = colleague.getByRole("region", { name: "Artifact", exact: true });
  await expect(library.getByRole("link", { name: "Luồng thanh toán" }).first()).toBeVisible();
  await expect(library.getByText("Bảng giá")).toHaveCount(0);
  await library.getByRole("link", { name: "Luồng thanh toán" }).first().click();
  await expect(colleague.getByRole("heading", { name: "Luồng thanh toán", level: 1 }).first()).toBeVisible();
  await expect(colleague.getByRole("button", { name: "Sửa" })).toBeVisible();
  await expect(colleague.getByRole("button", { name: "Chia sẻ" })).toHaveCount(0);
  await other.close();
});

test("artifact: trang react báo lỗi → Nhờ Leader sửa → về cuộc trò chuyện, bản mới hết lỗi", async ({ page }) => {
  const fixture = artifactsFixture();
  fixture.message({ role: "user", content: "Làm bảng điều khiển" });
  const app = fixture.leaderSave({
    type: "react",
    title: "Bảng điều khiển",
    content: REACT_SOURCE,
    compiled: REACT_BROKEN,
  });
  fixture.message({ role: "leader", content: "Đã tạo bảng điều khiển." });
  // Leader nhận lời nhờ thì lưu bản sửa, như run `leader` gọi `artifact_update`.
  fixture.state.onSend = () => {
    fixture.leaderSave({ id: app.id, content: REACT_SOURCE, compiled: REACT_COMPILED });
    fixture.message({ role: "leader", content: "Đã sửa lỗi đọc bảng giá." });
  };
  const { hub } = await openAs(page, fixture);
  await page.goto(`/artifacts/${app.id}`);
  const errors = page.getByRole("alert").filter({ hasText: "Trang báo lỗi" });
  await expect(errors).toContainText("Không đọc được bảng giá");
  await errors.getByRole("button", { name: "Nhờ Leader sửa" }).click();

  const dialog = page.getByRole("dialog", { name: "Nhờ Leader sửa" });
  await expect(dialog.getByRole("textbox").first()).toHaveValue(/Không đọc được bảng giá/);
  await dialog.getByRole("button", { name: "Gửi yêu cầu sửa" }).click();
  await expect(page).toHaveURL(new RegExp(`/leader\\?thread=${ARTIFACT_THREAD_ID}`));
  expect(hub.rpcCalls.find((c) => c.path === "artifacts/askLeaderFix")?.input).toMatchObject({
    id: app.id,
    version: 1,
    errors: [expect.objectContaining({ message: expect.stringContaining("Không đọc được bảng giá") })],
  });

  const messages = page.getByRole("list", { name: "Tin nhắn" });
  await expect(messages).toContainText("Đã sửa lỗi đọc bảng giá.");
  await expect(messages.getByRole("article", { name: "Artifact Bảng điều khiển, phiên bản 2" })).toBeVisible();
  await expect(frameOf(page, "Bảng điều khiển").getByRole("heading", { name: "Bảng điều khiển" })).toBeVisible();
  await expect(panelOf(page).getByText("Trang báo lỗi")).toHaveCount(0);
});

test("artifact: 360 px, tối — khung là ngăn kéo toàn màn, không cuộn ngang", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.addInitScript(() => localStorage.setItem("hive.theme", "dark"));
  const fixture = artifactsFixture();
  seedFour(fixture);
  const { hub } = await openAs(page, fixture);
  await page.goto(`/leader?thread=${ARTIFACT_THREAD_ID}`);
  const messages = page.getByRole("list", { name: "Tin nhắn" });
  await expect(messages.getByRole("article")).toHaveCount(4);
  await expect(panelOf(page)).toHaveCount(0);
  const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noHorizontalScroll()).toBe(true);

  await page.getByRole("button", { name: "Artifact của cuộc trò chuyện (4)" }).click();
  const panel = panelOf(page);
  await expect(panel.getByRole("heading", { name: "Bảng điều khiển", level: 3 })).toBeVisible();
  expect((await page.getByRole("dialog", { name: "Artifact" }).boundingBox())?.width).toBeCloseTo(360, 0);
  await expect(frameOf(page, "Bảng điều khiển").getByRole("heading", { name: "Bảng điều khiển" })).toBeVisible();
  // Khung nhận giao diện tối qua vé, không đọc được CSS của trang.
  expect(hub.rpcCalls.find((c) => c.path === "artifacts/frameUrl")?.input).toMatchObject({ theme: "dark" });

  await panel.getByRole("button", { name: "Về cuộc trò chuyện" }).click();
  await expect(panel).toHaveCount(0);

  // Thẻ mới đến khi ngăn kéo đang đóng thì tự mở ngăn kéo.
  await page.getByLabel("Nhắn cho leader").fill("Thêm ghi chú");
  await page.getByRole("button", { name: "Gửi", exact: true }).click();
  await expect(messages).toContainText("Thêm ghi chú");
  fixture.leaderSave({ type: "markdown", title: "Ghi chú triển khai", content: "# Ghi chú\n\nBật cờ tính năng." });
  await expect(panel.getByRole("heading", { name: "Ghi chú triển khai", level: 3 })).toBeVisible();
  await panel.getByRole("button", { name: "Về cuộc trò chuyện" }).click();

  await page.goto("/artifacts");
  await expect(page.getByRole("link", { name: "Ghi chú triển khai" }).first()).toBeVisible();
  expect(await noHorizontalScroll()).toBe(true);
  await page.goto(`/artifacts/${fixture.state.artifacts[0]?.id}`);
  await expect(page.getByRole("heading", { name: "Luồng thanh toán", level: 1 }).first()).toBeVisible();
  expect(await noHorizontalScroll()).toBe(true);
});

test("artifact: vạch chia kéo được bằng phím, nhớ độ rộng và trạng thái đóng khung", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = artifactsFixture();
  seedFour(fixture);
  await openAs(page, fixture);
  await page.goto(`/leader?thread=${ARTIFACT_THREAD_ID}`);
  const panel = panelOf(page);
  await expect(panel.getByRole("heading", { name: "Bảng điều khiển", level: 3 })).toBeVisible();

  const divider = page.getByRole("separator", { name: "Kéo để đổi độ rộng khung artifact" });
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  const before = (await panel.boundingBox())?.width ?? 0;
  await divider.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", "60");
  expect((await panel.boundingBox())?.width ?? 0).toBeGreaterThan(before);

  // Kéo bằng chuột về phía phải làm khung hẹp lại.
  const handle = await divider.boundingBox();
  if (!handle) throw new Error("Không thấy vạch chia");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 40);
  await page.mouse.down();
  await page.mouse.move(handle.x + 200, handle.y + 40, { steps: 5 });
  await page.mouse.up();
  const dragged = Number(await divider.getAttribute("aria-valuenow"));
  expect(dragged).toBeLessThan(60);

  await page.reload();
  await expect(divider).toHaveAttribute("aria-valuenow", String(dragged));

  await panel.getByRole("button", { name: "Đóng khung" }).click();
  await expect(panel).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("list", { name: "Tin nhắn" }).getByRole("article")).toHaveCount(4);
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: "Artifact của cuộc trò chuyện (4)" }).click();
  await expect(panel).toBeVisible();
});

test("artifact: thẻ của artifact đã xoá hay đã mất", async ({ page }) => {
  const fixture = artifactsFixture();
  seedFour(fixture).deletedAt = "2026-10-14T09:00:00.000Z";
  // Hub trả `artifact` null khi artifact đã bị xoá hẳn (hay người xem không còn đọc được): tin nhắn chỉ còn tiêu đề.
  const gone = fixture.state.artifacts[1];
  if (gone) gone.ownerId = COLLEAGUE.id;
  await openAs(page, fixture);
  await page.goto(`/leader?thread=${ARTIFACT_THREAD_ID}`);
  const messages = page.getByRole("list", { name: "Tin nhắn" });
  await expect(messages.getByText("Artifact không còn truy cập được.")).toHaveCount(1);
  await expect(messages.getByText("Sơ đồ thanh toán")).toBeVisible();
  await expect(messages.getByRole("article")).toHaveCount(2);
  await expect(
    panelOf(page).getByRole("navigation", { name: "Artifact của cuộc trò chuyện" }).getByRole("button"),
  ).toHaveCount(2);
});
