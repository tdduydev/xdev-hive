import { notImplemented, type QaRouteDeps, qaApi } from "../deps.ts";

export function myWorkRoutes(deps: QaRouteDeps) {
  const api = qaApi(deps).myWork;
  return {
    list: api.list.handler(notImplemented),
  };
}
