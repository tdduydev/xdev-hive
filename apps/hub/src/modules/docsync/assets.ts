import type { Jobs } from "../platform/index.ts";
import type { DocSyncDeps } from "./routes/deps.ts";

export async function registerAssets(_jobs: Jobs, _deps: DocSyncDeps): Promise<void> {}

export function handleAssetUpload(_deps: DocSyncDeps, _request: Request): Response {
  return Response.json({ code: "NOT_IMPLEMENTED", message: "Tải đính kèm chưa được triển khai." }, { status: 501 });
}

export function handleAssetDownload(_deps: DocSyncDeps, _request: Request, _id?: string): Response {
  return Response.json({ code: "NOT_IMPLEMENTED", message: "Tải đính kèm chưa được triển khai." }, { status: 501 });
}
