import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../../test/org-fixture.ts";
import { seedProject } from "../../../../test/project-fixture.ts";
import { docHistory, provideDocSaved, saveDoc, saveDocFromSync } from "../../knowledge/index.ts";
import { createPool, type Jobs, parseMasterKey, withTenant } from "../../platform/index.ts";
import { createMemoryProvider } from "../../scm/index.ts";
import { configureProjectHome, type HomeRow } from "../homes.ts";
import { DOCSYNC_PUSH_QUEUE } from "../jobs.ts";
import { docSavedHandler } from "../push.ts";

// plan.md mục 1: onDocSaved chỉ bỏ qua `repo` và `import`, nên bản lưu nguồn `word` được đẩy như `hub` mà không sửa hook.
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
const deps = { pool, jobs, masterKey, providerFactory: () => mem };
const projectKey = `ws${tag}`;

let org: Awaited<ReturnType<typeof seedOrg>>;
let project: Awaited<ReturnType<typeof seedProject>>;
let home: HomeRow;
const actor = () => ({ userId: org.user("tadmin"), orgId: org.orgId });
const as = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, actor(), fn);
const principal = () => ({ kind: "user" as const, userId: org.user("tadmin") });
const key = (name: string) => `project/${projectKey}/srs/${name}`;
const repoFile = async (docKey: string) =>
  (
    await admin.query(
      "select f.repo_path, f.state from hive.doc_repo_files f join hive.docs d on d.id = f.doc_id where d.key = $1",
      [docKey],
    )
  ).rows;
const pushes = () => queued.filter((job) => job.queue === DOCSYNC_PUSH_QUEUE && job.data.homeId === home.id);

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
  home = await as((tx) =>
    configureProjectHome(tx, deps, actor(), {
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

describe("nguồn phiên bản word", () => {
  it("saveDoc nguồn word tạo dòng chờ đẩy và xếp lô đẩy như hub", async () => {
    const doc = await as((tx) =>
      saveDoc(
        tx,
        principal(),
        { key: key("opd17"), content: "# OPD17\n\nNội dung từ Word.\n", baseVersion: 0 },
        { source: "word" },
      ),
    );
    expect(await repoFile(doc.key)).toEqual([{ repo_path: "docs/srs/opd17.md", state: "pending" }]);
    expect(pushes()).toHaveLength(1);
    const { rows } = await admin.query("select source from hive.doc_versions where doc_id = $1", [doc.id]);
    expect(rows).toEqual([{ source: "word" }]);
    expect(await as((tx) => docHistory(tx, principal(), { key: doc.key }))).toMatchObject([
      { version: 1, source: "word" },
    ]);
  });

  it("không truyền nguồn thì vẫn là hub", async () => {
    const doc = await as((tx) => saveDoc(tx, principal(), { key: key("hub"), content: "# Hub\n", baseVersion: 0 }));
    expect(await repoFile(doc.key)).toEqual([{ repo_path: "docs/srs/hub.md", state: "pending" }]);
    expect(await as((tx) => docHistory(tx, principal(), { key: doc.key }))).toMatchObject([{ source: "hub" }]);
  });

  it("bản lưu nguồn import không tạo dòng chờ đẩy", async () => {
    const doc = await as((tx) =>
      saveDocFromSync(tx, {
        key: key("imported"),
        content: "# Đã có trong repo\n",
        baseVersion: 0,
        scope: { teamId: org.teamId, projectId: project.projectId },
        source: "import",
      }),
    );
    expect(await repoFile(doc.key)).toEqual([]);
    expect(pushes()).toHaveLength(0);
  });
});
