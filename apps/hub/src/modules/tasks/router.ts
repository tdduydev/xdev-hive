import { implement } from "@orpc/server";
import { contract, type PlanApproveInput, type PlanDecision, type PlanRejectInput } from "@xdev-hive/contracts";
import { ConflictError, type RequestContext, type Tx, withTenant } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { setTaskDependencies, withDependencies } from "./dependencies.ts";
import { taskHistory } from "./history.ts";
import { getPlan, listPlans } from "./plans.ts";
import { cancelTask, createTask, getTask, listTasks, toTask, updateTask } from "./tasks.ts";

type PlanAction<I> = (tx: Tx, userId: string, input: I) => Promise<{ result: PlanDecision; afterCommit: () => void }>;

/** Duyệt hay từ chối kế hoạch đổi trạng thái run, nên do module runs làm; tasks chỉ giữ bảng plans và quyền đọc. */
export interface PlanActions {
  approve: PlanAction<PlanApproveInput>;
  reject: PlanAction<PlanRejectInput>;
}

export interface TasksDeps extends OrgDeps {
  /** Module runs gắn vào để huỷ run đang chạy khi huỷ task; tasks không import runs (runs đã phụ thuộc tasks). */
  cancelRuns?: ((tx: Tx, taskId: string) => Promise<() => void>) | undefined;
  /** Module runs gắn vào; không có (hub thiếu HIVE_AUTH_SECRET) thì xem được kế hoạch nhưng không duyệt được. */
  plans?: PlanActions | undefined;
}

export function tasksRouter(deps: TasksDeps) {
  const { authed, inOrg, orgMember } = orgMiddlewares(deps);
  const os = implement(contract.tasks).$context<RequestContext>().use(authed);
  const plans = () => {
    if (!deps.plans) {
      throw new ConflictError("RUNS_DISABLED", "Hub chưa cấu hình HIVE_AUTH_SECRET nên chưa duyệt kế hoạch được.");
    }
    return deps.plans;
  };
  return {
    create: os.create.use(inOrg).handler(({ context: { tx, user }, input }) => createTask(tx, user.id, input)),
    list: os.list
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => listTasks(tx, user.id, input.projectId, input.status, input.mine)),
    get: os.get.use(inOrg).handler(({ context: { tx, user }, input }) => getTask(tx, user.id, input.id)),
    update: os.update.use(inOrg).handler(({ context: { tx, user }, input }) => updateTask(tx, user.id, input)),
    // Tự mở transaction để gửi lệnh huỷ tới máy sau khi commit, không gửi khi transaction rollback.
    cancel: os.cancel.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
      const { task, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, (tx) =>
        cancelTask(tx, user.id, input.id, deps.cancelRuns),
      );
      afterCommit();
      return task;
    }),
    setDependencies: os.setDependencies.use(inOrg).handler(async ({ context: { tx, user }, input }) => {
      const { task } = await setTaskDependencies(tx, user.id, input);
      return withDependencies(tx, toTask(task));
    }),
    history: os.history.use(inOrg).handler(({ context: { tx, user }, input }) => taskHistory(tx, user.id, input.id)),
    plans: {
      get: os.plans.get.use(inOrg).handler(({ context: { tx, user }, input }) => getPlan(tx, user.id, input.id)),
      list: os.plans.list.use(inOrg).handler(({ context: { tx, user }, input }) => listPlans(tx, user.id, input.id)),
      // Như cancel: giao run sau khi commit, không giao run của transaction đã rollback.
      approve: os.plans.approve.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
        const actions = plans();
        const { result, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, (tx) =>
          actions.approve(tx, user.id, input),
        );
        afterCommit();
        return result;
      }),
      reject: os.plans.reject.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
        const actions = plans();
        const { result, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, (tx) =>
          actions.reject(tx, user.id, input),
        );
        afterCommit();
        return result;
      }),
    },
  };
}
