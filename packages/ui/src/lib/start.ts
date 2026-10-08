import type { AgentProfileStatus, DesktopSettings, Machine, SetupReport } from "@xdev-hive/core";

export function projectReadiness(project: string, settings: DesktopSettings | null | undefined, report: SetupReport | null | undefined, profiles: AgentProfileStatus[], machines: Machine[], desktop: boolean): { repo: boolean; agent: boolean } {
  if (!project) return { repo: false, agent: false };
  if (desktop) {
    const repo = settings?.projects.find((p) => p.name === project);
    const checked = report?.projects.find((p) => p.project === project);
    const connected = settings?.mode === "local" || (settings?.mode === "hub" && settings.hasHubToken && settings.runner.acceptHubRuns);
    return {
      repo: !!repo && !!checked && checked.items.every((i) => i.state === "installed"),
      agent: !!connected && profiles.some((p) => p.enabled && !!p.cliPath && (p.login?.loggedIn === true || p.hasToken)),
    };
  }
  const hosts = machines.filter((m) => m.projects.includes(project));
  return {
    repo: hosts.length > 0,
    agent: hosts.some((m) => m.online && m.acceptsRuns && m.profiles.some((p) => p.enabled && p.installed && p.loggedIn === true)),
  };
}

export type StartStep = "connection" | "tools" | "projects" | "agents" | "intake";
export type StepState = "done" | "todo" | "optional";

/** Readiness is installation, not being on the newest version or having quota left right now. */
export function startSteps(settings: DesktopSettings, report: SetupReport, profiles: AgentProfileStatus[]): Record<StartStep, StepState> {
  const local = settings.mode === "local";
  const readyProfile = profiles.some((p) => p.enabled && !!p.cliPath && (p.login?.loggedIn === true || p.hasToken));
  return {
    connection: local ? "optional" : settings.hasHubToken ? "done" : "todo",
    tools: report.machine.every((i) => i.state === "installed") ? "done" : "todo",
    projects: settings.projects.length > 0 && settings.projects.every((p) => {
      const checked = report.projects.find((r) => r.project === p.name);
      return !!checked && checked.items.every((i) => i.state === "installed");
    }) ? "done" : "todo",
    agents: readyProfile ? "done" : "todo",
    intake: local ? "optional" : settings.runner.acceptHubRuns ? "done" : "todo",
  };
}
export const remainingSteps = (steps: Record<StartStep, StepState>): number => Object.values(steps).filter((s) => s === "todo").length;

/** Today's automatic item selection must not turn an initial landing into an explicit deep link. */
export function shouldOpenStartGuide(initialHash: string, currentHash: string): boolean {
  return (!initialHash || initialHash === "#/today") && (!currentHash || /^#\/today(?:\?|$)/.test(currentHash));
}
