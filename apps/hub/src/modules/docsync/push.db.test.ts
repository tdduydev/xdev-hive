import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { archiveDoc, provideDocSaved, saveDoc } from "../knowledge/index.ts";
import { createPool, type Jobs, parseMasterKey, withTenant } from "../platform/index.ts";
import { createMemoryProvider, GitProviderError, type PullRequestEvent, type ScmEventContext } from "../scm/index.ts";
import { contentHash } from "./content.ts";
import { configureProjectHome, type HomeRow, homeById } from "./homes.ts";
import {
  DOCS_STATUS_CONTEXT,
  docSavedHandler,
  onDocsPrClosed,
  pushCommitMessage,
  pushHome,
  requestPushNow,
  syncBranchName,
} from "./push.ts";
import { listTree, moveDoc } from "./routes/tree.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const mem = createMemoryProvider("gitlab", ["xdev-team"]);
const queued: Array<{ queue: string; data: Record<string, unknown> }> = [];
const jobs = {
  enqueue: async (queue: string, data: Record<string, unknown>) => {
    queued.push({ queue, data });
    return randomUUID();
  },
} as unknown as Jobs;
const deps = { pool, jobs, masterKey, providerFactory: () => mem, publicUrl: "https://hive.example" };

let org: Awaited<ReturnType<typeof seedOrg>>;
const keys = { direct: `pd${tag}`, pr: `pp${tag}` };
const projects: Record<string, Awaited<ReturnType<typeof seedProject>>> = {};
const homes: Record<string, HomeRow> = {};
const actor = (name: string) => ({ userId: org.user(name), orgId: org.orgId });
const as = <T>(name: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, actor(name), fn);
const ref = (which: keyof typeof keys) => ({ owner: projects[which]?.owner ?? "", name: projects[which]?.repo ?? "" });
const repo = (which: keyof typeof keys) => {
  const r = mem.repos.get(`${ref(which).owner}/${ref(which).name}`.toLowerCase());
  if (!r) throw new Error("thiếu repo");
  return r;
};
const mainFile = (which: keyof typeof keys, path: string) => repo(which).branches.get("main")?.get(path);
const docKey = (which: keyof typeof keys, name: string) => `project/${keys[which]}/guide/${name}`;
const save = (which: keyof typeof keys, name: string, content: string, baseVersion: number) =>
  as("tadmin", (tx) =>
    saveDoc(tx, { kind: "user", userId: org.user("tadmin") }, { key: docKey(which, name), content, baseVersion }),
  );
/** Đẩy mốc gom về quá khứ thay vì chờ 60 giây thật. */
const elapse = (which: keyof typeof keys) =>
  admin.query(
    "update hive.doc_homes set last_saved_at = now() - interval '2 minutes', first_queued_at = now() - interval '2 minutes' where id = $1",
    [homes[which]?.id],
  );
const push = (which: keyof typeof keys, now = false) =>
  pushHome(deps, { orgId: org.orgId, homeId: homes[which]?.id ?? "", ...(now ? { now } : {}) });
const fileRow = async (which: keyof typeof keys, name: string) => {
  const { rows } = await admin.query(
    `select f.* from hive.doc_repo_files f join hive.docs d on d.id = f.doc_id where d.key = $1`,
    [docKey(which, name)],
  );
  return rows[0];
};
const latestBatch = async (which: keyof typeof keys) =>
  (
    await admin.query("select * from hive.doc_sync_batches where home_id = $1 order by created_at desc limit 1", [
      homes[which]?.id,
    ])
  ).rows[0];
const syncCommits = (which: keyof typeof keys, branch = "main") =>
  repo(which).commits.filter((c) => c.branch === branch && c.message.includes("Hive-Doc-Sync:"));

beforeAll(async () => {
  org = await seedOrg(admin, `dp-${tag}`);
  const base = {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
  };
  projects.direct = await seedProject(admin, pool, { ...base, key: keys.direct });
  const withQueue = defaultProjectSettings();
  projects.pr = await seedProject(admin, pool, {
    ...base,
    key: keys.pr,
    settings: { ...withQueue, features: { ...withQueue.features, mergeQueue: true } },
  });
  for (const which of ["direct", "pr"] as const) {
    mem.seedRepo(ref(which), { files: { "README.md": "# Repo\n" } });
    homes[which] = await as("tadmin", (tx) =>
      configureProjectHome(tx, deps, actor("tadmin"), {
        project: keys[which],
        settings: {
          enabled: true,
          root: "docs/",
          repoSync: which,
          include: ["**/*.md"],
          exclude: [],
          assetsDir: "assets",
          repoChangesNeedReview: false,
        },
      }),
    );
  }
  provideDocSaved(docSavedHandler(jobs));
});

afterAll(async () => {
  provideDocSaved(undefined);
  await Promise.all([admin.end(), pool.end()]);
});

describe("message commit", () => {
  it("đếm tài liệu và đính kèm, có trailer và Co-authored-by không trùng", () => {
    const message = pushCommitMessage({
      docs: 1,
      assets: 2,
      batchId: "b1",
      coAuthors: [
        { name: "An", email: "an@x.test" },
        { name: "An", email: "AN@x.test" },
      ],
    });
    expect(message).toBe(
      "docs: sync 1 document and 2 attachments from xDev Hive\n\nHive-Doc-Sync: b1\nCo-authored-by: An <an@x.test>",
    );
    expect(syncBranchName(null)).toBe("hive/docs-sync-org");
  });
});

describe("đẩy thẳng vào nhánh mặc định", () => {
  it("ba lần lưu gần nhau thành một commit", async () => {
    for (const name of ["one", "two", "three"]) await save("direct", name, `# ${name}\n\nNội dung.\n`, 0);
    expect(queued.filter((j) => j.queue === "docsync-push" && j.data.homeId === homes.direct?.id).length).toBe(3);
    // Lần lưu cuối vừa xong: job hẹn lại tới hết 60 giây.
    expect(await push("direct")).toBe("waiting");
    expect(syncCommits("direct")).toHaveLength(0);

    await elapse("direct");
    expect(await push("direct")).toBe("pushed");
    const commits = syncCommits("direct");
    expect(commits).toHaveLength(1);
    const batch = await latestBatch("direct");
    const tadmin = org.user("tadmin");
    expect(commits[0]?.message).toBe(
      `docs: sync 3 documents from xDev Hive\n\nHive-Doc-Sync: ${batch.id}\nCo-authored-by: ${tadmin} <${tadmin}@seed.test>`,
    );
    expect([...(commits[0]?.paths ?? [])].sort()).toEqual([
      "docs/guide/one.md",
      "docs/guide/three.md",
      "docs/guide/two.md",
    ]);
    expect(mainFile("direct", "docs/guide/one.md")).toBe("# one\n\nNội dung.\n");
    expect(batch).toMatchObject({ state: "done", mode: "direct", commit_sha: commits[0]?.sha, attempts: 1 });
    const row = await fileRow("direct", "one");
    expect(row).toMatchObject({
      state: "synced",
      synced_version: 1,
      synced_commit: commits[0]?.sha,
      synced_hash: contentHash("# one\n\nNội dung.\n"),
      repo_hash: contentHash("# one\n\nNội dung.\n"),
    });
  });

  it("không giữ quá 10 phút dù vẫn đang lưu liên tục", async () => {
    await save("direct", "one", "# one\n\nBản 2.\n", 1);
    await admin.query(
      "update hive.doc_homes set first_queued_at = now() - interval '11 minutes', last_saved_at = now() where id = $1",
      [homes.direct?.id],
    );
    expect(await push("direct")).toBe("pushed");
    expect(mainFile("direct", "docs/guide/one.md")).toBe("# one\n\nBản 2.\n");
  });

  it("giữ EOL và BOM gốc của file", async () => {
    await admin.query(
      "update hive.doc_repo_files set eol = 'crlf', bom = true where doc_id = (select id from hive.docs where key = $1)",
      [docKey("direct", "three")],
    );
    await save("direct", "three", "# three\n\nCRLF.\n", 1);
    await elapse("direct");
    expect(await push("direct")).toBe("pushed");
    expect(mainFile("direct", "docs/guide/three.md")).toBe("﻿# three\r\n\r\nCRLF.\r\n");
  });

  it("không ghi đè file repo đã đổi mà hub chưa kéo về, xếp job kéo", async () => {
    await mem.commitFiles(ref("direct"), {
      branch: "main",
      message: "sửa tay trên repo",
      files: [{ path: "docs/guide/two.md", content: "# two\n\nSửa trong repo.\n" }],
    });
    await save("direct", "two", "# two\n\nSửa trên hub.\n", 1);
    await elapse("direct");
    const before = syncCommits("direct").length;
    queued.length = 0;
    expect(await push("direct")).toBe("empty");
    expect(syncCommits("direct")).toHaveLength(before);
    expect(mainFile("direct", "docs/guide/two.md")).toBe("# two\n\nSửa trong repo.\n");
    expect((await fileRow("direct", "two")).state).toBe("pending");
    expect(queued).toContainEqual({ queue: "docsync-pull", data: { orgId: org.orgId, homeId: homes.direct?.id } });
    // Chỉ bỏ file bị đổi: lô sau vẫn đẩy file khác.
    await save("direct", "three", "# three\n\nBản 3.\n", 2);
    await elapse("direct");
    expect(await push("direct")).toBe("pushed");
    expect(syncCommits("direct").at(-1)?.paths).toEqual(["docs/guide/three.md"]);
    expect(mainFile("direct", "docs/guide/two.md")).toBe("# two\n\nSửa trong repo.\n");
  });

  it("di chuyển giữ lịch sử, lưu trữ thì xoá file", async () => {
    const one = await fileRow("direct", "one");
    const moved = await as("tadmin", (tx) =>
      moveDoc(tx, deps, org.user("tadmin"), {
        key: docKey("direct", "one"),
        repoPath: "docs/moved/one.md",
        baseVersion: 2,
      }),
    );
    expect(moved).toMatchObject({ path: "docs/moved/one.md", state: "pending", kind: "doc" });
    // Di chuyển lần nữa trước khi đẩy vẫn tính từ nơi file đang nằm trong repo.
    await as("tadmin", (tx) =>
      moveDoc(tx, deps, org.user("tadmin"), {
        key: docKey("direct", "one"),
        repoPath: "docs/moved/first.md",
        baseVersion: 2,
      }),
    );
    await elapse("direct");
    expect(await push("direct")).toBe("pushed");
    const commit = syncCommits("direct").at(-1);
    expect(commit?.paths).toEqual(["docs/moved/first.md"]);
    expect(mainFile("direct", "docs/guide/one.md")).toBeUndefined();
    expect(mainFile("direct", "docs/moved/first.md")).toBe("# one\n\nBản 2.\n");
    expect(await fileRow("direct", "one")).toMatchObject({ state: "synced", repo_path: "docs/moved/first.md" });
    expect(one.synced_hash).toBe(contentHash("# one\n\nBản 2.\n"));

    await as("tadmin", (tx) =>
      archiveDoc(tx, { kind: "user", userId: org.user("tadmin") }, { key: docKey("direct", "one"), baseVersion: 2 }),
    );
    await elapse("direct");
    expect(await push("direct")).toBe("pushed");
    expect(mainFile("direct", "docs/moved/first.md")).toBeUndefined();
    expect(await fileRow("direct", "one")).toMatchObject({ state: "synced", synced_hash: null });
  });

  it("cây tài liệu kèm trạng thái và link file trong repo", async () => {
    const page = await as("tmember", (tx) =>
      listTree(tx, org.user("tmember"), { homeId: homes.direct?.id, prefix: "docs/guide/", limit: 1 }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      path: "docs/guide/three.md",
      kind: "doc",
      state: "synced",
      repoUrl: `https://gitlab.com/${ref("direct").owner}/${ref("direct").name}/-/blob/main/docs/guide/three.md`,
    });
    const next = await as("tmember", (tx) =>
      listTree(tx, org.user("tmember"), {
        homeId: homes.direct?.id,
        prefix: "docs/guide/",
        limit: 1,
        cursor: page.nextCursor ?? undefined,
      }),
    );
    expect(next.items[0]).toMatchObject({ path: "docs/guide/two.md", state: "pending" });
  });

  it("nhánh được bảo vệ: lỗi không tự hết, không thử lại, báo quản trị; Đồng bộ ngay chạy lại", async () => {
    repo("direct").protection.set("main", { requirePullRequest: true, requiredApprovals: 1, allowForcePush: false });
    await save("direct", "three", "# three\n\nBản 4.\n", 3);
    await elapse("direct");
    queued.length = 0;
    expect(await push("direct")).toBe("failed");
    expect(await latestBatch("direct")).toMatchObject({
      state: "failed",
      error: "DOCSYNC_BRANCH_PROTECTED",
      next_at: null,
    });
    expect(await fileRow("direct", "three")).toMatchObject({ state: "failed" });
    const { rows: home } = await admin.query("select error from hive.doc_homes where id = $1", [homes.direct?.id]);
    expect(home[0].error).toContain("Nhánh được bảo vệ");
    expect(queued.some((j) => j.queue === "docsync-push")).toBe(false);
    const { rows: notes } = await admin.query(
      "select title, user_id from hive.inbox_items where org_id = $1 and event = 'docsync.sync_failed'",
      [org.orgId],
    );
    expect(notes).toContainEqual({
      title: `Chưa đồng bộ được tài liệu vào repo ${ref("direct").owner}/${ref("direct").name}`,
      user_id: org.user("tadmin"),
    });

    repo("direct").protection.delete("main");
    const row = await as("tadmin", (tx) => homeById(tx, homes.direct?.id ?? ""));
    expect(await as("tadmin", (tx) => requestPushNow(tx, jobs, row))).toBe(true);
    expect(queued.at(-1)).toMatchObject({ queue: "docsync-push", data: { homeId: row.id, now: true } });
    expect(await push("direct", true)).toBe("pushed");
    expect(mainFile("direct", "docs/guide/three.md")).toBe("﻿# three\r\n\r\nBản 4.\r\n");
  });

  it("lỗi tạm thời: thử lại theo lịch, giữ lô cũ", async () => {
    mem.fail("commitFiles", new GitProviderError("unavailable", "GitHub đang lỗi"));
    await save("direct", "three", "# three\n\nBản 5.\n", 4);
    await elapse("direct");
    queued.length = 0;
    expect(await push("direct")).toBe("failed");
    const failed = await latestBatch("direct");
    expect(failed).toMatchObject({ state: "failed", attempts: 1 });
    expect(failed.next_at.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(queued.filter((j) => j.queue === "docsync-push")).toHaveLength(1);
    // Chưa tới giờ thử lại thì job hẹn lại, không gọi Git.
    expect(await push("direct")).toBe("waiting");
    mem.fail("commitFiles", null);
    await admin.query("update hive.doc_sync_batches set next_at = now() - interval '1 second' where id = $1", [
      failed.id,
    ]);
    expect(await push("direct")).toBe("pushed");
    expect(await latestBatch("direct")).toMatchObject({ id: failed.id, state: "done", attempts: 2 });
  });
});

describe("chế độ PR cuốn chiếu", () => {
  const branch = () => syncBranchName(keys.pr);

  it("lô đầu mở PR, gắn commit status và vào merge queue", async () => {
    await save("pr", "alpha", "# alpha\n", 0);
    await elapse("pr");
    expect(await push("pr")).toBe("pushed");
    expect(syncCommits("pr", "main")).toHaveLength(0);
    const commits = syncCommits("pr", branch());
    expect(commits).toHaveLength(1);
    expect(repo("pr").pulls).toMatchObject([{ number: 1, head: branch(), base: "main", state: "open" }]);
    expect(
      repo("pr")
        .statuses.get(commits[0]?.sha ?? "")
        ?.get(DOCS_STATUS_CONTEXT),
    ).toMatchObject({
      state: "success",
    });
    const { rows } = await admin.query(
      "select pr_number, branch, enqueued_by from hive.merge_queue_entries where project_id = $1",
      [projects.pr?.projectId],
    );
    expect(rows).toEqual([{ pr_number: 1, branch: branch(), enqueued_by: "system:docsync" }]);
    expect(await fileRow("pr", "alpha")).toMatchObject({
      state: "synced",
      synced_hash: contentHash("# alpha\n"),
      repo_hash: null,
    });
  });

  it("lô sau thêm commit vào cùng PR", async () => {
    await save("pr", "alpha", "# alpha\n\nBản 2.\n", 1);
    await save("pr", "beta", "# beta\n", 0);
    await elapse("pr");
    expect(await push("pr")).toBe("pushed");
    const commits = syncCommits("pr", branch());
    expect(commits).toHaveLength(2);
    expect(commits[1]?.paths.sort()).toEqual(["docs/guide/alpha.md", "docs/guide/beta.md"]);
    expect(repo("pr").pulls).toHaveLength(1);
    expect(repo("pr").branches.get(branch())?.get("docs/guide/alpha.md")).toBe("# alpha\n\nBản 2.\n");
    const { rows } = await admin.query("select pr_number, pr_url from hive.doc_homes where id = $1", [homes.pr?.id]);
    expect(rows[0]).toEqual({ pr_number: 1, pr_url: repo("pr").pulls[0]?.url });
  });

  it("PR bị đóng không merge: file về pending, nhà báo lỗi, không tự đẩy lại", async () => {
    queued.length = 0;
    const event = {
      kind: "pull_request.closed",
      provider: "gitlab",
      repo: `${ref("pr").owner}/${ref("pr").name}`,
      actor: null,
      actorId: null,
      pullRequest: { number: 1, title: "docs", url: "", head: branch(), base: "main", headSha: null },
    } as PullRequestEvent;
    await withTenant(pool, { orgId: org.orgId }, (tx) =>
      onDocsPrClosed(event, {
        tx,
        orgId: org.orgId,
        projectId: projects.pr?.projectId ?? "",
        afterCommit: () => {},
      } as unknown as ScmEventContext),
    );
    expect(await fileRow("pr", "alpha")).toMatchObject({ state: "pending", synced_hash: null });
    expect(await fileRow("pr", "beta")).toMatchObject({ state: "pending", synced_hash: null });
    const { rows } = await admin.query("select pr_number, error from hive.doc_homes where id = $1", [homes.pr?.id]);
    expect(rows[0].pr_number).toBeNull();
    expect(rows[0].error).toContain("bị đóng mà không merge");
    expect(queued).toHaveLength(0);
  });
});
