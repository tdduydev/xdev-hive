import { randomBytes, randomUUID } from "node:crypto";
import { type CodeReviewFinding, workflowInput } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { z } from "zod";
import type { OrgFixture } from "../../../test/org-fixture.ts";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, type Jobs, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createMemoryProvider, GitProviderError, type MemoryProvider } from "../scm/index.ts";
import { onReviewRunFinished as aiRunFinished, type FinishedReviewRun, type StartReviewRunsInput } from "./ai.ts";
import { type CodeReviewWorkerDeps, handleCodeReviewJob } from "./jobs.ts";
import { type CodeReviewJob, cancelCodeReview, onReviewRunFinished, startCodeReview } from "./service.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

type Fixture = OrgFixture & { user: (n: string) => string };
let org: Fixture;
let provider: MemoryProvider;

// ---- Hàng đợi và engine giả ----------------------------------------------------------------------------------------

const queued: CodeReviewJob[] = [];
const jobs: Jobs = {
  start: async () => {},
  stop: async () => {},
  enqueue: async (_queue, data) => {
    queued.push(data as CodeReviewJob);
    return randomUUID();
  },
  schedule: async () => {},
  work: async () => {},
};
const reviewRuns: StartReviewRunsInput[] = [];
/** CLI không có máy dùng chung nào: run review của nó `waiting_machine` (ADR 0017). */
const noMachine = new Set<string>();
const warnings: string[] = [];
const deps: CodeReviewWorkerDeps = {
  pool: app,
  jobs,
  masterKey,
  providerFactory: () => provider,
  publicUrl: "https://hive.example.com/",
  logger: { warn: (m: string) => void warnings.push(m) },
  runEvidence: async () => null,
  startReviewRuns: async (_tx, input) => {
    reviewRuns.push(input);
    return input.reviewers.map((r) => ({
      runId: randomUUID(),
      cli: r.cli,
      model: r.model,
      state: noMachine.has(r.cli) ? "waiting_machine" : "queued",
    }));
  },
};

async function settle() {
  for (let n = 0; n < 20 && queued.length; n++) for (const j of queued.splice(0)) await handleCodeReviewJob(deps, j);
}

const sys = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId }, fn);

// ---- Dữ liệu -------------------------------------------------------------------------------------------------------

type Gate = z.input<typeof workflowInput>["phases"][number]["gates"][number];
type GateAi = NonNullable<Gate["ai"]>;

const HUMAN: Gate = {
  id: "reviewer",
  name: "Người duyệt",
  kind: "human",
  reviewers: { users: [], roles: ["team-member"], quorum: 1 },
  slaHours: 24,
};

let seq = 0;

/** Dự án có quy trình [AI, người duyệt], một PR do run code mở; trả phiên và lượt checkpoint AI đang chờ. */
async function openAiReview(ai: GateAi) {
  seq += 1;
  const key = `ai${seq}-${tag}`;
  const p = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key,
  });
  const ref = { owner: p.owner, name: p.repo };
  provider.seedRepo(ref);
  const w = workflowInput.parse({
    name: `Code ${key}`,
    preset: "custom",
    subject: "code",
    teamId: org.teamId,
    docPrefixes: [],
    code: { projects: [key] },
    phases: [{ name: "Review", gates: [{ id: "ai", name: "Review AI", kind: "ai", ai, slaHours: null }, HUMAN] }],
    enabled: true,
  });
  await admin.query(
    `insert into hive.review_workflows (org_id, team_id, name, preset, subject, doc_prefixes, code, phases, enabled)
     values ($1, $2, $3, 'custom', 'code', '{}', $4, $5, true)`,
    [org.orgId, w.teamId, w.name, JSON.stringify(w.code), JSON.stringify(w.phases)],
  );
  const branch = `ai/${key}`;
  await provider.commitFiles(ref, {
    branch,
    fromBranch: "main",
    message: "agent",
    files: [{ path: "src/pay.ts", content: "export {}\n" }],
  });
  const { number, url } = await provider.openPR(ref, { head: branch, base: "main", title: branch, body: "" });
  const headSha = (await provider.getPR(ref, number))?.headSha ?? "";
  const review = await sys((tx) =>
    startCodeReview(
      tx,
      {
        id: randomUUID(),
        teamId: org.teamId,
        projectId: p.projectId,
        taskId: null,
        ownerUserId: org.user("tadmin"),
        taskType: "feature",
        headSha,
        pr: { number, url, branch, baseBranch: "main" },
        stats: { addedLines: 10, deletedLines: 0, changedFiles: ["src/pay.ts"] },
        reasons: [],
      },
      deps,
    ),
  );
  await settle();
  if (!review) throw new Error("không mở được phiên");
  const [gate] = await gateRuns(review.id);
  return { review, gate, runIds: gate.run_ids as string[], ref, prNumber: number };
}

const reviewRow = async (id: string) =>
  (await admin.query("select status, gate_index from hive.code_reviews where id = $1", [id])).rows[0];
const gateRuns = async (id: string) =>
  (
    await admin.query(
      "select gate_id, status, score, note, checklist, details, run_ids from hive.code_review_gate_runs where review_id = $1 order by gate_index, started_at",
      [id],
    )
  ).rows;

const submitted = (id: string, score: number, findings: CodeReviewFinding[] = []): FinishedReviewRun => ({
  id,
  state: "succeeded",
  review: {
    score,
    summary: `Chấm ${score}`,
    findings,
    checklist: [{ label: "Có test", passed: score >= 8, note: null }],
  },
  error: null,
});
const finish = (run: FinishedReviewRun) => sys((tx) => onReviewRunFinished(tx, run, deps));
const comments = (prNumber: number) =>
  [...provider.repos.values()].flatMap((r) => r.comments).filter((c) => c.number === prNumber);

const TWO = [{ cli: "claude" as const }, { cli: "codex" as const, model: "gpt-5" }];

beforeAll(async () => {
  org = await seedOrg(admin, `cra-${tag}`);
  provider = createMemoryProvider("gitlab", ["xdev-team"]);
});

beforeEach(() => {
  queued.splice(0);
  reviewRuns.splice(0);
  noMachine.clear();
  warnings.splice(0);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

// ---- Test ----------------------------------------------------------------------------------------------------------

describe("checkpoint AI", () => {
  it("gửi rubric đã làm sạch, đường dẫn trọng tâm và quy tắc chấm cho engine", async () => {
    await openAiReview({ checks: ["Có test", " có  test", "An toàn"], passScore: 8, reviewers: TWO, blockOn: "major" });
    expect(reviewRuns[0]?.rubric).toEqual(["Có test", "An toàn"]);
    expect(reviewRuns[0]?.guidance.join("\n")).toMatch(/8\/10[\s\S]*critical hoặc major/);
  });

  it("aggregate all: một reviewer chấm dưới ngưỡng thì không đạt và phiên bị trả lại", async () => {
    const { review, runIds } = await openAiReview({ checks: ["Có test"], passScore: 8, reviewers: TWO });

    expect(await finish(submitted(runIds[0] as string, 9))).toBe(true);
    let [g] = await gateRuns(review.id);
    expect(g.status).toBe("waiting");
    expect(g.details[0]).toMatchObject({ cli: "claude", state: "done", score: 9, passed: true, summary: "Chấm 9" });
    expect(g.details[1]).toMatchObject({ cli: "codex", state: "queued", passed: null });

    await finish(submitted(runIds[1] as string, 6));
    [g] = await gateRuns(review.id);
    expect(g).toMatchObject({ status: "failed", score: 7.5 });
    expect(g.note).toContain("codex chấm 6/10, dưới ngưỡng 8.");
    expect(g.details.map((d: { passed: boolean }) => d.passed)).toEqual([true, false]);
    expect(g.details[1].checklist).toEqual([{ label: "Có test", passed: false, note: null }]);
    expect(g.checklist).toEqual([
      { label: "Reviewer claude", passed: true, note: "9/10" },
      { label: "Reviewer codex (gpt-5)", passed: false, note: "6/10" },
    ]);
    expect(await reviewRow(review.id)).toMatchObject({ status: "changes_requested", gate_index: 0 });
  });

  it("aggregate avg: điểm trung bình đạt ngưỡng thì đi tiếp tới người duyệt", async () => {
    const { review, runIds } = await openAiReview({
      checks: ["Có test"],
      passScore: 8,
      reviewers: TWO,
      aggregate: "avg",
    });
    await finish(submitted(runIds[0] as string, 9));
    await finish(submitted(runIds[1] as string, 7));
    await settle();
    const runs = await gateRuns(review.id);
    expect(runs.map((r) => [r.gate_id, r.status])).toEqual([
      ["ai", "passed"],
      ["reviewer", "waiting"],
    ]);
    expect(runs[0]).toMatchObject({ score: 8, note: null });
    expect(await reviewRow(review.id)).toMatchObject({ status: "in_review", gate_index: 1 });
  });

  it("blockOn major: điểm đủ nhưng có phát hiện major thì không đạt, ghi phát hiện làm lý do", async () => {
    const { review, runIds } = await openAiReview({
      checks: ["Có test"],
      passScore: 7,
      reviewers: [{ cli: "claude" }],
      blockOn: "major",
    });
    await finish(
      submitted(runIds[0] as string, 9, [
        { file: "src/pay.ts", line: 4, severity: "major", message: "Không kiểm số âm" },
        { file: "src/pay.ts", line: null, severity: "minor", message: "Tên biến" },
      ]),
    );
    const [g] = await gateRuns(review.id);
    expect(g.status).toBe("failed");
    expect(g.note).toBe("claude có phát hiện major ở src/pay.ts:4: Không kiểm số âm");
    expect(g.details[0]).toMatchObject({ state: "done", score: 9, passed: false });
    expect((await reviewRow(review.id)).status).toBe("changes_requested");
  });

  it("một reviewer lỗi: chờ reviewer còn lại rồi không đạt với lý do", async () => {
    const { review, runIds } = await openAiReview({ checks: ["Có test"], passScore: 7, reviewers: TWO });
    await finish({ id: runIds[1] as string, state: "cancelled", review: null, error: null });
    let [g] = await gateRuns(review.id);
    expect(g.status).toBe("waiting");
    expect(g.details[1]).toMatchObject({ state: "error", passed: false, error: "run review đã bị huỷ." });

    await finish(submitted(runIds[0] as string, 9));
    [g] = await gateRuns(review.id);
    expect(g.status).toBe("failed");
    expect(g.note).toBe("Run review của codex không có kết quả: run review đã bị huỷ.");
    expect(g.checklist[1]).toEqual({ label: "Reviewer codex (gpt-5)", passed: false, note: "run review đã bị huỷ." });
  });

  it("run xong mà agent không nộp review_submit là lỗi của reviewer đó", async () => {
    const { review, runIds } = await openAiReview({
      checks: ["Có test"],
      passScore: 7,
      reviewers: [{ cli: "claude" }],
    });
    await finish({ id: runIds[0] as string, state: "succeeded", review: null, error: null });
    const [g] = await gateRuns(review.id);
    expect(g.status).toBe("failed");
    expect(g.note).toContain("agent không nộp kết quả qua review_submit.");
  });

  it("máy dùng chung vắng: run review waiting_machine, checkpoint chờ kèm lý do", async () => {
    noMachine.add("codex");
    const { review, runIds } = await openAiReview({ checks: ["Có test"], passScore: 7, reviewers: TWO });
    let [g] = await gateRuns(review.id);
    expect(g).toMatchObject({ status: "waiting", note: "Chưa có máy dùng chung có codex." });
    expect(g.details.map((d: { state: string }) => d.state)).toEqual(["queued", "waiting_machine"]);

    await finish(submitted(runIds[0] as string, 9));
    [g] = await gateRuns(review.id);
    expect(g).toMatchObject({ status: "waiting", note: "Chưa có máy dùng chung có codex." });
    expect(g.details[0]).toMatchObject({ state: "done", passed: true });
    expect((await reviewRow(review.id)).status).toBe("in_review");

    // Có máy nhận run và nộp: checkpoint kết luận như thường.
    await finish(submitted(runIds[1] as string, 8));
    [g] = await gateRuns(review.id);
    expect(g).toMatchObject({ status: "passed", note: null });
  });

  it("kết quả báo lặp hay tới sau khi phiên huỷ: lưu kết quả, không kết luận lại", async () => {
    const { review, runIds } = await openAiReview({ checks: ["Có test"], passScore: 8, reviewers: TWO });
    await finish(submitted(runIds[0] as string, 9));
    await finish(submitted(runIds[0] as string, 3));
    let [g] = await gateRuns(review.id);
    expect(g.details[0]).toMatchObject({ score: 9, passed: true });
    expect(g.status).toBe("waiting");

    await sys((tx) => cancelCodeReview(tx, review.id, "PR đã đóng."));
    expect(await finish(submitted(runIds[1] as string, 2))).toBe(true);
    [g] = await gateRuns(review.id);
    expect(g).toMatchObject({ status: "skipped", note: "PR đã đóng." });
    expect(g.details[1]).toMatchObject({ state: "done", score: 2, passed: false });
    expect((await reviewRow(review.id)).status).toBe("cancelled");
  });

  it("đăng một bình luận tổng hợp lên PR khi kết luận, không đăng khi còn chờ", async () => {
    const { review, runIds, prNumber } = await openAiReview({ checks: ["Có test"], passScore: 8, reviewers: TWO });
    const first = await sys((tx) => aiRunFinished(tx, submitted(runIds[0] as string, 9), deps));
    expect(first).toEqual({ reviewId: review.id, gateIndex: 0, verdict: null });
    expect(comments(prNumber)).toHaveLength(0);

    const second = await sys((tx) =>
      aiRunFinished(
        tx,
        submitted(runIds[1] as string, 6, [{ file: "src/pay.ts", line: 2, severity: "major", message: "Sai" }]),
        deps,
      ),
    );
    expect(second?.verdict).toMatchObject({ status: "failed", score: 7.5 });
    await new Promise((r) => setTimeout(r, 0));
    const posted = comments(prNumber);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ pullRequest: true });
    expect(posted[0]?.body).toContain("Review AI “Review AI”: ❌ không đạt (7.5/10, ngưỡng 8");
    expect(posted[0]?.body).toContain("| codex (gpt-5) | 6/10 | không đạt |");
    expect(posted[0]?.body).toContain("`src/pay.ts:2`: Sai");
    expect(posted[0]?.body).toContain(`https://hive.example.com/knowledge/reviews?tab=code&id=${review.id}`);
  });

  it("lỗi nhà cung cấp khi bình luận chỉ ghi log, checkpoint vẫn kết luận", async () => {
    const { review, runIds } = await openAiReview({
      checks: ["Có test"],
      passScore: 7,
      reviewers: [{ cli: "claude" }],
    });
    provider.fail("commentOnIssue", new GitProviderError("unavailable", "GitLab sập", { status: 503 }));
    try {
      const out = await sys((tx) => aiRunFinished(tx, submitted(runIds[0] as string, 9), deps));
      expect(out?.verdict?.status).toBe("passed");
      await new Promise((r) => setTimeout(r, 0));
      expect(warnings.join("\n")).toContain("GitLab sập");
    } finally {
      provider.fail("commentOnIssue", null);
    }
    expect((await gateRuns(review.id))[0].details[0]).toMatchObject({ state: "done", passed: true });
  });
});
