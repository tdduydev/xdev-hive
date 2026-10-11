import type { NotificationChannelKind, NotificationEvent } from "@xdev-hive/contracts";
import { notificationChannelCreateInput, notificationChannelUpdateInput } from "@xdev-hive/contracts";

export const NOTIFICATION_EVENT_LABEL: Record<NotificationEvent, string> = {
  "run.failed": "Run thất bại",
  "run.needs_review": "Run cần duyệt",
  "project.provision_failed": "Khởi tạo dự án thất bại",
  "machine.offline": "Máy mất kết nối",
  "member.pending": "Thành viên chờ duyệt",
  "merge.failed": "Merge thất bại",
  "plan.awaiting_approval": "Kế hoạch chờ duyệt",
};

export const NOTIFICATION_EVENTS = Object.keys(NOTIFICATION_EVENT_LABEL) as NotificationEvent[];

/** Khi sửa metadata, bỏ hẳn config để hub giữ nguyên secret đã lưu. Thay config đòi nhập lại toàn bộ. */
export function parseChannelForm(form: FormData, kind: NotificationChannelKind, id?: string) {
  const value = (key: string) => String(form.get(key) ?? "");
  const replaceConfig = !id || form.has("replaceConfig");
  const config = !replaceConfig
    ? undefined
    : kind === "telegram"
      ? {
          kind,
          botToken: value("botToken"),
          chatId: value("chatId"),
        }
      : {
          kind,
          host: value("host"),
          port: Number(value("port")),
          tls: value("tls"),
          ...(value("user").trim() ? { user: value("user").trim() } : {}),
          ...(value("password") ? { password: value("password") } : {}),
          from: value("from").trim(),
          to: value("to")
            .split(/[,;\n]/)
            .map((email) => email.trim())
            .filter(Boolean),
        };
  const input = {
    name: value("name"),
    events: form.getAll("events"),
    enabled: form.has("enabled"),
    ...(config ? { config } : {}),
  };
  return id
    ? notificationChannelUpdateInput.safeParse({ ...input, id })
    : notificationChannelCreateInput.safeParse(input);
}
