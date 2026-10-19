import type { NotificationChannelEvent, NotificationChannelKind, NotificationEvent } from "@xdev-hive/contracts";
import {
  notificationChannelCreateInput,
  notificationChannelEvent,
  notificationChannelUpdateInput,
} from "@xdev-hive/contracts";

export const NOTIFICATION_EVENT_LABEL: Record<NotificationEvent, string> = {
  "run.failed": "Run thất bại",
  "run.needs_review": "Run cần duyệt",
  "project.provision_failed": "Khởi tạo dự án thất bại",
  "machine.offline": "Máy mất kết nối",
  "member.pending": "Thành viên chờ duyệt",
  "merge.failed": "Merge thất bại",
  "plan.awaiting_approval": "Kế hoạch chờ duyệt",
  "review.awaiting": "Tài liệu chờ duyệt",
  "review.overdue": "Duyệt tài liệu quá hạn",
  "code_review.awaiting": "PR chờ duyệt",
  "code_review.overdue": "Duyệt PR quá hạn",
  "code_review.returned": "PR bị trả lại",
  "code_review.approved": "PR đã duyệt, chờ merge",
  "sdlc.question": "Agent hỏi lại (AI SDLC)",
  "sdlc.blocked": "Run code bị chặn (AI SDLC)",
  "sdlc.override": "Ngoại lệ chặn (AI SDLC)",
  "sdlc.sync_failed": "Đồng bộ tài liệu lên repo lỗi",
  "sdlc.converged": "Hạng mục đã hội tụ",
  "sdlc.waiting_machine": "Chờ máy AI SDLC",
  "sdlc.project_added": "Dự án được thêm vào hạng mục",
  "sdlc.auto_approved": "Tự duyệt bởi AI",
  "sdlc.auto_revoked": "Thu hồi tự duyệt",
  "docsync.sync_failed": "Đồng bộ tài liệu thất bại",
  "docsync.conflict": "Tài liệu có xung đột",
  "docsync.paused": "Đồng bộ tài liệu tạm dừng",
  "docsync.import_done": "Nhập tài liệu hoàn tất",
  "docsync.deleted_in_repo": "Tài liệu đã bị xoá trên repo",
  "docsync.extract_review": "Bản trích tài liệu chờ duyệt",
  "artifact.quota": "Dung lượng artifact sắp hết",
  "artifact.public_link.revoked": "Link công khai bị thu hồi",
  "ci.failed": "CI đỏ trên nhánh chính",
  "ci.recovered": "CI xanh lại",
  "deploy.started": "Bắt đầu triển khai",
  "deploy.succeeded": "Triển khai thành công",
  "deploy.failed": "Triển khai thất bại",
  "deploy.approval_requested": "Triển khai chờ duyệt",
  "server.hostkey_changed": "Host key của máy chủ đã đổi",
  "terminal.remote_session": "Phiên điều khiển từ xa",
  "terminal.attention": "Agent cần bạn",
  "terminal.exit": "Phiên terminal kết thúc",
};

/** Sự kiện kênh của tổ chức chọn được; sự kiện riêng của phiên terminal chỉ vào hộp thư của chủ máy. */
export const NOTIFICATION_EVENTS: NotificationChannelEvent[] = notificationChannelEvent.options;

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
