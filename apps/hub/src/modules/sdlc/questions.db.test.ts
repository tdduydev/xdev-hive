import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, projectSdlcSettings } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createItem } from "./items.ts";
import type { SdlcDeps } from "./phases.ts";
import {
  answerQuestions,
  askQuestions,
  countQuestions,
  listQuestions,
  QUESTION_REMIND_MS,
  remindOpenQuestions,
} from "./questions.ts";
import { withStepRuns } from "./steps.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let projectId = "";
const deps: SdlcDeps = withStepRuns({ createSdlcRun: async () => ({ runId: randomUUID() }) });

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);
const system = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId }, fn);
const list = (who: string, over: Record<string, unknown> = {}) =>
  as(who, (tx) => listQuestions(tx, org.user(who), { scope: "mine", openOnly: true, limit: 50, ...over }));

beforeAll(async () => {
  org = await seedOrg(admin, `sdq-${tag}`);
  projectId = (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: `q${tag}`,
      settings: {
        ...defaultProjectSettings(),
        sdlc: projectSdlcSettings.parse({ enabled: true, defaultMode: "speckit" }),
      },
    })
  ).projectId;
});

beforeEach(async () => {
  await admin.query("delete from hive.sdlc_items where org_id = $1", [org.orgId]);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

/** Hạng mục của `who` với bước soạn đang chạy và `n` câu hỏi agent vừa gửi. */
async function itemWithQuestions(who: string, n: number, title = "Hoàn tiền một phần") {
  const item = await as(who, (tx) =>
    createItem(
      tx,
      org.user(who),
      {
        projectId,
        title,
        idea: "Cho phép hoàn tiền một phần cho đơn đã thanh toán, có ghi lý do và lịch sử.",
        modeRef: "speckit",
        size: "M",
      },
      deps,
    ),
  );
  const { rows } = await admin.query("select run_id from hive.sdlc_steps where item_id = $1", [item.id]);
  const asked = await system((tx) =>
    askQuestions(tx, rows[0].run_id, {
      questions: Array.from({ length: n }, (_, i) => ({ text: `${title} câu ${i + 1}?`, recommended: "Có" })),
    }),
  );
  return { item, ids: asked.ids };
}

describe("danh sách câu hỏi", () => {
  it("mine/all, lọc hạng mục, trang theo con trỏ, đếm; người ngoài đội không thấy", async () => {
    const a = await itemWithQuestions("tmember", 3, "Hoàn tiền");
    const b = await itemWithQuestions("tadmin", 2, "Đổi địa chỉ");

    const mine = await list("tmember");
    expect(mine.items.map((q) => q.text)).toEqual(["Hoàn tiền câu 1?", "Hoàn tiền câu 2?", "Hoàn tiền câu 3?"]);
    expect(mine.items[0]).toMatchObject({ itemId: a.item.id, item: { title: "Hoàn tiền" }, status: "open", round: 1 });
    expect((await list("tmember", { scope: "all" })).items).toHaveLength(5);
    expect((await list("tmember", { scope: "all", itemId: b.item.id })).items).toHaveLength(2);
    expect(await as("tmember", (tx) => countQuestions(tx, org.user("tmember")))).toEqual({ open: 3 });

    const page1 = await list("tmember", { scope: "all", limit: 2 });
    expect(page1.items).toHaveLength(2);
    const page2 = await list("tmember", { scope: "all", limit: 2, cursor: page1.nextCursor });
    const page3 = await list("tmember", { scope: "all", limit: 2, cursor: page2.nextCursor });
    expect(page3.nextCursor).toBeNull();
    const all = [...page1.items, ...page2.items, ...page3.items].map((q) => q.id);
    expect(new Set(all).size).toBe(5);
    expect(await errorCode(() => list("tmember", { cursor: "rác" }))).toBe("BAD_CURSOR");

    // SC-013: quản trị đội khác không thấy câu hỏi của hạng mục đội này.
    expect((await list("oadmin", { scope: "all" })).items).toEqual([]);
    expect(await as("oadmin", (tx) => countQuestions(tx, org.user("oadmin")))).toEqual({ open: 0 });
  });
});

describe("trả lời", () => {
  it("dùng đề xuất, trả lời lại bị từ chối, câu của hạng mục khác không nhận, người xem không trả lời được", async () => {
    const { item, ids } = await itemWithQuestions("tmember", 2);
    const other = await itemWithQuestions("tmember", 1, "Việc khác");
    const [q1, q2] = ids as [string, string];
    const out = await as("tmember", (tx) =>
      answerQuestions(tx, org.user("tmember"), { itemId: item.id, answers: [{ id: q1, useRecommended: true }] }, deps),
    );
    expect(out[0]).toMatchObject({ status: "answered", answer: "Có", usedRecommended: true });
    expect(out[0]?.answeredBy?.userId).toBe(org.user("tmember"));
    expect(
      await errorCode(() =>
        as("tmember", (tx) =>
          answerQuestions(tx, org.user("tmember"), { itemId: item.id, answers: [{ id: q1, answer: "Không" }] }, deps),
        ),
      ),
    ).toBe("SDLC_QUESTION_CLOSED");
    expect(
      await errorCode(() =>
        as("tmember", (tx) =>
          answerQuestions(
            tx,
            org.user("tmember"),
            { itemId: item.id, answers: [{ id: other.ids[0] as string, answer: "x" }] },
            deps,
          ),
        ),
      ),
    ).toBe("SDLC_QUESTION_NOT_FOUND");
    expect(
      await errorCode(() =>
        as("tviewer", (tx) =>
          answerQuestions(tx, org.user("tviewer"), { itemId: item.id, answers: [{ id: q2, answer: "x" }] }, deps),
        ),
      ),
    ).toBe("SDLC_FORBIDDEN");
    const { rows } = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'sdlc.question.answer' and target_id = $2",
      [org.orgId, item.id],
    );
    expect(rows[0]?.data).toMatchObject({ questions: [q1], recommended: [q1] });
  });
});

describe("nhắc câu hỏi quá hạn", () => {
  it("nhắc chủ hạng mục một lần mỗi 3 ngày", async () => {
    const { item } = await itemWithQuestions("tmember", 2);
    // Database dùng chung với file test khác chạy song song: chỉ xét dòng của tổ chức này.
    const remindedAt = async () =>
      (
        await admin.query("select reminded_at from hive.sdlc_questions where item_id = $1 order by position", [item.id])
      ).rows.map((r) => (r.reminded_at as Date | null)?.toISOString() ?? null);
    const later = new Date(Date.now() + QUESTION_REMIND_MS + 60_000);
    await remindOpenQuestions({ pool: app }, new Date());
    expect(await remindedAt()).toEqual([null, null]);
    await remindOpenQuestions({ pool: app }, later);
    expect(await remindedAt()).toEqual([later.toISOString(), later.toISOString()]);
    const inbox = await admin.query(
      "select title from hive.inbox_items where org_id = $1 and user_id = $2 and event = 'sdlc.question' and title like '%quá 3 ngày%'",
      [org.orgId, org.user("tmember")],
    );
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0]?.title).toContain("2 câu hỏi");
    // Lượt sau trong cùng 3 ngày không nhắc lại.
    await remindOpenQuestions({ pool: app }, new Date(later.getTime() + 3_600_000));
    expect(await remindedAt()).toEqual([later.toISOString(), later.toISOString()]);
  });
});
