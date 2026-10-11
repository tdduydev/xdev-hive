// projects.updateSettings: vá một phần, quyền, khoá lạ, sửa song song, RLS giữa hai tổ chức.
import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, type ProjectSettingsPatch, projectSettingsPatch } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { updateProjectSettings } from "./settings.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

type Org = OrgFixture & { user: (n: string) => string };
let org: Org;
let other: Org;

beforeAll(async () => {
  org = await seedOrg(admin, `ps-${tag}`);
  other = await seedOrg(admin, `ps-o-${tag}`);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

let seq = 0;
async function newProject(
  o: Org = org,
  teamId = o.teamId,
  systemId = o.systemId,
): Promise<{ id: string; key: string }> {
  seq += 1;
  const key = `ps${seq}-${tag}`;
  const p = await seedProject(admin, app, {
    orgId: o.orgId,
    teamId,
    systemId,
    adminUserId: o.user("admin"),
    masterKey,
    key,
  });
  return { id: p.projectId, key };
}

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>, o: Org = org) =>
  withTenant(app, { userId: o.user(who), orgId: o.orgId }, fn);
const update = (who: string, key: string, patch: ProjectSettingsPatch, o: Org = org) =>
  as(who, (tx) => updateProjectSettings(tx, o.user(who), key, patch), o);
const stored = async (id: string) =>
  (await admin.query("select settings from hive.projects where id = $1", [id])).rows[0].settings;

describe("projects.updateSettings: vá một phần", () => {
  it("bật merge queue, đặt ngân sách và CLI mặc định; trường khác giữ nguyên", async () => {
    const p = await newProject();
    const after = await update("tadmin", p.key, {
      merge: { mode: "auto", method: "rebase" },
      features: { mergeQueue: true },
      budget: { perRunUsd: 5, perTaskUsd: 20, maxTurns: 80 },
      defaultCli: "claude",
    });
    const base = defaultProjectSettings();
    const expected = {
      ...base,
      merge: { mode: "auto", requiredApprovals: base.merge.requiredApprovals, method: "rebase" },
      features: { ...base.features, mergeQueue: true },
      budget: { perRunUsd: 5, perTaskUsd: 20, maxTurns: 80 },
      defaultCli: "claude",
    };
    expect(after).toEqual(expected);
    expect(await stored(p.id)).toEqual(expected);
  });

  it("null bỏ cấu hình; budget rỗng thì bỏ hẳn; byType null xoá loại task", async () => {
    const p = await newProject();
    await update("tadmin", p.key, { merge: { method: "merge" }, budget: { perRunUsd: 3, maxTurns: 10 } });
    const a = await update("tadmin", p.key, { merge: { method: null }, budget: { perRunUsd: null } });
    expect(a.merge.method).toBeUndefined();
    expect(a.budget).toEqual({ maxTurns: 10 });
    const b = await update("tadmin", p.key, { budget: { maxTurns: null }, outcome: { byType: { research: null } } });
    expect(b.budget).toBeUndefined();
    expect(Object.keys(b.outcome.byType)).toEqual(["docs"]);
    expect(await stored(p.id)).not.toHaveProperty("budget");
  });

  it("quản trị tổ chức và chủ sở hữu đổi được dự án của mọi đội", async () => {
    const p = await newProject();
    expect((await update("admin", p.key, { features: { planMode: true } })).features.planMode).toBe(true);
    expect((await update("owner", p.key, { features: { planMode: false } })).features.planMode).toBe(false);
  });

  it("ghi audit với giá trị trước và sau của mục được vá", async () => {
    const p = await newProject();
    await update("tadmin", p.key, { features: { mergeQueue: true }, budget: { maxTurns: 50 } });
    const { rows } = await admin.query(
      "select actor_user_id, data from hive.audit_log where action = 'project.settings.update' and target_id = $1",
      [p.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe(org.user("tadmin"));
    expect(rows[0].data.key).toBe(p.key);
    expect(rows[0].data.before).toEqual({ features: defaultProjectSettings().features, budget: null });
    expect(rows[0].data.after).toEqual({
      features: { ...defaultProjectSettings().features, mergeQueue: true },
      budget: { maxTurns: 50 },
    });
  });

  it("dự án lưu trước khi có issueIntake vẫn vá được và được điền mặc định", async () => {
    const p = await newProject();
    await admin.query("update hive.projects set settings = settings - 'issueIntake' where id = $1", [p.id]);
    const after = await update("tadmin", p.key, { issueIntake: { enabled: true } });
    expect(after.issueIntake).toEqual({ enabled: true, label: "hive", mention: "hive" });
  });
});

describe("projects.updateSettings: quyền", () => {
  it.each([
    ["tmember", "TEAM_ROLE_REQUIRED"],
    ["tviewer", "TEAM_ROLE_REQUIRED"],
    ["oadmin", "PROJECT_NOT_FOUND"],
    ["loner", "PROJECT_NOT_FOUND"],
  ])("%s bị từ chối (%s), settings không đổi", async (who, code) => {
    const p = await newProject();
    const before = await stored(p.id);
    expect(await errorCode(() => update(who, p.key, { features: { mergeQueue: true } }))).toBe(code);
    expect(await stored(p.id)).toEqual(before);
  });

  it("key không có thì PROJECT_NOT_FOUND", async () => {
    expect(await errorCode(() => update("owner", `khong-co-${tag}`, { features: { sandbox: true } }))).toBe(
      "PROJECT_NOT_FOUND",
    );
  });
});

describe("projects.updateSettings: kiểm dữ liệu", () => {
  it.each<[string, unknown]>([
    ["khoá lạ ở gốc", { mergeQueue: true }],
    ["khoá lạ trong features", { features: { mergeQueu: true } }],
    ["khoá lạ trong merge", { merge: { auto: true } }],
    ["khoá lạ trong budget", { budget: { perRunUSD: 1 } }],
    ["khoá lạ trong bước kiểm", { outcome: { default: [{ check: "changes", maxFile: 3 }] } }],
    ["bản vá rỗng", {}],
    ["requiredApprovals ngoài khoảng", { merge: { requiredApprovals: 7 } }],
    ["ngân sách âm", { budget: { perRunUsd: -1 } }],
    ["maxTurns không nguyên", { budget: { maxTurns: 1.5 } }],
    ["CLI lạ", { defaultCli: "cursor" }],
    ["tắt bằng null trường bắt buộc", { features: { mergeQueue: null } }],
  ])("từ chối %s", (_, patch) => {
    expect(projectSettingsPatch.safeParse(patch).success).toBe(false);
  });

  it("settings đang lưu sai thì báo SETTINGS_INVALID, vá đúng trường hỏng thì sửa được", async () => {
    const p = await newProject();
    await admin.query(
      "update hive.projects set settings = jsonb_set(settings, '{merge,requiredApprovals}', '99') where id = $1",
      [p.id],
    );
    expect(await errorCode(() => update("tadmin", p.key, { features: { sandbox: true } }))).toBe("SETTINGS_INVALID");
    expect((await stored(p.id)).features.sandbox).toBe(false);
    const fixed = await update("tadmin", p.key, { merge: { requiredApprovals: 2 }, features: { sandbox: true } });
    expect([fixed.merge.requiredApprovals, fixed.features.sandbox]).toEqual([2, true]);
  });
});

describe("projects.updateSettings: sửa song song", () => {
  it("người sau chờ khoá dòng rồi vá lên bản mới, không ghi đè trường của người trước", async () => {
    const p = await newProject();
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let firstDone!: () => void;
    const firstWritten = new Promise<void>((r) => {
      firstDone = r;
    });
    const first = as("tadmin", async (tx) => {
      const s = await updateProjectSettings(tx, org.user("tadmin"), p.key, { features: { mergeQueue: true } });
      firstDone();
      await hold;
      return s;
    });
    await firstWritten;
    let secondFinished = false;
    const second = update("admin", p.key, { budget: { maxTurns: 30 } }).then((s) => {
      secondFinished = true;
      return s;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(secondFinished).toBe(false);
    release();
    await first;
    const s = await second;
    expect(s.features.mergeQueue).toBe(true);
    expect(s.budget).toEqual({ maxTurns: 30 });
    const saved = await stored(p.id);
    expect([saved.features.mergeQueue, saved.budget]).toEqual([true, { maxTurns: 30 }]);
  });
});

describe("projects.updateSettings: RLS", () => {
  it("chủ sở hữu tổ chức khác không đọc hay sửa được dự án, kể cả khi biết key", async () => {
    const p = await newProject();
    const before = await stored(p.id);
    expect(await errorCode(() => update("owner", p.key, { features: { mergeQueue: true } }, other))).toBe(
      "PROJECT_NOT_FOUND",
    );
    expect(await stored(p.id)).toEqual(before);
    // Bỏ qua lớp nghiệp vụ, gọi thẳng SQL bằng hive_app trong tenant của tổ chức khác: RLS không cho thấy hay sửa.
    const { seen, updated } = await as(
      "owner",
      async (tx) => {
        const read = await tx.execute(sql`select id from hive.projects where id = ${p.id}`);
        const write = await tx.execute(
          sql`update hive.projects set settings = settings || '{"budget":{"maxTurns":1}}' where id = ${p.id} returning id`,
        );
        return { seen: read.rows.length, updated: write.rows.length };
      },
      other,
    );
    expect([seen, updated]).toEqual([0, 0]);
    expect(await stored(p.id)).toEqual(before);
  });

  it("thiếu tenant context thì không thấy dự án", async () => {
    const p = await newProject();
    const n = await withTenant(app, { orgId: randomUUID() }, async (tx) => {
      const r = await tx.execute(sql`select id from hive.projects where id = ${p.id}`);
      return r.rows.length;
    });
    expect(n).toBe(0);
  });
});
