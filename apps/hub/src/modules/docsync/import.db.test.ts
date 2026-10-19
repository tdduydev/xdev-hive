import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import pg from "pg";
import { Header } from "tar";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { provideDocSaved, saveDocFromSync } from "../knowledge/index.ts";
import { createPool, ForbiddenError, type Jobs, parseMasterKey, withTenant } from "../platform/index.ts";
import { createMemoryProvider, type GitProvider, GitProviderError } from "../scm/index.ts";
import { adopt, adoptPreview } from "./adopt.ts";
import { configureProjectHome } from "./homes.ts";
import {
  confirmSecret,
  getImport,
  IMPORT_BATCH_FILES,
  listImportFiles,
  runImport,
  scanImport,
  startImport,
} from "./import.ts";
import { DOCSYNC_EXTRACT_QUEUE, DOCSYNC_IMPORT_QUEUE, DOCSYNC_PUSH_QUEUE, DOCSYNC_SCAN_IMPORT_QUEUE } from "./jobs.ts";
import { docSavedHandler } from "./push.ts";
import { readRepoFiles, runScan, W } from "./scan.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const mem = createMemoryProvider("gitlab", ["xdev-team"]);
const queued: Array<{ queue: string; data: unknown; opts: { startAfter?: Date } }> = [];
const jobs = {
  enqueue: async (queue: string, data: object, opts: { startAfter?: Date } = {}) => {
    queued.push({ queue, data, opts });
    return randomUUID();
  },
} as unknown as Jobs;
let archiveOverride: GitProvider["archive"] | null = null;
const deps = {
  pool,
  jobs,
  masterKey,
  providerFactory: () => (archiveOverride ? { ...mem, archive: archiveOverride } : mem),
  publicUrl: "https://hive.example",
};
const keys = { big: `ib${tag}`, main: `im${tag}` };
// Tách chuỗi để công cụ quét bí mật của repo không báo nhầm file test.
const SECRET = `-----BEGIN RSA ${"PRIVATE"} KEY-----`;

let org: Awaited<ReturnType<typeof seedOrg>>;
const projects: Record<string, Awaited<ReturnType<typeof seedProject>>> = {};
const homes: Record<string, string> = {};
const actor = (name: string) => ({ userId: org.user(name), orgId: org.orgId });
const as = <T>(name: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, actor(name), fn);
const refOf = (k: string) => ({ owner: projects[k]?.owner ?? "", name: projects[k]?.repo ?? "" });
const job = (k: string, importId: string) => ({ orgId: org.orgId, homeId: homes[k] ?? "", importId });
const settings = {
  enabled: true,
  root: "docs/",
  repoSync: "pr" as const,
  include: ["**/*"],
  exclude: [],
  assetsDir: "assets",
  repoChangesNeedReview: false,
  wordImportConfidential: false,
};

async function scan(k: string) {
  const imp = await as("tadmin", (tx) => scanImport(tx, jobs, actor("tadmin"), { homeId: homes[k] }));
  await runScan(deps, job(k, imp.id));
  return as("tadmin", (tx) => getImport(tx, actor("tadmin"), imp.id));
}

async function files(importId: string) {
  const { items } = await as("tadmin", (tx) => listImportFiles(tx, actor("tadmin"), { id: importId, limit: 200 }));
  return new Map(items.map((f) => [f.path, f]));
}

function tarOf(entries: Array<{ path: string; body?: string; type?: string; linkpath?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "");
    const h = new Header({
      path: e.path,
      size: body.length,
      type: (e.type ?? "File") as never,
      mode: 0o644,
      mtime: new Date(0),
      ...(e.linkpath ? { linkpath: e.linkpath } : {}),
    });
    h.encode();
    blocks.push(h.block as Buffer, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** Trả từng mảnh theo yêu cầu đọc rồi báo lỗi mạng, giống kết nối tải archive bị đứt giữa chừng. */
function brokenStream(chunks: Buffer[], error: Error) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i++];
      if (chunk) controller.enqueue(chunk);
      else controller.error(error);
    },
  });
}

beforeAll(async () => {
  org = await seedOrg(admin, `im-${tag}`);
  const base = {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
  };
  for (const k of Object.values(keys)) {
    projects[k] = await seedProject(admin, pool, { ...base, key: k });
    mem.seedRepo(refOf(k), { files: { "docs/readme.md": "# Đọc trước\n" } });
    const home = await as("tadmin", (tx) => configureProjectHome(tx, deps, actor("tadmin"), { project: k, settings }));
    homes[k] = home.id;
  }
});

afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

describe("nhập 2.000 file từ repo", () => {
  const big: Record<string, string> = {};
  for (let i = 0; i < 1998; i++)
    big[`docs/g${i % 20}/f${String(i).padStart(4, "0")}.md`] = `# Tệp ${i}\n\nNội dung ${i}.\n`;

  it("ngắt giữa chừng rồi chạy tiếp, không trùng tài liệu", { timeout: 180_000 }, async () => {
    await mem.commitFiles(refOf(keys.big), {
      branch: "main",
      message: "seed",
      files: Object.entries(big).map(([path, content]) => ({ path, content })),
    });
    // Repo có sẵn README.md và docs/readme.md; đọc lại cả cây để dựng archive giống hệt.
    const ref = refOf(keys.big);
    const sha = (await mem.branchHead(ref, "main")) ?? "";
    const all: Record<string, string> = {};
    for (const path of await mem.listFiles(ref, sha)) all[path] = (await mem.readFile(ref, path, sha)) ?? "";
    expect(Object.keys(all)).toHaveLength(2000);
    const ready = await scan(keys.big);
    expect(ready).toMatchObject({ state: "ready", progress: { done: 0, total: 2000 } });
    const started = await as("tadmin", (tx) =>
      startImport(tx, jobs, actor("tadmin"), { importId: ready.id, paths: Object.keys(all) }),
    );
    expect(started.state).toBe("importing");

    // Archive thật là tar; cắt sau 700 file để ba lô 200 file kịp ghi, lô thứ tư dở dang.
    const head = Object.keys(all)
      .sort()
      .slice(0, 700)
      .map((path) => tarOf([{ path: `repo-sha/${path}`, body: all[path] ?? "" }]).subarray(0, -1024));
    archiveOverride = async () =>
      brokenStream(head, new GitProviderError("unavailable", "gitlab: 503", { status: 503, retryAfterMs: 5_000 }));
    queued.length = 0;
    const before = Date.now();
    await runImport(deps, job(keys.big, ready.id));
    archiveOverride = null;
    const retry = queued.find((q) => q.queue === DOCSYNC_IMPORT_QUEUE);
    expect(retry?.data).toEqual(job(keys.big, ready.id));
    expect(retry?.opts.startAfter?.getTime()).toBeGreaterThanOrEqual(before + 5_000);
    const mid = await as("tadmin", (tx) => getImport(tx, actor("tadmin"), ready.id));
    expect(mid.state).toBe("importing");
    expect(mid.progress.done).toBe(3 * IMPORT_BATCH_FILES);

    await runImport(deps, job(keys.big, ready.id));
    const done = await as("tadmin", (tx) => getImport(tx, actor("tadmin"), ready.id));
    expect(done).toMatchObject({
      state: "done",
      progress: { done: 2000, total: 2000 },
      report: { imported: 2000, failed: 0, blockedSecret: 0 },
    });
    const { rows } = await admin.query(
      `select count(*)::int as docs, count(distinct d.key)::int as keys, max(d.current_version) as max_version,
              (select count(*)::int from hive.doc_repo_files f where f.home_id = $2) as mapped
         from hive.docs d where d.org_id = $1 and d.key like $3`,
      [org.orgId, homes[keys.big], `project/${keys.big}/%`],
    );
    expect(rows[0]).toEqual({ docs: 2000, keys: 2000, max_version: 1, mapped: 2000 });
    const inbox = await admin.query(
      "select title from hive.inbox_items where org_id = $1 and user_id = $2 and event = 'docsync.import_done'",
      [org.orgId, org.user("tadmin")],
    );
    expect(inbox.rowCount).toBe(1);
  });
});

describe("nhập file thường", () => {
  let importId = "";
  const main = () => keys.main;

  it("quét phân loại, cảnh báo bí mật, file lớn và trùng key", async () => {
    await as("tadmin", (tx) =>
      Promise.all(
        ["existing", "attach", "adopt-me"].map((name) =>
          saveDocFromSync(tx, {
            key: `project/${main()}/${name}`,
            content: `# Bản hub ${name}\n`,
            baseVersion: 0,
            scope: { teamId: org.teamId, projectId: projects[main()]?.projectId ?? "" },
            source: "import",
          }),
        ),
      ),
    );
    await mem.commitFiles(refOf(main()), {
      branch: "main",
      message: "seed",
      files: [
        { path: "docs/guide.md", content: "# Hướng dẫn\n" },
        { path: "docs/secret.md", content: `# Khoá\n\n${SECRET}\n` },
        { path: "docs/big.md", content: `# Lớn\n${"x".repeat(300_000)}\n` },
        { path: "docs/img/logo.gif", content: "GIF89a\u0001\u0000\u0001\u0000;" },
        { path: "docs/spec.pdf", content: "%PDF-1.4 giả" },
        { path: "docs/existing.md", content: "# Repo existing\n" },
        { path: "docs/attach.md", content: "# Repo attach\n" },
        {
          path: "docs/lfs.png",
          content: `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 1234\n`,
        },
      ],
    });
    const ready = await scan(main());
    importId = ready.id;
    expect(ready.state).toBe("ready");
    const byPath = await files(importId);
    expect(byPath.get("docs/secret.md")).toMatchObject({ secretScan: "found", warnings: [W.secret] });
    expect(byPath.get("docs/big.md")).toMatchObject({ kind: "markdown", warnings: [W.tooLong] });
    expect(byPath.get("docs/lfs.png")?.warnings).toEqual([W.lfs]);
    expect(byPath.get("docs/existing.md")).toMatchObject({
      existingKey: `project/${main()}/existing`,
      warnings: [W.collision],
    });
    // Quét lại thì bản xem trước cũ bị huỷ; đang quét thì không cho mở lần thứ hai.
    const rescan = await as("tadmin", (tx) => scanImport(tx, jobs, actor("tadmin"), { homeId: homes[main()] }));
    expect(rescan.state).toBe("scanning");
    expect((await as("tadmin", (tx) => getImport(tx, actor("tadmin"), importId))).state).toBe("cancelled");
    await expect(
      as("tadmin", (tx) => scanImport(tx, jobs, actor("tadmin"), { homeId: homes[main()] })),
    ).rejects.toMatchObject({ code: "DOCSYNC_IMPORT_RUNNING" });
    await runScan(deps, job(main(), rescan.id));
    importId = rescan.id;
  });

  it("thành viên thường không được quét hay nhập", async () => {
    await expect(
      as("tmember", (tx) => scanImport(tx, jobs, actor("tmember"), { homeId: homes[main()] })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("nhập tài liệu, đính kèm, chặn bí mật và xử lý trùng key", async () => {
    const byPath = await files(importId);
    queued.length = 0;
    await as("tadmin", (tx) =>
      startImport(tx, jobs, actor("tadmin"), {
        importId,
        paths: [...byPath.keys()].filter((p) => p !== "docs/readme.md"),
        resolutions: [
          { path: "docs/existing.md", action: "rename", key: `project/${main()}/existing-repo` },
          { path: "docs/attach.md", action: "attach", key: `project/${main()}/attach`, choice: "repo", baseVersion: 1 },
        ],
      }),
    );
    await runImport(deps, job(main(), importId));
    const after = await files(importId);
    expect(after.get("docs/readme.md")?.state).toBe("skipped");
    expect(after.get("docs/guide.md")).toMatchObject({ state: "done", docId: expect.any(String) });
    expect(after.get("docs/secret.md")?.state).toBe("blocked_secret");
    expect(after.get("docs/big.md")).toMatchObject({ state: "done", assetId: expect.any(String), docId: null });
    expect(after.get("docs/img/logo.gif")).toMatchObject({ state: "done", assetId: expect.any(String) });
    expect(after.get("docs/lfs.png")).toMatchObject({ state: "failed", error: "Thiếu đối tượng LFS" });
    expect(after.get("docs/existing.md")).toMatchObject({ state: "done", key: `project/${main()}/existing-repo` });
    expect(after.get("docs/attach.md")?.state).toBe("done");

    const pdf = after.get("docs/spec.pdf");
    expect(pdf?.state).toBe("done");
    expect(queued.find((q) => q.queue === DOCSYNC_EXTRACT_QUEUE)?.data).toMatchObject({ assetId: pdf?.assetId });
    const { rows: assets } = await admin.query(
      "select repo_path, state, blob_id is not null as has_blob from hive.doc_assets where home_id = $1 order by repo_path",
      [homes[main()]],
    );
    expect(assets).toEqual([
      { repo_path: "docs/big.md", state: "available", has_blob: true },
      { repo_path: "docs/img/logo.gif", state: "available", has_blob: true },
      { repo_path: "docs/lfs.png", state: "missing_lfs", has_blob: false },
      { repo_path: "docs/spec.pdf", state: "available", has_blob: true },
    ]);
    const { rows: docs } = await admin.query(
      "select key, current_version from hive.docs where org_id = $1 and key = any($2) order by key",
      [org.orgId, [`project/${main()}/attach`, `project/${main()}/existing`]],
    );
    expect(docs).toEqual([
      { key: `project/${main()}/attach`, current_version: 2 },
      { key: `project/${main()}/existing`, current_version: 1 },
    ]);
    expect(await as("tadmin", (tx) => getImport(tx, actor("tadmin"), importId))).toMatchObject({
      state: "done",
      report: { blockedSecret: 1, failed: 1 },
    });
  });

  it("xác nhận bí mật thì nhập tiếp file bị chặn", async () => {
    queued.length = 0;
    await expect(
      as("tmember", (tx) => confirmSecret(tx, jobs, actor("tmember"), { importId, path: "docs/secret.md" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      await as("tadmin", (tx) => confirmSecret(tx, jobs, actor("tadmin"), { importId, path: "docs/secret.md" })),
    ).toEqual({ queued: true });
    expect(queued.map((q) => q.queue)).toEqual([DOCSYNC_IMPORT_QUEUE]);
    await runImport(deps, job(main(), importId));
    expect((await files(importId)).get("docs/secret.md")).toMatchObject({ state: "done", docId: expect.any(String) });
    const audit = await admin.query(
      "select 1 from hive.audit_log where org_id = $1 and action = 'doc.import.secret_confirm'",
      [org.orgId],
    );
    expect(audit.rowCount).toBe(1);
    expect(await as("tadmin", (tx) => getImport(tx, actor("tadmin"), importId))).toMatchObject({
      state: "done",
      report: { blockedSecret: 0 },
    });
  });

  it("đưa tài liệu hub chưa có nhà vào repo qua lô PR riêng", async () => {
    const preview = await as("tadmin", (tx) =>
      adoptPreview(tx, deps, actor("tadmin"), { homeId: homes[main()] ?? "", limit: 50 }),
    );
    expect(preview.items).toEqual([
      { key: `project/${main()}/adopt-me`, repoPath: "docs/adopt-me.md", existsInRepo: false, warnings: [] },
      {
        key: `project/${main()}/existing`,
        repoPath: "docs/existing.md",
        existsInRepo: true,
        warnings: [expect.any(String)],
      },
    ]);
    queued.length = 0;
    const { batchId } = await as("tadmin", (tx) =>
      adopt(tx, jobs, actor("tadmin"), { homeId: homes[main()] ?? "", keys: [`project/${main()}/adopt-me`] }),
    );
    expect(queued.map((q) => q.queue)).toEqual([DOCSYNC_PUSH_QUEUE]);
    const { rows } = await admin.query(
      `select b.mode, b.state, b.branch, f.state as file_state, f.repo_path
         from hive.doc_sync_batches b, hive.doc_repo_files f
        where b.id = $1 and f.home_id = b.home_id and f.repo_path = 'docs/adopt-me.md'`,
      [batchId],
    );
    expect(rows[0]).toMatchObject({
      mode: "pr",
      state: "queued",
      file_state: "pending",
      repo_path: "docs/adopt-me.md",
    });
    await expect(
      as("tadmin", (tx) =>
        adopt(tx, jobs, actor("tadmin"), { homeId: homes[main()] ?? "", keys: [`project/${main()}/adopt-me`] }),
      ),
    ).rejects.toMatchObject({ code: "DOCSYNC_ADOPT_KEY" });
  });

  it("nhà cung cấp giới hạn lượt gọi thì hẹn quét lại theo Retry-After", async () => {
    await admin.query("update hive.doc_imports set state = 'cancelled' where home_id = $1", [homes[main()]]);
    const imp = await as("tadmin", (tx) => scanImport(tx, jobs, actor("tadmin"), { homeId: homes[main()] }));
    queued.length = 0;
    mem.fail("branchHead", new GitProviderError("rate_limited", "gitlab: 429", { status: 429, retryAfterMs: 120_000 }));
    const before = Date.now();
    await runScan(deps, job(main(), imp.id));
    mem.fail("branchHead", null);
    expect(queued[0]).toMatchObject({ queue: DOCSYNC_SCAN_IMPORT_QUEUE, data: job(main(), imp.id) });
    expect(queued[0]?.opts.startAfter?.getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect((await as("tadmin", (tx) => getImport(tx, actor("tadmin"), imp.id))).state).toBe("scanning");
  });
});

// Hub thật luôn đăng ký hook lưu của docsync (registerPush); các test trên không đăng ký nên không thấy lỗi này.
describe("nhập khi hook lưu của docsync đang bật", () => {
  const k = `ih${tag}`;
  const repo = {
    "README.md": "# Tài liệu dự án\n",
    "specs/001-menu/spec.md": "# Đặc tả\n",
    ".specify/memory/constitution.md": "# Nguyên tắc\n",
  };

  beforeAll(async () => {
    projects[k] = await seedProject(admin, pool, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: k,
    });
    mem.seedRepo(refOf(k));
    await mem.commitFiles(refOf(k), {
      branch: "main",
      message: "seed",
      files: Object.entries(repo).map(([path, content]) => ({ path, content })),
    });
    const include = ["README.md", "specs/**", ".specify/memory/**"];
    const home = await as("tadmin", (tx) =>
      configureProjectHome(tx, deps, actor("tadmin"), { project: k, settings: { ...settings, include } }),
    );
    homes[k] = home.id;
    provideDocSaved(docSavedHandler(jobs));
  });

  afterAll(() => provideDocSaved(undefined));

  it("giữ đường dẫn gốc trong repo và không xếp lô đẩy lại file vừa nhập", async () => {
    const imp = await scan(k);
    queued.length = 0;
    await as("tadmin", (tx) => startImport(tx, jobs, actor("tadmin"), { importId: imp.id, paths: Object.keys(repo) }));
    await runImport(deps, job(k, imp.id));
    const after = await files(imp.id);
    for (const path of Object.keys(repo))
      expect(after.get(path)).toMatchObject({ state: "done", docId: expect.any(String) });
    const { rows } = await admin.query<{ repo_path: string }>(
      "select repo_path from hive.doc_repo_files where home_id = $1",
      [homes[k]],
    );
    expect(rows.map((r) => r.repo_path).sort()).toEqual(Object.keys(repo).sort());
    expect(queued.some((q) => q.queue === DOCSYNC_PUSH_QUEUE)).toBe(false);
  });
});

describe("đọc archive tar", () => {
  const provider = (body: Buffer) =>
    ({
      archive: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        }),
    }) as unknown as GitProvider;
  const read = async (body: Buffer, wanted: string[], maxBytes = 1024 ** 2) => {
    const out: string[] = [];
    for await (const e of readRepoFiles(provider(body), { owner: "o", name: "r" }, "s", new Set(wanted), {
      archive: true,
      maxBytes,
      keep: () => true,
    }))
      out.push(`${e.path}:${Buffer.from(e.bytes ?? []).toString()}`);
    return out;
  };

  it("bỏ symlink, hardlink và đường dẫn có .., nhận cả tar.gz", async () => {
    const tar = tarOf([
      { path: "r/docs/a.md", body: "# A" },
      { path: "r/docs/link.md", type: "SymbolicLink", linkpath: "../../etc/passwd" },
      { path: "r/docs/hard.md", type: "Link", linkpath: "r/docs/a.md" },
      { path: "r/docs/../../evil.md", body: "evil" },
    ]);
    const wanted = ["docs/a.md", "docs/link.md", "docs/hard.md", "evil.md", "../evil.md"];
    expect(await read(tar, wanted)).toEqual(["docs/a.md:# A"]);
    expect(await read(gzipSync(tar), wanted)).toEqual(["docs/a.md:# A"]);
  });

  it("vượt HIVE_DOC_IMPORT_MAX_BYTES thì dừng", async () => {
    const tar = tarOf([
      { path: "r/a.md", body: "x".repeat(600) },
      { path: "r/b.md", body: "y".repeat(600) },
    ]);
    await expect(read(tar, ["a.md", "b.md"], 1000)).rejects.toThrow("HIVE_DOC_IMPORT_MAX_BYTES");
  });
});
