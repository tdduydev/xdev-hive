import { type RunSearchInput, type RunStatusGroup, runStatusGroup } from "@xdev-hive/contracts";

export type RunFilter = "all" | RunStatusGroup;

export const RUN_FILTERS: readonly { key: RunFilter; label: string }[] = [
  { key: "all", label: "Tất cả" },
  { key: "active", label: "Đang chạy" },
  { key: "waiting", label: "Chờ người" },
  { key: "succeeded", label: "Thành công" },
  { key: "failed", label: "Lỗi" },
  { key: "cancelled", label: "Đã huỷ" },
];

const CLIS = ["claude", "codex", "gemini"] as const;
type Cli = (typeof CLIS)[number];

/** Bộ lọc của /runs, lưu trên URL để chia sẻ link và giữ khi tải lại. */
export interface RunsSearch {
  status?: RunStatusGroup;
  /** Project key (dễ đọc trên URL hơn id); trang đổi sang id khi gọi hub. */
  project?: string;
  cli?: Cli;
  machine?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateRunsSearch(search: Record<string, unknown>): RunsSearch {
  const status = runStatusGroup.safeParse(search.status);
  const { project, cli, machine } = search;
  return {
    ...(status.success ? { status: status.data } : {}),
    ...(typeof project === "string" && project ? { project } : {}),
    ...(typeof cli === "string" && (CLIS as readonly string[]).includes(cli) ? { cli: cli as Cli } : {}),
    ...(typeof machine === "string" && UUID.test(machine) ? { machine } : {}),
  };
}

/** Đầu vào runs.search (chưa có con trỏ) ứng với bộ lọc trên URL. */
export function searchInput(search: RunsSearch, projectId: string | undefined): Omit<RunSearchInput, "cursor"> {
  return {
    limit: PAGE_SIZE,
    ...(search.status ? { status: search.status } : {}),
    ...(projectId ? { projectId } : {}),
    ...(search.cli ? { cli: search.cli } : {}),
    ...(search.machine ? { machineId: search.machine } : {}),
  };
}

export const PAGE_SIZE = 50;

export const hasFilter = (s: RunsSearch): boolean => Boolean(s.status || s.project || s.cli || s.machine);
