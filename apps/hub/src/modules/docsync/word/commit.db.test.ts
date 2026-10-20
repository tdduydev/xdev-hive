import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../../test/org-fixture.ts";
import { seedProject } from "../../../../test/project-fixture.ts";
import { provideDocSaved, saveDoc } from "../../knowledge/index.ts";
import { createPool, createPostgresBlobStore, type Jobs, parseMasterKey, withTenant } from "../../platform/index.ts";
import { createMemoryProvider } from "../../scm/index.ts";
import { configureProjectHome, type HomeRow } from "../homes.ts";
import { DOCSYNC_PUSH_QUEUE } from "../jobs.ts";
import { docSavedHandler, pushHome } from "../push.ts";
import { commitWordImport } from "./commit.ts";

// Test chèn file `ready` thẳng vào bảng, không cần job chuyển (T009) hay pandoc.
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
const deps = { pool, jobs, masterKey, providerFactory: () => mem, publicUrl: "https://hive.example" };
const blobStore = createPostgresBlobStore();
const projectKey = `wc${tag}`;
const FAKE_KEY = `AKIA${"Q".repeat(16)}`;

let org: Awaited<ReturnType<typeof seedOrg>>;
let project: Awaited<ReturnType<typeof seedProject>>;
let home: HomeRow;
const actor = (name: string) => ({ userId: org.user(name), orgId: org.orgId });
const as = <T>(name: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, actor(name), fn);
const user = (name: string) => ({ kind: "user" as const, userId: org.user(name) });
const key = (path: string) => `project/${projectKey}/${path}`;
const repo = () => {
  const r = mem.repos.get(`${project.owner}/${project.repo}`.toLowerCase());
  if (!r) throw new Error("thiếu repo");
  return r;
};
const mainFile = (path: string) => repo().branches.get("main")?.get(path);
const syncCommits = () => repo().commits.filter((c) => c.branch === "main" && c.message.includes("Hive-Doc-Sync:"));
const pushes = () => queued.filter((job) => job.queue === DOCSYNC_PUSH_QUEUE && job.data.homeId === home.id);
/** Đẩy mốc gom về quá khứ thay vì chờ 60 giây thật. */
const push = async () => {
  await admin.query(
    "update hive.doc_homes set last_saved_at = now() - interval '2 minutes', first_queued_at = now() - interval '2 minutes' where id = $1",
    [home.id],
  );
  return pushHome(deps, { orgId: org.orgId, homeId: home.id });
};

const png = (seed: string) => {
  const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(seed)]);
  return { bytes, name: `${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.png` };
};

async function putImage(seed: string) {
  const { bytes, name } = png(seed);
  const blob = await as("tadmin", (tx) =>
    blobStore.put(
      tx,
      org.orgId,
      (async function* () {
        yield bytes;
      })(),
      "image/png",
    ),
  );
  return { name, blobId: blob.id, mediaType: "image/png", bytes: bytes.length };
}

interface FileSeed {
  fileName: string;
  relativeDir?: string;
  proposedPath: string | null;
  pathOverride?: string;
  title?: string;
  markdown: string;
  images?: Array<{ name: string; blobId: string; mediaType: string; bytes: number }>;
  state?: string;
}

/** Lượt `create` có các file đã chuyển xong, ghi bằng superuser như job chuyển sẽ ghi. */
async function seedImport(files: FileSeed[], opts: { targetDir?: string; confidential?: boolean } = {}) {
  const { rows } = await admin.query(
    `insert into hive.doc_word_imports (org_id, home_id, target_dir, mode, confidential, state, created_by)
     values ($1, $2, $3, 'create', $4, 'ready', $5) returning id`,
    [org.orgId, home.id, opts.targetDir ?? "docs/srs", opts.confidential ?? false, org.user("tadmin")],
  );
  const importId: string = rows[0].id;
  const ids: string[] = [];
  for (const f of files) {
    const res = await admin.query(
      `insert into hive.doc_word_import_files
         (org_id, import_id, relative_dir, file_name, format, size, sha256, proposed_path, proposed_title, path_override,
          state, markdown, images)
       values ($1, $2, $3, $4, 'docx', 100, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [
        org.orgId,
        importId,
        f.relativeDir ?? "",
        f.fileName,
        createHash("sha256").update(f.fileName).digest("hex"),
        f.proposedPath,
        f.title ?? f.fileName.replace(/\.docx$/, ""),
        f.pathOverride ?? null,
        f.state ?? "ready",
        f.markdown,
        JSON.stringify(f.images ?? []),
      ],
    );
    ids.push(res.rows[0].id);
  }
  return { importId, ids };
}

const fileRow = async (id: string) =>
  (await admin.query("select * from hive.doc_word_import_files where id = $1", [id])).rows[0];
const importRow = async (id: string) =>
  (await admin.query("select * from hive.doc_word_imports where id = $1", [id])).rows[0];
const repoPathOf = async (docId: string) =>
  (await admin.query("select repo_path, state from hive.doc_repo_files where doc_id = $1", [docId])).rows;

beforeAll(async () => {
  org = await seedOrg(admin, `dwc-${tag}`);
  project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
  mem.seedRepo({ owner: project.owner, name: project.repo }, { files: { "README.md": "# Repo\n" } });
  home = await as("tadmin", (tx) =>
    configureProjectHome(tx, deps, actor("tadmin"), {
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
    }),
  );
  provideDocSaved(docSavedHandler(jobs));
});

beforeEach(() => {
  queued.length = 0;
});

afterAll(async () => {
  provideDocSaved(undefined);
  await Promise.all([admin.end(), pool.end()]);
});

describe("tạo tài liệu từ lượt nhập Word", () => {
  it("một lô đẩy có Markdown và ảnh, không có file Word gốc (Q6)", async () => {
    const logo = await putImage(`logo-${tag}`);
    const { importId, ids } = await seedImport([
      {
        fileName: "OPD17_v1.2.docx",
        proposedPath: "docs/srs/opd17.md",
        title: "OPD17 Khám bệnh",
        markdown: `# OPD17\n\n![](${logo.name})\n`,
        images: [logo],
      },
      {
        fileName: "OPD18.docx",
        proposedPath: "docs/srs/opd18.md",
        markdown: `# OPD18\n\n![](${logo.name})\n`,
        images: [logo],
      },
    ]);
    const out = await as("tadmin", (tx) => commitWordImport(tx, deps, user("tadmin"), { importId }));
    expect(out.import.state).toBe("done");
    expect(out.import.counts.done).toBe(2);
    expect(out.files.map((f) => [f.key, f.state, f.docVersion, f.exists])).toEqual([
      [key("srs/opd17"), "done", 1, true],
      [key("srs/opd18"), "done", 1, true],
    ]);
    expect(pushes().length).toBeGreaterThan(0);

    const first = await fileRow(ids[0] ?? "");
    const { rows: versions } = await admin.query(
      "select v.content, v.source from hive.doc_versions v where v.doc_id = $1",
      [first.doc_id],
    );
    expect(versions).toHaveLength(1);
    expect(versions[0].source).toBe("word");
    expect(versions[0].content).toBe(
      [
        "---",
        'title: "OPD17 Khám bệnh"',
        "word:",
        '  file: "OPD17_v1.2.docx"',
        `  sha256: "${first.sha256}"`,
        "---",
        "",
        "# OPD17",
        "",
        `![](../assets/${logo.name})`,
        "",
      ].join("\n"),
    );
    const { rows: assets } = await admin.query(
      "select repo_path, state, blob_id, owner_doc_id from hive.doc_assets where home_id = $1 and repo_path like $2",
      [home.id, `%${logo.name}`],
    );
    // Hai tài liệu cùng logo: một dòng ảnh, trỏ blob đã có từ lúc chuyển.
    expect(assets).toEqual([
      {
        repo_path: `docs/assets/${logo.name}`,
        state: "pending_push",
        blob_id: logo.blobId,
        owner_doc_id: first.doc_id,
      },
    ]);
    const { rows: audits } = await admin.query(
      "select action from hive.audit_log where org_id = $1 and data->>'importId' = $2",
      [org.orgId, importId],
    );
    expect(audits.map((a) => a.action)).toEqual(["docs.word_import", "docs.word_import"]);

    const before = syncCommits().length;
    expect(await push()).toBe("pushed");
    const commits = syncCommits();
    expect(commits).toHaveLength(before + 1);
    const commit = commits.at(-1);
    expect(commit?.paths.toSorted()).toEqual(
      [`docs/assets/${logo.name}`, "docs/srs/opd17.md", "docs/srs/opd18.md"].toSorted(),
    );
    expect(commit?.paths.some((p) => /\.(docx|odt|doc)$/.test(p))).toBe(false);
    expect(mainFile("docs/srs/opd17.md")).toContain(`![](../assets/${logo.name})`);
    expect(mainFile(`docs/assets/${logo.name}`)).toBeDefined();
  });

  it("giữ hoa thường của đường dẫn đã chọn", async () => {
    const { importId, ids } = await seedImport(
      [
        {
          fileName: "OPD02.docx",
          proposedPath: "docs/opd/opd02.md",
          pathOverride: "docs/OPD/OPD02.md",
          markdown: "# OPD02\n",
        },
      ],
      { targetDir: "docs/opd" },
    );
    const out = await as("tadmin", (tx) => commitWordImport(tx, deps, user("tadmin"), { importId }));
    expect(out.files[0]).toMatchObject({ state: "done", path: "docs/OPD/OPD02.md", key: key("opd/opd02") });
    const row = await fileRow(ids[0] ?? "");
    expect(await repoPathOf(row.doc_id)).toEqual([{ repo_path: "docs/OPD/OPD02.md", state: "pending" }]);
    expect(await push()).toBe("pushed");
    expect(mainFile("docs/OPD/OPD02.md")).toContain("# OPD02");
    expect(mainFile("docs/opd/opd02.md")).toBeUndefined();
  });

  it("tài liệu mật ghi `confidential: true` vào front matter", async () => {
    const { importId, ids } = await seedImport(
      [{ fileName: "Mat.docx", proposedPath: "docs/mat/mat.md", markdown: "# Mật\n" }],
      { targetDir: "docs/mat", confidential: true },
    );
    await as("tadmin", (tx) => commitWordImport(tx, deps, user("tadmin"), { importId }));
    const row = await fileRow(ids[0] ?? "");
    const { rows } = await admin.query("select content from hive.doc_versions where doc_id = $1", [row.doc_id]);
    expect(rows[0].content).toMatch(/\nconfidential: true\n---\n/);
  });

  it("bí mật chặn file đó, xác nhận rồi mới tạo và ghi audit kèm hash nội dung (FR-018)", async () => {
    const { importId, ids } = await seedImport([
      { fileName: "Secret.docx", proposedPath: "docs/sec/secret.md", markdown: `# Cấu hình\n\nkey = ${FAKE_KEY}\n` },
      { fileName: "Clean.docx", proposedPath: "docs/sec/clean.md", markdown: "# Sạch\n" },
    ]);
    const out = await as("tadmin", (tx) => commitWordImport(tx, deps, user("tadmin"), { importId }));
    expect(out.files.map((f) => [f.fileName, f.state])).toEqual([
      ["Clean.docx", "done"],
      ["Secret.docx", "blocked_secret"],
    ]);
    const blocked = await fileRow(ids[0] ?? "");
    // Dòng tính trên tài liệu sẽ lưu: 7 dòng front matter rồi mới tới thân.
    expect(blocked.findings).toEqual([{ kind: "aws_access_key", line: 10 }]);
    expect(JSON.stringify(blocked.findings)).not.toContain(FAKE_KEY);
    expect(out.import.state).not.toBe("done");

    const again = await as("tadmin", (tx) =>
      commitWordImport(tx, deps, user("tadmin"), { importId, acknowledgeSecrets: true }),
    );
    expect(again.files.map((f) => f.state)).toEqual(["done", "done"]);
    expect(again.import.state).toBe("done");
    const done = await fileRow(ids[0] ?? "");
    expect(done.findings).toEqual([]);
    const { rows } = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'doc.secrets.acknowledge' and data->>'key' = $2",
      [org.orgId, key("sec/secret")],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data.contentHash).toMatch(/\S/);
    expect(JSON.stringify(rows[0].data)).not.toContain(FAKE_KEY);
  });

  it("trùng tài liệu có sẵn, trùng đường dẫn trong lượt, ngoài nhà: ghi lỗi vào file, file khác vẫn tạo", async () => {
    await as("tadmin", (tx) =>
      saveDoc(tx, user("tadmin"), { key: key("dup/existing"), content: "# Có sẵn\n", baseVersion: 0 }),
    );
    const { importId } = await seedImport([
      { fileName: "Existing.docx", proposedPath: "docs/dup/existing.md", markdown: "# Mới\n" },
      { fileName: "A.docx", relativeDir: "a", proposedPath: "docs/dup/same.md", markdown: "# A\n" },
      { fileName: "B.docx", relativeDir: "b", proposedPath: "docs/dup/Same.md", markdown: "# B\n" },
      { fileName: "Out.docx", proposedPath: "other/out.md", markdown: "# Ngoài\n" },
      { fileName: "Ok.docx", proposedPath: "docs/dup/ok.md", markdown: "# Ok\n" },
    ]);
    const out = await as("tadmin", (tx) => commitWordImport(tx, deps, user("tadmin"), { importId }));
    const byName = Object.fromEntries(out.files.map((f) => [f.fileName, [f.state, f.error?.code ?? null]]));
    expect(byName).toEqual({
      "Existing.docx": ["ready", "WORD_IMPORT_EXISTS"],
      "A.docx": ["ready", "WORD_IMPORT_DUPLICATE_PATH"],
      "B.docx": ["ready", "WORD_IMPORT_DUPLICATE_PATH"],
      "Out.docx": ["ready", "WORD_IMPORT_OUTSIDE_HOME"],
      "Ok.docx": ["done", null],
    });
    const { rows } = await admin.query("select current_version from hive.docs where key = $1", [key("dup/existing")]);
    expect(rows).toEqual([{ current_version: 1 }]);
  });

  it("nhập lại tài liệu đã tạo ở lượt trước, khác hoa thường, thì báo đã có (FR-019)", async () => {
    const { importId } = await seedImport([
      { fileName: "Opd17.docx", proposedPath: "docs/srs/OPD17.md", markdown: "# Lần hai\n" },
    ]);
    const out = await as("tadmin", (tx) => commitWordImport(tx, deps, user("tadmin"), { importId }));
    expect(out.files[0]).toMatchObject({ state: "ready", error: { code: "WORD_IMPORT_EXISTS" } });
  });

  it("bấm tạo lần hai không tạo lại file đã xong", async () => {
    const { importId, ids } = await seedImport([
      { fileName: "Twice.docx", proposedPath: "docs/twice/twice.md", markdown: "# Twice\n" },
    ]);
    await as("tadmin", (tx) => commitWordImport(tx, deps, user("tadmin"), { importId }));
    const again = await as("tadmin", (tx) => commitWordImport(tx, deps, user("tadmin"), { importId }));
    expect(again.files[0]).toMatchObject({ state: "done", docVersion: 1, error: null });
    const row = await fileRow(ids[0] ?? "");
    const { rows } = await admin.query("select count(*)::int as n from hive.doc_versions where doc_id = $1", [
      row.doc_id,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it("chỉ tạo các file được chọn, bỏ qua file bị loại", async () => {
    const { importId, ids } = await seedImport([
      { fileName: "Pick.docx", proposedPath: "docs/pick/pick.md", markdown: "# Pick\n" },
      { fileName: "Later.docx", proposedPath: "docs/pick/later.md", markdown: "# Later\n" },
    ]);
    const out = await as("tadmin", (tx) =>
      commitWordImport(tx, deps, user("tadmin"), { importId, fileIds: [ids[0] ?? ""] }),
    );
    expect(out.files.map((f) => [f.fileName, f.state])).toEqual([
      ["Later.docx", "ready"],
      ["Pick.docx", "done"],
    ]);
    expect((await importRow(importId)).state).toBe("ready");
    await admin.query("update hive.doc_word_import_files set excluded = true where id = $1", [ids[1]]);
    const rest = await as("tadmin", (tx) => commitWordImport(tx, deps, user("tadmin"), { importId }));
    expect(rest.files.find((f) => f.fileName === "Later.docx")?.state).toBe("ready");
    expect(rest.import.state).toBe("done");
  });

  it("file không thuộc lượt thì báo không tìm thấy", async () => {
    const { importId } = await seedImport([{ fileName: "X.docx", proposedPath: "docs/x/x.md", markdown: "# X\n" }]);
    await expect(
      as("tadmin", (tx) => commitWordImport(tx, deps, user("tadmin"), { importId, fileIds: [randomUUID()] })),
    ).rejects.toMatchObject({ code: "WORD_IMPORT_FILE_NOT_FOUND" });
  });

  it("thiếu quyền quản lý thì báo cần quyền quản lý, không tạo gì (Q2)", async () => {
    const { importId, ids } = await seedImport([
      { fileName: "NoManage.docx", proposedPath: "docs/nm/nomanage.md", markdown: "# NM\n" },
    ]);
    await expect(
      as("tviewer", (tx) => commitWordImport(tx, deps, user("tviewer"), { importId })),
    ).rejects.toMatchObject({ code: "WORD_IMPORT_NEEDS_MANAGE" });
    expect((await fileRow(ids[0] ?? "")).doc_id).toBeNull();
    const { rows } = await admin.query("select 1 from hive.docs where key = $1", [key("nm/nomanage")]);
    expect(rows).toHaveLength(0);
  });

  it("ảnh cùng tên khác nội dung với ảnh đã có trong nhà thì không tạo file đó", async () => {
    const logo = await putImage(`conflict-${tag}`);
    await admin.query(
      `insert into hive.doc_assets (org_id, home_id, repo_path, blob_id, media_type, size, sha256, state)
       values ($1, $2, $3, $4, 'image/png', 1, $5, 'available')`,
      [org.orgId, home.id, `docs/assets/${logo.name}`, logo.blobId, "0".repeat(64)],
    );
    const { importId } = await seedImport([
      {
        fileName: "Img.docx",
        proposedPath: "docs/img/img.md",
        markdown: `# Img\n\n![](${logo.name})\n`,
        images: [logo],
      },
    ]);
    const out = await as("tadmin", (tx) => commitWordImport(tx, deps, user("tadmin"), { importId }));
    expect(out.files[0]).toMatchObject({ state: "ready", error: { code: "WORD_IMPORT_EXISTS" } });
    const { rows } = await admin.query("select 1 from hive.docs where key = $1", [key("img/img")]);
    expect(rows).toHaveLength(0);
  });
});
