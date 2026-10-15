import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import type { Principal } from "./access.ts";
import {
  archiveDoc,
  DOC_SYNC_ACTOR,
  type DocSavedEvent,
  DocSecretError,
  docContentHash,
  docHistory,
  getDoc,
  listDocs,
  provideDocSaved,
  restoreDoc,
  saveDoc,
  saveDocFromSync,
} from "./docs.ts";
import { saveDraft, submitDraft } from "./editor.ts";
import { approveProposal } from "./proposals.ts";
import { decideReview, getReview, proposeWithReview, saveWorkflow } from "./reviews.ts";
import { docVersions } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let projectKey = "";
let projectId = "";
let key = "";

const user = (who: string): Principal => ({ kind: "user", userId: org.user(who) });
const run = (): Principal => ({ kind: "run", runId: randomUUID(), projectId });
const as = <T>(who: string | null, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: who ? org.user(who) : undefined, orgId: org.orgId }, fn);
const deps = {};

// Ghép lúc chạy để mã nguồn không chứa chuỗi giống khoá thật (máy quét bí mật của repo sẽ báo nhầm).
const FAKE_KEY = `AKIA${"Q".repeat(16)}`;
const SECRET = `# Cấu hình\n\nKhoá truy cập: ${FAKE_KEY}\n`;

let events: DocSavedEvent[] = [];

beforeAll(async () => {
  org = await seedOrg(admin, `dsh-${tag}`);
  projectKey = `sync-${tag}`;
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

beforeEach(() => {
  key = `project/${projectKey}/doc-${randomUUID().slice(0, 6)}`;
  events = [];
  provideDocSaved(async (_tx, e) => {
    events.push(e);
  });
});

afterEach(() => provideDocSaved(undefined));

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const versionRow = (docId: string, version: number) =>
  as("tadmin", async (tx) => {
    const rows = await tx.select().from(docVersions);
    return rows.find((r) => r.docId === docId && r.version === version);
  });

describe("hook lưu", () => {
  it("lưu trên hub gọi hook trong transaction với đúng phiên bản và nguồn", async () => {
    const doc = await as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key, content: "# A", baseVersion: 0 }));
    expect(events).toEqual([{ orgId: org.orgId, docId: doc.id, key, version: 1, source: "hub", change: "save" }]);
    const v = await versionRow(doc.id, 1);
    expect(v).toMatchObject({ source: "hub", repoCommit: null, secretFlag: false, contentHash: docContentHash("# A") });
  });

  it("hook lỗi thì cả lần lưu bị huỷ", async () => {
    provideDocSaved(async () => {
      throw new Error("hỏng");
    });
    await expect(
      as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key, content: "# A", baseVersion: 0 })),
    ).rejects.toThrow("hỏng");
    provideDocSaved(undefined);
    expect(await errorCode(() => as("tadmin", (tx) => getDoc(tx, user("tadmin"), { key })))).toBe("DOC_NOT_FOUND");
  });
});

describe("lưu từ đồng bộ", () => {
  it("không qua duyệt, người lưu là hệ thống, ghi nguồn và commit", async () => {
    const doc = await as(null, (tx) =>
      saveDocFromSync(tx, {
        key,
        content: "# Từ repo",
        baseVersion: 0,
        scope: { teamId: org.teamId, projectId },
        source: "repo",
        repoCommit: "a".repeat(40),
        message: "Đồng bộ từ repo, tác giả Nguyễn Văn A",
      }),
    );
    expect(doc).toMatchObject({ version: 1, secretFlag: false });
    expect(events).toEqual([{ orgId: org.orgId, docId: doc.id, key, version: 1, source: "repo", change: "save" }]);
    const [h] = await as("tviewer", (tx) => docHistory(tx, user("tviewer"), { key }));
    expect(h).toMatchObject({ author: { userId: DOC_SYNC_ACTOR }, message: "Đồng bộ từ repo, tác giả Nguyễn Văn A" });
    expect(await versionRow(doc.id, 1)).toMatchObject({ source: "repo", repoCommit: "a".repeat(40) });

    // Lệch phiên bản thì CONFLICT như mọi đường lưu khác; docsync tự xử lý xung đột.
    expect(
      await errorCode(() =>
        as(null, (tx) =>
          saveDocFromSync(tx, {
            key,
            content: "# Cũ",
            baseVersion: 0,
            scope: { teamId: org.teamId, projectId },
            source: "repo",
          }),
        ),
      ),
    ).toBe("VERSION_CONFLICT");
  });

  it("có bí mật thì vẫn lưu nhưng gắn cờ; agent không thấy, người vẫn thấy", async () => {
    const doc = await as(null, (tx) =>
      saveDocFromSync(tx, {
        key,
        content: SECRET,
        baseVersion: 0,
        scope: { teamId: org.teamId, projectId },
        source: "import",
      }),
    );
    expect(doc.secretFlag).toBe(true);
    expect((await as("tviewer", (tx) => getDoc(tx, user("tviewer"), { key }))).content).toBe(SECRET);
    expect(await errorCode(() => as(null, (tx) => getDoc(tx, run(), { key })))).toBe("DOC_SECRET_FLAGGED");
    expect((await as(null, (tx) => listDocs(tx, run(), {}))).map((d) => d.key)).not.toContain(key);
    expect((await as("tviewer", (tx) => listDocs(tx, user("tviewer"), {}))).map((d) => d.key)).toContain(key);

    // Đã xác nhận riêng (người xác nhận từng file khi nhập) thì không gắn cờ.
    const next = await as(null, (tx) =>
      saveDocFromSync(tx, {
        key,
        content: `${SECRET}\nThêm.\n`,
        baseVersion: 1,
        scope: { teamId: org.teamId, projectId },
        source: "merge",
        secretsAcknowledged: true,
      }),
    );
    expect(next.secretFlag).toBe(false);
    expect((await as(null, (tx) => getDoc(tx, run(), { key }))).version).toBe(2);
  });
});

describe("lưu trữ", () => {
  beforeEach(async () => {
    await as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key, content: "# A", baseVersion: 0 }));
    events = [];
  });

  it("cần quyền quản trị và đúng phiên bản", async () => {
    expect(await errorCode(() => as("tmember", (tx) => archiveDoc(tx, user("tmember"), { key, baseVersion: 1 })))).toBe(
      "TEAM_ROLE_REQUIRED",
    );
    expect(await errorCode(() => as("tadmin", (tx) => archiveDoc(tx, user("tadmin"), { key, baseVersion: 2 })))).toBe(
      "VERSION_CONFLICT",
    );
    expect(await errorCode(() => as(null, (tx) => archiveDoc(tx, run(), { key, baseVersion: 1 })))).toBeDefined();
    expect(events).toEqual([]);
  });

  it("ẩn khỏi danh sách, đọc và MCP; lịch sử giữ; khôi phục thì hiện lại", async () => {
    await as("tadmin", (tx) => archiveDoc(tx, user("tadmin"), { key, baseVersion: 1 }));
    // Gọi lại không đổi gì và không báo đồng bộ thêm lần nữa.
    await as("tadmin", (tx) => archiveDoc(tx, user("tadmin"), { key, baseVersion: 1 }));
    expect(events).toMatchObject([{ key, version: 1, change: "archive" }]);

    const keys = async (p: Principal, archived?: boolean) =>
      (await as(p.kind === "user" ? "tviewer" : null, (tx) => listDocs(tx, p, archived ? { archived } : {}))).map(
        (d) => d.key,
      );
    expect(await keys(user("tviewer"))).not.toContain(key);
    expect(await keys(user("tviewer"), true)).toContain(key);
    expect(await keys(run())).not.toContain(key);
    expect(await keys(run(), true)).not.toContain(key);
    expect(await errorCode(() => as("tviewer", (tx) => getDoc(tx, user("tviewer"), { key })))).toBe("DOC_NOT_FOUND");
    expect(await errorCode(() => as(null, (tx) => getDoc(tx, run(), { key, version: 1 })))).toBe("DOC_NOT_FOUND");
    expect((await as("tviewer", (tx) => getDoc(tx, user("tviewer"), { key, version: 1 }))).content).toBe("# A");
    expect(await as("tviewer", (tx) => docHistory(tx, user("tviewer"), { key }))).toHaveLength(1);
    expect(
      await errorCode(() => as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key, content: "# B", baseVersion: 1 }))),
    ).toBe("DOC_ARCHIVED");

    const doc = await as("tadmin", (tx) => restoreDoc(tx, user("tadmin"), { key, baseVersion: 1 }));
    expect(doc).toMatchObject({ key, version: 1, content: "# A" });
    expect(events.map((e) => e.change)).toEqual(["archive", "restore"]);
    expect(await keys(run())).toContain(key);

    const { rows } = await admin.query(
      "select action from hive.audit_log where org_id = $1 and data->>'key' = $2 order by created_at",
      [org.orgId, key],
    );
    expect(rows.map((r) => r.action)).toEqual(["doc.save", "doc.archive", "doc.restore"]);
  });
});

describe("chặn bí mật khi lưu", () => {
  it("lưu trực tiếp: báo dòng và loại, không kèm chuỗi; quản trị xác nhận được", async () => {
    const err = await as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key, content: SECRET, baseVersion: 0 })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DocSecretError);
    expect((err as DocSecretError).code).toBe("DOC_SECRET_FOUND");
    expect((err as DocSecretError).findings).toEqual([{ line: 3, kind: "aws_access_key" }]);
    expect((err as DocSecretError).message).not.toContain(FAKE_KEY);
    expect(events).toEqual([]);

    const doc = await as("tadmin", (tx) =>
      saveDoc(tx, user("tadmin"), { key, content: SECRET, baseVersion: 0, acknowledgeSecrets: true }),
    );
    expect(await versionRow(doc.id, 1)).toMatchObject({ secretFlag: false });
    expect((await as(null, (tx) => getDoc(tx, run(), { key }))).content).toBe(SECRET);
    const { rows } = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'doc.secrets.acknowledge' and data->>'key' = $2",
      [org.orgId, key],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ contentHash: docContentHash(SECRET), findings: [{ line: 3 }] });
    expect(JSON.stringify(rows[0].data)).not.toContain(FAKE_KEY);
  });

  it("gửi duyệt: thành viên không xác nhận được; quản trị xác nhận thì bước chốt lưu không gắn cờ", async () => {
    await as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key, content: "# A", baseVersion: 0 }));
    await as("tmember", (tx) => saveDraft(tx, user("tmember"), { key, content: SECRET, revision: 0 }));
    expect(
      await errorCode(() => as("tmember", (tx) => submitDraft(tx, user("tmember"), { key, revision: 1 }, deps))),
    ).toBe("DOC_SECRET_FOUND");
    expect(
      await errorCode(() =>
        as("tmember", (tx) => submitDraft(tx, user("tmember"), { key, revision: 1, acknowledgeSecrets: true }, deps)),
      ),
    ).toBe("TEAM_ROLE_REQUIRED");
    const out = await as("tadmin", (tx) =>
      submitDraft(tx, user("tadmin"), { key, revision: 1, acknowledgeSecrets: true }, deps),
    );
    const doc = await as("tadmin", (tx) => approveProposal(tx, user("tadmin"), { id: out.proposalId }));
    expect(doc).toBeDefined();
    const latest = await as(null, (tx) => getDoc(tx, run(), { key }));
    expect(latest).toMatchObject({ version: 2, content: SECRET });
  });

  it("bước chốt của quy trình trả về người viết khi nội dung có bí mật chưa xác nhận", async () => {
    const prefix = `project/${projectKey}/sec-${tag}`;
    key = `${prefix}-${randomUUID().slice(0, 6)}`;
    await as("tadmin", (tx) =>
      saveWorkflow(tx, org.user("tadmin"), {
        name: `Bí mật ${tag}`,
        preset: "custom",
        teamId: org.teamId,
        docPrefixes: [prefix],
        phases: [
          {
            name: "Duyệt",
            gates: [
              {
                id: "po",
                name: "PO duyệt",
                kind: "human",
                reviewers: { users: [], roles: ["team-admin"], quorum: 1 },
                slaHours: 24,
              },
            ],
          },
        ],
        enabled: true,
      }),
    );
    await as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key, content: "# A", baseVersion: 0 }));
    // Đề xuất không qua trình soạn (như agent gọi doc_propose) nên không có bước chặn lúc gửi.
    const p = await as("tmember", (tx) =>
      proposeWithReview(tx, user("tmember"), { kind: "doc", key, baseVersion: 1, content: SECRET }, deps),
    );
    const reviewId = (await admin.query("select id from hive.review_instances where proposal_id = $1", [p.id])).rows[0]
      .id as string;
    events = [];
    await as("tadmin", (tx) => decideReview(tx, org.user("tadmin"), { id: reviewId, decision: "approve" }, deps));
    const r = await as("tadmin", (tx) => getReview(tx, org.user("tadmin"), reviewId, deps));
    expect(r.status).toBe("changes_requested");
    expect(events).toEqual([]);
    expect((await as("tadmin", (tx) => getDoc(tx, user("tadmin"), { key }))).version).toBe(1);
  });

  it("duyệt tay đề xuất có bí mật: lưu nhưng gắn cờ để agent và đồng bộ không dùng", async () => {
    await as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key, content: "# A", baseVersion: 0 }));
    const p = await as("tmember", (tx) =>
      proposeWithReview(tx, user("tmember"), { kind: "doc", key, baseVersion: 1, content: SECRET }, deps),
    );
    await as("tadmin", (tx) => approveProposal(tx, user("tadmin"), { id: p.id }));
    expect(await errorCode(() => as(null, (tx) => getDoc(tx, run(), { key })))).toBe("DOC_SECRET_FLAGGED");
    expect((await as("tadmin", (tx) => getDoc(tx, user("tadmin"), { key }))).version).toBe(2);
  });
});
