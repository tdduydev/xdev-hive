import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../../test/org-fixture.ts";
import { seedProject } from "../../../../test/project-fixture.ts";
import type { Auth } from "../../identity/index.ts";
import {
  approveProposal,
  provideDocSaved,
  provideProposalApproved,
  rejectProposal,
  saveDoc,
} from "../../knowledge/index.ts";
import { createPool, createPostgresBlobStore, type Jobs, parseMasterKey, withTenant } from "../../platform/index.ts";
import { createMemoryProvider } from "../../scm/index.ts";
import { ORG_HEADER } from "../../tenancy/index.ts";
import { configureProjectHome, type HomeRow } from "../homes.ts";
import { DOCSYNC_PUSH_QUEUE } from "../jobs.ts";
import { docSavedHandler, pushHome } from "../push.ts";
import { approveWordImport } from "../routes/word-staging.ts";
import { commitWordImport } from "./commit.ts";
import { handleWordMedia } from "./media.ts";
import { sweepWordStaging, wordProposalApproved } from "./staging.ts";

// US4: thành viên đội (chỉ có `propose`) nhập Word thành đề xuất; quản trị duyệt hoặc từ chối.
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
const projectKey = `ws${tag}`;
const FAKE_KEY = `AKIA${"Q".repeat(16)}`;

let org: Awaited<ReturnType<typeof seedOrg>>;
let project: Awaited<ReturnType<typeof seedProject>>;
let home: HomeRow;
let unregister: () => void;
const actor = (name: string) => ({ userId: org.user(name), orgId: org.orgId });
const as = <T>(name: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, actor(name), fn);
const user = (name: string) => ({ kind: "user" as const, userId: org.user(name) });
const key = (path: string) => `project/${projectKey}/${path}`;
const repo = () => {
  const r = mem.repos.get(`${project.owner}/${project.repo}`.toLowerCase());
  if (!r) throw new Error("thiếu repo");
  return r;
};
const syncCommits = () => repo().commits.filter((c) => c.branch === "main" && c.message.includes("Hive-Doc-Sync:"));
const pushes = () => queued.filter((job) => job.queue === DOCSYNC_PUSH_QUEUE && job.data.homeId === home.id);

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

/** Lượt `create` của `tmember` có một file đã chuyển xong, ghi bằng superuser như job chuyển sẽ ghi. */
async function seedImport(fileName: string, path: string, markdown: string, images: unknown[] = []) {
  const { rows } = await admin.query(
    `insert into hive.doc_word_imports (org_id, home_id, target_dir, mode, state, created_by)
     values ($1, $2, $3, 'create', 'ready', $4) returning id`,
    [org.orgId, home.id, path.replace(/\/[^/]+$/, ""), org.user("tmember")],
  );
  const importId: string = rows[0].id;
  const blob = await putImage(`original-${fileName}-${tag}`);
  const res = await admin.query(
    `insert into hive.doc_word_import_files
       (org_id, import_id, file_name, format, size, sha256, blob_id, proposed_path, proposed_title, state, markdown, images)
     values ($1, $2, $3, 'docx', 100, $4, $5, $6, $7, 'ready', $8, $9) returning id`,
    [
      org.orgId,
      importId,
      fileName,
      createHash("sha256").update(fileName).digest("hex"),
      blob.blobId,
      path,
      fileName.replace(/\.docx$/, ""),
      markdown,
      JSON.stringify(images),
    ],
  );
  return { importId, fileId: res.rows[0].id as string };
}

const fileRow = async (id: string) =>
  (await admin.query("select * from hive.doc_word_import_files where id = $1", [id])).rows[0];
const docOf = async (docKey: string) =>
  (await admin.query("select id, current_version from hive.docs where key = $1", [docKey])).rows[0];
const assetsLike = async (name: string) =>
  (
    await admin.query(
      "select repo_path, state, owner_doc_id from hive.doc_assets where home_id = $1 and repo_path like $2",
      [home.id, `%${name}`],
    )
  ).rows;

const fakeAuth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get("x-test-user");
      return id ? { user: { id }, session: {} } : null;
    },
  },
} as unknown as Auth;

function media(who: string, importId: string, fileId: string, name: string) {
  const request = new Request(`http://hub.test/api/v1/docs/word-imports/${importId}/files/${fileId}/media/${name}`, {
    headers: { "x-test-user": org.user(who), [ORG_HEADER]: org.orgId },
  });
  return handleWordMedia({ pool, auth: fakeAuth }, request, { importId, fileId, name });
}

/** Đề xuất của tmember cho một file có ảnh, chưa ai duyệt. */
async function proposed(name: string) {
  const logo = await putImage(`${name}-${tag}`);
  const path = `docs/${name}/${name.toUpperCase()}.md`;
  const seeded = await seedImport(`${name}.docx`, path, `# ${name}\n\n![](${logo.name})\n`, [logo]);
  const out = await as("tmember", (tx) => commitWordImport(tx, deps, user("tmember"), { importId: seeded.importId }));
  return { ...seeded, logo, path, docKey: key(`${name}/${name}`), out };
}

beforeAll(async () => {
  org = await seedOrg(admin, `dws-${tag}`);
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
  unregister = provideProposalApproved(wordProposalApproved(jobs));
});

beforeEach(() => {
  queued.length = 0;
});

afterAll(async () => {
  unregister();
  provideDocSaved(undefined);
  await Promise.all([admin.end(), pool.end()]);
});

describe("đề xuất từ Word cho người chỉ có propose", () => {
  it("gửi duyệt: đề xuất nguồn Word, chưa có tài liệu hay ảnh trong nhà; duyệt thì tạo như US1", async () => {
    const p = await proposed("opd30");
    expect(p.out.access).toBe("propose");
    expect(p.out.import.state).toBe("done");
    expect(p.out.import.counts.proposed).toBe(1);
    const staged = await fileRow(p.fileId);
    expect(staged.state).toBe("proposed");
    expect(staged.proposal_id).not.toBeNull();
    expect(p.out.files[0]?.proposalId).toBe(staged.proposal_id);
    const { rows: proposals } = await admin.query(
      "select target, status, origin, base_version from hive.proposals where id = $1",
      [staged.proposal_id],
    );
    expect(proposals[0]).toEqual({
      target: p.docKey,
      status: "pending",
      origin: { kind: "word", importFileId: p.fileId },
      base_version: 0,
    });
    expect(await docOf(p.docKey)).toBeUndefined();
    expect(await assetsLike(p.logo.name)).toEqual([]);
    expect(pushes()).toEqual([]);

    // Người nhập và quản trị (người duyệt) xem được ảnh; đội khác thì không.
    expect((await media("tmember", p.importId, p.fileId, p.logo.name)).status).toBe(200);
    expect((await media("tadmin", p.importId, p.fileId, p.logo.name)).status).toBe(200);
    expect((await media("oadmin", p.importId, p.fileId, p.logo.name)).status).toBe(404);

    const out = await as("tadmin", (tx) =>
      approveWordImport(tx, user("tadmin"), { importId: p.importId, fileIds: [p.fileId] }),
    );
    expect(out.files[0]).toMatchObject({ state: "done", docVersion: 1, exists: true });
    const doc = await docOf(p.docKey);
    expect(doc.current_version).toBe(1);
    const { rows: versions } = await admin.query("select source, content from hive.doc_versions where doc_id = $1", [
      doc.id,
    ]);
    expect(versions).toHaveLength(1);
    expect(versions[0].source).toBe("word");
    expect(versions[0].content).toContain(`![](../assets/${p.logo.name})`);
    // Đường dẫn giữ hoa thường như lúc nhập; ảnh vào thư mục ảnh của nhà, chờ lô đẩy.
    const { rows: files } = await admin.query("select repo_path from hive.doc_repo_files where doc_id = $1", [doc.id]);
    expect(files).toEqual([{ repo_path: p.path }]);
    expect(await assetsLike(p.logo.name)).toEqual([
      { repo_path: `docs/assets/${p.logo.name}`, state: "pending_push", owner_doc_id: doc.id },
    ]);
    expect(pushes().length).toBeGreaterThan(0);
    const { rows: audits } = await admin.query(
      "select action from hive.audit_log where org_id = $1 and data->>'fileId' = $2",
      [org.orgId, p.fileId],
    );
    expect(audits.map((a) => a.action)).toEqual(["docs.word_import"]);
    expect((await fileRow(p.fileId)).doc_id).toBe(doc.id);

    await admin.query(
      "update hive.doc_homes set last_saved_at = now() - interval '2 minutes', first_queued_at = now() - interval '2 minutes' where id = $1",
      [home.id],
    );
    const before = syncCommits().length;
    expect(await pushHome(deps, { orgId: org.orgId, homeId: home.id })).toBe("pushed");
    expect(syncCommits()).toHaveLength(before + 1);
    expect(syncCommits().at(-1)?.paths.toSorted()).toEqual([`docs/assets/${p.logo.name}`, p.path].toSorted());
  });

  it("duyệt từ trang đề xuất cũng chạy hook của Word", async () => {
    const p = await proposed("opd31");
    const proposalId = (await fileRow(p.fileId)).proposal_id;
    await as("tadmin", (tx) => approveProposal(tx, user("tadmin"), { id: proposalId }));
    const file = await fileRow(p.fileId);
    expect(file.state).toBe("done");
    expect(file.doc_id).toBe((await docOf(p.docKey)).id);
    expect(await assetsLike(p.logo.name)).toHaveLength(1);
  });

  it("người chỉ có propose không duyệt được", async () => {
    const p = await proposed("opd32");
    await expect(
      as("tmember", (tx) => approveWordImport(tx, user("tmember"), { importId: p.importId, fileIds: [p.fileId] })),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(await docOf(p.docKey)).toBeUndefined();
  });

  it("file chưa gửi duyệt thì không duyệt được", async () => {
    const seeded = await seedImport("Draft.docx", "docs/draft/draft.md", "# Draft\n");
    await expect(
      as("tadmin", (tx) =>
        approveWordImport(tx, user("tadmin"), { importId: seeded.importId, fileIds: [seeded.fileId] }),
      ),
    ).rejects.toMatchObject({ code: "WORD_IMPORT_NOT_PROPOSED" });
  });

  it("từ chối thì lần dọn kế tiếp bỏ file và ảnh giữ tạm, không có gì trong nhà", async () => {
    const p = await proposed("opd33");
    const proposalId = (await fileRow(p.fileId)).proposal_id;
    await as("tadmin", (tx) => rejectProposal(tx, user("tadmin"), { id: proposalId, note: "Chưa đúng mẫu" }));
    expect(await as("tadmin", (tx) => sweepWordStaging(tx, 30))).toBeGreaterThanOrEqual(1);
    const file = await fileRow(p.fileId);
    expect(file).toMatchObject({ state: "cancelled", blob_id: null, markdown: null, images: [] });
    expect(await docOf(p.docKey)).toBeUndefined();
    expect(await assetsLike(p.logo.name)).toEqual([]);
    expect((await media("tmember", p.importId, p.fileId, p.logo.name)).status).toBe(404);
  });

  it("chờ quá hạn giữ thì dọn; duyệt sau đó báo đã dọn và không tạo tài liệu", async () => {
    const p = await proposed("opd34");
    const fresh = await proposed("opd35");
    const proposalId = (await fileRow(p.fileId)).proposal_id;
    await admin.query("update hive.proposals set created_at = now() - interval '31 days' where id = $1", [proposalId]);
    await as("tadmin", (tx) => sweepWordStaging(tx, 30));
    expect((await fileRow(p.fileId)).state).toBe("cancelled");
    expect((await fileRow(fresh.fileId)).state).toBe("proposed");
    await expect(as("tadmin", (tx) => approveProposal(tx, user("tadmin"), { id: proposalId }))).rejects.toMatchObject({
      code: "WORD_IMPORT_STAGING_GONE",
    });
    expect(await docOf(p.docKey)).toBeUndefined();
    const { rows } = await admin.query("select status from hive.proposals where id = $1", [proposalId]);
    expect(rows[0].status).toBe("pending");
  });

  it("có chuỗi giống bí mật thì chặn; người chỉ có propose không xác nhận được", async () => {
    const seeded = await seedImport("Secret.docx", "docs/sec/secret.md", `# Cấu hình\n\nkey = ${FAKE_KEY}\n`);
    const blocked = await as("tmember", (tx) =>
      commitWordImport(tx, deps, user("tmember"), { importId: seeded.importId }),
    );
    expect(blocked.files[0]?.state).toBe("blocked_secret");
    const acked = await as("tmember", (tx) =>
      commitWordImport(tx, deps, user("tmember"), { importId: seeded.importId, acknowledgeSecrets: true }),
    );
    expect(acked.files[0]).toMatchObject({
      state: "blocked_secret",
      proposalId: null,
      error: { code: "WORD_IMPORT_NEEDS_MANAGE" },
    });
  });

  it("đường dẫn đã có tài liệu thì không gửi đề xuất", async () => {
    await as("tadmin", (tx) =>
      saveDoc(tx, user("tadmin"), { key: key("dup/dup"), content: "# Có sẵn\n", baseVersion: 0 }),
    );
    const seeded = await seedImport("Dup.docx", "docs/dup/dup.md", "# Dup\n");
    const out = await as("tmember", (tx) => commitWordImport(tx, deps, user("tmember"), { importId: seeded.importId }));
    expect(out.files[0]).toMatchObject({ state: "ready", proposalId: null, error: { code: "WORD_IMPORT_EXISTS" } });
  });
});
