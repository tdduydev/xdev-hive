import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { toDoc } from "./modules/artifacts/convert.ts";
import { provideDocProposer, type Reader, readerFor } from "./modules/artifacts/index.ts";
import { createArtifact, updateArtifact } from "./modules/artifacts/service.ts";
import { tombstoneVersion } from "./modules/artifacts/versions.ts";
import { createDocProposer } from "./modules/knowledge/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "./modules/platform/index.ts";

/*
 * "Chuyển thành tài liệu" (specs/012 T066, FR-110): luôn thành đề xuất `knowledge`, không ghi thẳng tài liệu; chỉ
 * Markdown; quyền đọc artifact và quyền đề xuất trên tài liệu đều phải đủ. Người dùng thật của seedOrg: tmember (đội A,
 * viết được), tviewer (chỉ xem đội A), loner (không thuộc đội nào).
 */
const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let projectKey = "";

const as = <T>(who: string, fn: (tx: Tx, reader: Reader) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, async (tx) =>
    fn(tx, await readerFor(tx, { kind: "user", userId: org.user(who) })),
  );

const markdown = (title: string, content = "# Quy trình\n\nBước một.") =>
  as("tmember", (tx, r) =>
    createArtifact(tx, r, { type: "markdown", title, content, scope: "project", projectKey }),
  ).then((created) => created.artifact.id);

const docKey = (name: string) => `project/${projectKey}/${name}`;

const proposalOf = async (id: string) =>
  (await admin.query("select * from hive.proposals where id = $1", [id])).rows[0] as
    | {
        kind: string;
        target: string;
        base_version: number;
        title: string | null;
        content: string;
        reason: string | null;
      }
    | undefined;

beforeAll(async () => {
  org = await seedOrg(admin, `td-${tag}`);
  projectKey = `td${tag}`;
  await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
  provideDocProposer(createDocProposer());
});

afterAll(async () => {
  provideDocProposer(undefined);
  await Promise.all([admin.end(), app.end()]);
});

describe("artifact Markdown thành đề xuất tài liệu", () => {
  it("tài liệu chưa có: đề xuất mới với base 0, tiêu đề theo artifact, lý do ghi nguồn, có audit", async () => {
    const id = await markdown("Quy trình hoàn tiền");
    const { proposalId } = await as("tmember", (tx, r) => toDoc(tx, r, { id, version: 1, key: docKey("hoan-tien") }));
    expect(await proposalOf(proposalId)).toMatchObject({
      kind: "doc",
      target: docKey("hoan-tien"),
      base_version: 0,
      title: "Quy trình hoàn tiền",
      content: "# Quy trình\n\nBước một.",
    });
    expect((await proposalOf(proposalId))?.reason).toContain("phiên bản 1");
    const audits = await admin.query(
      "select data from hive.audit_log where action = 'artifact.to_doc' and target_id = $1",
      [id],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0].data).toMatchObject({ version: 1, key: docKey("hoan-tien"), proposalId });
    // Chỉ là đề xuất: tài liệu chưa được tạo.
    const docs = await admin.query("select 1 from hive.docs where org_id = $1 and key = $2", [
      org.orgId,
      docKey("hoan-tien"),
    ]);
    expect(docs.rowCount).toBe(0);
  });

  it("chọn phiên bản cũ thì đề xuất nội dung của phiên bản đó, tiêu đề nhập tay thắng tiêu đề artifact", async () => {
    const id = await markdown("Bản nháp", "# v1");
    await as("tmember", (tx, r) => updateArtifact(tx, r, { id, content: "# v2", baseVersion: 1 }));
    const { proposalId } = await as("tmember", (tx, r) =>
      toDoc(tx, r, { id, version: 1, key: docKey("ban-nhap"), title: "Tên tài liệu" }),
    );
    expect(await proposalOf(proposalId)).toMatchObject({ content: "# v1", title: "Tên tài liệu" });
  });

  it("tài liệu đã có: base là phiên bản hiện tại", async () => {
    const key = docKey("co-san");
    await admin.query(
      `insert into hive.docs (org_id, team_id, project_id, key, title, current_version, updated_by_user_id)
       select $1, $2, id, $3, 'Có sẵn', 3, $4 from hive.projects where org_id = $1 and key = $5`,
      [org.orgId, org.teamId, key, org.user("tmember"), projectKey],
    );
    const id = await markdown("Cập nhật");
    const { proposalId } = await as("tmember", (tx, r) => toDoc(tx, r, { id, version: 1, key }));
    expect((await proposalOf(proposalId))?.base_version).toBe(3);
  });

  it("loại khác Markdown bị từ chối", async () => {
    const id = (
      await as("tmember", (tx, r) =>
        createArtifact(tx, r, { type: "code", title: "Mã", content: "const a = 1;", scope: "project", projectKey }),
      )
    ).artifact.id;
    expect(await errorCode(() => as("tmember", (tx, r) => toDoc(tx, r, { id, version: 1, key: docKey("ma") })))).toBe(
      "ARTIFACT_NOT_MARKDOWN",
    );
  });

  it("phiên bản không có hoặc đã bị xoá nội dung thì báo không tìm thấy", async () => {
    const id = await markdown("Có bí mật", "# v1");
    await as("tmember", (tx, r) => updateArtifact(tx, r, { id, content: "# v2", baseVersion: 1 }));
    expect(await errorCode(() => as("tmember", (tx, r) => toDoc(tx, r, { id, version: 9, key: docKey("x") })))).toBe(
      "ARTIFACT_NOT_FOUND",
    );
    await as("tmember", (tx, r) => tombstoneVersion(tx, r, { id, version: 1 }, {}));
    expect(await errorCode(() => as("tmember", (tx, r) => toDoc(tx, r, { id, version: 1, key: docKey("x") })))).toBe(
      "ARTIFACT_NOT_FOUND",
    );
  });

  it("người chỉ xem đội đọc được artifact nhưng không đề xuất được; người ngoài không thấy artifact", async () => {
    const id = await markdown("Chỉ xem");
    expect(
      await errorCode(() => as("tviewer", (tx, r) => toDoc(tx, r, { id, version: 1, key: docKey("chi-xem") }))),
    ).toBe("TEAM_ROLE_REQUIRED");
    expect(
      await errorCode(() => as("loner", (tx, r) => toDoc(tx, r, { id, version: 1, key: docKey("chi-xem") }))),
    ).toBe("ARTIFACT_NOT_FOUND");
    const count = await admin.query("select count(*)::int as n from hive.proposals where org_id = $1 and target = $2", [
      org.orgId,
      docKey("chi-xem"),
    ]);
    expect(count.rows[0].n).toBe(0);
  });

  it("hub chưa cài hook tài liệu thì báo lỗi rõ", async () => {
    const id = await markdown("Không hook");
    provideDocProposer(undefined);
    try {
      expect(
        await errorCode(() => as("tmember", (tx, r) => toDoc(tx, r, { id, version: 1, key: docKey("khong-hook") }))),
      ).toBe("DOCS_DISABLED");
    } finally {
      provideDocProposer(createDocProposer());
    }
  });
});
