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
  await page.getByLabel("Cuộc trò chuyện mới").fill("Hỏi về chi phí");
  await page.getByLabel("Dự án").selectOption(PROJECT.id);
  await page.getByRole("button", { name: "Tạo", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`thread=${created.id}`));
  expect(hub.rpcCalls.find((c) => c.path === "leader/threads/create")?.input).toEqual({
    title: "Hỏi về chi phí",
    projectId: PROJECT.id,
  });
});
