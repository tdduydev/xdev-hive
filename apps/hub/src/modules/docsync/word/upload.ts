import { notImplementedResponse, type WordHttpDeps } from "./tools.ts";

/** `POST /api/v1/docs/word-imports` (multipart, plan.md mục 2): phiên web hoặc token cá nhân, tổ chức từ `x-hive-org`. */
export async function handleWordUpload(_deps: WordHttpDeps, _request: Request): Promise<Response> {
  return notImplementedResponse();
}
