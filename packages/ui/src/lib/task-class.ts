// What a task is (roadmap 54b) as the task sheet shows and edits it: three fields, each its own select.
import { TASK_KINDS, TASK_RISKS, TASK_SIZES, type Task, type TaskKind, type TaskRisk, type TaskSize } from "@xdev-hive/core";

export const CLASS_FIELDS = ["kind", "size", "risk"] as const;
export type ClassField = (typeof CLASS_FIELDS)[number];
export const CLASS_VALUES: Record<ClassField, readonly string[]> = { kind: TASK_KINDS, size: TASK_SIZES, risk: TASK_RISKS };

/** The tasks.classify input that changes one field and leaves the other two as they are. */
export function classInput(id: string, field: ClassField, value: string): { id: string; kind?: TaskKind; size?: TaskSize; risk?: TaskRisk } {
  if (!CLASS_VALUES[field].includes(value)) throw new Error(`${field}: ${value}`);
  // Checked against the field's own list just above.
  return { id, [field]: value } as { id: string; kind?: TaskKind; size?: TaskSize; risk?: TaskRisk };
}

/**
 * Who said what the task is, for the line under the fields: the hub's rules, the classify run, or a person (their
 * name). null when nobody has yet, or the hub is older than 54b and sends no such field.
 */
export function classSource(task: Pick<Task, "classifiedBy" | "classifiedAt">): { by: "rule" | "ai" | "person"; name: string; at: string } | null {
  const by = task.classifiedBy ?? null;
  const at = task.classifiedAt ?? null;
  if (!by || !at) return null;
  return { by: by === "rule" ? "rule" : by === "ai" ? "ai" : "person", name: by, at };
}
