import { deployBoard, getDeploy, listDeploys } from "../deploys/board.ts";
import { cancelDeploy, createDeploy } from "../deploys/orchestrator.ts";
import { type DeliveryRouteDeps, deliveryApi, notImplemented } from "../deps.ts";

/** Lần triển khai: tạo, xem, lịch sử, bảng "đang chạy", huỷ. Quay về làm ở T028. */
export function deploysRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).deploys;
  return {
    create: api.create.handler(({ context, input }) => createDeploy(context.tx, deps, context.user.id, input)),
    get: api.get.handler(({ context, input }) => getDeploy(context.tx, context.user.id, input.id)),
    list: api.list.handler(({ context, input }) => listDeploys(context.tx, context.user.id, input)),
    board: api.board.handler(({ context, input }) => deployBoard(context.tx, context.user.id, input.systemId)),
    cancel: api.cancel.handler(({ context, input }) => cancelDeploy(context.tx, deps, context.user.id, input.id)),
    rollback: api.rollback.handler(notImplemented),
    rollbackInfo: api.rollbackInfo.handler(notImplemented),
  };
}
