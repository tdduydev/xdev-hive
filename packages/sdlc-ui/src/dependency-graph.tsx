import type { Breakdown } from "@xdev-hive/contracts";
import { Background, Controls, type Edge, MarkerType, type Node, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "cn";
import { useMemo } from "react";
import { waveOf } from "./breakdown-edit.ts";
import { useText } from "./env.tsx";

const LANE_LABEL_WIDTH = 140;
const COL_WIDTH = 220;
const ROW_HEIGHT = 64;
const LANE_GAP = 28;

export interface DependencyGraphProps {
  breakdown: Breakdown;
  /** Dự án chính đứng làn đầu. */
  homeProject: string;
  view?: "graph" | "list" | undefined;
  /** Vòng vừa bị từ chối: tô các task trong vòng để người duyệt thấy chỗ cần bỏ. */
  cycle?: string[] | undefined;
}

/** Làn theo dự án, dự án chính trước, rồi theo thứ tự xuất hiện trong bản tách. */
export function lanesOf(b: Breakdown, homeProject: string): string[] {
  const seen = [...new Set(b.tasks.map((t) => t.project))];
  return [homeProject, ...seen.filter((p) => p !== homeProject)].filter((p) => seen.includes(p));
}

/**
 * Đặt chỗ thuần cho đồ thị: làn ngang là dự án, cột là đợt (D24). Tách khỏi component để test được mà không cần
 * trình duyệt đo kích thước.
 */
export function layoutGraph(b: Breakdown, homeProject: string) {
  const lanes = lanesOf(b, homeProject);
  const wave = waveOf(b);
  const projectOf = new Map(b.tasks.map((t) => [t.sliceKey, t.project]));
  const nodes: Node[] = [];
  let top = 0;
  for (const lane of lanes) {
    const inLane = b.tasks.filter((t) => t.project === lane);
    const perWave = new Map<number, number>();
    let rows = 1;
    for (const task of inLane) {
      const col = wave.get(task.sliceKey) ?? b.waves.length;
      const row = perWave.get(col) ?? 0;
      perWave.set(col, row + 1);
      rows = Math.max(rows, row + 1);
      nodes.push({
        id: task.sliceKey,
        position: { x: LANE_LABEL_WIDTH + col * COL_WIDTH, y: top + row * ROW_HEIGHT },
        data: { label: `${task.sliceKey} · ${task.title}` },
        draggable: false,
        connectable: false,
        style: { width: COL_WIDTH - 40, fontSize: 12 },
      });
    }
    nodes.push({
      id: `lane:${lane}`,
      position: { x: 0, y: top },
      data: { label: lane },
      draggable: false,
      selectable: false,
      connectable: false,
      type: "input",
      style: { width: LANE_LABEL_WIDTH - 20, fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 12 },
    });
    top += rows * ROW_HEIGHT + LANE_GAP;
  }
  const edges: Edge[] = b.tasks.flatMap((task) =>
    task.dependsOn
      .filter((dep) => projectOf.has(dep))
      .map((dep) => {
        const cross = projectOf.get(dep) !== task.project;
        return {
          id: `${dep}->${task.sliceKey}`,
          source: dep,
          target: task.sliceKey,
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { cross },
          style: cross ? { strokeWidth: 2.5, strokeDasharray: "6 4" } : { strokeWidth: 1 },
        };
      }),
  );
  return { lanes, nodes, edges };
}

/**
 * Đồ thị phụ thuộc của bản tách (AppSdlcBreakdown.dc.html). Ở 360 px luôn là danh sách theo đợt: đồ thị kéo ngang trên
 * màn hẹp khó đọc và khó bấm.
 */
export function DependencyGraph({ breakdown, homeProject, view = "graph", cycle = [] }: DependencyGraphProps) {
  const t = useText().breakdown;
  const { nodes, edges } = useMemo(() => layoutGraph(breakdown, homeProject), [breakdown, homeProject]);
  const labelled = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        ...(e.data?.cross ? { label: t.cross } : {}),
        ...(cycle.includes(e.source) && cycle.includes(e.target)
          ? { style: { ...e.style, stroke: "var(--destructive)", strokeDasharray: "2 3" } }
          : {}),
      })),
    [edges, cycle, t.cross],
  );
  const height = Math.max(200, ...nodes.map((n) => n.position.y + 80));

  return (
    <div className="flex flex-col gap-2">
      {view === "graph" && (
        <section
          aria-label={t.graphScroll}
          className="overflow-hidden rounded-lg border border-border max-sm:hidden"
          style={{ height }}
        >
          <ReactFlow
            nodes={nodes}
            edges={labelled}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </section>
      )}
      <DependencyList breakdown={breakdown} cycle={cycle} className={cn(view === "graph" && "sm:hidden")} />
      <ul aria-label={t.legend} className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <li>{t.legSame}</li>
        <li>{t.legCross}</li>
        <li>{t.legBad}</li>
        <li>{t.legLanes}</li>
      </ul>
    </div>
  );
}

function DependencyList({
  breakdown,
  cycle,
  className,
}: {
  breakdown: Breakdown;
  cycle: string[];
  className?: string;
}) {
  const t = useText().breakdown;
  const projectOf = new Map(breakdown.tasks.map((task) => [task.sliceKey, task.project]));
  return (
    <ol aria-label={t.listAria} className={cn("flex flex-col gap-3", className)}>
      {breakdown.waves.map((wave, i) => (
        <li key={wave.join(",")} className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold text-muted-foreground">{t.wave(i + 1)}</h4>
          <ul className="flex flex-col gap-1">
            {wave.map((key) => {
              const task = breakdown.tasks.find((x) => x.sliceKey === key);
              if (!task) return null;
              return (
                <li
                  key={key}
                  className={cn(
                    "flex flex-col rounded-md border border-border px-2 py-1 text-sm",
                    cycle.includes(key) && "border-destructive",
                  )}
                >
                  <span>
                    <span className="font-mono font-medium">{key}</span> · {task.title}{" "}
                    <span className="font-mono text-xs text-muted-foreground">{task.project}</span>
                  </span>
                  {task.dependsOn.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {t.after(
                        task.dependsOn
                          .map((d) => (projectOf.get(d) !== task.project ? `${d} (${t.cross})` : d))
                          .join(", "),
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}
