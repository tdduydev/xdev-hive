import { notImplemented, type QaRouteDeps, qaApi } from "../deps.ts";

export function roundsRoutes(deps: QaRouteDeps) {
  const api = qaApi(deps).rounds;
  return {
    list: api.list.handler(notImplemented),
    get: api.get.handler(notImplemented),
    create: api.create.handler(notImplemented),
    createNext: api.createNext.handler(notImplemented),
    assign: api.assign.handler(notImplemented),
    record: api.record.handler(notImplemented),
    history: api.history.handler(notImplemented),
    close: api.close.handler(notImplemented),
    reopen: api.reopen.handler(notImplemented),
    deleteNote: api.deleteNote.handler(notImplemented),
  };
}
