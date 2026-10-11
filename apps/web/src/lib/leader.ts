import type { ChatMessage, LeaderAction, Project } from "@xdev-hive/contracts";
import { cliLabel } from "./run-view.ts";

export const ROLE_LABEL: Record<ChatMessage["role"], string> = { user: "Bạn", leader: "Leader", system: "Hệ thống" };

const SETTING_LABEL: Record<string, string> = {
  merge: "merge",
  outcome: "chính sách kết quả",
  features: "tính năng",
  issueIntake: "nhận việc từ issue",
  budget: "ngân sách",
  models: "model",
  runPermissions: "quyền CLI",
  defaultCli: "CLI mặc định",
};

/** Câu mô tả hành động leader đề xuất, để người duyệt biết mình đang đồng ý với việc gì. */
export function describeAction(action: LeaderAction, projects: readonly Project[] | undefined): string {
  switch (action.type) {
    case "task.create": {
      const project = projects?.find((p) => p.id === action.projectId);
      return `Tạo việc "${action.title}" trong dự án ${project?.key ?? "không rõ"}`;
    }
    case "run.dispatch":
      return `Giao việc ${action.taskId.slice(0, 8)} cho ${action.cli ? cliLabel(action.cli) : "agent bất kỳ"}`;
    case "run.cancel":
      return `Huỷ run ${action.runId.slice(0, 8)}`;
    case "project.settings": {
      const keys = Object.keys(action.patch).map((k) => SETTING_LABEL[k] ?? k);
      return `Đổi cấu hình dự án ${action.projectKey}: ${keys.join(", ") || "không có mục nào"}`;
    }
  }
}

/** Đang chờ leader trả lời: tin cuối là của người dùng (leader chưa gọi leader_reply cho lượt đó). */
export const awaitingLeader = (messages: readonly ChatMessage[] | undefined): boolean =>
  messages !== undefined && messages.length > 0 && messages[messages.length - 1]?.role === "user";
