import { and, desc, eq, notInArray, or, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadProject, type ProjectRow } from "../catalog/index.ts";
import type { MasterKey, Tx } from "../platform/index.ts";
import {
  type IssueEvent,
  loadConnection,
  type MentionEvent,
  type ProviderFactory,
  type PullRequestEvent,
  type ScmEvent,
  type ScmEventContext,
  type ScmEventRegistry,
} from "../scm/index.ts";
import {
  createSystemTask,
  findTaskByIssue,
  findTaskByKey,
  loadTask,
  setTaskStatus,
  type TaskRow,
} from "../tasks/index.ts";
import { runs } from "./schema.ts";
import { hubEvent, projectReady, type RunRow } from "./state.ts";

// Kiểu viết tay thay vì lấy từ RunsEngine: engine import file này, lấy ngược lại thành vòng phụ thuộc.
export interface ScmHandlerDeps {
  queueRun(
    tx: Tx,
    task: TaskRow,
    project: ProjectRow | null,
    opts: { cli: RunRow["cli"]; createdBy: string; actorUserId?: string | null; instructions?: string[] },
  ): Promise<{ afterCommit: () => void }>;
  steerRun(
    tx: Tx,
    runId: string,
    input: string,
    by: string,
  ): Promise<{ status: "sent" | "pending" | "closing"; afterCommit: () => void }>;
  cancelRunsOfTask(tx: Tx, taskId: string): Promise<() => void>;
  providerFactory: ProviderFactory;
  /** Không có thì không giải mã được kết nối Git: vẫn tạo task, chỉ bỏ bình luận trả lời. */
  masterKey?: MasterKey | undefined;
  publicUrl: string;
  logger: Pick<Console, "warn">;
}

const FINISHED = ["succeeded", "no_changes", "needs_review", "failed", "cancelled"] as const;
const TITLE_MAX = 200;
const BODY_MAX = 50_000;

/** Tiền tố nhánh của run (`ai/<task key>`), xem engine.queueRun. */
const BRANCH_PREFIX = "ai/";

/** Chưa có trang task trên web; đường dẫn này sẽ là trang task khi web có (ghi trong mô tả PR). */
const taskUrl = (publicUrl: string, task: TaskRow) => `${publicUrl.replace(/\/+$/, "")}/tasks/${task.key}`;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** createdBy của task, run do webhook tạo: không có người dùng hub, ghi tài khoản trên nhà cung cấp Git. */
const scmActor = (e: { provider: string; actor: string | null }) => `${e.provider}:${e.actor ?? "?"}`;

/** Run code đang sống của task; run review chạy kèm lúc run cha verifying không nhận chỉ dẫn từ PR. */
async function activeRunOf(tx: Tx, taskId: string): Promise<RunRow | null> {
  const [row] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.taskId, taskId), eq(runs.kind, "code"), notInArray(runs.state, [...FINISHED])))
    .limit(1);
  return row ?? null;
}

/**
 * Run đã mở PR này. So `pr_url` trước; URL trong webhook có thể khác dạng URL API trả lúc mở PR (GitLab bản cũ không
 * có `/-/`), nên so thêm đuôi số PR. Mỗi dự án một repo nên số PR không lẫn sang repo khác.
 */
async function runOfPullRequest(tx: Tx, projectId: string, url: string | null, number: number): Promise<RunRow | null> {
  const [row] = await tx
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        or(
          url ? eq(runs.prUrl, url) : undefined,
          sql`(${runs.prUrl} like ${`%/pull/${number}`} or ${runs.prUrl} like ${`%/merge_requests/${number}`})`,
        ),
      ),
    )
    .orderBy(desc(sql`${runs.prUrl} = ${url ?? ""}`), desc(runs.createdAt))
    .limit(1);
  return row ?? null;
}

/** Task của PR: theo run đã mở PR, không có thì theo nhánh `ai/<task key>` (PR người mở tay từ nhánh của run). */
async function taskOfPullRequest(
  tx: Tx,
  projectId: string,
  pr: PullRequestEvent["pullRequest"],
): Promise<{ task: TaskRow; run: RunRow | null } | null> {
  const run = await runOfPullRequest(tx, projectId, pr.url, pr.number);
  if (run) {
    const task = await loadTask(tx, run.taskId);
    return task ? { task, run } : null;
  }
  if (!pr.head.startsWith(BRANCH_PREFIX)) return null;
  const task = await findTaskByKey(tx, projectId, pr.head.slice(BRANCH_PREFIX.length));
  return task ? { task, run: null } : null;
}

/** Bình luận sau commit: lỗi của GitHub/GitLab không làm task vừa tạo bị rollback. */
function replyLater(
  ctx: ScmEventContext,
  deps: ScmHandlerDeps,
  conn: Awaited<ReturnType<typeof loadConnection>>,
  project: ProjectRow,
  number: number,
  body: string,
  pullRequest = false,
) {
  if (!conn) {
    deps.logger.warn(`Không bình luận được vào #${number} của dự án ${project.id}: thiếu khoá chủ hoặc kết nối Git.`);
    return;
  }
  ctx.afterCommit(async () => {
    await deps
      .providerFactory(conn)
      .commentOnIssue({ owner: project.repoOwner, name: project.repoName }, number, body, { pullRequest });
  });
}

async function connectionOf(tx: Tx, deps: ScmHandlerDeps, project: ProjectRow) {
  return deps.masterKey ? loadConnection(tx, deps.masterKey, project.scmConnectionId) : null;
}

/**
 * Repo public thì ai cũng mở issue, bình luận được, còn agent làm theo nội dung đó lại push được vào repo. Chỉ người
 * có quyền push mới giao việc hay chỉ dẫn được cho agent. Không có kết nối Git để hỏi thì từ chối. Lỗi mạng ném ra
 * để pg-boss chạy lại delivery thay vì bỏ qua yêu cầu của người có quyền.
 */
async function actorCanPush(
  deps: ScmHandlerDeps,
  conn: Awaited<ReturnType<typeof loadConnection>>,
  project: ProjectRow,
  e: { actor: string | null; actorId: number | null },
): Promise<boolean> {
  if (!conn) return false;
  return deps
    .providerFactory(conn)
    .canPush({ owner: project.repoOwner, name: project.repoName }, { login: e.actor, id: e.actorId });
}

async function denied(tx: Tx, task: TaskRow | null, projectId: string, e: ScmEvent, data: Record<string, unknown>) {
  await recordAudit(tx, {
    action: "scm.denied",
    actorUserId: null,
    targetType: task ? "task" : "project",
    targetId: task?.id ?? projectId,
    data: { kind: e.kind, provider: e.provider, actor: e.actor, ...data },
  });
}

export function registerScmHandlers(registry: Pick<ScmEventRegistry, "on">, deps: ScmHandlerDeps): () => void {
  const offs = [
    registry.on("pull_request.merged", (e, ctx) => onMerged(e, ctx, deps)),
    registry.on("pull_request.closed", (e, ctx) => onClosed(e, ctx)),
    registry.on("issue.opened", (e, ctx) => onIssue(e, ctx, deps)),
    registry.on("issue.labeled", (e, ctx) => onIssue(e, ctx, deps)),
    registry.on("comment.mentioned", (e, ctx) => onMention(e, ctx, deps)),
  ];
  return () => {
    for (const off of offs) off();
  };
}

// ---- PR ------------------------------------------------------------------------------------------------------

async function onMerged(e: PullRequestEvent, ctx: ScmEventContext, deps: ScmHandlerDeps) {
  const { tx } = ctx;
  const found = await taskOfPullRequest(tx, ctx.projectId, e.pullRequest);
  if (!found || found.task.status === "done" || found.task.status === "cancelled") return;
  const { task, run } = found;
  // Thay đổi đã vào nhánh chính: run còn chạy trên task (chạy lại theo bình luận) không còn ý nghĩa.
  ctx.afterCommit(await deps.cancelRunsOfTask(tx, task.id));
  await setTaskStatus(tx, task.id, "done");
  if (run) await hubEvent(tx, run, "pr_merged", { url: e.pullRequest.url, actor: e.actor });
  await recordAudit(tx, {
    action: "task.done",
    actorUserId: null,
    targetType: "task",
    targetId: task.id,
    data: { via: e.kind, provider: e.provider, pr: e.pullRequest.number, url: e.pullRequest.url, actor: e.actor },
  });
}

async function onClosed(e: PullRequestEvent, ctx: ScmEventContext) {
  const { tx } = ctx;
  const found = await taskOfPullRequest(tx, ctx.projectId, e.pullRequest);
  // Chỉ task đang chờ review mới về todo: task đã xong, đã huỷ, hay đang có run mới thì PR cũ đóng không ảnh hưởng.
  if (found?.task.status !== "review") return;
  const { task, run } = found;
  if (await activeRunOf(tx, task.id)) return;
  const note = `PR #${e.pullRequest.number} bị đóng mà không merge${e.actor ? ` (bởi ${e.actor})` : ""}.`;
  await setTaskStatus(tx, task.id, "todo");
  if (run) await hubEvent(tx, run, "pr_closed", { url: e.pullRequest.url, actor: e.actor, note });
  await recordAudit(tx, {
    action: "task.reopen",
    actorUserId: null,
    targetType: "task",
    targetId: task.id,
    data: { via: e.kind, provider: e.provider, pr: e.pullRequest.number, url: e.pullRequest.url, note },
  });
}

// ---- Issue ---------------------------------------------------------------------------------------------------

/** Nhãn GitHub không phân biệt hoa thường; GitLab có, nhưng người dùng gõ cấu hình khó khớp đúng chữ hoa. */
function wantsTask(e: Extract<IssueEvent, { kind: "issue.opened" | "issue.labeled" }>, label: string): boolean {
  const want = label.toLowerCase();
  if (e.kind === "issue.labeled") return e.label.toLowerCase() === want;
  return e.issue.labels.some((l) => l.toLowerCase() === want);
}

async function onIssue(
  e: Extract<IssueEvent, { kind: "issue.opened" | "issue.labeled" }>,
  ctx: ScmEventContext,
  deps: ScmHandlerDeps,
) {
  const { tx } = ctx;
  if (!ctx.intake.enabled || !wantsTask(e, ctx.intake.label)) return;
  // Issue mở kèm nhãn sinh hai delivery (opened, labeled) xử lý song song: khoá theo issue để chỉ một bên tạo task.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`issue:${ctx.projectId}:${e.provider}:${e.issue.number}`}, 0))`,
  );
  if (await findTaskByIssue(tx, ctx.projectId, { provider: e.provider, number: e.issue.number })) return;
  const project = await loadProject(tx, ctx.projectId);
  if (!project || project.state === "archived") return;
  const conn = await connectionOf(tx, deps, project);
  // Không trả lời người không có quyền: trả lời thì ai cũng khiến bot bình luận hàng loạt được.
  if (!(await actorCanPush(deps, conn, project, e))) {
    await denied(tx, null, project.id, e, { issue: e.issue.number });
    return;
  }
  const by = scmActor(e);
  const title = clip(e.issue.title.trim() || `Issue #${e.issue.number}`, TITLE_MAX);
  const ref = e.issue.url ? `\n\nIssue: ${e.issue.url}` : "";
  const task = await createSystemTask(
    tx,
    by,
    { projectId: project.id, title, body: clip(e.issue.body, BODY_MAX - ref.length) + ref },
    {
      kind: "issue",
      provider: e.provider,
      repo: e.repo,
      number: e.issue.number,
      url: e.issue.url,
      author: e.issue.author,
    },
  );
  let started = false;
  if (projectReady(project)) {
    const { afterCommit } = await deps.queueRun(tx, task, project, {
      cli: project.settings.defaultCli ?? null,
      createdBy: by,
      actorUserId: null,
    });
    ctx.afterCommit(afterCommit);
    started = true;
  }
  const link = taskUrl(deps.publicUrl, task);
  const body = started
    ? `Hive đã nhận issue này thành task [${task.key}](${link}) và giao cho agent. PR sẽ được mở khi agent làm xong.`
    : `Hive đã nhận issue này thành task [${task.key}](${link}). Dự án chưa sẵn sàng nên task chờ người giao.`;
  replyLater(ctx, deps, conn, project, e.issue.number, body);
}

// ---- Bình luận nhắc bot trên PR ------------------------------------------------------------------------------

async function onMention(e: MentionEvent, ctx: ScmEventContext, deps: ScmHandlerDeps) {
  const { tx } = ctx;
  if (e.target.type !== "pull_request") return;
  const prRun = await runOfPullRequest(tx, ctx.projectId, e.target.url, e.target.number);
  // PR không do run nào mở: không phải việc của Hive.
  if (!prRun) return;
  const task = await loadTask(tx, prRun.taskId);
  const project = await loadProject(tx, ctx.projectId);
  if (!task || !project) return;
  const conn = await connectionOf(tx, deps, project);
  if (!(await actorCanPush(deps, conn, project, e))) {
    await denied(tx, task, project.id, e, { pr: e.target.number, commentId: e.comment.id });
    return;
  }
  const by = scmActor({ provider: e.provider, actor: e.comment.author ?? e.actor });
  const input = clip(e.comment.body.trim(), 100_000);
  let reply: string;
  const active = await activeRunOf(tx, task.id);
  if (active) {
    const { status, afterCommit } = await deps.steerRun(tx, active.id, input, by);
    ctx.afterCommit(afterCommit);
    reply =
      status === "sent"
        ? `Đã chuyển chỉ dẫn tới agent đang chạy task ${task.key}.`
        : status === "pending"
          ? `Run của task ${task.key} chưa bắt đầu; chỉ dẫn sẽ được gửi kèm khi agent bắt đầu.`
          : `Run của task ${task.key} đang kiểm kết quả, chưa nhận chỉ dẫn mới. Hãy nhắc lại sau khi run xong.`;
  } else if (task.status === "done" || task.status === "cancelled") {
    reply = `Task ${task.key} đã ${task.status === "done" ? "xong" : "huỷ"}, Hive không chạy lại.`;
  } else if (!projectReady(project)) {
    reply = `Dự án chưa sẵn sàng, Hive chưa chạy lại task ${task.key} được.`;
  } else {
    const { afterCommit } = await deps.queueRun(tx, task, project, {
      cli: prRun.cli ?? project.settings.defaultCli ?? null,
      createdBy: by,
      actorUserId: null,
      instructions: [input],
    });
    ctx.afterCommit(afterCommit);
    reply = `Đã chạy lại task ${task.key} với chỉ dẫn này; agent sẽ cập nhật PR khi xong.`;
  }
  await recordAudit(tx, {
    action: "run.steer",
    actorUserId: null,
    targetType: "task",
    targetId: task.id,
    data: { provider: e.provider, pr: e.target.number, commentId: e.comment.id, actor: by, rerun: !active },
  });
  replyLater(ctx, deps, conn, project, e.target.number, reply, true);
}
