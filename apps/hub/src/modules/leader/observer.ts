import type { Tx } from "../platform/index.ts";

/** Điều leader vừa nói hay đề xuất trong một cuộc trò chuyện, để kênh khác (chat) chuyển tiếp cho người đang chờ. */
export interface LeaderEvent {
  threadId: string;
  kind: "reply" | "proposal";
  content: string;
  /** Có khi kind = proposal. */
  approvalId?: string;
}

type LeaderObserver = (tx: Tx, event: LeaderEvent) => Promise<void>;

// Module chat phụ thuộc leader (gọi hàm duyệt, gửi tin), nên leader không import chat mà để chat đăng ký ở đây.
let observer: LeaderObserver | undefined;

export function provideLeaderObserver(fn: LeaderObserver | undefined): void {
  observer = fn;
}

export async function emitLeaderEvent(tx: Tx, event: LeaderEvent): Promise<void> {
  await observer?.(tx, event);
}
