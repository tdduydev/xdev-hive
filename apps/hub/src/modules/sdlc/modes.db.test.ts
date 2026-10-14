import { randomBytes, randomUUID } from "node:crypto";
import {
  DEFAULT_AGENT_POLICY,
  reviewGate,
  SDLC_PRESETS,
  type SdlcMode,
  type SdlcModeSaveInput,
  sdlcMode,
} from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { saveAgentPolicy } from "../governance/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { dryRunMode, listModes, removeMode, resolveMode, saveMode } from "./modes.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

type Fixture = OrgFixture & { user: (n: string) => string };
let org: Fixture;
let projectKey = "";
let projectId = "";

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

const speckit = SDLC_PRESETS.speckit as SdlcMode;

/** Bản sao speckit đủ để lưu, có sửa `edit` trước khi parse lại (parse điền mặc định và kiểm luật chế độ). */
function definition(slug: string, edit: (m: SdlcMode) => void = () => undefined): SdlcMode {
  const m = structuredClone(speckit);
  m.id = slug;
  m.name = `Chế độ ${slug}`;
  edit(m);
  return sdlcMode.parse(m);
}

let n = 0;
const slugOf = () => `mode-${tag}-${++n}`;

function input(over: Partial<SdlcModeSaveInput> & { edit?: (m: SdlcMode) => void } = {}): SdlcModeSaveInput {
  const slug = over.slug ?? slugOf();
  const { edit, ...rest } = over;
  return {
    teamId: org.teamId,
    slug,
    basePreset: "speckit",
    definition: definition(slug, edit),
    enabled: true,
    ...rest,
  };
}

const save = (who: string, over: Parameters<typeof input>[0] = {}) =>
  as(who, (tx) => saveMode(tx, org.user(who), input(over)));

/** `sdlc_items` chèn bằng superuser: tạo hạng mục là việc của T012, test này chỉ cần dòng để đếm và để đọc bản chụp. */
async function seedItem(slug: string, number: number, status = "active") {
  const { rows } = await admin.query(
    `insert into hive.sdlc_items (org_id, team_id, project_id, number, slug, title, idea, source, mode_ref, mode,
       settings, size, status, owner_user_id, created_by)
     values ($1, $2, $3, $4, $5, 'Hạng mục', 'Ý tưởng đủ dài để qua kiểm tra', '{"kind":"manual"}', $6, $7, '{}', 'M',
       $8, $9, $9) returning id`,
    [
      org.orgId,
      org.teamId,
      projectId,
      number,
      `item-${number}`,
      slug,
      JSON.stringify(speckit),
      status,
      org.user("admin"),
    ],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  org = await seedOrg(admin, `sdm-${tag}`);
  projectKey = `sm${tag}`;
  projectId = (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: projectKey,
    })
  ).projectId;
});

beforeEach(async () => {
  await admin.query("delete from hive.sdlc_items where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.sdlc_modes where org_id = $1", [org.orgId]);
  // Vai trò tự tạo của ca trước không được dính sang ca sau.
  await admin.query("delete from hive.member_custom_roles where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.custom_roles where org_id = $1", [org.orgId]);
  await as("admin", (tx) => saveAgentPolicy(tx, org.user("admin"), DEFAULT_AGENT_POLICY));
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("preset", () => {
  it("có trong danh sách, chỉ đọc: không lưu đè được, nhân bản thành chế độ riêng thì được", async () => {
    const list = await as("tviewer", (tx) => listModes(tx, org.user("tviewer")));
    const preset = list.find((m) => m.ref === "speckit");
    expect(preset).toMatchObject({ preset: true, teamId: null, enabled: true, openItems: 0, updatedAt: null });
    expect(list.filter((m) => m.preset).map((m) => m.ref)).toEqual(
      expect.arrayContaining(["bugfix", "small", "aidlc-express", "speckit"]),
    );

    // Mã trùng preset bị từ chối, nên không có đường sửa đè preset qua `saveMode`.
    expect(await errorCode(() => save("tadmin", { slug: "speckit" }))).toBe("SDLC_MODE_SLUG_TAKEN");
    const copy = await save("tadmin", { slug: `speckit-${tag}` });
    expect(copy).toMatchObject({ preset: false, basePreset: "speckit", version: 1, teamId: org.teamId });
    expect(copy.definition.id).toBe(`speckit-${tag}`);
  });
});

describe("đường dẫn và luật chế độ", () => {
  const withPath = (path: string) => ({
    edit: (m: SdlcMode) => {
      const artifact = m.phases[0]?.artifacts[0];
      if (artifact) artifact.path = path;
    },
  });
  const rejected = (over: Parameters<typeof input>[0]) =>
    // `definition` được parse lại bằng `sdlcMode` khi lưu, nên đường dẫn cấm đã bị chặn từ lúc dựng đầu vào.
    expect(() => input(over)).toThrow(/Đường dẫn tài liệu phải nằm trong repo/);

  it("từ chối đường dẫn ra ngoài repo hoặc vào thư mục bị cấm", () => {
    rejected(withPath("../x/spec.md"));
    rejected(withPath(".github/workflows/x.md"));
    rejected(withPath(".GitHub/Workflows/x.md"));
    rejected(withPath("/etc/spec.md"));
  });

  it("đường dẫn cấm bị từ chối cả khi đầu vào đi thẳng vào hub không qua dựng sẵn", async () => {
    const raw = { ...input(), definition: structuredClone(speckit) as SdlcModeSaveInput["definition"] };
    const first = raw.definition.phases[0]?.artifacts?.[0];
    if (first) first.path = ".gitlab-ci.yml";
    await expect(as("tadmin", (tx) => saveMode(tx, org.user("tadmin"), raw))).rejects.toThrow(
      /Đường dẫn tài liệu phải nằm trong repo/,
    );
    const rows = await admin.query("select 1 from hive.sdlc_modes where org_id = $1", [org.orgId]);
    expect(rows.rowCount).toBe(0);
  });

  it("tự duyệt giai đoạn yêu cầu của chế độ nặng bị từ chối (FR-056)", () => {
    expect(() =>
      input({
        edit: (m) => {
          const phase = m.phases[0];
          if (phase) phase.autoApprove = { gates: ["po"], minScore: 9, revokeHours: 24 };
        },
      }),
    ).toThrow(/Giai đoạn yêu cầu của chế độ nặng luôn cần người duyệt/);
  });
});

describe("quyền sdlc.modes.write", () => {
  it("chế độ đội cần quản trị đội, chế độ tổ chức cần quản trị tổ chức, đội khác không sửa được", async () => {
    expect(await errorCode(() => save("tmember"))).toBe("TEAM_ROLE_REQUIRED");
    expect(await errorCode(() => save("tviewer"))).toBe("TEAM_ROLE_REQUIRED");
    expect(await errorCode(() => save("oadmin"))).toBe("NOT_TEAM_MEMBER");
    expect(await errorCode(() => save("tadmin", { teamId: null }))).toBe("ORG_ROLE_REQUIRED");
    expect((await save("tadmin")).teamId).toBe(org.teamId);
    expect((await save("admin", { teamId: null })).teamId).toBeNull();
  });

  it("vai trò tự tạo có sdlc.modes.write cho thành viên thường lưu và xoá được; có audit", async () => {
    const {
      rows: [role],
    } = await admin.query(
      `insert into hive.custom_roles (org_id, name, scope, permissions, created_by)
       values ($1, $2, 'org', '{sdlc.modes.write}', $3) returning id`,
      [org.orgId, `Quản lý chế độ ${tag}`, org.user("owner")],
    );
    await admin.query("insert into hive.member_custom_roles (role_id, org_id, user_id) values ($1, $2, $3)", [
      role.id,
      org.orgId,
      org.user("tmember"),
    ]);
    const mode = await save("tmember", { teamId: null });
    expect(mode.teamId).toBeNull();
    await as("tmember", (tx) => removeMode(tx, org.user("tmember"), mode.ref));
    const { rows } = await admin.query(
      "select action, data from hive.audit_log where org_id = $1 and target_id = $2 order by created_at",
      [org.orgId, mode.ref],
    );
    expect(rows.map((r) => r.action)).toEqual(["sdlc.mode.save", "sdlc.mode.remove"]);
    expect(rows[0].data).toMatchObject({ slug: mode.slug, created: true, version: 1 });
  });

  it("đội không tồn tại bị từ chối", async () => {
    expect(await errorCode(() => save("admin", { teamId: randomUUID() }))).toBe("TEAM_NOT_FOUND");
  });
});

describe("chính sách agent (FR-003)", () => {
  const setAllowed = (claude: string[]) =>
    as("admin", (tx) =>
      saveAgentPolicy(tx, org.user("admin"), {
        ...DEFAULT_AGENT_POLICY,
        allowedModels: { ...DEFAULT_AGENT_POLICY.allowedModels, claude },
      }),
    );
  const withStepModel = (model: string) => ({
    edit: (m: SdlcMode) => {
      const step = m.phases.flatMap((p) => p.steps)[0];
      if (step) Object.assign(step, { cli: "claude", model });
    },
  });

  it("model của bước ngoài danh sách bị từ chối; trong danh sách hoặc danh sách rỗng thì lưu được", async () => {
    await setAllowed(["claude-sonnet-5-5"]);
    expect(await errorCode(() => save("tadmin", withStepModel("claude-opus-5-5")))).toBe("SDLC_MODE_MODEL_FORBIDDEN");
    expect((await save("tadmin", withStepModel("claude-sonnet-5-5"))).version).toBe(1);
    await setAllowed([]);
    expect((await save("tadmin", withStepModel("claude-opus-5-5"))).version).toBe(1);
  });
});

describe("sửa, xoá, phạm vi", () => {
  it("sửa tăng version, mã cố định, hạng mục mở giữ bản chụp và được đếm", async () => {
    const v1 = await save("tadmin");
    const itemId = await seedItem(v1.slug, 1);
    await seedItem(v1.slug, 2, "done");
    const v2 = await as("tadmin", (tx) =>
      saveMode(tx, org.user("tadmin"), {
        ...input({ slug: v1.slug, teamId: org.teamId }),
        id: v1.ref,
        definition: definition(v1.slug, (m) => {
          m.description = "Bản sửa";
        }),
      }),
    );
    expect(v2).toMatchObject({ ref: v1.ref, version: 2, openItems: 1 });
    expect(v2.definition.description).toBe("Bản sửa");

    const { rows } = await admin.query("select mode from hive.sdlc_items where id = $1", [itemId]);
    expect(rows[0].mode.description).toBe(speckit.description);

    expect(
      await errorCode(() =>
        as("tadmin", (tx) =>
          saveMode(tx, org.user("tadmin"), { ...input({ slug: `${v1.slug}-moi` }), id: v1.ref, teamId: org.teamId }),
        ),
      ),
    ).toBe("SDLC_MODE_SLUG_FIXED");
  });

  it("chuyển chế độ đội lên tổ chức cần quyền ở cả hai phía", async () => {
    const mode = await save("tadmin");
    const move = (who: string) =>
      as(who, (tx) =>
        saveMode(tx, org.user(who), {
          ...input({ slug: mode.slug, teamId: null }),
          id: mode.ref,
        }),
      );
    expect(await errorCode(() => move("tadmin"))).toBe("ORG_ROLE_REQUIRED");
    expect((await move("admin")).teamId).toBeNull();
  });

  it("trùng mã trong tổ chức bị từ chối", async () => {
    const slug = slugOf();
    await save("tadmin", { slug });
    expect(await errorCode(() => save("oadmin", { slug, teamId: org.otherTeamId }))).toBe("SDLC_MODE_SLUG_TAKEN");
  });

  it("danh sách theo phạm vi: chế độ tổ chức ai cũng thấy, chế độ đội chỉ thành viên đội", async () => {
    const orgMode = await save("admin", { teamId: null });
    const teamMode = await save("tadmin");
    const otherMode = await save("oadmin", { teamId: org.otherTeamId });
    const refs = async (who: string, teamId?: string) =>
      (await as(who, (tx) => listModes(tx, org.user(who), { teamId }))).filter((m) => !m.preset).map((m) => m.ref);

    expect((await refs("tmember")).sort()).toEqual([orgMode.ref, teamMode.ref].sort());
    expect((await refs("oadmin")).sort()).toEqual([orgMode.ref, otherMode.ref].sort());
    expect((await refs("admin")).sort()).toEqual([orgMode.ref, teamMode.ref, otherMode.ref].sort());
    // Lọc theo đội không mở chế độ của đội mà người xem không thuộc.
    expect(await refs("tmember", org.otherTeamId)).toEqual([orgMode.ref]);
  });

  it("resolveMode: preset, chế độ của đội và của tổ chức; không thấy chế độ đội khác hay đã tắt", async () => {
    const orgMode = await save("admin", { teamId: null });
    const teamMode = await save("tadmin");
    const off = await save("tadmin", { enabled: false });
    const r = (ref: string, teamId = org.teamId) => as("tmember", (tx) => resolveMode(tx, ref, teamId));

    expect(await r("speckit")).toMatchObject({ ref: "speckit", preset: true });
    expect(await r(teamMode.slug)).toMatchObject({ ref: teamMode.slug, preset: false, version: 1 });
    expect(await r(orgMode.slug, org.otherTeamId)).toMatchObject({ ref: orgMode.slug });
    expect(await r(teamMode.slug, org.otherTeamId)).toBeNull();
    expect(await r(off.slug)).toBeNull();
    expect(await r("khong-co")).toBeNull();
  });

  it("xoá: quản trị đội xoá được, thành viên không; hạng mục mở vẫn giữ bản chụp; audit có số hạng mục mở", async () => {
    const mode = await save("tadmin");
    const itemId = await seedItem(mode.slug, 1);
    expect(await errorCode(() => as("tmember", (tx) => removeMode(tx, org.user("tmember"), mode.ref)))).toBe(
      "TEAM_ROLE_REQUIRED",
    );
    await as("tadmin", (tx) => removeMode(tx, org.user("tadmin"), mode.ref));
    expect(await errorCode(() => as("tadmin", (tx) => removeMode(tx, org.user("tadmin"), mode.ref)))).toBe(
      "SDLC_MODE_NOT_FOUND",
    );
    const { rows } = await admin.query("select mode_ref from hive.sdlc_items where id = $1", [itemId]);
    expect(rows[0].mode_ref).toBe(mode.slug);
    const audit = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'sdlc.mode.remove' and target_id = $2",
      [org.orgId, mode.ref],
    );
    expect(audit.rows[0].data).toMatchObject({ slug: mode.slug, openItems: 1 });
  });
});

describe("chạy thử", () => {
  const legal = reviewGate.parse({
    id: "legal",
    name: "Pháp chế",
    kind: "human",
    reviewers: { users: [], roles: ["team-admin"], quorum: 1 },
    slaHours: 24,
    conditions: { keywords: ["hoàn tiền"] },
  });
  const mode = definition("dry", (m) => {
    m.phases[0]?.gate[0]?.gates.push(legal);
  });
  const dry = (title: string, extra: Record<string, unknown> = {}) =>
    as("tmember", (tx) => dryRunMode(tx, org.user("tmember"), { mode, projectKey, title, ...extra }));

  it("trả đường dẫn, key tài liệu và cổng; checkpoint theo từ khoá chạy khi tiêu đề nhắc tới", async () => {
    const withKeyword = await dry("Hoàn tiền một phần");
    const specify = withKeyword.phases[0];
    expect(specify?.artifacts[0]).toEqual({
      artifactId: "spec",
      path: "specs/001-hoan-tien-mot-phan/spec.md",
      docKey: `project/${projectKey}/sdlc/001-hoan-tien-mot-phan/spec`,
    });
    expect(specify?.gates.find((g) => g.gateId === "legal")?.runs).toBe(true);
    expect(specify?.gates.find((g) => g.gateId === "po")).toMatchObject({ runs: true, autoApprove: false });

    const without = await dry("Đổi màu nút bấm");
    expect(without.phases[0]?.gates.find((g) => g.gateId === "legal")).toMatchObject({ runs: false });
    expect(without.phases[0]?.gates.find((g) => g.gateId === "legal")?.reason).toContain("hoàn tiền");

    const plan = withKeyword.phases.find((p) => p.id === "plan");
    expect(plan?.gates.find((g) => g.gateId === "lead")?.autoApprove).toBe(true);
    expect(plan?.artifacts.find((a) => a.artifactId === "contract")?.path).toMatch(/contracts\/contract-mau\.yaml$/);
  });

  it("số hạng mục là số kế tiếp của dự án và không ghi dữ liệu", async () => {
    await seedItem("speckit", 7);
    const before = await admin.query("select count(*)::int as n from hive.audit_log where org_id = $1", [org.orgId]);
    const result = await dry("Hoàn tiền");
    expect(result.phases[0]?.artifacts[0]?.path).toBe("specs/008-hoan-tien/spec.md");
    const after = await admin.query("select count(*)::int as n from hive.audit_log where org_id = $1", [org.orgId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const items = await admin.query("select count(*)::int as n from hive.sdlc_items where org_id = $1", [org.orgId]);
    expect(items.rows[0].n).toBe(1);
  });

  it("cỡ nằm ngoài giai đoạn thì giai đoạn bỏ qua và không checkpoint nào chạy", async () => {
    const sized = definition("sized", (m) => {
      const phase = m.phases[0];
      if (phase) phase.sizes = ["L"];
    });
    const result = await as("tmember", (tx) =>
      dryRunMode(tx, org.user("tmember"), { mode: sized, projectKey, title: "Hoàn tiền", size: "S" }),
    );
    expect(result.phases[0]).toMatchObject({ skipped: true });
    expect(result.phases[0]?.gates.every((g) => !g.runs)).toBe(true);
  });

  it("dự án không có hoặc người xem ngoài đội dự án thì từ chối", async () => {
    expect(await errorCode(() => dry("Hoàn tiền", { projectKey: "khong-co" }))).toBe("PROJECT_NOT_FOUND");
    expect(await errorCode(() => dry("Hoàn tiền", { participants: ["khong-co"] }))).toBe("PROJECT_NOT_FOUND");
    expect(
      await errorCode(() =>
        as("oadmin", (tx) => dryRunMode(tx, org.user("oadmin"), { mode, projectKey, title: "Hoàn tiền" })),
      ),
    ).toBe("NOT_TEAM_MEMBER");
  });

  it("cảnh báo chặn cứng không có tác dụng khi chưa có tài liệu bắt buộc", async () => {
    const weak = definition("weak", (m) => {
      m.blocking = "hard";
      for (const p of m.phases) for (const a of p.artifacts) a.required = false;
    });
    const result = await as("tmember", (tx) =>
      dryRunMode(tx, org.user("tmember"), { mode: weak, projectKey, title: "Hoàn tiền" }),
    );
    expect(result.warnings).toContain("Chặn cứng không có tác dụng: chưa có tài liệu bắt buộc.");
  });
});
