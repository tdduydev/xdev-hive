import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../../test/org-fixture.ts";
import { seedProject } from "../../../../test/project-fixture.ts";
import { createPool, type Jobs, parseMasterKey, withTenant } from "../../platform/index.ts";
import { createMemoryProvider } from "../../scm/index.ts";
import { configureProjectHome } from "../homes.ts";
import { docWordImportFiles, docWordImports } from "../schema.ts";
import { refreshWordImportCounts, type WordImportPhase } from "./shared.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const mem = createMemoryProvider("gitlab", ["xdev-team"]);
const jobs = { enqueue: async () => randomUUID() } as unknown as Jobs;
const projectKey = `ws${tag}`;

let org: Awaited<ReturnType<typeof seedOrg>>;
let homeId: string;
const asOrg = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, { orgId: org.orgId }, fn);

type FileSpec = string | { state: string; excluded: true };

beforeAll(async () => {
  org = await seedOrg(admin, `dws-${tag}`);
  const project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
  mem.seedRepo({ owner: project.owner, name: project.repo }, { files: { "README.md": "# Repo\n" } });
  const home = await withTenant(pool, { userId: org.user("tadmin"), orgId: org.orgId }, (tx) =>
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
  homeId = home.id;
});

afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

async function seed(importState: string, files: FileSpec[]): Promise<string> {
  return asOrg(async (tx) => {
    const [imp] = await tx
      .insert(docWordImports)
      .values({ orgId: org.orgId, homeId, targetDir: "docs/srs", state: importState, createdBy: org.user("tadmin") })
      .returning({ id: docWordImports.id });
    if (!imp) throw new Error("không tạo được lượt");
    for (const [i, spec] of files.entries()) {
      const { state, excluded } = typeof spec === "string" ? { state: spec, excluded: false } : spec;
      await tx.insert(docWordImportFiles).values({
        orgId: org.orgId,
        importId: imp.id,
        fileName: `f${i}.docx`,
        format: "docx",
        size: 1,
        sha256: "0".repeat(64),
        state,
        excluded,
      });
    }
    return imp.id;
  });
}

async function refresh(importId: string, phase: WordImportPhase) {
  await asOrg((tx) => refreshWordImportCounts(tx, importId, phase));
  const { rows } = await admin.query("select state, counts from hive.doc_word_imports where id = $1", [importId]);
  return rows[0] as { state: string; counts: Record<string, number> };
}

describe("refreshWordImportCounts: đếm", () => {
  it("đếm theo trạng thái file, đổi blocked_secret thành blockedSecret", async () => {
    const id = await seed("ready", ["ready", "ready", "blocked_secret", "failed", "skipped", "proposed", "done"]);
    const { counts } = await refresh(id, "convert");
    expect(counts).toEqual({
      queued: 0,
      converting: 0,
      ready: 2,
      skipped: 1,
      blockedSecret: 1,
      failed: 1,
      proposed: 1,
      cancelled: 0,
      done: 1,
    });
  });

  it("lượt không tồn tại thì bỏ qua", async () => {
    await expect(asOrg((tx) => refreshWordImportCounts(tx, randomUUID(), "commit"))).resolves.toBeUndefined();
  });
});

describe("refreshWordImportCounts: luật của bước chuyển", () => {
  const cases: Array<[string, string, FileSpec[], string]> = [
    ["còn file chờ chuyển", "converting", ["queued", "ready"], "converting"],
    ["đang chuyển một file", "ready", ["converting"], "converting"],
    ["chuyển xong, còn file chờ tạo", "converting", ["ready", "done"], "ready"],
    ["file có bí mật vẫn chờ tạo", "converting", ["blocked_secret"], "ready"],
    ["chuyển xong, không còn gì để tạo", "converting", ["failed", "skipped"], "done"],
    ["file bỏ chọn không tính là chờ", "converting", [{ state: "ready", excluded: true }], "done"],
    ["từ ready không tự đóng lượt", "ready", ["done", "proposed"], "ready"],
    ["từ ready bỏ chọn hết vẫn giữ ready", "ready", [{ state: "ready", excluded: true }], "ready"],
    ["đang tải lên thì giữ nguyên", "uploading", ["queued"], "uploading"],
    ["đang tạo thì giữ nguyên", "committing", ["ready"], "committing"],
    ["đã xong thì giữ nguyên", "done", ["queued"], "done"],
    ["đã huỷ thì giữ nguyên", "cancelled", ["queued", "ready"], "cancelled"],
    ["đã hỏng thì giữ nguyên", "failed", ["ready"], "failed"],
  ];
  it.each(cases)("%s: %s → %s", async (_name, from, files, to) => {
    const id = await seed(from, files);
    expect((await refresh(id, "convert")).state).toBe(to);
  });
});

describe("refreshWordImportCounts: luật của bước tạo", () => {
  const cases: Array<[string, string, FileSpec[], string]> = [
    ["còn file chờ tạo", "ready", ["ready", "done"], "ready"],
    ["còn file có bí mật", "ready", ["blocked_secret", "done"], "ready"],
    ["còn file chờ chuyển", "converting", ["queued"], "converting"],
    ["không còn file chờ thì xong", "ready", ["done", "proposed", "failed"], "done"],
    ["file bỏ chọn không tính là chờ", "ready", [{ state: "ready", excluded: true }, "done"], "done"],
    ["đang tạo thì xong", "committing", ["done"], "done"],
    ["đang chuyển mà hết file chờ thì xong", "converting", ["skipped"], "done"],
    ["đang tải lên thì giữ nguyên", "uploading", ["done"], "uploading"],
    ["đã huỷ thì giữ nguyên", "cancelled", ["cancelled"], "cancelled"],
    ["đã hỏng thì giữ nguyên", "failed", ["done"], "failed"],
  ];
  it.each(cases)("%s: %s → %s", async (_name, from, files, to) => {
    const id = await seed(from, files);
    expect((await refresh(id, "commit")).state).toBe(to);
  });

  it("hai bước khác nhau ở lượt ready không còn file chờ", async () => {
    const files: FileSpec[] = ["done", "proposed"];
    expect((await refresh(await seed("ready", files), "convert")).state).toBe("ready");
    expect((await refresh(await seed("ready", files), "commit")).state).toBe("done");
  });
});
