import type { ClientSource, TaskHistoryItem } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import type { Tx } from "../platform/index.ts";
import { taskForUser } from "./tasks.ts";

/** Đủ cho khung Lịch sử của một task; cũ hơn thì xem log run. */
const HISTORY_LIMIT = 500;

interface HistoryRow extends Record<string, unknown> {
  at: Date;
  client_created_at: Date | null;
  kind: string;
  outcome: "accepted" | "rejected";
  source: ClientSource;
  machine_id: string | null;
  machine_name: string | null;
  actor_id: string | null;
  actor_name: string | null;
  reason_code: string | null;
  reason: string | null;
}

/**
 * Lịch sử ghi của task (specs/027 FR-006): lần ghi từ client nhắm vào task hay run của task, cùng các lần đổi trạng
 * thái run, sắp theo giờ hub nhận. Người xem phải xem được task.
 *
 * Viết bằng SQL theo tên bảng vì runs và fleet đã phụ thuộc tasks, import ngược sẽ thành vòng; RLS vẫn lọc theo tổ
 * chức như mọi truy vấn trong withTenant. Lần trùng không có dòng riêng (client_events chỉ giữ lần đầu) nên không hiện.
 */
export async function taskHistory(tx: Tx, userId: string, taskId: string): Promise<TaskHistoryItem[]> {
  await taskForUser(tx, userId, taskId, "viewer");
  const { rows } = await tx.execute<HistoryRow>(sql`
    with task_runs as (select id, machine_id from hive.runs where task_id = ${taskId}),
    items as (
      select ce.received_at as at, ce.client_created_at, ce.kind, ce.outcome::text as outcome, ce.source::text as source,
             ce.machine_id, ce.user_id as actor_id, ce.reason_code, ce.reason
        from hive.client_events ce
       where (ce.target_type = 'task' and ce.target_id = ${taskId})
          or (ce.target_type = 'run' and ce.target_id in (select id::text from task_runs))
      union all
      -- Trạng thái run do hub ghi khi nhận gói của worker hay lệnh của người dùng; "by" là người khi có người bấm.
      select e.created_at, null, 'run.' || (e.data ->> 'to'), 'accepted', 'worker-run',
             r.machine_id, e.data ->> 'by', null, null
        from hive.run_events e
        join task_runs r on r.id = e.run_id
       where e.type = 'state'
    )
    select i.*, m.name as machine_name, u.name as actor_name
      from items i
      left join hive.machines m on m.id = i.machine_id
      left join auth."user" u on u.id = i.actor_id
     order by i.at desc, i.kind desc
     limit ${HISTORY_LIMIT}
  `);
  // Lấy các dòng mới nhất rồi đảo lại cho đúng thứ tự thời gian: task dài vẫn thấy việc vừa xảy ra.
  return rows.reverse().map((r) => ({
    at: new Date(r.at).toISOString(),
    clientCreatedAt: r.client_created_at ? new Date(r.client_created_at).toISOString() : null,
    kind: r.kind,
    outcome: r.outcome,
    source: r.source,
    machine: r.machine_id && r.machine_name ? { id: r.machine_id, name: r.machine_name } : null,
    // "by" của sự kiện trạng thái có thể là tên luồng (review, workflow) chứ không phải người: chỉ giữ khi khớp người.
    actor: r.actor_id && r.actor_name ? { id: r.actor_id, name: r.actor_name } : null,
    reasonCode: r.reason_code,
    reason: r.reason,
  }));
}
