import type { ChatAction, ChatSettings } from "@xdev-hive/contracts";
import { ConflictError } from "../platform/index.ts";
import type { ResolvedBot } from "./bots.ts";
import type { ChatDeps } from "./deps.ts";
import type { LinkRow } from "./links.ts";

export interface InboundMessage {
  externalUserId: string;
  /** Nơi trả lời và gửi thông báo sau này: chat riêng với bot. */
  chatId: string;
  /** Tên hiển thị nền tảng báo; chỉ để người dùng nhận ra tài khoản, không dùng nhận diện. */
  label: string;
  chatType: "private" | "group";
  text: string;
}

export interface InboundAction {
  externalUserId: string;
  chatType: "private" | "group";
  data: string;
}

export interface Reply {
  title?: string;
  text: string;
  actions?: ChatAction[];
  url?: string | null;
}

export interface HandlerResult {
  replies: Reply[];
  after?: (() => void) | undefined;
}

export interface Ctx {
  deps: ChatDeps;
  bot: ResolvedBot;
  link: LinkRow;
  settings: ChatSettings;
  chatType: "private" | "group";
}

/** Vượt hạn mức tin tự do tới Leader; là lỗi nghiệp vụ nên được trả lời cho người dùng, không phải lỗi hệ thống. */
export class LimitError extends ConflictError {
  constructor(message: string) {
    super("CHAT_LIMIT", message);
  }
}
