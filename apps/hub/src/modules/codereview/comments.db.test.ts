import { randomUUID } from "node:crypto";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { codeReviewCommentThread, reviewPhase } from "@xdev-hive/contracts";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, seedOrg } from "../../../test/org-fixture.ts";
import { createAuth } from "../identity/index.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";
import {
  addReviewComment,
  deleteReviewComment,
  editReviewComment,
  listReviewComments,
  replyReviewComment,
  resolveReviewComment,
} from "./comments.ts";
import { codeReviewsRouter } from "./router.ts";
import { codeReviewComments, codeReviews } from "./schema.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const authPool = createPool(authUrl);
let org: Awaited<ReturnType<typeof seedOrg>>;
let other: Awaited<ReturnType<typeof seedOrg>>;
let reviewId: string;
const headSha = "a".repeat(40);
const u = (name: string) => org.user(name);
const run = <T>(who: string, fn: (tx: Tx, userId: string) => Promise<T>) =>
  withTenant(app, { orgId: org.orgId, userId: u(who) }, (tx) => fn(tx, u(who)));
const add = (who = "tviewer", over = {}) =>
  run(who, (tx, userId) =>
    addReviewComment(tx, userId, {
      reviewId,
      headSha,
      path: "src/a.ts",
      line: 12,
      side: "new",
      body: "Cần thêm test",
      ...over,
    }),
  );

beforeAll(async () => {
  org = await seedOrg(admin, `comments-${randomUUID().slice(0, 6)}`);
  other = await seedOrg(admin, `comments-other-${randomUUID().slice(0, 6)}`);
  await withTenant(app, { orgId: org.orgId }, async (tx) => {
    const [review] = await tx
      .insert(codeReviews)
      .values({
        orgId: org.orgId,
        teamId: org.teamId,
        projectId: randomUUID(),
        runId: randomUUID(),
        workflowName: "Review",
        phases: [
          reviewPhase.parse({
            name: "Duyệt",
            gates: [
              {
                id: "human",
                name: "Người duyệt",
                kind: "human",
                reviewers: { users: [u("loner")], roles: ["team-member"], teams: [org.teamId] },
              },
            ],
          }),
        ],
        options: { merge: "project", maxAgentRevisions: 2, dismissStaleApprovals: false },
        prNumber: 10,
        prUrl: "https://git.test/pr/10",
        branch: "feature",
        baseBranch: "main",
        headSha,
        requesterUserId: u("tmember"),
      })
      .returning();
    if (!review) throw new Error("Không tạo được review");
    reviewId = review.id;
  });
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end(), authPool.end()]);
});

describe("bình luận review code", () => {
  it("người xem thêm, trả lời, sửa và xoá mềm; giữ luồng và phản hồi", async () => {
    const root = await add();
    expect(codeReviewCommentThread.safeParse(root).success).toBe(true);
    expect(root).toMatchObject({ path: "src/a.ts", line: 12, side: "new", headSha, outdated: false, resolved: false });
    const first = root.comments[0];
    expect(first).toMatchObject({
      id: root.id,
      threadId: root.id,
      authorId: u("tviewer"),
      authorName: u("tviewer"),
      origin: "hive",
      externalAuthor: null,
      syncState: null,
      providerUrl: null,
    });
    const reply = await run("tmember", (tx, user) =>
      replyReviewComment(tx, user, { threadId: root.id, body: " Đã bổ sung " }),
    );
    expect(reply.body).toBe("Đã bổ sung");
    const edited = await run("tviewer", (tx, user) =>
      editReviewComment(tx, user, { commentId: root.id, body: " Xem lại test " }),
    );
    expect(edited.body).toBe("Xem lại test");
    expect(edited.editedAt).not.toBeNull();
    expect(await run("tviewer", (tx, user) => deleteReviewComment(tx, user, root.id))).toEqual({ ok: true });
    await run("tviewer", (tx, user) => deleteReviewComment(tx, user, root.id));
    const listed = await run("tmember", (tx, user) => listReviewComments(tx, user, reviewId));
    const saved = listed.threads.find((t) => t.id === root.id);
    expect(saved?.comments.map((c) => c.id)).toEqual([root.id, reply.id]);
    expect(saved?.comments[0]).toMatchObject({ body: "", deletedAt: expect.any(String) });
    expect(
      await errorCode(() =>
        run("tviewer", (tx, user) => editReviewComment(tx, user, { commentId: root.id, body: "Hồi sinh" })),
      ),
    ).toBe("CODE_REVIEW_COMMENT_NOT_FOUND");
    await run("tmember", (tx, user) =>
      replyReviewComment(tx, user, { threadId: root.id, body: "Luồng vẫn dùng được" }),
    );
  });

  it("xử lý, mở lại và giữ vị trí cũ khi head đổi", async () => {
    const root = await add("tmember", { side: "old" });
    const resolve = (yes: boolean) => run("loner", (tx, user) => resolveReviewComment(tx, user, root.id, yes));
    expect(await resolve(true)).toMatchObject({
      resolved: true,
      resolvedBy: u("loner"),
      resolvedAt: expect.any(String),
    });
    expect(await resolve(false)).toMatchObject({ resolved: false, resolvedBy: null, resolvedAt: null });
    await run("tmember", (tx) =>
      tx
        .update(codeReviews)
        .set({ headSha: "b".repeat(40) })
        .where(eq(codeReviews.id, reviewId)),
    );
    const listed = await run("loner", (tx, user) => listReviewComments(tx, user, reviewId));
    expect(listed.threads.find((t) => t.id === root.id)).toMatchObject({
      outdated: true,
      headSha,
      side: "old",
      line: 12,
    });
  });

  it("chỉ tác giả bình luận Hive được sửa, xoá; quản trị cũng không thay tác giả", async () => {
    const root = await add();
    for (const who of ["tmember", "admin"]) {
      expect(
        await errorCode(() => run(who, (tx, user) => editReviewComment(tx, user, { commentId: root.id, body: "Sửa" }))),
      ).toBe("CODE_REVIEW_COMMENT_AUTHOR_ONLY");
      expect(await errorCode(() => run(who, (tx, user) => deleteReviewComment(tx, user, root.id)))).toBe(
        "CODE_REVIEW_COMMENT_AUTHOR_ONLY",
      );
    }
    for (const origin of ["github", "gitlab"] as const) {
      await run("tviewer", (tx) =>
        tx
          .update(codeReviewComments)
          .set({ origin, externalAuthor: "dev-git" })
          .where(eq(codeReviewComments.id, root.id)),
      );
      expect(
        await errorCode(() =>
          run("tviewer", (tx, user) => editReviewComment(tx, user, { commentId: root.id, body: "Sửa" })),
        ),
      ).toBe("CODE_REVIEW_COMMENT_AUTHOR_ONLY");
      expect(await errorCode(() => run("tviewer", (tx, user) => deleteReviewComment(tx, user, root.id)))).toBe(
        "CODE_REVIEW_COMMENT_AUTHOR_ONLY",
      );
    }
  });

  it("mọi thao tác chặn người không xem được review và tổ chức khác", async () => {
    const root = await add();
    const actions: ((tx: Tx, user: string) => Promise<unknown>)[] = [
      (tx: Tx, user: string) => listReviewComments(tx, user, reviewId),
      (tx: Tx, user: string) =>
        addReviewComment(tx, user, { reviewId, headSha, path: "a", line: 1, side: "new", body: "a" }),
      (tx: Tx, user: string) => replyReviewComment(tx, user, { threadId: root.id, body: "a" }),
      (tx: Tx, user: string) => editReviewComment(tx, user, { commentId: root.id, body: "a" }),
      (tx: Tx, user: string) => deleteReviewComment(tx, user, root.id),
      (tx: Tx, user: string) => resolveReviewComment(tx, user, root.id, true),
      (tx: Tx, user: string) => resolveReviewComment(tx, user, root.id, false),
    ];
    for (const action of actions) {
      expect(await errorCode(() => run("oadmin", action))).toBe("CODE_REVIEW_NOT_FOUND");
      expect(
        await errorCode(() =>
          withTenant(app, { orgId: other.orgId, userId: other.user("admin") }, (tx) => action(tx, other.user("admin"))),
        ),
      ).toMatch(/NOT_FOUND$/);
    }
    const reply = await run("tmember", (tx, user) => replyReviewComment(tx, user, { threadId: root.id, body: "a" }));
    expect(
      await errorCode(() =>
        run("tmember", (tx, user) => replyReviewComment(tx, user, { threadId: reply.id, body: "a" })),
      ),
    ).toBe("CODE_REVIEW_COMMENT_NOT_FOUND");
    expect(await errorCode(() => run("tmember", (tx, user) => resolveReviewComment(tx, user, reply.id, true)))).toBe(
      "CODE_REVIEW_COMMENT_NOT_FOUND",
    );
  });

  it("audit đủ thao tác và thông báo người giao việc, reviewer; loại người viết và chống trùng", async () => {
    const root = await add("tmember");
    const reply = await run("tviewer", (tx, user) =>
      replyReviewComment(tx, user, { threadId: root.id, body: "Phản hồi" }),
    );
    await run("tmember", (tx, user) => editReviewComment(tx, user, { commentId: root.id, body: "Cập nhật" }));
    await run("tviewer", (tx, user) => resolveReviewComment(tx, user, root.id, true));
    await run("tviewer", (tx, user) => resolveReviewComment(tx, user, root.id, false));
    await run("tmember", (tx, user) => deleteReviewComment(tx, user, root.id));
    const result = await run("tmember", async (tx) => {
      const audits = await tx.execute<{ action: string }>(
        sql`select action from hive.audit_log where data->>'threadId' = ${root.id} order by created_at`,
      );
      const inbox = await admin.query<{ user_id: string; title: string }>(
        "select user_id, title from hive.inbox_items where event_key = $1",
        [`code_review.comment:${root.id}`],
      );
      return { audits: audits.rows, inbox: inbox.rows };
    });
    expect(result.audits.map((a) => a.action).sort()).toEqual(
      ["add", "reply", "edit", "delete", "resolve", "reopen"].map((a) => `code_review.comment.${a}`).sort(),
    );
    expect(new Set(result.inbox.map((r) => r.user_id))).toEqual(new Set(["owner", "admin", "tadmin", "loner"].map(u)));
    expect(result.inbox).toHaveLength(4);
    expect(result.inbox.every((r) => r.title === "Có bình luận mới")).toBe(true);
    const requesterInbox = await run("tmember", (tx) =>
      tx.execute(sql`select id from hive.inbox_items where event_key = ${`code_review.comment:${reply.id}`}`),
    );
    expect(requesterInbox.rows).toHaveLength(1);
  });
});

it("HTTP thật qua router hub, phiên đăng nhập và transaction tenant với Postgres", async () => {
  const auth = createAuth({
    pool: authPool,
    baseURL: "http://localhost:3000",
    secret: "test-comments-0123456789abcdef-0123456789",
    allowEmailSignUp: true,
  });
  const signup = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Người review",
        email: `comments-${randomUUID()}@example.test`,
        password: "test-password-comments-123",
      }),
    }),
  );
  expect(signup.status).toBe(200);
  const userId = ((await signup.json()) as { user: { id: string } }).user.id;
  const cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
    org.orgId,
    userId,
  ]);
  await admin.query("insert into hive.team_members (org_id, team_id, user_id, role) values ($1, $2, $3, 'viewer')", [
    org.orgId,
    org.teamId,
    userId,
  ]);
  const handler = new OpenAPIHandler(
    codeReviewsRouter({
      pool: app,
      auth,
      runs: {
        load: async () => {
          throw new Error("Không đọc run trong test bình luận.");
        },
      },
    }),
  );
  const call = async (path: string, body?: unknown, session = cookie, orgId = org.orgId) => {
    const headers = new Headers({ cookie: session, "x-hive-org": orgId, "content-type": "application/json" });
    const request = new Request(`http://localhost:3000/v1/code-reviews/comments${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await handler.handle(request, { context: { headers } });
    if (!result.response) throw new Error("Không tìm thấy API bình luận.");
    return result.response;
  };
  expect((await call(`?reviewId=${reviewId}`, undefined, "")).status).toBe(401);
  expect((await call("", { reviewId, path: "a.ts", line: 0, side: "new", headSha, body: "a" })).status).toBe(400);
  const added = await call("", { reviewId, path: "a.ts", line: 1, side: "new", headSha, body: "Bình luận HTTP" });
  expect(added.status).toBe(200);
  const root = codeReviewCommentThread.parse(await added.json());
  const reply = await call("/reply", { threadId: root.id, body: "Trả lời HTTP" });
  expect(reply.status).toBe(200);
  expect(await reply.json()).toMatchObject({ threadId: root.id, authorId: userId });
  const edited = await call("/edit", { commentId: root.id, body: "Sửa HTTP" });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({ body: "Sửa HTTP" });
  for (const [path, resolved] of [
    ["/resolve", true],
    ["/reopen", false],
  ] as const) {
    const response = await call(path, { threadId: root.id });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resolved });
  }
  expect((await call("/delete", { commentId: root.id })).status).toBe(200);
  const listed = await call(`?reviewId=${reviewId}`);
  expect(listed.status).toBe(200);
  const output = (await listed.json()) as {
    threads: { id: string; comments: { body: string; deletedAt: string | null }[] }[];
  };
  expect(output.threads.find((t) => t.id === root.id)?.comments[0]).toMatchObject({
    body: "",
    deletedAt: expect.any(String),
  });
});
