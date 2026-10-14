import type { RequirementTrace } from "@xdev-hive/contracts";
import { and, eq, sql } from "drizzle-orm";
import { type ReviewHooks, type RuleContextExtras, requirementsOf, type TraceRequest } from "../knowledge/index.ts";
import type { Tx } from "../platform/index.ts";
import { loadTask, type TaskRow } from "../tasks/index.ts";
import { autoDecide } from "./autoapprove.ts";
import { breakdownRuleInput } from "./breakdown.ts";
import { onBaseline, type SdlcDeps, workflowFor } from "./phases.ts";
import { sdlcArtifacts, sdlcItems, sdlcItemTasks, sdlcQuestions } from "./schema.ts";
import { queueAuthorFix } from "./steps.ts";

/*
 * Điểm nối của `sdlc` vào máy trạng thái duyệt của `knowledge` (T014). main.ts cài một lần bằng `provideReviewHooks`
 * để route, MCP và worker của knowledge đều thấy; tài liệu không thuộc hạng mục thì mọi hook trả về như chưa cài.
 */

async function artifactItem(tx: Tx, docKey: string) {
  const [row] = await tx
    .select({ artifact: sdlcArtifacts, item: sdlcItems })
    .from(sdlcArtifacts)
    .innerJoin(sdlcItems, eq(sdlcItems.id, sdlcArtifacts.itemId))
    .where(eq(sdlcArtifacts.docKey, docKey));
  return row ?? null;
}

/** Luật `no-open-questions` (câu hỏi mở của giai đoạn, FR-017), `breakdown` và `coverage` (tài liệu tách việc). */
export async function ruleContext(tx: Tx, docKey: string): Promise<RuleContextExtras | null> {
  const row = await artifactItem(tx, docKey);
  if (!row) return null;
  const { artifact, item } = row;
  const [open] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(sdlcQuestions)
    .where(
      and(
        eq(sdlcQuestions.itemId, item.id),
        eq(sdlcQuestions.phaseId, artifact.phaseId),
        eq(sdlcQuestions.status, "open"),
      ),
    );
  return { openQuestions: open?.n ?? 0, breakdown: await breakdownRuleInput(tx, item, artifact) };
}

/**
 * Truy vết ở phiên duyệt tài liệu hạng mục: mã requirement theo mẫu của chế độ (FR-001…), task là task của bản tách
 * nhận requirement đó ở mọi dự án tham gia, thay vì dò tiêu đề task trong một dự án.
 */
export async function traceFor(tx: Tx, request: TraceRequest): Promise<RequirementTrace[] | null> {
  const row = await artifactItem(tx, request.docKey);
  const pattern = row?.item.mode.decomposition?.requirementId;
  if (!row || !pattern) return null;
  const reqs = requirementsOf(request.content, pattern);
  if (!reqs.length) return null;
  const links = await tx
    .select({ taskId: sdlcItemTasks.taskId, requirementIds: sdlcItemTasks.requirementIds })
    .from(sdlcItemTasks)
    .where(and(eq(sdlcItemTasks.itemId, row.item.id), eq(sdlcItemTasks.removed, false)));
  const tasks: { task: TaskRow; requirementIds: string[] }[] = [];
  for (const l of links) {
    const task = await loadTask(tx, l.taskId);
    if (task && task.status !== "cancelled") tasks.push({ task, requirementIds: l.requirementIds });
  }
  return reqs.map((r) => ({
    id: r.id,
    text: r.text,
    acceptance: r.acceptance,
    tasks: tasks
      .filter((t) => t.requirementIds.includes(r.id))
      .map(({ task }) => ({ key: task.key, title: task.title, status: task.status })),
  }));
}

/** Bộ hook cài vào knowledge; `deps` là deps của engine để bước soạn lại, giai đoạn kế và đợt chạy được run. */
export function sdlcReviewHooks(deps: SdlcDeps): ReviewHooks {
  return {
    workflowFor,
    onBaseline: (tx, event) => onBaseline(tx, event, deps),
    queueAuthorFix: (tx, request) => queueAuthorFix(tx, request, deps),
    traceFor,
    autoDecide: (tx, request) => autoDecide(tx, request, { jobs: deps.jobs, publicUrl: deps.publicUrl }),
    ruleContext: (tx, docKey) => ruleContext(tx, docKey),
  };
}
