import { hubTool } from "@/lib/hub.ts";
import { invoke } from "@/lib/tauri.ts";

/** Một run trong kết quả tool run_list của hub. */
export interface MachineRun {
  id: string;
  kind: "code" | "review" | "plan" | "leader" | "doccheck";
  state: string;
  taskKey: string;
  title: string;
  projectId: string;
  project: { key: string; name: string } | null;
  cli: string | null;
  model: string | null;
  machine: string | null;
  costUsd: number | null;
  tokensIn: number;
  prUrl: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Máy này trên hub (tên hay id đã đăng ký); null khi chưa đăng ký. */
export const thisMachine = () => invoke<string | null>("this_machine");

/** Run hub đã giao cho máy này, mới nhất trước. */
export const machineRuns = (machine: string, limit = 50) =>
  hubTool<{ runs: MachineRun[] }>("run_list", { machine, limit }).then((r) => r.runs);

/** Thời lượng của run (giây): đang chạy thì tính tới giờ. */
export function duration(run: Pick<MachineRun, "startedAt" | "finishedAt">, now = Date.now()): number | null {
  if (!run.startedAt) return null;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  return Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
}
