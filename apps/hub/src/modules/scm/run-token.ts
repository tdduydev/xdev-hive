import type { RunGitCredential } from "@xdev-hive/contracts/worker-protocol";
import { and, asc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
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
  /** Mặc định `RUN_GIT_TOKEN_ISSUE_TIMEOUT_MS`; test đặt ngắn hơn. */
  issueTimeoutMs?: number;
  logger?: Pick<Console, "warn">;
}

/** Máy đang chờ lease: GitHub/GitLab treo thì thôi chờ, người gọi xử như cấp lỗi (theo `git.requireRunGitToken`). */
export const RUN_GIT_TOKEN_ISSUE_TIMEOUT_MS = 15_000;

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
  const grant = await within(
    provider.issueRunToken(target.repo, `hive-run-${target.runId}-${target.attempt}`),
    deps.issueTimeoutMs ?? RUN_GIT_TOKEN_ISSUE_TIMEOUT_MS,
    // Token về sau hạn chờ thì không ai dùng, và chưa có dòng để job quét thấy: thu hồi ngay.
    (late) => {
      if (late.externalId) provider.revokeRunToken?.(target.repo, late.externalId).catch(() => undefined);
    },
  );
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

function within<T>(work: Promise<T>, ms: number, onLate: (value: T) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let late = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      late = true;
      reject(new Error(`GitHub/GitLab không cấp token git trong ${ms / 1000} giây`));
    }, ms);
  });
  work.then(
    (value) => late && onLate(value),
    () => undefined,
  );
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
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
    try {
      if (!providers.has(t.connectionId)) {
        const conn = await tenant((tx) => loadConnection(tx, deps.masterKey, t.connectionId));
        providers.set(t.connectionId, conn ? deps.providerFactory(conn) : null);
      }
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
    } catch (e) {
      // Lỗi mạng hay hết hạn mức ở một token không chặn các token sau; dòng còn mở, lượt quét sau thử lại.
      (deps.logger ?? console).warn(`Không thu hồi được token git ${t.id} của run ${t.runId}`, e);
    }
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
  /** Số dòng mỗi trang, mặc định 200; test đặt nhỏ để đi qua nhiều trang. */
  pageSize?: number;
}

const SWEEP_PAGE = 200;

/**
 * Thu hồi token GitLab của run đã rời máy mà chưa thu hồi được lúc kết thúc (hub tắt giữa chừng, GitLab lỗi).
 * `hive.run_git_token_orgs` (SECURITY DEFINER) chỉ trả id tổ chức; phần còn lại chạy trong tổ chức đó.
 */
export async function sweepRunGitTokens(deps: RunGitTokenSweepDeps): Promise<number> {
  const orgs = await withTenant(deps.pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ org_id: string }>(sql`select org_id from hive.run_git_token_orgs()`);
    return rows.map((r) => r.org_id);
  });
  const pageSize = deps.pageSize ?? SWEEP_PAGE;
  let revoked = 0;
  for (const orgId of orgs) {
    try {
      // Đi hết theo trang: chỉ lấy 200 dòng đầu thì khi 200 dòng đó đều của run còn chạy, token phía sau không bao giờ
      // được thu hồi.
      for (let after: string | null = null; ; ) {
        const cursor: string | null = after;
        const page: { last: string | null; full: boolean; due: OpenToken[] } = await withTenant(
          deps.pool,
          { orgId },
          async (tx) => {
            const rows = await tx
              .select({ ...openColumns, externalId: sql<string>`${runGitTokens.externalId}` })
              .from(runGitTokens)
              .where(cursor ? and(open, gt(runGitTokens.id, cursor)) : open)
              .orderBy(asc(runGitTokens.id))
              .limit(pageSize);
            const due: OpenToken[] = [];
            for (const row of rows) if (!(await deps.isLive(tx, row.runId, row.attempt))) due.push(row);
            return { last: rows.at(-1)?.id ?? null, full: rows.length === pageSize, due };
          },
        );
        revoked += await revokeTokens(deps, orgId, page.due);
        if (!page.full || !page.last) break;
        after = page.last;
      }
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
