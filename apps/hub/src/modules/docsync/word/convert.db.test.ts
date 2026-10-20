import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../../test/org-fixture.ts";
import { seedProject } from "../../../../test/project-fixture.ts";
import { createPool, createPostgresBlobStore, type Jobs, parseMasterKey, withTenant } from "../../platform/index.ts";
import { createMemoryProvider } from "../../scm/index.ts";
import { configureProjectHome, type HomeRow } from "../homes.ts";
import { DOCSYNC_WORD_IMPORT_QUEUE } from "../queues.ts";
import { docWordImportFiles, docWordImports } from "../schema.ts";
import { runWordImportJob, sweepWordImports } from "./convert.ts";
import { detectPandoc, PANDOC_VERSION, type PandocCommand } from "./pandoc.ts";
import type { WordTools } from "./tools.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const mem = createMemoryProvider("gitlab", ["xdev-team"]);
const queued: Array<{ queue: string; data: Record<string, unknown>; options?: Record<string, unknown> }> = [];
const jobs = {
  enqueue: async (queue: string, data: Record<string, unknown>, options?: Record<string, unknown>) => {
    queued.push({ queue, data, ...(options ? { options } : {}) });
    return randomUUID();
  },
} as unknown as Jobs;
const projectKey = `wc${tag}`;
const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const hang = [process.execPath, fileURLToPath(new URL("./test-bin/pandoc-hang.mjs", import.meta.url))] as const;
// PNG 1×1 thật: kho file dò loại theo nội dung nên ảnh giả không qua được.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
// Đầu bản ghi EMR_HEADER cùng chữ ký " EMF" ở byte 40; trình duyệt và kho file đều không nhận ra là ảnh.
const EMF = Buffer.concat([
  Buffer.from([1, 0, 0, 0, 108, 0, 0, 0]),
  Buffer.alloc(32),
  Buffer.from(" EMF"),
  Buffer.alloc(64),
]);

let org: Awaited<ReturnType<typeof seedOrg>>;
let home: HomeRow;
let bin: string;
const asOrg = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, { orgId: org.orgId }, fn);

interface FakeOutput {
  markdown: string;
  media?: Record<string, Uint8Array>;
  log?: unknown[];
}

/** Pandoc giả ghi đúng kết quả cho trước; nội dung nằm trong script vì tiến trình con chỉ nhận env tối thiểu. */
async function fakePandoc(output: FakeOutput): Promise<PandocCommand> {
  const spec = {
    markdown: output.markdown,
    media: Object.fromEntries(
      Object.entries(output.media ?? {}).map(([p, b]) => [p, Buffer.from(b).toString("base64")]),
    ),
    log: output.log ?? [],
  };
  const script = join(bin, `pandoc-${randomUUID()}.mjs`);
  await writeFile(
    script,
    `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const spec = ${JSON.stringify(spec)};
if (process.argv[2] === "--version") { process.stdout.write("pandoc 3.12\\n"); process.exit(0); }
for (const [path, b64] of Object.entries(spec.media)) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(b64, "base64"));
}
writeFileSync("out.md", spec.markdown);
writeFileSync("log.json", JSON.stringify(spec.log));
`,
  );
  return [process.execPath, script];
}

const tools = (pandocPath: PandocCommand, timeoutMs = 30_000): WordTools =>
  ({
    config: { pandocPath, timeoutMs },
    pandoc: { ok: true, version: PANDOC_VERSION },
    soffice: { ok: false },
  }) as unknown as WordTools;

async function docx(entries: Record<string, string | Uint8Array> = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", "<w:document/>");
  for (const [name, data] of Object.entries(entries)) zip.file(name, data);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** Lượt tạo một file đã tải lên, file chờ chuyển như sau bước upload (T008). */
async function seedFile(bytes: Uint8Array, opts: { format?: "docx" | "odt"; fileName?: string } = {}) {
  const fileName = opts.fileName ?? `srs-${randomUUID().slice(0, 6)}.docx`;
  return asOrg(async (tx) => {
    const blob = await createPostgresBlobStore().put(
      tx,
      org.orgId,
      (async function* () {
        yield bytes;
      })(),
      "application/octet-stream",
    );
    const [imp] = await tx
      .insert(docWordImports)
      .values({
        orgId: org.orgId,
        homeId: home.id,
        targetDir: "docs/srs",
        state: "converting",
        createdBy: org.user("tadmin"),
      })
      .returning();
    if (!imp) throw new Error("không tạo được lượt");
    const [file] = await tx
      .insert(docWordImportFiles)
      .values({
        orgId: org.orgId,
        importId: imp.id,
        fileName,
        format: opts.format ?? "docx",
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        blobId: blob.id,
        proposedPath: `docs/srs/${fileName.replace(/\.[^.]+$/, "")}.md`,
        proposedTitle: "Tài liệu SRS",
      })
      .returning();
    if (!file) throw new Error("không tạo được file");
    return { importId: imp.id, fileId: file.id };
  });
}

async function run(pandoc: PandocCommand, bytes: Uint8Array, timeoutMs?: number) {
  const seeded = await seedFile(bytes);
  const state = await runWordImportJob(
    { pool, tools: tools(pandoc, timeoutMs) },
    { orgId: org.orgId, fileId: seeded.fileId },
  );
  return { ...seeded, state, ...(await read(seeded.fileId, seeded.importId)) };
}

async function read(fileId: string, importId: string) {
  const { rows } = await admin.query("select * from hive.doc_word_import_files where id = $1", [fileId]);
  const imp = await admin.query("select state, counts from hive.doc_word_imports where id = $1", [importId]);
  return { file: rows[0], imp: imp.rows[0] };
}

beforeAll(async () => {
  bin = await mkdtemp(join(tmpdir(), "hive-fake-pandoc-"));
  org = await seedOrg(admin, `dwc-${tag}`);
  const project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
  mem.seedRepo({ owner: project.owner, name: project.repo }, { files: { "README.md": "# Repo\n" } });
  home = await withTenant(pool, { userId: org.user("tadmin"), orgId: org.orgId }, (tx) =>
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
});

afterAll(async () => {
  await rm(bin, { recursive: true, force: true });
  await Promise.all([admin.end(), pool.end()]);
});

describe("job chuyển Word", () => {
  it("chuyển xong: front matter, ảnh đổi tên theo nội dung, cảnh báo, lượt sang ready", async () => {
    const pandoc = await fakePandoc({
      markdown: "# Tổng quan\n\n![](m/media/image1.png)\n",
      media: { "m/media/image1.png": PNG },
      log: [{ type: "ScriptingWarning", verbosity: "WARNING", message: "footnote: 2" }],
    });
    const { state, file, imp } = await run(pandoc, await docx());
    expect(state).toBe("ready");
    const name = `${createHash("sha256").update(PNG).digest("hex").slice(0, 12)}.png`;
    expect(file.markdown).toMatch(/^---\ntitle: "Tài liệu SRS"\nword:\n {2}file: "srs-[0-9a-f]{6}\.docx"\n/);
    expect(file.markdown).toContain(`# Tổng quan\n\n![](${name})\n`);
    expect(file.images).toEqual([{ name, blobId: expect.any(String), mediaType: "image/png", bytes: PNG.byteLength }]);
    expect(file.warnings).toEqual([{ code: "footnote", count: 2, detail: null }]);
    expect(file.stats).toEqual({ headings: 1, tables: 0, images: 1 });
    expect(imp).toMatchObject({ state: "ready", counts: { ready: 1, converting: 0, queued: 0 } });
  });

  it("logo lặp ở nhiều chỗ chỉ thành một ảnh, một blob (US2 kịch bản 4)", async () => {
    const before = await admin.query("select count(*)::int as n from hive.blobs where org_id = $1", [org.orgId]);
    const logo = Buffer.concat([PNG, Buffer.from(randomUUID())]);
    const pandoc = await fakePandoc({
      markdown: "# A\n\n![](m/media/image1.png)\n\n# B\n\n![](m/media/image7.png)\n",
      media: { "m/media/image1.png": logo, "m/media/image7.png": logo },
    });
    const { file } = await run(pandoc, await docx({ "docProps/custom.xml": randomUUID() }));
    const name = `${createHash("sha256").update(logo).digest("hex").slice(0, 12)}.png`;
    expect(file.images.map((i: { name: string }) => i.name)).toEqual([name]);
    expect(file.markdown.split(`![](${name})`)).toHaveLength(3);
    const after = await admin.query("select count(*)::int as n from hive.blobs where org_id = $1", [org.orgId]);
    // Một blob cho file Word, một cho logo.
    expect(after.rows[0].n - before.rows[0].n).toBe(2);
  });

  it("EMF giữ làm link tải kèm cảnh báo emf_image (Q10)", async () => {
    const pandoc = await fakePandoc({
      markdown: "# Sơ đồ\n\n![Quy trình](m/media/image10.emf)\n",
      media: { "m/media/image10.emf": EMF },
    });
    const { state, file } = await run(pandoc, await docx());
    expect(state).toBe("ready");
    const name = `${createHash("sha256").update(EMF).digest("hex").slice(0, 12)}.emf`;
    expect(file.markdown).toContain(`[Quy trình](${name})`);
    expect(file.markdown).not.toContain("![");
    expect(file.images).toEqual([expect.objectContaining({ name, mediaType: "application/octet-stream" })]);
    expect(file.warnings).toEqual([{ code: "emf_image", count: 1, detail: null }]);
  });

  it("zip bomb: dừng giải nén, file hỏng với FILE_TOO_LARGE", async () => {
    const entries = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`word/media/x${i}.bin`, "x"]));
    const pandoc = await fakePandoc({ markdown: "# Không được chạy\n" });
    const { state, file, imp } = await run(pandoc, await docx(entries));
    expect(state).toBe("failed");
    expect(file.error).toMatchObject({
      code: "WORD_IMPORT_FILE_TOO_LARGE",
      detail: expect.stringContaining("zip bomb"),
    });
    expect(file.markdown).toBeNull();
    // Không còn file nào chờ tạo nên lượt kết thúc.
    expect(imp).toMatchObject({ state: "done", counts: { failed: 1 } });
  });

  it("không phải zip, hay zip không có word/document.xml: NOT_WORD; container OLE: PASSWORD", async () => {
    const pandoc = await fakePandoc({ markdown: "# x\n" });
    expect((await run(pandoc, Buffer.from("không phải zip"))).file.error.code).toBe("WORD_IMPORT_NOT_WORD");
    const bare = new JSZip();
    bare.file("a.txt", "a");
    const zip = await bare.generateAsync({ type: "uint8array" });
    expect((await run(pandoc, zip)).file.error.code).toBe("WORD_IMPORT_NOT_WORD");
    const ole = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(504)]);
    expect((await run(pandoc, ole)).file.error.code).toBe("WORD_IMPORT_PASSWORD");
  });

  it("quá 200.000 ký tự: file hỏng với TOO_LONG, không lưu ảnh", async () => {
    const pandoc = await fakePandoc({
      markdown: `# Dài\n\n${"Đoạn văn rất dài. ".repeat(12_000)}\n![](m/media/image1.png)\n`,
      media: { "m/media/image1.png": Buffer.concat([PNG, Buffer.from(randomUUID())]) },
    });
    const { state, file } = await run(pandoc, await docx());
    expect(state).toBe("failed");
    expect(file.error).toMatchObject({ code: "WORD_IMPORT_TOO_LONG", detail: expect.stringMatching(/^\d+ ký tự\.$/) });
    expect(file.images).toEqual([]);
  });

  it("pandoc treo: dừng sau thời hạn, file hỏng với TIMEOUT (SC-005)", async () => {
    const started = Date.now();
    const { state, file } = await run(hang, await docx(), 1_500);
    expect(state).toBe("failed");
    expect(file.error.code).toBe("WORD_IMPORT_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("pandoc lỗi: CONVERT_FAILED kèm stderr", async () => {
    const fail = [process.execPath, fileURLToPath(new URL("./test-bin/pandoc-fail.mjs", import.meta.url))] as const;
    const { state, file } = await run(fail, await docx());
    expect(state).toBe("failed");
    expect(file.error.code).toBe("WORD_IMPORT_CONVERT_FAILED");
  });

  it("chuỗi giống token: blocked_secret, chỉ lưu loại và dòng (FR-018)", async () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
    const pandoc = await fakePandoc({ markdown: `# Cấu hình\n\nToken thử: ${token}\n` });
    const { state, file, imp } = await run(pandoc, await docx());
    expect(state).toBe("blocked_secret");
    expect(file.findings).toEqual([{ kind: expect.any(String), line: expect.any(Number) }]);
    expect(JSON.stringify(file.findings)).not.toContain(token);
    // Dòng tính trên Markdown đã có front matter, đúng dòng người dùng thấy ở xem trước.
    expect(file.markdown.split("\n")[file.findings[0].line - 1]).toContain(token);
    expect(imp).toMatchObject({ state: "ready", counts: { blockedSecret: 1 } });
  });

  it("job chạy lại sau khi hub khởi động lại không chuyển lần nữa", async () => {
    const pandoc = await fakePandoc({
      markdown: "# Một lần\n\n![](m/media/image1.png)\n",
      media: { "m/media/image1.png": Buffer.concat([PNG, Buffer.from(randomUUID())]) },
    });
    const first = await run(pandoc, await docx());
    expect(first.state).toBe("ready");
    const other = await fakePandoc({ markdown: "# Lần hai\n" });
    const again = await runWordImportJob({ pool, tools: tools(other) }, { orgId: org.orgId, fileId: first.fileId });
    expect(again).toBe("skipped");
    const after = await read(first.fileId, first.importId);
    expect(after.file.markdown).toBe(first.file.markdown);
    expect(after.file.images).toEqual(first.file.images);
  });

  it("file đang converting (hub tắt giữa chừng) thì chuyển tiếp được", async () => {
    const pandoc = await fakePandoc({ markdown: "# Tiếp\n" });
    const seeded = await seedFile(await docx());
    await admin.query("update hive.doc_word_import_files set state = 'converting' where id = $1", [seeded.fileId]);
    expect(await runWordImportJob({ pool, tools: tools(pandoc) }, { orgId: org.orgId, fileId: seeded.fileId })).toBe(
      "ready",
    );
  });

  it("lượt đã huỷ thì không chuyển", async () => {
    const pandoc = await fakePandoc({ markdown: "# Huỷ\n" });
    const seeded = await seedFile(await docx());
    await admin.query("update hive.doc_word_imports set state = 'cancelled' where id = $1", [seeded.importId]);
    expect(await runWordImportJob({ pool, tools: tools(pandoc) }, { orgId: org.orgId, fileId: seeded.fileId })).toBe(
      "skipped",
    );
    expect((await read(seeded.fileId, seeded.importId)).file.state).toBe("queued");
  });

  it("cron xếp lại file chờ quá lâu, khoá theo file", async () => {
    const seeded = await seedFile(await docx());
    const fresh = await seedFile(await docx());
    await admin.query("update hive.doc_word_import_files set updated_at = now() - interval '1 hour' where id = $1", [
      seeded.fileId,
    ]);
    queued.length = 0;
    await sweepWordImports({ pool, tools: tools("pandoc"), jobs });
    const mine = queued.filter((j) => j.queue === DOCSYNC_WORD_IMPORT_QUEUE && j.data.orgId === org.orgId);
    expect(mine.map((j) => j.data.fileId)).toContain(seeded.fileId);
    expect(mine.map((j) => j.data.fileId)).not.toContain(fresh.fileId);
    expect(mine.find((j) => j.data.fileId === seeded.fileId)?.options).toMatchObject({ singletonKey: seeded.fileId });
  });
});

const real = await detectPandoc("pandoc");
const goldenReady = real.ok && real.version === PANDOC_VERSION;
if (!goldenReady) console.warn(`Bỏ qua so job với golden: cần pandoc ${PANDOC_VERSION}.`);

/** Về dạng so được: bỏ front matter, link ảnh (tên băm hay `m/media/…`, ODT là `m/Pictures/…`) thành chỗ giữ, EMF thành link tải. */
function normalize(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n\n/, "")
    .replace(/!\[([^\]]*)\]\(m\/(?:media|Pictures)\/[^)]+\.(?:emf|wmf)\)/g, "[EMF]")
    .replace(/\[[^\]]*\]\([0-9a-f]{12}\.(?:emf|wmf)\)/g, "[EMF]")
    .replace(/(!\[[^\]]*\]\()(?:m\/(?:media|Pictures)\/[^)]+|[0-9a-f]{12}\.[a-z0-9]+)\)/g, "$1IMG)");
}

describe.skipIf(!goldenReady)("job chuyển Word với pandoc thật", () => {
  for (const [input, golden, format] of [
    ["srs.docx", "srs.md", "docx"],
    ["srs.odt", "srs.odt.md", "odt"],
    ["no-h1.docx", "no-h1.md", "docx"],
  ] as const) {
    it(`${input} ra đúng ${golden} sau hậu xử lý`, async () => {
      const bytes = readFileSync(join(fixtureDir, input));
      const seeded = await seedFile(bytes, { format, fileName: input });
      await runWordImportJob({ pool, tools: tools("pandoc") }, { orgId: org.orgId, fileId: seeded.fileId });
      const { file } = await read(seeded.fileId, seeded.importId);
      expect(file.state).toBe("ready");
      expect(normalize(file.markdown)).toBe(normalize(readFileSync(join(fixtureDir, golden), "utf8")));
    }, 60_000);
  }
});
