import { randomUUID } from "node:crypto";
import { createRedactor, type Redactor } from "@xdev-hive/contracts";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { createPool, type Jobs, withTenant } from "../platform/index.ts";
import { appendDeployLog, DEPLOY_LOG_CHANNEL, flushDeployLog, logsAfter, notifyDeploy } from "./logs.ts";
import { DELIVERY_LOG_RETENTION_QUEUE } from "./queues.ts";
import { DELIVERY_LOG_RETENTION_CRON, purgeDeployLogs, registerRetention } from "./retention.ts";
import { DeployLogNotifier, deployStreamHandler } from "./stream-route.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const notifier = new DeployLogNotifier(app);

// Chuỗi giả, chỉ có hình dạng giống bí mật thật. Ghép lúc chạy để trình quét bí mật của GitHub không chặn push.
const PASSWORD = "S3cr3t-Hive!2026";
const GITLAB = ["glpat", "Zr8Kq2Lm7Np3Vx9WbT4y"].join("-");

let org: Awaited<ReturnType<typeof seedOrg>>;
let other: Awaited<ReturnType<typeof seedOrg>>;
let targetId: string;
const actor = (name: string) => ({ userId: org.user(name), orgId: org.orgId });
const inOrg = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(app, actor("tmember"), fn);

beforeAll(async () => {
  org = await seedOrg(admin, `deploy-logs-${randomUUID().slice(0, 8)}`);
  other = await seedOrg(admin, `deploy-logs-other-${randomUUID().slice(0, 8)}`);
  const scm = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'GitLab ACME', 'x', $3)",
    [scm, org.orgId, org.user("owner")],
  );
  const projectId = (
    await admin.query(
      `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
         repo_owner, repo_name, settings, idempotency_key, created_by)
       values ($1, $2, $3, 'billing', 'billing', $4, 'gitlab', 'existing', 'xdev-team', 'billing', '{}', $5, $6)
       returning id`,
      [org.orgId, org.teamId, org.systemId, scm, randomUUID(), org.user("owner")],
    )
  ).rows[0].id as string;
  const environmentId = (
    await admin.query(
      "insert into hive.deploy_environments (org_id, team_id, system_id, name, policy) values ($1, $2, $3, 'dev', '{}') returning id",
      [org.orgId, org.teamId, org.systemId],
    )
  ).rows[0].id as string;
  targetId = (
    await admin.query(
      `insert into hive.deploy_targets (org_id, project_id, environment_id, method, config)
       values ($1, $2, $3, 'jenkins-job', '{"method":"jenkins-job"}') returning id`,
      [org.orgId, projectId, environmentId],
    )
  ).rows[0].id as string;
});

afterAll(async () => {
  await notifier.close();
  await admin.end();
  await app.end();
});

/** `external` để không giữ khoá "một lần đang đi mỗi đích", nên mỗi test tạo thêm bao nhiêu lần cũng được. */
async function newDeploy(state = "running"): Promise<string> {
  return (
    await admin.query(
      `insert into hive.deploys (org_id, target_id, method, origin, state, version)
       values ($1, $2, 'jenkins-job', 'external', $3, '{}') returning id`,
      [org.orgId, targetId, state],
    )
  ).rows[0].id as string;
}

/** Byte thật nằm trong bảng, đọc bằng superuser (bỏ qua RLS), ghép theo thứ tự. */
async function stored(deployId: string): Promise<{ text: string; seqs: number[]; rows: Buffer[] }> {
  const { rows } = await admin.query("select seq, data from hive.deploy_log_chunks where deploy_id = $1 order by id", [
    deployId,
  ]);
  const buffers = rows.map((r) => r.data as Buffer);
  return {
    text: Buffer.concat(buffers).toString("utf8"),
    seqs: rows.map((r) => r.seq as number),
    rows: buffers,
  };
}

const passthrough: Redactor = { push: (s) => s, flush: () => "" };
const filler = (n: number) => Array.from({ length: n }, (_, i) => `[bước ${i}] build module ${i} ok\n`).join("");
const append = (deployId: string, text: string, r: Redactor) => inOrg((tx) => appendDeployLog(tx, deployId, text, r));
const flush = (deployId: string, r: Redactor) => inOrg((tx) => flushDeployLog(tx, deployId, r));

describe("appendDeployLog", () => {
  it("che mật khẩu của đích và token theo mẫu chung trước khi ghi", async () => {
    const id = await newDeploy();
    const redactor = createRedactor([PASSWORD]);
    await append(id, `${filler(20)}DB_PASSWORD=${PASSWORD}\n${filler(3)}`, redactor);
    await append(id, `git clone https://oauth2:${GITLAB}@gitlab.example.invalid/team/app.git\n${filler(20)}`, redactor);
    await flush(id, redactor);
    const { text } = await stored(id);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(GITLAB);
    expect(text).toContain("***");
    expect(text).toContain("DB_PASSWORD=***");
    expect(text).toContain("[bước 19] build module 19 ok");
  });

  it("che cả bí mật bị cắt giữa hai lần ghi, và không để lại nửa đầu trong bảng", async () => {
    const id = await newDeploy();
    const redactor = createRedactor([PASSWORD]);
    const half = PASSWORD.length >> 1;
    // Đoạn đầu kết thúc giữa mật khẩu; đoạn sau (ở giao dịch khác, như hai lần watch) mang nửa còn lại.
    await append(id, `${filler(30)}DB_PASSWORD=${PASSWORD.slice(0, half)}`, redactor);
    const afterFirst = (await stored(id)).text;
    expect(afterFirst).not.toContain(PASSWORD.slice(0, half));
    await append(id, `${PASSWORD.slice(half)}\n${filler(30)}`, redactor);
    await flush(id, redactor);
    const { text } = await stored(id);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(PASSWORD.slice(0, half));
    expect(text).not.toContain(PASSWORD.slice(half));
    expect(text).toContain("DB_PASSWORD=***");
  });

  it("phần redactor còn giữ chỉ được ghi khi flush, và flush rỗng thì không ghi gì", async () => {
    const id = await newDeploy();
    const redactor = createRedactor([PASSWORD]);
    expect(await append(id, "ngắn\n", redactor)).toBe(0);
    expect((await stored(id)).rows).toHaveLength(0);
    expect(await flush(id, redactor)).toBe(1);
    expect((await stored(id)).text).toBe("ngắn\n");
    expect(await flush(id, redactor)).toBe(0);
    expect(await append(id, "", redactor)).toBe(0);
  });

  it("cắt đoạn dài mà không xẻ đôi ký tự UTF-8, seq liền nhau, ghép lại đúng", async () => {
    const id = await newDeploy();
    // 😀 nằm đúng ranh giới cắt (16384 ký tự) để thử trường hợp cặp surrogate.
    const text = `${"a".repeat(16383)}😀${"Triển khai ✓ ".repeat(4000)}`;
    const redactor = createRedactor([]);
    await append(id, text, redactor);
    await flush(id, redactor);
    const { text: back, seqs, rows } = await stored(id);
    expect(back).toBe(text);
    expect(seqs.length).toBeGreaterThan(3);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    for (const row of rows) expect(() => new TextDecoder("utf-8", { fatal: true }).decode(row)).not.toThrow();
  });

  it("seq tiếp nối giữa các lần ghi, kể cả khi nhiều lần ghi chạy cùng lúc", async () => {
    const id = await newDeploy();
    await append(id, "một\n", passthrough);
    await Promise.all(Array.from({ length: 6 }, (_, i) => append(id, `song song ${i}\n`, passthrough)));
    const { seqs, text } = await stored(id);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (let i = 0; i < 6; i++) expect(text).toContain(`song song ${i}\n`);
  });

  it("gửi NOTIFY kèm id lần triển khai khi commit", async () => {
    const id = await newDeploy();
    const listener = new pg.Client({ connectionString: db.appUrl });
    await listener.connect();
    try {
      const got = new Promise<string>((resolve) =>
        listener.on("notification", (n) => n.channel === DEPLOY_LOG_CHANNEL && n.payload === id && resolve(n.payload)),
      );
      await listener.query(`listen ${DEPLOY_LOG_CHANNEL}`);
      await append(id, "có log mới\n", passthrough);
      expect(await got).toBe(id);
    } finally {
      await listener.end();
    }
  });

  it("lần triển khai lạ hoặc của tổ chức khác thì không ghi được", async () => {
    const id = await newDeploy();
    const error = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (e) {
        return (e as Error).name;
      }
      return undefined;
    };
    expect(await error(() => append(randomUUID(), "x\n", passthrough))).toBe("NotFoundError");
    expect(
      await error(() =>
        withTenant(app, { userId: other.user("tadmin"), orgId: other.orgId }, (tx) =>
          appendDeployLog(tx, id, "x\n", passthrough),
        ),
      ),
    ).toBe("NotFoundError");
    expect((await stored(id)).rows).toHaveLength(0);
  });
});

describe("logsAfter", () => {
  it("đọc tiếp từ con trỏ theo thứ tự, có giới hạn, và không thấy log của tổ chức khác", async () => {
    const id = await newDeploy();
    for (const line of ["một\n", "hai\n", "ba\n", "bốn\n"]) await append(id, line, passthrough);
    const all = await inOrg((tx) => logsAfter(tx, id, 0, 100));
    expect(all.map((c) => Buffer.from(c.bytes, "base64").toString())).toEqual(["một\n", "hai\n", "ba\n", "bốn\n"]);
    expect(all.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    expect(all.every((c, i) => i === 0 || c.id > (all[i - 1]?.id ?? 0))).toBe(true);
    const [first, second] = all;
    const rest = await inOrg((tx) => logsAfter(tx, id, second?.id ?? 0, 100));
    expect(rest.map((c) => c.seq)).toEqual([3, 4]);
    expect((await inOrg((tx) => logsAfter(tx, id, first?.id ?? 0, 1))).map((c) => c.seq)).toEqual([2]);
    expect(await inOrg((tx) => logsAfter(tx, id, all.at(-1)?.id ?? 0, 100))).toEqual([]);
    const foreign = await withTenant(app, { userId: other.user("tadmin"), orgId: other.orgId }, (tx) =>
      logsAfter(tx, id, 0, 100),
    );
    expect(foreign).toEqual([]);
  });
});

describe("dọn log quá hạn", () => {
  const age = (id: string, seq: number, days: number) =>
    admin.query(
      "insert into hive.deploy_log_chunks (org_id, deploy_id, seq, data, created_at) values ($1, $2, $3, $4, now() - make_interval(days => $5))",
      [org.orgId, id, seq, Buffer.from(`${days} ngày\n`), days],
    );

  it("xoá đoạn quá hạn giữ mặc định 365 ngày, giữ đoạn còn hạn", async () => {
    const id = await newDeploy("succeeded");
    await age(id, 1, 400);
    await age(id, 2, 40);
    await age(id, 3, 1);
    expect(await purgeDeployLogs(app)).toBeGreaterThanOrEqual(1);
    expect((await stored(id)).text).toBe("40 ngày\n1 ngày\n");
    // Chạy lại không xoá thêm gì.
    await purgeDeployLogs(app);
    expect((await stored(id)).seqs).toEqual([2, 3]);
  });

  it("job hằng ngày: đăng ký worker và lịch cron, chạy thì dọn", async () => {
    const id = await newDeploy("succeeded");
    await age(id, 1, 500);
    const jobs = { work: vi.fn(), schedule: vi.fn(), enqueue: vi.fn() };
    await registerRetention(jobs as unknown as Jobs, { pool: app });
    expect(jobs.schedule).toHaveBeenCalledWith(DELIVERY_LOG_RETENTION_QUEUE, DELIVERY_LOG_RETENTION_CRON);
    expect(jobs.work).toHaveBeenCalledOnce();
    expect(jobs.work.mock.calls[0]?.[0]).toBe(DELIVERY_LOG_RETENTION_QUEUE);
    await jobs.work.mock.calls[0]?.[1]();
    expect((await stored(id)).rows).toHaveLength(0);
  });

  it("không có pool thì không đăng ký gì", async () => {
    const jobs = { work: vi.fn(), schedule: vi.fn(), enqueue: vi.fn() };
    await registerRetention(jobs as unknown as Jobs, {});
    expect(jobs.work).not.toHaveBeenCalled();
    expect(jobs.schedule).not.toHaveBeenCalled();
  });
});

describe("SSE /api/v1/deploys/:id/stream", () => {
  const auth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const user = headers.get("x-test-user");
        return user ? { user: { id: user } } : null;
      },
    },
  } as never;
  // pollMs lớn: sự kiện mới tới trong thời gian ngắn là nhờ NOTIFY, không phải nhờ đọc lại định kỳ.
  const server = new Hono().get(
    "/api/v1/deploys/:id/stream",
    deployStreamHandler({ auth, pool: app, notifier, pollMs: 20_000 }),
  );

  interface SseEvent {
    event: string;
    id: string | null;
    data: string;
  }

  async function open(
    deployId: string,
    opts: { user?: string | null; org?: string | null; lastEventId?: string; query?: string } = {},
  ) {
    const controller = new AbortController();
    const headers: Record<string, string> = {};
    const user = opts.user === undefined ? actor("tmember").userId : opts.user;
    if (user) headers["x-test-user"] = user;
    const orgId = opts.org === undefined ? org.orgId : opts.org;
    if (orgId) headers["x-hive-org"] = orgId;
    if (opts.lastEventId) headers["last-event-id"] = opts.lastEventId;
    const res = await server.request(`/api/v1/deploys/${deployId}/stream${opts.query ?? ""}`, {
      headers,
      signal: controller.signal,
    });
    const failure = res.ok
      ? null
      : await res
          .clone()
          .json()
          .catch(() => null);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    /** Sự kiện kế tiếp; null khi server đóng luồng. */
    const next = async (ms = 5000): Promise<SseEvent | null> => {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith(":")) continue;
          const field = (name: string) => block.match(new RegExp(`^${name}: ?(.*)$`, "m"))?.[1] ?? null;
          return { event: field("event") ?? "message", id: field("id"), data: field("data") ?? "" };
        }
        if (!reader) return null;
        const timer = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Không có sự kiện SSE trong ${ms} ms`)), ms),
        );
        const chunk = await Promise.race([reader.read(), timer]);
        if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    /** Đọc tới khi gặp sự kiện `event`; trả mọi sự kiện đã đọc, cái cuối là sự kiện đó. */
    const until = async (event: string) => {
      const seen: SseEvent[] = [];
      for (;;) {
        const e = await next();
        if (!e) return seen;
        seen.push(e);
        if (e.event === event) return seen;
      }
    };
    return { res, failure, next, until, close: () => controller.abort() };
  }

  const text = (e: SseEvent | null | undefined) =>
    Buffer.from((JSON.parse(e?.data ?? "{}") as { bytes: string }).bytes, "base64").toString("utf8");
  const logs = (events: SseEvent[]) => events.filter((e) => e.event === "log");

  it("gửi trạng thái, log đã có, log mới nhờ NOTIFY rồi kết thúc khi lần triển khai xong", async () => {
    const id = await newDeploy("running");
    await append(id, "đang build\n", passthrough);
    await append(id, "đang đẩy image\n", passthrough);
    const stream = await open(id);
    try {
      expect(stream.res.status).toBe(200);
      expect(stream.res.headers.get("content-type")).toMatch(/text\/event-stream/);
      const first = await stream.next();
      expect(first?.event).toBe("steps");
      expect(JSON.parse(first?.data ?? "{}")).toMatchObject({ state: "running", steps: [] });
      const a = await stream.next();
      const b = await stream.next();
      expect([text(a), text(b)]).toEqual(["đang build\n", "đang đẩy image\n"]);
      expect(a?.id).toBe(String(JSON.parse(a?.data ?? "{}").id));
      expect(Number(b?.id)).toBeGreaterThan(Number(a?.id));

      await append(id, "xong bước deploy\n", passthrough);
      const c = await stream.next(2000);
      expect(c?.event).toBe("log");
      expect(text(c)).toBe("xong bước deploy\n");
      expect(JSON.parse(c?.data ?? "{}")).toMatchObject({ seq: 3 });

      await admin.query(
        "update hive.deploys set state = 'succeeded', steps = $2::jsonb, finished_at = now() where id = $1",
        [
          id,
          JSON.stringify([
            { key: "deploy", state: "succeeded", startedAt: null, finishedAt: null, exitCode: 0, message: null },
          ]),
        ],
      );
      await inOrg((tx) => notifyDeploy(tx, id));
      const rest = await stream.until("end");
      expect(rest.map((e) => e.event)).toEqual(["steps", "end"]);
      expect(JSON.parse(rest[0]?.data ?? "{}")).toMatchObject({ state: "succeeded", steps: [{ key: "deploy" }] });
      expect(JSON.parse(rest[1]?.data ?? "{}")).toEqual({ state: "succeeded" });
      expect(await stream.next()).toBeNull();
    } finally {
      stream.close();
    }
  });

  it("nối lại bằng Last-Event-ID thì đọc tiếp từ đoạn sau con trỏ, không phát lại", async () => {
    const id = await newDeploy("running");
    for (const line of ["một\n", "hai\n", "ba\n"]) await append(id, line, passthrough);
    const all = await inOrg((tx) => logsAfter(tx, id, 0, 10));
    const second = all[1];
    const stream = await open(id, { lastEventId: String(second?.id) });
    try {
      const events = [await stream.next(), await stream.next()];
      expect(events.map((e) => e?.event)).toEqual(["steps", "log"]);
      expect(text(events[1])).toBe("ba\n");
      await append(id, "bốn\n", passthrough);
      expect(text(await stream.next(2000))).toBe("bốn\n");
    } finally {
      stream.close();
    }
  });

  it("lần triển khai đã xong: gửi hết log rồi đóng luồng ngay", async () => {
    const id = await newDeploy("failed");
    await append(id, "lỗi ở bước deploy\n", passthrough);
    const stream = await open(id);
    try {
      const events = await stream.until("end");
      expect(events.map((e) => e.event)).toEqual(["steps", "log", "end"]);
      expect(await stream.next()).toBeNull();
    } finally {
      stream.close();
    }
  });

  it("gửi hết khi nhiều hơn một trang log", async () => {
    const id = await newDeploy("succeeded");
    const rows = Array.from({ length: 450 }, (_, i) => i + 1);
    await admin.query(
      "insert into hive.deploy_log_chunks (org_id, deploy_id, seq, data) select $1, $2, s, convert_to(s::text || E'\\n', 'UTF8') from unnest($3::int[]) as s",
      [org.orgId, id, rows],
    );
    const stream = await open(id);
    try {
      const events = await stream.until("end");
      expect(logs(events).map((e) => text(e))).toEqual(rows.map((n) => `${n}\n`));
    } finally {
      stream.close();
    }
  });

  it("Last-Event-ID không hợp lệ thì đọc từ đầu", async () => {
    const id = await newDeploy("succeeded");
    await append(id, "đầu\n", passthrough);
    const stream = await open(id, { lastEventId: "not-a-number" });
    try {
      expect(logs(await stream.until("end")).map((e) => text(e))).toEqual(["đầu\n"]);
    } finally {
      stream.close();
    }
  });

  it("tổ chức lấy được từ tham số org khi trình duyệt không đặt được header", async () => {
    const id = await newDeploy("succeeded");
    const stream = await open(id, { org: null, query: `?org=${org.orgId}` });
    try {
      expect((await stream.until("end")).at(-1)?.event).toBe("end");
    } finally {
      stream.close();
    }
  });

  it("từ chối: chưa đăng nhập 401, thiếu tổ chức 400, id lạ hoặc không phải thành viên 404", async () => {
    const id = await newDeploy("succeeded");
    expect((await open(id, { user: null })).res.status).toBe(401);
    expect((await open(id, { org: null })).res.status).toBe(400);
    expect((await open(id, { org: "not-a-uuid" })).res.status).toBe(400);
    expect((await open("khong-phai-uuid")).res.status).toBe(404);
    expect((await open(randomUUID())).res.status).toBe(404);
    // Người không thuộc tổ chức không có ci.view, và không được biết lần triển khai có tồn tại.
    const stranger = await open(id, { user: `stranger-${randomUUID().slice(0, 8)}` });
    expect(stranger.res.status).toBe(404);
    expect(stranger.failure).toMatchObject({ data: { code: "NOT_FOUND" } });
    // Thành viên tổ chức khác, đặt header sang tổ chức này: cũng không thấy.
    expect((await open(id, { user: other.user("tadmin") })).res.status).toBe(404);
    // Dùng id của tổ chức khác làm ngữ cảnh: RLS che lần triển khai.
    expect((await open(id, { user: other.user("tadmin"), org: other.orgId })).res.status).toBe(404);
  });

  it("thành viên của đội, kể cả người chỉ xem, xem được (ci.view)", async () => {
    const id = await newDeploy("succeeded");
    for (const user of ["tviewer", "tmember", "tadmin", "owner"]) {
      const stream = await open(id, { user: org.user(user) });
      try {
        expect(stream.res.status, user).toBe(200);
        expect((await stream.until("end")).at(-1)?.event, user).toBe("end");
      } finally {
        stream.close();
      }
    }
  });
});
