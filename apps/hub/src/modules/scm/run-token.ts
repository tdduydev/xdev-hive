import type { RunGitCredential } from "@xdev-hive/contracts/worker-protocol";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { type Jobs, type MasterKey, type Tx, withTenant } from "../platform/index.ts";
import { loadConnection, type ProviderFactory } from "./connections.ts";
import { runGitTokens } from "./schema.ts";
import type { GitProvider, RepoRef } from "./types.ts";

/** Token git theo run (specs/027 R9). Hub cấp lúc giao lease, máy chỉ đưa token cho git, không cho CLI agent. */
export interface RunGitTokenDeps {
  pool: pg.Pool;
  masterKey: MasterKey;
  providerFactory: ProviderFactory;
}

export interface RunGitTokenTarget {
  orgId: string;
  runId: string;
  attempt: number;
  connectionId: string;
  repo: RepoRef;
}

const repoName = (ref: RepoRef) => `${ref.owner}/${ref.name}`;

// GitLab cho owner lồng nhiều cấp (`a/b/c`), tên repo là đoạn cuối.
function repoRef(repo: string): RepoRef {
  const i = repo.lastIndexOf("/");
  return { owner: repo.slice(0, i), name: repo.slice(i + 1) };
}

/** Kết nối của dự án cấp được token theo run không. Không gọi mạng; dùng lúc giao run để chặn sớm theo chính sách. */
export async function canIssueRunGitToken(
  tx: Tx,
  deps: Pick<RunGitTokenDeps, "masterKey" | "providerFactory">,
  connectionId: string,
): Promise<boolean> {
  const conn = await loadConnection(tx, deps.masterKey, connectionId);
  return Boolean(conn && deps.providerFactory(conn).issueRunToken);
}

/**
 * Cấp token git cho một lần thử của run. Null khi kết nối không cấp được (PAT, provider local): máy dùng thông tin git
 * sẵn có. Lỗi gọi GitHub/GitLab ném ra để người gọi quyết theo chính sách `git.requireRunGitToken`.
 */
export async function issueRunGitToken(
  deps: RunGitTokenDeps,
  target: RunGitTokenTarget,
): Promise<RunGitCredential | null> {
  const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(deps.pool, { orgId: target.orgId }, fn);
  const conn = await tenant((tx) => loadConnection(tx, deps.masterKey, target.connectionId));
  if (!conn) return null;
  const provider = deps.providerFactory(conn);
  if (!provider.issueRunToken) return null;
  // Gọi GitHub/GitLab ngoài transaction để không giữ kết nối database trong lúc chờ mạng.
  const grant = await provider.issueRunToken(target.repo, `hive-run-${target.runId}-${target.attempt}`);
  const repo = repoName(target.repo);
  try {
    await tenant(async (tx) => {
      await tx.insert(runGitTokens).values({
        orgId: sql`hive.ctx_org()`,
        runId: target.runId,
        attempt: target.attempt,
        connectionId: conn.id,
        provider: conn.kind,
        externalId: grant.externalId,
        repo,
        expiresAt: grant.expiresAt,
      });
      await recordAudit(tx, {
        action: "scm.run_token_issue",
        actorUserId: null,
        targetType: "run",
        targetId: target.runId,
        data: { attempt: target.attempt, provider: conn.kind, repo, expiresAt: grant.expiresAt.toISOString() },
      });
    });
  } catch (e) {
    // Không có dòng thì job quét không biết token này để thu hồi: thu hồi ngay rồi báo lỗi.
    if (grant.externalId) await provider.revokeRunToken?.(target.repo, grant.externalId).catch(() => undefined);
    throw e;
  }
  return {
    host: grant.host,
    username: grant.username,
    token: grant.token,
    expiresAt: grant.expiresAt.toISOString(),
    repo,
  };
}

type OpenToken = Pick<typeof runGitTokens.$inferSelect, "id" | "runId" | "attempt" | "connectionId" | "repo"> & {
  externalId: string;
};

const openColumns = {
  id: runGitTokens.id,
  runId: runGitTokens.runId,
  attempt: runGitTokens.attempt,
  connectionId: runGitTokens.connectionId,
  repo: runGitTokens.repo,
};

/** Chỉ token có id phía nhà cung cấp (GitLab) mới cần thu hồi; token cài đặt GitHub tự hết hạn sau 1 giờ. */
const open = and(isNull(runGitTokens.revokedAt), isNotNull(runGitTokens.externalId));

async function revokeTokens(deps: RunGitTokenDeps, orgId: string, tokens: OpenToken[]): Promise<number> {
  const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(deps.pool, { orgId }, fn);
  const providers = new Map<string, GitProvider | null>();
  let revoked = 0;
  for (const t of tokens) {
    if (!providers.has(t.connectionId)) {
      const conn = await tenant((tx) => loadConnection(tx, deps.masterKey, t.connectionId));
      providers.set(t.connectionId, conn ? deps.providerFactory(conn) : null);
    }
    // Lỗi mạng hay hết hạn mức thì để dòng mở, lượt quét sau thử lại.
    await providers.get(t.connectionId)?.revokeRunToken?.(repoRef(t.repo), t.externalId);
    await tenant(async (tx) => {
      await tx.update(runGitTokens).set({ revokedAt: sql`now()` }).where(eq(runGitTokens.id, t.id));
      await recordAudit(tx, {
        action: "scm.run_token_revoke",
        actorUserId: null,
        targetType: "run",
        targetId: t.runId,
        data: { attempt: t.attempt, repo: t.repo },
      });
    });
    revoked += 1;
  }
  return revoked;
}

/** Thu hồi token GitLab còn mở của run. Gọi khi run xong trên máy; lỗi thì job quét thử lại sau. */
export async function revokeRunGitTokens(deps: RunGitTokenDeps, orgId: string, runId: string): Promise<number> {
  const tokens = await withTenant(deps.pool, { orgId }, (tx) =>
    tx
      .select({ ...openColumns, externalId: sql<string>`${runGitTokens.externalId}` })
      .from(runGitTokens)
      .where(and(eq(runGitTokens.runId, runId), open)),
  );
  return revokeTokens(deps, orgId, tokens);
}

export const RUN_GIT_TOKEN_QUEUE = "scm-run-git-tokens";
export const RUN_GIT_TOKEN_CRON = "*/10 * * * *";
export const runGitTokenQueue = {
  name: RUN_GIT_TOKEN_QUEUE,
  // Lịch 10 phút sau chạy lại được, không cần thử lại từng lượt.
  retryLimit: 0,
  expireInSeconds: 5 * 60,
} as const;

export interface RunGitTokenSweepDeps extends RunGitTokenDeps {
  /** Lần thử này của run còn trên máy thì giữ token. Module runs cài vào: scm không đọc bảng runs. */
  isLive: (tx: Tx, runId: string, attempt: number) => Promise<boolean>;
  logger?: Pick<Console, "warn">;
}

/**
 * Thu hồi token GitLab của run đã rời máy mà chưa thu hồi được lúc kết thúc (hub tắt giữa chừng, GitLab lỗi).
 * `hive.run_git_token_orgs` (SECURITY DEFINER) chỉ trả id tổ chức; phần còn lại chạy trong tổ chức đó.
 */
export async function sweepRunGitTokens(deps: RunGitTokenSweepDeps): Promise<number> {
  const orgs = await withTenant(deps.pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ org_id: string }>(sql`select org_id from hive.run_git_token_orgs()`);
    return rows.map((r) => r.org_id);
  });
  let revoked = 0;
  for (const orgId of orgs) {
    const due = await withTenant(deps.pool, { orgId }, async (tx) => {
      const rows = await tx
        .select({ ...openColumns, externalId: sql<string>`${runGitTokens.externalId}` })
        .from(runGitTokens)
        .where(open)
        .limit(200);
      const out: OpenToken[] = [];
      for (const row of rows) if (!(await deps.isLive(tx, row.runId, row.attempt))) out.push(row);
      return out;
    });
    try {
      revoked += await revokeTokens(deps, orgId, due);
    } catch (e) {
      // Một tổ chức lỗi (GitLab sập, kết nối bị xoá quyền) không chặn tổ chức khác.
      (deps.logger ?? console).warn(`Không thu hồi được token git theo run của tổ chức ${orgId}`, e);
    }
  }
  return revoked;
}

export async function registerRunGitTokenSweep(jobs: Jobs, deps: RunGitTokenSweepDeps): Promise<void> {
  await jobs.work(RUN_GIT_TOKEN_QUEUE, async () => void (await sweepRunGitTokens(deps)));
  await jobs.schedule(RUN_GIT_TOKEN_QUEUE, RUN_GIT_TOKEN_CRON);
}
