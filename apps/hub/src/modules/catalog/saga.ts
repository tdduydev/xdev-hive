import { and, eq, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { notify } from "../notify/index.ts";
import { decryptSecret, type Jobs, type MasterKey, type Tx, withTenant } from "../platform/index.ts";
import {
  type GitProvider,
  isGitProviderError,
  loadConnection,
  type ProviderFactory,
  type RepoInfo,
  type ScmAuthMode,
  type WebhookEvent,
} from "../scm/index.ts";
import { findSystem } from "../tenancy/index.ts";
import {
  loadProject,
  loadSteps,
  PROVISION_QUEUE,
  type ProjectRow,
  type ProvisionJob,
  repoMarker,
  webhookSecretContext,
  webhookUrl,
} from "./projects.ts";
import { projectProvisionSteps, projects } from "./schema.ts";
import { describeFailure, StepFailure, TEMPLATE_BRANCH } from "./steps.ts";
import { renderTemplate } from "./template.ts";

/** Issue và bình luận để giao việc từ issue; push và PR để chuyển trạng thái task, run. */
const WEBHOOK_EVENTS = ["push", "pull_request", "issues", "issue_comment"] as const satisfies WebhookEvent[];

export interface ProvisionDeps {
  /** Pool của hive_app. Job chạy với tenant là tổ chức trong payload, không có người dùng. */
  pool: pg.Pool;
  masterKey: MasterKey;
  providerFactory: ProviderFactory;
  publicUrl: string;
  /** Gửi thông báo cho nhóm quản trị khi saga dừng ở bước lỗi; không có thì thông báo nằm chờ deliverPending. */
  jobs?: Jobs | undefined;
}

/** pg-boss thử lại lỗi tạm thời (hết hạn mức, nhà cung cấp không phản hồi) chừng này lần trước khi dừng ở bước lỗi. */
export const PROVISION_RETRY_LIMIT = 3;

export const provisionQueue = {
  name: PROVISION_QUEUE,
  // Mỗi dự án tối đa một job chờ và một job đang chạy (singletonKey = projectId): bấm "Thử lại" nhiều lần không
  // làm hai saga cùng chạy trên một dự án.
  policy: "stately",
  retryLimit: PROVISION_RETRY_LIMIT,
  retryDelay: 15,
  retryBackoff: true,
  expireInSeconds: 15 * 60,
} as const;

export type ProvisionOutcome = "active" | "failed" | "skipped";

/** Lỗi tạm thời: báo pg-boss thử lại job, bước giữ nguyên pending. */
export class RetryLater extends Error {
  override readonly name = "RetryLater";
}

type StepRow = Awaited<ReturnType<typeof loadSteps>>[number];
type RepoPatch = Partial<
  Pick<ProjectRow, "defaultBranch" | "repoExternalId" | "repoHttpUrl" | "repoSshUrl" | "repoWebUrl" | "repoVisibility">
>;

interface StepOutput {
  result: Record<string, unknown>;
  repo?: RepoPatch;
}

const repoPatch = (r: RepoInfo): RepoPatch => ({
  defaultBranch: r.defaultBranch,
  repoExternalId: r.id,
  repoHttpUrl: r.httpUrl,
  repoSshUrl: r.sshUrl,
  repoWebUrl: r.webUrl,
  repoVisibility: r.visibility,
});

interface StepContext {
  project: ProjectRow;
  provider: GitProvider;
  authMode: ScmAuthMode;
  systemName: string;
  deps: ProvisionDeps;
}

function needBranch(project: ProjectRow): string {
  if (!project.defaultBranch) {
    throw new StepFailure("NO_DEFAULT_BRANCH", "Chưa biết nhánh chính của repo.", "Chạy lại bước đọc repo trước.");
  }
  return project.defaultBranch;
}

/** Mỗi bước idempotent: chạy lại sau khi chết giữa chừng cho cùng kết quả, không tạo trùng trên nhà cung cấp. */
async function execute(step: StepRow, c: StepContext): Promise<StepOutput> {
  const { project, provider, authMode } = c;
  const ref = { owner: project.repoOwner, name: project.repoName };
  switch (step.kind) {
    case "check-access": {
      const access = await provider.checkAccess(ref.owner);
      if (!access.canCreate) {
        const missing = access.missingScopes.length ? `: thiếu ${access.missingScopes.join(", ")}` : "";
        throw new StepFailure(
          "ACCESS_DENIED",
          `Kết nối Git chưa tạo được repo trong ${ref.owner}${missing}.`,
          project.scmKind === "github" && authMode === "token"
            ? `Token GitHub phải tạo được repo trong ${ref.owner}: owner là chính chủ token hoặc org mà chủ token được tạo repo; fine-grained token cần Administration, Contents, Pull requests, Webhooks (ghi), PAT cổ điển cần scope repo. Sửa xong, bấm “Thử lại bước này”.`
            : project.scmKind === "github"
              ? `Cài GitHub App của Hive vào tổ chức ${ref.owner} (không phải tài khoản cá nhân) và cấp quyền Administration, Contents, Pull requests, Webhooks (ghi). Sửa xong, bấm “Thử lại bước này”.`
              : `Token GitLab cần scope api và vai trò Maintainer trở lên trong group ${ref.owner}. Sửa xong, bấm “Thử lại bước này”.`,
        );
      }
      return { result: { missingScopes: access.missingScopes } };
    }
    case "create-repo": {
      const repo = await provider.createRepo({
        ...ref,
        visibility: project.repoVisibility ?? "private",
        defaultBranch: project.defaultBranch ?? "main",
        description: String(step.params.description ?? project.name),
        marker: repoMarker(project.id),
      });
      return { result: { repoId: repo.id, webUrl: repo.webUrl }, repo: repoPatch(repo) };
    }
    case "link-repo": {
      const repo = await provider.getRepo(ref);
      if (!repo) {
        throw new StepFailure(
          "REPO_NOT_FOUND",
          `Kết nối Git không thấy repo ${ref.owner}/${ref.name}.`,
          "Kiểm lại URL repo và cho kết nối quyền đọc repo đó (GitHub: thêm repo vào danh sách repo của app). Sửa xong, bấm “Thử lại bước này”.",
        );
      }
      return { result: { repoId: repo.id, defaultBranch: repo.defaultBranch }, repo: repoPatch(repo) };
    }
    case "commit-template": {
      const base = needBranch(project);
      const files = renderTemplate({
        projectKey: project.key,
        projectName: project.name,
        publicUrl: c.deps.publicUrl,
        defaultBranch: base,
        systemName: c.systemName,
      });
      const message = `chore: thêm file mẫu xDev Hive cho ${project.key}`;
      if (project.repoMode === "new") {
        const { sha } = await provider.commitFiles(ref, { branch: base, message, files });
        return { result: { sha, files: files.map((f) => f.path) } };
      }
      // Repo có sẵn: không commit thẳng vào nhánh chính, đưa file mẫu qua PR để chủ repo duyệt.
      const { sha } = await provider.commitFiles(ref, { branch: TEMPLATE_BRANCH, fromBranch: base, message, files });
      const pr = await provider.openPR(ref, {
        head: TEMPLATE_BRANCH,
        base,
        title: "Thêm file mẫu xDev Hive",
        body: `Hive thêm ${files.map((f) => `\`${f.path}\``).join(", ")} cho dự án \`${project.key}\`. File đã có trong repo sẽ bị thay bằng bản trong PR này; xem kỹ trước khi merge.`,
      });
      return { result: { sha, files: files.map((f) => f.path), prNumber: pr.number, prUrl: pr.url } };
    }
    case "protect-branch": {
      const branch = needBranch(project);
      await provider.protectBranch(ref, branch, {
        requirePullRequest: true,
        requiredApprovals: Number(step.params.requiredApprovals ?? 1),
        allowForcePush: false,
      });
      return { result: { branch } };
    }
    case "add-webhook": {
      if (!project.webhookSecretEnc) throw new StepFailure("NO_WEBHOOK_SECRET", "Dự án chưa có secret webhook.", null);
      const url = String(step.params.url ?? webhookUrl(c.deps.publicUrl, project.id));
      const secret = decryptSecret(c.deps.masterKey, project.webhookSecretEnc, webhookSecretContext(project.id));
      const hook = await provider.addWebhook(ref, { url, secret, events: WEBHOOK_EVENTS });
      return { result: { hookId: hook.id, url } };
    }
  }
}

/**
 * Chạy saga khởi tạo của một dự án: lần lượt các bước chưa xong, ghi trạng thái từng bước trong transaction riêng,
 * gọi nhà cung cấp ngoài transaction. Lỗi thì dừng ở bước đó (dự án `failed`), người quản trị sửa rồi retryStep.
 */
export async function runProvision(
  deps: ProvisionDeps,
  job: ProvisionJob,
  attempt: { retryCount: number; retryLimit: number } = { retryCount: 0, retryLimit: 0 },
): Promise<ProvisionOutcome> {
  const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(deps.pool, { orgId: job.orgId }, fn);

  const loaded = await tenant(async (tx) => {
    const project = await loadProject(tx, job.projectId);
    if (project?.state !== "provisioning") return null;
    const conn = await loadConnection(tx, deps.masterKey, project.scmConnectionId);
    const system = await findSystem(tx, project.systemId);
    return { project, conn, systemName: system?.name ?? "", steps: await loadSteps(tx, project.id) };
  });
  // Dự án đã xong, đã lỗi chờ người xử lý, hoặc đã bị xoá: job cũ chạy lại không làm gì.
  if (!loaded) return "skipped";
  let { project } = loaded;
  if (!loaded.conn) throw new Error("Kết nối Git của dự án không còn.");
  const provider = deps.providerFactory(loaded.conn);

  for (const step of loaded.steps) {
    if (step.state === "done" || step.state === "skipped") continue;
    // Bước còn `failed` mà dự án đang provisioning: người dùng chưa chọn chạy lại bước này, giữ nguyên chỗ dừng.
    if (step.state === "failed") {
      await tenant((tx) =>
        tx.update(projects).set({ state: "failed", updatedAt: sql`now()` }).where(eq(projects.id, job.projectId)),
      );
      return "failed";
    }

    const claimed = await tenant((tx) =>
      tx
        .update(projectProvisionSteps)
        .set({
          state: "running",
          attempts: sql`${projectProvisionSteps.attempts} + 1`,
          startedAt: sql`now()`,
          error: null,
        })
        // `running` cũng nhận: lần chạy trước chết giữa bước, pg-boss giao lại job.
        .where(and(eq(projectProvisionSteps.id, step.id), inArray(projectProvisionSteps.state, ["pending", "running"])))
        .returning({ id: projectProvisionSteps.id }),
    );
    if (claimed.length === 0) return "skipped";

    let output: StepOutput;
    try {
      output = await execute(step, {
        project,
        provider,
        authMode: loaded.conn.authMode,
        systemName: loaded.systemName,
        deps,
      });
    } catch (e) {
      const error = describeFailure(step.kind, project.scmKind, project.repoOwner, e, loaded.conn.authMode);
      if (isGitProviderError(e) && e.retryable && attempt.retryCount < attempt.retryLimit) {
        await tenant((tx) =>
          tx
            .update(projectProvisionSteps)
            .set({ state: "pending", error: { ...error, message: `${error.message} Đang tự thử lại.` } })
            .where(eq(projectProvisionSteps.id, step.id)),
        );
        throw new RetryLater(error.message, { cause: e });
      }
      await tenant(async (tx) => {
        await tx
          .update(projectProvisionSteps)
          .set({ state: "failed", error, finishedAt: sql`now()` })
          .where(eq(projectProvisionSteps.id, step.id));
        await tx.update(projects).set({ state: "failed", updatedAt: sql`now()` }).where(eq(projects.id, project.id));
        await recordAudit(tx, {
          action: "project.provision.step_failed",
          actorUserId: null,
          targetType: "project",
          targetId: project.id,
          data: { stepId: step.id, kind: step.kind, code: error.code, message: error.message },
        });
        await notify(
          tx,
          {
            orgId: job.orgId,
            event: "project.provision_failed",
            title: `Khởi tạo dự án ${project.key} dừng ở bước ${step.kind}`,
            body: `${error.message}\nSửa nguyên nhân rồi chạy lại bước này trên trang dự án.`,
            link: `${deps.publicUrl.replace(/\/+$/, "")}/du-an/${project.key}`,
          },
          { jobs: deps.jobs },
        );
      });
      return "failed";
    }

    project = await tenant(async (tx) => {
      await tx
        .update(projectProvisionSteps)
        .set({ state: "done", result: output.result, error: null, finishedAt: sql`now()` })
        .where(eq(projectProvisionSteps.id, step.id));
      const [updated] = await tx
        .update(projects)
        .set({ ...output.repo, updatedAt: sql`now()` })
        .where(eq(projects.id, project.id))
        .returning();
      await recordAudit(tx, {
        action: "project.provision.step_done",
        actorUserId: null,
        targetType: "project",
        targetId: project.id,
        data: { stepId: step.id, kind: step.kind, result: output.result },
      });
      return updated ?? project;
    });
  }

  await tenant(async (tx) => {
    await tx.update(projects).set({ state: "active", updatedAt: sql`now()` }).where(eq(projects.id, project.id));
    await recordAudit(tx, {
      action: "project.provisioned",
      actorUserId: null,
      targetType: "project",
      targetId: project.id,
      data: { key: project.key, repo: project.repoWebUrl },
    });
  });
  return "active";
}

/** Đăng ký xử lý job khởi tạo ở tiến trình có vai trò `jobs`. */
export async function registerProvisionWorker(
  jobs: Jobs,
  deps: ProvisionDeps,
  opts: { pollingIntervalSeconds?: number } = {},
) {
  await jobs.work<ProvisionJob>(
    PROVISION_QUEUE,
    async (job) => {
      await runProvision(deps, job.data, { retryCount: job.retryCount, retryLimit: PROVISION_RETRY_LIMIT });
    },
    opts,
  );
}
