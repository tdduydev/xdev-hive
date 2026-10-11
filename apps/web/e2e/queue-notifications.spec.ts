import { expect, type Page, test } from "@playwright/test";
import {
  defaultProjectSettings,
  type MergeQueueEntry,
  type MergeQueueState,
  type NotificationChannel,
  type Project,
} from "@xdev-hive/contracts";
import { fail, fakeHub, ok, type RpcHandler, USER } from "./fake-hub.ts";

const at = "2026-10-11T08:00:00.000Z";
const orgId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const teamId = "00000000-0000-4000-8000-000000000003";
const project: Project = {
  id: projectId,
  systemId: "00000000-0000-4000-8000-000000000004",
  teamId,
  key: "hive",
  name: "xDev Hive",
  state: "active",
  repo: {
    mode: "existing",
    connectionId: "00000000-0000-4000-8000-000000000005",
    kind: "github",
    owner: "example",
    name: "hive",
    defaultBranch: "main",
    visibility: "private",
    httpUrl: null,
    sshUrl: null,
    webUrl: "https://github.com/example/hive",
  },
  settings: { ...defaultProjectSettings(), features: { ...defaultProjectSettings().features, mergeQueue: true } },
  createdBy: USER.id,
  createdAt: at,
  updatedAt: at,
};

const channel: NotificationChannel = {
  id: "00000000-0000-4000-8000-000000000006",
  kind: "telegram",
  name: "Nhóm vận hành",
  events: ["merge.failed", "run.failed"],
  enabled: true,
  target: "Telegram · -1000123456",
  createdAt: at,
  updatedAt: at,
};

function entry(state: MergeQueueState, number: number, position: number | null): MergeQueueEntry {
  return {
    id: `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    projectId,
    prNumber: number,
    prUrl: `https://github.com/example/hive/pull/${number}`,
    branch: `ai/task-${number}`,
    headSha: "abc123",
    ciState: state === "failed" ? "failure" : state === "waiting" ? "pending" : state === "merged" ? "success" : null,
    runId: null,
    taskId: null,
    state,
    note: state === "failed" ? "CI không đạt." : state === "waiting" ? "Chờ CI." : null,
    position,
    mergeSha: state === "merged" ? "c1d2e3f4a5b6789012345678901234567890abcdef" : null,
    enqueuedBy: USER.id,
    createdAt: at,
    updatedAt: at,
    finishedAt: position === null ? at : null,
  };
}

const queueEntries = () => [
  entry("queued", 128, 2),
  entry("waiting", 127, 1),
  entry("updating", 129, 3),
  entry("merging", 130, 4),
  entry("merged", 126, null),
  entry("failed", 125, null),
  entry("removed", 124, null),
];

async function setup(page: Page, rpc: Record<string, RpcHandler> = {}, role = "owner", teamRole = "viewer") {
  return fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [{ id: orgId, slug: "example", name: "Đội phát triển", role, emailDomain: null, createdAt: at }],
          canCreateOrg: false,
        }),
      "projects/list": () => ok([project]),
      "projects/mergeQueue": () => ok(queueEntries()),
      "teamMembers/list": () =>
        ok([{ userId: USER.id, name: USER.name, email: USER.email, image: null, teamId, role: teamRole }]),
      "notificationChannels/list": () => ok([channel]),
      ...rpc,
    },
  });
}

test("queue preserves order, shows history and confirms removal/retry with tenant header", async ({ page }) => {
  let entries = queueEntries();
  const hub = await setup(page, {
    "projects/mergeQueue": () => ok(entries),
    "projects/removeMerge": (raw) => {
      const input = raw as { id: string; entryId: string };
      const removed = entries.find((item) => item.id === input.entryId);
      if (!removed) return fail("NOT_FOUND", 404, "Không tìm thấy PR.");
      entries = entries.map((item) =>
        item.id === input.entryId ? { ...item, state: "removed", position: null, finishedAt: at } : item,
      );
      return ok(entries.find((item) => item.id === input.entryId));
    },
    "projects/enqueueMerge": (raw) => {
      const input = raw as { prNumber: number };
      const queued = entry("queued", input.prNumber, 5);
      entries = [...entries, { ...queued, id: "20000000-0000-4000-8000-000000000125" }];
      return ok(queued);
    },
  });
  await page.goto("/projects/hive/merge-queue");
  const active = page.getByRole("region", { name: "Đang trong hàng" });
  await expect(active.getByRole("listitem").first()).toContainText("PR #127");
  await expect(active.getByRole("listitem").nth(1)).toContainText("PR #128");
  await expect(page.getByText("Chờ CI.", { exact: true })).toBeVisible();
  await expect(page.getByText("CI không đạt.", { exact: true })).toBeVisible();
  await expect(page.getByText("c1d2e3f4a5b6789012345678901234567890abcdef")).toBeVisible();
  await expect(page.getByRole("button", { name: "Đưa PR #130 ra khỏi hàng" })).toHaveCount(0);
  const remove = page.getByRole("button", { name: "Đưa PR #128 ra khỏi hàng" });
  await remove.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("Đưa PR #128 ra khỏi hàng?");
  expect(hub.rpcCalls.filter((call) => call.path === "projects/removeMerge")).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(remove).toBeFocused();
  await remove.click();
  await page.getByRole("dialog").getByRole("button", { name: "Đưa ra khỏi hàng", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Đã đưa PR #128 ra khỏi hàng.");
  await page.getByRole("button", { name: "Đưa lại PR #125 vào hàng" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Đưa vào hàng", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Đã đưa PR #125 vào hàng.");
  expect(hub.rpcCalls.find((call) => call.path === "projects/removeMerge")?.input).toEqual({
    id: projectId,
    entryId: entry("queued", 128, 2).id,
  });
  expect(hub.rpcCalls.find((call) => call.path === "projects/enqueueMerge")?.input).toEqual({
    id: projectId,
    prNumber: 125,
  });
  expect(hub.rpcCalls.filter((call) => call.path.startsWith("projects/")).every((call) => call.org === orgId)).toBe(
    true,
  );
});

test("queue disabled, empty and missing project states", async ({ page }) => {
  let enabled = false;
  const hub = await setup(page, {
    "projects/list": () =>
      ok([
        {
          ...project,
          settings: { ...project.settings, features: { ...project.settings.features, mergeQueue: enabled } },
        },
      ]),
    "projects/mergeQueue": () => ok([]),
  });
  await page.goto("/projects/hive/merge-queue");
  await expect(page.getByRole("heading", { name: "Dự án chưa bật hàng merge" })).toBeVisible();
  expect(hub.rpcCalls.some((call) => call.path === "projects/mergeQueue")).toBe(false);
  enabled = true;
  await page.reload();
  await expect(page.getByText(/Chưa có PR nào trong hàng/)).toBeVisible();
  await page.goto("/projects/missing/merge-queue");
  await expect(page.getByRole("heading", { name: "Không tìm thấy dự án" })).toBeVisible();
});

test("queue loading, recoverable API errors and mutation conflicts", async ({ page }) => {
  let broken = true;
  const hub = await setup(page, {
    "projects/mergeQueue": () =>
      broken ? fail("FORBIDDEN", 403, "Bạn không có quyền xem hàng merge.") : ok(queueEntries()),
    "projects/removeMerge": () => fail("CONFLICT", 409, "PR đang được merge, không bỏ khỏi hàng được."),
  });
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/projects/mergeQueue?**", async (route) => {
    await hold;
    await route.fallback();
  });
  await page.goto("/projects/hive/merge-queue");
  await expect(page.getByRole("status")).toContainText("Đang tải hàng merge…");
  release();
  await expect(page.getByRole("alert")).toContainText("Bạn không có quyền xem hàng merge.");
  broken = false;
  await page.getByRole("button", { name: "Tải lại" }).click();
  await page.getByRole("button", { name: "Đưa PR #128 ra khỏi hàng" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Đưa ra khỏi hàng", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("PR đang được merge");
  expect(hub.rpcCalls.filter((call) => call.path === "projects/removeMerge")).toHaveLength(1);
});

test("viewer sees queue without actions and organization member cannot load channel configuration", async ({
  page,
}) => {
  const hub = await setup(page, {}, "member", "viewer");
  await page.goto("/projects/hive/merge-queue");
  await expect(page.getByText("CI không đạt.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Đưa .*PR/ })).toHaveCount(0);
  await page.goto("/notifications");
  await expect(page.getByRole("heading", { name: "Thông báo cá nhân chưa khả dụng" })).toBeVisible();
  await expect(page.getByText(/Chỉ chủ sở hữu và quản trị tổ chức/)).toBeVisible();
  expect(hub.rpcCalls.some((call) => call.path.startsWith("notificationChannels/"))).toBe(false);
});

test("team member can manage merge queue", async ({ page }) => {
  await setup(page, {}, "member", "member");
  await page.goto("/projects/hive/merge-queue");
  await expect(page.getByRole("button", { name: "Đưa PR #128 ra khỏi hàng" })).toBeVisible();
});

test("channel create, metadata edit, toggle, delivery failure and confirmed removal", async ({ page }) => {
  let channels: NotificationChannel[] = [];
  const hub = await setup(page, {
    "notificationChannels/list": () => ok(channels),
    "notificationChannels/create": () => {
      channels = [channel];
      return ok(channel);
    },
    "notificationChannels/update": (raw) => {
      const input = raw as { name?: string; enabled?: boolean };
      channels = channels.map((item) => ({
        ...item,
        ...(input.name ? { name: input.name } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      }));
      return ok(channels[0]);
    },
    "notificationChannels/test": () => ok({ ok: false, message: "Telegram từ chối token bot. Kiểm tra lại cấu hình." }),
    "notificationChannels/remove": () => {
      channels = [];
      return ok({ id: channel.id });
    },
  });
  await page.goto("/notifications");
  await expect(page.getByRole("heading", { name: "Chưa có kênh thông báo" })).toBeVisible();
  await page.getByRole("button", { name: "Thêm kênh" }).click();
  await page.getByLabel("Tên kênh", { exact: true }).fill(channel.name);
  await page.getByLabel("Merge thất bại", { exact: true }).check();
  await page.getByLabel("Token bot Telegram", { exact: true }).fill("123456:abcdefghijklmnopqrstuvwxyz");
  await page.getByLabel("Chat ID", { exact: true }).fill("-1000123456");
  await page.getByRole("button", { name: "Lưu kênh" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(channel.name, { exact: true })).toBeVisible();
  expect(hub.rpcCalls.find((call) => call.path === "notificationChannels/create")?.input).toMatchObject({
    name: channel.name,
    config: { kind: "telegram", botToken: "123456:abcdefghijklmnopqrstuvwxyz", chatId: "-1000123456" },
    events: ["merge.failed"],
    enabled: true,
  });
  await page.getByRole("button", { name: `Sửa kênh ${channel.name}` }).click();
  await expect(page.getByLabel("Token bot Telegram", { exact: true })).toHaveCount(0);
  await page.getByLabel("Tên kênh", { exact: true }).fill("Nhóm trực");
  await page.getByRole("button", { name: "Lưu kênh" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const edit = hub.rpcCalls.find((call) => call.path === "notificationChannels/update");
  expect(edit?.input).not.toHaveProperty("config");
  await page.getByRole("button", { name: "Tắt kênh Nhóm trực" }).click();
  await expect(page.getByText("Đã tắt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Gửi thử qua Nhóm trực" }).click();
  await expect(page.getByRole("alert")).toContainText("Telegram từ chối token bot");
  await page.getByRole("button", { name: "Xoá kênh Nhóm trực" }).click();
  expect(hub.rpcCalls.some((call) => call.path === "notificationChannels/remove")).toBe(false);
  await page.getByRole("dialog").getByRole("button", { name: "Xoá kênh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Chưa có kênh thông báo" })).toBeVisible();
  expect(
    hub.rpcCalls.filter((call) => call.path.startsWith("notificationChannels/")).every((call) => call.org === orgId),
  ).toBe(true);
});

test("email configuration validates recipients before sending SMTP settings", async ({ page }) => {
  const hub = await setup(page, {
    "notificationChannels/create": () =>
      ok({ ...channel, kind: "email", name: "Email vận hành", target: "ops@example.com" }),
  });
  await page.goto("/notifications");
  await page.getByRole("button", { name: "Thêm kênh" }).click();
  await page.getByLabel("Loại kênh", { exact: true }).selectOption("email");
  await page.getByLabel("Tên kênh", { exact: true }).fill("Email vận hành");
  await page.getByLabel("Run thất bại", { exact: true }).check();
  await page.getByLabel("Máy chủ SMTP", { exact: true }).fill("smtp.example.com");
  await page.getByLabel("Email gửi", { exact: true }).fill("hive@example.com");
  await page.getByLabel("Email nhận", { exact: true }).fill("invalid");
  await page.getByRole("button", { name: "Lưu kênh" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  expect(hub.rpcCalls.some((call) => call.path === "notificationChannels/create")).toBe(false);
  await page.getByLabel("Email nhận", { exact: true }).fill("ops@example.com, oncall@example.com");
  await page.getByRole("button", { name: "Lưu kênh" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(hub.rpcCalls.find((call) => call.path === "notificationChannels/create")?.input).toMatchObject({
    config: { kind: "email", port: 587, tls: "starttls", to: ["ops@example.com", "oncall@example.com"] },
  });
});

test("channel list errors can be retried", async ({ page }) => {
  let broken = true;
  await setup(page, {
    "notificationChannels/list": () =>
      broken ? fail("FORBIDDEN", 403, "Bạn không có quyền cấu hình kênh.") : ok([channel]),
  });
  await page.goto("/notifications");
  await expect(page.getByRole("alert")).toContainText("Bạn không có quyền cấu hình kênh.");
  broken = false;
  await page.getByRole("button", { name: "Tải lại" }).click();
  await expect(page.getByText(channel.name, { exact: true })).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`queue and notification pages fit 360px and support ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const entries = queueEntries();
    entries[0] = {
      ...entry("queued", 128, 2),
      branch: `ai/${"long-branch-".repeat(20)}`,
      note: "Đang chờ cập nhật nhánh từ nhà cung cấp.",
    };
    await setup(page, {
      "projects/mergeQueue": () => ok(entries),
      "notificationChannels/list": () =>
        ok([{ ...channel, name: `Nhóm ${"vận hành ".repeat(10)}`, target: `${"receiver".repeat(25)}@example.com` }]),
    });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/projects/hive/merge-queue");
    await expect(page.getByRole("region", { name: "Đang trong hàng" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await page.getByRole("button", { name: "Đưa PR #128 ra khỏi hàng" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await page.getByRole("button", { name: "Huỷ", exact: true }).click();
    await page.goto("/notifications");
    await expect(page.getByText(/receiver/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await page.getByRole("button", { name: "Thêm kênh" }).click();
    await page.getByLabel("Loại kênh", { exact: true }).selectOption("email");
    await expect(page.getByLabel("Email nhận", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await page.getByRole("button", { name: "Huỷ", exact: true }).click();
  });

  test(`screenshots of queue and notification pages in ${scheme} theme`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await setup(page);
    await page.goto("/projects/hive/merge-queue");
    await expect(page.getByRole("region", { name: "Đang trong hàng" })).toBeVisible();
    await expect(page.locator("body")).toHaveCSS(
      "background-color",
      scheme === "light" ? "rgb(246, 248, 252)" : "rgb(12, 23, 41)",
    );
    await page.screenshot({
      path: testInfo.outputPath(`merge-queue-${scheme}.png`),
      fullPage: true,
    });
    await page.goto("/notifications");
    await expect(page.getByText(channel.name, { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`notifications-${scheme}.png`),
      fullPage: true,
    });
  });
}
