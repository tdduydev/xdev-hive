import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, projectSdlcSettings, type SdlcItemDetail } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { saveDoc } from "../knowledge/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { getBreakdown, saveBreakdown } from "./breakdown.ts";
import { createItem, getItem } from "./items.ts";
import { onBaseline } from "./phases.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let teamC = "";
const p: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };
const key = (k: string) => `${k}${tag}`;

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

async function seedSdlcProject(k: string, teamId: string, systemId: string) {
  return (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId,
      systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: key(k),
      settings: {
        ...defaultProjectSettings(),
        sdlc: projectSdlcSettings.parse({ enabled: true, defaultMode: "speckit", modes: ["speckit", "bugfix"] }),
      },
    })
  ).projectId;
}

const newItem = (modeRef: "speckit" | "bugfix", participants: string[] = []) =>
  as("admin", (tx) =>
    createItem(tx, org.user("admin"), {
      projectId: p.a,
      participants,
      title: "Xuất báo cáo",
      idea: "Xuất báo cáo doanh thu theo tháng ra file CSV cho kế toán.",
      modeRef,
      size: modeRef === "bugfix" ? "S" : "M",
    }),
  );

const docKeyOf = (item: SdlcItemDetail, artifactId: string) => {
  const a = item.artifacts.find((x) => x.artifactId === artifactId);
  if (!a) throw new Error(`thiếu ${artifactId}`);
  return a.docKey;
};

/** Lưu phiên bản kế tiếp rồi báo baseline như `knowledge.finish`. */
async function baseline(docKey: string, content: string) {
  return as("admin", async (tx) => {
    const { rows } = await admin.query(
      "select coalesce(max(v.version), 0)::int as v from hive.doc_versions v join hive.docs d on d.id = v.doc_id where d.key = $1",
      [docKey],
    );
    const doc = await saveDoc(
      tx,
      { kind: "user", userId: org.user("admin") },
      { key: docKey, content, baseVersion: rows[0].v },
    );
    await onBaseline(tx, { docKey, version: doc.version, proposalId: randomUUID(), reviewId: randomUUID() });
    return doc.version;
  });
}

async function itemTasks(itemId: string) {
  const { rows } = await admin.query(
    `select l.slice_key as "sliceKey", l.wave, l.removed, l.project_id as "projectId", l.requirement_ids as "requirementIds",
       t.id, t.key, t.title, t.status, t.checklist, t.source
     from hive.sdlc_item_tasks l join hive.tasks t on t.id = l.task_id where l.item_id = $1 order by l.slice_key`,
    [itemId],
  );
  return rows as {
    sliceKey: string;
    wave: number;
    removed: boolean;
    projectId: string;
    requirementIds: string[];
    id: string;
    key: string;
    title: string;
    status: string;
    checklist: { id: string; done: boolean }[];
    source: Record<string, unknown>;
  }[];
}

const depsOf = async (taskId: string) =>
  (await admin.query("select depends_on_id as id from hive.task_dependencies where task_id = $1", [taskId])).rows.map(
    (r) => r.id as string,
  );

const TASKS_V1 = `# Tasks

## Phase 1: Nền

- [ ] T001 Bảng báo cáo (FR-001)
- [ ] T002 [P] Hàm tổng hợp doanh thu (FR-002)

## Phase 2: Xuất CSV

- [ ] T003 Nút xuất CSV (FR-003) (phụ thuộc T001)
- [ ] T004 Test xuất CSV

## Phase 3: Lịch gửi

- [ ] T005 Gửi báo cáo hằng tháng (phụ thuộc T002)
`;

beforeAll(async () => {
  org = await seedOrg(admin, `sdb-${tag}`);
  teamC = (
    await admin.query("insert into hive.teams (org_id, slug, name) values ($1, 'mobile', 'Mobile') returning id", [
      org.orgId,
    ])
  ).rows[0].id;
  const systemC = (
    await admin.query(
      "insert into hive.systems (org_id, team_id, slug, name) values ($1, $2, 'app', 'App') returning id",
      [org.orgId, teamC],
    )
  ).rows[0].id;
  p.a = await seedSdlcProject("a", org.teamId, org.systemId);
  p.b = await seedSdlcProject("b", org.otherTeamId, org.otherSystemId);
  p.c = await seedSdlcProject("c", teamC, systemC);
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

describe("áp baseline của tài liệu tách việc", () => {
  it("Spec Kit `heading`: ba phần thành ba task có checklist, phụ thuộc, đợt; audit và truy vết", async () => {
    const item = await newItem("speckit");
    await baseline(docKeyOf(item, "tasks"), TASKS_V1);
    const tasks = await itemTasks(item.id);
    expect(tasks.map((t) => [t.sliceKey, t.wave, t.status, t.projectId])).toEqual([
      ["phase-1-nen", 1, "todo", p.a],
      ["phase-2-xuat-csv", 2, "todo", p.a],
      ["phase-3-lich-gui", 2, "todo", p.a],
    ]);
    const [t1, t2, t3] = tasks;
    expect(t1?.checklist.map((c) => c.id)).toEqual(["T001", "T002"]);
    expect(t1?.requirementIds).toEqual(["FR-001", "FR-002"]);
    expect(t1?.source).toMatchObject({ kind: "sdlc", itemId: item.id, sliceKey: "phase-1-nen" });
    expect(await depsOf(t2?.id ?? "")).toEqual([t1?.id]);
    expect(await depsOf(t3?.id ?? "")).toEqual([t1?.id]);
    const { rows: audit } = await admin.query(
      "select data from hive.audit_log where action = 'sdlc.breakdown.apply' and target_id = $1",
      [item.id],
    );
    expect(audit[0]?.data.created).toHaveLength(3);
    const { rows: links } = await admin.query(
      "select requirement_id from hive.sdlc_trace_links where item_id = $1 and kind = 'task' order by requirement_id",
      [item.id],
    );
    expect(links.map((r) => r.requirement_id)).toEqual(["FR-001", "FR-002", "FR-003"]);
    const detail = await as("admin", (tx) => getItem(tx, org.user("admin"), { id: item.id }));
    expect(detail.tasks.map((t) => [t.sliceKey, t.blockedBy.map((b) => b.key)])).toEqual([
      ["phase-1-nen", []],
      ["phase-2-xuat-csv", [t1?.key]],
      ["phase-3-lich-gui", [t1?.key]],
    ]);
  });

  it("duyệt lại: sửa task `todo` giữ dấu xong, huỷ phần bị bỏ còn `todo`, cảnh báo phần bị bỏ đã chạy", async () => {
    const item = await newItem("speckit");
    const docKey = docKeyOf(item, "tasks");
    await baseline(docKey, `${TASKS_V1}\n## Phase 4: Dọn dẹp\n\n- [ ] T006 Xoá cờ cũ\n`);
    const before = await itemTasks(item.id);
    const byKey = (rows: typeof before, k: string) => rows.find((t) => t.sliceKey === k);
    await admin.query(`update hive.tasks set checklist = jsonb_set(checklist, '{0,done}', 'true') where id = $1`, [
      byKey(before, "phase-1-nen")?.id,
    ]);
    await admin.query("update hive.tasks set status = 'running' where id = $1", [byKey(before, "phase-4-don-dep")?.id]);

    const v2 = TASKS_V1.replace("T002 [P] Hàm tổng hợp doanh thu", "T002 [P] Hàm tổng hợp doanh thu theo quý").replace(
      /## Phase 3[\s\S]*$/,
      "## Phase 5: Tài liệu\n\n- [ ] T007 Hướng dẫn dùng\n",
    );
    await baseline(docKey, v2);
    const after = await itemTasks(item.id);
    const p1 = byKey(after, "phase-1-nen");
    expect(p1?.id).toBe(byKey(before, "phase-1-nen")?.id);
    expect(p1?.checklist).toEqual([
      expect.objectContaining({ id: "T001", done: true }),
      expect.objectContaining({ id: "T002", done: false, text: "[P] Hàm tổng hợp doanh thu theo quý (FR-002)" }),
    ]);
    expect(byKey(after, "phase-3-lich-gui")).toMatchObject({ removed: true, status: "cancelled" });
    expect(byKey(after, "phase-4-don-dep")).toMatchObject({ removed: true, status: "running" });
    expect(byKey(after, "phase-5-tai-lieu")).toMatchObject({ removed: false, status: "todo" });
    const detail = await as("admin", (tx) => getItem(tx, org.user("admin"), { id: item.id }));
    expect(detail.warnings).toContain(
      `Task ${byKey(before, "phase-4-don-dep")?.key} đã chạy nhưng bị bỏ khỏi bản tách; giữ lại để xem kết quả.`,
    );
  });

  it("bugfix `single`: một task ở dự án chính, checklist từ tài liệu", async () => {
    const item = await newItem("bugfix");
    await baseline(
      docKeyOf(item, "bugfix"),
      "# Bugfix\n\n## Nguyên nhân\n\nSai múi giờ.\n\n## Cách sửa\n\n- [ ] Đổi sang UTC\n- [ ] Thêm test hồi quy\n",
    );
    const tasks = await itemTasks(item.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.projectId).toBe(p.a);
    expect(tasks[0]?.checklist).toHaveLength(2);
  });

  it("ba dự án: task đúng dự án, phụ thuộc liên dự án", async () => {
    const item = await newItem("speckit", [p.b, p.c]);
    await baseline(
      docKeyOf(item, "tasks"),
      `# Tasks\n\n## Phase 1: API\n\n- [ ] T001 API xuất báo cáo (FR-001)\n\n## Phase 2: Web\n\nDự án: ${key("b")}\n\n- [ ] T002 Màn xuất (phụ thuộc T001)\n\n## Phase 3: Mobile\n\nDự án: ${key("c")}\n\n- [ ] T003 Màn xuất trên app (phụ thuộc T001)\n`,
    );
    const tasks = await itemTasks(item.id);
    expect(tasks.map((t) => [t.sliceKey, t.projectId])).toEqual([
      ["phase-1-api", p.a],
      ["phase-2-web", p.b],
      ["phase-3-mobile", p.c],
    ]);
    const api = tasks[0]?.id;
    expect(await depsOf(tasks[1]?.id ?? "")).toEqual([api]);
    expect(await depsOf(tasks[2]?.id ?? "")).toEqual([api]);
    expect(tasks[1]?.key.startsWith(key("b"))).toBe(true);
  });
});

describe("breakdown.get|save", () => {
  it("đọc bản nháp, lưu bản tách đã sửa thành Markdown trong bản nháp; dự án ngoài hạng mục bị từ chối", async () => {
    const item = await newItem("speckit");
    const view = await as("admin", (tx) => getBreakdown(tx, org.user("admin"), { id: item.id, source: "draft" }));
    expect(view.breakdown?.tasks.length).toBeGreaterThan(0);
    const breakdown = view.breakdown;
    if (!breakdown) throw new Error("không đọc được khuôn");
    const edited = { ...breakdown, tasks: breakdown.tasks.slice(0, 1).map((t) => ({ ...t, title: "Nền dữ liệu" })) };
    const saved = await as("admin", (tx) =>
      saveBreakdown(tx, org.user("admin"), { id: item.id, breakdown: edited, baseRevision: view.revision }),
    );
    expect(saved.revision).toBeGreaterThan(view.revision);
    expect(saved.breakdown?.tasks.map((t) => t.title)).toEqual(["Nền dữ liệu"]);
    expect(
      await errorCode(() =>
        as("admin", (tx) =>
          saveBreakdown(tx, org.user("admin"), {
            id: item.id,
            breakdown: { ...edited, tasks: edited.tasks.map((t) => ({ ...t, project: "khong-co" })) },
            baseRevision: saved.revision,
          }),
        ),
      ),
    ).toBe("SDLC_BREAKDOWN_INVALID");
    expect(
      await errorCode(() =>
        as("admin", (tx) => getBreakdown(tx, org.user("admin"), { id: item.id, source: "baseline" })),
      ),
    ).toBe("SDLC_BREAKDOWN_NO_BASELINE");
  });
});
