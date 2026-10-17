import { expect, type Page, test } from "@playwright/test";
import type { ProjectMember } from "@xdev-hive/contracts";
import { fail, ok, type RpcHandler, USER } from "./fake-hub.ts";
import { inOrg, TEAM_ID } from "./reviews-fixture.ts";

const NOW = "2026-10-17T03:00:00.000Z";
const PROJECT = {
  id: "9a9a9a9a-0000-4000-8000-000000000001",
  systemId: "5e5e5e5e-0000-4000-8000-000000000001",
  teamId: TEAM_ID,
  key: "PAY",
  name: "payment-api",
  state: "active",
  repo: null,
  settings: {
    merge: { mode: "review", requiredApprovals: 1 },
    outcome: { default: [], byType: {} },
    features: { planMode: false, crossReview: false, mergeQueue: false, leaderChat: false, sandbox: false },
    issueIntake: { enabled: false, label: "hive", mention: "hive" },
    brief: { auto: true, refreshCommits: 50, refreshDays: 7 },
    budget: { perRunUsd: 2 },
  },
  createdBy: "u1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const person = (userId: string, name: string) => ({ userId, name, email: `${userId}@acme.vn`, image: null });
const LAN = person("u-lan", "Trần Lan");
const HA = person("u-ha", "Phạm Hà");
const BINH = person("u-binh", "Lê Bình");
const teamMembers = [LAN, HA, BINH].map((p) => ({ ...p, teamId: TEAM_ID, role: "member" }));

/** Người đăng nhập (u1) là `role` của đội sở hữu dự án; vai trò tổ chức là member để quyền chỉ đến từ đội. */
const orgMembers = (role: "admin" | "member") => [
  {
    ...USER,
    role: "member",
    status: "active",
    joinedAt: NOW,
    teams: [{ teamId: TEAM_ID, name: "Thanh toán", role }],
  },
];

const added = (p: ReturnType<typeof person>): ProjectMember => ({ ...p, addedBy: "u1", addedAt: NOW });

/** Hub giữ danh sách thành viên giữa các lời gọi, như hub thật, để danh sách sau khi thêm hay gỡ là bản hub trả. */
function scenario(role: "admin" | "member", initial: ProjectMember[] = []) {
  let members = initial;
  const rpc: Record<string, RpcHandler> = {
    "orgMembers/list": () => ok(orgMembers(role)),
    "projects/list": () => ok([PROJECT]),
    "teamMembers/list": () => ok(teamMembers),
    "projectMembers/list": () => ok(members),
    "projectMembers/add": (input) => {
      const wanted = (input as { userIds: string[] }).userIds;
      members = [...members, ...teamMembers.filter((m) => wanted.includes(m.userId)).map(added)];
      return ok(members);
    },
    "projectMembers/remove": (input) => {
      members = members.filter((m) => m.userId !== (input as { userId: string }).userId);
      return ok({ ok: true });
    },
  };
  return rpc;
}

const section = (page: Page) => page.getByRole("group", { name: "Thành viên dự án" });

test("admin đội thêm và gỡ thành viên dự án", async ({ page }) => {
  const hub = await inOrg(page, "member", scenario("admin"));
  await page.goto("/projects/PAY/settings");

  const members = section(page);
  await expect(members.getByText("Dự án chưa có thành viên.")).toBeVisible();
  await members.getByRole("checkbox", { name: /Phạm Hà/ }).click();
  await members.getByRole("checkbox", { name: /Lê Bình/ }).click();
  await members.getByRole("button", { name: "Thêm" }).click();

  await expect(members.getByRole("listitem")).toHaveCount(2);
  const add = hub.rpcCalls.filter((c) => c.path === "projectMembers/add");
  expect(add).toHaveLength(1);
  // Thứ tự theo lúc bấm chọn.
  expect(add[0]?.input).toEqual({ id: PROJECT.id, userIds: ["u-ha", "u-binh"] });

  await members.getByRole("button", { name: "Gỡ Phạm Hà" }).click();
  await expect(members.getByRole("listitem")).toHaveCount(1);
  await expect(members.getByRole("listitem")).toContainText("Lê Bình");
  expect(hub.rpcCalls.filter((c) => c.path === "projectMembers/remove").map((c) => c.input)).toEqual([
    { id: PROJECT.id, userId: "u-ha" },
  ]);
});

test("thành viên thường chỉ xem danh sách", async ({ page }) => {
  await inOrg(page, "member", scenario("member", [added(LAN)]));
  await page.goto("/projects/PAY/settings");

  const members = section(page);
  await expect(members.getByRole("listitem")).toHaveCount(1);
  await expect(members.getByRole("listitem")).toContainText("Trần Lan");
  await expect(members.getByRole("button", { name: "Thêm" })).toHaveCount(0);
  await expect(members.getByRole("button", { name: /^Gỡ / })).toHaveCount(0);
});

test("hiện lỗi khi hub từ chối người ngoài đội", async ({ page }) => {
  const message = "Lê Bình chưa thuộc đội. Thêm người này vào đội trước.";
  await inOrg(page, "member", {
    ...scenario("admin"),
    "projectMembers/add": () => fail("PROJECT_MEMBER_NOT_IN_TEAM", 400, message),
  });
  await page.goto("/projects/PAY/settings");

  const members = section(page);
  await members.getByRole("checkbox", { name: /Lê Bình/ }).click();
  await members.getByRole("button", { name: "Thêm" }).click();
  await expect(members.getByRole("alert")).toHaveText(message);
});
