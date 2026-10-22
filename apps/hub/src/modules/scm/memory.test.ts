import { describe, expect, it } from "vitest";
import { createMemoryProvider } from "./memory.ts";

const ref = { owner: "xdev-team", name: "web" };

describe("memory provider: prFiles và setCommitStatus", () => {
  it("đọc blob, so sánh commit, tải archive và nhận yêu cầu LFS", async () => {
    const scm = createMemoryProvider();
    scm.seedRepo(ref, { files: { "a.txt": "cũ" } });
    const before = await scm.branchHead(ref, "main");
    const { sha } = await scm.commitFiles(ref, {
      branch: "main",
      message: "update",
      files: [{ path: "a.txt", content: "mới" }],
    });
    expect(new TextDecoder().decode(await scm.readBlob(ref, "mới"))).toBe("mới");
    expect(await scm.compare(ref, before!, sha)).toMatchObject({
      files: [{ path: "a.txt", status: "modified" }],
      incomplete: false,
    });
    expect(await new Response(await scm.archive(ref, sha)).text()).toContain("mới");
    expect(await scm.lfsBatch(ref, "upload", [{ oid: "sha256:abc", size: 3 }])).toMatchObject({
      objects: [{ oid: "sha256:abc" }],
    });
  });

  it("mô phỏng cây bị cắt, compare chưa đầy đủ và nhánh bị bảo vệ", async () => {
    const scm = createMemoryProvider();
    scm.seedRepo(ref, { files: { "a.txt": "a", "b.txt": "b" }, truncated: true, incomplete: true });
    const head = await scm.branchHead(ref, "main");
    expect(await scm.listFiles(ref, head!)).toHaveLength(1);
    expect((await scm.compare(ref, head!, head!)).incomplete).toBe(true);
    await scm.protectBranch(ref, "main", { requirePullRequest: true, requiredApprovals: 1, allowForcePush: false });
    await expect(
      scm.commitFiles(ref, { branch: "main", message: "x", files: [{ path: "c.txt", content: "c" }] }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });
  it("giữ luồng bình luận theo dòng và hỗ trợ sửa, xoá, resolve", async () => {
    const scm = createMemoryProvider();
    scm.seedRepo(ref);
    const pr = await scm.openPR(ref, { head: "feature", base: "main", title: "T", body: "" });
    const created = await scm.createReviewComment(ref, pr.number, {
      path: "src/a.ts",
      line: 4,
      side: "RIGHT",
      commitSha: "sha1",
      body: "Cần sửa",
    });
    const reply = await scm.replyReviewComment(ref, pr.number, created.threadId, "Đã sửa");
    expect(reply.inReplyToId).toBe(created.id);
    await scm.editReviewComment(ref, pr.number, reply.id, "Đã sửa xong");
    await scm.setReviewThreadResolved(ref, pr.number, created.threadId, true);
    expect(await scm.listReviewComments(ref, pr.number)).toMatchObject([
      { id: created.id, resolved: true },
      { id: reply.id, body: "Đã sửa xong", resolved: true },
    ]);
    await scm.deleteReviewComment(ref, pr.number, reply.id);
    expect(await scm.listReviewComments(ref, pr.number)).toHaveLength(1);
  });

  it("suy file đổi từ nhánh head và base, hoặc dùng danh sách đặt tay", async () => {
    const scm = createMemoryProvider();
    scm.seedRepo(ref, { files: { "a.txt": "một\nhai\n", "gone.txt": "bye\n" } });
    await scm.commitFiles(ref, {
      branch: "ai/T",
      fromBranch: "main",
      message: "t",
      files: [
        { path: "a.txt", content: "một\nHAI\nba\n" },
        { path: "new.txt", content: "mới\n" },
      ],
    });
    const { number } = await scm.openPR(ref, { head: "ai/T", base: "main", title: "T", body: "" });
    const files = await scm.prFiles(ref, number);
    expect(files?.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["a.txt", "modified", 3, 2],
      ["new.txt", "added", 1, 0],
    ]);
    expect(files?.[1]?.patch).toBe("@@ -0,0 +1,1 @@\n+mới");

    scm.setPull(ref, number, {
      files: [{ path: "big.json", status: "modified", additions: 9000, deletions: 1, truncated: true }],
    });
    expect((await scm.prFiles(ref, number))?.[0]?.truncated).toBe(true);
    expect(await scm.prFiles(ref, 99)).toBeNull();
  });

  it("status cùng context của một commit bị ghi đè, khác context hoặc khác sha thì giữ riêng", async () => {
    const scm = createMemoryProvider();
    const repo = scm.seedRepo(ref);
    await scm.setCommitStatus(ref, "sha1", { context: "xdev-hive/review", state: "pending", description: "chờ" });
    await scm.setCommitStatus(ref, "sha1", { context: "xdev-hive/review", state: "success", description: "đạt" });
    await scm.setCommitStatus(ref, "sha1", { context: "khac", state: "failure", description: "" });
    await scm.setCommitStatus(ref, "sha2", {
      context: "xdev-hive/review",
      state: "pending",
      description: "x".repeat(300),
    });
    expect(repo.statuses.get("sha1")?.get("xdev-hive/review")?.state).toBe("success");
    expect(repo.statuses.get("sha1")?.size).toBe(2);
    expect(repo.statuses.get("sha2")?.get("xdev-hive/review")?.description).toHaveLength(140);
  });
});

describe("memory provider: pipeline và job", () => {
  const seed = () => {
    const scm = createMemoryProvider("gitlab");
    scm.seedRepo(ref);
    const { pipeline, jobs } = scm.seedPipeline(ref, {
      jobs: [
        { name: "build", stage: "build", status: "success", log: "đã build\n" },
        { name: "test", stage: "test", status: "failed" },
        { name: "deploy", stage: "deploy", status: "manual" },
      ],
    });
    const idOf = (name: string) => {
      const job = jobs.find((j) => j.name === name);
      if (!job) throw new Error(`thiếu job ${name}`);
      return job.id;
    };
    return { scm, pipeline, build: idOf("build"), test: idOf("test"), deploy: idOf("deploy") };
  };

  it("tạo pipeline trên head nhánh mặc định; lọc nhánh, sha, trạng thái; mới nhất trước, phân trang", async () => {
    const { scm, pipeline } = seed();
    expect(pipeline).toMatchObject({ ref: "main", sha: await scm.branchHead(ref, "main"), status: "running" });
    const other = scm.seedPipeline(ref, { ref: "feat", sha: "abc", status: "success" }).pipeline;
    expect((await scm.listPipelines(ref, { page: 1 })).items.map((p) => p.id)).toEqual([other.id, pipeline.id]);
    expect((await scm.listPipelines(ref, { branch: "feat", page: 1 })).items.map((p) => p.id)).toEqual([other.id]);
    expect((await scm.listPipelines(ref, { sha: "abc", page: 1 })).items).toHaveLength(1);
    expect((await scm.listPipelines(ref, { status: "running", page: 1 })).items.map((p) => p.id)).toEqual([
      pipeline.id,
    ]);
    expect(await scm.listPipelines(ref, { page: 1, perPage: 1 })).toMatchObject({ nextPage: 2 });
    expect(await scm.listPipelines(ref, { page: 2, perPage: 1 })).toMatchObject({ nextPage: null });
  });

  it("job, log theo vị trí byte, đổi trạng thái job", async () => {
    const { scm, pipeline, build, test } = seed();
    expect((await scm.pipelineJobs(ref, pipeline.id)).map((j) => [j.name, j.status])).toEqual([
      ["build", "success"],
      ["test", "failed"],
      ["deploy", "manual"],
    ]);
    const size = Buffer.byteLength("đã build\n");
    expect(await scm.jobLog(ref, build, 0)).toEqual({ text: "đã build\n", next: size, complete: true });
    expect(await scm.jobLog(ref, build, size)).toEqual({ text: "", next: size, complete: true });
    scm.setJob(ref, test, { status: "running", appendLog: "chạy test\n" });
    expect(await scm.jobLog(ref, test, 0)).toMatchObject({ text: "chạy test\n", complete: false });
    await expect(scm.jobLog(ref, "999", 0)).rejects.toMatchObject({ code: "not_found" });
  });

  it("bấm job chờ tay; job khác thì invalid", async () => {
    const { scm, build, deploy } = seed();
    expect(await scm.playJob(ref, deploy)).toMatchObject({ id: deploy, status: "pending" });
    await expect(scm.playJob(ref, build)).rejects.toMatchObject({ code: "invalid" });
  });

  it("chạy lại job ra job mới thay job cũ; huỷ job đang chạy", async () => {
    const { scm, pipeline, build, test, deploy } = seed();
    const again = await scm.retryJob(ref, test);
    expect(again).toMatchObject({ name: "test", status: "pending", pipelineId: pipeline.id });
    expect(again.id).not.toBe(test);
    expect((await scm.pipelineJobs(ref, pipeline.id)).map((j) => j.id)).toEqual([build, again.id, deploy]);
    expect(await scm.cancelJob(ref, again.id)).toMatchObject({ status: "canceled" });
    await expect(scm.cancelJob(ref, build)).rejects.toMatchObject({ code: "invalid" });
  });

  it("chạy lại pipeline làm lại job lỗi; huỷ pipeline huỷ job đang chờ", async () => {
    const { scm, pipeline } = seed();
    expect(await scm.retryPipeline(ref, pipeline.id)).toMatchObject({ status: "pending" });
    expect((await scm.pipelineJobs(ref, pipeline.id)).map((j) => j.status)).toEqual(["success", "pending", "manual"]);
    expect(await scm.cancelPipeline(ref, pipeline.id)).toMatchObject({ status: "canceled" });
    expect((await scm.pipelineJobs(ref, pipeline.id)).map((j) => j.status)).toEqual(["success", "canceled", "manual"]);
    scm.setPipeline(ref, pipeline.id, { status: "failed" });
    expect((await scm.listPipelines(ref, { page: 1 })).items[0]?.status).toBe("failed");
  });

  it("phát sự kiện pipeline, job như webhook GitLab đã chuẩn hoá", async () => {
    const { scm, pipeline, test } = seed();
    expect(scm.pipelineEvent(ref, pipeline.id)).toMatchObject({
      provider: "gitlab",
      kind: "pipeline",
      repo: "xdev-team/web",
      pipeline: { id: pipeline.id, ref: "main", sha: pipeline.sha, status: "running" },
    });
    expect(scm.jobEvent(ref, test)).toMatchObject({
      kind: "job",
      job: { id: test, pipelineId: pipeline.id, name: "test", status: "failed" },
    });
  });

  it("deployment chờ duyệt: duyệt hết thì chạy tiếp, từ chối thì lỗi, environment không chờ thì invalid", async () => {
    const scm = createMemoryProvider("github");
    const repo = scm.seedRepo(ref);
    const { pipeline } = scm.seedPipeline(ref, { pendingDeployments: ["staging", "production"] });
    expect(pipeline.status).toBe("waiting");
    expect((await scm.pendingDeployments(ref, pipeline.id)).map((d) => [d.environment, d.canApprove])).toEqual([
      ["staging", true],
      ["production", true],
    ]);
    await scm.reviewDeployments(ref, pipeline.id, { environments: ["staging"], decision: "approve", comment: "" });
    expect((await scm.listPipelines(ref, { page: 1 })).items[0]?.status).toBe("waiting");
    await scm.reviewDeployments(ref, pipeline.id, { environments: ["production"], decision: "approve", comment: "ok" });
    expect((await scm.listPipelines(ref, { page: 1 })).items[0]?.status).toBe("running");
    expect(repo.reviews.map((r) => [r.environments, r.decision, r.comment])).toEqual([
      [["staging"], "approve", ""],
      [["production"], "approve", "ok"],
    ]);
    await expect(
      scm.reviewDeployments(ref, pipeline.id, { environments: ["production"], decision: "approve", comment: "" }),
    ).rejects.toMatchObject({ code: "invalid" });

    const other = scm.seedPipeline(ref, { pendingDeployments: ["production"] }).pipeline;
    await scm.reviewDeployments(ref, other.id, { environments: ["production"], decision: "reject", comment: "chưa" });
    const rejected = (await scm.listPipelines(ref, { page: 1 })).items.find((p) => p.id === other.id);
    expect(rejected).toMatchObject({ status: "failed" });
    expect(rejected?.finishedAt).not.toBeNull();
    expect(await scm.pendingDeployments(ref, other.id)).toEqual([]);
  });

  it("compare trả commit giữa hai sha của nhánh", async () => {
    const scm = createMemoryProvider();
    scm.seedRepo(ref, { files: { "a.txt": "a" } });
    const before = (await scm.branchHead(ref, "main")) ?? "";
    const one = await scm.commitFiles(ref, {
      branch: "main",
      message: "một\n\nchi tiết",
      files: [{ path: "a", content: "1" }],
    });
    const two = await scm.commitFiles(ref, { branch: "main", message: "hai", files: [{ path: "a", content: "2" }] });
    const { commits } = await scm.compare(ref, before, two.sha);
    expect(commits.map((c) => [c.sha, c.title, c.author])).toEqual([
      [one.sha, "một", "hive"],
      [two.sha, "hai", "hive"],
    ]);
    expect(commits[0]?.authoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await scm.compare(ref, one.sha, two.sha)).commits.map((c) => c.sha)).toEqual([two.sha]);
  });
});
