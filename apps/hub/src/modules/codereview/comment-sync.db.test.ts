import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { errorCode, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, type Jobs, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createMemoryProvider, GitProviderError } from "../scm/index.ts";
import { bodyHash, type CommentSyncDeps, syncCommentJob } from "./comment-sync.ts";
import { receiveReviewComment, reconcileCommentPr } from "./comment-sync-in.ts";
import {
  addReviewComment,
  deleteReviewComment,
  editReviewComment,
  listReviewComments,
  replyReviewComment,
  resolveReviewComment,
  retryReviewCommentSync,
} from "./comments.ts";
import { codeReviews, codeReviewComments as comments, codeReviewCommentLinks as links } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
let org: Awaited<ReturnType<typeof seedOrg>>;
const enqueue = vi.fn(async () => randomUUID());
const jobs = { enqueue } as unknown as Jobs;
const sha = "a".repeat(40);
let seq = 0;
beforeAll(async () => {
  org = await seedOrg(admin, `sync-${randomUUID().slice(0, 6)}`);
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});
const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId, userId: org.user("admin") }, fn);

async function fixture(kind: "github" | "gitlab" = "github") {
  const project = await seedProject(admin, app, {
    ...org,
    adminUserId: org.user("admin"),
    masterKey,
    key: `sync-${++seq}-${randomUUID().slice(0, 6)}`,
  });
  await admin.query("update hive.projects set scm_kind = $2 where id = $1", [project.projectId, kind]);
  const provider = createMemoryProvider(kind);
  const ref = { owner: project.owner, name: project.repo };
  const repo = provider.seedRepo(ref);
  const create = provider.createReviewComment;
  provider.createReviewComment = async (...args) => {
    const remote = await create(...args);
    remote.url = `https://git.test/comment/${remote.id}`;
    return remote;
  };
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
  const deps: CommentSyncDeps = { pool: app, providerFactory: () => provider, masterKey, jobs };
  const job = { orgId: org.orgId, projectId: project.projectId, prNumber: 1 };
  const add = () =>
    tenant((tx) =>
      addReviewComment(
        tx,
        org.user("admin"),
        { reviewId: review.id, path: "src/a.ts", line: 12, side: "old", headSha: sha, body: "Thêm test" },
        deps,
      ),
    );
  const state = (id: string) => tenant(async (tx) => (await tx.select().from(links).where(eq(links.commentId, id)))[0]);
  let time = Date.now() + 100;
  const sync = () => {
    time += 3000;
    return syncCommentJob(deps, job, new Date(time));
  };
  return { project, provider, ref, repo, deps, job, add, state, sync, review };
}

for (const kind of ["github", "gitlab"] as const)
  describe(`đẩy bình luận ${kind}`, () => {
    it("thêm, trả lời, sửa, resolve, reopen và xoá đúng vị trí; list có trạng thái và URL", async () => {
      const f = await fixture(kind);
      const root = await f.add();
      expect((await f.state(root.id))?.state).toBe("pending");
      await f.sync();
      expect((await f.state(root.id))?.state).toBe("synced");
      const call = f.provider.calls.find((c) => c.method === "createReviewComment");
      expect(call?.args).toEqual([
        f.ref,
        1,
        expect.objectContaining({
          path: "src/a.ts",
          line: 12,
          side: "LEFT",
          commitSha: sha,
          body: expect.stringContaining(`<!-- xdev-hive:c=${root.id} -->`),
        }),
      ]);
      const reply = await tenant((tx) =>
        replyReviewComment(tx, org.user("admin"), { threadId: root.id, body: "Đã thêm" }, f.deps),
      );
      await f.sync();
      expect((await f.state(reply.id))?.providerThreadId).toBe((await f.state(root.id))?.providerThreadId);
      await tenant((tx) => editReviewComment(tx, org.user("admin"), { commentId: root.id, body: "Đổi test" }, f.deps));
      await f.sync();
      expect((await f.state(root.id))?.bodyHash).toBe(bodyHash("Đổi test"));
      await tenant((tx) => resolveReviewComment(tx, org.user("admin"), root.id, true, f.deps));
      await f.sync();
      expect((await f.state(root.id))?.providerResolved).toBe(true);
      await tenant((tx) => resolveReviewComment(tx, org.user("admin"), root.id, false, f.deps));
      await f.sync();
      expect((await f.state(root.id))?.providerResolved).toBe(false);
      const listed = await tenant((tx) => listReviewComments(tx, org.user("admin"), f.review.id));
      expect(listed.threads[0]?.comments[0]).toMatchObject({
        syncState: "synced",
        providerUrl: expect.any(String),
        origin: "hive",
      });
      await tenant((tx) => deleteReviewComment(tx, org.user("admin"), reply.id, f.deps));
      await f.sync();
      expect((await f.state(reply.id))?.providerDeleted).toBe(true);
      expect(await f.provider.listReviewComments(f.ref, 1)).toHaveLength(1);
    });

    it("webhook tới trước API trả không tạo trùng; giao lại 100 lần không đổi dữ liệu", async () => {
      const f = await fixture(kind);
      const root = await f.add();
      const create = f.provider.createReviewComment;
      f.provider.createReviewComment = async (...args) => {
        const remote = await create(...args);
        await tenant((tx) =>
          receiveReviewComment(tx, { ...f.job, provider: kind, action: "created", comment: remote }, f.deps),
        );
        return remote;
      };
      await f.sync();
      const [remote] = await f.provider.listReviewComments(f.ref, 1);
      if (!remote) throw new Error("Không có bình luận từ provider.");
      const before = await f.state(root.id);
      for (let i = 0; i < 100; i++)
        await tenant((tx) =>
          receiveReviewComment(tx, { ...f.job, provider: kind, action: "created", comment: remote }, f.deps),
        );
      expect(await f.state(root.id)).toEqual(before);
      expect(await tenant((tx) => tx.select().from(comments).where(eq(comments.reviewId, f.review.id)))).toHaveLength(
        1,
      );
      expect(await f.provider.listReviewComments(f.ref, 1)).toHaveLength(1);
    });
  });

describe("thử lại và giới hạn ghi", () => {
  it("vị trí sai rơi về bình luận chung có vị trí và dấu ẩn", async () => {
    const f = await fixture();
    const root = await f.add();
    f.provider.fail("createReviewComment", new GitProviderError("position_invalid", "Vị trí không hợp lệ."));
    await f.sync();
    await f.sync();
    expect((await f.state(root.id))?.state).toBe("fallback");
    expect(f.repo.comments).toEqual([
      expect.objectContaining({ pullRequest: true, body: expect.stringContaining(`src/a.ts:12@${sha}`) }),
    ]);
    await reconcileCommentPr(f.deps, f.job);
    expect((await f.state(root.id))?.providerDeleted).toBe(false);
  });

  it("rate_limited hoãn theo Retry-After; không tăng attempts", async () => {
    const f = await fixture();
    const root = await f.add();
    f.provider.fail(
      "createReviewComment",
      new GitProviderError("rate_limited", "Hết hạn mức.", { retryAfterMs: 123_000 }),
    );
    const now = new Date();
    await syncCommentJob(f.deps, f.job, now);
    const link = await f.state(root.id);
    expect(link).toMatchObject({ state: "pending", attempts: 0 });
    expect(link?.nextAttemptAt?.getTime()).toBe(now.getTime() + 123_000);
    const calls = f.provider.calls.filter((c) => c.method === "createReviewComment").length;
    await syncCommentJob(f.deps, f.job, new Date(now.getTime() + 1000));
    expect(f.provider.calls.filter((c) => c.method === "createReviewComment")).toHaveLength(calls);
  });

  it("thiếu quyền dừng trước khi gọi API ghi", async () => {
    const f = await fixture();
    const root = await f.add();
    f.provider.owners.clear();
    await f.sync();
    expect((await f.state(root.id))?.state).toBe("disabled");
    expect(f.provider.calls.some((c) => c.method === "createReviewComment")).toBe(false);
  });

  it("lỗi năm lần thành failed; chỉ tác giả được thử lại", async () => {
    const f = await fixture();
    const root = await f.add();
    f.provider.fail("createReviewComment", new GitProviderError("unavailable", "Tạm ngừng."));
    for (let i = 0; i < 5; i++) await syncCommentJob(f.deps, f.job, new Date(Date.now() + i * 3600_000));
    expect((await f.state(root.id))?.state).toBe("failed");
    expect(
      await errorCode(() => tenant((tx) => retryReviewCommentSync(tx, org.user("tmember"), root.id, f.deps))),
    ).toBe("CODE_REVIEW_COMMENT_AUTHOR_ONLY");
    await tenant((tx) => retryReviewCommentSync(tx, org.user("admin"), root.id, f.deps));
    expect((await f.state(root.id))?.state).toBe("pending");
  });

  it("giữ hạn mức chung khi hai PR dùng cùng kết nối", async () => {
    const f = await fixture();
    await f.add();
    const [second] = await tenant((tx) =>
      tx
        .insert(codeReviews)
        .values({ ...f.review, id: randomUUID(), prNumber: 2 })
        .returning(),
    );
    if (!second) throw new Error("Không tạo được PR thứ hai.");
    await tenant((tx) =>
      addReviewComment(
        tx,
        org.user("admin"),
        { reviewId: second.id, path: "a.ts", line: 1, side: "new", headSha: sha, body: "Câu thứ hai" },
        f.deps,
      ),
    );
    const now = new Date(Date.now() + 100);
    await Promise.all([syncCommentJob(f.deps, f.job, now), syncCommentJob(f.deps, { ...f.job, prNumber: 2 }, now)]);
    expect(f.provider.calls.filter((c) => c.method === "createReviewComment")).toHaveLength(1);
    const later = new Date(now.getTime() + 2000);
    await syncCommentJob(f.deps, f.job, later);
    await syncCommentJob(f.deps, { ...f.job, prNumber: 2 }, later);
    expect(f.provider.calls.filter((c) => c.method === "createReviewComment")).toHaveLength(2);
  });
});
