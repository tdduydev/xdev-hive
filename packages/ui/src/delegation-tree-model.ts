/*
 * Phần thuần của cây giao việc (specs/028): dựng nút, lọc, làm phẳng cho bàn phím, định dạng số. Tách khỏi component
 * để test không cần DOM và để web, desktop cùng một luật.
 *
 * Kiểu dữ liệu chép theo hình của `delegationTree` trong @xdev-hive/contracts (leader.ts) thay vì import: gói ui không
 * phụ thuộc contracts, và kiểu cấu trúc nên dữ liệu hub trả về truyền thẳng vào được.
 */

export type SubagentStatus = "running" | "completed" | "failed" | "killed" | "unknown";

export interface TreeSubagentData {
  id: string;
  parentId: string | null;
  type: string;
  description: string;
  status: SubagentStatus;
  depth: number;
  tokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
}

export interface TreeRunData {
  id: string;
  kind: string;
  state: string;
  attempt: number;
  parentRunId: string | null;
  machine: { id: string; name: string } | null;
  cli: string | null;
  account: string | null;
  startedAt: string | null;
  endedAt: string | null;
  costUsd: number | null;
  error: string | null;
  subagents: TreeSubagentData[] | null;
  subagentsUnsupported: boolean;
}

export interface TreeTaskData {
  id: string;
  key: string;
  title: string;
  status: string;
  projectKey: string;
  createdBy: "leader" | "user";
  runs: TreeRunData[];
}

export interface DelegationTreeData {
  thread: { id: string; title: string; createdAt: string };
  tasks: TreeTaskData[];
  hidden: number;
  active: boolean;
}

export type TreeNode =
  | { kind: "thread"; id: string; thread: DelegationTreeData["thread"]; children: TreeNode[] }
  | { kind: "task"; id: string; task: TreeTaskData; children: TreeNode[] }
  | { kind: "run"; id: string; run: TreeRunData; children: TreeNode[] }
  | { kind: "subagent"; id: string; subagent: TreeSubagentData; run: TreeRunData; children: TreeNode[] };

export type Tone = "neutral" | "ok" | "warn" | "bad" | "sel";

/** Trạng thái run đã kết thúc (khớp TERMINAL_RUN_STATES của hub); trạng thái lạ coi như đang chạy để không bị giấu. */
const FINISHED_RUN = new Set(["succeeded", "no_changes", "needs_review", "failed", "lost", "cancelled"]);
const ERROR_RUN = new Set(["failed", "lost"]);

export const RUN_STATE_LABEL: Record<string, string> = {
  queued: "Chờ máy",
  planning: "Đang lập kế hoạch",
  awaiting_plan: "Chờ duyệt kế hoạch",
  leased: "Đã nhận máy",
  preparing: "Đang chuẩn bị",
  running: "Đang chạy",
  awaiting_input: "Chờ trả lời",
  verifying: "Đang kiểm kết quả",
  succeeded: "Thành công",
  no_changes: "Không có thay đổi",
  needs_review: "Cần người xem",
  failed: "Lỗi",
  lost: "Mất máy",
  cancelling: "Đang huỷ",
  cancelled: "Đã huỷ",
};

export const RUN_KIND_LABEL: Record<string, string> = {
  code: "Viết code",
  review: "Review chéo",
  plan: "Lập kế hoạch",
  leader: "Leader",
  doccheck: "Kiểm tài liệu",
  docassist: "Trợ lý tài liệu",
  sdlc: "Bước AI SDLC",
  brief: "Viết brief",
  skill_proposal: "Đề xuất skill",
};

export const TASK_STATUS_LABEL: Record<string, string> = {
  todo: "Chưa làm",
  queued: "Chờ máy",
  running: "Đang làm",
  awaiting_plan: "Chờ duyệt kế hoạch",
  review: "Chờ review",
  done: "Xong",
  cancelled: "Đã huỷ",
};

export const SUBAGENT_STATUS_LABEL: Record<SubagentStatus, string> = {
  running: "Đang chạy",
  completed: "Xong",
  failed: "Lỗi",
  killed: "Bị dừng",
  unknown: "Không rõ",
};

export function runStateTone(state: string): Tone {
  if (ERROR_RUN.has(state)) return "bad";
  if (state === "succeeded") return "ok";
  if (state === "awaiting_plan" || state === "awaiting_input" || state === "needs_review") return "warn";
  if (state === "queued" || state === "cancelled" || state === "no_changes") return "neutral";
  return FINISHED_RUN.has(state) ? "neutral" : "sel";
}

export function taskStatusTone(status: string): Tone {
  if (status === "done") return "ok";
  if (status === "running") return "sel";
  if (status === "awaiting_plan" || status === "review") return "warn";
  return "neutral";
}

export function subagentTone(status: SubagentStatus): Tone {
  return { running: "sel", completed: "ok", failed: "bad", killed: "bad", unknown: "neutral" }[status] as Tone;
}

export const isRunActive = (state: string): boolean => !FINISHED_RUN.has(state);
export const isRunError = (state: string): boolean => ERROR_RUN.has(state);

/** Nút tự nó đang chạy hay lỗi (không tính con). */
export function isHot(node: TreeNode): boolean {
  if (node.kind === "run") return isRunActive(node.run.state) || isRunError(node.run.state);
  if (node.kind === "subagent") return node.subagent.status !== "completed" && node.subagent.status !== "unknown";
  return false;
}

/** Nút còn việc đang chạy (chính nó hay con cháu): nhánh như vậy không được thu gọn sẵn. */
export function isActive(node: TreeNode): boolean {
  if (node.kind === "run" && isRunActive(node.run.state)) return true;
  if (node.kind === "subagent" && node.subagent.status === "running") return true;
  return node.children.some(isActive);
}

/** Sub-agent lồng theo parentId; cha không có trong danh sách (sự kiện bị mất) thì đưa lên ngay dưới run. */
function subagentNodes(run: TreeRunData): TreeNode[] {
  const list = run.subagents ?? [];
  const ids = new Set(list.map((s) => s.id));
  const build = (parent: string | null): TreeNode[] =>
    list
      .filter((s) => (parent === null ? s.parentId === null || !ids.has(s.parentId) : s.parentId === parent))
      .map((s) => ({ kind: "subagent", id: `sub:${run.id}:${s.id}`, subagent: s, run, children: build(s.id) }));
  return build(null);
}

/** Run con nằm dưới run cha (FR-004); run cha không thuộc task này thì run con đứng ngay dưới task. */
function runNodes(runs: TreeRunData[]): TreeNode[] {
  const ids = new Set(runs.map((r) => r.id));
  const build = (parent: string | null): TreeNode[] =>
    runs
      .filter((r) => (parent === null ? r.parentRunId === null || !ids.has(r.parentRunId) : r.parentRunId === parent))
      .map((r) => ({ kind: "run", id: `run:${r.id}`, run: r, children: [...subagentNodes(r), ...build(r.id)] }));
  return build(null);
}

export function buildTree(tree: DelegationTreeData): TreeNode {
  return {
    kind: "thread",
    id: `thread:${tree.thread.id}`,
    thread: tree.thread,
    children: tree.tasks.map((task) => ({ kind: "task", id: `task:${task.id}`, task, children: runNodes(task.runs) })),
  };
}

export function countNodes(node: TreeNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

/** Bỏ dấu tiếng Việt để gõ "phan quyen" vẫn ra "Phân quyền". */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLocaleLowerCase("vi")
    .trim();
}

export interface TreeFilter {
  /** Chỉ giữ nhánh có run hay sub-agent đang chạy hoặc lỗi. */
  hotOnly: boolean;
  /** Tìm theo tên hay mã task. */
  query: string;
}

function keepHot(node: TreeNode): TreeNode | null {
  const children = node.children.map(keepHot).filter((c): c is TreeNode => c !== null);
  if (isHot(node) || children.length > 0) return { ...node, children };
  return null;
}

/** Cây sau khi lọc; gốc luôn còn để người xem biết đang ở phiên nào. */
export function filterTree(root: TreeNode, filter: TreeFilter): TreeNode {
  const query = normalize(filter.query);
  let tasks = root.children;
  if (query)
    tasks = tasks.filter(
      (node) =>
        node.kind === "task" &&
        (normalize(node.task.title).includes(query) || normalize(node.task.key).includes(query)),
    );
  if (filter.hotOnly) tasks = tasks.map(keepHot).filter((c): c is TreeNode => c !== null);
  return { ...root, children: tasks };
}

/** Ngưỡng thu gọn sẵn (edge case của spec): cây lớn hơn thì nhánh đã xong đóng lại để thấy ngay việc đang chạy. */
export const COLLAPSE_THRESHOLD = 200;

/** Nút có con mà cả nhánh đã xong; chỉ áp khi cây vượt ngưỡng. */
export function defaultCollapsed(root: TreeNode, threshold = COLLAPSE_THRESHOLD): Set<string> {
  const out = new Set<string>();
  if (countNodes(root) <= threshold) return out;
  const walk = (node: TreeNode) => {
    if (node.kind !== "thread" && node.children.length > 0 && !isActive(node)) out.add(node.id);
    else node.children.forEach(walk);
  };
  walk(root);
  return out;
}

export interface FlatNode {
  node: TreeNode;
  level: number;
  parentId: string | null;
}

/** Các nút đang hiện theo thứ tự trên màn, cho phím mũi tên, Home, End. */
export function visibleNodes(root: TreeNode, isExpanded: (id: string) => boolean): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (node: TreeNode, level: number, parentId: string | null) => {
    out.push({ node, level, parentId });
    if (node.children.length > 0 && isExpanded(node.id))
      for (const child of node.children) walk(child, level + 1, node.id);
  };
  walk(root, 1, null);
  return out;
}

export type TreeKeyAction =
  | { type: "focus"; id: string }
  | { type: "expand"; id: string }
  | { type: "collapse"; id: string }
  | { type: "activate"; id: string }
  | null;

/** Luật bàn phím của WAI-ARIA tree view (một cấp chọn, không chọn nhiều). */
export function treeKeyAction(
  flat: FlatNode[],
  currentId: string,
  key: string,
  isExpanded: (id: string) => boolean,
): TreeKeyAction {
  const index = flat.findIndex((f) => f.node.id === currentId);
  if (index < 0) return flat[0] ? { type: "focus", id: flat[0].node.id } : null;
  const current = flat[index] as FlatNode;
  const hasChildren = current.node.children.length > 0;
  switch (key) {
    case "ArrowDown": {
      const next = flat[index + 1];
      return next ? { type: "focus", id: next.node.id } : null;
    }
    case "ArrowUp": {
      const prev = flat[index - 1];
      return prev ? { type: "focus", id: prev.node.id } : null;
    }
    case "ArrowRight":
      if (!hasChildren) return null;
      if (!isExpanded(current.node.id)) return { type: "expand", id: current.node.id };
      return current.node.children[0] ? { type: "focus", id: current.node.children[0].id } : null;
    case "ArrowLeft":
      if (hasChildren && isExpanded(current.node.id)) return { type: "collapse", id: current.node.id };
      return current.parentId ? { type: "focus", id: current.parentId } : null;
    case "Home":
      return flat[0] ? { type: "focus", id: flat[0].node.id } : null;
    case "End": {
      const last = flat.at(-1);
      return last ? { type: "focus", id: last.node.id } : null;
    }
    case "Enter":
    case " ":
      return { type: "activate", id: current.node.id };
    default:
      return null;
  }
}

/**
 * Nhịp hỏi lại cây (research R6): còn run hay sub-agent đang chạy thì 3 giây để trạng thái khớp trong 5 giây
 * (SC-002); xong hết thì 30 giây, chỉ để thấy Leader giao thêm việc. Web và desktop cùng dùng.
 */
export const treeRefetchMs = (tree: { active: boolean } | undefined): number => (tree?.active ? 3000 : 30_000);

/** Thời gian chạy của run; đang chạy thì tính tới `now`. */
export function runDurationMs(run: Pick<TreeRunData, "startedAt" | "endedAt">, now: number): number | null {
  if (!run.startedAt) return null;
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  return Math.max(0, end - Date.parse(run.startedAt));
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.floor(ms / 1000);
  if (total < 1) return "dưới 1 giây";
  if (total < 60) return `${total} giây`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const seconds = total % 60;
    return seconds ? `${minutes} phút ${seconds} giây` : `${minutes} phút`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} giờ ${rest} phút` : `${hours} giờ`;
}

export function formatCost(usd: number | null): string {
  if (usd === null) return "—";
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(tokens: number | null): string {
  if (tokens === null) return "chưa có số token";
  if (tokens < 1000) return `${tokens} token`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1).replace(".", ",")}k token`;
  return `${(tokens / 1_000_000).toFixed(1).replace(".", ",")}M token`;
}
