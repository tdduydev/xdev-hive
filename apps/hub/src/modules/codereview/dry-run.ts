import {
  type CodeDryRunInput,
  type CodeDryRunResult,
  codeDryRunInput,
  outcomeToCodeWorkflow,
  type WorkflowInput,
} from "@xdev-hive/contracts";
import type { DiffStats } from "@xdev-hive/contracts/worker-protocol";
import { findProject, projectFor } from "../catalog/index.ts";
import { flatGates, listCodeWorkflows } from "../knowledge/index.ts";
import { BadRequestError, NotFoundError, type Tx } from "../platform/index.ts";
import { allowWith, requireTeamRole } from "../tenancy/index.ts";
import { gateApplies } from "./gates.ts";
import { type MatchCandidate, type MatchRun, matchCodeWorkflow, scopeMatches } from "./match.ts";

/** Run code mà chạy thử xét: đủ để chọn quy trình và đánh giá điều kiện từng checkpoint. */
export interface CodeRunInfo {
  id: string;
  kind: string;
  project: { id: string; key: string; name: string; teamId: string; defaultBranch: string };
  taskType: string | null;
  /** PR của run; null khi run chưa mở PR (chạy thử vẫn trả kết quả, chỉ không có PR để hiện). */
  pr: { number: number; url: string } | null;
  /** Nhánh PR nhắm tới. */
  baseBranch: string;
  /** null khi worker cũ không báo `diffStats`. */
  stats: DiffStats | null;
}

/**
 * Cách đọc run cho chạy thử. `runs` import `codereview` (mở phiên khi run kết thúc) nên module này không import ngược
 * được; module `runs` cài vào, giống `DocAssistPort` của knowledge. `load` phải kiểm quyền xem run của người gọi và ném
 * NotFoundError khi không thấy.
 */
export interface CodeRunPort {
  load(tx: Tx, userId: string, runId: string): Promise<CodeRunInfo>;
}

/**
 * Chạy thử một bản nháp quy trình code trên một run có sẵn (FR-009): chỉ đọc, không tạo run, không ghi dữ liệu. Bản nháp
 * đứng thay cho bản đã lưu cùng id để quản trị thấy kết quả của chính thứ họ sắp lưu.
 */
export async function dryRunCodeWorkflow(
  tx: Tx,
  userId: string,
  raw: CodeDryRunInput,
  runs: CodeRunPort,
): Promise<CodeDryRunResult> {
  const { workflow, runId } = codeDryRunInput.parse(raw);
  const info = await runs.load(tx, userId, runId);
  if (info.kind !== "code")
    throw new BadRequestError("RUN_NOT_CODE", "Chạy thử cần một run code, không phải run review hay lập kế hoạch.");
  const { code } = workflow;
  if (!code) throw new BadRequestError("WORKFLOW_CODE_MISSING", "Quy trình code thiếu phạm vi áp dụng.");

  const run: MatchRun = {
    teamId: info.project.teamId,
    projectKey: info.project.key,
    baseBranch: info.baseBranch,
    defaultBranch: info.project.defaultBranch,
    taskType: info.taskType,
    changedFiles: info.stats?.changedFiles ?? null,
  };
  const verdict = workflow.enabled
    ? scopeMatches(code, run, workflow.teamId)
    : { matches: false, reason: "Quy trình đang tắt nên không chạy cho run nào." };

  const saved = await listCodeWorkflows(tx, { teamId: info.project.teamId, projectId: info.project.id });
  const candidates: (MatchCandidate & { id: string | null })[] = saved
    .filter((w) => w.id !== workflow.id && w.code)
    .map((w) => ({
      id: w.id,
      name: w.name,
      teamId: w.teamId,
      // `code` khác null được lọc ở trên; TypeScript không thu hẹp qua callback.
      scope: w.code ?? code,
      updatedAt: new Date(w.updatedAt),
    }));
  // Bản nháp được lưu sẽ có `updated_at` mới nhất nên thắng khi cùng độ cụ thể.
  if (workflow.enabled)
    candidates.push({
      id: workflow.id ?? null,
      name: workflow.name,
      teamId: workflow.teamId,
      scope: code,
      updatedAt: new Date(),
    });
  const { chosen, outranked } = matchCodeWorkflow(candidates, run);

  const ctx = { taskType: info.taskType, stats: info.stats };
  return {
    runId: info.id,
    project: { id: info.project.id, key: info.project.key, name: info.project.name },
    pr: info.pr,
    matched: verdict.matches,
    reason: verdict.reason,
    chosen: chosen && { id: chosen.id, name: chosen.name },
    outranked: outranked.map((w) => ({ id: w.id, name: w.name })),
    gates: flatGates(workflow.phases).map(({ gate, phase }) => {
      const applies = verdict.matches
        ? gateApplies(gate, ctx)
        : { runs: false, reason: "Quy trình không khớp run này nên không checkpoint nào chạy." };
      return { gateId: gate.id, name: gate.name, kind: gate.kind, phase, ...applies };
    }),
  };
}

/**
 * Bản nháp quy trình code tương đương cấu hình dự án (FR-010), chưa lưu. Gắn đội sở hữu dự án để chỉ quản trị đội đó lưu
 * được; người chỉ xem được dự án thì không lấy được bản nháp, vì nó tiết lộ cấu hình review của dự án.
 */
export async function workflowFromProject(tx: Tx, userId: string, projectKey: string): Promise<WorkflowInput> {
  const ref = await findProject(tx, projectKey);
  if (!ref) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
  const project = await projectFor(tx, userId, ref.id, "viewer");
  await allowWith(
    tx,
    userId,
    "workflows.write",
    () => requireTeamRole(tx, userId, project.teamId, "admin"),
    project.teamId,
  );
  return { ...outcomeToCodeWorkflow(project.settings, project.key), teamId: project.teamId };
}
