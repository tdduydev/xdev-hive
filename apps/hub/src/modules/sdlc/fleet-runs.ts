import { type SdlcFleetMachine, sdlcItemRef, TERMINAL_RUN_STATES } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import type { Tx } from "../platform/index.ts";

type FleetRun = SdlcFleetMachine["runs"][number];

/**
 * Run chưa kết thúc theo máy cho trang Đội máy AI SDLC (US15); main.ts cài qua `provideSdlcFleetRuns` vì fleet không
 * import sdlc. Mọi run đều tính vào chỗ đã dùng của máy; run bước hạng mục hoặc run task của bản tách thì kèm hạng mục.
 * Đọc thẳng bảng `runs` như waves.ts vì sdlc không import module runs.
 */
export async function fleetRuns(tx: Tx, machineIds: string[]): Promise<Map<string, FleetRun[]>> {
  const out = new Map<string, FleetRun[]>();
  if (machineIds.length === 0) return out;
  const { rows } = await tx.execute<{
    id: string;
    kind: string;
    machine_id: string;
    started_at: string | null;
    project_key: string;
    item_id: string | null;
    item_number: number | null;
    item_title: string | null;
    step_id: string | null;
  }>(sql`
    select r.id, r.kind, r.machine_id, r.started_at, p.key as project_key,
           coalesce(si.id, ti.id) as item_id, coalesce(si.number, ti.number) as item_number,
           coalesce(si.title, ti.title) as item_title, s.step_id
    from hive.runs r
    join hive.projects p on p.id = r.project_id
    left join hive.sdlc_steps s on s.run_id = r.id
    left join hive.sdlc_items si on si.id = s.item_id
    left join hive.sdlc_item_tasks l on l.task_id = r.task_id and not l.removed
    left join hive.sdlc_items ti on ti.id = l.item_id
    where r.machine_id in ${machineIds} and r.state not in ${[...TERMINAL_RUN_STATES]}
    order by r.started_at nulls last, r.created_at`);
  for (const r of rows) {
    const list = out.get(r.machine_id) ?? [];
    list.push({
      runId: r.id,
      kind: r.kind,
      projectKey: r.project_key,
      item:
        r.item_id && r.item_number !== null
          ? { id: r.item_id, ref: sdlcItemRef(r.item_number), title: r.item_title ?? "" }
          : null,
      step: r.step_id,
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
    });
    out.set(r.machine_id, list);
  }
  return out;
}
