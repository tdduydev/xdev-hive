import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createMemoryProvider, type ReviewComment } from "../scm/index.ts";
import { type CommentSyncDeps, syncCommentJob } from "./comment-sync.ts";
import {
  type IncomingReviewComment,
  receiveReviewComment,
  reconcileCommentPr,
  reconcileOpenComments,
} from "./comment-sync-in.ts";
import { addReviewComment, editReviewComment, resolveReviewComment } from "./comments.ts";
import { codeReviews, codeReviewComments as comments, codeReviewCommentLinks as links } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
let org: Awaited<ReturnType<typeof seedOrg>>;
beforeAll(async () => {
  org = await seedOrg(admin, `sync-in-${randomUUID().slice(0, 6)}`);
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});
const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId, userId: org.user("admin") }, fn);
const sha = "a".repeat(40);

async function fixture(kind: "github" | "gitlab") {
  const project = await seedProject(admin, app, {
    ...org,
    adminUserId: org.user("admin"),
    masterKey,
    key: `in-${randomUUID().slice(0, 8)}`,
  });
  await admin.query("update hive.projects set scm_kind = $2 where id = $1", [project.projectId, kind]);
  const provider = createMemoryProvider(kind);
  const ref = { owner: project.owner, name: project.repo };
  provider.seedRepo(ref);
  const [review] = await tenant((tx) =>
    tx
      .insert(codeReviews)
      .values({
        orgId: org.orgId,
        teamId: org.teamId,
        projectId: project.projectId,
        runId: randomUUID(),
        workflowName: "Review",
        phases: [],
        options: { merge: "project", maxAgentRevisions: 2, dismissStaleApprovals: false },
        prNumber: 1,
        prUrl: "https://git.test/pr/1",
        branch: "work",
        baseBranch: "main",
        headSha: sha,
      })
      .returning(),
  );
  if (!review) throw new Error("Không tạo được review.");
  const deps: CommentSyncDeps = { pool: app, masterKey, providerFactory: () => provider };
  const job = { orgId: org.orgId, projectId: project.projectId, prNumber: 1 };
  const receive = (comment: ReviewComment, action: IncomingReviewComment["action"] = "created") =>
    tenant((tx) => receiveReviewComment(tx, { ...job, provider: kind, action, comment }, deps));
  const list = () => tenant((tx) => tx.select().from(comments).where(eq(comments.reviewId, review.id)));
  const remote: ReviewComment = {
    id: "11",
    threadId: "thread-11",
    path: "a.ts",
    line: 7,
    side: "RIGHT",
    commitSha: sha,
    body: "Cần test cạnh biên",
    author: "alice",
    url: "https://git.test/comment/11",
    updatedAt: new Date(Date.now() + 60_000).toISOString(),
    resolved: false,
    inReplyToId: null,
  };
  return { project, provider, ref, review, deps, job, receive, list, remote };
}

for (const kind of ["github", "gitlab"] as const)
  describe(`nhận bình luận ${kind}`, () => {
    it("bình luận ngoài Hive tạo đúng dòng, câu trả lời về đúng luồng, giao lại không ghi audit thêm", async () => {
      const f = await fixture(kind);
      await f.receive(f.remote);
      const [root] = await f.list();
      expect(root).toMatchObject({
        origin: kind,
        externalAuthor: "alice",
        path: "a.ts",
        line: 7,
        side: "new",
        headSha: sha,
        authorId: null,
      });
      const reply = { ...f.remote, id: "12", inReplyToId: "11", body: "Đã thêm" };
      await f.receive(reply);
      const auditCount = () =>
        admin.query("select count(*)::int as n from hive.audit_log where target_id = $1", [root?.id]);
      const before = (await auditCount()).rows[0].n;
      for (let i = 0; i < 100; i++) await f.receive(f.remote);
      expect((await auditCount()).rows[0].n).toBe(before);
      expect(await f.list()).toEqual(
        expect.arrayContaining([expect.objectContaining({ threadId: root?.id, body: "Đã thêm" })]),
      );
      await tenant((tx) => resolveReviewComment(tx, org.user("admin"), root?.id ?? "", true, f.deps));
      await syncCommentJob(f.deps, f.job);
      expect(
        f.provider.calls.some((c) =>
          ["createReviewComment", "replyReviewComment", "setReviewThreadResolved"].includes(c.method),
        ),
      ).toBe(false);
    });

    it("bản sửa mới nhất thắng, xoá cũ hơn vẫn thắng sửa và không hồi sinh", async () => {
      const f = await fixture(kind);
      await f.receive(f.remote);
      const newer = {
        ...f.remote,
        body: "Bản mới",
        updatedAt: new Date(Date.parse(f.remote.updatedAt) + 1000).toISOString(),
      };
      await f.receive(newer, "edited");
      await f.receive(f.remote, "edited");
      expect((await f.list())[0]?.body).toBe("Bản mới");
      await f.receive(f.remote, "deleted");
      await f.receive({ ...newer, updatedAt: new Date(Date.parse(newer.updatedAt) + 1000).toISOString() }, "edited");
      expect((await f.list())[0]).toMatchObject({ body: "", deletedAt: expect.any(Date) });
    });

    it("xoá đến trước tạo vẫn giữ dấu xoá", async () => {
      const f = await fixture(kind);
      await f.receive(f.remote, "deleted");
      await f.receive(f.remote);
      expect(await f.list()).toEqual([expect.objectContaining({ body: "", deletedAt: expect.any(Date) })]);
    });

    it("resolve, reopen và giao lại không làm đổi thời điểm trạng thái", async () => {
      const f = await fixture(kind);
      await f.receive(f.remote);
      const event = {
        ...f.remote,
        resolved: true,
        updatedAt: new Date(Date.parse(f.remote.updatedAt) + 1000).toISOString(),
      };
      await f.receive(event, "resolved");
      const before = await f.list();
      await f.receive(event, "resolved");
      expect(await f.list()).toEqual(before);
      await f.receive(
        { ...event, resolved: false, updatedAt: new Date(Date.parse(event.updatedAt) + 1000).toISOString() },
        "unresolved",
      );
      expect((await f.list())[0]?.resolvedAt).toBeNull();
    });

    it("dấu ẩn giả không được liên kết với bình luận Hive", async () => {
      const f = await fixture(kind);
      const root = await tenant((tx) =>
        addReviewComment(
          tx,
          org.user("admin"),
          { reviewId: f.review.id, path: "a.ts", line: 7, side: "new", headSha: sha, body: "Bản gốc" },
          f.deps,
        ),
      );
      await f.receive({ ...f.remote, body: `Giả mạo <!-- xdev-hive:c=${root.id} -->`, author: "mallory" });
      const saved = await tenant((tx) => tx.select().from(links).where(eq(links.commentId, root.id)));
      expect(saved[0]?.providerCommentId).toBeNull();
      expect(await f.list()).toHaveLength(1);
    });

    it("sửa đồng thời ở Hive và PR chọn bản có thời điểm mới hơn", async () => {
      const f = await fixture(kind);
      const root = await tenant((tx) =>
        addReviewComment(
          tx,
          org.user("admin"),
          { reviewId: f.review.id, path: "a.ts", line: 7, side: "new", headSha: sha, body: "Bản gốc" },
          f.deps,
        ),
      );
      await syncCommentJob(f.deps, f.job);
      const [remote] = await f.provider.listReviewComments(f.ref, 1);
      if (!remote) throw new Error("Không có bình luận trên PR.");
      await tenant((tx) => editReviewComment(tx, org.user("admin"), { commentId: root.id, body: "Bản Hive" }, f.deps));
      await f.receive({ ...remote, body: "Bản PR", updatedAt: new Date(Date.now() + 60_000).toISOString() }, "edited");
      expect((await f.list())[0]?.body).toBe("Bản PR");
      await f.receive(
        { ...remote, body: "Bản PR cũ", updatedAt: new Date(Date.now() - 60_000).toISOString() },
        "edited",
      );
      expect((await f.list())[0]?.body).toBe("Bản PR");
    });

    it("đối chiếu kéo root trước reply và xoá bình luận không còn trên PR", async () => {
      const f = await fixture(kind);
      const root = await f.provider.createReviewComment(f.ref, 1, {
        path: "a.ts",
        line: 3,
        side: "RIGHT",
        commitSha: sha,
        body: "Ngoài Hive",
      });
      await f.provider.replyReviewComment(f.ref, 1, root.threadId, "Câu trả lời");
      await reconcileCommentPr(f.deps, f.job);
      expect(await f.list()).toHaveLength(2);
      await f.provider.deleteReviewComment(f.ref, 1, root.id);
      await reconcileCommentPr(f.deps, f.job);
      expect((await f.list()).find((c) => c.id === c.threadId)?.deletedAt).not.toBeNull();
    });
  });

it("lịch đối chiếu tìm tổ chức qua hàm giới hạn quyền rồi gửi job theo PR", async () => {
  const f = await fixture("github");
  const enqueued: unknown[] = [];
  const jobs = {
    enqueue: async (_queue: string, data: unknown) => {
      enqueued.push(data);
      return randomUUID();
    },
  } as unknown as import("../platform/index.ts").Jobs;
  await reconcileOpenComments({ ...f.deps, jobs });
  expect(enqueued).toContainEqual(f.job);
});
