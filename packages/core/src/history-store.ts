import type { DatabaseSync } from "node:sqlite";
import type { ParsedInput } from "#core/methods.ts";
import type { HistoryEntry } from "#core/history.ts";

// Read existing records, not another copy of their history. Never include raw run logs or gate subjects.
const sources = `
 SELECT 'run:' || machine_id || '/' || run_id AS id, 'run' AS kind, updated_at AS at,
 project, task_id AS taskId, task_title AS title, COALESCE(NULLIF(summary, ''), error, '') AS detail,
 machine AS actor, status, machine_id || '/' || run_id AS link FROM run_records
 UNION ALL
 SELECT 'chat:' || m.id, 'chat', m.created_at, t.project, NULL, t.title,
 m.text, m.author, COALESCE(m.status, m.role), CAST(t.id AS TEXT)
 FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
 UNION ALL
 SELECT 'gate:' || id, 'gate', COALESCE(decided_at, created_at), project, task_id,
 gate, COALESCE(note, ''), COALESCE(decided_by, ''), status, task_id FROM sdlc_gates
 UNION ALL
 SELECT 'audit:' || id, 'audit', at, NULL, NULL, action, target || ' · ' || detail,
 actor, '', '' FROM audit`;

export function historyRows(db: DatabaseSync, input: ParsedInput<"history.list">, visible: (entry: HistoryEntry) => boolean) {
  const words = input.query?.trim();
  const like = words ? `%${words.normalize("NFC").toLocaleLowerCase("vi").replace(/[\\%_]/g, "\\$&")}%` : null;
  const rows = db.prepare(`SELECT * FROM (${sources}) WHERE
    (?1 IS NULL OR project = ?1) AND (?2 IS NULL OR project IN (SELECT value FROM json_each(?2)))
    AND (?3 IS NULL OR kind = ?3) AND (?4 IS NULL OR taskId = ?4)
    AND (?5 IS NULL OR at >= ?5) AND (?6 IS NULL OR at <= ?6)
    AND (?7 IS NULL OR hive_fold(COALESCE(project, '') || ' ' || COALESCE(taskId, '') || ' ' || title || ' ' || detail || ' ' || actor || ' ' || status) LIKE ?7 ESCAPE '\\')
    ORDER BY at DESC, id DESC`).iterate(input.project ?? null, input.projects ? JSON.stringify(input.projects) : null,
      input.kind ?? null, input.taskId ?? null, input.since ?? null, input.until ?? null, like);
  const entries: HistoryEntry[] = [];
  let skipped = 0;
  for (const row of rows) {
    const kind = row.kind as HistoryEntry["kind"];
    const link = encodeURIComponent(String(row.link));
    const href = kind === "run" ? `#/runs?run=${link}` : kind === "chat" ? `#/chat?thread=${link}` : kind === "gate" ? `#/pipeline?project=${encodeURIComponent(String(row.project))}` : "#/audit";
    const entry: HistoryEntry = { id: String(row.id), kind, at: String(row.at), project: row.project as string | null,
      taskId: row.taskId as string | null, title: String(row.title), detail: String(row.detail).slice(0, 500),
      actor: String(row.actor), status: String(row.status), href };
    if (!visible(entry)) continue;
    if (skipped++ < input.offset) continue;
    if (entries.length === input.limit) return { entries, hasMore: true };
    entries.push(entry);
  }
  return { entries, hasMore: false };
}
