import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import { type RequestContext, type Tx, withTenant } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { cancelTask, createTask, getTask, listTasks, updateTask } from "./tasks.ts";

export interface TasksDeps extends OrgDeps {
  /** Module runs gắn vào để huỷ run đang chạy khi huỷ task; tasks không import runs (runs đã phụ thuộc tasks). */
  cancelRuns?: ((tx: Tx, taskId: string) => Promise<() => void>) | undefined;
}

export function tasksRouter(deps: TasksDeps) {
  const { authed, inOrg, orgMember } = orgMiddlewares(deps);
  const os = implement(contract.tasks).$context<RequestContext>().use(authed);
  return {
    create: os.create.use(inOrg).handler(({ context: { tx, user }, input }) => createTask(tx, user.id, input)),
    list: os.list
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => listTasks(tx, user.id, input.projectId, input.status)),
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
  };
}
