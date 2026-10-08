export interface HistoryEntry {
  id: string;
  kind: "run" | "chat" | "gate" | "audit";
  at: string;
  project: string | null;
  taskId: string | null;
  title: string;
  detail: string;
  actor: string;
  status: string;
  href: string;
}

