import { notImplementedResponse, type WordHttpDeps } from "./tools.ts";

export interface WordOriginalParams {
  importId: string;
  fileId: string;
}

/**
 * `GET /api/v1/docs/word-imports/:importId/files/:fileId/original`: file Word gốc, chỉ người đọc được tài liệu tạo ra
 * từ nó tải được (FR-020).
 */
export async function handleWordOriginal(
  _deps: WordHttpDeps,
  _request: Request,
  _params: WordOriginalParams,
): Promise<Response> {
  return notImplementedResponse();
}
