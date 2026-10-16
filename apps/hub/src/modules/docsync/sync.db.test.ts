import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import {
  DOC_INDEX_QUEUE,
  type Embedder,
  getDoc,
  listDocs,
  type Principal,
  provideDocIndexJobs,
  provideDocSaved,
  registerDocIndexWorker,
  saveDoc,
  saveDocFromSync,
  searchDocs,
} from "../knowledge/index.ts";
import { createPool, decryptSecret, ForbiddenError, type Jobs, parseMasterKey, withTenant } from "../platform/index.ts";
import { createMemoryProvider, type GitProvider } from "../scm/index.ts";
import { findDocAsset, listDocAssets } from "./assets.ts";
import { configureOrgHome, configureProjectHome, type HomeRow, homeSecretContext } from "./homes.ts";
import {
  confirmSecret,
  getImport,
  listImportFiles,
  listImports,
  runImport,
  scanImport,
  startImport,
} from "./import.ts";
import { DOCSYNC_IMPORT_QUEUE, DOCSYNC_PULL_QUEUE, DOCSYNC_PUSH_QUEUE } from "./jobs.ts";
import { pullHome } from "./pull.ts";
import { docSavedHandler, pushHome } from "./push.ts";
import { listTree } from "./routes/tree.ts";
import { runScan } from "./scan.ts";
import { handleDocsWebhook } from "./webhook.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
// Ghép lúc chạy để máy quét bí mật của repo không báo nhầm file test.
const FAKE_KEY = `AKIA${"Q".repeat(16)}`;
const PEM = `-----BEGIN RSA ${"PRIVATE"} KEY-----`;
/** Độ trễ mỗi lời gọi API Git, cỡ một request GitHub/GitLab qua mạng, để thời gian đo gần với chạy thật. */
const LATENCY_MS = 120;

const mem = createMemoryProvider("github", ["xdev-team"]);
const calls: string[] = [];
// Chạy đúng một lần ngay trước commitFiles kế tiếp: giả repo đổi giữa lúc lập lô và lúc commit.
let beforeCommit: (() => Promise<void>) | null = null;
const provider: GitProvider = new Proxy(mem, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") return value;
    return async (...args: unknown[]) => {
      calls.push(String(prop));
      await sleep(LATENCY_MS);
      if (prop === "commitFiles" && beforeCommit) {
        const hook = beforeCommit;
        beforeCommit = null;
        await hook();
      }
      return value.apply(target, args);
    };
  },
});

const queued: Array<{ queue: string; data: Record<string, unknown> }> = [];
const workers = new Map<string, (job: { data: unknown }) => Promise<void>>();
const jobs = {
  enqueue: async (queue: string, data: Record<string, unknown>) => {
    queued.push({ queue, data });
    return randomUUID();
  },
  work: async (queue: string, fn: (job: { data: unknown }) => Promise<void>) => {
    workers.set(queue, fn);
  },
} as unknown as Jobs;
const deps = { pool, jobs, masterKey, providerFactory: () => provider, publicUrl: "https://hive.example" };

/** Embedder giả ghi lại mọi văn bản được gửi đi, để kiểm nội dung bí mật không rời hub. */
const seen: string[] = [];
const embedder: Embedder = {
  model: "gia-lap-v1",
  async embed(texts) {
    seen.push(...texts);
    return texts.map(() => [1, 0, 0]);
  },
};

let org: Awaited<ReturnType<typeof seedOrg>>;
let project: Awaited<ReturnType<typeof seedProject>>;
let orgHome: HomeRow;
let projectHome: HomeRow;
const projectKey = `sy${tag}`;
const orgRef = () => ({ owner: project.owner, name: `docs-${tag}` });
const projectRef = () => ({ owner: project.owner, name: project.repo });
const actor = (name: string) => ({ userId: org.user(name), orgId: org.orgId });
const user = (name: string): Principal => ({ kind: "user", userId: org.user(name) });
const as = <T>(name: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, actor(name), fn);
const repoFile = (ref: { owner: string; name: string }, path: string) =>
  mem.repos.get(`${ref.owner}/${ref.name}`.toLowerCase())?.branches.get("main")?.get(path);
const syncCommits = (ref: { owner: string; name: string }) =>
  (mem.repos.get(`${ref.owner}/${ref.name}`.toLowerCase())?.commits ?? []).filter((c) =>
    c.message.includes("Hive-Doc-Sync:"),
  );
/** Đẩy mốc gom về quá khứ thay vì chờ 60 giây thật; thời gian chờ gom được cộng lại khi báo kết quả. */
const elapse = (home: HomeRow) =>
  admin.query(
    "update hive.doc_homes set last_saved_at = now() - interval '2 minutes', first_queued_at = now() - interval '2 minutes' where id = $1",
    [home.id],
  );
const push = (home: HomeRow) => pushHome(deps, { orgId: org.orgId, homeId: home.id });
const pull = (home: HomeRow) => pullHome(deps, { orgId: org.orgId, homeId: home.id });
const versionCount = async (key: string) =>
  (
    await admin.query(
      "select count(*)::int as n from hive.doc_versions v join hive.docs d on d.id = v.doc_id where d.key = $1",
      [key],
    )
  ).rows[0].n as number;
const fileState = async (key: string) =>
  (
    await admin.query(
      "select f.state from hive.doc_repo_files f join hive.docs d on d.id = f.doc_id where d.key = $1",
      [key],
    )
  ).rows[0]?.state as string | undefined;

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] ?? 0;

let webhookSecret = "";
const webhook = (home: HomeRow, delivery: string) => {
  const body = JSON.stringify({ ref: "refs/heads/main" });
  return handleDocsWebhook(
    deps,
    home.id,
    new Request(`https://hive.example/hooks/docs/${home.id}`, {
      method: "POST",
      body,
      headers: {
        "x-github-event": "push",
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
      },
    }),
  );
};

/** Chạy hết job chỉ mục tài liệu đã xếp, như worker thật. */
async function drainIndex() {
  const work = workers.get(DOC_INDEX_QUEUE);
  if (!work) throw new Error("chưa đăng ký worker chỉ mục");
  for (let i = queued.findIndex((q) => q.queue === DOC_INDEX_QUEUE); i >= 0; ) {
    const [job] = queued.splice(i, 1);
    await work({ data: job?.data });
    i = queued.findIndex((q) => q.queue === DOC_INDEX_QUEUE);
  }
}

async function scanAndStart(paths: string[]) {
  const scanned = await as("tadmin", (tx) => scanImport(tx, jobs, actor("tadmin"), { homeId: projectHome.id }));
  const job = { orgId: org.orgId, homeId: projectHome.id, importId: scanned.id };
  await runScan(deps, job);
  await as("tadmin", (tx) => startImport(tx, jobs, actor("tadmin"), { importId: scanned.id, paths }));
  return job;
}

async function chunkModels(key: string) {
  const { rows } = await admin.query(
    "select distinct c.embedding_model from hive.doc_chunks c join hive.docs d on d.id = c.doc_id where d.key = $1",
    [key],
  );
  return rows.map((r) => r.embedding_model as string | null);
}

beforeAll(async () => {
  org = await seedOrg(admin, `sy-${tag}`);
  project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
  mem.seedRepo(orgRef(), { files: { "README.md": "# Tài liệu\n" } });
  mem.seedRepo(projectRef(), { files: { "README.md": "# Dự án\n" } });
  orgHome = await as("admin", (tx) =>
    configureOrgHome(tx, deps, actor("admin"), {
      connectionId: project.connectionId,
      owner: orgRef().owner,
      name: orgRef().name,
      root: "",
      include: [],
    }),
  );
  if (!orgHome.webhookSecretEnc) throw new Error("nhà tổ chức chưa gắn webhook");
  webhookSecret = decryptSecret(masterKey, orgHome.webhookSecretEnc, homeSecretContext(orgHome.id));
  projectHome = await as("tadmin", (tx) =>
    configureProjectHome(tx, deps, actor("tadmin"), {
      project: projectKey,
      settings: {
        enabled: true,
        root: "docs/",
        repoSync: "pr",
        include: ["**/*"],
        exclude: [],
        assetsDir: "assets",
        repoChangesNeedReview: false,
      },
    }),
  );
  provideDocSaved(docSavedHandler(jobs));
  provideDocIndexJobs(jobs);
  await registerDocIndexWorker(jobs, { pool, embedder });
});

afterAll(async () => {
  provideDocSaved(undefined);
  provideDocIndexJobs(undefined);
  await Promise.all([admin.end(), pool.end()]);
});

describe("vòng hub → repo → webhook → hub (SC-002, SC-003, SC-004)", () => {
  it("mỗi lần lưu thêm đúng một phiên bản, không dội lại; đo thời gian xử lý", { timeout: 300_000 }, async () => {
    const key = `team/thanh-toan/vong-${tag}`;
    const path = `teams/thanh-toan/vong-${tag}.md`;
    const pushMs: number[] = [];
    const pullMs: number[] = [];
    const rounds = 20;
    let version = 0;
    for (let i = 1; i <= rounds; i++) {
      // Lưu trên hub → commit vào repo.
      const content = `# Vòng\n\nLần lưu trên hub thứ ${i}.\n`;
      await as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key, content, baseVersion: version }));
      version += 1;
      await elapse(orgHome);
      const pushed = await timed(() => push(orgHome));
      expect(pushed.value).toBe("pushed");
      pushMs.push(pushed.ms);
      expect(repoFile(orgRef(), path)).toBe(content);

      // Repo báo push của chính hub qua webhook: kéo về không tạo phiên bản mới.
      queued.length = 0;
      expect((await webhook(orgHome, `hub-${tag}-${i}`)).status).toBe(202);
      expect(queued).toContainEqual({ queue: DOCSYNC_PULL_QUEUE, data: { orgId: org.orgId, homeId: orgHome.id } });
      const echo = await pull(orgHome);
      expect(echo.counts.applied ?? 0).toBe(0);
      expect(await versionCount(key)).toBe(version);

      // Sửa trong repo → webhook → hub có đúng một phiên bản mới, không đẩy ngược.
      const edited = `# Vòng\n\nLần sửa trong repo thứ ${i}.\n`;
      await mem.commitFiles(orgRef(), {
        branch: "main",
        message: "Sửa trong repo",
        files: [{ path, content: edited }],
      });
      const commitsBefore = syncCommits(orgRef()).length;
      queued.length = 0;
      expect((await webhook(orgHome, `repo-${tag}-${i}`)).status).toBe(202);
      const pulled = await timed(() => pull(orgHome));
      expect(pulled.value.counts.applied).toBe(1);
      pullMs.push(pulled.ms);
      version += 1;
      expect(await versionCount(key)).toBe(version);
      expect(await as("tadmin", (tx) => getDoc(tx, user("tadmin"), { key }))).toMatchObject({
        version,
        content: edited,
      });
      expect(queued.filter((q) => q.queue === DOCSYNC_PUSH_QUEUE)).toHaveLength(0);
      await elapse(orgHome);
      expect(await push(orgHome)).not.toBe("pushed");
      expect(syncCommits(orgRef())).toHaveLength(commitsBefore);
    }
    expect(await versionCount(key)).toBe(2 * rounds);
    // Thời gian đo là phần job xử lý với độ trễ giả; SC-002 cộng thêm 60 giây gom, SC-003 cộng thời gian xếp hàng.
    console.info(
      `[DOC-T026] latency=${LATENCY_MS}ms rounds=${rounds} push p95=${p95(pushMs).toFixed(0)}ms max=${Math.max(...pushMs).toFixed(0)}ms pull p95=${p95(pullMs).toFixed(0)}ms max=${Math.max(...pullMs).toFixed(0)}ms`,
    );
    expect(p95(pushMs)).toBeLessThan(60_000);
    expect(p95(pullMs)).toBeLessThan(60_000);
  });
});

describe("tranh chấp: repo đổi giữa lúc lập lô và commit (SC-006)", () => {
  it("không ghi đè thay đổi của repo; kéo về rồi mới đẩy", { timeout: 60_000 }, async () => {
    const key = `team/thanh-toan/tranh-${tag}`;
    const path = `teams/thanh-toan/tranh-${tag}.md`;
    const base = "# Tranh chấp\n\nĐoạn một.\n\nĐoạn hai.\n\nĐoạn ba.\n";
    await as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key, content: base, baseVersion: 0 }));
    await elapse(orgHome);
    expect(await push(orgHome)).toBe("pushed");

    const hubEdit = base.replace("Đoạn một.", "Đoạn một, sửa trên hub.");
    const repoEdit = base.replace("Đoạn ba.", "Đoạn ba, sửa trong repo.");
    await as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key, content: hubEdit, baseVersion: 1 }));
    await elapse(orgHome);
    beforeCommit = async () => {
      await mem.commitFiles(orgRef(), { branch: "main", message: "Sửa tay", files: [{ path, content: repoEdit }] });
    };
    queued.length = 0;
    expect(await push(orgHome)).toBe("failed");
    expect(beforeCommit).toBeNull();
    expect(repoFile(orgRef(), path)).toBe(repoEdit);

    // Lần thử lại thấy file đã đổi trong repo: bỏ file khỏi lô và xếp job kéo thay vì ghi đè.
    await admin.query(
      "update hive.doc_sync_batches set next_at = now() - interval '1 second' where home_id = $1 and state = 'failed'",
      [orgHome.id],
    );
    queued.length = 0;
    expect(await push(orgHome)).toBe("empty");
    expect(repoFile(orgRef(), path)).toBe(repoEdit);
    expect(queued).toContainEqual({ queue: DOCSYNC_PULL_QUEUE, data: { orgId: org.orgId, homeId: orgHome.id } });

    // Kéo về: hai bên sửa đoạn khác nhau nên gộp được; lô sau đẩy bản gộp chứa cả hai thay đổi.
    const pulled = await pull(orgHome);
    expect(pulled.counts.conflict ?? 0).toBe(0);
    const merged = await as("tadmin", (tx) => getDoc(tx, user("tadmin"), { key }));
    expect(merged.content).toContain("sửa trên hub");
    expect(merged.content).toContain("sửa trong repo");
    await elapse(orgHome);
    await push(orgHome);
    expect(repoFile(orgRef(), path)).toContain("sửa trong repo");
    expect(repoFile(orgRef(), path)).toContain("sửa trên hub");
  });
});

describe("bí mật không vào repo hay embedding khi chưa xác nhận (SC-007)", () => {
  it("người lưu bị chặn; bản có cờ bí mật không được đẩy và không gửi embedding", async () => {
    const key = `team/thanh-toan/khoa-${tag}`;
    const path = `teams/thanh-toan/khoa-${tag}.md`;
    const content = `# Khoá\n\nKhoá triển khai: ${FAKE_KEY}\n`;
    queued.length = 0;
    await expect(
      as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key, content, baseVersion: 0 })),
    ).rejects.toMatchObject({ code: "DOC_SECRET_FOUND" });
    expect(await versionCount(key)).toBe(0);

    // Bản gộp xung đột không qua bước chặn của người lưu nên ghi phiên bản có cờ, và vẫn vào hàng đợi đẩy.
    await as("admin", (tx) =>
      saveDocFromSync(tx, {
        key,
        content,
        baseVersion: 0,
        scope: { teamId: org.teamId, projectId: null },
        source: "merge",
      }),
    );
    await elapse(orgHome);
    await push(orgHome);
    expect(await fileState(key)).toBe("blocked_secret");
    expect(repoFile(orgRef(), path)).toBeUndefined();
    await drainIndex();
    expect(await chunkModels(key)).toEqual(["skipped"]);
    expect(seen.join("\n")).not.toContain(FAKE_KEY);
  });

  it("xác nhận có ghi audit thì mới đẩy", async () => {
    const key = `team/thanh-toan/xac-nhan-${tag}`;
    const path = `teams/thanh-toan/xac-nhan-${tag}.md`;
    const content = `# Ví dụ\n\nChuỗi mẫu trong tài liệu: ${FAKE_KEY}\n`;
    await expect(
      as("tmember", (tx) => saveDoc(tx, user("tmember"), { key, content, baseVersion: 0, acknowledgeSecrets: true })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key, content, baseVersion: 0, acknowledgeSecrets: true }));
    const audit = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'doc.secrets.acknowledge' and target_id = $2",
      [org.orgId, key],
    );
    expect(audit.rowCount).toBe(1);
    expect(JSON.stringify(audit.rows[0].data)).not.toContain(FAKE_KEY);
    await elapse(orgHome);
    expect(await push(orgHome)).toBe("pushed");
    expect(repoFile(orgRef(), path)).toBe(content);
  });

  it("repo đưa bí mật vào: phiên bản có cờ, không đẩy lại, không gửi embedding", async () => {
    const key = `team/thanh-toan/tu-repo-${tag}`;
    const path = `teams/thanh-toan/tu-repo-${tag}.md`;
    await as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key, content: "# Từ repo\n", baseVersion: 0 }));
    await elapse(orgHome);
    expect(await push(orgHome)).toBe("pushed");
    await pull(orgHome);
    const leaked = `# Từ repo\n\n${PEM}\n`;
    await mem.commitFiles(orgRef(), { branch: "main", message: "lỡ tay", files: [{ path, content: leaked }] });
    const commitsBefore = syncCommits(orgRef()).length;
    await pull(orgHome);
    const { rows } = await admin.query(
      "select v.secret_flag from hive.doc_versions v join hive.docs d on d.id = v.doc_id where d.key = $1 and v.version = d.current_version",
      [key],
    );
    expect(rows[0]).toEqual({ secret_flag: true });
    expect(await fileState(key)).toBe("blocked_secret");
    await elapse(orgHome);
    await push(orgHome);
    expect(syncCommits(orgRef())).toHaveLength(commitsBefore);
    await drainIndex();
    expect(await chunkModels(key)).toEqual(["skipped"]);
    expect(seen.join("\n")).not.toContain(PEM);
  });

  it("nhập từ repo: file có bí mật bị chặn tới khi xác nhận", async () => {
    await mem.commitFiles(projectRef(), {
      branch: "main",
      message: "seed",
      files: [
        { path: "docs/ke-hoach.md", content: `# Kế hoạch zircon${tag}\n\n![Sơ đồ](img/so-do.gif)\n` },
        { path: "docs/img/so-do.gif", content: "GIF89a\u0001\u0000\u0001\u0000;" },
        { path: "docs/khoa.md", content: `# Khoá\n\n${PEM}\n` },
      ],
    });
    const job = await scanAndStart(["docs/ke-hoach.md", "docs/img/so-do.gif", "docs/khoa.md"]);
    await runImport(deps, job);
    const report = await as("tadmin", (tx) => getImport(tx, actor("tadmin"), job.importId));
    expect(report.report).toMatchObject({ blockedSecret: 1, failed: 0 });
    expect(await versionCount(`project/${projectKey}/khoa`)).toBe(0);
    await drainIndex();
    expect(seen.join("\n")).not.toContain(PEM);

    queued.length = 0;
    await as("tadmin", (tx) =>
      confirmSecret(tx, jobs, actor("tadmin"), { importId: job.importId, path: "docs/khoa.md" }),
    );
    expect(queued.map((q) => q.queue)).toContain(DOCSYNC_IMPORT_QUEUE);
    const audit = await admin.query(
      "select 1 from hive.audit_log where org_id = $1 and action = 'doc.import.secret_confirm'",
      [org.orgId],
    );
    expect(audit.rowCount).toBe(1);
    await runImport(deps, job);
    expect(await versionCount(`project/${projectKey}/khoa`)).toBe(1);
  });
});

describe("người không có quyền không thấy gì (SC-009)", () => {
  const key = () => `project/${projectKey}/ke-hoach`;
  const word = () => `zircon${tag}`;
  const asset = "docs/img/so-do.gif";

  it("đối chứng: thành viên đội thấy tài liệu, đoạn tìm kiếm và đính kèm", async () => {
    await drainIndex();
    expect((await as("tmember", (tx) => listDocs(tx, user("tmember"), {}))).map((d) => d.key)).toContain(key());
    const found = await as("tmember", (tx) => searchDocs(tx, user("tmember"), { query: word() }));
    expect(found.hits.map((h) => h.key)).toContain(key());
    const assets = await as("tmember", (tx) =>
      listDocAssets(tx, user("tmember"), { homeId: projectHome.id, docKey: key(), limit: 50 }),
    );
    expect(assets.items.map((a) => a.repoPath)).toContain(asset);
    expect(
      await as("tmember", (tx) => findDocAsset(tx, user("tmember"), { docKey: key(), path: "img/so-do.gif" })),
    ).toMatchObject({ repoPath: asset });
    const tree = await as("tmember", (tx) => listTree(tx, org.user("tmember"), { homeId: projectHome.id, limit: 200 }));
    expect(tree.items.map((i) => i.path)).toEqual(expect.arrayContaining(["docs/ke-hoach.md", asset]));
  });

  it.each(["oadmin", "loner"])("%s: danh sách, tìm kiếm, MCP, đính kèm, cây và báo cáo nhập đều trống", async (who) => {
    const docs = await as(who, (tx) => listDocs(tx, user(who), {}));
    expect(docs.map((d) => d.key)).not.toContain(key());
    await expect(as(who, (tx) => getDoc(tx, user(who), { key: key() }))).rejects.toThrow();
    const found = await as(who, (tx) => searchDocs(tx, user(who), { query: word() }));
    expect(found.hits).toEqual([]);
    expect(JSON.stringify(found)).not.toContain(word());
    const assets = await as(who, (tx) => listDocAssets(tx, user(who), { homeId: projectHome.id, limit: 50 }));
    expect(assets.items).toEqual([]);
    await expect(
      as(who, (tx) => listDocAssets(tx, user(who), { homeId: projectHome.id, docKey: key(), limit: 50 })),
    ).rejects.toThrow();
    // Tool MCP doc_asset_get đi qua findDocAsset.
    await expect(
      as(who, (tx) => findDocAsset(tx, user(who), { docKey: key(), path: "img/so-do.gif" })),
    ).rejects.toThrow();
    // Nhà của dự án đội khác trả "không tìm thấy" như nhà không có; cây chung không lộ file của nhà đó.
    await expect(
      as(who, (tx) => listTree(tx, org.user(who), { homeId: projectHome.id, limit: 200 })),
    ).rejects.toMatchObject({ code: "DOCSYNC_HOME_NOT_FOUND" });
    const tree = await as(who, (tx) => listTree(tx, org.user(who), { limit: 200 }));
    expect(JSON.stringify(tree)).not.toContain("ke-hoach");
    expect(JSON.stringify(tree)).not.toContain("so-do.gif");

    const { rows } = await admin.query("select id from hive.doc_imports where home_id = $1 limit 1", [projectHome.id]);
    const importId = rows[0].id as string;
    const denied = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ message: expect.any(String) });
    await denied(as(who, (tx) => getImport(tx, actor(who), importId)));
    await denied(as(who, (tx) => listImports(tx, actor(who), { homeId: projectHome.id })));
    await denied(as(who, (tx) => listImportFiles(tx, actor(who), { id: importId })));
  });
});

describe("nhập khi hook đẩy đang bật (T029)", () => {
  // Tiến trình worker gọi registerPush nên hook luôn bật lúc nhập; trước đây nó gắn tài liệu trước bước nhập.
  it("nhập markdown mới khi hook đẩy đang bật", async () => {
    const path = `docs/moi-${tag}.md`;
    await mem.commitFiles(projectRef(), { branch: "main", message: "thêm", files: [{ path, content: "# Mới\n" }] });
    const job = await scanAndStart([path]);
    await runImport(deps, job);
    const { items } = await as("tadmin", (tx) => listImportFiles(tx, actor("tadmin"), { id: job.importId }));
    expect(items.find((f) => f.path === path)).toMatchObject({ state: "done" });
  });
});
