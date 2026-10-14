import { randomBytes, randomUUID } from "node:crypto";
import { type ChatAction, workflowInput } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { type DecideDeps, startCodeReview } from "../codereview/index.ts";
import { createPool, parseMasterKey, withTenant } from "../platform/index.ts";
import { createMemoryProvider } from "../scm/index.ts";
import { createBot, findChatBot, type ResolvedBot } from "./bots.ts";
import { handleAction } from "./commands.ts";
import type { ChatDeps } from "./deps.ts";
import { installChatHooks } from "./hooks.ts";
import { deliverOutbox } from "./outbox.ts";
import { messageLimiter } from "./rate-limit.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const provider = createMemoryProvider("gitlab", ["xdev-team"]);
const publicUrl = "https://hive.example.com";
const reviewDeps: DecideDeps = { masterKey, providerFactory: () => provider, publicUrl };
const deps: ChatDeps = { pool, masterKey, publicUrl, codeReviews: reviewDeps };
let org: OrgFixture & { user: (n: string) => string };
let bot: ResolvedBot;
const u = (name: string) => org.user(name);

beforeAll(async () => {
  org = await seedOrg(admin, `chatcode-${randomUUID()}`);
  const created = await withTenant(pool, { orgId: org.orgId, userId: u("admin") }, (tx) =>
    createBot(tx, masterKey, u("admin"), {
      name: "code",
      config: { kind: "telegram", botToken: "123456:ABCdefGhIJKlmnOPQrstUVwxyz0123456789" },
    }),
  );
  const found = await findChatBot(pool, masterKey, created.id);
  if (!found) throw new Error("Không tìm thấy bot.");
  bot = found;
  for (const [id, user] of [
    ["1", "tadmin"],
    ["2", "tmember"],
    ["3", "tviewer"],
  ]) {
    await admin.query(
      "insert into hive.chat_links (org_id, bot_id, user_id, external_user_id, chat_id, events) values ($1, $2, $3, $4, $4, '{code_review.awaiting,code_review.overdue}')",
      [org.orgId, bot.id, u(user ?? ""), id],
    );
  }
});
beforeEach(() => {
  messageLimiter.reset();
  installChatHooks({ publicUrl });
});
afterAll(async () => {
  installChatHooks(undefined);
  await Promise.all([admin.end(), pool.end()]);
});

async function waiting(gates = 1, quorum = 1) {
  const key = `chatcr-${randomUUID().slice(0, 8)}`;
  const project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: u("admin"),
    masterKey,
    key,
  });
  const ref = { owner: project.owner, name: project.repo };
  provider.seedRepo(ref);
  const branch = "ai/chat";
  await provider.commitFiles(ref, {
    branch,
    fromBranch: "main",
    message: "code",
    files: [{ path: "a.ts", content: "export const a = 1;" }],
  });
  const pr = await provider.openPR(ref, { head: branch, base: "main", title: "Code", body: "" });
  const headSha = (await provider.getPR(ref, pr.number))?.headSha ?? "";
  const workflow = workflowInput.parse({
    name: key,
    preset: "custom",
    subject: "code",
    teamId: org.teamId,
    docPrefixes: [],
    enabled: true,
    code: { projects: [key], merge: "manual" },
    phases: [
      {
        name: "Review",
        gates: Array.from({ length: gates }, (_, i) => ({
          id: `human${i}`,
          name: `Người duyệt ${i}`,
          kind: "human",
          onReject: "author",
          slaHours: 1,
          reviewers: { users: [u("tadmin"), u("tmember")], roles: [], quorum, allowRequester: false },
        })),
      },
    ],
  });
  await admin.query(
    "insert into hive.review_workflows (org_id, team_id, name, preset, subject, doc_prefixes, code, phases, enabled) values ($1, $2, $3, 'custom', 'code', '{}', $4, $5, true)",
    [org.orgId, org.teamId, key, JSON.stringify(workflow.code), JSON.stringify(workflow.phases)],
  );
  const review = await withTenant(pool, { orgId: org.orgId }, (tx) =>
    startCodeReview(
      tx,
      {
        id: randomUUID(),
        teamId: org.teamId,
        projectId: project.projectId,
        taskId: null,
        ownerUserId: u("tmember"),
        taskType: "feature",
        headSha,
        pr: { number: pr.number, url: pr.url, branch, baseBranch: "main" },
        stats: null,
        reasons: [],
      },
      reviewDeps,
    ),
  );
  if (!review) throw new Error("Không mở được phiên.");
  return { review, ref, branch };
}

async function outbox(reviewId: string) {
  const { rows } = await admin.query<{ id: string; body: string; actions: ChatAction[] }>(
    "select o.id, o.body, o.actions from hive.chat_outbox o join hive.chat_links l on l.id = o.link_id where o.org_id = $1 and l.external_user_id = '1' and o.actions @> $2::jsonb order by o.created_at desc limit 1",
    [org.orgId, JSON.stringify([{ reviewId }])],
  );
  if (!rows[0]) throw new Error("Không có thông báo chat.");
  return rows[0];
}
const press = (id: string, index = 0, user = "1", d = deps) =>
  handleAction(d, bot, { externalUserId: user, chatType: "private", data: `o:${id}:${index}` });
const state = async (id: string) =>
  (await admin.query("select status, gate_index, route from hive.code_reviews where id = $1", [id])).rows[0];

describe("checkpoint code review qua chat", () => {
  it("fan-out có SHA và nút; người nhận duyệt qua đúng hàm và ghi cả hai audit", async () => {
    const { review } = await waiting();
    const msg = await outbox(review.id);
    expect(msg.body).toContain(review.headSha);
    expect(msg.actions).toMatchObject([
      { kind: "code_review.approve", headSha: review.headSha, reviewId: review.id },
      { kind: "code_review.changes", headSha: review.headSha, reviewId: review.id },
    ]);
    const sent: Record<string, unknown>[] = [];
    expect(
      await deliverOutbox(
        {
          ...deps,
          fetch: async (_url, init) => {
            sent.push(JSON.parse(String(init?.body)));
            return Response.json({ ok: true, result: {} });
          },
        },
        { orgId: org.orgId, outboxId: msg.id },
      ),
    ).toBe("sent");
    expect(JSON.stringify(sent[0])).toContain("Duyệt code");
    const result = await press(msg.id);
    expect(result.ok).toBe(true);
    expect(result.messages[0]?.text).toContain(review.headSha);
    expect(await state(review.id)).toMatchObject({ status: "approved" });
    const { rows } = await admin.query(
      "select action from hive.audit_log where org_id = $1 and actor_user_id = $2 and (target_id = $3 or data->>'outboxId' = $4)",
      [org.orgId, u("tadmin"), review.id, msg.id],
    );
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["codereview.approve", "chat.action"]));
    expect((await press(msg.id)).ok).toBe(false);
  });

  it("nút cũ không duyệt checkpoint tiếp theo trên cùng SHA", async () => {
    const { review } = await waiting(2);
    const msg = await outbox(review.id);
    expect((await press(msg.id)).ok).toBe(true);
    expect(await state(review.id)).toMatchObject({ status: "in_review", gate_index: 1 });
    const stale = await press(msg.id);
    expect(stale.ok).toBe(false);
    expect(stale.messages[0]?.text).toContain("Checkpoint đã thay đổi");
    const next = await outbox(review.id);
    expect(next.id).not.toBe(msg.id);
    expect((await press(next.id)).ok).toBe(true);
    expect(await state(review.id)).toMatchObject({ status: "approved" });
  });

  it("SHA nhà cung cấp đã đổi nhưng webhook chưa tới thì từ chối", async () => {
    const { review, ref, branch } = await waiting();
    const msg = await outbox(review.id);
    const { sha } = await provider.commitFiles(ref, {
      branch,
      message: "new",
      files: [{ path: "a.ts", content: "export const a = 2;" }],
    });
    provider.setPull(ref, review.prNumber, { headSha: sha });
    const result = await press(msg.id);
    expect(result.ok).toBe(false);
    expect(result.messages[0]?.text).toContain("commit mới");
    expect(await state(review.id)).toMatchObject({ status: "in_review" });
  });

  it("từ chối tài khoản khác, người giao việc, thành viên mất quyền và người rời tổ chức", async () => {
    const { review } = await waiting();
    const msg = await outbox(review.id);
    expect((await press(msg.id, 0, "2")).messages[0]?.text).toContain("không dành cho tài khoản");
    // Nút dành cho người giao việc vẫn không vượt điều kiện allowRequester=false.
    const { rows } = await admin.query(
      "insert into hive.chat_outbox (org_id, link_id, kind, body, actions) select $1, id, 'command', 'Duyệt code', $2 from hive.chat_links where bot_id = $3 and external_user_id = '2' returning id",
      [org.orgId, JSON.stringify(msg.actions), bot.id],
    );
    expect((await press(rows[0].id, 0, "2")).ok).toBe(false);
    await admin.query(
      "update hive.code_reviews set phases = jsonb_set(phases, '{0,gates,0,reviewers,users}', $2::jsonb) where id = $1",
      [review.id, JSON.stringify([u("tviewer")])],
    );
    const denied = await press(msg.id);
    expect(denied.ok).toBe(false);
    expect(denied.messages[0]?.text).toContain("không phải người duyệt");
    await admin.query("update hive.org_members set status = 'pending' where org_id = $1 and user_id = $2", [
      org.orgId,
      u("tadmin"),
    ]);
    try {
      expect((await press(msg.id)).ok).toBe(false);
      expect(await state(review.id)).toMatchObject({ status: "in_review" });
    } finally {
      await admin.query("update hive.org_members set status = 'active' where org_id = $1 and user_id = $2", [
        org.orgId,
        u("tadmin"),
      ]);
    }
  });

  it("trả lại theo hướng checkpoint và quorum không hoàn tất trước khi đủ người", async () => {
    const { review } = await waiting();
    const msg = await outbox(review.id);
    expect((await press(msg.id, 1)).ok).toBe(true);
    expect(await state(review.id)).toMatchObject({ status: "changes_requested", route: "author" });
    const second = await waiting(1, 2);
    const pending = await outbox(second.review.id);
    expect((await press(pending.id)).ok).toBe(true);
    expect(await state(second.review.id)).toMatchObject({ status: "in_review" });
    expect((await press(pending.id)).ok).toBe(false);
  });
});
