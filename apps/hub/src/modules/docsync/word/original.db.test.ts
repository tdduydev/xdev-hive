import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, seedOrg } from "../../../../test/org-fixture.ts";
import { seedProject } from "../../../../test/project-fixture.ts";
import type { Auth } from "../../identity/index.ts";
import { saveDoc } from "../../knowledge/index.ts";
import {
  createPool,
  createPostgresBlobStore,
  type Jobs,
  parseMasterKey,
  type Tx,
  withTenant,
} from "../../platform/index.ts";
import { createMemoryProvider } from "../../scm/index.ts";
import { ORG_HEADER } from "../../tenancy/index.ts";
import { configureProjectHome, type HomeRow } from "../homes.ts";
import { getWordImport, listWordImports, wordImportOfDoc } from "../routes/word-imports.ts";
import { docWordImportFiles, docWordImports } from "../schema.ts";
import { handleWordOriginal } from "./original.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const mem = createMemoryProvider("gitlab", ["xdev-team"]);
const jobs = { enqueue: async () => randomUUID() } as unknown as Jobs;
const projectKey = `wo${tag}`;
const WORD = Buffer.from("word gốc của lượt nhập");
const TEN = "Đặc tả yêu cầu (bản 1).docx";

let org: Awaited<ReturnType<typeof seedOrg>>;
let home: HomeRow;
const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pool, { userId: org.user(who), orgId: org.orgId }, fn);
const user = (who: string) => ({ kind: "user" as const, userId: org.user(who) });
const key = (name: string) => `project/${projectKey}/srs/${name}`;

async function* once(bytes: Uint8Array) {
  yield bytes;
}

const fakeAuth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get("x-test-user");
      return id ? { user: { id }, session: {} } : null;
    },
  },
} as unknown as Auth;

/** Lượt tạo của `who` có một file Word; `docKey` null là lượt chưa tạo tài liệu. */
async function seedImport(
  who: string,
  fileName: string,
  docKey: string | null,
  opts: { createdAt?: Date; blob?: boolean } = {},
) {
  return withTenant(pool, { orgId: org.orgId }, async (tx) => {
    let docId: string | null = null;
    if (docKey) {
      const { rows } = await tx.execute<{ id: string }>(sql`select id from hive.docs where key = ${docKey}`);
      docId = rows[0]?.id ?? null;
    }
    const [imp] = await tx
      .insert(docWordImports)
      .values({
        orgId: org.orgId,
        homeId: home.id,
        targetDir: "docs/srs",
        state: docId ? "done" : "ready",
        createdBy: org.user(who),
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      })
      .returning();
    if (!imp) throw new Error("không tạo được lượt");
    const word =
      opts.blob === false
        ? null
        : await createPostgresBlobStore().put(tx, org.orgId, once(WORD), "application/octet-stream");
    const [file] = await tx
      .insert(docWordImportFiles)
      .values({
        orgId: org.orgId,
        importId: imp.id,
        fileName,
        format: "docx",
        size: WORD.byteLength,
        sha256: "b".repeat(64),
        blobId: word?.id ?? null,
        proposedPath: "docs/srs/x.md",
        state: docId ? "done" : "ready",
        docId,
        docVersion: docId ? 1 : null,
      })
      .returning();
    if (!file) throw new Error("không tạo được file");
    return { importId: imp.id, fileId: file.id };
  });
}

function original(who: string | null, importId: string, fileId: string) {
  const request = new Request(`http://hub.test/api/v1/docs/word-imports/${importId}/files/${fileId}/original`, {
    headers: { ...(who ? { "x-test-user": org.user(who) } : {}), [ORG_HEADER]: org.orgId },
  });
  return handleWordOriginal({ pool, auth: fakeAuth }, request, { importId, fileId });
}

const audits = (fileId: string) =>
  admin
    .query("select actor_user_id from hive.audit_log where action = $1 and data->>'fileId' = $2", [
      "docs.word_original.download",
      fileId,
    ])
    .then((r) => r.rows as Array<{ actor_user_id: string }>);

let docKey: string;

beforeAll(async () => {
  org = await seedOrg(admin, `dwo-${tag}`);
  const project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
  mem.seedRepo({ owner: project.owner, name: project.repo }, { files: { "README.md": "# Repo\n" } });
  home = await as("tadmin", (tx) =>
    configureProjectHome(
      tx,
      { pool, jobs, masterKey, providerFactory: () => mem },
      { userId: org.user("tadmin"), orgId: org.orgId },
      {
        project: projectKey,
        settings: {
          enabled: true,
          root: "docs/",
          repoSync: "direct",
          include: ["**/*.md"],
          exclude: [],
          assetsDir: "assets",
          repoChangesNeedReview: false,
          wordImportConfidential: false,
        },
      },
    ),
  );
  docKey = key("from-word");
  await as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key: docKey, content: "# Từ Word\n", baseVersion: 0 }));
});

afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

describe("tải file Word gốc và lượt nhập theo tài liệu (spec 019, T020)", () => {
  it("người đọc được tài liệu tải được file gốc, tên tiếng Việt mã hoá đúng, có audit", async () => {
    const seeded = await seedImport("tadmin", TEN, docKey);
    const encoded = encodeURIComponent(TEN).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    for (const who of ["tadmin", "tmember", "tviewer"]) {
      const response = await original(who, seeded.importId, seeded.fileId);
      expect(response.status).toBe(200);
      const disposition = response.headers.get("content-disposition") ?? "";
      expect(disposition.startsWith("attachment;")).toBe(true);
      expect(disposition).toContain(`filename*=UTF-8''${encoded}`);
      expect(/[^\x20-\x7e]/.test(disposition)).toBe(false);
      expect(response.headers.get("content-type")).toContain("wordprocessingml");
      expect(Buffer.from(await response.arrayBuffer()).equals(WORD)).toBe(true);
    }
    expect((await audits(seeded.fileId)).map((r) => r.actor_user_id).sort()).toEqual(
      ["tadmin", "tmember", "tviewer"].map(org.user).sort(),
    );
  });

  it("người không đọc được tài liệu nhận 404 và không để lại audit", async () => {
    const seeded = await seedImport("tadmin", "a.docx", docKey);
    for (const who of ["oadmin", "loner"]) {
      expect((await original(who, seeded.importId, seeded.fileId)).status).toBe(404);
    }
    expect(await audits(seeded.fileId)).toHaveLength(0);
  });

  it("chưa đăng nhập 401; id lạ hoặc lượt và file không khớp 404", async () => {
    const seeded = await seedImport("tadmin", "b.docx", docKey);
    const other = await seedImport("tadmin", "c.docx", docKey);
    expect((await original(null, seeded.importId, seeded.fileId)).status).toBe(401);
    expect((await original("tadmin", "khong-phai-uuid", seeded.fileId)).status).toBe(404);
    expect((await original("tadmin", other.importId, seeded.fileId)).status).toBe(404);
    expect((await original("tadmin", seeded.importId, randomUUID())).status).toBe(404);
  });

  it("lượt chưa tạo tài liệu hoặc file đã dọn thì không tải được", async () => {
    const notCreated = await seedImport("tadmin", "d.docx", null);
    expect((await original("tadmin", notCreated.importId, notCreated.fileId)).status).toBe(404);
    const cleaned = await seedImport("tadmin", "e.docx", docKey, { blob: false });
    expect((await original("tadmin", cleaned.importId, cleaned.fileId)).status).toBe(404);
  });

  it("list: người tạo và người đọc được tài liệu thấy lượt, người ngoài không", async () => {
    const seeded = await seedImport("tadmin", "f.docx", docKey);
    const draft = await seedImport("tadmin", "g.docx", null);
    const idsOf = async (who: string) =>
      (await as(who, (tx) => listWordImports(tx, user(who), { homeId: home.id, limit: 100 }))).items.map((i) => i.id);
    expect(await idsOf("tadmin")).toEqual(expect.arrayContaining([seeded.importId, draft.importId]));
    // tviewer không tạo lượt và không có `manage`, nhưng đọc được tài liệu sinh ra từ lượt.
    const viewer = await idsOf("tviewer");
    expect(viewer).toContain(seeded.importId);
    expect(viewer).not.toContain(draft.importId);
    const outsider = await idsOf("oadmin");
    expect(outsider).not.toContain(seeded.importId);
    expect(outsider).not.toContain(draft.importId);
    // Chi tiết lượt giữ luật cũ: người tạo hoặc `manage`.
    expect(await errorCode(() => as("oadmin", (tx) => getWordImport(tx, user("oadmin"), seeded.importId)))).toBe(
      "WORD_IMPORT_NOT_FOUND",
    );
  });

  it("ofDoc: lần nhập gần nhất kèm tên file, ngày, người nhập; null khi không đọc được", async () => {
    const docOf = key("of-doc");
    await as("tadmin", (tx) =>
      saveDoc(tx, user("tadmin"), { key: docOf, content: "# Của tài liệu\n", baseVersion: 0 }),
    );
    await seedImport("tadmin", "cu.docx", docOf, { createdAt: new Date("2026-01-01T00:00:00Z") });
    const newer = await seedImport("tmember", "moi.docx", docOf, { createdAt: new Date("2026-02-01T00:00:00Z") });
    const got = await as("tviewer", (tx) => wordImportOfDoc(tx, user("tviewer"), { docKey: docOf }));
    expect(got?.file.fileName).toBe("moi.docx");
    expect(got?.file.id).toBe(newer.fileId);
    expect(got?.import.createdAt).toBe("2026-02-01T00:00:00.000Z");
    expect(got?.import.createdBy.id).toBe(org.user("tmember"));
    expect(await as("oadmin", (tx) => wordImportOfDoc(tx, user("oadmin"), { docKey: docOf }))).toBeNull();
    expect(await as("tviewer", (tx) => wordImportOfDoc(tx, user("tviewer"), { docKey: key("khong-co") }))).toBeNull();
  });
});
