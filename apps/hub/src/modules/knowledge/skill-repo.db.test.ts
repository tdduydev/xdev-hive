import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, decryptSecret, type Jobs, parseMasterKey, withTenant } from "../platform/index.ts";
import { createMemoryProvider } from "../scm/index.ts";
import { createProposal, rejectProposal } from "./proposals.ts";
import { proposals, skillRepos, skills } from "./schema.ts";
import {
  closeProposalPR,
  handleSkillWebhook,
  openProposalPR,
  parseSkillFile,
  renderSkillFile,
  type SkillGitJob,
  setSkillRepo,
  syncSkillRepo,
} from "./skill-repo.ts";
import { getSkill, listSkills, saveSkill } from "./skills.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const mem = createMemoryProvider("github", ["acme"]);
const REF = { owner: "acme", name: "xdev-skills" };
const queued: SkillGitJob[] = [];
const jobs = {
  enqueue: async (_q: string, data: object) => {
    queued.push(data as SkillGitJob);
    return randomUUID();
  },
} as unknown as Jobs;
const deps = { pool, masterKey, providerFactory: () => mem, publicUrl: "https://hive.example", jobs };

let org: Awaited<ReturnType<typeof seedOrg>>;
let project: { projectId: string; connectionId: string };
const projectKey = `sk${tag}`;
const asAdmin = () => ({ userId: org.user("admin"), orgId: org.orgId });
const inOrg = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, asAdmin(), fn);
const filesOnMain = () => mem.repos.get("acme/xdev-skills")?.branches.get("main") as Map<string, string>;

beforeAll(async () => {
  org = await seedOrg(admin, `skr-${tag}`);
  project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
  mem.seedRepo(REF, {
    files: {
      "README.md": "# skills\n",
      "org/review/SKILL.md": renderSkillFile("review", "Đọc diff kỹ", "Đọc từng file trong diff."),
      "teams/thanh-toan/money/SKILL.md": renderSkillFile("money", "Tiền tệ", "Lưu tiền theo đơn vị nhỏ nhất."),
      [`projects/${projectKey}/api/SKILL.md`]: renderSkillFile("api", "API", "Mã lỗi theo module."),
      "teams/khong-co/x/SKILL.md": renderSkillFile("x", "x", "x"),
      "org/notes.md": "không phải skill",
    },
  });
});

afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

describe("định dạng SKILL.md", () => {
  it("đọc frontmatter và nội dung, ghi lại khớp", () => {
    const text = renderSkillFile("review", 'Có "ngoặc": và #', "Nội dung.");
    expect(parseSkillFile(text)).toEqual({ name: "review", description: 'Có "ngoặc": và #', content: "Nội dung." });
    expect(parseSkillFile("Chỉ có nội dung\n")).toEqual({ name: null, description: "", content: "Chỉ có nội dung" });
    expect(parseSkillFile("---\nname: 'a'\ndescription: 'it''s'\n---\nX")).toMatchObject({
      name: "a",
      description: "it's",
    });
  });
});

describe("kết nối và đồng bộ kho skill", () => {
  it("repo không có thì báo lỗi; có thì lưu, gắn webhook và xếp lần đồng bộ đầu", async () => {
    await expect(
      setSkillRepo(deps, asAdmin(), {
        connectionId: project.connectionId,
        owner: "acme",
        name: "khong-co",
        branch: "main",
      }),
    ).rejects.toMatchObject({ code: "SKILL_REPO_NOT_FOUND" });
    const repo = await setSkillRepo(deps, asAdmin(), {
      connectionId: project.connectionId,
      owner: "acme",
      name: "xdev-skills",
      branch: "main",
    });
    expect(repo).toMatchObject({
      owner: "acme",
      name: "xdev-skills",
      status: "idle",
      webhookUrl: expect.stringContaining("/hooks/skills/"),
    });
    expect([...(mem.repos.get("acme/xdev-skills")?.hooks.values() ?? [])][0]).toMatchObject({ events: ["push"] });
    expect(queued.at(-1)).toEqual({ kind: "sync", orgId: org.orgId });
  });

  it("kéo skill theo thư mục vào đúng phạm vi; thư mục không khớp đội nào thì cảnh báo", async () => {
    await syncSkillRepo(deps, org.orgId);
    const rows = await inOrg((tx) =>
      tx
        .select({ name: skills.name, teamId: skills.teamId, projectId: skills.projectId, repoPath: skills.repoPath })
        .from(skills),
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.review).toMatchObject({ teamId: null, projectId: null, repoPath: "org/review/SKILL.md" });
    expect(byName.money).toMatchObject({ teamId: org.teamId, projectId: null });
    expect(byName.api).toMatchObject({ projectId: project.projectId });
    expect(byName.x).toBeUndefined();
    const row = await inOrg(async (tx) => (await tx.select().from(skillRepos))[0]);
    expect(row).toMatchObject({ status: "ok", lastSha: await mem.branchHead(REF, "main") });
    expect(row?.error).toContain("khong-co");
    // Dự án thấy bộ skill áp dụng: của dự án, của đội, của tổ chức.
    const forProject = await inOrg((tx) =>
      listSkills(tx, { kind: "user", userId: org.user("tadmin") }, { project: projectKey }),
    );
    expect(forProject.map((s) => s.name).sort()).toEqual(["api", "money", "review"]);
  });

  it("sửa trong Git thì hub có phiên bản mới; đồng bộ lại không đổi gì thì không tạo phiên bản", async () => {
    await mem.commitFiles(REF, {
      branch: "main",
      message: "sửa review",
      files: [
        { path: "org/review/SKILL.md", content: renderSkillFile("review", "Đọc diff kỹ", "Đọc từng file, chạy test.") },
      ],
    });
    await syncSkillRepo(deps, org.orgId);
    await syncSkillRepo(deps, org.orgId);
    const s = await inOrg((tx) => getSkill(tx, { kind: "user", userId: org.user("admin") }, { name: "review" }));
    expect(s).toMatchObject({ version: 2, content: "Đọc từng file, chạy test." });
  });

  it("sửa trên hub và skill mới trên hub được đẩy lên Git trong một commit", async () => {
    const admin1 = { kind: "user" as const, userId: org.user("admin") };
    await inOrg((tx) =>
      saveSkill(tx, admin1, {
        scope: { level: "org" },
        name: "review",
        description: "Đọc diff kỹ",
        content: "Bản sửa trên hub.",
        baseVersion: 2,
      }),
    );
    await inOrg((tx) =>
      saveSkill(tx, admin1, {
        scope: { level: "team", teamId: org.teamId },
        name: "deploy",
        description: "Triển khai",
        content: "Chạy migration trước.",
        baseVersion: 0,
      }),
    );
    const before = (await mem.branchHead(REF, "main")) as string;
    await syncSkillRepo(deps, org.orgId);
    const after = await mem.branchHead(REF, "main");
    expect(after).not.toBe(before);
    const commit = mem.repos.get("acme/xdev-skills")?.commits.at(-1);
    expect(commit?.message).toContain(`Co-authored-by: ${org.user("admin")} <${org.user("admin")}@seed.test>`);
    expect(parseSkillFile(filesOnMain().get("org/review/SKILL.md") ?? "").content).toBe("Bản sửa trên hub.");
    expect(parseSkillFile(filesOnMain().get("teams/thanh-toan/deploy/SKILL.md") ?? "")).toMatchObject({
      name: "deploy",
      content: "Chạy migration trước.",
    });
    const row = await inOrg(async (tx) => (await tx.select().from(skillRepos))[0]);
    // Commit của chính hub không bị kéo về lần nữa khi webhook báo.
    expect(row?.lastSha).toBe(after);
    const pending = await inOrg((tx) => tx.select().from(skills).where(eq(skills.name, "deploy")));
    expect(pending[0]).toMatchObject({ repoPath: "teams/thanh-toan/deploy/SKILL.md", repoVersion: 1 });
  });

  it("xoá file trong Git thì xoá skill trên hub", async () => {
    filesOnMain().delete(`projects/${projectKey}/api/SKILL.md`);
    await mem.commitFiles(REF, {
      branch: "main",
      message: "xoá api",
      files: [{ path: "README.md", content: "# skills v2\n" }],
    });
    await syncSkillRepo(deps, org.orgId);
    const names = (await inOrg((tx) => tx.select({ name: skills.name }).from(skills))).map((r) => r.name);
    expect(names).not.toContain("api");
    expect(names).toContain("deploy");
  });

  it("đề xuất skill mở PR; từ chối trên hub thì đóng PR", async () => {
    const p = await inOrg((tx) =>
      createProposal(
        tx,
        { kind: "user", userId: org.user("tmember") },
        {
          kind: "skill",
          scope: { level: "team", teamId: org.teamId },
          name: "money",
          description: "Tiền tệ",
          content: "Làm tròn theo dòng.",
          baseVersion: 1,
          reason: "Thống nhất cách làm tròn",
        },
      ),
    );
    await openProposalPR(deps, org.orgId, p.id);
    const row = await inOrg(async (tx) => (await tx.select().from(proposals).where(eq(proposals.id, p.id)))[0]);
    expect(row?.gitPrNumber).toBeGreaterThan(0);
    const pr = mem.repos.get("acme/xdev-skills")?.pulls.find((x) => x.number === row?.gitPrNumber);
    expect(pr).toMatchObject({ state: "open", base: "main", head: `hive/skill-proposal-${p.id.slice(0, 8)}` });
    await inOrg((tx) =>
      rejectProposal(tx, { kind: "user", userId: org.user("tadmin") }, { id: p.id, note: "Chưa cần" }),
    );
    await closeProposalPR(deps, org.orgId, p.id);
    expect(pr?.state).toBe("closed");
  });
});

describe("webhook kho skill", () => {
  const post = (id: string, headers: Record<string, string>, body: string) =>
    handleSkillWebhook(deps, id, new Request("https://hive.example/hooks/skills/x", { method: "POST", headers, body }));

  it("sai chữ ký thì 401; ping thì 204; push vào nhánh của kho thì xếp đồng bộ, nhánh khác thì không", async () => {
    const row = await inOrg(async (tx) => (await tx.select().from(skillRepos))[0]);
    const id = row?.id as string;
    const secret = decryptSecret(masterKey, row?.webhookSecretEnc as string, `skill_repos:${id}`);
    const sign = (b: string) => `sha256=${createHmac("sha256", secret).update(b).digest("hex")}`;
    const push = JSON.stringify({ ref: "refs/heads/main" });
    expect((await post(id, { "x-github-event": "push", "x-hub-signature-256": "sha256=00" }, push)).status).toBe(401);
    expect((await post(id, { "x-github-event": "ping", "x-hub-signature-256": sign("{}") }, "{}")).status).toBe(204);
    const before = queued.length;
    const other = JSON.stringify({ ref: "refs/heads/feature" });
    expect((await post(id, { "x-github-event": "push", "x-hub-signature-256": sign(other) }, other)).status).toBe(202);
    expect(queued.length).toBe(before);
    expect((await post(id, { "x-github-event": "push", "x-hub-signature-256": sign(push) }, push)).status).toBe(202);
    expect(queued.at(-1)).toEqual({ kind: "sync", orgId: org.orgId });
    expect((await post(randomUUID(), { "x-github-event": "push" }, push)).status).toBe(404);
  });

  it("tổ chức khác không thấy kho skill", async () => {
    const other = await seedOrg(admin, `skr2-${tag}`);
    const rows = await withTenant(pool, { userId: other.user("admin"), orgId: other.orgId }, (tx) =>
      tx.select().from(skillRepos),
    );
    expect(rows).toEqual([]);
  });
});
