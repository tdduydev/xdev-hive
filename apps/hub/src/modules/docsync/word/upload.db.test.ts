// Route nhận file Word (plan.md mục 2). Token cá nhân đi qua lớp ghép app.ts nên test ở src/word-upload-pat.db.test.ts.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WORD_IMPORT_UPLOAD_PATH } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { encryptedOoxml, oleDoc } from "../../../../test/ole-fixture.ts";
import { seedOrg } from "../../../../test/org-fixture.ts";
import { seedProject } from "../../../../test/project-fixture.ts";
import type { Auth } from "../../identity/index.ts";
import { saveDoc } from "../../knowledge/index.ts";
import { createPool, type Jobs, loadConfig, parseMasterKey, withTenant } from "../../platform/index.ts";
import { createMemoryProvider } from "../../scm/index.ts";
import { configureProjectHome } from "../homes.ts";
import { DOCSYNC_WORD_IMPORT_QUEUE } from "../queues.ts";
import { provideWordTools, type WordImportConfig, type WordTools } from "./tools.ts";
import { handleWordUpload } from "./upload.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const mem = createMemoryProvider("gitlab", ["xdev-team"]);
const queued: Array<{ queue: string; data: Record<string, unknown> }> = [];
const jobs = {
  enqueue: async (queue: string, data: Record<string, unknown>) => {
    queued.push({ queue, data });
    return randomUUID();
  },
} as unknown as Jobs;
// Phiên đăng nhập giả: header riêng của test thay cookie của better-auth.
const auth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get("x-test-user");
      return id ? { user: { id } } : null;
    },
  },
} as unknown as Auth;
const deps = { pool, jobs, masterKey, providerFactory: () => mem, auth };
const baseConfig = loadConfig({}).wordImport as WordImportConfig;
const ok = { ok: true, version: "3.12", reason: null };
const missing = { ok: false, version: null, reason: "Không chạy được." };
const tools = (config: Partial<WordImportConfig> = {}, soffice: WordTools["soffice"] = ok) =>
  provideWordTools({ config: { ...baseConfig, ...config }, pandoc: ok, soffice });

const fixtures = join(import.meta.dirname, "fixtures");
let docx: Buffer;
let odt: Buffer;
let org: Awaited<ReturnType<typeof seedOrg>>;
let homeId: string;
const projectKey = `wu${tag}`;
const existingKey = `project/${projectKey}/srs/opd99`;

interface Send {
  files: Array<{ name: string; data: Buffer; dir?: string; lastModified?: number }>;
  fields?: Record<string, string>;
  headers?: Record<string, string>;
}

function send(who: string | null, { files, fields = {}, headers = {} }: Send) {
  const form = new FormData();
  form.set("homeId", homeId);
  form.set("targetDir", "docs/srs");
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  for (const file of files) {
    form.append("files[]", new File([new Uint8Array(file.data)], file.name));
    if (files.some((f) => f.dir !== undefined)) form.append("relativePaths", file.dir ?? "");
    if (files.some((f) => f.lastModified !== undefined)) form.append("lastModified", String(file.lastModified ?? 0));
  }
  const h = new Headers({ "x-hive-org": org.orgId, ...headers });
  if (who) h.set("x-test-user", org.user(who));
  return handleWordUpload(
    deps,
    new Request(`http://hive.test${WORD_IMPORT_UPLOAD_PATH}`, { method: "POST", headers: h, body: form }),
  );
}

async function created(response: Response) {
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { importId: string }).importId;
}

async function failure(response: Response) {
  return { status: response.status, ...((await response.json()) as { code: string; data?: { code?: string } }) };
}

const importRow = async (id: string) =>
  (await admin.query("select * from hive.doc_word_imports where id = $1", [id])).rows[0];
const fileRows = async (id: string) =>
  (
    await admin.query(
      `select file_name, relative_dir, format, state, proposed_path, proposed_title, version_label, warnings, error,
              blob_id, sha256, size
         from hive.doc_word_import_files where import_id = $1 order by relative_dir, file_name`,
      [id],
    )
  ).rows;
const wordJobs = () => queued.filter((job) => job.queue === DOCSYNC_WORD_IMPORT_QUEUE);

beforeAll(async () => {
  [docx, odt] = await Promise.all([readFile(join(fixtures, "srs.docx")), readFile(join(fixtures, "srs.odt"))]);
  org = await seedOrg(admin, `wu-${tag}`);
  const project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
  mem.seedRepo({ owner: project.owner, name: project.repo }, { files: { "README.md": "# Repo\n" } });
  const actor = { userId: org.user("tadmin"), orgId: org.orgId };
  const home = await withTenant(pool, actor, (tx) =>
    configureProjectHome(tx, deps, actor, {
      project: projectKey,
      settings: {
        enabled: true,
        root: "docs/",
        repoSync: "direct",
        include: ["**/*.md"],
        exclude: [],
        assetsDir: "assets",
        repoChangesNeedReview: false,
        wordImportConfidential: true,
      },
    }),
  );
  homeId = home.id;
  await withTenant(pool, actor, (tx) =>
    saveDoc(
      tx,
      { kind: "user", userId: actor.userId },
      { key: existingKey, title: "Khám bệnh", content: "# Khám\n", baseVersion: 0 },
    ),
  );
});

beforeEach(() => {
  queued.length = 0;
  tools();
});

afterAll(async () => {
  provideWordTools(null);
  await Promise.all([admin.end(), pool.end()]);
});

describe("xác thực", () => {
  it("phiên web: tạo lượt, ghi file queued, xếp job từng file và ghi audit", async () => {
    const id = await created(
      await send("tmember", { files: [{ name: "eHosV2i_SRS_OPD.OPD02_v1.0.docx", data: docx }] }),
    );
    expect(await importRow(id)).toMatchObject({
      org_id: org.orgId,
      home_id: homeId,
      target_dir: "docs/srs",
      mode: "create",
      update_doc_id: null,
      // Bỏ trống `confidential` thì theo cài đặt của nhà (Q15).
      confidential: true,
      state: "converting",
      created_by: org.user("tmember"),
      counts: expect.objectContaining({ queued: 1, skipped: 0, failed: 0 }),
    });
    const [file] = await fileRows(id);
    expect(file).toMatchObject({
      format: "docx",
      state: "queued",
      proposed_path: "docs/srs/eHosV2i-SRS-OPD-OPD02.md",
      version_label: "1.0",
      // pg trả bigint dạng chuỗi.
      size: String(docx.length),
      sha256: createHash("sha256").update(docx).digest("hex"),
    });
    expect(file.blob_id).toBeTruthy();
    expect(wordJobs()).toHaveLength(1);
    const audit = await admin.query("select action, actor_user_id from hive.audit_log where target_id = $1", [id]);
    expect(audit.rows).toEqual([{ action: "doc.word_import.upload", actor_user_id: org.user("tmember") }]);
  });

  it("nhận .odt; `confidential` gửi kèm thắng cài đặt của nhà", async () => {
    const id = await created(
      await send("tmember", { files: [{ name: "moi.odt", data: odt }], fields: { confidential: "false" } }),
    );
    expect(await importRow(id)).toMatchObject({ confidential: false });
    expect(await fileRows(id)).toMatchObject([{ format: "odt", state: "queued" }]);
  });

  it("chưa đăng nhập hay thiếu tổ chức thì từ chối", async () => {
    const files = [{ name: "a.docx", data: docx }];
    expect((await send(null, { files })).status).toBe(401);
    expect((await send("tmember", { files, headers: { "x-hive-org": "khong-phai-uuid" } })).status).toBe(400);
    expect(wordJobs()).toHaveLength(0);
  });

  it("người không có quyền đề xuất ở phạm vi đích thì từ chối, không ghi gì", async () => {
    const count = async () =>
      (await admin.query("select count(*)::int as n from hive.doc_word_imports where org_id = $1", [org.orgId])).rows[0]
        .n;
    const before = await count();
    // Người xem của đội thấy nhà nhưng không được đề xuất; người ngoài đội không thấy cả dự án.
    for (const [user, status] of [
      ["tviewer", 403],
      ["loner", 404],
    ] as const) {
      const response = await send(user, { files: [{ name: "a.docx", data: docx }] });
      expect(response.status, user).toBe(status);
    }
    expect(await count()).toBe(before);
    expect(wordJobs()).toHaveLength(0);
  });

  it("thư mục đích ngoài gốc nhà thì từ chối", async () => {
    const response = await send("tmember", { files: [{ name: "a.docx", data: docx }], fields: { targetDir: "src" } });
    expect(await failure(response)).toMatchObject({ status: 400, data: { code: "WORD_IMPORT_OUTSIDE_HOME" } });
  });
});

describe("nội dung file", () => {
  it("file có mật khẩu và file đổi đuôi một mình thì từ chối ngay, nói rõ lý do", async () => {
    for (const [name, data, code] of [
      ["mat-khau.docx", encryptedOoxml(), "WORD_IMPORT_PASSWORD"],
      ["mat-khau.doc", oleDoc({ encrypted: true }), "WORD_IMPORT_PASSWORD"],
      ["doi-duoi.docx", odt, "WORD_IMPORT_NOT_WORD"],
      ["doi-duoi.odt", Buffer.from("%PDF-1.7\n"), "WORD_IMPORT_NOT_WORD"],
    ] as const) {
      const response = await send("tmember", { files: [{ name, data }] });
      expect(await failure(response), name).toMatchObject({ status: 400, data: { code } });
    }
    expect(wordJobs()).toHaveLength(0);
  });

  it(".doc bị từ chối khi hub chưa có LibreOffice, nhận khi có", async () => {
    tools({}, missing);
    const files = [{ name: "cu.doc", data: oleDoc() }];
    expect(await failure(await send("tmember", { files }))).toMatchObject({
      data: { code: "WORD_IMPORT_DOC_DISABLED" },
    });
    tools();
    const id = await created(await send("tmember", { files }));
    expect(await fileRows(id)).toMatchObject([{ format: "doc", state: "queued" }]);
  });

  it("chưa có pandoc thì tắt nhập Word", async () => {
    provideWordTools({ config: baseConfig, pandoc: missing, soffice: ok });
    const response = await send("tmember", { files: [{ name: "a.docx", data: docx }] });
    expect(await failure(response)).toMatchObject({ status: 409, data: { code: "WORD_IMPORT_DISABLED" } });
  });

  it("hai file cùng thư mục con và tên thì báo trùng", async () => {
    const files = [
      { name: "a.docx", data: docx, dir: "OPD" },
      { name: "a.docx", data: docx, dir: "OPD" },
    ];
    expect(await failure(await send("tmember", { files }))).toMatchObject({
      status: 409,
      data: { code: "WORD_IMPORT_DUPLICATE_PATH", path: "OPD/a.docx" },
    });
  });
});

describe("giới hạn", () => {
  it("file vượt HIVE_DOC_WORD_MAX_BYTES", async () => {
    tools({ maxBytes: docx.length - 1 });
    const response = await send("tmember", { files: [{ name: "a.docx", data: docx }] });
    expect(await failure(response)).toMatchObject({
      status: 400,
      data: { code: "WORD_IMPORT_FILE_TOO_LARGE", limit: docx.length - 1 },
    });
  });

  it("lượt vượt số file hoặc tổng dung lượng", async () => {
    tools({ batchFiles: 2 });
    const three = ["a", "b", "c"].map((n) => ({ name: `${n}.docx`, data: docx }));
    expect(await failure(await send("tmember", { files: three }))).toMatchObject({
      data: { code: "WORD_IMPORT_BATCH_TOO_LARGE" },
    });
    tools({ batchBytes: docx.length * 2 - 1 });
    const response = await send("tmember", { files: three.slice(0, 2) });
    expect(await failure(response)).toMatchObject({
      data: { code: "WORD_IMPORT_BATCH_TOO_LARGE", limit: docx.length * 2 - 1 },
    });
  });

  it("content-length khai quá lượt thì từ chối trước khi đọc thân request", async () => {
    tools({ batchBytes: docx.length * 2 });
    const response = await send("tmember", {
      files: [{ name: "a.docx", data: docx }],
      headers: { "content-length": String(1024 ** 3) },
    });
    expect(await failure(response)).toMatchObject({ data: { code: "WORD_IMPORT_BATCH_TOO_LARGE" } });
  });
});

describe("nhiều file (US2)", () => {
  it("30 file, 2 mã có hai phiên bản: giữ bản cao nhất, bản cũ skipped kèm lý do", async () => {
    const codes = Array.from({ length: 28 }, (_, i) => `OPD${String(i + 1).padStart(2, "0")}`);
    const files = [
      ...codes.map((code) => ({ name: `eHosV2i_SRS_OPD.${code}_v1.0.docx`, data: docx })),
      { name: "eHosV2i_SRS_OPD.OPD01_v1.1.docx", data: docx },
      { name: "eHosV2i_SRS_OPD.OPD02_v2.0.docx", data: docx },
    ];
    const id = await created(await send("tmember", { files }));
    const rows = await fileRows(id);
    expect(rows).toHaveLength(30);
    const queuedRows = rows.filter((row) => row.state === "queued");
    expect(queuedRows).toHaveLength(28);
    expect(new Set(queuedRows.map((row) => row.proposed_path))).toEqual(
      new Set(codes.map((code) => `docs/srs/${code}.md`)),
    );
    expect(queuedRows.find((row) => row.proposed_path === "docs/srs/OPD02.md")?.version_label).toBe("2.0");
    expect(rows.filter((row) => row.state === "skipped")).toMatchObject([
      {
        file_name: "eHosV2i_SRS_OPD.OPD01_v1.0.docx",
        proposed_path: null,
        version_label: "1.0",
        warnings: [{ code: "skipped_older", count: 1, detail: "eHosV2i_SRS_OPD.OPD01_v1.1.docx" }],
      },
      {
        file_name: "eHosV2i_SRS_OPD.OPD02_v1.0.docx",
        warnings: [{ code: "skipped_older", count: 1, detail: "eHosV2i_SRS_OPD.OPD02_v2.0.docx" }],
      },
    ]);
    expect((await importRow(id)).counts).toMatchObject({ queued: 28, skipped: 2, failed: 0 });
    expect(wordJobs()).toHaveLength(28);
  });

  it("file hỏng hay có mật khẩu trong lượt nhiều file: ghi failed kèm lý do, phần còn lại vẫn nhập", async () => {
    const id = await created(
      await send("tmember", {
        files: [
          { name: "OPD02.docx", data: docx, dir: "OPD" },
          { name: "OPD03.docx", data: encryptedOoxml(), dir: "OPD" },
          { name: "OPD04.docx", data: Buffer.from("không phải zip"), dir: "OPD" },
        ],
      }),
    );
    const rows = await fileRows(id);
    expect(rows).toMatchObject([
      { file_name: "OPD02.docx", state: "queued", proposed_path: "docs/srs/OPD/OPD02.md" },
      {
        file_name: "OPD03.docx",
        state: "failed",
        blob_id: null,
        proposed_path: null,
        error: { code: "WORD_IMPORT_PASSWORD", message: "File có mật khẩu. Mở khoá trong Word, lưu lại rồi tải lên." },
      },
      { file_name: "OPD04.docx", state: "failed", blob_id: null, error: { code: "WORD_IMPORT_NOT_WORD" } },
    ]);
    expect((await importRow(id)).counts).toMatchObject({ queued: 1, failed: 2 });
    expect(wordJobs()).toHaveLength(1);
  });
});

describe("cập nhật và gắn", () => {
  it("cần docKey của tài liệu có sẵn, đường dẫn và tên theo tài liệu đó", async () => {
    for (const mode of ["update", "link"]) {
      const id = await created(
        await send("tmember", {
          files: [{ name: "Ten bat ky_v3.0.docx", data: docx }],
          fields: { mode, docKey: existingKey },
        }),
      );
      const row = await importRow(id);
      expect(row).toMatchObject({ mode, target_dir: null });
      expect(row.update_doc_id).toBeTruthy();
      expect(await fileRows(id)).toMatchObject([
        { state: "queued", proposed_path: "docs/srs/opd99.md", proposed_title: "Khám bệnh", version_label: "3.0" },
      ]);
    }
  });

  it("thiếu docKey, hai file, tài liệu không có, hay file có mật khẩu thì từ chối", async () => {
    const one = [{ name: "a.docx", data: docx }];
    expect((await send("tmember", { files: one, fields: { mode: "update" } })).status).toBe(400);
    const two = [...one, { name: "b.docx", data: docx }];
    expect((await send("tmember", { files: two, fields: { mode: "update", docKey: existingKey } })).status).toBe(400);
    const missingDoc = { mode: "link", docKey: `project/${projectKey}/srs/khong-co` };
    expect((await send("tmember", { files: one, fields: missingDoc })).status).toBe(404);
    const locked = [{ name: "a.docx", data: encryptedOoxml() }];
    expect(
      await failure(await send("tmember", { files: locked, fields: { mode: "update", docKey: existingKey } })),
    ).toMatchObject({ data: { code: "WORD_IMPORT_PASSWORD" } });
    expect(wordJobs()).toHaveLength(0);
  });
});
