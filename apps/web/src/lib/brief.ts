import { ORPCError } from "@orpc/client";
import type { ProjectBrief } from "@xdev-hive/contracts";
import { apiErrorMessage } from "@/lib/api-errors.ts";

/** Commit SHA rút gọn như git hiển thị; brief tay chưa có SHA thì "—". */
export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

/** Số commit nhánh chính đã đi trước brief, hoặc null khi chưa biết hay chưa lệch. */
export function briefDrift(brief: Pick<ProjectBrief, "commitsBehind">): number | null {
  const behind = brief.commitsBehind;
  return behind !== null && behind > 0 ? behind : null;
}

/** Phiên bản gửi làm `baseVersion`: 0 là tạo brief mới. */
export const briefBaseVersion = (brief: Pick<ProjectBrief, "version"> | null | undefined): number =>
  brief?.version ?? 0;

/** CONFLICT khi lưu brief là lệch phiên bản: agent hoặc người khác vừa lưu bản mới hơn bản mình đang sửa. */
export const isBriefConflict = (error: unknown): boolean => error instanceof ORPCError && error.code === "CONFLICT";

/** Lỗi khi lưu brief; nói rõ việc cần làm thay cho câu chung "dữ liệu bị trùng" của CONFLICT. */
export function briefSaveMessage(error: unknown): string {
  if (isBriefConflict(error)) {
    return "Brief vừa được người khác hoặc agent cập nhật. Bấm Huỷ để xem bản mới nhất, rồi sửa lại.";
  }
  return apiErrorMessage(error);
}
