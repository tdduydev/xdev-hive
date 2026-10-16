import type { InboxItem, NotificationEvent } from "@xdev-hive/contracts";
import { useEffect } from "react";
import { hub } from "@/lib/hub-rpc.ts";
import { type Dict, getLang } from "@/lib/i18n.ts";
import { type MachineRun, machineRuns, thisMachine } from "@/lib/machine-runs.ts";
import { ACTIVE } from "@/lib/run-state.ts";
import { type AppSettings, appSettings } from "@/lib/settings.ts";
import { invoke } from "@/lib/tauri.ts";

/**
 * Thông báo Windows thay cho các màn việc của đội đã chuyển sang web: app dò hộp thư cá nhân trên hub và run của máy
 * này, có mục mới thì báo; bấm vào thì Rust mở đúng trang web (việc của đội) hoặc màn Lượt chạy (run trên máy).
 */

/** Hỏi lại mỗi phút: đủ nhanh cho việc chờ duyệt, và Chromium vẫn cho chạy nhịp này khi cửa sổ đang ẩn ở khay. */
export const POLL_MS = 60_000;

export type Category = "approvals" | "questions";

/** Kế hoạch, PR, tài liệu chờ duyệt và câu hỏi của agent; sự kiện khác của hộp thư không báo trên máy. */
const CATEGORY: Partial<Record<NotificationEvent, Category>> = {
  "plan.awaiting_approval": "approvals",
  "review.awaiting": "approvals",
  "code_review.awaiting": "approvals",
  "sdlc.question": "questions",
  "terminal.attention": "questions",
};

/** Trang web mở khi hub không gửi kèm liên kết. */
const FALLBACK: Record<Category, string> = { approvals: "/knowledge/reviews", questions: "/sdlc/questions" };

const SETTING: Record<Category, keyof AppSettings> = { approvals: "notifyApprovals", questions: "notifyQuestions" };

export const categoryOf = (event: NotificationEvent): Category | null => CATEGORY[event] ?? null;

/** Ký tự Rust nhận ở đường dẫn trên hub (safe_hub_path trong src-tauri/src/lib.rs). */
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9/\-_?=&.]{0,299}$/;

/**
 * Liên kết của hộp thư là URL đầy đủ theo địa chỉ công khai của hub, có thể khác địa chỉ máy đăng ký: chỉ giữ đường dẫn
 * để Rust mở trên đúng hub của máy. Không đọc được thì về trang chung của loại việc.
 */
export function hubPath(link: string | null, fallback: string): string {
  if (!link) return fallback;
  try {
    const url = new URL(link, "http://hub.invalid");
    const path = url.pathname + url.search;
    return SAFE_PATH.test(path) ? path : fallback;
  } catch {
    return fallback;
  }
}

/** Dòng đầu có chữ của nội dung (nội dung kế hoạch là Markdown nhiều dòng). */
const firstLine = (body: string) =>
  body
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
    .find(Boolean) ?? "";

export interface Notice {
  title: string;
  body: string;
  web?: string;
  screen?: string;
}

export function inboxNotice(item: InboxItem): Notice | null {
  const category = categoryOf(item.event);
  if (!category) return null;
  return { title: item.title, body: firstLine(item.body), web: hubPath(item.link, FALLBACK[category]) };
}

/** Mục hộp thư đã báo hoặc đã có trước lần dò đầu tiên. Thiếu khoá là chưa dò lần nào. */
const SEEN_KEY = "hive.notify.inbox";
const SEEN_MAX = 300;

function readSeen(): string[] | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}

function writeSeen(ids: string[]) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-SEEN_MAX)));
  } catch {
    /* Không nhớ được thì lần sau dò lại như lần đầu: không báo trùng, chỉ bỏ sót mục đến trong lúc đó. */
  }
}

/**
 * Mục chưa đọc mới so với lần trước. Lần dò đầu (cài app, đăng nhập lần đầu) chỉ ghi nhớ, không báo: hộp thư cũ có thể
 * có hàng chục mục, báo dồn một lúc là vô ích.
 */
export function freshInbox(items: InboxItem[], seen: string[] | null): { fresh: InboxItem[]; seen: string[] } {
  const ids = items.map((i) => i.id);
  if (seen === null) return { fresh: [], seen: ids };
  const known = new Set(seen);
  const fresh = items.filter((i) => !known.has(i.id));
  return { fresh, seen: [...seen, ...fresh.map((i) => i.id)] };
}

const RUN_TEXT: Dict<{
  done: (key: string) => string;
  review: (key: string) => string;
  failed: (key: string) => string;
}> = {
  vi: {
    done: (key) => `${key} đã xong trên máy này`,
    review: (key) => `${key} xong, cần xem kết quả`,
    failed: (key) => `${key} lỗi trên máy này`,
  },
  en: {
    done: (key) => `${key} finished on this machine`,
    review: (key) => `${key} finished and needs review`,
    failed: (key) => `${key} failed on this machine`,
  },
};

/** Run vừa từ đang chạy sang xong hay lỗi giữa hai lần dò. Run bị huỷ thì người huỷ đã biết, không báo. */
export function finishedRuns(before: Map<string, string>, runs: MachineRun[]): Notice[] {
  const t = RUN_TEXT[getLang()];
  const out: Notice[] = [];
  for (const run of runs) {
    const prev = before.get(run.id);
    if (!prev || !ACTIVE.has(prev) || ACTIVE.has(run.state)) continue;
    const title =
      run.state === "succeeded" || run.state === "no_changes"
        ? t.done(run.taskKey)
        : run.state === "needs_review"
          ? t.review(run.taskKey)
          : run.state === "failed" || run.state === "lost"
            ? t.failed(run.taskKey)
            : null;
    if (title) out.push({ title, body: run.title, screen: "runs" });
  }
  return out;
}

const show = (n: Notice) =>
  invoke<void>("show_notification", { title: n.title, body: n.body, web: n.web ?? null, screen: n.screen ?? null });

/**
 * Dò và báo khi đã đăng nhập Hive. Đọc lại cài đặt mỗi lần dò để công tắc ở màn Cài đặt có tác dụng ngay, không cần
 * báo qua lại giữa hai màn. Lỗi mạng hay hub cũ thiếu hộp thư thì bỏ qua lần đó.
 */
export function useTeamNotifications(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn) return;
    let stopped = false;
    let runs: Map<string, string> | null = null;
    const tick = async () => {
      const settings = await appSettings().catch(() => null);
      if (!settings || stopped) return;
      if (settings.notifyApprovals || settings.notifyQuestions) {
        try {
          const { items } = await hub.inbox.list({ unreadOnly: true, limit: 30 });
          const { fresh, seen } = freshInbox(items, readSeen());
          writeSeen(seen);
          for (const item of fresh) {
            const category = categoryOf(item.event);
            const notice = inboxNotice(item);
            if (category && notice && settings[SETTING[category]] && !stopped) await show(notice).catch(() => {});
          }
        } catch {
          /* Hub chưa có hộp thư hay mất mạng: lần sau dò lại. */
        }
      }
      try {
        const machine = await thisMachine();
        if (!machine) return;
        const list = await machineRuns(machine, 20);
        if (runs && settings.notifyRuns && !stopped) {
          for (const notice of finishedRuns(runs, list)) await show(notice).catch(() => {});
        }
        runs = new Map(list.map((r) => [r.id, r.state]));
      } catch {
        /* Giữ trạng thái cũ để lần sau vẫn nhận ra run vừa xong. */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [signedIn]);
}
