import { Pill, type PillProps } from "@xdev-hive/ui/pill";
import { type Lang, useOptionalDocEditorEnv } from "./env.tsx";

/**
 * Trạng thái đồng bộ của một tài liệu với repo (FR-040). Gồm trạng thái từng file (`doc_repo_files.state`) và
 * `no_home` cho tài liệu chưa thuộc nhà nào, vì khi đó không có dòng file để đọc trạng thái.
 */
export type DocSyncState =
  | "synced"
  | "pending"
  | "conflict"
  | "failed"
  | "deleted_in_repo"
  | "blocked_secret"
  | "excluded"
  | "no_home";

const text: Record<Lang, { state: Record<DocSyncState, string>; pr: (n: number) => string }> = {
  vi: {
    state: {
      synced: "Đã đồng bộ",
      pending: "Chờ đồng bộ",
      conflict: "Xung đột",
      failed: "Lỗi",
      deleted_in_repo: "Đã xoá trên repo",
      blocked_secret: "Bị chặn vì bí mật",
      excluded: "Không đồng bộ",
      no_home: "Chưa có nhà",
    },
    pr: (n) => `PR #${n} đang mở`,
  },
  en: {
    state: {
      synced: "Synced",
      pending: "Pending sync",
      conflict: "Conflict",
      failed: "Error",
      deleted_in_repo: "Deleted in repository",
      blocked_secret: "Blocked by secret",
      excluded: "Not synced",
      no_home: "No home",
    },
    pr: (n) => `PR #${n} open`,
  },
};

const TONE: Record<DocSyncState, NonNullable<PillProps["tone"]>> = {
  synced: "ok",
  pending: "neutral",
  conflict: "bad",
  failed: "bad",
  deleted_in_repo: "bad",
  blocked_secret: "bad",
  excluded: "neutral",
  no_home: "neutral",
};

/** Chữ của nhãn, tách ra để app chủ dùng cho `aria-label` hay bộ lọc mà không dựng nhãn. */
export function syncStateLabel(state: DocSyncState, lang: Lang, prNumber?: number | null): string {
  return state === "pending" && prNumber ? text[lang].pr(prNumber) : text[lang].state[state];
}

/**
 * Nhãn trạng thái đồng bộ dùng chung web và desktop. Ngôn ngữ lấy từ `DocEditorProvider` nếu có, nếu không thì từ
 * `lang` (màn danh sách nằm ngoài trình soạn). Chờ đồng bộ kèm PR đang mở thì hiện số PR, vì lúc đó bản hub đã
 * nằm trên một nhánh chờ duyệt chứ không chỉ "chờ".
 */
export function SyncBadge({
  state,
  prNumber,
  lang,
  ...props
}: Omit<PillProps, "tone" | "dot" | "children"> & {
  state: DocSyncState;
  prNumber?: number | null | undefined;
  lang?: Lang | undefined;
}) {
  const envLang = useOptionalDocEditorEnv()?.lang;
  const open = state === "pending" && !!prNumber;
  return (
    <Pill tone={open ? "warn" : TONE[state]} dot={state !== "synced"} data-sync-state={state} {...props}>
      {syncStateLabel(state, lang ?? envLang ?? "vi", prNumber)}
    </Pill>
  );
}
