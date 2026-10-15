import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, projectSdlcSettings, type SdlcItemDetail } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { saveDoc, type TraceRequest } from "../knowledge/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createItem } from "./items.ts";
import { onBaseline } from "./phases.ts";
import { reviewSpecFor } from "./prompt.ts";
import { ruleContext, traceFor } from "./review-hooks.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let projectId = "";

const req = (docKey: string, content: string): TraceRequest => ({
  userId: org.user("admin"),
  docKey,
  content,
  projectId: null,
});

const as = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { userId: org.user("admin"), orgId: org.orgId }, fn);

const SPEC = `# Spec

## Yêu cầu

- **FR-001**: Hệ thống MUST xuất CSV.
  - Tiêu chí chấp nhận: file có cột ngày và số tiền.
- **FR-002**: Hệ thống MUST tổng hợp theo tháng.
- **FR-003**: Hệ thống MUST chạy theo lịch.
`;

const TASKS = `# Tasks

## Phase 1: A

- [ ] T001 Bảng (FR-001)

## Phase 2: B

- [ ] T002 Hàm (FR-002)

## Phase 3: C

- [ ] T003 Xuất CSV (FR-001) (phụ thuộc T001)
`;

/** Spec đã baseline (nguồn requirement) và bản tách đã baseline để có task nối requirement. */
async function seedItem() {
  const item: SdlcItemDetail = await as((tx) =>
    createItem(tx, org.user("admin"), {
      projectId,
      title: "Xuất báo cáo",
      idea: "Xuất báo cáo doanh thu theo tháng ra file CSV cho kế toán.",
      modeRef: "speckit",
      size: "M",
    }),
  );
  const docOf = (artifactId: string) => item.artifacts.find((a) => a.artifactId === artifactId)?.docKey ?? "";
  const spec = docOf("spec");
  const tasks = docOf("tasks");
  await as(async (tx) => {
    const s = await saveDoc(
      tx,
      { kind: "user", userId: org.user("admin") },
      { key: spec, content: SPEC, baseVersion: 0 },
    );
    // Đặt thẳng baseline của spec: chỉ cần nguồn requirement, không cần chạy chuyển giai đoạn của onBaseline.
    await tx.execute(
      sql`update hive.sdlc_artifacts set baseline_version = ${s.version}, approval = 'human' where doc_key = ${spec}`,
    );
  });
  await as(async (tx) => {
    const doc = await saveDoc(
      tx,
      { kind: "user", userId: org.user("admin") },
      { key: tasks, content: TASKS, baseVersion: 0 },
    );
    await onBaseline(tx, { docKey: tasks, version: doc.version, proposalId: randomUUID(), reviewId: randomUUID() });
  });
  return { item, spec, tasks };
}

async function question(itemId: string, phaseId: string, status: string) {
  await admin.query(
    `insert into hive.sdlc_questions (org_id, item_id, phase_id, round, position, text, status)
     values ($1, $2, $3, 1, 0, 'Định dạng ngày?', $4)`,
    [org.orgId, itemId, phaseId, status],
  );
}

async function taskKeys(itemId: string): Promise<Record<string, string>> {
  const { rows } = await admin.query(
    `select l.slice_key, t.key from hive.sdlc_item_tasks l join hive.tasks t on t.id = l.task_id
     where l.item_id = $1`,
    [itemId],
  );
  return Object.fromEntries(rows.map((r) => [r.slice_key, r.key]));
}

beforeAll(async () => {
  org = await seedOrg(admin, `srh-${tag}`);
  projectId = (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: `rh${tag}`,
      settings: {
        ...defaultProjectSettings(),
        sdlc: projectSdlcSettings.parse({ enabled: true, defaultMode: "speckit", modes: ["speckit"] }),
      },
    })
  ).projectId;
});

beforeEach(async () => {
  await admin.query("delete from hive.sdlc_items where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.tasks where org_id = $1", [org.orgId]);
  for (const table of ["doc_drafts", "docs"])
    await admin.query(`delete from hive.${table} where org_id = $1`, [org.orgId]);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("ruleContext", () => {
  it("đếm câu hỏi mở của đúng giai đoạn; bản tách có requirement từ spec baseline", async () => {
    const { item, spec, tasks } = await seedItem();
    await question(item.id, "tasks", "open");
    await question(item.id, "tasks", "answered");
    await question(item.id, "specify", "open");
    await question(item.id, "specify", "open");

    const forTasks = await as((tx) => ruleContext(tx, tasks));
    expect(forTasks?.openQuestions).toBe(1);
    expect(forTasks?.breakdown).toMatchObject({
      decomposition: { phase: "tasks", artifact: "tasks" },
      context: { homeProject: `rh${tag}`, projects: [`rh${tag}`] },
      requirements: ["FR-001", "FR-002", "FR-003"],
    });

    // Spec không phải tài liệu tách việc: luật breakdown/coverage không có đầu vào.
    const forSpec = await as((tx) => ruleContext(tx, spec));
    expect(forSpec).toEqual({ openQuestions: 2, breakdown: undefined });
  });

  it("tài liệu không thuộc hạng mục thì trả null như hook chưa cài", async () => {
    expect(await as((tx) => ruleContext(tx, `wiki/${tag}`))).toBeNull();
  });
});

describe("traceFor", () => {
  it("nối requirement với task của bản tách; bỏ task đã huỷ và liên kết đã gỡ", async () => {
    const { item, spec } = await seedItem();
    const keys = await taskKeys(item.id);
    const trace = await as((tx) => traceFor(tx, req(spec, SPEC)));
    expect(trace?.map((r) => [r.id, r.tasks.map((t) => t.key).sort()])).toEqual([
      ["FR-001", [keys["phase-1-a"], keys["phase-3-c"]].sort()],
      ["FR-002", [keys["phase-2-b"]]],
      ["FR-003", []],
    ]);
    expect(trace?.[0]?.text).toContain("xuất CSV");

    await admin.query(
      `update hive.tasks set status = 'cancelled'
       where id = (select task_id from hive.sdlc_item_tasks where item_id = $1 and slice_key = 'phase-1-a')`,
      [item.id],
    );
    await admin.query("update hive.sdlc_item_tasks set removed = true where item_id = $1 and slice_key = 'phase-2-b'", [
      item.id,
    ]);
    const after = await as((tx) => traceFor(tx, req(spec, SPEC)));
    expect(after?.map((r) => r.tasks.map((t) => t.key))).toEqual([[keys["phase-3-c"]], [], []]);
  });

  it("trả null khi tài liệu không thuộc hạng mục hoặc không nêu requirement", async () => {
    const { spec } = await seedItem();
    expect(await as((tx) => traceFor(tx, req(`wiki/${tag}`, SPEC)))).toBeNull();
    expect(await as((tx) => traceFor(tx, req(spec, "# Spec\n\nChưa có yêu cầu.")))).toBeNull();
  });
});

describe("reviewSpecFor", () => {
  it("requirement của task kèm câu chữ và tiêu chí từ spec baseline, tài liệu đã duyệt; task ngoài hạng mục thì null", async () => {
    const { item, spec } = await seedItem();
    const { rows } = await admin.query(
      "select slice_key, task_id from hive.sdlc_item_tasks where item_id = $1 order by slice_key",
      [item.id],
    );
    const got = await as((tx) => reviewSpecFor(tx, rows[0].task_id));
    expect(got).toMatchObject({
      item: `${item.ref} · Xuất báo cáo`,
      requirements: [
        {
          id: "FR-001",
          text: expect.stringContaining("xuất CSV"),
          acceptance: [expect.stringContaining("cột ngày")],
        },
      ],
    });
    expect(got?.docs).toContainEqual({ name: "spec.md", docKey: spec, version: 1 });
    expect(await as((tx) => reviewSpecFor(tx, randomUUID()))).toBeNull();
  });
});
