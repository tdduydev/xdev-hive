import { randomBytes } from "node:crypto";
import type { SkillRepo } from "@xdev-hive/contracts";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type pg from "pg";
import { findProject } from "../catalog/index.ts";
import { authUser } from "../identity/index.ts";
import {
  BadRequestError,
  decryptSecret,
  encryptSecret,
  type Jobs,
  type MasterKey,
  NotFoundError,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import {
  type GitProvider,
  isGitProviderError,
  loadConnection,
  type ProviderFactory,
  verifyGitHubSignature,
  verifyGitLabToken,
} from "../scm/index.ts";
import { teams } from "../tenancy/index.ts";
import { audit, type Principal, type Scope } from "./access.ts";
import { proposals, skillRepos, skills, skillVersions } from "./schema.ts";
import { applySkillSave } from "./skills.ts";

/** Một hàng đợi cho mọi việc với kho skill: đồng bộ, mở PR đề xuất, đóng PR đề xuất. */
export const SKILL_GIT_QUEUE = "knowledge-skill-git";
export const skillGitQueue = {
  name: SKILL_GIT_QUEUE,
  // Git bận hay hết hạn mức thì thử lại; đồng bộ chạy lại an toàn vì so sánh nội dung trước khi ghi.
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 10 * 60,
  policy: "stately",
} as const;

export type SkillGitJob =
  | { kind: "sync"; orgId: string }
  | { kind: "open-pr"; orgId: string; proposalId: string }
  | { kind: "close-pr"; orgId: string; proposalId: string };

export interface SkillRepoDeps {
  pool: pg.Pool;
  masterKey?: MasterKey | undefined;
  providerFactory: ProviderFactory;
  publicUrl?: string | undefined;
  jobs?: Jobs | undefined;
}

/** `org/<skill>/SKILL.md`, `teams/<slug>/<skill>/SKILL.md`, `projects/<key>/<skill>/SKILL.md`. */
const SKILL_PATH = /^(?:org|teams\/([^/]+)|projects\/([^/]+))\/([^/]+)\/SKILL\.md$/;
const secretContext = (id: string) => `skill_repos:${id}`;
const MAX_SKILLS = 500;

/** Đọc frontmatter `---` đầu file (name, description); phần còn lại là nội dung skill. Không cần thư viện YAML. */
export function parseSkillFile(text: string): { name: string | null; description: string; content: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  const fields: Record<string, string> = {};
  if (m?.[1]) {
    for (const line of m[1].split("\n")) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!kv?.[1]) continue;
      let v = (kv[2] ?? "").trim();
      if (/^".*"$/.test(v)) v = (JSON.parse(v) as string) ?? v;
      else if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
      fields[kv[1]] = v;
    }
  }
  return {
    name: fields.name || null,
    description: fields.description ?? "",
    content: (m ? normalized.slice(m[0].length) : normalized).trim(),
  };
}

/** Ngược của parseSkillFile; description để trong ngoặc kép để dấu hai chấm, # không làm hỏng YAML. */
export function renderSkillFile(name: string, description: string, content: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${content.trim()}\n`;
}

const same = (a: string, b: string) => a.replace(/\r\n/g, "\n").trim() === b.replace(/\r\n/g, "\n").trim();

async function repoRow(tx: Tx) {
  const [row] = await tx.select().from(skillRepos).limit(1);
  return row ?? null;
}

async function hubOnlyCount(tx: Tx): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(skills)
    .where(or(isNull(skills.repoPath), isNull(skills.repoVersion), ne(skills.repoVersion, skills.currentVersion)));
  return r?.n ?? 0;
}

function view(row: typeof skillRepos.$inferSelect, hubOnly: number): SkillRepo {
  return {
    id: row.id,
    connectionId: row.connectionId,
    owner: row.owner,
    name: row.name,
    branch: row.branch,
    status: row.status,
    lastSha: row.lastSha,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    error: row.error,
    webhookUrl: row.webhookUrl,
    hubOnly,
  };
}

export async function getSkillRepo(tx: Tx): Promise<SkillRepo | null> {
  const row = await repoRow(tx);
  return row ? view(row, await hubOnlyCount(tx)) : null;
}

/** Thư mục trong kho theo phạm vi skill; dự án hay đội không còn thì null (không đẩy được). */
async function folderOf(tx: Tx, scope: Scope): Promise<string | null> {
  if (scope.projectId) {
    const p = await findProject(tx, scope.projectId);
    return p ? `projects/${p.key}` : null;
  }
  if (scope.teamId) {
    const [t] = await tx.select({ slug: teams.slug }).from(teams).where(eq(teams.id, scope.teamId));
    return t ? `teams/${t.slug}` : null;
  }
  return "org";
}

async function providerFor(tx: Tx, deps: SkillRepoDeps, connectionId: string): Promise<GitProvider> {
  if (!deps.masterKey) throw new BadRequestError("NO_MASTER_KEY", "Hub chưa cấu hình HIVE_MASTER_KEY.");
  const conn = await loadConnection(tx, deps.masterKey, connectionId);
  if (!conn) throw new NotFoundError("SCM_CONNECTION_NOT_FOUND", "Không tìm thấy kết nối Git trong tổ chức.");
  return deps.providerFactory(conn);
}

export async function enqueueSkillGit(deps: Pick<SkillRepoDeps, "jobs">, job: SkillGitJob, tx?: Tx) {
  if (!deps.jobs) return null;
  return deps.jobs.enqueue(SKILL_GIT_QUEUE, job, {
    tx,
    ...(job.kind === "sync" ? { singletonKey: `sync:${job.orgId}` } : {}),
  });
}

/** Có kho skill thì xếp việc (đẩy skill vừa sửa, mở hoặc đóng PR đề xuất) trong cùng transaction với thay đổi. */
export async function afterSkillChange(tx: Tx, deps: Pick<SkillRepoDeps, "jobs">, job: SkillGitJob) {
  if (await repoRow(tx)) await enqueueSkillGit(deps, job, tx);
}

/**
 * Kết nối kho skill. Gọi Git ngoài transaction (kiểm repo và nhánh, gắn webhook) để không giữ kết nối database lúc
 * chờ mạng. Quyền đã kiểm ở router (quản trị tổ chức).
 */
export async function setSkillRepo(
  deps: SkillRepoDeps,
  ctx: { userId: string; orgId: string },
  input: { connectionId: string; owner: string; name: string; branch: string },
): Promise<SkillRepo> {
  const provider = await withTenant(deps.pool, ctx, (tx) => providerFor(tx, deps, input.connectionId));
  const ref = { owner: input.owner, name: input.name };
  if (!(await provider.getRepo(ref)))
    throw new NotFoundError("SKILL_REPO_NOT_FOUND", `Kết nối không thấy repo ${input.owner}/${input.name}.`);
  if (!(await provider.branchHead(ref, input.branch)))
    throw new NotFoundError("SKILL_REPO_BRANCH_NOT_FOUND", `Repo không có nhánh ${input.branch}.`);
  const secret = randomBytes(32).toString("hex");
  const row = await withTenant(deps.pool, ctx, async (tx) => {
    const old = await repoRow(tx);
    const id = old?.id ?? crypto.randomUUID();
    const values = {
      connectionId: input.connectionId,
      owner: input.owner,
      name: input.name,
      branch: input.branch,
      webhookSecretEnc: encryptSecret(deps.masterKey as MasterKey, secret, secretContext(id)),
      status: "idle" as const,
      lastSha: null,
      lastSyncedAt: null,
      error: null,
      configuredBy: ctx.userId,
      updatedAt: new Date(),
    };
    const [saved] = old
      ? await tx.update(skillRepos).set(values).where(eq(skillRepos.id, id)).returning()
      : await tx
          .insert(skillRepos)
          .values({ id, orgId: ctx.orgId, ...values })
          .returning();
    // Kho khác thì skill cũ không còn ứng với file nào: coi như chỉ có trên hub, lần đồng bộ đầu sẽ đẩy lên.
    if (old && (old.owner !== input.owner || old.name !== input.name || old.branch !== input.branch))
      await tx.update(skills).set({ repoPath: null, repoVersion: null });
    await audit(tx, { kind: "user", userId: ctx.userId }, "skill.repo_config", { type: "skill_repo", id }, input);
    return saved as typeof skillRepos.$inferSelect;
  });
  let webhookUrl: string | null = null;
  let webhookId: string | null = null;
  let warning: string | null = null;
  if (deps.publicUrl) {
    const url = `${deps.publicUrl.replace(/\/+$/, "")}/hooks/skills/${row.id}`;
    try {
      webhookId = (await provider.addWebhook(ref, { url, secret, events: ["push"] })).id;
      webhookUrl = url;
    } catch (e) {
      // Hub trong mạng nội bộ thì nhà cung cấp không gọi được webhook: vẫn dùng được nút Đồng bộ ngay.
      warning = `Không gắn được webhook (${e instanceof Error ? e.message : String(e)}); đồng bộ bằng nút Đồng bộ ngay.`;
    }
  }
  return withTenant(deps.pool, ctx, async (tx) => {
    const [saved] = await tx
      .update(skillRepos)
      .set({ webhookId, webhookUrl, error: warning })
      .where(eq(skillRepos.id, row.id))
      .returning();
    await enqueueSkillGit(deps, { kind: "sync", orgId: ctx.orgId }, tx);
    return view(saved as typeof skillRepos.$inferSelect, await hubOnlyCount(tx));
  });
}

export async function removeSkillRepo(deps: SkillRepoDeps, ctx: { userId: string; orgId: string }) {
  const removed = await withTenant(deps.pool, ctx, async (tx) => {
    const row = await repoRow(tx);
    if (!row) return null;
    const provider = await providerFor(tx, deps, row.connectionId).catch(() => null);
    await tx.delete(skillRepos).where(eq(skillRepos.id, row.id));
    await tx.update(skills).set({ repoPath: null, repoVersion: null });
    await audit(tx, { kind: "user", userId: ctx.userId }, "skill.repo_remove", { type: "skill_repo", id: row.id });
    return { row, provider };
  });
  if (removed?.row.webhookId && removed.provider)
    await removed.provider
      .removeWebhook({ owner: removed.row.owner, name: removed.row.name }, removed.row.webhookId)
      .catch(() => {});
  return { ok: true as const };
}

export async function requestSkillSync(tx: Tx, deps: Pick<SkillRepoDeps, "jobs">, orgId: string) {
  const row = await repoRow(tx);
  if (!row) throw new NotFoundError("SKILL_REPO_NOT_CONFIGURED", "Tổ chức chưa kết nối kho skill.");
  await tx.update(skillRepos).set({ status: "syncing" }).where(eq(skillRepos.id, row.id));
  return { queued: (await enqueueSkillGit(deps, { kind: "sync", orgId }, tx)) !== null };
}

interface RepoFile {
  path: string;
  folderRef: { team?: string; project?: string };
  name: string;
  description: string;
  content: string;
}

/**
 * Đồng bộ hai chiều (SKILL-01, SKILL-03, SKILL-04): kéo SKILL.md từ Git vào hub (Git là bản gốc), xoá skill đã xoá trong
 * Git, rồi đẩy skill chỉ có trên hub hoặc sửa trên hub sau lần đồng bộ trước trong một commit.
 */
export async function syncSkillRepo(deps: SkillRepoDeps, orgId: string): Promise<void> {
  const ctx = { orgId };
  const loaded = await withTenant(deps.pool, ctx, async (tx) => {
    const row = await repoRow(tx);
    if (!row) return null;
    return { row, provider: await providerFor(tx, deps, row.connectionId) };
  });
  if (!loaded) return;
  const { row, provider } = loaded;
  const ref = { owner: row.owner, name: row.name };
  const author: Principal = { kind: "user", userId: row.configuredBy };
  try {
    const head = await provider.branchHead(ref, row.branch);
    if (!head) throw new Error(`Repo không còn nhánh ${row.branch}.`);
    const warnings: string[] = [];
    let pulled = { added: 0, updated: 0, removed: 0 };
    if (head !== row.lastSha) {
      const paths = (await provider.listFiles(ref, head)).filter((p) => SKILL_PATH.test(p));
      if (paths.length > MAX_SKILLS) throw new Error(`Kho có ${paths.length} skill, quá giới hạn ${MAX_SKILLS}.`);
      const files: RepoFile[] = [];
      for (const path of paths) {
        const m = SKILL_PATH.exec(path) as RegExpExecArray;
        const text = await provider.readFile(ref, path, head);
        if (text === null) continue;
        const parsed = parseSkillFile(text);
        const folderName = m[3] as string;
        if (parsed.name && parsed.name !== folderName)
          warnings.push(`${path}: name "${parsed.name}" khác tên thư mục, dùng tên thư mục.`);
        files.push({
          path,
          folderRef: m[1] ? { team: m[1] } : m[2] ? { project: m[2] } : {},
          name: folderName,
          description: parsed.description,
          content: parsed.content,
        });
      }
      pulled = await withTenant(deps.pool, ctx, (tx) => applyPull(tx, author, files, head, warnings));
    }
    const pushed = await pushHubChanges(deps, ctx, provider, row, head);
    await withTenant(deps.pool, ctx, async (tx) => {
      await tx
        .update(skillRepos)
        .set({
          status: "ok",
          lastSha: pushed.sha ?? head,
          lastSyncedAt: new Date(),
          error: warnings.length ? warnings.slice(0, 10).join("\n") : null,
          updatedAt: new Date(),
        })
        .where(eq(skillRepos.id, row.id));
      await audit(
        tx,
        author,
        "skill.sync",
        { type: "skill_repo", id: row.id },
        { ...pulled, pushed: pushed.count, sha: pushed.sha ?? head },
      );
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await withTenant(deps.pool, ctx, (tx) =>
      tx
        .update(skillRepos)
        .set({ status: "failed", error: message, updatedAt: new Date() })
        .where(eq(skillRepos.id, row.id)),
    );
    // Hết hạn mức hay Git bận thì để pg-boss thử lại; lỗi cấu hình (không quyền, không thấy repo) thì dừng.
    if (isGitProviderError(e, "rate_limited") || isGitProviderError(e, "unavailable")) throw e;
  }
}

async function scopeFor(tx: Tx, ref: RepoFile["folderRef"]): Promise<Scope | null> {
  if (ref.project) {
    const p = await findProject(tx, ref.project);
    return p ? { teamId: p.teamId, projectId: p.id } : null;
  }
  if (ref.team) {
    const [t] = await tx.select({ id: teams.id }).from(teams).where(eq(teams.slug, ref.team));
    return t ? { teamId: t.id, projectId: null } : null;
  }
  return { teamId: null, projectId: null };
}

const sameScopeWhere = (scope: Scope) =>
  and(
    sql`${skills.teamId} is not distinct from ${scope.teamId}::uuid`,
    sql`${skills.projectId} is not distinct from ${scope.projectId}::uuid`,
  );

async function applyPull(tx: Tx, author: Principal, files: RepoFile[], head: string, warnings: string[]) {
  const counts = { added: 0, updated: 0, removed: 0 };
  const seen = new Set<string>();
  for (const f of files) {
    const scope = await scopeFor(tx, f.folderRef);
    if (!scope) {
      warnings.push(
        `${f.path}: không có ${f.folderRef.team ? `đội ${f.folderRef.team}` : `dự án ${f.folderRef.project}`} trong tổ chức, bỏ qua.`,
      );
      continue;
    }
    seen.add(f.path);
    const [current] = await tx
      .select()
      .from(skills)
      .where(and(sameScopeWhere(scope), eq(skills.name, f.name)));
    if (current) {
      const [latest] = await tx
        .select({ content: skillVersions.content })
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, current.id), eq(skillVersions.version, current.currentVersion)));
      const unchanged = latest && same(latest.content, f.content) && same(current.description, f.description);
      if (!unchanged) {
        // Sửa cả trên hub lẫn Git: Git là bản gốc (ADR 0014), bản sửa trên hub còn trong lịch sử phiên bản.
        if (current.repoVersion !== null && current.repoVersion !== current.currentVersion)
          warnings.push(`${f.path}: sửa cả trên hub và Git, giữ bản Git (bản hub còn trong lịch sử).`);
        await applySkillSave(tx, author, scope, {
          name: f.name,
          description: f.description,
          content: f.content,
          baseVersion: current.currentVersion,
          message: `Đồng bộ từ Git ${head.slice(0, 7)}`,
        });
        counts.updated++;
      }
      await tx
        .update(skills)
        .set({ repoPath: f.path, repoVersion: sql`${skills.currentVersion}` })
        .where(eq(skills.id, current.id));
    } else {
      const saved = await applySkillSave(tx, author, scope, {
        name: f.name,
        description: f.description,
        content: f.content,
        baseVersion: 0,
        message: `Đồng bộ từ Git ${head.slice(0, 7)}`,
      });
      await tx.update(skills).set({ repoPath: f.path, repoVersion: saved.version }).where(eq(skills.id, saved.id));
      counts.added++;
    }
  }
  // Skill đã từng ở trong Git mà file không còn: xoá trên hub. Skill chỉ có trên hub (repo_path null) giữ nguyên.
  const gone = (await tx.select({ id: skills.id, repoPath: skills.repoPath }).from(skills)).filter(
    (s) => s.repoPath !== null && !seen.has(s.repoPath) && SKILL_PATH.test(s.repoPath),
  );
  for (const s of gone) {
    await tx.delete(skills).where(eq(skills.id, s.id));
    counts.removed++;
  }
  return counts;
}

async function pushHubChanges(
  deps: SkillRepoDeps,
  ctx: { orgId: string },
  provider: GitProvider,
  row: typeof skillRepos.$inferSelect,
  head: string,
): Promise<{ sha: string | null; count: number }> {
  let coAuthors: string[] = [];
  const pending = await withTenant(deps.pool, ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(skills)
      .where(or(isNull(skills.repoPath), isNull(skills.repoVersion), ne(skills.repoVersion, skills.currentVersion)));
    const out: { id: string; version: number; path: string; text: string }[] = [];
    // Commit đi bằng token của kết nối; ghi người sửa thành Co-authored-by để Git hiện đúng ai sửa (SKILL-04).
    const editors = new Set(rows.map((r) => r.updatedByUserId).filter((u): u is string => !!u));
    const people = editors.size
      ? await tx
          .select({ name: authUser.name, email: authUser.email })
          .from(authUser)
          .where(inArray(authUser.id, [...editors]))
      : [];
    coAuthors = people.map((u) => `Co-authored-by: ${u.name || u.email} <${u.email}>`);
    for (const s of rows) {
      const folder = await folderOf(tx, { teamId: s.teamId, projectId: s.projectId });
      if (!folder) continue;
      const [v] = await tx
        .select({ content: skillVersions.content })
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, s.id), eq(skillVersions.version, s.currentVersion)));
      out.push({
        id: s.id,
        version: s.currentVersion,
        path: s.repoPath ?? `${folder}/${s.name}/SKILL.md`,
        text: renderSkillFile(s.name, s.description, v?.content ?? ""),
      });
    }
    return out;
  });
  if (!pending.length) return { sha: null, count: 0 };
  const names = pending.map((p) => p.path.split("/").at(-2)).join(", ");
  const { sha } = await provider.commitFiles(
    { owner: row.owner, name: row.name },
    {
      branch: row.branch,
      message: [`skills: cập nhật từ xDev Hive (${names})`, ...(coAuthors.length ? ["", ...coAuthors] : [])].join("\n"),
      files: pending.map((p) => ({ path: p.path, content: p.text })),
    },
  );
  await withTenant(deps.pool, ctx, async (tx) => {
    for (const p of pending)
      await tx.update(skills).set({ repoPath: p.path, repoVersion: p.version }).where(eq(skills.id, p.id));
  });
  void head;
  return { sha, count: pending.length };
}

/** Đề xuất skill thành PR trong kho (SKILL-04): nhánh riêng tạo từ nhánh chính, một commit với nội dung đề xuất. */
export async function openProposalPR(deps: SkillRepoDeps, orgId: string, proposalId: string): Promise<void> {
  const ctx = { orgId };
  const loaded = await withTenant(deps.pool, ctx, async (tx) => {
    const row = await repoRow(tx);
    const [p] = await tx.select().from(proposals).where(eq(proposals.id, proposalId));
    if (!row || !p || p.kind !== "skill" || p.status !== "pending" || p.gitPrNumber !== null) return null;
    const folder = await folderOf(tx, { teamId: p.teamId, projectId: p.projectId });
    if (!folder) return null;
    return { row, p, folder, provider: await providerFor(tx, deps, row.connectionId) };
  });
  if (!loaded) return;
  const { row, p, folder, provider } = loaded;
  const ref = { owner: row.owner, name: row.name };
  const branch = `hive/skill-proposal-${p.id.slice(0, 8)}`;
  await provider.commitFiles(ref, {
    branch,
    fromBranch: row.branch,
    message: `Đề xuất sửa skill ${p.target}`,
    files: [
      { path: `${folder}/${p.target}/SKILL.md`, content: renderSkillFile(p.target, p.description ?? "", p.content) },
    ],
  });
  const pr = await provider.openPR(ref, {
    head: branch,
    base: row.branch,
    title: p.title ?? `Đề xuất sửa skill ${p.target}`,
    body: `${p.reason ?? ""}\n\nĐề xuất từ xDev Hive (${p.id}). Duyệt hoặc từ chối trên hub; hub đóng PR này sau khi quyết định.`.trim(),
  });
  await withTenant(deps.pool, ctx, (tx) =>
    tx.update(proposals).set({ gitPrNumber: pr.number, gitPrUrl: pr.url }).where(eq(proposals.id, p.id)),
  );
}

/** Đề xuất đã quyết trên hub: đóng PR. Bản duyệt vào nhánh chính qua lần đồng bộ (đẩy skill đã sửa). */
export async function closeProposalPR(deps: SkillRepoDeps, orgId: string, proposalId: string): Promise<void> {
  const loaded = await withTenant(deps.pool, { orgId }, async (tx) => {
    const row = await repoRow(tx);
    const [p] = await tx.select().from(proposals).where(eq(proposals.id, proposalId));
    if (!row || !p?.gitPrNumber) return null;
    return {
      row,
      number: p.gitPrNumber,
      approved: p.status === "approved",
      provider: await providerFor(tx, deps, row.connectionId),
    };
  });
  if (!loaded) return;
  const ref = { owner: loaded.row.owner, name: loaded.row.name };
  await loaded.provider
    .commentOnIssue(
      ref,
      loaded.number,
      loaded.approved
        ? "Đã duyệt trên xDev Hive; nội dung vào nhánh chính qua lần đồng bộ skill."
        : "Đã từ chối trên xDev Hive.",
      { pullRequest: true },
    )
    .catch(() => {});
  await loaded.provider.closePR(ref, loaded.number);
}

export async function registerSkillGitWorker(jobs: Jobs, deps: SkillRepoDeps): Promise<void> {
  await jobs.work<SkillGitJob>(SKILL_GIT_QUEUE, async ({ data }) => {
    if (data.kind === "sync") return syncSkillRepo(deps, data.orgId);
    if (data.kind === "open-pr") return openProposalPR(deps, data.orgId, data.proposalId);
    return closeProposalPR(deps, data.orgId, data.proposalId);
  });
}

/**
 * POST /hooks/skills/{repoId}: kiểm chữ ký trước khi tin bất cứ gì (GitHub X-Hub-Signature-256, GitLab
 * X-Gitlab-Token), push vào nhánh của kho thì xếp một lần đồng bộ.
 */
export async function handleSkillWebhook(deps: SkillRepoDeps, repoId: string, request: Request): Promise<Response> {
  if (!deps.masterKey || !/^[0-9a-f-]{36}$/i.test(repoId)) return new Response("Not Found", { status: 404 });
  const row = await withTenant(deps.pool, {}, async (tx) => {
    await tx.execute(sql`select set_config('app.webhook_skill_repo_id', ${repoId}, true)`);
    const [r] = await tx.select().from(skillRepos).where(eq(skillRepos.id, repoId));
    return r ?? null;
  });
  if (!row) return new Response("Not Found", { status: 404 });
  const body = new Uint8Array(await request.arrayBuffer());
  const secret = decryptSecret(deps.masterKey, row.webhookSecretEnc, secretContext(row.id));
  const gh = request.headers.get("x-hub-signature-256");
  const ok = gh
    ? verifyGitHubSignature(secret, body, gh)
    : verifyGitLabToken(secret, request.headers.get("x-gitlab-token"));
  if (!ok) return new Response("Chữ ký webhook không hợp lệ.", { status: 401 });
  const event = request.headers.get("x-github-event") ?? request.headers.get("x-gitlab-event") ?? "";
  if (event === "ping") return new Response(null, { status: 204 });
  if (event !== "push" && event !== "Push Hook") return new Response(null, { status: 202 });
  const payload = JSON.parse(new TextDecoder().decode(body)) as { ref?: string };
  if (payload.ref !== `refs/heads/${row.branch}`) return new Response(null, { status: 202 });
  await withTenant(deps.pool, { orgId: row.orgId }, (tx) =>
    enqueueSkillGit(deps, { kind: "sync", orgId: row.orgId }, tx),
  );
  return new Response(null, { status: 202 });
}
