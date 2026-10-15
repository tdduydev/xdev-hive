import type { DocSyncDeps } from "./routes/deps.ts";

export function handleDocsWebhook(_deps: DocSyncDeps, _homeId: string, _request: Request): Response {
  return Response.json({ code: "NOT_IMPLEMENTED", message: "Webhook tài liệu chưa được triển khai." }, { status: 501 });
}
