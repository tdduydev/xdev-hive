import { randomBytes, randomUUID } from "node:crypto";
import {
  defaultProjectSettings,
  type ProjectSdlcSettingsInput,
  projectSdlcSettings,
  type SdlcItemCreate,
} from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, type Jobs, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createMemoryProvider, type MemoryProvider } from "../scm/index.ts";
import {
  cancelItem,
  changeItemMode,
  createItem,
  getItem,
  issueNumberOf,
  itemBoard,
  listItems,
  pauseItem,
  resumeItem,
  suggestItem,
} from "./items.ts";
import { handleSdlcJob } from "./jobs.ts";
import { onBaseline, type SdlcDeps } from "./phases.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let home = { id: "", key: "" };
let off = { id: "", key: "" };
let provider: MemoryProvider;
let enqueued: { queue: string; data: Record<string, unknown> }[] = [];
const jobs = {
  enqueue: async (queue: string, data: Record<string, unknown>) => {
    enqueued.push({ queue, data });
    return randomUUID();
  },
} as unknown as Jobs;
let deps: SdlcDeps;

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

const IDEA = "Cho phép hoàn tiền một phần cho đơn hàng đã thanh toán, có ghi lý do và thông báo khách.";

const input = (over: Partial<SdlcItemCreate> = {}): SdlcItemCreate => ({
  projectId: home.id,
  title: "Hoàn tiền một phần",
  idea: IDEA,
  modeRef: "speckit",
  size: "M",
  ...over,
});

const create = (who: string, over: Partial<SdlcItemCreate> = {}, d: SdlcDeps = deps) =>
  as(who, (tx) => createItem(tx, org.user(who), input(over), d));

async function project(key: string, sdlc: ProjectSdlcSettingsInput | null) {
  const settings = { ...defaultProjectSettings(), ...(sdlc ? { sdlc: projectSdlcSettings.parse(sdlc) } : {}) };
  const seeded = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key,
    settings,
  });
  return { id: seeded.projectId, key };
}

const repoOf = (key: string) => ({ owner: "xdev-team", name: `repo-${key}` });

beforeAll(async () => {
  org = await seedOrg(admin, `sdi-${tag}`);
  home = await project(`si${tag}`, {
    enabled: true,
    defaultMode: "speckit",
    modes: ["speckit", "bugfix", "small"],
    riskKeywords: ["hoàn tiền"],
  });
  off = await project(`so${tag}`, null);
});

beforeEach(async () => {
  await admin.query("delete from hive.sdlc_items where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.doc_drafts where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.docs where org_id = $1", [org.orgId]);
  enqueued = [];
  provider = createMemoryProvider("gitlab");
  provider.seedRepo(repoOf(home.key), { defaultBranch: "main", files: { "README.md": "# repo" } });
  deps = { jobs, providerFactory: () => provider, masterKey, publicUrl: "https://hive.test" };
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

async function auditOf(action: string, targetId: string) {
  const { rows } = await admin.query(
    "select data, actor_user_id from hive.audit_log where org_id = $1 and action = $2 and target_id = $3",
    [org.orgId, action, targetId],
  );
  return rows as { data: Record<string, unknown>; actor_user_id: string | null }[];
}

describe("tạo hạng mục", () => {
  it("cấp số kế tiếp, slug bỏ dấu, chụp chế độ, tạo tài liệu theo khuôn và giai đoạn đầu đang soạn", async () => {
    const suggestion = { size: "L" as const, modeRef: "speckit", reason: "Đụng thanh toán", alternatives: [] };
    const first = await create("tmember", { suggestion });
    const second = await create("tmember", { title: "Đổi địa chỉ giao hàng" });

    expect(first).toMatchObject({
      number: 1,
      ref: "001",
      slug: "hoan-tien-mot-phan",
      modeRef: "speckit",
      size: "M",
      sizeSuggested: "L",
      status: "active",
      source: { kind: "manual", issueNumber: null },
      phase: { id: "specify", kind: "requirements", status: "drafting", index: 0 },
      owner: { userId: org.user("tmember") },
      can: { write: true, manage: true, changeMode: true },
    });
    expect(second.number).toBe(2);
    expect(first.mode.id).toBe("speckit");
    expect(first.projectsDetail).toEqual([
      expect.objectContaining({ id: home.id, role: "home", enabled: true, teamId: org.teamId }),
    ]);
    expect(first.phases.map((p) => [p.id, p.status])).toEqual([
      ["specify", "drafting"],
      ["plan", "pending"],
      ["tasks", "pending"],
      ["implement", "pending"],
      ["converge", "pending"],
      ["release", "pending"],
    ]);

    // Contract chưa có bản nào lúc tạo; tài liệu tuỳ chọn vẫn có dòng nhưng không bắt buộc.
    const spec = first.artifacts.find((a) => a.artifactId === "spec");
    expect(spec).toMatchObject({
      scope: "item",
      required: true,
      docKey: `project/${home.key}/sdlc/001-hoan-tien-mot-phan/spec`,
      repoPath: "specs/001-hoan-tien-mot-phan/spec.md",
      projectId: home.id,
      baselineVersion: null,
      approval: "none",
      syncs: [expect.objectContaining({ projectId: home.id, kind: "source", state: "none" })],
    });
    expect(first.artifacts.map((a) => a.artifactId).sort()).toEqual([
      "data-model",
      "plan",
      "release-notes",
      "research",
      "retro",
      "spec",
      "tasks",
    ]);
    expect(first.artifacts.find((a) => a.artifactId === "research")?.required).toBe(false);

    // Bản nháp theo khuôn của preset dưới tên người tạo, chưa có phiên bản nào được duyệt.
    const { rows: drafts } = await admin.query(
      "select content, base_version, updated_by_user_id from hive.doc_drafts where org_id = $1 and key = $2",
      [org.orgId, spec?.docKey],
    );
    expect(drafts).toEqual([expect.objectContaining({ base_version: 0, updated_by_user_id: org.user("tmember") })]);
    expect(drafts[0].content.length).toBeGreaterThan(20);

    const [log] = await auditOf("sdlc.item.create", first.id);
    expect(log?.data).toMatchObject({ suggestion, chosen: { modeRef: "speckit", size: "M" }, number: 1 });
    expect(log?.actor_user_id).toBe(org.user("tmember"));
    // Giai đoạn đầu đi tiếp qua job sau commit.
    expect(enqueued).toContainEqual({ queue: "sdlc", data: { kind: "advance", orgId: org.orgId, itemId: first.id } });
  });

  it("từ chối: chế độ ngoài danh sách, dự án chưa bật, thiếu quyền, đường dẫn trùng hạng mục khác", async () => {
    expect(await errorCode(() => create("tmember", { modeRef: "aidlc-express" }))).toBe("SDLC_MODE_NOT_ALLOWED");
    expect(await errorCode(() => create("tmember", { projectId: off.id }))).toBe("SDLC_NOT_ENABLED");
    expect(await errorCode(() => create("tviewer"))).toBe("SDLC_FORBIDDEN");
    expect(await errorCode(() => create("oadmin"))).toBe("SDLC_FORBIDDEN");
    expect(await errorCode(() => create("loner"))).toBe("SDLC_FORBIDDEN");
    // Thiếu quyền ở dự án tham gia thì từ chối cả yêu cầu, không tạo hạng mục dở.
    expect(await errorCode(() => create("tmember", { participants: [off.id] }))).toBe("SDLC_NOT_ENABLED");
    const { rows } = await admin.query("select count(*)::int as n from hive.sdlc_items where org_id = $1", [org.orgId]);
    expect(rows[0].n).toBe(0);
  });

  it("đường dẫn đã có file trong repo (không thuộc hạng mục nào) thì từ chối và gợi ý nhận thư mục", async () => {
    provider.seedRepo(repoOf(home.key), {
      defaultBranch: "main",
      files: { "specs/001-hoan-tien-mot-phan/notes.md": "viết tay" },
    });
    const error = await as("tmember", (tx) => createItem(tx, org.user("tmember"), input(), deps)).catch((e) => e);
    expect(error).toMatchObject({ code: "SDLC_REPO_PATH_EXISTS" });
    expect(error.message).toContain("specs/001-hoan-tien-mot-phan");
    expect(error.message).toContain("Nhận thư mục có sẵn");

    // Tiêu đề khác thì thư mục khác, tạo được; thư mục `specs/` chung không tính là trùng.
    const ok = await create("tmember", { title: "Hoàn tiền toàn phần" });
    expect(ok.artifacts[0]?.repoPath).toMatch(/^specs\/001-hoan-tien-toan-phan\//);
  });
});

describe("từ issue", () => {
  const issue = (n: number, key = home.key) => `https://gitlab.com/xdev-team/repo-${key}/-/issues/${n}`;

  it("đọc số issue từ link GitHub, GitLab; link repo khác không nhận", () => {
    const repo = { repoOwner: "acme", repoName: "shop", repoWebUrl: "https://github.com/acme/shop" };
    expect(issueNumberOf("https://github.com/acme/shop/issues/12", repo)).toBe(12);
    expect(issueNumberOf("https://github.com/Acme/Shop/issues/12/", repo)).toBe(12);
    expect(issueNumberOf("https://github.com/acme/other/issues/12", repo)).toBeNull();
    expect(issueNumberOf("https://gitlab.com/acme/shop/-/issues/12", repo)).toBeNull();
    expect(
      issueNumberOf("https://gitlab.com/g/sub/repo/-/issues/3", {
        repoOwner: "g/sub",
        repoName: "repo",
        repoWebUrl: null,
      }),
    ).toBe(3);
    expect(issueNumberOf("không phải link", repo)).toBeNull();
  });

  it("gắn issue, bình luận link hạng mục sau commit; issue đã có hạng mục thì báo số hạng mục, không tạo trùng", async () => {
    const item = await create("tmember", { issueUrl: issue(7) });
    expect(item.source).toMatchObject({ kind: "issue", issueNumber: 7, url: issue(7) });
    const job = enqueued.find((j) => j.data.kind === "issue-comment");
    expect(job?.data).toEqual({ kind: "issue-comment", orgId: org.orgId, itemId: item.id });

    await handleSdlcJob(
      { pool: app, providerFactory: () => provider, masterKey, publicUrl: "https://hive.test/" },
      { kind: "issue-comment", orgId: org.orgId, itemId: item.id },
    );
    const comments = provider.repos.get(`xdev-team/repo-${home.key}`.toLowerCase())?.comments ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ number: 7, pullRequest: false });
    expect(comments[0]?.body).toContain(`https://hive.test/sdlc/${home.key}/001`);

    const dup = await as("tadmin", (tx) =>
      createItem(tx, org.user("tadmin"), input({ issueUrl: issue(7) }), deps),
    ).catch((e) => e);
    expect(dup).toMatchObject({ code: "SDLC_ISSUE_TAKEN", message: "Issue này đã có hạng mục 001." });
    expect(await errorCode(() => create("tmember", { issueUrl: issue(7, "khac") }))).toBe("SDLC_ISSUE_INVALID");
    // Issue khác vẫn tạo được.
    expect((await create("tmember", { issueUrl: issue(8) })).number).toBe(2);
  });
});

describe("tạm dừng, tiếp tục, huỷ, đổi chế độ", () => {
  it("chủ hạng mục hoặc quản trị đội; người khác bị từ chối; mỗi thao tác có audit", async () => {
    const item = await create("tmember");
    const viewerOther = await as("tviewer", (tx) => pauseItem(tx, org.user("tviewer"), item.id)).catch((e) => e);
    expect(viewerOther).toMatchObject({ code: "SDLC_MANAGE_FORBIDDEN" });

    const paused = await as("tmember", (tx) => pauseItem(tx, org.user("tmember"), item.id));
    expect(paused).toMatchObject({ status: "paused", waitingFor: "Đang tạm dừng" });
    expect(await errorCode(() => as("tmember", (tx) => pauseItem(tx, org.user("tmember"), item.id)))).toBe(
      "SDLC_ITEM_NOT_ACTIVE",
    );
    enqueued = [];
    const resumed = await as("tadmin", (tx) => resumeItem(tx, org.user("tadmin"), item.id, deps));
    expect(resumed.status).toBe("active");
    expect(enqueued.map((j) => j.data.kind)).toEqual(["advance"]);

    const cancelled = await as("tadmin", (tx) =>
      cancelItem(tx, org.user("tadmin"), { id: item.id, reason: "Khách đổi ý" }),
    );
    expect(cancelled).toMatchObject({ status: "cancelled", phase: null });
    expect(await errorCode(() => as("tadmin", (tx) => resumeItem(tx, org.user("tadmin"), item.id, deps)))).toBe(
      "SDLC_ITEM_NOT_PAUSED",
    );

    for (const action of ["sdlc.item.pause", "sdlc.item.resume", "sdlc.item.cancel"])
      expect(await auditOf(action, item.id)).toHaveLength(1);
    expect((await auditOf("sdlc.item.cancel", item.id))[0]?.data).toEqual({ reason: "Khách đổi ý" });
  });

  it("đổi chế độ dựng lại giai đoạn và tài liệu khi chưa có baseline; có baseline thì khoá", async () => {
    const item = await create("tmember");
    expect(
      await errorCode(() =>
        as("tmember", (tx) => changeItemMode(tx, org.user("tmember"), { id: item.id, modeRef: "aidlc-express" }, deps)),
      ),
    ).toBe("SDLC_MODE_NOT_ALLOWED");

    const changed = await as("tmember", (tx) =>
      changeItemMode(tx, org.user("tmember"), { id: item.id, modeRef: "bugfix" }, deps),
    );
    expect(changed).toMatchObject({ modeRef: "bugfix", number: 1, phase: { id: "fix", status: "drafting" } });
    expect(changed.artifacts.map((a) => a.repoPath)).toEqual(["fixes/001-hoan-tien-mot-phan/bugfix.md"]);
    expect(changed.phases.map((p) => p.id)).toEqual(["fix", "implement"]);
    expect((await auditOf("sdlc.item.change_mode", item.id))[0]?.data).toEqual({ from: "speckit", to: "bugfix" });

    const docKey = changed.artifacts[0]?.docKey ?? "";
    await as("tadmin", (tx) =>
      onBaseline(tx, { docKey, version: 1, proposalId: randomUUID(), reviewId: randomUUID() }, deps),
    );
    expect(
      await errorCode(() =>
        as("tmember", (tx) => changeItemMode(tx, org.user("tmember"), { id: item.id, modeRef: "speckit" }, deps)),
      ),
    ).toBe("SDLC_MODE_LOCKED");
  });
});

describe("danh sách, bảng, chi tiết", () => {
  it("chỉ đội của dự án thấy; lọc theo dự án, trạng thái, loại giai đoạn; phân trang", async () => {
    const a = await create("tmember");
    const b = await create("tadmin", { title: "Sửa lỗi tính thuế", modeRef: "bugfix", size: "S" });
    const c = await create("tmember", { title: "Đổi màu nút", modeRef: "small", size: "S" });
    await as("tmember", (tx) => pauseItem(tx, org.user("tmember"), c.id));

    const all = await as("tviewer", (tx) => listItems(tx, org.user("tviewer"), {}));
    expect(all.items.map((i) => i.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(all.nextCursor).toBeNull();
    expect((await as("oadmin", (tx) => listItems(tx, org.user("oadmin"), {}))).items).toEqual([]);
    expect((await as("loner", (tx) => listItems(tx, org.user("loner"), {}))).items).toEqual([]);

    const mine = await as("tmember", (tx) => listItems(tx, org.user("tmember"), { scope: "mine" }));
    expect(mine.items.map((i) => i.id).sort()).toEqual([a.id, c.id].sort());
    const paused = await as("tmember", (tx) => listItems(tx, org.user("tmember"), { status: "paused" }));
    expect(paused.items.map((i) => i.id)).toEqual([c.id]);
    const impl = await as("tmember", (tx) => listItems(tx, org.user("tmember"), { phaseKind: "implementation" }));
    expect(impl.items.map((i) => i.id)).toEqual([c.id]);
    expect((await as("tmember", (tx) => listItems(tx, org.user("tmember"), { projectId: off.id }))).items).toEqual([]);

    const page1 = await as("tmember", (tx) => listItems(tx, org.user("tmember"), { limit: 2 }));
    expect(page1.items).toHaveLength(2);
    const page2 = await as("tmember", (tx) =>
      listItems(tx, org.user("tmember"), { limit: 2, cursor: page1.nextCursor ?? undefined }),
    );
    expect(page2.nextCursor).toBeNull();
    expect([...page1.items, ...page2.items].map((i) => i.id).sort()).toEqual([a.id, b.id, c.id].sort());

    const board = await as("tviewer", (tx) => itemBoard(tx, org.user("tviewer"), {}));
    const col = (kind: string) => board.columns.find((x) => x.kind === kind)?.items.map((i) => i.id) ?? [];
    expect(col("requirements").sort()).toEqual([a.id, b.id].sort());
    expect(col("implementation")).toEqual([c.id]);
    expect(board.columns.map((x) => x.kind)).toContain("release");

    const byKey = await as("tviewer", (tx) =>
      getItem(tx, org.user("tviewer"), { projectKey: home.key, number: b.number }),
    );
    expect(byKey).toMatchObject({ id: b.id, can: { write: false, manage: false } });
    expect(await errorCode(() => as("oadmin", (tx) => getItem(tx, org.user("oadmin"), { id: a.id })))).toBe(
      "SDLC_ITEM_NOT_FOUND",
    );
  });

  it("gợi ý cỡ và chế độ trong số chế độ dự án cho dùng", async () => {
    const s = await as("tmember", (tx) =>
      suggestItem(tx, org.user("tmember"), { projectId: home.id, title: "Hoàn tiền", idea: IDEA }),
    );
    expect(["speckit", "bugfix", "small"]).toContain(s.modeRef);
    expect(s.reason).toContain("hoàn tiền");
    expect(
      await errorCode(() =>
        as("tmember", (tx) => suggestItem(tx, org.user("tmember"), { projectId: off.id, title: "Việc", idea: IDEA })),
      ),
    ).toBe("SDLC_NOT_ENABLED");
  });
});
