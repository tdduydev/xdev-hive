import { ORPCError } from "@orpc/client";
import { type ArtifactWriteResult, artifactWriteResult } from "@xdev-hive/contracts";
import { ORG_HEADER } from "@/lib/rpc.ts";

const UPLOAD_FAILED = "Không tải được tệp lên. Kiểm tra kết nối rồi thử lại.";

/**
 * Tải ảnh/PDF lên làm artifact mới. Đi qua `fetch` thay vì oRPC vì thân multipart lớn; lỗi của hub có dạng
 * `{ message, data: { code } }` như lỗi oRPC nên chữ tiếng Việt của hub được giữ nguyên.
 */
export async function uploadArtifactFile(orgId: string, file: File): Promise<ArtifactWriteResult> {
  const body = new FormData();
  body.set("file", file);
  const response = await fetch("/api/v1/artifacts/upload", {
    method: "POST",
    headers: { [ORG_HEADER]: orgId },
    credentials: "same-origin",
    body,
  }).catch(() => {
    throw new Error(UPLOAD_FAILED);
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload && "message" in payload && typeof payload.message === "string"
        ? payload.message
        : UPLOAD_FAILED;
    throw new ORPCError("BAD_REQUEST", { defined: true, message });
  }
  const parsed = artifactWriteResult.safeParse(payload);
  if (!parsed.success) throw new Error("Phản hồi tải tệp không hợp lệ.");
  return parsed.data;
}
