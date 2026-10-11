import type { Plan, PlanContent } from "@xdev-hive/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import { ConflictError, NotFoundError, type Tx } from "../platform/index.ts";
import { plans } from "./schema.ts";
import { taskForUser } from "./tasks.ts";

export type PlanRow = typeof plans.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toPlan(p: PlanRow): Plan {
  return {
    id: p.id,
    taskId: p.taskId,
    runId: p.runId,
    planRunId: p.planRunId,
    revision: p.revision,
    status: p.status,
    content: p.content,
    editedContent: p.editedContent,
    note: p.note,
    decidedBy: p.decidedBy,
    decidedAt: iso(p.decidedAt),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** Kế hoạch mới nhất của task (lần lập sau cùng), kể cả đã quyết. */
export async function latestPlanOf(tx: Tx, taskId: string): Promise<PlanRow | null> {
  const [row] = await tx.select().from(plans).where(eq(plans.taskId, taskId)).orderBy(desc(plans.revision)).limit(1);
  return row ?? null;
}

export async function getPlan(tx: Tx, userId: string, taskId: string): Promise<Plan> {
  await taskForUser(tx, userId, taskId, "viewer");
  const row = await latestPlanOf(tx, taskId);
  if (!row) throw new NotFoundError("PLAN_NOT_FOUND", "Task chưa có kế hoạch nào.");
  return toPlan(row);
}

/** Kế hoạch theo id trong task, không khoá; dùng để biết run nào cần khoá trước khi khoá kế hoạch. */
export async function findPlan(tx: Tx, taskId: string, planId: string): Promise<PlanRow> {
  const [row] = await tx
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.taskId, taskId)));
  if (!row) throw new NotFoundError("PLAN_NOT_FOUND", "Không tìm thấy kế hoạch của task.");
  return row;
}

/**
 * Khoá kế hoạch còn chờ duyệt tới hết transaction. Người gọi khoá run code trước (cùng thứ tự với đường huỷ run), để
 * duyệt và huỷ chạy cùng lúc không khoá chéo nhau.
 */
export async function lockAwaitingPlan(tx: Tx, taskId: string, planId: string): Promise<PlanRow> {
  const [row] = await tx
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.taskId, taskId)))
    .for("update");
  if (!row) throw new NotFoundError("PLAN_NOT_FOUND", "Không tìm thấy kế hoạch của task.");
  if (row.status !== "awaiting") throw new ConflictError("PLAN_DECIDED", "Kế hoạch không còn chờ duyệt.");
  return row;
}

/**
 * Ghi kế hoạch run plan vừa nộp, chờ duyệt. Người gọi đang khoá run code của task (mỗi task một run code đang sống),
 * nên hai lần ghi không lấy trùng revision.
 */
export async function recordPlan(
  tx: Tx,
  input: { teamId: string; taskId: string; runId: string; planRunId: string; content: PlanContent },
): Promise<PlanRow> {
  const [{ next } = { next: 1 }] = await tx
    .select({ next: sql<number>`coalesce(max(${plans.revision}), 0) + 1` })
    .from(plans)
    .where(eq(plans.taskId, input.taskId));
  const [row] = await tx
    .insert(plans)
    .values({
      orgId: sql`hive.ctx_org()`,
      teamId: input.teamId,
      taskId: input.taskId,
      runId: input.runId,
      planRunId: input.planRunId,
      revision: Number(next),
      content: input.content,
    })
    .returning();
  if (!row) throw new Error("Không ghi được kế hoạch.");
  return row;
}

export async function decidePlan(
  tx: Tx,
  id: string,
  decision: {
    status: "approved" | "rejected";
    by: string;
    note: string | null;
    editedContent?: PlanContent | null;
  },
): Promise<PlanRow> {
  const [row] = await tx
    .update(plans)
    .set({
      status: decision.status,
      note: decision.note,
      editedContent: decision.editedContent ?? null,
      decidedBy: decision.by,
      decidedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(plans.id, id), eq(plans.status, "awaiting")))
    .returning();
  if (!row) throw new ConflictError("PLAN_DECIDED", "Kế hoạch không còn chờ duyệt.");
  return row;
}

/** Run code bị huỷ hay kết thúc khi kế hoạch còn chờ: kế hoạch không còn ai để chạy theo. */
export async function supersedePlans(tx: Tx, runId: string): Promise<void> {
  await tx
    .update(plans)
    .set({ status: "superseded", updatedAt: sql`now()` })
    .where(and(eq(plans.runId, runId), eq(plans.status, "awaiting")));
}

/** Kế hoạch đã duyệt mà run code phải làm theo. */
export async function approvedPlanOf(tx: Tx, runId: string): Promise<PlanRow | null> {
  const [row] = await tx
    .select()
    .from(plans)
    .where(and(eq(plans.runId, runId), eq(plans.status, "approved")))
    .orderBy(desc(plans.revision))
    .limit(1);
  return row ?? null;
}

const CHANGE: Record<NonNullable<PlanContent["files"][number]["change"]>, string> = {
  add: "thêm",
  modify: "sửa",
  delete: "xoá",
};

/** Kế hoạch dạng markdown: đưa vào prompt của agent và nội dung thông báo cho người duyệt. */
export function planMarkdown(p: PlanContent): string {
  const lines = ["**Tóm tắt:**", p.summary, "", "**Các bước:**"];
  p.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title}`);
    if (s.detail) lines.push(...s.detail.split("\n").map((l) => `   ${l}`));
  });
  if (p.files.length) {
    lines.push("", "**File dự kiến đụng:**");
    for (const f of p.files) {
      const change = f.change ? ` (${CHANGE[f.change]})` : "";
      lines.push(`- \`${f.path}\`${change}${f.reason ? `: ${f.reason}` : ""}`);
    }
  }
  if (p.risks.length) lines.push("", "**Rủi ro:**", ...p.risks.map((r) => `- ${r}`));
  if (p.questions.length) lines.push("", "**Câu hỏi cho người duyệt:**", ...p.questions.map((q) => `- ${q}`));
  return lines.join("\n");
}
