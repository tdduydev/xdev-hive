// Số truy vấn của các API web gọi khi mở trang chính, trên dữ liệu cỡ vừa (vài nghìn task và run). Trần số truy vấn
// không tăng theo số dòng hay số đội: thêm một vòng lặp hỏi database cho từng đội, từng dòng thì test này hỏng.
// HIVE_PERF_REPORT=<file> ghi thời gian (trung vị), số truy vấn và cỡ kết quả của từng API ra file JSON;
// HIVE_PERF_EXPLAIN=<file> ghi thêm EXPLAIN ANALYZE của từng truy vấn API đã chạy, để tìm chỗ thiếu index.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { createAuth } from "./modules/identity/index.ts";
import { createPool, parseMasterKey, withTenant } from "./modules/platform/index.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
const secret = "test-secret-0123456789abcdef-0123456789";
const publicUrl = "http://hub.test";
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

const TEAMS = 8;
const PROJECTS_PER_TEAM = 2;
const TASKS = 3000;
const RUNS_PER_TASK = 2;
const MACHINES_PER_TEAM = 3;
const MEMBERS = 60;
const DOCS = 300;
const REVIEWS = 120;
const EVENTS = 3000;

let org: OrgFixture & { user: (n: string) => string };
let app: ReturnType<typeof createApp>;
let cookie = "";
let devUserId = "";
const teamIds: string[] = [];
let bigRunId = "";

// Đếm mọi truy vấn đi qua pg (cả pool của hive_app lẫn pool của Better Auth) trong lúc đo.
let counting = false;
let queries = 0;
let seen: { text: string; values?: unknown[] }[] = [];
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
  if (counting) {
    queries++;
    const [q, values] = args as [string | { text: string; values?: unknown[] }, unknown[] | undefined];
    // Drizzle truyền tham số ở đối số thứ hai, kèm config { text, rowMode }.
    const text = typeof q === "string" ? q : q.text;
    seen.push({ text, values: Array.isArray(values) ? values : typeof q === "string" ? [] : (q.values ?? []) });
  }
  return (query as (...a: unknown[]) => unknown).apply(this, args);
} as typeof query;

/** EXPLAIN ANALYZE từng truy vấn đọc của hive_app, trong tenant context của người đang đo như lúc chạy thật. */
async function explain(statements: typeof seen) {
  const plans: { ms: number; sql: string; plan: string }[] = [];
  for (const q of statements) {
    // Vẫn liệt kê lệnh không EXPLAIN được (begin, commit, truy vấn của Better Auth chạy bằng role khác) với -1 ms.
    const rows =
      /^\s*select\b/i.test(q.text) && !/set_config/.test(q.text)
        ? await withTenant(pool, { userId: devUserId, orgId: org.orgId }, async (tx) => {
            const r = await tx.$client.query(`explain (analyze, buffers, format text) ${q.text}`, q.values);
            return r.rows.map((x: Record<string, string>) => x["QUERY PLAN"]);
          }).catch(() => null)
        : null;
    if (!rows) {
      plans.push({ ms: -1, sql: q.text, plan: "" });
      continue;
    }
    const ms = Number(/Execution Time: ([\d.]+)/.exec(rows.at(-1) ?? "")?.[1] ?? 0);
    plans.push({ ms, sql: q.text, plan: rows.join("\n") });
  }
  return plans.sort((a, b) => b.ms - a.ms);
}

async function call(path: string, input?: unknown): Promise<unknown> {
  const res = await app.request(`/rpc/${path}`, {
    method: "POST",
    headers: { cookie, "x-hive-org": org.orgId, "content-type": "application/json" },
    body: JSON.stringify(input === undefined ? {} : { json: input }),
  });
  const body = (await res.json()) as { json: unknown };
  if (res.status !== 200) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
  return body.json;
}

async function measure(path: string, input?: unknown) {
  await call(path, input);
  counting = true;
  queries = 0;
  seen = [];
  const result = await call(path, input);
  counting = false;
  const count = queries;
  const plans = process.env.HIVE_PERF_EXPLAIN ? await explain(seen) : [];
  const times: number[] = [];
  // Thời gian chỉ để đọc báo cáo, không kiểm trong CI (máy CI chạy nhanh chậm thất thường).
  for (let i = 0; i < (process.env.HIVE_PERF_REPORT ? 15 : 0); i++) {
    const start = performance.now();
    await call(path, input);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const ms = times[Math.floor(times.length / 2)] ?? 0;
  const kb = Buffer.byteLength(JSON.stringify(result)) / 1024;
  return { result, queries: count, ms, kb, plans };
}

beforeAll(async () => {
  org = await seedOrg(admin, `pf-${tag}`);
  const auth = createAuth({ pool: authPool, baseURL: publicUrl, secret, allowEmailSignUp: true });
  app = createApp({ config: { port: 0, version: "test", publicUrl }, auth, pool });
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Dev", email: `pf-${tag}@example.com`, password: "mat-khau-du-dai-123" }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  devUserId = ((await res.json()) as { user: { id: string } }).user.id;
  // Thành viên thường của tổ chức, quản trị mọi đội: đường kiểm quyền theo từng đội, không phải lối tắt của admin tổ chức.
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
    org.orgId,
    devUserId,
  ]);

  teamIds.push(org.teamId, org.otherTeamId);
  for (let i = teamIds.length; i < TEAMS; i++) {
    const { rows } = await admin.query("insert into hive.teams (org_id, slug, name) values ($1, $2, $2) returning id", [
      org.orgId,
      `doi-${i}`,
    ]);
    teamIds.push(rows[0].id);
  }
  const projects: { id: string; teamId: string }[] = [];
  for (const [i, teamId] of teamIds.entries()) {
    await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'admin')", [
      teamId,
      org.orgId,
      devUserId,
    ]);
    const { rows } = await admin.query(
      "insert into hive.systems (org_id, team_id, slug, name) values ($1, $2, $3, $3) returning id",
      [org.orgId, teamId, `he-${i}`],
    );
    for (let p = 0; p < PROJECTS_PER_TEAM; p++) {
      const { projectId } = await seedProject(admin, pool, {
        orgId: org.orgId,
        teamId,
        systemId: rows[0].id,
        adminUserId: org.user("admin"),
        masterKey,
        key: `pf-${tag}-${i}-${p}`,
      });
      projects.push({ id: projectId, teamId });
    }
  }

  // Thành viên tổ chức, mỗi người ở một đội.
  await admin.query(
    `insert into auth."user" (id, name, email)
     select 'pf-${tag}-u' || g, 'Người ' || g, 'pf-${tag}-u' || g || '@seed.test' from generate_series(1, $1) g`,
    [MEMBERS],
  );
  await admin.query(
    `insert into hive.org_members (org_id, user_id, role) select $1, 'pf-${tag}-u' || g, 'member' from generate_series(1, $2) g`,
    [org.orgId, MEMBERS],
  );
  await admin.query(
    `insert into hive.team_members (team_id, org_id, user_id, role)
     select ($2::uuid[])[1 + g % array_length($2::uuid[], 1)], $1, 'pf-${tag}-u' || g, 'member' from generate_series(1, $3) g`,
    [org.orgId, teamIds, MEMBERS],
  );

  await admin.query(
    `insert into hive.machines (org_id, team_id, name, os, version, clis, capacity)
     select $1, t, 'may-' || left(t::text, 4) || '-' || g, 'linux', '1', '{claude,codex}', 1
     from unnest($2::uuid[]) t, generate_series(1, $3) g`,
    [org.orgId, teamIds, MACHINES_PER_TEAM],
  );
  const machineIds = (await admin.query("select id from hive.machines where org_id = $1", [org.orgId])).rows.map(
    (r) => r.id as string,
  );

  // Task chia đều cho các dự án; mỗi task vài run cũ dần, trạng thái và máy xoay vòng.
  await admin.query(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, created_by, created_at)
     select $1, (p->>'teamId')::uuid, (p->>'id')::uuid, g, 'pf-' || g, 'Việc số ' || g, 'seed',
       now() - make_interval(mins => g)
     from generate_series(1, $3) g,
       lateral (select $2::jsonb -> (g % jsonb_array_length($2::jsonb))) as x(p)`,
    [org.orgId, JSON.stringify(projects), TASKS],
  );
  await admin.query(
    `insert into hive.runs (org_id, team_id, task_id, project_id, kind, state, branch, policy_snapshot, created_by,
       created_at, cli, machine_id)
     select t.org_id, t.team_id, t.id, t.project_id, 'code',
       (array['succeeded','failed','needs_review','cancelled','no_changes'])[1 + (t.number + r) % 5]::hive.run_state,
       'ai/x', '[]', 'seed', t.created_at + make_interval(secs => r), (array['claude','codex','gemini'])[1 + r % 3],
       ($2::uuid[])[1 + (t.number * 7 + r) % array_length($2::uuid[], 1)]
     from hive.tasks t, generate_series(1, $3) r where t.org_id = $1`,
    [org.orgId, machineIds, RUNS_PER_TASK],
  );
  bigRunId = (
    await admin.query("select id from hive.runs where org_id = $1 order by created_at desc limit 1", [org.orgId])
  ).rows[0].id;
  await admin.query(
    `insert into hive.run_events (org_id, run_id, attempt, seq, type, data)
     select $1, $2, 1, g, 'message', jsonb_build_object('text', repeat('x', 80)) from generate_series(1, $3) g`,
    [org.orgId, bigRunId, EVENTS],
  );
  await admin.query(
    `insert into hive.run_logs (org_id, run_id, attempt, seq, "offset", data)
     select $1, $2, 1, g, g * 200, convert_to(repeat('y', 200), 'UTF8') from generate_series(1, $3) g`,
    [org.orgId, bigRunId, EVENTS],
  );

  // Tài liệu: một phần của tổ chức, phần còn lại chia cho các đội.
  await admin.query(
    `insert into hive.docs (org_id, team_id, key, title, current_version, updated_by_user_id)
     select $1, case when g % 3 = 0 then null else ($2::uuid[])[1 + g % array_length($2::uuid[], 1)] end,
       'org/tai-lieu-' || g, 'Tài liệu ' || g, 1, 'seed'
     from generate_series(1, $3) g`,
    [org.orgId, teamIds, DOCS],
  );
  const phases = JSON.stringify([
    {
      name: "Duyệt",
      outputs: [],
      gates: [
        { id: "ai", name: "AI", kind: "ai", ai: { checks: ["x"], passScore: 70 } },
        {
          id: "nguoi",
          name: "Người duyệt",
          kind: "human",
          reviewers: { users: [devUserId], roles: [], teams: [], quorum: 1 },
        },
      ],
    },
  ]);
  await admin.query(
    `with p as (
       insert into hive.proposals (org_id, kind, target, base_version, content, author_user_id)
       select $1, 'doc', 'org/tai-lieu-' || g, 1, 'Nội dung ' || g, 'pf-${tag}-u' || (1 + g % $3)
       from generate_series(1, $2) g returning id, target, author_user_id
     ), i as (
       insert into hive.review_instances (org_id, proposal_id, workflow_name, phases, doc_key, doc_title, gate_index,
         author_user_id)
       select $1, id, 'Quy trình', $4::jsonb, target, target, 1, author_user_id from p returning id
     )
     insert into hive.review_gate_runs (org_id, instance_id, gate_index, gate_id, status, score)
     select $1, id, 0, 'ai', 'passed', 85 from i
     union all
     select $1, id, 1, 'nguoi', 'waiting', null from i`,
    [org.orgId, REVIEWS, MEMBERS, phases],
  );
  // Thống kê như autovacuum sẽ có trên database thật, để planner chọn plan giống production.
  await admin.query("analyze hive.tasks, hive.runs, hive.run_events, hive.run_logs, hive.docs, hive.review_instances");
}, 180_000);

afterAll(async () => {
  pg.Client.prototype.query = query;
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

/**
 * Trần số truy vấn mỗi request, gồm cả đọc phiên đăng nhập, begin, set_config và commit: số đo được cộng 2 cho chỗ
 * thêm một truy vấn hợp lý. Vượt trần thường là hỏi database theo từng đội, từng dòng (8 đội, 50 dòng một trang).
 */
const cases: { name: string; path: string; input?: () => unknown; max: number; check?: (r: unknown) => void }[] = [
  { name: "me.get", path: "me/get", max: 4 },
  { name: "orgs.mine", path: "orgs/mine", max: 9 },
  { name: "inbox.unreadCount", path: "inbox/unreadCount", max: 9 },
  {
    name: "tasks.list",
    path: "tasks/list",
    input: () => ({}),
    max: 10,
    check: (r) => expect(r).toHaveLength(TASKS),
  },
  {
    name: "runs.latest",
    path: "runs/latest",
    input: () => ({}),
    max: 11,
    check: (r) => expect(r).toHaveLength(TASKS),
  },
  {
    name: "runs.search",
    path: "runs/search",
    input: () => ({ limit: 50 }),
    max: 14,
    check: (r) => expect((r as { items: unknown[] }).items).toHaveLength(50),
  },
  { name: "runs.get", path: "runs/get", input: () => ({ id: bigRunId }), max: 12 },
  {
    name: "runs.events",
    path: "runs/events",
    input: () => ({ id: bigRunId, after: 0, limit: 500 }),
    max: 12,
    check: (r) => expect(r).toHaveLength(500),
  },
  {
    name: "runs.logs",
    path: "runs/logs",
    input: () => ({ id: bigRunId, after: 0, limit: 500 }),
    max: 12,
    check: (r) => expect(r).toHaveLength(500),
  },
  {
    name: "machines.list",
    path: "machines/list",
    input: () => ({ teamId: org.teamId }),
    max: 9,
    check: (r) => expect(r).toHaveLength(MACHINES_PER_TEAM),
  },
  {
    name: "docs.list",
    path: "docs/list",
    input: () => ({}),
    max: 11,
    check: (r) => expect(r).toHaveLength(DOCS),
  },
  {
    name: "reviews.list (mine)",
    path: "reviews/list",
    input: () => ({ scope: "mine" }),
    max: 13,
    check: (r) => expect((r as { items: unknown[] }).items).toHaveLength(50),
  },
  {
    name: "reviews.list (all)",
    path: "reviews/list",
    input: () => ({ scope: "all" }),
    max: 13,
    check: (r) => expect((r as { items: unknown[] }).items).toHaveLength(50),
  },
  {
    name: "orgMembers.list",
    path: "orgMembers/list",
    max: 10,
    check: (r) => expect((r as unknown[]).length).toBeGreaterThanOrEqual(MEMBERS),
  },
  { name: "teams.list", path: "teams/list", max: 9, check: (r) => expect(r).toHaveLength(TEAMS) },
  {
    name: "projects.list",
    path: "projects/list",
    input: () => ({}),
    max: 10,
    check: (r) => expect(r).toHaveLength(TEAMS * PROJECTS_PER_TEAM),
  },
];

describe("hiệu năng API của các trang chính", () => {
  const report: Record<string, { queries: number; ms: number; kb: number }> = {};
  const explained: Record<string, Awaited<ReturnType<typeof explain>>> = {};

  for (const c of cases) {
    it(`${c.name}: không quá ${c.max} truy vấn`, async () => {
      const { result, queries: n, ms, kb, plans } = await measure(c.path, c.input?.());
      explained[c.name] = plans;
      c.check?.(result);
      report[c.name] = { queries: n, ms: Math.round(ms * 10) / 10, kb: Math.round(kb * 10) / 10 };
      expect(n).toBeLessThanOrEqual(c.max);
    });
  }

  it("JSON lớn trả về đã nén gzip; luồng SSE của run thì không", async () => {
    const res = await app.request("/rpc/tasks/list", {
      method: "POST",
      headers: { cookie, "x-hive-org": org.orgId, "content-type": "application/json", "accept-encoding": "gzip" },
      body: JSON.stringify({ json: {} }),
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const zipped = Buffer.from(await res.arrayBuffer());
    const json = gunzipSync(zipped).toString();
    expect((JSON.parse(json) as { json: unknown[] }).json).toHaveLength(TASKS);
    expect(zipped.length).toBeLessThan(json.length / 5);

    const stream = await app.request(`/api/v1/runs/${bigRunId}/stream`, {
      headers: { cookie, "x-hive-org": org.orgId, "accept-encoding": "gzip" },
    });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.headers.get("content-encoding")).toBeNull();
    await stream.body?.cancel();
  });

  afterAll(() => {
    if (process.env.HIVE_PERF_REPORT) writeFileSync(process.env.HIVE_PERF_REPORT, JSON.stringify(report, null, 2));
    if (process.env.HIVE_PERF_EXPLAIN) {
      const text = Object.entries(explained).flatMap(([name, plans]) => [
        `## ${name}`,
        ...plans.map((p) => `### ${p.ms} ms\n${p.sql}\n${p.plan}\n`),
      ]);
      writeFileSync(process.env.HIVE_PERF_EXPLAIN, text.join("\n"));
    }
  });
});
