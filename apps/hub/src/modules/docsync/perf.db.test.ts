import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, type Jobs, parseMasterKey, withTenant } from "../platform/index.ts";
import { createMemoryProvider, type GitProvider } from "../scm/index.ts";
import { configureProjectHome } from "./homes.ts";
import { getImport, runImport, scanImport, startImport } from "./import.ts";
import { runScan } from "./scan.ts";

// SC-001 đầy đủ (5.000 file markdown tổng 100 MB, 500 ảnh) mất vài phút nên chỉ chạy khi đặt HIVE_DOCSYNC_PERF=1.
// Mặc định chạy 1/10 khối lượng để CI vẫn kiểm số lời gọi provider và đường archive.
const FULL = process.env.HIVE_DOCSYNC_PERF === "1";
const SCALE = FULL ? 1 : 0.1;
const MARKDOWN = Math.round(5000 * SCALE);
const IMAGES = Math.round(500 * SCALE);
const MD_BYTES = 20 * 1024;
const IMAGE_BYTES = 20 * 1024;
const BUDGET_MS = 15 * 60_000 * SCALE;
/** Độ trễ mỗi lời gọi API Git, cỡ một request GitHub/GitLab qua mạng. */
const LATENCY_MS = 120;
/** Tốc độ tải archive giả định (~25 MB/s), để thời gian đo gồm cả phần tải. */
const ARCHIVE_BYTES_PER_MS = 25 * 1024;

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const key = `pf${tag}`;
const mem = createMemoryProvider("github", ["xdev-team"]);
const calls: string[] = [];
let repoBytes = 0;
const provider: GitProvider = new Proxy(mem, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") return value;
    return async (...args: unknown[]) => {
      calls.push(String(prop));
      await sleep(LATENCY_MS + (prop === "archive" ? repoBytes / ARCHIVE_BYTES_PER_MS : 0));
      return value.apply(target, args);
    };
  },
});
const jobs = { enqueue: async () => randomUUID() } as unknown as Jobs;
const deps = { pool, jobs, masterKey, providerFactory: () => provider, publicUrl: "https://hive.example" };

let org: Awaited<ReturnType<typeof seedOrg>>;
let project: Awaited<ReturnType<typeof seedProject>>;
let homeId = "";
const files: Record<string, string> = {};
const actor = () => ({ userId: org.user("tadmin"), orgId: org.orgId });
const as = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, actor(), fn);

/** Markdown ~20 KB, mỗi file khác nhau, không có chuỗi giống bí mật. */
function markdown(i: number): string {
  const head = `# Tài liệu ${i}\n\n`;
  const line = `Đoạn hướng dẫn vận hành số ${i}: kiểm tra cấu hình, sao lưu dữ liệu và ghi nhật ký trước khi triển khai.\n\n`;
  const body = line.repeat(Math.ceil(MD_BYTES / Buffer.byteLength(line)));
  return (head + body).slice(0, MD_BYTES - head.length);
}

/** Provider memory giữ nội dung dạng chuỗi UTF-8 nên chỉ dựng được ảnh có phần đầu ASCII như GIF. */
const image = (i: number) =>
  `GIF89a\u0001\u0000\u0001\u0000${String(i).padStart(6, "0")}${"x".repeat(IMAGE_BYTES - 17)};`;

beforeAll(async () => {
  org = await seedOrg(admin, `pf-${tag}`);
  project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key,
  });
  for (let i = 0; i < MARKDOWN; i++) files[`docs/g${i % 50}/t${String(i).padStart(5, "0")}.md`] = markdown(i);
  for (let i = 0; i < IMAGES; i++) files[`docs/img/a${String(i).padStart(4, "0")}.gif`] = image(i);
  repoBytes = Object.values(files).reduce((n, c) => n + Buffer.byteLength(c), 0);
  const ref = { owner: project.owner, name: project.repo };
  mem.seedRepo(ref);
  await mem.commitFiles(ref, {
    branch: "main",
    message: "seed",
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
  });
  homeId = (
    await as((tx) =>
      configureProjectHome(tx, deps, actor(), {
        project: key,
        settings: {
          enabled: true,
          root: "docs/",
          repoSync: "pr",
          include: ["**/*"],
          exclude: [],
          assetsDir: "assets",
          repoChangesNeedReview: false,
          wordImportConfidential: false,
        },
      }),
    )
  ).id;
});

afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

describe(`nhập ${MARKDOWN} file markdown và ${IMAGES} ảnh (SC-001${FULL ? "" : ", thu nhỏ 1/10"})`, () => {
  it("xong trong thời hạn, ≤ 50 lời gọi provider ngoài archive", { timeout: BUDGET_MS + 5 * 60_000 }, async () => {
    calls.length = 0;
    const start = performance.now();
    const scanned = await as((tx) => scanImport(tx, jobs, actor(), { homeId }));
    const job = { orgId: org.orgId, homeId, importId: scanned.id };
    await runScan(deps, job);
    const ready = await as((tx) => getImport(tx, actor(), scanned.id));
    // Quét gồm cả README.md mà repo memory tạo sẵn ở gốc repo.
    expect(ready).toMatchObject({ state: "ready", progress: { total: MARKDOWN + IMAGES + 1 } });
    const scanMs = performance.now() - start;

    await as((tx) => startImport(tx, jobs, actor(), { importId: scanned.id, paths: Object.keys(files) }));
    await runImport(deps, job);
    const totalMs = performance.now() - start;

    const done = await as((tx) => getImport(tx, actor(), scanned.id));
    expect(done).toMatchObject({
      state: "done",
      report: { imported: MARKDOWN + IMAGES, failed: 0, blockedSecret: 0 },
    });
    const { rows } = await admin.query(
      `select (select count(*)::int from hive.doc_repo_files where home_id = $1) as docs,
              (select count(*)::int from hive.doc_assets where home_id = $1 and state = 'available') as assets`,
      [homeId],
    );
    expect(rows[0]).toEqual({ docs: MARKDOWN, assets: IMAGES });

    const api = calls.filter((m) => m !== "archive");
    const byMethod: Record<string, number> = {};
    for (const m of calls) byMethod[m] = (byMethod[m] ?? 0) + 1;
    console.info(
      `[DOC-T026] files=${MARKDOWN}+${IMAGES} bytes=${(repoBytes / 1024 ** 2).toFixed(1)}MB latency=${LATENCY_MS}ms scan=${(scanMs / 1000).toFixed(1)}s total=${(totalMs / 1000).toFixed(1)}s calls=${JSON.stringify(byMethod)}`,
    );
    expect(api.length).toBeLessThanOrEqual(50);
    expect(totalMs).toBeLessThanOrEqual(BUDGET_MS);
  });
});
