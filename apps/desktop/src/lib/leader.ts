import type { ChatMessage } from "@xdev-hive/contracts";
import { LEADER_TIER_GUIDE, type LeaderAction, type Project, type TaskTier } from "@xdev-hive/contracts";
import { getLang, type Lang } from "@/lib/i18n.ts";

const CLI_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  antigravity: "Antigravity",
};
const cliLabel = (cli: string | null | undefined, lang: Lang) =>
  cli ? (CLI_LABEL[cli] ?? cli) : lang === "en" ? "any agent" : "agent bất kỳ";

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

/** Câu mô tả hành động Leader đề xuất, để người duyệt biết mình đang đồng ý với việc gì (cùng chữ với web). */
export function describeAction(action: LeaderAction, projects: readonly Project[] | undefined, lang: Lang): string {
  const key = (projectId: string) =>
    projects?.find((p) => p.id === projectId)?.key ?? (lang === "en" ? "unknown" : "không rõ");
  if (lang === "en") {
    switch (action.type) {
      case "task.create":
        return `Create task "${action.title}" in project ${key(action.projectId)}`;
      case "run.dispatch":
        return `Assign task ${action.taskId.slice(0, 8)} to ${cliLabel(action.cli, lang)}`;
      case "run.cancel":
        return `Cancel run ${action.runId.slice(0, 8)}`;
      case "project.settings":
        return `Change project ${action.projectKey} settings: ${Object.keys(action.patch).join(", ") || "none"}`;
      case "sdlc.item.create":
        return `Create AI SDLC item "${action.item.title}" in project ${key(action.item.projectId)}`;
    }
  }
  switch (action.type) {
    case "task.create":
      return `Tạo việc "${action.title}" trong dự án ${key(action.projectId)}`;
    case "run.dispatch":
      return `Giao việc ${action.taskId.slice(0, 8)} cho ${cliLabel(action.cli, lang)}`;
    case "run.cancel":
      return `Huỷ run ${action.runId.slice(0, 8)}`;
    case "project.settings": {
      const keys = Object.keys(action.patch).map((k) => SETTING_LABEL[k] ?? k);
      return `Đổi cấu hình dự án ${action.projectKey}: ${keys.join(", ") || "không có mục nào"}`;
    }
    case "sdlc.item.create":
      return `Tạo hạng mục AI SDLC "${action.item.title}" trong dự án ${key(action.item.projectId)}`;
  }
}

const TIER_EN: Record<TaskTier, { label: string; meaning: string }> = {
  light: { label: "Light", meaning: "Docs, wording changes, small config edits, adding or fixing a small test." },
  medium: { label: "Medium", meaning: "One UI screen, CRUD with e2e, a tidy refactor inside one module." },
  heavy: {
    label: "Heavy",
    meaning: "Several modules, protocols, security, data migrations, performance, hard work that needs deep reasoning.",
  },
};

export const TIERS: readonly TaskTier[] = LEADER_TIER_GUIDE.map((entry) => entry.tier);
export const isTier = (value: string): value is TaskTier => (TIERS as readonly string[]).includes(value);

/** Bản tiếng Việt lấy từ hợp đồng để khớp bảng Leader đọc. */
export const tierLabel = (tier: TaskTier, lang: Lang): string =>
  lang === "en" ? TIER_EN[tier].label : (LEADER_TIER_GUIDE.find((e) => e.tier === tier)?.label ?? tier);
export const tierMeaning = (tier: TaskTier, lang: Lang): string =>
  lang === "en" ? TIER_EN[tier].meaning : (LEADER_TIER_GUIDE.find((e) => e.tier === tier)?.meaning ?? "");

/** Chỉ task.create và run.dispatch mang cấp độ; loại khác không hiện ô chọn cấp. */
export const hasTier = (action: { type: string }): boolean =>
  action.type === "task.create" || action.type === "run.dispatch";

/** Đang chờ Leader trả lời: tin cuối là của người dùng (Leader chưa gọi leader_reply cho lượt đó). */
export const awaitingLeader = (messages: readonly ChatMessage[] | undefined): boolean =>
  messages !== undefined && messages.length > 0 && messages[messages.length - 1]?.role === "user";

const hourMinute = new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false });
const monthDay = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short" });

/** Giờ:phút và ngày/tháng (14:02, 11/10 hay 14:02, Oct 11): EN viết tên tháng vì 11/10 đọc thành ngày 10 tháng 11. */
export function formatDayTime(iso: string, lang: Lang = getLang()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  if (lang === "en") return `${hourMinute.format(date)}, ${monthDay.format(date)}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${hourMinute.format(date)}, ${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
}
