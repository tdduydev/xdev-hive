import { randomBytes, randomUUID } from "node:crypto";
import { type CodeReviewListInput, workflowInput } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { z } from "zod";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createMemoryProvider, type MemoryProvider } from "../scm/index.ts";
import { type DecideDeps, decideCodeReview } from "./decide.ts";
import { codeReviewFiles, countAwaiting, createFilesCache, listCodeReviews } from "./queries.ts";
import { type CodeReviewRun, startCodeReview } from "./service.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let provider: MemoryProvider;

// Không có hàng đợi: phiên đi tiếp ngay trong transaction.
const deps: DecideDeps = {
  masterKey,
  providerFactory: () => provider,
  publicUrl: "https://hive.example.com",
  startReviewRuns: async (_tx, input) =>
    input.reviewers.map((r) => ({ runId: randomUUID(), cli: r.cli, model: r.model, state: "queued" })),
};

const sys = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId }, fn);
const u = (n: string) => org.user(n);

interface P {
  projectId: string;
  key: string;
  ref: { owner: string; name: string };
}

let seq = 0;
async function newProject(): Promise<P> {
  seq += 1;
  const key = `crq${seq}-${tag}`;
  const p = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: u("admin"),
    masterKey,
    key,
  });
  const ref = { owner: p.owner, name: p.repo };
  provider.seedRepo(ref);
  return { projectId: p.projectId, key, ref };
}

type Gate = z.input<typeof workflowInput>["phases"][number]["gates"][number];

async function saveWorkflow(p: P, gates: Gate[]) {
  const w = workflowInput.parse({
    name: `Code ${randomUUID().slice(0, 4)}`,
    preset: "custom",
    subject: "code",
    teamId: org.teamId,
    docPrefixes: [],
    code: { projects: [p.key] },
    phases: [{ name: "Review", gates }],
    enabled: true,
  });
  await admin.query(
    `insert into hive.review_workflows (org_id, team_id, name, preset, subject, doc_prefixes, code, phases, enabled)
     values ($1, $2, $3, 'custom', 'code', '{}', $4, $5, true)`,
    [org.orgId, w.teamId, w.name, JSON.stringify(w.code), JSON.stringify(w.phases)],
  );
}

async function openReview(p: P, requester: string | null = null) {
  const branch = `ai/${randomUUID().slice(0, 6)}`;
  await provider.commitFiles(p.ref, {
    branch,
    fromBranch: "main",
    message: "agent",
    files: [{ path: "src/pay.ts", content: `export const v = "${branch}";\n` }],
  });
  const { number, url } = await provider.openPR(p.ref, { head: branch, base: "main", title: branch, body: "" });
  const headSha = (await provider.getPR(p.ref, number))?.headSha ?? "";
  const run: CodeReviewRun = {
    id: randomUUID(),
    teamId: org.teamId,
    projectId: p.projectId,
    taskId: null,
    ownerUserId: requester,
    taskType: "feature",
    headSha,
    pr: { number, url, branch, baseBranch: "main" },
    stats: { addedLines: 3, deletedLines: 1, changedFiles: ["src/pay.ts"] },
    reasons: [],
  };
  const row = await sys((tx) => startCodeReview(tx, run, deps));
  if (!row) throw new Error("không mở được phiên");
  return { id: row.id, headSha, pr: { number, branch } };
}

const human = (reviewers: Record<string, unknown>, id = "reviewer"): Gate =>
  ({
    id,
    name: "Người duyệt",
    kind: "human",
    reviewers: { users: [], roles: [], quorum: 1, ...reviewers },
    slaHours: 24,
  }) as Gate;
const AI: Gate = {
  id: "ai",
  name: "Review AI",
  kind: "ai",
  ai: { checks: ["Đúng yêu cầu"], passScore: 7, reviewers: [{ cli: "claude" }] },
  slaHours: null,
};

const list = (who: string, input: CodeReviewListInput) => sys((tx) => listCodeReviews(tx, u(who), input));
const ids = async (who: string, input: CodeReviewListInput) => (await list(who, input)).items.map((i) => i.id);
const count = async (who: string) => (await sys((tx) => countAwaiting(tx, u(who)))).awaitingMe;

/** Đọc hết các trang theo con trỏ. */
async function allPages(who: string, input: CodeReviewListInput): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await list(who, { ...input, ...(cursor ? { cursor } : {}) });
    out.push(...page.items.map((x) => x.id));
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
  throw new Error("con trỏ không dừng");
}

beforeAll(async () => {
  org = await seedOrg(admin, `crq-${tag}`);
  provider = createMemoryProvider("gitlab", ["xdev-team"]);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("hàng “Chờ tôi duyệt” tab Code (FR-018)", () => {
  // Chạy trước: số đếm tính trên cả tổ chức nên chưa được có phiên của test khác.
  it("mine chỉ có PR chờ người gọi quyết; all có mọi phiên người gọi thấy; số đếm khớp", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human({ roles: ["team-member"] })]);
    const team = await openReview(p);
    const own = await openReview(p, u("tmember"));
    const p2 = await newProject();
    await saveWorkflow(p2, [human({ users: [u("loner")] })]);
    const named = await openReview(p2);
    const p3 = await newProject();
    await saveWorkflow(p3, [AI, human({ roles: ["team-member"] })]);
    const auto = await openReview(p3);

    // Người giao việc không tự duyệt (Q2); phiên ở checkpoint AI chưa chờ ai.
    expect(await ids("tmember", { scope: "mine" })).toEqual([team.id]);
    expect(await count("tmember")).toBe(1);
    expect((await ids("tmember", { scope: "all" })).sort()).toEqual([team.id, own.id, named.id, auto.id].sort());
    // Người được chỉ định ngoài đội chỉ thấy phiên có tên mình.
    expect(await ids("loner", { scope: "mine" })).toEqual([named.id]);
    expect(await ids("loner", { scope: "all" })).toEqual([named.id]);
    expect(await count("loner")).toBe(1);
    // Người xem đội thấy nhưng không có gì để quyết; đội khác không thấy gì.
    expect(await ids("tviewer", { scope: "mine" })).toEqual([]);
    expect(await ids("tviewer", { scope: "all" })).toHaveLength(4);
    expect(await ids("oadmin", { scope: "all" })).toEqual([]);
    expect(await count("oadmin")).toBe(0);
    // Quản trị tổ chức quyết được mọi checkpoint người duyệt.
    expect(await count("admin")).toBe(3);

    const [item] = (await list("tmember", { scope: "mine" })).items;
    expect(item).toMatchObject({
      id: team.id,
      project: { id: p.projectId, key: p.key },
      pr: { number: team.pr.number, branch: team.pr.branch, headSha: team.headSha },
      status: "in_review",
      awaitingMe: true,
      gate: { id: "reviewer", kind: "human", index: 0, total: 1, sla: "on-time" },
      addedLines: 3,
      deletedLines: 1,
      changedFiles: 1,
    });

    // Duyệt xong thì rời hàng chờ; lọc theo trạng thái và dự án.
    await sys((tx) =>
      decideCodeReview(tx, u("tadmin"), { id: team.id, headSha: team.headSha, decision: "approve" }, deps),
    );
    expect(await ids("tmember", { scope: "mine" })).toEqual([]);
    expect(await count("tmember")).toBe(0);
    expect(await ids("tmember", { scope: "all", status: "approved" })).toEqual([team.id]);
    expect((await ids("tmember", { scope: "all", projectId: p.projectId })).sort()).toEqual([team.id, own.id].sort());
    expect((await list("tmember", { scope: "all", status: "approved" })).items[0]?.gate).toBeNull();
  });

  it("lọc theo SLA của checkpoint đang chờ", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human({ roles: ["team-member"] })]);
    const [late, soon, ok] = [await openReview(p), await openReview(p), await openReview(p)];
    const due = (id: string, started: string, dueAt: string) =>
      admin.query(
        `update hive.code_review_gate_runs set started_at = now() + $2::interval, due_at = now() + $3::interval
         where review_id = $1`,
        [id, started, dueAt],
      );
    await due(late.id, "-25 hours", "-1 hour");
    await due(soon.id, "-22 hours", "2 hours");
    await due(ok.id, "-1 hour", "23 hours");

    const by = (sla: CodeReviewListInput["sla"]) => ids("tmember", { scope: "mine", projectId: p.projectId, sla });
    expect(await by("overdue")).toEqual([late.id]);
    expect(await by("due-soon")).toEqual([soon.id]);
    expect(await by("on-time")).toEqual([ok.id]);
    const items = (await list("tmember", { scope: "all", projectId: p.projectId })).items;
    expect(Object.fromEntries(items.map((i) => [i.id, i.gate?.sla]))).toEqual({
      [late.id]: "overdue",
      [soon.id]: "due-soon",
      [ok.id]: "on-time",
    });
  });

  it("con trỏ đi hết các trang, không lặp không sót, kể cả phiên cùng thời điểm cập nhật", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human({ roles: ["team-member"] })]);
    const opened: string[] = [];
    for (let i = 0; i < 5; i++) opened.push((await openReview(p)).id);
    // Ba phiên cùng micro giây: chỉ thứ tự theo id phân biệt được.
    await admin.query("update hive.code_reviews set updated_at = '2026-10-01T08:00:00.123456Z' where id = any($1)", [
      opened.slice(0, 3),
    ]);

    for (const scope of ["mine", "all"] as const) {
      const pages = await allPages("tmember", { scope, projectId: p.projectId, limit: 2 });
      expect(pages).toHaveLength(5);
      expect(new Set(pages)).toEqual(new Set(opened));
    }
    const first = await list("tmember", { scope: "all", projectId: p.projectId, limit: 5 });
    expect(first.nextCursor).toBeNull();
    expect(await errorCode(() => list("tmember", { scope: "all", cursor: "khong-hop-le" }))).toBe("BAD_CURSOR");
  });
});

describe("diff của PR (D10)", () => {
  it("lấy từ nhà cung cấp Git, đệm theo head_sha; commit mới thì đọc lại; đội khác không xem được", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human({ roles: ["team-member"] })]);
    const r = await openReview(p);
    const read = { ...deps, filesCache: createFilesCache() };
    const files = (who: string) => sys((tx) => codeReviewFiles(tx, u(who), r.id, read));
    const prFilesCalls = () => provider.calls.filter((c) => c.method === "prFiles").length;

    const before = prFilesCalls();
    const out = await files("tviewer");
    expect(out).toMatchObject({ headSha: r.headSha, truncated: false });
    expect(out.files).toEqual([expect.objectContaining({ path: "src/pay.ts", status: "added", previousPath: null })]);
    expect(await files("tmember")).toEqual(out);
    expect(prFilesCalls()).toBe(before + 1);

    await admin.query("update hive.code_reviews set head_sha = $2 where id = $1", [r.id, "b".repeat(40)]);
    expect((await files("tmember")).headSha).toBe("b".repeat(40));
    expect(prFilesCalls()).toBe(before + 2);

    expect(await errorCode(() => files("oadmin"))).toBe("CODE_REVIEW_NOT_FOUND");
    expect(
      await errorCode(() => sys((tx) => codeReviewFiles(tx, u("tmember"), r.id, { filesCache: createFilesCache() }))),
    ).toBe("SCM_UNAVAILABLE");
  });

  it("đệm hết hạn sau thời gian sống và bỏ mục cũ nhất khi đầy", () => {
    const cache = createFilesCache(1000, 2);
    const v = { headSha: "x", files: [], truncated: false };
    cache.set("a", v);
    cache.set("b", v);
    cache.set("c", v);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBe(v);
    const expired = createFilesCache(-1);
    expired.set("a", v);
    expect(expired.get("a")).toBeUndefined();
  });
});

describe("SC-003: hàng chờ với 1 000 phiên mở", () => {
  it("mine và số đếm trả trong 300 ms (p95)", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human({ roles: ["team-member"] })]);
    const tpl = await openReview(p);
    // Nhân bản phiên mẫu bằng SQL: mở 1 000 PR qua nhà cung cấp giả chỉ làm test chậm, không thêm gì cho phép đo.
    await admin.query(
      `with src as (select * from hive.code_reviews where id = $1),
       made as (
         insert into hive.code_reviews (org_id, team_id, project_id, run_id, workflow_id, workflow_name, phases, options,
           pr_number, pr_url, branch, base_branch, head_sha, requester_user_id, updated_at)
         select org_id, team_id, project_id, gen_random_uuid(), workflow_id, workflow_name, phases, options,
           1000 + n, pr_url, branch || '-' || n, base_branch, head_sha, requester_user_id, now() - n * interval '1 second'
         from src, generate_series(1, 1000) n
         returning id, org_id, head_sha)
       insert into hive.code_review_gate_runs (org_id, review_id, gate_index, gate_id, head_sha, status, due_at)
       select org_id, id, 0, 'reviewer', head_sha, 'waiting', now() + interval '1 day' from made`,
      [tpl.id],
    );
    await admin.query("analyze hive.code_reviews; analyze hive.code_review_gate_runs");

    const time = async (fn: () => Promise<unknown>) => {
      const t = performance.now();
      await fn();
      return performance.now() - t;
    };
    const p95 = async (fn: () => Promise<unknown>) => {
      await fn();
      const runs: number[] = [];
      for (let i = 0; i < 20; i++) runs.push(await time(fn));
      runs.sort((a, b) => a - b);
      return runs[Math.ceil(runs.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    };

    const page = await list("tmember", { scope: "mine", projectId: p.projectId });
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
    expect(await p95(() => list("tmember", { scope: "mine" }))).toBeLessThan(300);
    expect(await p95(() => list("tmember", { scope: "all" }))).toBeLessThan(300);
    expect(await p95(() => count("tmember"))).toBeLessThan(300);
  });
});
