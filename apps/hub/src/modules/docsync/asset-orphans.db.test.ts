import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { provideDocSaved, saveDoc } from "../knowledge/index.ts";
import { createPool, createPostgresBlobStore, type Jobs, parseMasterKey, withTenant } from "../platform/index.ts";
import { createMemoryProvider, GitProviderError } from "../scm/index.ts";
import { markOrphanAssets } from "./asset-orphans.ts";
import { configureProjectHome, type HomeRow } from "./homes.ts";
import { docSavedHandler, pushHome } from "./push.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const mem = createMemoryProvider("gitlab", ["xdev-team"]);
const jobs = { enqueue: async () => randomUUID() } as unknown as Jobs;
const deps = { pool, jobs, masterKey, providerFactory: () => mem, publicUrl: "https://hive.example" };
const blobStore = createPostgresBlobStore();
const projectKey = `ao${tag}`;

let org: Awaited<ReturnType<typeof seedOrg>>;
let project: Awaited<ReturnType<typeof seedProject>>;
let home: HomeRow;
const as = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(pool, { userId: org.user("tadmin"), orgId: org.orgId }, fn);
const key = (name: string) => `project/${projectKey}/guide/${name}`;
const repo = () => {
  const r = mem.repos.get(`${project.owner}/${project.repo}`.toLowerCase());
  if (!r) throw new Error("thiếu repo");
  return r;
};
const inRepo = (path: string) => repo().branches.get("main")?.has(path) ?? false;
const save = (name: string, content: string, baseVersion: number) =>
  as((tx) => saveDoc(tx, { kind: "user", userId: org.user("tadmin") }, { key: key(name), content, baseVersion }));
const push = async () => {
  await admin.query(
    "update hive.doc_homes set last_saved_at = now() - interval '2 minutes', first_queued_at = now() - interval '2 minutes' where id = $1",
    [home.id],
  );
  return pushHome(deps, { orgId: org.orgId, homeId: home.id });
};
const state = async (path: string) =>
  (await admin.query("select state from hive.doc_assets where home_id = $1 and repo_path = $2", [home.id, path]))
    .rows[0]?.state as string | undefined;
const mark = () => as((tx) => markOrphanAssets(tx, home.id));

const png = (seed: string) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(`${seed}-${tag}`)]);
const hashed = (seed: string) => {
  const bytes = png(seed);
  return { bytes, name: `${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.png` };
};

/** Ảnh `pending_push` ở thư mục ảnh của nhà; lô đẩy đưa nó vào repo như ảnh bước nhập Word tạo. */
async function seedAsset(name: string, bytes: Buffer, dir = "docs/assets", mediaType = "image/png") {
  const blob = await as((tx) =>
    blobStore.put(
      tx,
      org.orgId,
      (async function* () {
        yield bytes;
      })(),
      mediaType,
    ),
  );
  await admin.query(
    `insert into hive.doc_assets (org_id, home_id, repo_path, blob_id, media_type, size, sha256, state)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending_push')`,
    [org.orgId, home.id, `${dir}/${name}`, blob.id, mediaType, bytes.length, blob.sha256],
  );
  return `${dir}/${name}`;
}

const one = hashed("one");
const two = hashed("two");
const three = hashed("three");
const editorImage = "image-20261014-101500.png";
const outsideDir = hashed("outside");
let paths: Record<"one" | "two" | "three" | "editor" | "report" | "outside", string>;

beforeAll(async () => {
  org = await seedOrg(admin, `ao-${tag}`);
  project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
  mem.seedRepo({ owner: project.owner, name: project.repo }, { files: { "README.md": "# Repo\n" } });
  home = await as((tx) =>
    configureProjectHome(
      tx,
      deps,
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
  provideDocSaved(docSavedHandler(jobs));
  paths = {
    one: await seedAsset(one.name, one.bytes),
    two: await seedAsset(two.name, two.bytes),
    three: await seedAsset(three.name, three.bytes),
    editor: await seedAsset(editorImage, png(`editor-${tag}`)),
    report: await seedAsset("report.pdf", Buffer.from(`%PDF-1.7\n${tag}`), "docs/assets", "application/pdf"),
    // Tên kiểu hash nhưng không nằm trong thư mục ảnh của nhà.
    outside: await seedAsset(outsideDir.name, outsideDir.bytes, "docs/guide"),
  };
  await save("a", `# A\n\n![](../assets/${one.name})\n\n![](../assets/${two.name})\n`, 0);
  await save("b", `# B\n\n<img src="../assets/${two.name}">\n\n![](../assets/${three.name})\n`, 0);
  expect(await push()).toBe("pushed");
});

afterAll(async () => {
  provideDocSaved(undefined);
  await Promise.all([admin.end(), pool.end()]);
});

describe("đánh dấu ảnh mồ côi", () => {
  it("ảnh còn tài liệu trỏ tới, ảnh editor và file khác không bị đánh dấu", async () => {
    expect(await mark()).toBe(0);
    for (const p of Object.values(paths)) expect(await state(p)).toBe("available");
  });

  it("chỉ ảnh hash của nhà mà không tài liệu nào trỏ tới chuyển pending_delete", async () => {
    // Bản mới của a bỏ ảnh one; b vẫn trỏ tới two (qua <img>) và three.
    await save("a", "# A\n\nKhông còn ảnh.\n", 1);
    expect(await mark()).toBe(1);
    expect(await state(paths.one)).toBe("pending_delete");
    for (const p of [paths.two, paths.three, paths.editor, paths.report, paths.outside])
      expect(await state(p)).toBe("available");
    // Chạy lại không đánh dấu thêm.
    expect(await mark()).toBe(0);
  });
});

describe("lô đẩy xoá ảnh", () => {
  it("lô lỗi giữ dòng pending_delete và ảnh trong repo", async () => {
    mem.fail("commitFiles", new GitProviderError("unavailable", "GitHub đang lỗi"));
    expect(await push()).toBe("failed");
    mem.fail("commitFiles", null);
    expect(await state(paths.one)).toBe("pending_delete");
    expect(inRepo(paths.one)).toBe(true);
    await admin.query("update hive.doc_sync_batches set next_at = now() - interval '1 second' where home_id = $1", [
      home.id,
    ]);
  });

  it("ảnh được tài liệu trỏ lại trước lô kế tiếp thì ở lại", async () => {
    await save("b", `# B\n\n![](../assets/${one.name})\n\n![](../assets/${three.name})\n`, 1);
    expect(await push()).toBe("pushed");
    expect(await state(paths.one)).toBe("available");
    expect(inRepo(paths.one)).toBe(true);
  });

  it("ảnh mồ côi rời repo ở lô kế tiếp, dòng bị xoá, ảnh editor và file khác giữ nguyên", async () => {
    await save("b", "# B\n\nHết ảnh.\n", 2);
    expect(await mark()).toBe(3);
    const before = repo().commits.filter((c) => c.branch === "main").length;
    expect(await push()).toBe("pushed");
    const commits = repo().commits.filter((c) => c.branch === "main");
    expect(commits).toHaveLength(before + 1);
    expect(commits.at(-1)?.message).toContain("remove 3 orphaned attachments");
    for (const p of [paths.one, paths.two, paths.three]) {
      expect(inRepo(p)).toBe(false);
      expect(await state(p)).toBeUndefined();
    }
    for (const p of [paths.editor, paths.report, paths.outside]) {
      expect(inRepo(p)).toBe(true);
      expect(await state(p)).toBe("available");
    }
  });

  it("ảnh pending_delete đã không còn trong repo thì chỉ xoá dòng, không tạo commit", async () => {
    const gone = hashed("gone");
    const path = await seedAsset(gone.name, gone.bytes);
    await admin.query("update hive.doc_assets set state = 'pending_delete' where repo_path = $1", [path]);
    const before = repo().commits.length;
    expect(await push()).toBe("empty");
    expect(repo().commits).toHaveLength(before);
    expect(await state(path)).toBeUndefined();
  });
});
