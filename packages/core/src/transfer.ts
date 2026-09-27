// Copies shared data (docs, memory, tasks) from one Hive backend to another: this machine's local
// database → the team hub ("push") or back ("pull"). Never overwrites: a doc that differs becomes a
// proposal on the target, existing memory and tasks are left alone.
import { HiveError } from "./errors.ts";
import { SEED_DOCS } from "./seed.ts";
import type { HiveBackend, Method, MethodInput } from "./methods.ts";
import type { Actor, Memory, Task } from "./types.ts";

export interface TransferSide {
  backend: HiveBackend;
  actor: Actor;
  /** Shown in notes and proposal reasons, e.g. "máy duy-mbp" or "hub". */
  label: string;
}

export const TRANSFER_RESULTS = ["added", "updated", "proposed", "unchanged", "skipped", "failed"] as const;
export type TransferResult = (typeof TRANSFER_RESULTS)[number];

export interface TransferItem {
  kind: "doc" | "memory" | "task";
  key: string;
  result: TransferResult;
  note?: string;
}

export interface TransferReport {
  from: string;
  to: string;
  items: TransferItem[];
  counts: Record<TransferResult, number>;
}

/** memory.list returns at most this many entries per project. */
const MEMORY_PAGE = 500;

const reason = (err: unknown) =>
  err instanceof HiveError && err.code === "forbidden" ? `cần token admin (${err.message})` : (err as Error).message;

export interface TransferOptions {
  /**
   * A doc that differs is saved as a new version on the target (its history keeps the old one) instead of
   * becoming a proposal. For pulling the team's hub copy onto this machine.
   */
  newVersions?: boolean;
}

const untouchedSeed = (key: string, content: string) => SEED_DOCS.some((d) => d.key === key && d.content === content);

export async function transferHive(from: TransferSide, to: TransferSide, opts: TransferOptions = {}): Promise<TransferReport> {
  const items: TransferItem[] = [];
  const track = async (kind: TransferItem["kind"], key: string, fn: () => Promise<Omit<TransferItem, "kind" | "key">>) => {
    try {
      items.push({ kind, key, ...(await fn()) });
    } catch (err) {
      items.push({ kind, key, result: "failed", note: reason(err) });
    }
  };
  const src = <M extends Method>(method: M, input: MethodInput<M>) => from.backend.call(method, input, from.actor);
  const dst = <M extends Method>(method: M, input: MethodInput<M>) => to.backend.call(method, input, to.actor);

  // Docs: latest version only (history stays where it was written).
  const pending = await dst("proposals.list", { status: "pending" });
  for (const summary of await src("docs.list", {})) {
    await track("doc", summary.key, async () => {
      const doc = await src("docs.get", { key: summary.key });
      if (!doc) return { result: "skipped", note: "không còn ở nguồn" };
      const target = await dst("docs.get", { key: doc.key });
      if (target?.content === doc.content) return { result: "unchanged" };
      // Every database starts with the same default org docs: an unedited one carries nothing to move.
      if (untouchedSeed(doc.key, doc.content)) return { result: "skipped", note: "tài liệu mặc định, chưa sửa" };
      if (pending.some((p) => p.docKey === doc.key && p.content === doc.content)) return { result: "unchanged", note: "đã có đề xuất đang chờ duyệt" };
      if (!target || opts.newVersions) {
        try {
          await dst("docs.save", {
            key: doc.key,
            content: doc.content,
            title: doc.title,
            includeInAgents: doc.includeInAgents,
            baseVersion: target?.version ?? 0,
            note: `Chuyển từ ${from.label}`,
          });
          return target ? { result: "updated", note: `v${target.version} → v${target.version + 1}, bản cũ vẫn trong lịch sử` } : { result: "added" };
        } catch (err) {
          if (!(err instanceof HiveError && err.code === "forbidden")) throw err;
          // An agent token cannot write docs: leave it for an admin to approve.
        }
      }
      await dst("proposals.create", {
        docKey: doc.key,
        baseVersion: target?.version ?? 0,
        content: doc.content,
        reason: target ? `Bản trên ${from.label} khác bản ở ${to.label} (v${target.version})` : `Tài liệu mới từ ${from.label}`,
      });
      return { result: "proposed", note: target ? `khác v${target.version}, chờ admin duyệt` : "chờ admin duyệt" };
    });
  }

  // Memory: approved entries only, so copying never skips a review. Same project + kind + content = already there.
  const memories = await src("memory.list", { status: "approved", limit: MEMORY_PAGE });
  const existing = new Map<string, Set<string>>();
  const seen = async (project: string) => {
    if (!existing.has(project)) {
      const list: Memory[] = await dst("memory.list", { project, limit: MEMORY_PAGE });
      existing.set(project, new Set(list.map((m) => `${m.kind}\n${m.content}`)));
    }
    return existing.get(project)!;
  };
  for (const m of memories) {
    await track("memory", `${m.project} #${m.id}`, async () => {
      const set = await seen(m.project);
      if (set.has(`${m.kind}\n${m.content}`)) return { result: "unchanged" };
      const written = await dst("memory.write", { project: m.project, kind: m.kind, content: m.content, taskId: m.taskId ?? undefined });
      set.add(`${m.kind}\n${m.content}`);
      return { result: "added", note: written.status === "pending" ? "chờ admin duyệt ở đích" : undefined };
    });
  }
  if (memories.length >= MEMORY_PAGE) {
    items.push({ kind: "memory", key: "…", result: "skipped", note: `chỉ chuyển ${MEMORY_PAGE} memory mới nhất` });
  }

  // Tasks: new ids only. A task being worked on at the source arrives as "todo", with no lease.
  const targetTasks = new Map((await dst("tasks.list", {})).map((t: Task) => [t.id, t]));
  for (const t of await src("tasks.list", {})) {
    await track("task", t.id, async () => {
      const there = targetTasks.get(t.id);
      if (there) {
        return there.project === t.project && there.title === t.title
          ? { result: "unchanged" }
          : { result: "skipped", note: `id đã có ở ${to.label} với nội dung khác (${there.project}: ${there.title})` };
      }
      await dst("tasks.create", { id: t.id, project: t.project, title: t.title });
      const status = t.status === "doing" ? "todo" : t.status;
      const note = [t.note, t.status === "doing" ? `(Đang làm ở ${from.label} bởi ${t.owner ?? "?"} khi chuyển)` : ""].filter(Boolean).join("\n\n");
      if (status !== "todo" || note) await dst("tasks.update", { id: t.id, status, note: note ? note.slice(0, 2000) : undefined });
      return { result: "added", note: t.status === "doing" ? "đang làm ở nguồn, chuyển sang Chưa làm" : undefined };
    });
  }

  const counts = Object.fromEntries(TRANSFER_RESULTS.map((r) => [r, 0])) as Record<TransferResult, number>;
  for (const i of items) counts[i.result]++;
  return { from: from.label, to: to.label, items, counts };
}
