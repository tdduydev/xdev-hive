import { EventEmitter } from "node:events";
import { defaultRouting, LEADER_TIER_GUIDE, type LeaderAction, type TaskTier } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import { loadProject, updateProjectSettings } from "../catalog/index.ts";
import type { Tx } from "../platform/index.ts";
import type { RunsEngine } from "../runs/index.ts";
import { createItem, type SdlcDeps } from "../sdlc/index.ts";
import { createTask, loadTask } from "../tasks/index.ts";
import { leaderDelegations } from "./schema.ts";

export interface ActionOutcome {
  result: Record<string, unknown> | null;
  afterCommit?: (() => void) | undefined;
}

/** Cấp độ, model hub sẽ dùng cho cấp đó và lý do; ghi vào audit và đề xuất (FR-067). */
export interface TierChoice {
  tier: TaskTier;
  reason: string | null;
  model: string | null;
  effort: string | null;
}

/**
 * Dự án của hành động có cấp độ: task.create mang thẳng projectId, run.dispatch đi qua task. null khi hành động
 * không có cấp độ hay không tìm thấy.
 */
async function actionProjectId(tx: Tx, action: LeaderAction): Promise<string | null> {
  if (action.type === "task.create") return action.projectId;
  if (action.type === "run.dispatch") return (await loadTask(tx, action.taskId))?.projectId ?? null;
  return null;
}

/** Model/effort định tuyến của dự án cho cấp độ; dự án tắt định tuyến thì model null (hub giữ model theo cách cũ). */
export async function tierChoice(tx: Tx, action: LeaderAction): Promise<TierChoice | null> {
  if ((action.type !== "task.create" && action.type !== "run.dispatch") || !action.tier) return null;
  const projectId = await actionProjectId(tx, action);
  const project = projectId ? await loadProject(tx, projectId) : null;
  const routing = project?.settings.routing ?? defaultRouting;
  const route = routing.enabled ? routing.tiers[action.tier] : null;
  return {
    tier: action.tier,
    reason: action.tierReason ?? null,
    model: route?.model ?? null,
    effort: route?.effort ?? null,
  };
}

/**
 * Bảng cấp độ cho Leader chọn nhất quán: ý nghĩa cố định cộng model/effort định tuyến của dự án (mặc định khi dự án
 * chưa lưu). Tool `leader_tiers` trả bảng này.
 */
export async function tierTable(tx: Tx, projectId: string | null) {
  const project = projectId ? await loadProject(tx, projectId) : null;
  const routing = project?.settings.routing ?? defaultRouting;
  return {
    routingEnabled: routing.enabled,
    tiers: LEADER_TIER_GUIDE.map((g) => ({
      ...g,
      model: routing.enabled ? routing.tiers[g.tier].model : null,
      effort: routing.tiers[g.tier].effort,
      advisor: routing.enabled ? routing.tiers[g.tier].advisor : null,
    })),
    howTo:
      "Gắn `tier` (light|medium|heavy) và `tierReason` ngắn cho mỗi task.create và run.dispatch. Chọn cấp thấp nhất đủ làm tốt việc: hub dùng model/effort theo cấp nên chọn cao quá là phí, thấp quá thì run dễ hỏng.",
  };
}

/**
 * Thực hiện một hành động leader bằng quyền của `userId`: dùng chung cho duyệt đề xuất và cho terminal Leader ở chế độ
 * Bypass, để hai đường cùng kiểm quyền và cùng hiệu ứng. Có `threadId` thì ghi liên kết giao việc cùng transaction
 * (specs/028), để cây của phiên không thiếu việc đã làm mà cũng không có việc bị rollback.
 */
export async function executeLeaderAction(
  tx: Tx,
  userId: string,
  action: LeaderAction,
  runs: RunsEngine | undefined,
  sdlc: SdlcDeps = {},
  threadId?: string,
): Promise<ActionOutcome> {
  if (action.type === "task.create") {
    // Cấp độ đi qua nhãn `tier:` của task để định tuyến của run code (runs/routing.ts) dùng đúng cấp Leader chọn.
    const source = {
      kind: "leader",
      ...(action.tier ? { labels: [`tier:${action.tier}`], tierReason: action.tierReason ?? null } : {}),
    };
    const task = await createTask(
      tx,
      userId,
      { projectId: action.projectId, title: action.title, body: action.body },
      source,
    );
    if (threadId) await recordDelegation(tx, userId, threadId, { kind: "task", taskId: task.id, runId: null });
    return { result: { task } };
  }
  if (action.type === "project.settings")
    return { result: { settings: await updateProjectSettings(tx, userId, action.projectKey, action.patch) } };
  if (action.type === "run.dispatch") {
    if (!runs) throw new Error("Hub chưa cấu hình giao run.");
    const queued = await runs.startRun(tx, userId, {
      taskId: action.taskId,
      ...(action.cli ? { cli: action.cli } : {}),
      ...(action.tier ? { tier: action.tier } : {}),
    });
    if (threadId)
      await recordDelegation(tx, userId, threadId, { kind: "run", taskId: action.taskId, runId: queued.run.id });
    return { result: { run: queued.run }, afterCommit: queued.afterCommit };
  }
  if (action.type === "run.cancel") {
    if (!runs) throw new Error("Hub chưa cấu hình giao run.");
    const cancelled = await runs.cancelRun(tx, userId, action.runId);
    return { result: { run: cancelled.run }, afterCommit: cancelled.afterCommit };
  }
  if (action.type === "sdlc.item.create") {
    // Người duyệt đề xuất là chủ hạng mục (US1-5): quyền ở mọi dự án tham gia kiểm như khi tạo trên web.
    const item = await createItem(tx, userId, action.item, sdlc, { sourceKind: "leader" });
    return {
      result: { item: { id: item.id, ref: item.ref, title: item.title, projectKey: item.project.key } },
    };
  }
  return { result: null };
}

async function recordDelegation(
  tx: Tx,
  userId: string,
  threadId: string,
  link: { kind: "task" | "run"; taskId: string; runId: string | null },
): Promise<void> {
  await tx.insert(leaderDelegations).values({ orgId: sql`hive.ctx_org()`, threadId, createdBy: userId, ...link });
}

/** Một dòng tóm tắt hành động cho nhật ký (không có nội dung tự do dài). */
export function describeAction(action: LeaderAction): string {
  switch (action.type) {
    case "task.create":
      return `Tạo task "${action.title.slice(0, 120)}"`;
    case "run.dispatch":
      return `Giao run cho task ${action.taskId}`;
    case "run.cancel":
      return `Huỷ run ${action.runId}`;
    case "project.settings":
      return `Đổi cài đặt dự án ${action.projectKey}`;
    case "sdlc.item.create":
      return `Tạo hạng mục AI SDLC "${action.item.title.slice(0, 120)}"`;
  }
}

const activity = new EventEmitter();
activity.setMaxListeners(0);

/** Báo có đề xuất mới hay hành động vừa làm trong một cuộc trò chuyện, để terminal Leader làm mới khung bên phải. */
export function emitLeaderActivity(threadId: string): void {
  activity.emit("thread", threadId);
}

export function onLeaderActivity(listener: (threadId: string) => void): () => void {
  activity.on("thread", listener);
  return () => activity.off("thread", listener);
}
