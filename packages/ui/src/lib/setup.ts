import { compareVersions, type SetupItem } from "@xdev-hive/core";

/** An agent CLI behind the newest on its registry (roadmap 33); it still runs, so its state stays "installed". */
export const hasNewer = (i: Pick<SetupItem, "version" | "latest">): boolean => !!i.version && !!i.latest && compareVersions(i.latest, i.version) > 0;


export const needsSetup = (item: SetupItem): boolean => item.state !== "installed" || hasNewer(item);

type ProjectSetup = import("@xdev-hive/core").SetupReport["projects"][number];
export function setupGroups(projects: ProjectSetup[], systems: { name: string; projects: string[] }[]) {
  const assigned = new Set<string>();
  const groups = systems.map((system) => ({
    name: system.name,
    projects: projects.filter((p) => {
      if (assigned.has(p.project) || !system.projects.includes(p.project)) return false;
      assigned.add(p.project);
      return true;
    }).sort((a, b) => Number(b.items.some(needsSetup)) - Number(a.items.some(needsSetup))),
  })).filter((g) => g.projects.length);
  const outside = projects.filter((p) => !assigned.has(p.project)).sort((a, b) => Number(b.items.some(needsSetup)) - Number(a.items.some(needsSetup)));
  if (outside.length) groups.push({ name: "", projects: outside });
  return groups;
}

/** Machine prerequisites precede repo configuration; an index is built after the integrations are ready. */
export function setupOrder(report: import("@xdev-hive/core").SetupReport, projects?: string[] | "machine") {
  if (projects === "machine") return report.machine.filter(needsSetup);
  const rank = (i: SetupItem) => i.id.endsWith(":codegraph-index") ? 1 : 0;
  return [
    ...(projects ? [] : report.machine),
    ...report.projects.filter((p) => !projects || projects.includes(p.project)).flatMap((p) => [...p.items].sort((a, b) => rank(a) - rank(b))),
  ].filter(needsSetup);
}

export async function installSetupSequence(
  initial: import("@xdev-hive/core").SetupReport,
  projects: string[] | "machine" | undefined,
  host: { setupStatus(): Promise<import("@xdev-hive/core").SetupReport>; installSetup(id: string): Promise<{ item: SetupItem; output: string }> },
  changed: (report: import("@xdev-hive/core").SetupReport) => void,
  progress: (item: SetupItem, completed: number, total: number) => void,
) {
  let report = initial;
  const attempted = new Set<string>();
  while (true) {
    const pending = setupOrder(report, projects).filter((i) => !attempted.has(i.id));
    const item = pending.find((i) => i.action);
    if (!item) return pending;
    progress(item, attempted.size, attempted.size + pending.length);
    let result: Awaited<ReturnType<typeof host.installSetup>>;
    try { result = await host.installSetup(item.id); }
    catch (error) { throw new Error(`${item.label}: ${error instanceof Error ? error.message : String(error)}`); }
    attempted.add(item.id);
    report = await host.setupStatus();
    changed(report);
    if (needsSetup(result.item)) throw new Error(`${item.label}: ${result.output || result.item.detail}`);
  }
}
