import { invoke } from "@/lib/tauri.ts";

export interface LocalRunLogPage {
  runId: string;
  attempt: number;
  offset: number;
  nextOffset: number;
  size: number;
  bytes: string;
}

export const readRunLog = (id: string, offset: number) => invoke<LocalRunLogPage>("read_run_log", { id, offset });
