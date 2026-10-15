import { expect, type Page, test } from "@playwright/test";
import {
  ARTIFACT_ORG,
  ARTIFACT_THREAD_ID,
  artifactsFixture,
  fail,
  fakeArtifactFrames,
  fakeHub,
  USER,
} from "./fake-hub.ts";

const broken = 'export default function App() { throw new Error("Không đọc được bảng giá"); }';

async function setup(page: Page) {
  const fixture = artifactsFixture();
  const app = fixture.leaderSave({
    type: "react",
    title: "Bảng giá lỗi",
    content: "export default function App() { return <h1>Bảng giá</h1>; }",
    compiled: broken,
  });
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ARTIFACT_ORG.id);
  await fakeArtifactFrames(page, fixture);
  const hub = await fakeHub(page, { signedIn: true, rpc: fixture.rpcFor(USER) });
  return { fixture, app, hub };
}

test("Nhờ Leader sửa: sửa lỗi, thêm lời nhắn, gửi vào cuộc trò chuyện đang mở và nhận v2 (SC-008)", async ({
  page,
}) => {
  const { fixture, app, hub } = await setup(page);
  await page.goto(`/leader?thread=${ARTIFACT_THREAD_ID}`);
  const panel = page.getByRole("region", { name: "Artifact", exact: true });
  await expect(panel.getByText("Không đọc được bảng giá", { exact: false })).toBeVisible();
  await panel.getByRole("button", { name: "Nhờ Leader sửa" }).click();
  const dialog = page.getByRole("dialog", { name: "Nhờ Leader sửa" });
  await dialog.getByRole("textbox").first().fill("Kiểm tra nguồn bảng giá trước khi đọc");
  await dialog.getByRole("textbox").last().fill("Giữ nguyên bố cục");
  await expect(dialog.getByRole("radio", { name: "Cuộc trò chuyện này" })).toBeChecked();
  fixture.state.onSend = () => {
    fixture.leaderSave({
      id: app.id,
      content: "export default function App() { return <h1>Bảng giá đã sửa</h1>; }",
      compiled:
        'import { jsx } from "react/jsx-runtime"; export default function App() { return jsx("h1", { children: "Bảng giá đã sửa" }); }',
    });
    fixture.message({ role: "leader", content: "Đã sửa bảng giá." });
  };
  await dialog.getByRole("button", { name: "Gửi yêu cầu sửa" }).click();
  await expect(dialog).toBeHidden();
  const input = hub.rpcCalls.find((c) => c.path === "artifacts/askLeaderFix")?.input;
  expect(input).toMatchObject({
    id: app.id,
    version: 1,
    threadId: ARTIFACT_THREAD_ID,
    note: "Giữ nguyên bố cục",
    errors: [expect.objectContaining({ message: "Kiểm tra nguồn bảng giá trước khi đọc" })],
  });
  const messages = page.getByRole("list", { name: "Tin nhắn" });
  expect(fixture.state.messages.find((m) => m.role === "user" && m.artifact?.id === app.id)).toMatchObject({
    content: "Giữ nguyên bố cục",
    pageErrors: [expect.objectContaining({ message: "Kiểm tra nguồn bảng giá trước khi đọc" })],
  });
  test.info().annotations.push({
    type: "T030 follow-up",
    description:
      "Leader hiện thẻ của tin nhắn yêu cầu sửa nhưng chưa hiện lời nhắn/lỗi kèm thẻ; leader-page.tsx ngoài Scope T031.",
  });
  await expect(messages.getByRole("article", { name: "Artifact Bảng giá lỗi, phiên bản 1" }).last()).toBeVisible();
  await expect(messages).toContainText("Đã sửa bảng giá.");
  await expect(page.frameLocator("iframe").getByRole("heading", { name: "Bảng giá đã sửa" })).toBeVisible();
  await expect(panel.getByText("Trang báo lỗi")).toHaveCount(0);
});

test("Nhờ Leader sửa: từ chi tiết, xoá lỗi, chỉ gửi lời nhắn vào cuộc trò chuyện mới của người xem", async ({
  page,
}) => {
  const { fixture, app, hub } = await setup(page);
  const newThread = "5e5e5e5e-0000-4000-8000-000000000099";
  fixture.state.fixThreadId = newThread;
  await page.goto(`/artifacts/${app.id}`);
  await page.getByRole("button", { name: "Nhờ Leader sửa" }).click();
  const dialog = page.getByRole("dialog", { name: "Nhờ Leader sửa" });
  await expect(dialog.getByRole("radio", { name: "Cuộc trò chuyện này" })).toHaveCount(0);
  await dialog
    .getByRole("button", { name: /^Bỏ lỗi này:/ })
    .first()
    .click();
  await expect(dialog.getByRole("button", { name: "Gửi yêu cầu sửa" })).toBeDisabled();
  await dialog.getByRole("textbox").last().fill("Sửa nhãn nút");
  await dialog.getByRole("button", { name: "Gửi yêu cầu sửa" }).click();
  await expect(page).toHaveURL(new RegExp(`/leader\\?thread=${newThread}`));
  const input = hub.rpcCalls.find((c) => c.path === "artifacts/askLeaderFix")?.input;
  expect(input).toMatchObject({ id: app.id, version: 1, note: "Sửa nhãn nút", errors: [] });
  expect(input).not.toHaveProperty("threadId");
  expect(fixture.state.messages.find((m) => m.role === "user" && m.artifact?.id === app.id)?.content).toBe(
    "Sửa nhãn nút",
  );
  await expect(
    page
      .getByRole("list", { name: "Tin nhắn" })
      .getByRole("article", { name: "Artifact Bảng giá lỗi, phiên bản 1" })
      .last(),
  ).toBeVisible();
});

test("Nhờ Leader sửa: 360 px, tối; console.warn gom lỗi, gửi lỗi thất bại rồi thử lại", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.addInitScript(() => localStorage.setItem("hive.theme", "dark"));
  const { fixture, app } = await setup(page);
  app.type = "html";
  const version = app.versions[0];
  if (!version) throw new Error("Thiếu phiên bản thử nghiệm");
  version.content = '<h1>Bảng giá</h1><script>console.warn("Cảnh báo từ trang <img onerror=alert(1)>");</script>';
  let failed = true;
  const rpc = fixture.rpcFor(USER);
  await fakeHub(page, {
    signedIn: true,
    rpc: {
      ...rpc,
      "artifacts/askLeaderFix": (...args) =>
        failed
          ? fail("CONFLICT", 409, "Chưa gửi được yêu cầu sửa.")
          : (rpc["artifacts/askLeaderFix"]?.(...args) as never),
    },
  });
  await page.goto(`/artifacts/${app.id}`);
  await page.getByRole("button", { name: "Nhờ Leader sửa" }).click();
  const dialog = page.getByRole("dialog", { name: "Nhờ Leader sửa" });
  await expect(dialog.getByRole("textbox").first()).toHaveValue("Cảnh báo từ trang <img onerror=alert(1)>");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(dialog.locator("img")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Gửi yêu cầu sửa" }).click();
  await expect(dialog.getByText("Chưa gửi được yêu cầu sửa.")).toBeVisible();
  failed = false;
  await dialog.getByRole("button", { name: "Gửi yêu cầu sửa" }).click();
  await expect(page).toHaveURL(new RegExp(`/leader\\?thread=${ARTIFACT_THREAD_ID}`));
  expect(fixture.state.fixRequests).toHaveLength(1);
});
