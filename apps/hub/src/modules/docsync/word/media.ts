import { notImplementedResponse, type WordHttpDeps } from "./tools.ts";

export interface WordMediaParams {
  importId: string;
  fileId: string;
  name: string;
}

/**
 * `GET /api/v1/docs/word-imports/:importId/files/:fileId/media/:name`: ảnh giữ tạm để xem trước (plan.md mục 5). Chỉ
 * người tạo lượt và người `manage` ở phạm vi đích xem được.
 */
export async function handleWordMedia(
  _deps: WordHttpDeps,
  _request: Request,
  _params: WordMediaParams,
): Promise<Response> {
  return notImplementedResponse();
}
