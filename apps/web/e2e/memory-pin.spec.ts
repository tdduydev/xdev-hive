import { expect, type Page, test } from "@playwright/test";
import { fakeHub, ok, USER } from "./fake-hub.ts";

const at = "2026-10-12T03:00:00.000Z";
const ORG_ID = "0a0a0a0a-0000-4000-8000-000000000001";
const TEAM_ID = "0a0a0a0a-0000-4000-8000-000000000002";
const scope = { level: "team", teamId: TEAM_ID, projectId: null };
const item = (n: number, content: string, pinned = false) => ({
  id: `0a0a0a0a-0000-4000-8000-00000000020${n}`,
  kind: "convention",
  status: "approved",
  content,
  files: [],
  scope,
  author: { userId: USER.id, runId: null },
  createdAt: at,
  supersededBy: null,
  pinned,
});

async function open(page: Page, options: { role: string; teamRole: string }) {
  let memories = [item(1, "Dùng tiền nhỏ nhất.", true), item(2, "Không gọi API thật trong test.")];
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [{ id: ORG_ID, slug: "acme", name: "Acme", role: options.role, emailDomain: null, createdAt: at }],
          canCreateOrg: false,
        }),
      "orgMembers/list": () =>
        ok([
          {
            userId: USER.id,
            name: USER.name,
            email: USER.email,
            image: null,
            role: "member",
            status: "active",
            joinedAt: at,
            teams: [{ teamId: TEAM_ID, name: "Platform", role: options.teamRole }],
          },
        ]),
      "teams/list": () =>
        ok([
          {
            id: TEAM_ID,
            name: "Platform",
            slug: "platform",
            color: null,
            createdAt: at,
            systemCount: 0,
            memberCount: 1,
          },
        ]),
      "projects/list": () => ok([]),
      "notifications/unreadCount": () => ok({ count: 0 }),
      "memory/list": (input) => ok((input as { status?: string }).status === "pending" ? [] : memories),
      "memory/pin": (input) => {
        const { id, pinned } = input as { id: string; pinned: boolean };
        memories = memories.map((m) => (m.id === id ? { ...m, pinned } : m));
        return ok(memories.find((m) => m.id === id));
      },
    },
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/knowledge/memory");
  return hub;
}

test("memory: ghim và bỏ ghim bằng bàn phím, mục đã ghim có nhãn", async ({ page }) => {
  const hub = await open(page, { role: "member", teamRole: "member" });
  const table = page.getByRole("table");
  await expect(table).toContainText("Không gọi API thật trong test.");
  await expect(table.getByRole("img", { name: "Đã ghim" })).toHaveCount(1);

  const pin = table.getByRole("button", { name: /^Ghim: Không gọi API/ });
  await pin.focus();
  await page.keyboard.press("Enter");
  await expect(table.getByRole("img", { name: "Đã ghim" })).toHaveCount(2);
  expect(hub.rpcCalls.filter((c) => c.path === "memory/pin").at(-1)?.input).toEqual({
    id: "0a0a0a0a-0000-4000-8000-000000000202",
    pinned: true,
  });
  // Bấm nút không được mở trang chi tiết của dòng.
  await expect(page).toHaveURL(/\/knowledge\/memory$/);

  const unpin = table.getByRole("button", { name: /^Bỏ ghim: Dùng tiền/ });
  await unpin.focus();
  await page.keyboard.press("Space");
  await expect(table.getByRole("img", { name: "Đã ghim" })).toHaveCount(1);
  expect(hub.rpcCalls.filter((c) => c.path === "memory/pin").at(-1)?.input).toEqual({
    id: "0a0a0a0a-0000-4000-8000-000000000201",
    pinned: false,
  });
});

test("memory: người không có quyền ghi không thấy nút ghim", async ({ page }) => {
  await open(page, { role: "member", teamRole: "viewer" });
  const table = page.getByRole("table");
  await expect(table).toContainText("Dùng tiền nhỏ nhất.");
  await expect(table.getByRole("img", { name: "Đã ghim" })).toHaveCount(1);
  await expect(table.getByRole("button", { name: /Ghim/ })).toHaveCount(0);
});
