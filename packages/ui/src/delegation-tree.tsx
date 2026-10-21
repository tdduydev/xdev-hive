import { cn } from "cn";
import { BotIcon, ChevronRightIcon, ListTodoIcon, PlayIcon, SearchIcon, WorkflowIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./button.tsx";
import {
  buildTree,
  type DelegationTreeData,
  defaultCollapsed,
  filterTree,
  formatCost,
  formatDuration,
  formatTokens,
  RUN_KIND_LABEL,
  RUN_STATE_LABEL,
  runDurationMs,
  runStateTone,
  SUBAGENT_STATUS_LABEL,
  subagentTone,
  TASK_STATUS_LABEL,
  type TreeNode,
  type TreeRunData,
  taskStatusTone,
  treeKeyAction,
  visibleNodes,
} from "./delegation-tree-model.ts";
import { Input } from "./input.tsx";
import { Pill } from "./pill.tsx";

export type {
  DelegationTreeData,
  TreeRunData,
  TreeSubagentData,
  TreeTaskData,
} from "./delegation-tree-model.ts";
export { treeRefetchMs } from "./delegation-tree-model.ts";

export interface DelegationTreeProps {
  tree: DelegationTreeData;
  /** Bấm (hay Enter) vào nút run: web mở trang run, desktop mở màn Agent trên máy hay trang web. */
  onOpenRun: (run: TreeRunData) => void;
  /** Desktop: run chạy trên chính máy đang mở app được đánh dấu "máy này". */
  isThisMachine?: (machineId: string) => boolean;
  /** Mốc giờ để tính thời gian run đang chạy; mặc định là lúc vẽ. */
  now?: number;
  className?: string;
}

/** Tên nút cho trình đọc màn hình: nút cây chứa cả nhánh con, nên tên phải đặt riêng thay vì lấy chữ bên trong. */
export function nodeLabel(node: TreeNode, isThisMachine?: (machineId: string) => boolean): string {
  switch (node.kind) {
    case "thread":
      return `Phiên Leader: ${node.thread.title}`;
    case "task":
      return `${node.task.key} ${node.task.title}, ${TASK_STATUS_LABEL[node.task.status] ?? node.task.status}`;
    case "run": {
      const { run } = node;
      const machine = run.machine
        ? `, máy ${run.machine.name}${isThisMachine?.(run.machine.id) ? " (máy này)" : ""}`
        : "";
      return `Run ${RUN_KIND_LABEL[run.kind] ?? run.kind}, ${RUN_STATE_LABEL[run.state] ?? run.state}${machine}`;
    }
    case "subagent":
      return `Sub-agent ${node.subagent.type}: ${node.subagent.description}, ${SUBAGENT_STATUS_LABEL[node.subagent.status]}`;
  }
}

/**
 * Cây giao việc của một phiên Leader (specs/028): phiên → task → run (run con dưới run cha) → sub-agent. Vẽ bằng danh
 * sách lồng theo mẫu WAI-ARIA tree (research R7): DOM đủ nhanh cho vài trăm nút và đọc được bằng bàn phím, trình đọc
 * màn hình. Chỉ để xem; mở log, terminal qua `onOpenRun`.
 */
export function DelegationTree({ tree, onOpenRun, isThisMachine, now, className }: DelegationTreeProps) {
  const [hotOnly, setHotOnly] = useState(false);
  const [query, setQuery] = useState("");
  /** Lựa chọn mở hay đóng của người xem; nút chưa chạm thì theo mặc định. Giữ qua các lần poll vì id nút ổn định. */
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const items = useRef(new Map<string, HTMLDivElement>());
  const pendingFocus = useRef<string | null>(null);

  const root = useMemo(() => buildTree(tree), [tree]);
  const collapsed = useMemo(() => defaultCollapsed(root), [root]);
  const shown = useMemo(() => filterTree(root, { hotOnly, query }), [root, hotOnly, query]);
  // Đang lọc hay tìm thì mở hết: người xem đang tìm một việc, nhánh đóng sẵn sẽ giấu đúng thứ họ cần.
  const filtering = hotOnly || query.trim() !== "";
  const isExpanded = (id: string) => toggled.get(id) ?? (filtering || !collapsed.has(id));
  const flat = visibleNodes(shown, isExpanded);
  const current = flat.some((f) => f.node.id === focusedId) ? focusedId : (flat[0]?.node.id ?? null);
  const time = now ?? Date.now();

  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    pendingFocus.current = null;
    items.current.get(id)?.focus();
  });

  const setExpanded = (id: string, open: boolean) =>
    setToggled((prev) => {
      const next = new Map(prev);
      next.set(id, open);
      return next;
    });

  const moveFocus = (id: string) => {
    setFocusedId(id);
    pendingFocus.current = id;
  };

  const activate = (node: TreeNode) => {
    if (node.kind === "run") onOpenRun(node.run);
    else if (node.children.length > 0) setExpanded(node.id, !isExpanded(node.id));
  };

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    const id = item?.dataset.nodeId;
    if (!id) return;
    const action = treeKeyAction(flat, id, event.key, isExpanded);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action.type === "focus") moveFocus(action.id);
    else if (action.type === "expand") setExpanded(action.id, true);
    else if (action.type === "collapse") setExpanded(action.id, false);
    else {
      const node = flat.find((f) => f.node.id === action.id)?.node;
      if (node) activate(node);
    }
  }

  const renderNode = (node: TreeNode, level: number, index: number, size: number) => {
    const hasChildren = node.children.length > 0;
    const open = hasChildren && isExpanded(node.id);
    return (
      <div
        key={node.id}
        ref={(el) => {
          if (el) items.current.set(node.id, el);
          else items.current.delete(node.id);
        }}
        role="treeitem"
        aria-label={nodeLabel(node, isThisMachine)}
        aria-level={level}
        aria-posinset={index + 1}
        aria-setsize={size}
        aria-expanded={hasChildren ? open : undefined}
        aria-selected={node.id === current}
        tabIndex={node.id === current ? 0 : -1}
        data-node-id={node.id}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setFocusedId(node.id);
        }}
        className={cn(
          "outline-none",
          // Đường nối kiểu cây gia phả: nét dọc từ cha xuống, nét ngang vào từng con; con cuối chỉ kẻ dọc tới giữa dòng.
          level > 1 &&
            "relative pl-5 before:absolute before:top-0 before:left-2 before:h-full before:border-l before:border-border last:before:h-4 after:absolute after:top-4 after:left-2 after:w-2.5 after:border-t after:border-border",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 items-start gap-1 rounded-md px-1 py-1",
            "[[role=treeitem]:focus-visible>&]:ring-2 [[role=treeitem]:focus-visible>&]:ring-ring",
            node.id === current && "bg-muted/60",
          )}
        >
          {hasChildren ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={open ? "Thu gọn" : "Mở rộng"}
              onClick={() => {
                setFocusedId(node.id);
                setExpanded(node.id, !open);
              }}
              className="mt-0.5 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronRightIcon aria-hidden="true" className={cn("size-4 transition-transform", open && "rotate-90")} />
            </button>
          ) : (
            <span aria-hidden="true" className="size-5 shrink-0" />
          )}
          <NodeContent
            node={node}
            now={time}
            isThisMachine={isThisMachine}
            onOpenRun={(run) => {
              setFocusedId(node.id);
              onOpenRun(run);
            }}
          />
        </div>
        {open && (
          // biome-ignore lint/a11y/useSemanticElements: nhóm con của nút cây theo WAI-ARIA, không phải nhóm ô nhập.
          <div role="group" className="grid">
            {node.children.map((child, i) => renderNode(child, level + 1, i, node.children.length))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={cn("grid min-w-0 content-start gap-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-48">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
          />
          <Input
            type="search"
            className="pl-8"
            aria-label="Tìm theo tên hoặc mã task"
            placeholder="Tìm theo tên hoặc mã task"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button variant="outline" size="sm" aria-pressed={hotOnly} onClick={() => setHotOnly((v) => !v)}>
          <span
            aria-hidden="true"
            className={cn("size-2 rounded-full border border-current", hotOnly && "bg-current")}
          />
          Chỉ đang chạy hoặc lỗi
        </Button>
      </div>
      {tree.hidden > 0 && (
        <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">{tree.hidden} mục bị ẩn do quyền</p>
      )}
      <div
        role="tree"
        aria-label={`Cây giao việc: ${tree.thread.title}`}
        onKeyDown={onKeyDown}
        className="grid min-w-0"
      >
        {renderNode(shown, 1, 0, 1)}
      </div>
      {root.children.length === 0 ? (
        <p className="text-sm text-muted-foreground">Phiên này chưa giao việc nào.</p>
      ) : (
        shown.children.length === 0 && (
          <p className="text-sm text-muted-foreground">Không có việc phù hợp với bộ lọc.</p>
        )
      )}
    </div>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <span className="whitespace-nowrap">{children}</span>;
}

function NodeContent({
  node,
  now,
  isThisMachine,
  onOpenRun,
}: {
  node: TreeNode;
  now: number;
  isThisMachine: ((machineId: string) => boolean) | undefined;
  onOpenRun: (run: TreeRunData) => void;
}) {
  switch (node.kind) {
    case "thread":
      return (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <BotIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 font-semibold break-words text-foreground">{node.thread.title}</span>
          <span className="text-xs text-muted-foreground">Phiên Leader</span>
        </span>
      );
    case "task": {
      const { task } = node;
      return (
        <span className="grid min-w-0 gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <ListTodoIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-mono text-xs text-muted-foreground">{task.key}</span>
            <span className="min-w-0 font-medium break-words text-foreground">{task.title}</span>
            <Pill small tone={taskStatusTone(task.status)}>
              {TASK_STATUS_LABEL[task.status] ?? task.status}
            </Pill>
          </span>
          <span className="text-xs text-muted-foreground">
            {task.createdBy === "leader" ? "Leader tạo" : "Người tạo, Leader giao"} · {task.projectKey}
          </span>
        </span>
      );
    }
    case "run": {
      const { run } = node;
      const mine = run.machine ? (isThisMachine?.(run.machine.id) ?? false) : false;
      return (
        <span className="grid min-w-0 gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <PlayIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => onOpenRun(run)}
              className="cursor-pointer font-medium text-primary underline-offset-2 hover:underline"
            >
              {RUN_KIND_LABEL[run.kind] ?? run.kind}
            </button>
            <Pill small dot tone={runStateTone(run.state)}>
              {RUN_STATE_LABEL[run.state] ?? run.state}
            </Pill>
            {run.attempt > 1 && <span className="text-xs text-muted-foreground">lần thử {run.attempt}</span>}
            {mine && (
              <Pill small tone="sel">
                máy này
              </Pill>
            )}
          </span>
          <span className="flex min-w-0 flex-wrap gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
            <Meta>{run.machine ? run.machine.name : "Chưa có máy"}</Meta>
            {run.cli && <Meta>{run.cli}</Meta>}
            {run.account && <Meta>Gói {run.account}</Meta>}
            <Meta>{formatDuration(runDurationMs(run, now))}</Meta>
            <Meta>{formatCost(run.costUsd)}</Meta>
          </span>
          {run.error && <span className="text-xs break-words text-destructive">{run.error}</span>}
          {run.subagentsUnsupported && (
            <span className="text-xs text-muted-foreground">Không theo dõi được sub-agent của CLI này</span>
          )}
        </span>
      );
    }
    case "subagent": {
      const { subagent } = node;
      return (
        <span className="grid min-w-0 gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <WorkflowIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-mono text-xs text-foreground">{subagent.type}</span>
            <Pill small dot tone={subagentTone(subagent.status)}>
              {SUBAGENT_STATUS_LABEL[subagent.status]}
            </Pill>
          </span>
          {subagent.description && (
            <span className="text-xs break-words text-muted-foreground">{subagent.description}</span>
          )}
          <span className="flex flex-wrap gap-x-2.5 text-xs text-muted-foreground">
            <Meta>{formatTokens(subagent.tokens)}</Meta>
            <Meta>{formatDuration(subagent.durationMs)}</Meta>
          </span>
        </span>
      );
    }
  }
}
