import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../../test/org-fixture.ts";
import { seedProject } from "../../../../test/project-fixture.ts";
import { getDoc, provideDocSaved, saveDoc } from "../../knowledge/index.ts";
import { createPool, createPostgresBlobStore, type Jobs, parseMasterKey, withTenant } from "../../platform/index.ts";
import { createMemoryProvider } from "../../scm/index.ts";
import { getConflict, listConflicts, resolveConflict } from "../conflicts.ts";
import { configureProjectHome, type HomeRow } from "../homes.ts";
import { docSavedHandler, pushHome } from "../push.ts";
import { docWordImportFiles } from "../schema.ts";
import { commitWordImport } from "./commit.ts";
import { frontMatter } from "./postprocess.ts";
import { planUpdate, prepareUpdate } from "./update.ts";

// Test chèn file đã chuyển thẳng vào bảng, không cần pandoc; lượt đầu đi qua bước tạo thật (T010) để có gốc.
const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const mem = createMemoryProvider("gitlab", ["xdev-team"]);
const jobs = { enqueue: async () => randomUUID() } as unknown as Jobs;
const deps = { pool, jobs, masterKey, providerFactory: () => mem, publicUrl: "https://hive.example" };
const blobStore = createPostgresBlobStore();
const projectKey = `wu${tag}`;

let org: Awaited<ReturnType<typeof seedOrg>>;
let project: Awaited<ReturnType<typeof seedProject>>;
let home: HomeRow;
const actor = (name: string) => ({ userId: org.user(name), orgId: org.orgId });
const as = <T>(name: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, actor(name), fn);
const user = (name: string) => ({ kind: "user" as const, userId: org.user(name) });
const repo = () => {
  const r = mem.repos.get(`${project.owner}/${project.repo}`.toLowerCase());
  if (!r) throw new Error("thiếu repo");
  return r;
};
const mainFile = (path: string) => repo().branches.get("main")?.get(path);
const syncCommits = () => repo().commits.filter((c) => c.branch === "main" && c.message.includes("Hive-Doc-Sync:"));
const push = async () => {
  await admin.query(
    "update hive.doc_homes set last_saved_at = now() - interval '2 minutes', first_queued_at = now() - interval '2 minutes' where id = $1",
    [home.id],
  );
  return pushHome(deps, { orgId: org.orgId, homeId: home.id });
};

type Image = { name: string; blobId: string; mediaType: string; bytes: number };

async function putImage(seed: string): Promise<Image> {
  const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(seed)]);
  const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.png`;
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

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** Markdown như job chuyển ghi: front matter của lần chuyển rồi tới thân, link ảnh là tên ảnh. */
const converted = (fileName: string, body: string) =>
  frontMatter({ title: "OPD05", file: fileName, sha256: sha(fileName), confidential: false }) + body;

const body = (t1: string, t2: string, image: string) =>
  [
    "# OPD05",
    "",
    "## Bảng 1",
    "",
    "| A | B |",
    "| --- | --- |",
    `| 1 | ${t1} |`,
    "",
    "## Bảng 2",
    "",
    "| C | D |",
    "| --- | --- |",
    `| 3 | ${t2} |`,
    "",
    `![](${image})`,
    "",
  ].join("\n");

async function insertFile(importId: string, fileName: string, markdown: string, images: Image[], state = "ready") {
  const { rows } = await admin.query(
    `insert into hive.doc_word_import_files (org_id, import_id, file_name, format, size, sha256, proposed_path,
       proposed_title, state, markdown, images)
     values ($1, $2, $3, 'docx', 100, $4, $5, 'OPD05', $6, $7, $8) returning id`,
    [org.orgId, importId, fileName, sha(fileName), "docs/srs/opd05.md", state, markdown, JSON.stringify(images)],
  );
  return rows[0].id as string;
}

/** Lượt `update` có một file đã chuyển xong, rồi bước xem trước như job chuyển gọi. */
async function seedUpdate(docId: string, fileName: string, markdown: string, images: Image[] = []) {
  const { rows } = await admin.query(
    `insert into hive.doc_word_imports (org_id, home_id, mode, update_doc_id, state, created_by)
     values ($1, $2, 'update', $3, 'converting', $4) returning id`,
    [org.orgId, home.id, docId, org.user("tadmin")],
  );
  const importId: string = rows[0].id;
  const fileId = await insertFile(importId, fileName, markdown, images);
  await as("tadmin", async (tx) => {
    const [file] = await tx.select().from(docWordImportFiles).where(eq(docWordImportFiles.id, fileId));
    if (!file) throw new Error("thiếu file");
    await prepareUpdate(tx, file);
  });
  return { importId, fileId };
}

const commit = (importId: string, who = "tadmin") =>
  as(who, (tx) => commitWordImport(tx, deps, user(who), { importId }));
const fileRow = async (id: string) =>
  (await admin.query("select * from hive.doc_word_import_files where id = $1", [id])).rows[0];
const versions = async (docId: string) =>
  (
    await admin.query("select version, source, content from hive.doc_versions where doc_id = $1 order by version", [
      docId,
    ])
  ).rows as Array<{ version: number; source: string; content: string }>;
const assetState = async (name: string) =>
  (
    await admin.query("select state from hive.doc_assets where home_id = $1 and repo_path = $2", [
      home.id,
      `docs/assets/${name}`,
    ])
  ).rows[0]?.state;

beforeAll(async () => {
  org = await seedOrg(admin, `dwu-${tag}`);
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

afterAll(async () => {
  provideDocSaved(undefined);
  await Promise.all([admin.end(), pool.end()]);
});

describe("hợp ba bên (hàm thuần)", () => {
  const base = converted("v1.docx", body("2", "4", "aaaaaaaaaaaa.png"));
  const input = {
    title: "OPD05 Khám",
    fileName: "v2.docx",
    sha256: sha("v2.docx"),
    confidential: false,
    images: new Set(["bbbbbbbbbbbb.png"]),
    docPath: "docs/srs/opd05.md",
    assetsDir: "docs/assets",
  };

  it("link ảnh kiểu srs2md không thành chỗ sửa trên hub, ảnh mới trỏ vào thư mục ảnh của nhà", () => {
    const current = `---\ntitle: "OPD05"\nsource: srs2md\n---\n\n${body("2", "4", "../OPD/assets/aaaaaaaaaaaa.png")}`;
    const plan = planUpdate({
      ...input,
      base,
      current,
      markdown: converted("v2.docx", body("2", "40", "aaaaaaaaaaaa.png")),
    });
    expect(plan.conflicts).toBe(0);
    // Front matter của nơi khác giữ nguyên; ảnh không đổi giữ đúng link cũ.
    expect(plan.content).toBe(
      `---\ntitle: "OPD05"\nsource: srs2md\n---\n\n${body("2", "40", "../OPD/assets/aaaaaaaaaaaa.png")}`,
    );
    expect(plan.used.size).toBe(0);

    const swapped = planUpdate({
      ...input,
      base,
      current,
      markdown: converted("v2.docx", body("2", "4", "bbbbbbbbbbbb.png")),
    });
    expect(swapped.content).toContain("![](../assets/bbbbbbbbbbbb.png)");
    expect([...swapped.used]).toEqual(["bbbbbbbbbbbb.png"]);
  });

  it("front matter của bước nhập được dựng lại theo bản mới, giữ tiêu đề và nhãn mật trên hub", () => {
    const current = `${frontMatter({ title: "OPD05 Khám", file: "v1.docx", sha256: sha("v1.docx"), confidential: true })}${body("2", "4", "../assets/aaaaaaaaaaaa.png")}`;
    const plan = planUpdate({
      ...input,
      base,
      current,
      markdown: converted("v2.docx", body("2", "4", "aaaaaaaaaaaa.png")),
    });
    expect(plan.content).toBe(
      frontMatter({ title: "OPD05 Khám", file: "v2.docx", sha256: sha("v2.docx"), confidential: true }) +
        body("2", "4", "../assets/aaaaaaaaaaaa.png"),
    );
  });

  it("cùng sửa một khối thì đếm xung đột và giữ bản trên hub", () => {
    const current = converted("v1.docx", body("20", "4", "../assets/aaaaaaaaaaaa.png"));
    const plan = planUpdate({
      ...input,
      base,
      current,
      markdown: converted("v2.docx", body("99", "4", "aaaaaaaaaaaa.png")),
    });
    expect(plan.conflicts).toBe(1);
    expect(plan.content).toContain("| 1 | 20 |");
    expect(plan.word).toContain("| 1 | 99 |");
    expect(plan.word).toContain("![](../assets/aaaaaaaaaaaa.png)");
    expect(plan.base).toContain("| 1 | 2 |");
  });
});

describe("cập nhật tài liệu từ bản Word mới (US3)", () => {
  it("hợp sạch, rồi xung đột không ghi đè, rồi tải lại đúng file không tạo gì (SC-004)", async () => {
    const logo = await putImage(`logo-${tag}`);
    const chart = await putImage(`chart-${tag}`);

    // v1.0 qua bước tạo thật.
    const { rows } = await admin.query(
      `insert into hive.doc_word_imports (org_id, home_id, target_dir, mode, state, created_by)
       values ($1, $2, 'docs/srs', 'create', 'ready', $3) returning id`,
      [org.orgId, home.id, org.user("tadmin")],
    );
    const v1 = await insertFile(
      rows[0].id,
      "OPD05_v1.0.docx",
      converted("OPD05_v1.0.docx", body("2", "4", logo.name)),
      [logo],
    );
    await commit(rows[0].id);
    const docId: string = (await fileRow(v1)).doc_id;
    const key = `project/${projectKey}/srs/opd05`;
    expect(await push()).toBe("pushed");
    expect(await assetState(logo.name)).toBe("available");

    // Sửa bảng 1 trên hub.
    await as("tadmin", async (tx) => {
      const doc = await getDoc(tx, user("tadmin"), { key });
      await saveDoc(tx, user("tadmin"), {
        key,
        content: doc.content.replace("| 1 | 2 |", "| 1 | 20 |"),
        baseVersion: doc.version,
      });
    });

    // v1.1 đổi bảng 2 và thay ảnh: hợp sạch.
    const clean = await seedUpdate(
      docId,
      "OPD05_v1.1.docx",
      converted("OPD05_v1.1.docx", body("2", "40", chart.name)),
      [chart],
    );
    expect(await fileRow(clean.fileId)).toMatchObject({ state: "ready", link_matches: true });
    const out = await commit(clean.importId);
    expect(out.files[0]).toMatchObject({ state: "done", docId, docVersion: 3, linkMatches: true });
    expect(out.import.state).toBe("done");
    const v3 = (await versions(docId)).at(-1);
    expect(v3?.source).toBe("word");
    expect(v3?.content).toBe(
      frontMatter({ title: "OPD05", file: "OPD05_v1.1.docx", sha256: sha("OPD05_v1.1.docx"), confidential: false }) +
        body("20", "40", `../assets/${chart.name}`),
    );
    // Ảnh bỏ đi chờ xoá, ảnh mới chờ đẩy; lô kế tiếp ghi ảnh mới và xoá ảnh cũ khỏi repo (FR-026).
    expect(await assetState(logo.name)).toBe("pending_delete");
    expect(await assetState(chart.name)).toBe("pending_push");
    expect(await push()).toBe("pushed");
    expect(mainFile(`docs/assets/${chart.name}`)).toBeDefined();
    expect(mainFile(`docs/assets/${logo.name}`)).toBeUndefined();
    expect(mainFile("docs/srs/opd05.md")).toContain("| 1 | 20 |");
    const { rows: audits } = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'docs.word_update' and target_id = $2",
      [org.orgId, docId],
    );
    expect(audits).toEqual([{ data: expect.objectContaining({ fileId: clean.fileId, conflicts: 0, version: 3 }) }]);

    // v1.2 sửa đúng bảng 1 đã sửa trên hub: xung đột, không ghi đè.
    const clash = await seedUpdate(
      docId,
      "OPD05_v1.2.docx",
      converted("OPD05_v1.2.docx", body("99", "40", chart.name)),
      [chart],
    );
    expect(await fileRow(clash.fileId)).toMatchObject({ state: "ready", link_matches: false });
    const conflicted = await commit(clash.importId);
    expect(conflicted.files[0]).toMatchObject({ state: "done", docId, docVersion: null, linkMatches: false });
    expect((await versions(docId)).length).toBe(3);

    const list = await as("tadmin", (tx) => listConflicts(tx, user("tadmin"), {}));
    const item = list.items.find((c) => c.docId === docId);
    expect(item).toMatchObject({ origin: "word", repoCommit: null, repoPath: "docs/srs/opd05.md", state: "open" });
    const detail = await as("tadmin", (tx) => getConflict(tx, user("tadmin"), item?.id ?? ""));
    expect(detail.baseContent).toContain("| 1 | 2 |");
    expect(detail.hubContent).toContain("| 1 | 20 |");
    expect(detail.repoContent).toContain("| 1 | 99 |");
    expect(detail.merge.conflicts).toBe(1);

    // Đang có xung đột mở thì không cập nhật tiếp được.
    const blocked = await seedUpdate(
      docId,
      "OPD05_v1.3.docx",
      converted("OPD05_v1.3.docx", body("2", "41", chart.name)),
    );
    await expect(commit(blocked.importId)).rejects.toMatchObject({ code: "DOCSYNC_CONFLICT_OPEN" });

    // Lấy bản Word: phiên bản mới nguồn `word`, không đụng trạng thái đồng bộ repo.
    const before = (
      await admin.query("select synced_hash, synced_commit from hive.doc_repo_files where doc_id = $1", [docId])
    ).rows[0];
    let pushedHomes = 0;
    const resolved = await as("tadmin", (tx) =>
      resolveConflict(tx, user("tadmin"), { id: item?.id ?? "", choice: "repo", baseVersion: 3 }, async () => {
        pushedHomes++;
      }),
    );
    expect(resolved).toEqual({ key, version: 4 });
    expect(pushedHomes).toBe(1);
    const v4 = (await versions(docId)).at(-1);
    expect(v4?.source).toBe("word");
    expect(v4?.content).toContain("| 1 | 99 |");
    expect(
      (await admin.query("select synced_hash, synced_commit from hive.doc_repo_files where doc_id = $1", [docId]))
        .rows[0],
    ).toEqual(before);
    expect(
      (await admin.query("select state, resolution from hive.doc_conflicts where doc_id = $1", [docId])).rows,
    ).toEqual([{ state: "resolved", resolution: "repo" }]);
    expect(await push()).toBe("pushed");

    // Tải lại đúng file v1.2: không có gì thay đổi, không phiên bản, không commit (FR-025, SC-004).
    const commits = syncCommits().length;
    const same = await seedUpdate(
      docId,
      "OPD05_v1.2.docx",
      converted("OPD05_v1.2.docx", body("99", "40", chart.name)),
      [chart],
    );
    expect(await fileRow(same.fileId)).toMatchObject({ state: "skipped", doc_id: docId, doc_version: null });
    const again = await commit(same.importId);
    expect(again.files[0]?.state).toBe("skipped");
    expect((await versions(docId)).length).toBe(4);
    await push();
    expect(syncCommits().length).toBe(commits);
  });

  it("giữ bản hub khi giải quyết thì không tạo phiên bản", async () => {
    const doc = await as("tadmin", (tx) =>
      saveDoc(tx, user("tadmin"), {
        key: `project/${projectKey}/srs/giu`,
        content: `# Giữ\n\nhub sửa\n`,
        baseVersion: 0,
      }),
    );
    const { rows } = await admin.query(
      `insert into hive.doc_word_imports (org_id, home_id, mode, update_doc_id, state, created_by)
       values ($1, $2, 'link', $3, 'done', $4) returning id`,
      [org.orgId, home.id, doc.id, org.user("tadmin")],
    );
    const linked = await insertFile(rows[0].id, "Giu_v1.docx", "# Giữ\n\ngốc\n", [], "done");
    await admin.query("update hive.doc_word_import_files set doc_id = $1 where id = $2", [doc.id, linked]);

    const clash = await seedUpdate(doc.id, "Giu_v2.docx", "# Giữ\n\nWord sửa\n");
    await commit(clash.importId);
    const [conflict] = (await as("tadmin", (tx) => listConflicts(tx, user("tadmin"), {}))).items.filter(
      (c) => c.docId === doc.id,
    );
    expect(conflict?.origin).toBe("word");
    const resolved = await as("tadmin", (tx) =>
      resolveConflict(tx, user("tadmin"), { id: conflict?.id ?? "", choice: "hub", baseVersion: 1 }, async () => {
        throw new Error("không được xếp lô đẩy");
      }),
    );
    expect(resolved.version).toBe(1);
    expect((await versions(doc.id)).length).toBe(1);
  });

  it("tài liệu chưa nhập hay gắn với Word thì không cập nhật được", async () => {
    const doc = await as("tadmin", (tx) =>
      saveDoc(tx, user("tadmin"), { key: `project/${projectKey}/srs/moi`, content: "# Mới\n", baseVersion: 0 }),
    );
    const { importId, fileId } = await seedUpdate(doc.id, "Moi.docx", "# Mới\n\nWord\n");
    expect((await fileRow(fileId)).link_matches).toBeNull();
    await expect(commit(importId)).rejects.toMatchObject({ code: "WORD_IMPORT_NO_BASE" });
  });
});
