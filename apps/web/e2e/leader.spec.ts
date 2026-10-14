import { expect, type Page, test } from "@playwright/test";
import { fakeHub, ok, type RpcHandler } from "./fake-hub.ts";

const ORG_ID = "0a0a0a0a-0000-4000-8000-00000000000a";
const PROJECT = { id: "9a9a9a9a-0000-4000-8000-000000000001", key: "PAY", name: "payment-api" };
const THREAD = {
  id: "4d4d4d4d-0000-4000-8000-000000000001",
  projectId: PROJECT.id,
  title: "Chia việc thanh toán",
  createdAt: "2026-10-12T01:00:00.000Z",
  updatedAt: "2026-10-12T01:05:00.000Z",
};
const msg = (n: number, role: "user" | "leader" | "system", content: string) => ({
  id: `5e5e5e5e-0000-4000-8000-00000000000${n}`,
  role,
  content,
  runId: null,
  createdAt: `2026-10-12T01:0${n}:00.000Z`,
});
const APPROVAL = {
  id: "6f6f6f6f-0000-4000-8000-000000000001",
  threadId: THREAD.id,
  action: { type: "task.create", projectId: PROJECT.id, title: "Thêm hoàn tiền", body: "" },
  status: "pending",
  expiresAt: "2026-10-13T01:00:00.000Z",
  decidedBy: null,
  reason: null,
  createdAt: "2026-10-12T01:05:00.000Z",
};

async function open(page: Page, rpc: Record<string, RpcHandler> = {}) {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_ID);
  return fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [
            { id: ORG_ID, slug: "acme", name: "Acme", role: "admin", emailDomain: null, createdAt: THREAD.createdAt },
          ],
          canCreateOrg: false,
        }),
      "projects/list": () => ok([PROJECT]),
      "leader/threads/list": () => ok([THREAD]),
      "leader/threads/get": () =>
        ok({
          thread: THREAD,
          messages: [msg(1, "user", "Chia việc giúp mình"), msg(2, "leader", "Đề xuất tạo việc.")],
        }),
      "leader/approvals/list": () => ok([APPROVAL]),
      "terminal/list": () => ok([]),
      ...rpc,
    },
  });
}

test("leader: xem tin nhắn và duyệt đề xuất tạo việc", async ({ page }) => {
  const hub = await open(page, {
    "leader/approvals/approve": () =>
      ok({ approval: { ...APPROVAL, status: "approved" }, result: { taskKey: "PAY-9" } }),
  });
  await page.goto("/leader");
  await expect(page.getByRole("heading", { name: "Chia việc thanh toán" })).toBeVisible();
  const messages = page.getByRole("list", { name: "Tin nhắn" });
  await expect(messages).toContainText("Chia việc giúp mình");
  await expect(messages).toContainText("Đề xuất tạo việc.");

  const card = page.getByLabel("Đề xuất của leader");
  await expect(card).toContainText('Tạo việc "Thêm hoàn tiền" trong dự án PAY');
  await card.getByRole("button", { name: "Duyệt và thực hiện" }).click();
  await expect
    .poll(() => hub.rpcCalls.find((c) => c.path === "leader/approvals/approve")?.input)
    .toEqual({
      id: APPROVAL.id,
    });
});

test("leader: đề xuất có cấp độ và lý do, sửa cấp rồi duyệt gửi tier mới", async ({ page }) => {
  const leveled = {
    ...APPROVAL,
    action: { ...APPROVAL.action, tier: "light", tierReason: "Chỉ đổi chữ trên nút." },
  };
  const hub = await open(page, {
    "leader/approvals/list": () => ok([leveled]),
    "leader/approvals/approve": () =>
      ok({ approval: { ...leveled, status: "approved" }, result: { taskKey: "PAY-9" } }),
  });
  await page.goto("/leader");
  const card = page.getByLabel("Đề xuất của leader");
  await expect(card).toContainText("Leader chọn cấp: Nhẹ");
  await expect(card).toContainText("Chỉ đổi chữ trên nút.");
  const tier = card.getByLabel("Cấp độ khi duyệt");
  await expect(tier).toHaveValue("light");
  await expect(card).toContainText("Tài liệu, đổi chữ");
  await tier.selectOption("heavy");
  await expect(card).toContainText("Nhiều module, giao thức, bảo mật");
  await card.getByRole("button", { name: "Duyệt và thực hiện" }).click();
  await expect
    .poll(() => hub.rpcCalls.find((c) => c.path === "leader/approvals/approve")?.input)
    .toEqual({ id: APPROVAL.id, tier: "heavy" });
});

test("leader: đề xuất cũ không có cấp độ thì để hub tự suy và duyệt không gửi tier", async ({ page }) => {
  const hub = await open(page, {
    "leader/approvals/approve": () => ok({ approval: { ...APPROVAL, status: "approved" }, result: null }),
  });
  await page.goto("/leader");
  const card = page.getByLabel("Đề xuất của leader");
  await expect(card).toContainText("Leader chưa chọn cấp độ");
  await expect(card.getByLabel("Cấp độ khi duyệt")).toHaveValue("");
  await card.getByRole("button", { name: "Duyệt và thực hiện" }).click();
  await expect
    .poll(() => hub.rpcCalls.find((c) => c.path === "leader/approvals/approve")?.input)
    .toEqual({ id: APPROVAL.id });
});

test("leader: từ chối đề xuất bắt buộc có lý do", async ({ page }) => {
  const hub = await open(page, {
    "leader/approvals/reject": (input) =>
      ok({ ...APPROVAL, status: "rejected", reason: (input as { reason: string }).reason }),
  });
  await page.goto("/leader");
  const card = page.getByLabel("Đề xuất của leader");
  await card.getByRole("button", { name: "Từ chối…" }).click();
  await expect(card.getByRole("button", { name: "Từ chối", exact: true })).toBeDisabled();
  await card.getByLabel("Lý do từ chối").fill("Chưa ưu tiên trong quý này");
  await card.getByRole("button", { name: "Từ chối", exact: true }).click();
  await expect
    .poll(() => hub.rpcCalls.find((c) => c.path === "leader/approvals/reject")?.input)
    .toEqual({
      id: APPROVAL.id,
      reason: "Chưa ưu tiên trong quý này",
    });
});

test("leader: gửi tin thì hiện đang chờ trả lời", async ({ page }) => {
  let sent = false;
  const hub = await open(page, {
    "leader/approvals/list": () => ok([]),
    "leader/threads/get": () =>
      ok({
        thread: THREAD,
        messages: sent ? [msg(1, "user", "Có máy nào rảnh không?")] : [],
      }),
    "leader/threads/send": () => {
      sent = true;
      return ok({ message: msg(1, "user", "Có máy nào rảnh không?"), runId: "7a7a7a7a-0000-4000-8000-000000000001" });
    },
  });
  await page.goto(`/leader?thread=${THREAD.id}`);
  await expect(page.getByRole("button", { name: "Gửi" })).toBeDisabled();
  await page.getByLabel("Nhắn cho leader").fill("Có máy nào rảnh không?");
  await page.getByRole("button", { name: "Gửi" }).click();
  await expect(page.getByRole("status")).toHaveText("Leader đang trả lời…");
  expect(hub.rpcCalls.find((c) => c.path === "leader/threads/send")?.input).toEqual({
    id: THREAD.id,
    content: "Có máy nào rảnh không?",
  });
  await expect(page.getByLabel("Nhắn cho leader")).toHaveValue("");
});

test("leader: tạo cuộc trò chuyện mới gắn dự án rồi mở nó", async ({ page }) => {
  const created = { ...THREAD, id: "4d4d4d4d-0000-4000-8000-000000000002", title: "Hỏi về chi phí" };
  const hub = await open(page, {
    "leader/threads/list": () => ok([]),
    "leader/threads/create": () => ok(created),
    "leader/threads/get": () => ok({ thread: created, messages: [] }),
    "leader/approvals/list": () => ok([]),
  });
  await page.goto("/leader");
  await expect(page.getByText("Chưa có cuộc trò chuyện nào")).toBeVisible();
  await page.getByRole("textbox", { name: "Cuộc trò chuyện mới" }).fill("Hỏi về chi phí");
  await page.getByLabel("Dự án").selectOption(PROJECT.id);
  await page.getByRole("button", { name: "Tạo", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`thread=${created.id}`));
  expect(hub.rpcCalls.find((c) => c.path === "leader/threads/create")?.input).toEqual({
    title: "Hỏi về chi phí",
    projectId: PROJECT.id,
  });
});

test("leader: tìm cuộc trò chuyện và mở form tạo bằng bàn phím", async ({ page }) => {
  await open(page);
  await page.goto("/leader");
  const threads = page.getByRole("navigation", { name: "Cuộc trò chuyện", exact: true });
  await expect(threads.getByRole("button")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Tìm cuộc trò chuyện" }).fill("không khớp");
  await expect(threads.getByRole("button")).toHaveCount(0);
  await expect(page.getByText("Không có cuộc trò chuyện phù hợp.")).toBeVisible();
  await page.getByRole("textbox", { name: "Tìm cuộc trò chuyện" }).fill("THANH TOÁN");
  await expect(threads.getByRole("button")).toHaveCount(1);
  const create = page.getByRole("button", { name: "Cuộc trò chuyện mới", exact: true });
  await create.focus();
  await page.keyboard.press("Enter");
  await expect(create).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("textbox", { name: "Cuộc trò chuyện mới" })).toBeVisible();
});

test("leader: Shift+Enter xuống dòng, Enter gửi và chờ câu trả lời mới", async ({ page }) => {
  let sent = false;
  let replied = false;
  const hub = await open(page, {
    "leader/approvals/list": () => ok([]),
    "leader/threads/get": () =>
      ok({
        thread: THREAD,
        messages: !sent
          ? []
          : replied
            ? [msg(1, "user", "API trước\nUI sau"), msg(2, "leader", "Đã hiểu.")]
            : [msg(1, "user", "API trước\nUI sau")],
      }),
    "leader/threads/send": () => {
      sent = true;
      return ok({ message: msg(1, "user", "API trước\nUI sau"), runId: "7a7a7a7a-0000-4000-8000-000000000001" });
    },
  });
  await page.goto("/leader");
  const composer = page.getByRole("textbox", { name: "Nhắn cho leader" });
  await composer.fill("API trước");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("UI sau");
  await expect(composer).toHaveValue("API trước\nUI sau");
  await composer.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Leader đang trả lời…");
  expect(hub.rpcCalls.find((call) => call.path === "leader/threads/send")?.input).toEqual({
    id: THREAD.id,
    content: "API trước\nUI sau",
  });
  // Ô soạn được xoá khi gửi xong; gõ trước lúc đó thì chữ mới bị xoá theo và nút Gửi tắt luôn.
  await expect(composer).toHaveValue("");
  await composer.fill("Tin tiếp theo");
  await expect(page.getByRole("button", { name: "Gửi", exact: true })).toBeDisabled();
  replied = true;
  await expect(page.getByText("Đã hiểu.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Gửi", exact: true })).toBeEnabled();
});

for (const scheme of ["light", "dark"] as const) {
  test(`leader: song ngữ, 360px, ${scheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
    await open(page);
    await page.goto("/leader");
    await expect(page.getByRole("textbox", { name: "Search conversations" })).toBeVisible();
    const proposal = page.getByLabel("Leader proposal");
    await expect(proposal).toContainText('Create task "Thêm hoàn tiền" in project PAY');
    await proposal.getByRole("button", { name: "Reject…" }).click();
    await expect(proposal.getByRole("textbox", { name: "Reason for rejecting" })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`leader-360-${scheme}.png`), fullPage: true });
  });
}
