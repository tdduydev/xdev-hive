import type { FixRequest } from "./env.tsx";

export interface FixRequestDialogProps {
  request: FixRequest;
  /** Cuộc trò chuyện đang mở artifact (đích "Cuộc trò chuyện này"); bỏ trống thì chỉ gửi được vào cuộc trò chuyện mới. */
  threadId?: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent?: ((result: { threadId: string; messageId: string }) => void) | undefined;
}

/** Hộp "Nhờ Leader sửa": sửa/xoá lỗi, lời nhắn, chọn đích, gửi `askLeaderFix`. T023 điền. */
export function FixRequestDialog(_props: FixRequestDialogProps) {
  return null;
}
