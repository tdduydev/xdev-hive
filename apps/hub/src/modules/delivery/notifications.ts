import type { NotificationEvent } from "@xdev-hive/contracts";
import { notify } from "../notify/index.ts";
import type { Jobs, Tx } from "../platform/index.ts";

export type DeliveryEvent = Extract<
  NotificationEvent,
  | "ci.failed"
  | "ci.recovered"
  | "deploy.started"
  | "deploy.succeeded"
  | "deploy.failed"
  | "deploy.approval_requested"
  | "server.hostkey_changed"
>;

export interface DeliveryEventInput {
  orgId: string;
  event: DeliveryEvent;
  title: string;
  body: string;
  /**
   * Hệ thống của sự kiện, để kênh chỉ nhận hệ thống đã chọn (`notification_channels.system_ids`). Chưa lọc: T029 nối
   * vào notify.
   */
  systemId?: string | null | undefined;
  /** Khoá ổn định (vd. `deploy:<id>:succeeded`) để job chạy lại không báo hai lần. */
  eventKey: string;
  recipientIds?: string[] | undefined;
  link?: string | null | undefined;
}

/** Mọi thông báo CI/CD và triển khai đi qua đây, để lọc theo hệ thống và chọn người nhận ở một chỗ. */
export async function emitDeliveryEvent(tx: Tx, input: DeliveryEventInput, jobs?: Jobs): Promise<string[]> {
  return notify(
    tx,
    {
      orgId: input.orgId,
      event: input.event,
      title: input.title,
      body: input.body,
      eventKey: input.eventKey,
      recipientIds: input.recipientIds,
      link: input.link,
    },
    { jobs },
  );
}
