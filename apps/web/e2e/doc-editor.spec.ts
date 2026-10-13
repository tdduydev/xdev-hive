import { expect, type Page, test } from "@playwright/test";
import type { DocThread } from "@xdev-hive/contracts";
import { fakeHub, ok, type RpcHandler, USER } from "./fake-hub.ts";

const at = "2026-10-12T03:00:00.000Z";
const orgId = "0a0a0a0a-0000-4000-8000-000000000001";
const teamId = "0a0a0a0a-0000-4000-8000-000000000002";
const projectId = "0a0a0a0a-0000-4000-8000-000000000003";
const key = "project/hive/prd-refund";
const me = { userId: USER.id, runId: null, name: USER.name };
const ai = { userId: null, runId: "0a0a0a0a-0000-4000-8000-0000000000a1", name: "Trợ lý AI" };
const CONTENT = "## Yêu cầu\n\n- R-1: Hoàn tiền một phần.\n\nTổng hoàn phải nhỏ hơn số tiền gốc.\n";

function draft(over: Record<string, unknown> = {}) {
  return {
    key,
    title: "Hoàn tiền một phần",
    content: CONTENT,
    scope: { level: "project", teamId, projectId },
    baseVersion: 1,
    latestVersion: 1,
    revision: 3,
    updatedAt: at,
    updatedBy: me,
    canEdit: true,
    ...over,
  };
}

function state(over: Record<string, unknown> = {}, draftOver: Record<string, unknown> = {}) {
  return {
    draft: draft(draftOver),
    presence: [
      { userId: USER.id, name: USER.name, editing: true, seenAt: at },
      { userId: "u2", name: "Phạm Hà", editing: false, seenAt: at },
    ],
    workflow: {
      id: "0a0a0a0a-0000-4000-8000-0000000000b1",
      name: "PRD chuẩn",
      steps: [
        { gateId: "ai", name: "AI tự kiểm", kind: "ai", phase: "Inception", state: "todo" },
        { gateId: "po", name: "Product owner", kind: "human", phase: "Inception", state: "todo" },
      ],
    },
    review: null,
    stage: "drafting",
    draftNumber: 3,
    openComments: 1,
    pendingSuggestions: 1,
    ...over,
  };
}

const suggestion = {
  id: "0a0a0a0a-0000-4000-8000-0000000000c1",
  key,
  before: "phải nhỏ hơn số tiền gốc",
  after: "không được vượt số tiền gốc trừ phí đã thu",
  reason: "Khớp quy ước phí",
  author: ai,
  status: "pending",
  stale: false,
  createdAt: at,
  decidedBy: null,
  decidedAt: null,
};

const thread: DocThread = {
  id: "0a0a0a0a-0000-4000-8000-0000000000d1",
  key,
  quote: "Hoàn tiền một phần.",
  anchored: true,
  comments: [
    {
      id: "0a0a0a0a-0000-4000-8000-0000000000d2",
      author: { ...me, name: "Phạm Hà" },
      body: "Pháp chế duyệt chưa?",
      createdAt: at,
    },
  ],
  resolvedAt: null,
  resolvedBy: null,
};

async function setup(page: Page, overrides: Record<string, RpcHandler> = {}) {
  let current = state();
  let suggestions = [suggestion];
  let threads: DocThread[] = [thread];
  return fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [{ id: orgId, slug: "acme", name: "Acme", role: "member", emailDomain: null, createdAt: at }],
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
            teams: [{ teamId, name: "Platform", role: "member" }],
          },
        ]),
      "teams/list": () => ok([]),
      "projects/list": () => ok([{ id: projectId, teamId, name: "Hive", key: "hive", createdAt: at }]),
      "notifications/unreadCount": () => ok({ count: 0 }),
      "docs/list": () =>
        ok([
          {
            id: "0a0a0a0a-0000-4000-8000-000000000004",
            key,
            title: "Hoàn tiền một phần",
            scope: { level: "project", teamId, projectId },
            version: 1,
            updatedAt: at,
            updatedBy: { userId: USER.id, runId: null },
          },
        ]),
      "docs/get": () =>
        ok({
          id: "0a0a0a0a-0000-4000-8000-000000000004",
          key,
          title: "Hoàn tiền một phần",
          scope: { level: "project", teamId, projectId },
          version: 1,
          updatedAt: at,
          updatedBy: { userId: USER.id, runId: null },
          content: CONTENT,
        }),
      "docEditor/state": () => ok(current),
      "docEditor/save": (input) => {
        const i = input as { content: string; title?: string; revision: number };
        current = state({}, { content: i.content, title: i.title ?? current.draft.title, revision: i.revision + 1 });
        return ok(current.draft);
      },
      "docEditor/suggestions/list": () => ok(suggestions.filter((x) => x.status === "pending")),
      "docEditor/suggestions/decide": (input) => {
        const i = input as { id: string; accept: boolean };
        const content = i.accept
          ? current.draft.content.replace(suggestion.before, suggestion.after)
          : current.draft.content;
        current = state({ pendingSuggestions: 0 }, { content, revision: current.draft.revision + 1 });
        suggestions = [];
        return ok({ suggestion: { ...suggestion, status: i.accept ? "accepted" : "rejected" }, draft: current.draft });
      },
      "docEditor/comments/list": () => ok(threads),
      "docEditor/comments/add": (input) => {
        const i = input as { body: string; quote?: string; threadId?: string };
        const t = {
          ...thread,
          id: "0a0a0a0a-0000-4000-8000-0000000000d9",
          quote: i.quote ?? null,
          comments: [{ id: "0a0a0a0a-0000-4000-8000-0000000000da", author: me, body: i.body, createdAt: at }],
        };
        threads = [...threads, t];
        return ok(t);
      },
      "docEditor/comments/resolve": (input) => {
        threads = threads.map((x) =>
          x.id === (input as { id: string }).id ? { ...x, resolvedAt: at, resolvedBy: me } : x,
        );
        return ok(threads[0]);
      },
      "docEditor/snapshots/list": () => ok([]),
      "docEditor/submitPreview": () =>
        ok({
          workflow: { id: "0a0a0a0a-0000-4000-8000-0000000000b1", name: "PRD chuẩn" },
          gates: [
            { gateId: "ai", name: "AI tự kiểm", kind: "ai", runs: true, reason: "Đủ điều kiện.", who: "Agent AI kiểm" },
            {
              gateId: "po",
              name: "Product owner",
              kind: "human",
              runs: true,
              reason: "Đủ điều kiện.",
              who: "Quản trị đội",
            },
          ],
          addedLines: 2,
          deletedLines: 1,
        }),
      "docEditor/submit": () => {
        current = state({ stage: "in_review", draftNumber: 4 });
        return ok({
          snapshot: {
            id: "0a0a0a0a-0000-4000-8000-0000000000e1",
            key,
            number: 1,
            name: "Gửi duyệt v3",
            title: "Hoàn tiền một phần",
            baseVersion: 1,
            author: me,
            createdAt: at,
            chars: 100,
            submission: {
              proposalId: "0a0a0a0a-0000-4000-8000-0000000000e2",
              reviewId: null,
              status: "in_review",
              note: null,
            },
          },
          proposalId: "0a0a0a0a-0000-4000-8000-0000000000e2",
          reviewId: null,
        });
      },
      "docEditor/assist/targets": () =>
        ok([
          {
            machineId: "0a0a0a0a-0000-4000-8000-0000000000f1",
            name: "macbook-duy",
            clis: ["claude", "codex"],
            online: true,
            ready: true,
          },
        ]),
      "docEditor/assist/list": () => ok([]),
      "docEditor/assist/start": (input) =>
        ok({
          runId: "0a0a0a0a-0000-4000-8000-0000000000f2",
          action: (input as { action: string }).action,
          cli: "claude",
          machine: "macbook-duy",
          state: "queued",
          prompt: null,
          summary: null,
          suggestions: 0,
          comments: 0,
          createdAt: at,
        }),
      ...overrides,
    },
  });
}

const editorUrl = `/knowledge/docs/${encodeURIComponent(key)}/edit`;

test("doc editor: open from Docs, see workflow, edit a block directly and insert a numbered requirement", async ({
  page,
}) => {
  const hub = await setup(page);
  await page.goto("/knowledge/docs");
  await page.getByRole("button", { name: "Mở dòng Hoàn tiền một phần" }).click();
  await page.getByRole("link", { name: "Soạn", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/knowledge/docs/${encodeURIComponent(key)}/edit$`));
  await expect(page.getByRole("navigation", { name: "Quy trình duyệt" })).toContainText("Quy trình: PRD chuẩn");
  await expect(page.getByRole("navigation", { name: "Quy trình duyệt" })).toContainText("Product owner");
  await expect(page.getByText("Đang soạn · v3")).toBeVisible();
  await expect(page.getByRole("list", { name: "Đang mở tài liệu" })).toContainText("Phạm Hà");

  await page.getByRole("button", { name: "+ Thêm khối mới" }).click();
  await page.keyboard.type("/");
  const menu = page.getByRole("listbox", { name: "Chèn khối" });
  await expect(menu).toBeVisible();
  await menu.getByRole("option", { name: /Yêu cầu có mã/ }).click();
  const doc = page.getByRole("textbox", { name: "Nội dung tài liệu" });
  // Mã kế tiếp sau R-1 có sẵn; mã là một khối nguyên, gõ chữ phía sau không đổi mã.
  await expect(doc.locator("[data-requirement]")).toHaveText(["R-1", "R-2"]);
  await page.keyboard.type("Chặn tổng hoàn vượt số tiền gốc.");
  await expect
    .poll(() => (hub.rpcCalls.findLast((c) => c.path === "docEditor/save")?.input as { content?: string })?.content, {
      timeout: 5000,
    })
    .toContain("- R-2: Chặn tổng hoàn vượt số tiền gốc.");
  const save = hub.rpcCalls.find((c) => c.path === "docEditor/save");
  expect(save?.input).toMatchObject({ key, revision: 3 });
  // Khối không ai sửa giữ nguyên chữ gốc.
  expect((save?.input as { content?: string } | undefined)?.content?.startsWith(CONTENT)).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "Đã lưu" })).toBeVisible({ timeout: 5000 });
});

test("doc editor: AI suggestion shows inline diff and accepting it updates the draft", async ({ page }) => {
  const hub = await setup(page);
  await page.goto(editorUrl);
  const card = page.getByRole("group", { name: "Trợ lý AI đề xuất sửa" });
  await expect(card.locator("del")).toHaveText("phải nhỏ hơn");
  await expect(card.locator("ins").first()).toHaveText("không được vượt");
  await card.getByRole("button", { name: "Nhận" }).click();
  await expect(page.locator("main article").first()).toContainText("không được vượt số tiền gốc trừ phí đã thu");
  await expect(card).toHaveCount(0);
  expect(hub.rpcCalls.find((c) => c.path === "docEditor/suggestions/decide")?.input).toEqual({
    id: suggestion.id,
    accept: true,
  });
});

test("doc editor: suggesting mode turns an edit into a suggestion instead of saving", async ({ page }) => {
  const hub = await setup(page);
  await page.goto(editorUrl);
  await page.getByRole("button", { name: "Chế độ: Sửa thẳng" }).click();
  await expect(page.getByRole("button", { name: "Chế độ: Đề xuất" })).toHaveAttribute("aria-pressed", "true");
  const doc = page.getByRole("textbox", { name: "Nội dung tài liệu" });
  await doc.getByText("Tổng hoàn phải nhỏ hơn số tiền gốc.").click({ clickCount: 3 });
  await page.keyboard.type("Tổng hoàn không vượt số tiền gốc.");
  await expect(page.getByText("1 chỗ sửa chưa gửi")).toBeVisible();
  await expect(page.getByRole("button", { name: "Chế độ: Đề xuất" })).toBeDisabled();
  await page.getByRole("button", { name: "Gửi đề xuất" }).click();
  await expect.poll(() => hub.rpcCalls.filter((c) => c.path === "docEditor/suggestions/create").length).toBe(1);
  expect(hub.rpcCalls.find((c) => c.path === "docEditor/suggestions/create")?.input).toMatchObject({
    key,
    before: "Tổng hoàn phải nhỏ hơn số tiền gốc.",
    after: "Tổng hoàn không vượt số tiền gốc.",
  });
  expect(hub.rpcCalls.filter((c) => c.path === "docEditor/save")).toHaveLength(0);
});

test("doc editor: comment threads, reply composer and resolve", async ({ page }) => {
  const hub = await setup(page);
  await page.goto(editorUrl);
  await expect(page.getByRole("tab", { name: "Bình luận · 1" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Pháp chế duyệt chưa?")).toBeVisible();
  await page.getByRole("button", { name: "+ Bình luận mới" }).click();
  await page.getByRole("textbox", { name: "Viết bình luận…" }).fill("Cần thêm số liệu đối soát.");
  await page.getByRole("button", { name: "Gửi", exact: true }).click();
  await expect(page.getByText("Cần thêm số liệu đối soát.")).toBeVisible();
  await page.getByRole("button", { name: "Đóng", exact: true }).first().click();
  await expect.poll(() => hub.rpcCalls.filter((c) => c.path === "docEditor/comments/resolve").length).toBe(1);
});

test("doc editor: submit shows the checkpoints and sends the note", async ({ page }) => {
  const hub = await setup(page);
  await page.goto(editorUrl);
  await page.getByRole("button", { name: "Gửi duyệt" }).click();
  const dialog = page.getByRole("dialog", { name: "Gửi bản nháp vào quy trình duyệt?" });
  await expect(dialog).toContainText("AI tự kiểm");
  await expect(dialog).toContainText("Quản trị đội");
  await expect(dialog).toContainText("+2 −1 dòng");
  await dialog.getByLabel("Ghi chú cho người duyệt").fill("Đã thêm phí.");
  await dialog.getByRole("button", { name: "Gửi duyệt" }).click();
  await expect(page.getByText("Đã gửi duyệt.")).toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "docEditor/submit")?.input).toEqual({
    key,
    revision: 3,
    note: "Đã thêm phí.",
  });
});

test("doc editor: AI actions run on my own machine with the chosen CLI", async ({ page }) => {
  const hub = await setup(page);
  await page.goto(editorUrl);
  await page.getByRole("button", { name: "✦ Hỏi AI" }).click();
  await expect(page.getByLabel("Máy chạy")).toHaveValue("0a0a0a0a-0000-4000-8000-0000000000f1");
  await page.getByLabel("Nhà cung cấp").selectOption("codex");
  await page.getByRole("button", { name: /Sinh tiêu chí chấp nhận/ }).click();
  await expect.poll(() => hub.rpcCalls.filter((c) => c.path === "docEditor/assist/start").length).toBe(1);
  expect(hub.rpcCalls.find((c) => c.path === "docEditor/assist/start")?.input).toEqual({
    key,
    action: "acceptance",
    cli: "codex",
    machineId: "0a0a0a0a-0000-4000-8000-0000000000f1",
  });
});

test("doc editor: viewers read and comment only", async ({ page }) => {
  await setup(page, { "docEditor/state": () => ok(state({}, { canEdit: false })) });
  await page.goto(editorUrl);
  await expect(page.getByRole("status").filter({ hasText: "Chỉ đọc và bình luận" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Gửi duyệt" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ Thêm khối mới" })).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Trợ lý AI đề xuất sửa" }).getByRole("button", { name: "Nhận" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ Bình luận mới" })).toBeVisible();
});
