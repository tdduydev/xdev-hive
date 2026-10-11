// Webhook GitHub/GitLab đi qua app thật: kiểm chữ ký, chống trùng, ghi delivery, gửi job scm.event, rồi xử lý job.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { defaultProjectSettings, type ProjectSettings } from "@xdev-hive/contracts";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { seedOrg } from "../test/org-fixture.ts";
import { createApp } from "./app.ts";
import { findWebhookTarget, webhookSecretContext } from "./modules/catalog/index.ts";
import { createJobs, createPool, encryptSecret, parseMasterKey, withTenant } from "./modules/platform/index.ts";
import {
  auditScmEvent,
  createScmEventRegistry,
  processScmEventJob,
  registerScmEventWorker,
  SCM_EVENT_QUEUE,
  type ScmEventJob,
  scmEventQueue,
} from "./modules/scm/index.ts";
import { webhookDeliveries } from "./modules/scm/schema.ts";

const { adminUrl, appUrl, jobsUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const jobs = createJobs({ connectionString: jobsUrl, queues: [scmEventQueue], maintenance: false });
const app = createApp({
  config: { port: 0, version: "t", publicUrl: "https://hive.example.com", masterKey },
  pool,
  jobs,
});

const fixture = (path: string) => readFileSync(new URL(`./modules/scm/fixtures/${path}.json`, import.meta.url), "utf8");

type Org = Awaited<ReturnType<typeof seedOrg>>;
let org: Org;
let other: Org;
const gh = { id: "", secret: "" };
const gl = { id: "", secret: "" };
let legacyId = "";
let noSecretId = "";
let otherId = "";

async function connection(o: Org, kind: "github" | "gitlab"): Promise<string> {
  const { rows } = await admin.query(
    `insert into hive.scm_connections (org_id, kind, name, secret_enc, created_by)
     values ($1, $2, $3, 'khong-giai-ma', 'u') returning id`,
    [o.orgId, kind, `${kind}-${randomUUID().slice(0, 6)}`],
  );
  return rows[0].id;
}

/** Seed thẳng bằng superuser: luồng tạo dự án đã có test riêng ở module catalog. */
async function project(
  o: Org,
  conn: string,
  kind: "github" | "gitlab",
  secret: string | null,
  settings: unknown = defaultProjectSettings(),
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into hive.projects (id, org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
       repo_owner, repo_name, state, settings, idempotency_key, webhook_secret_enc, created_by)
     values ($1, $2, $3, $4, $5, $5, $6, $7, 'existing', 'xdev-team', $5, 'active', $8, gen_random_uuid(), $9, 'u')`,
    [
      id,
      o.orgId,
      o.teamId,
      o.systemId,
      `wh-${id.slice(0, 8)}`,
      conn,
      kind,
      JSON.stringify(settings),
      secret ? encryptSecret(masterKey, secret, webhookSecretContext(id)) : null,
    ],
  );
  return id;
}

beforeAll(async () => {
  org = await seedOrg(admin, "wh");
  other = await seedOrg(admin, "wh2");
  await jobs.start();
  const ghConn = await connection(org, "github");
  const glConn = await connection(org, "gitlab");
  const enabled: ProjectSettings = {
    ...defaultProjectSettings(),
    issueIntake: { enabled: true, label: "giao-viec", mention: "hive" },
  };
  gh.secret = randomBytes(32).toString("hex");
  gh.id = await project(org, ghConn, "github", gh.secret, enabled);
  gl.secret = randomBytes(32).toString("hex");
  gl.id = await project(org, glConn, "gitlab", gl.secret);
  // Dự án tạo trước khi settings có issueIntake.
  const { issueIntake: _, ...legacy } = defaultProjectSettings();
  legacyId = await project(org, ghConn, "github", "bi-mat-cu", legacy);
  noSecretId = await project(org, ghConn, "github", null);
  otherId = await project(other, await connection(other, "github"), "github", "bi-mat-to-chuc-khac");
});

afterAll(async () => {
  await jobs.stop();
  await Promise.all([admin.end(), pool.end()]);
});

const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function github(projectId: string, event: string, body: string, opts: { secret?: string; delivery?: string } = {}) {
  return app.request(`/hooks/git/${projectId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": opts.delivery ?? randomUUID(),
      "x-hub-signature-256": sign(opts.secret ?? gh.secret, body),
    },
    body,
  });
}

function gitlab(event: string, body: string, opts: { token?: string; delivery?: string } = {}) {
  return app.request(`/hooks/git/${gl.id}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-event": event,
      "idempotency-key": opts.delivery ?? randomUUID(),
      "x-gitlab-token": opts.token ?? gl.secret,
    },
    body,
  });
}

async function deliveries(deliveryId: string) {
  const { rows } = await admin.query(
    "select id, org_id, project_id, provider, event, status, processed_at, error from hive.webhook_deliveries where delivery_id = $1",
    [deliveryId],
  );
  return rows;
}

async function jobsFor(deliveryRowId: string): Promise<Array<{ data: ScmEventJob }>> {
  const { rows } = await admin.query("select data from pgboss.job where name = $1 and data->>'deliveryRowId' = $2", [
    SCM_EVENT_QUEUE,
    deliveryRowId,
  ]);
  return rows;
}

describe("POST /hooks/git/{projectId}: GitHub", () => {
  it("chữ ký đúng: ghi delivery, gửi job scm.event với sự kiện đã chuẩn hoá, trả 202", async () => {
    const delivery = randomUUID();
    const res = await github(gh.id, "pull_request", fixture("github/pull_request.opened"), { delivery });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ status: "queued", events: ["pull_request.opened"] });

    const [row, ...more] = await deliveries(delivery);
    expect(more).toHaveLength(0);
    expect(row).toMatchObject({
      id: body.deliveryId,
      org_id: org.orgId,
      project_id: gh.id,
      provider: "github",
      event: "pull_request.opened",
      status: "queued",
      processed_at: null,
    });
    const queued = await jobsFor(row.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.data).toMatchObject({
      orgId: org.orgId,
      projectId: gh.id,
      provider: "github",
      intake: { enabled: true, label: "giao-viec", mention: "hive" },
      events: [{ kind: "pull_request.opened", pullRequest: { number: 2, head: "changes", base: "master" } }],
    });
  });

  it("nhận trùng mã giao nhận: 200, không ghi thêm, không gửi thêm job", async () => {
    const delivery = randomUUID();
    const payload = fixture("github/issues.opened");
    expect((await github(gh.id, "issues", payload, { delivery })).status).toBe(202);
    const again = await github(gh.id, "issues", payload, { delivery });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "duplicate" });
    const rows = await deliveries(delivery);
    expect(rows).toHaveLength(1);
    expect(await jobsFor(rows[0].id)).toHaveLength(1);
  });

  it("hai lần gửi trùng cùng lúc: chỉ một lần được ghi", async () => {
    const delivery = randomUUID();
    const payload = fixture("github/push");
    const results = await Promise.all([1, 2, 3].map(() => github(gh.id, "push", payload, { delivery })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 202]);
    expect(await deliveries(delivery)).toHaveLength(1);
  });

  it.each([
    ["secret khác", { secret: "bi-mat-sai" }],
    ["secret của dự án ở tổ chức khác", { secret: "bi-mat-to-chuc-khac" }],
  ])("chữ ký sai (%s): 401, không ghi gì", async (_name, opts) => {
    const delivery = randomUUID();
    const res = await github(gh.id, "pull_request", fixture("github/pull_request.opened"), { ...opts, delivery });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "WEBHOOK_UNAUTHORIZED", message: "Chữ ký webhook không hợp lệ." },
    });
    expect(await deliveries(delivery)).toHaveLength(0);
  });

  it("thân request bị sửa sau khi ký: 401", async () => {
    const body = fixture("github/pull_request.opened");
    const res = await app.request(`/hooks/git/${gh.id}`, {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": sign(gh.secret, body),
      },
      body: body.replace('"number": 2', '"number": 3'),
    });
    expect(res.status).toBe(401);
  });

  it("thiếu chữ ký, hoặc gửi kiểu GitLab tới dự án GitHub: 401", async () => {
    const body = fixture("github/ping");
    const base = { "x-github-event": "ping", "x-github-delivery": randomUUID() };
    const send = (headers: Record<string, string>) =>
      app.request(`/hooks/git/${gh.id}`, { method: "POST", headers, body });
    expect((await send(base)).status).toBe(401);
    expect((await send({ ...base, "x-gitlab-token": gh.secret })).status).toBe(401);
  });

  it("dự án không có, id không phải UUID, dự án chưa bật webhook, dự án tổ chức khác ký bằng secret khác: cùng 401", async () => {
    const body = fixture("github/ping");
    for (const id of [randomUUID(), "khong-phai-uuid", noSecretId]) {
      expect((await github(id, "ping", body)).status).toBe(401);
    }
    expect((await github(otherId, "ping", body)).status).toBe(401);
    expect((await github(otherId, "ping", body, { secret: "bi-mat-to-chuc-khac" })).status).toBe(202);
  });

  it("ping và sự kiện không quan tâm: ghi delivery `ignored`, không gửi job", async () => {
    const delivery = randomUUID();
    const res = await github(gh.id, "ping", fixture("github/ping"), { delivery });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "ignored", events: [] });
    const [row] = await deliveries(delivery);
    expect(row).toMatchObject({ status: "ignored", event: "ping" });
    expect(row.processed_at).not.toBeNull();
    expect(await jobsFor(row.id)).toHaveLength(0);
  });

  it("thiếu mã giao nhận: 400; thân không phải JSON: 400; không ghi gì", async () => {
    const body = fixture("github/ping");
    const noDelivery = await app.request(`/hooks/git/${gh.id}`, {
      method: "POST",
      headers: { "x-github-event": "ping", "x-hub-signature-256": sign(gh.secret, body) },
      body,
    });
    expect(noDelivery.status).toBe(400);
    const delivery = randomUUID();
    const form = "payload=%7B%7D";
    const notJson = await app.request(`/hooks/git/${gh.id}`, {
      method: "POST",
      headers: {
        "x-github-event": "ping",
        "x-github-delivery": delivery,
        "x-hub-signature-256": sign(gh.secret, form),
      },
      body: form,
    });
    expect(notJson.status).toBe(400);
    expect(await deliveries(delivery)).toHaveLength(0);
  });

  it("dự án tạo trước khi có issueIntake: dùng mặc định (tắt, nhãn hive)", async () => {
    const res = await github(legacyId, "issues", fixture("github/issues.opened"), { secret: "bi-mat-cu" });
    expect(res.status).toBe(202);
    const { deliveryId } = await res.json();
    const [job] = await jobsFor(deliveryId);
    expect(job?.data.intake).toEqual({ enabled: false, label: "hive", mention: "hive" });
  });
});

describe("POST /hooks/git/{projectId}: GitLab", () => {
  it("X-Gitlab-Token đúng: 202, job mang sự kiện đã chuẩn hoá", async () => {
    const delivery = randomUUID();
    const res = await gitlab("Merge Request Hook", fixture("gitlab/merge_request.open"), { delivery });
    expect(res.status).toBe(202);
    const [row] = await deliveries(delivery);
    expect(row).toMatchObject({ provider: "gitlab", event: "merge_request.open", status: "queued" });
    const [job] = await jobsFor(row.id);
    expect(job?.data.events).toEqual([
      expect.objectContaining({ kind: "pull_request.opened", pullRequest: expect.objectContaining({ number: 16 }) }),
    ]);
  });

  it("token sai hoặc thiếu: 401, không ghi gì", async () => {
    const delivery = randomUUID();
    expect((await gitlab("Push Hook", fixture("gitlab/push"), { token: "sai", delivery })).status).toBe(401);
    expect((await gitlab("Push Hook", fixture("gitlab/push"), { token: "", delivery })).status).toBe(401);
    expect(await deliveries(delivery)).toHaveLength(0);
  });

  it("nhận trùng Idempotency-Key: 200", async () => {
    const delivery = randomUUID();
    expect((await gitlab("Note Hook", fixture("gitlab/note.issue"), { delivery })).status).toBe(202);
    expect((await gitlab("Note Hook", fixture("gitlab/note.issue"), { delivery })).status).toBe(200);
    expect(await deliveries(delivery)).toHaveLength(1);
  });

  it("mã giao nhận trùng giữa GitHub và GitLab là hai delivery khác nhau", async () => {
    const delivery = randomUUID();
    expect((await gitlab("Push Hook", fixture("gitlab/push"), { delivery })).status).toBe(202);
    expect((await github(gh.id, "push", fixture("github/push"), { delivery })).status).toBe(202);
    expect((await deliveries(delivery)).map((r) => r.provider).sort()).toEqual(["github", "gitlab"]);
  });
});

describe("xử lý job scm.event", () => {
  async function queuedJob(): Promise<ScmEventJob> {
    const p = JSON.parse(fixture("github/issue_comment.created"));
    p.comment.body = "@hive làm giúp issue này";
    const res = await github(gh.id, "issue_comment", JSON.stringify(p));
    const { deliveryId } = await res.json();
    const [job] = await jobsFor(deliveryId);
    if (!job) throw new Error("không có job");
    return job.data;
  }

  it("gọi handler đã đăng ký đúng loại, handler `*` nhận mọi loại; delivery thành processed", async () => {
    const job = await queuedJob();
    const registry = createScmEventRegistry();
    const commented = vi.fn(async () => {});
    const mentioned = vi.fn(async () => {});
    const merged = vi.fn(async () => {});
    const all = vi.fn(async () => {});
    registry.on("issue.commented", commented);
    registry.on("comment.mentioned", mentioned);
    registry.on("pull_request.merged", merged);
    registry.on("*", all);

    expect(await processScmEventJob(pool, registry, job)).toBe("processed");
    expect(commented).toHaveBeenCalledTimes(1);
    expect(commented.mock.calls[0]).toEqual([
      expect.objectContaining({ kind: "issue.commented", issue: expect.objectContaining({ number: 1 }) }),
      expect.objectContaining({ orgId: org.orgId, projectId: gh.id, deliveryRowId: job.deliveryRowId }),
    ]);
    expect(mentioned).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "comment.mentioned", comment: expect.objectContaining({ id: "492700400" }) }),
      expect.anything(),
    );
    expect(merged).not.toHaveBeenCalled();
    expect(all).toHaveBeenCalledTimes(2);
    const { rows } = await admin.query("select status, processed_at from hive.webhook_deliveries where id = $1", [
      job.deliveryRowId,
    ]);
    expect(rows[0].status).toBe("processed");
    expect(rows[0].processed_at).not.toBeNull();

    // pg-boss giao lại job đã xong: không chạy handler lần nữa.
    expect(await processScmEventJob(pool, registry, job)).toBe("skipped");
    expect(all).toHaveBeenCalledTimes(2);
  });

  it("huỷ đăng ký thì handler không còn được gọi", async () => {
    const job = await queuedJob();
    const registry = createScmEventRegistry();
    const handler = vi.fn(async () => {});
    const off = registry.on("*", handler);
    off();
    await processScmEventJob(pool, registry, job);
    expect(handler).not.toHaveBeenCalled();
  });

  it("handler mẫu ghi audit cho từng sự kiện, trong tổ chức của dự án", async () => {
    const job = await queuedJob();
    const registry = createScmEventRegistry();
    registry.on("*", auditScmEvent);
    await processScmEventJob(pool, registry, job);
    const { rows } = await admin.query(
      "select org_id, actor_user_id, action, target_id, data from hive.audit_log where data->>'deliveryRowId' = $1 order by action",
      [job.deliveryRowId],
    );
    expect(rows.map((r) => r.action)).toEqual(["scm.comment.mentioned", "scm.issue.commented"]);
    expect(rows[0]).toMatchObject({
      org_id: org.orgId,
      actor_user_id: null,
      target_id: gh.id,
      data: { provider: "github", repo: "Codertocat/Hello-World", target: "issue", number: 1, commentId: "492700400" },
    });
    // Không chép nội dung bình luận vào nhật ký.
    expect(JSON.stringify(rows)).not.toContain("làm giúp");
  });

  it("handler lỗi: rollback mọi ghi của handler, delivery `failed` kèm lỗi, ném lại để pg-boss thử lại", async () => {
    const job = await queuedJob();
    const registry = createScmEventRegistry();
    registry.on("*", auditScmEvent);
    let fail = true;
    registry.on("comment.mentioned", async () => {
      if (fail) throw new Error("module tasks đang lỗi");
    });
    await expect(processScmEventJob(pool, registry, job)).rejects.toThrow("module tasks đang lỗi");
    const status = async () =>
      (await admin.query("select status, error from hive.webhook_deliveries where id = $1", [job.deliveryRowId]))
        .rows[0];
    expect(await status()).toEqual({ status: "failed", error: "module tasks đang lỗi" });
    const audits = async () =>
      (
        await admin.query("select count(*)::int as n from hive.audit_log where data->>'deliveryRowId' = $1", [
          job.deliveryRowId,
        ])
      ).rows[0].n;
    expect(await audits()).toBe(0);

    fail = false;
    expect(await processScmEventJob(pool, registry, job)).toBe("processed");
    expect(await status()).toEqual({ status: "processed", error: null });
    expect(await audits()).toBe(2);
  });

  it("worker pg-boss nhận job từ webhook và gọi handler", async () => {
    const registry = createScmEventRegistry();
    const seen: string[] = [];
    registry.on("pull_request.merged", async (event, ctx) => {
      seen.push(`${ctx.deliveryRowId}:${event.pullRequest.number}`);
    });
    await registerScmEventWorker(jobs, { pool, registry }, { pollingIntervalSeconds: 0.5 });
    const p = JSON.parse(fixture("github/pull_request.closed"));
    p.pull_request.merged = true;
    const res = await github(gh.id, "pull_request", JSON.stringify(p));
    const { deliveryId } = await res.json();
    await vi.waitFor(() => expect(seen).toContain(`${deliveryId}:2`), { timeout: 15_000, interval: 200 });
    await vi.waitFor(
      async () =>
        expect(
          (await admin.query("select status from hive.webhook_deliveries where id = $1", [deliveryId])).rows[0].status,
        ).toBe("processed"),
      { timeout: 5_000, interval: 200 },
    );
  });
});

describe("RLS webhook_deliveries và tra dự án theo id", () => {
  const RLS_VIOLATION = "42501";
  const FK_VIOLATION = "23503";
  async function pgCode(run: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await run();
      return undefined;
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } };
      return e.cause?.code ?? e.code;
    }
  }
  const row = (orgId: string, projectId: string) => ({
    orgId,
    projectId,
    provider: "github" as const,
    deliveryId: randomUUID(),
    event: "push",
    status: "queued" as const,
  });

  it("không có context thì không thấy delivery nào", async () => {
    await withTenant(pool, {}, async (tx) => {
      expect(await tx.select().from(webhookDeliveries)).toHaveLength(0);
    });
  });

  it("tổ chức chỉ thấy delivery của mình", async () => {
    await withTenant(pool, { orgId: other.orgId }, async (tx) => {
      const rows = await tx.select().from(webhookDeliveries);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.orgId === other.orgId)).toBe(true);
    });
  });

  it("không ghi được delivery cho tổ chức khác, không chuyển được delivery sang tổ chức khác", async () => {
    expect(
      await pgCode(() =>
        withTenant(pool, { orgId: org.orgId }, (tx) => tx.insert(webhookDeliveries).values(row(other.orgId, otherId))),
      ),
    ).toBe(RLS_VIOLATION);
    expect(
      await pgCode(() =>
        withTenant(pool, { orgId: org.orgId }, (tx) =>
          tx.update(webhookDeliveries).set({ orgId: other.orgId }).where(eq(webhookDeliveries.projectId, gh.id)),
        ),
      ),
    ).toBe(RLS_VIOLATION);
  });

  it("delivery không trỏ được tới dự án của tổ chức khác (khoá kép)", async () => {
    expect(
      await pgCode(() =>
        withTenant(pool, { orgId: org.orgId }, (tx) => tx.insert(webhookDeliveries).values(row(org.orgId, otherId))),
      ),
    ).toBe(FK_VIOLATION);
  });

  it("tra theo id chỉ thấy đúng một dự án, chỉ đọc, không thấy delivery", async () => {
    await withTenant(pool, {}, async (tx) => {
      await tx.execute(sql`select set_config('app.webhook_project_id', ${gh.id}, true)`);
      const { rows } = await tx.$client.query("select id, org_id from hive.projects");
      expect(rows).toEqual([{ id: gh.id, org_id: org.orgId }]);
      expect((await tx.$client.query("update hive.projects set name = 'x' returning id")).rowCount).toBe(0);
      expect((await tx.$client.query("delete from hive.projects returning id")).rowCount).toBe(0);
      expect(await tx.select().from(webhookDeliveries)).toHaveLength(0);
    });
    const { rows } = await admin.query("select name from hive.projects where id = $1", [gh.id]);
    expect(rows[0].name).not.toBe("x");
  });

  it("findWebhookTarget giải mã secret đúng dự án; app.webhook_project_id không rò sang lần mượn kết nối sau", async () => {
    expect(await findWebhookTarget(pool, masterKey, gh.id)).toEqual({
      orgId: org.orgId,
      projectId: gh.id,
      provider: "github",
      secret: gh.secret,
      intake: { enabled: true, label: "giao-viec", mention: "hive" },
    });
    expect(await findWebhookTarget(pool, masterKey, noSecretId)).toBeNull();
    expect(await findWebhookTarget(pool, masterKey, randomUUID())).toBeNull();
    const client = await pool.connect();
    try {
      expect((await client.query("select hive.ctx_webhook_project() as p")).rows[0]).toEqual({ p: null });
    } finally {
      client.release();
    }
  });
});
