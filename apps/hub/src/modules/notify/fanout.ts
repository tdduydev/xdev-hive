import type { ChatAction, NotificationEvent } from "@xdev-hive/contracts";
import type { Jobs, Tx } from "../platform/index.ts";

export interface NotifyFanoutInput {
  orgId: string;
  event: NotificationEvent;
  title: string;
  body: string;
  link: string | null;
  /** Khoá ổn định của lần phát sự kiện, để chat không gửi lại khi job chạy lại. */
  eventKey: string;
  /** Người nhận hộp thư: những người có liên kết chat và chọn sự kiện này sẽ nhận thêm qua chat. */
  recipients: string[];
  actions: ChatAction[];
}

type NotifyFanout = (tx: Tx, input: NotifyFanoutInput, opts: { jobs?: Jobs | undefined }) => Promise<void>;

// Module chat phụ thuộc runs, knowledge, fleet; những module đó gọi notify(). Để tránh vòng, notify không import chat:
// chat đăng ký hàm chuyển tiếp ở đây lúc hub khởi động.
let fanout: NotifyFanout | undefined;

export function provideNotifyFanout(fn: NotifyFanout | undefined): void {
  fanout = fn;
}

export async function fanoutNotification(
  tx: Tx,
  input: NotifyFanoutInput,
  opts: { jobs?: Jobs | undefined },
): Promise<void> {
  await fanout?.(tx, input, opts);
}
