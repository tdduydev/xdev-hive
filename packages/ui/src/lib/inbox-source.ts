import type { RunRecord, Task } from "@xdev-hive/core";
import type { HiveClient } from "#ui/client.ts";

/** Both sidebar and Today build from the same complete actionable sources. */
export async function allInboxSources(client: Pick<HiveClient, "call">, filter: { project?: string; projects?: string[] }, includeRuns = true) {
  async function read(source: "tasks" | "runs") {
    const tasks: Task[] = [];
    const runs: RunRecord[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await client.call("inbox.source", { ...filter, source, offset, limit: 500 });
      tasks.push(...page.tasks);
      runs.push(...page.runs);
      if (offset + 500 >= page.total) return { tasks, runs };
    }
  }
  const [tasks, runs] = await Promise.all([read("tasks"), includeRuns ? read("runs") : Promise.resolve({ runs: [] })]);
  // Review tasks bring their newest run (for Merge MR); a waiting run can be the same record.
  const byId = new Map([...tasks.runs, ...runs.runs].map((r) => [`${r.machineId}/${r.runId}`, r]));
  return { tasks: tasks.tasks, runs: [...byId.values()] };
}

/** The dispatch link reads precisely the source used for the pipeline's total. */
export async function allDispatchTasks(client: Pick<HiveClient, "call">, filter: { project?: string; projects?: string[] }) {
  const tasks: Task[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await client.call("sdlc.dispatch", { ...filter, offset, limit: 500 });
    tasks.push(...page.tasks);
    if (offset + 500 >= page.total) return tasks;
  }
}
