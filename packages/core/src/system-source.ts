// Where a system's repositories come from (GROUP-init-sync). A system used to be only a list of project keys: the hub
// knew neither the GitLab group behind it nor where each repo is cloned from. A second machine could not set the group
// up, and when the group's folder was registered as a project by mistake and then deleted (5/10, customer-ai), the URL
// of one repo was lost with it. The source keeps the group and each member's path and clone URLs, so any machine with a
// forge token rebuilds the same tree, and a periodic sync brings in repos added to the group later.
import { z } from "zod";
import { PROJECT_NAME } from "./keys.ts";
import { GITLAB_PROJECT, isSafeCloneUrl } from "./machine-projects.ts";

/**
 * active: in the group · archived: archived on the forge · gone: no longer listed (deleted, moved, or the token that
 * synced cannot see it). Neither of the last two ever deletes a folder: a person decides what to do with it.
 */
export const SYSTEM_MEMBER_STATES = ["active", "archived", "gone"] as const;
export type SystemMemberState = (typeof SYSTEM_MEMBER_STATES)[number];

const noDotSegment = (v: string) => !v.split("/").some((s) => s === "." || s === "..");

/** The forge's own address: http(s), no credentials, no query, since every machine of the team reads it. */
export function isForgeUrl(u: string): boolean {
  if (!u || u.length > 300) return false;
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.search && !url.hash;
}

export const systemSourceMemberSchema = z.object({
  project: z.string().regex(PROJECT_NAME),
  /** group/sub/repo on GitLab, owner/repo on GitHub. */
  pathWithNamespace: z.string().max(300).regex(GITLAB_PROJECT).refine(noDotSegment, "no . or .. segment"),
  sshUrl: z.string().refine(isSafeCloneUrl, "sshUrl must be ssh or https, without credentials"),
  httpUrl: z.string().refine(isSafeCloneUrl, "httpUrl must be ssh or https, without credentials"),
  defaultBranch: z.string().max(200).nullable().default(null),
  state: z.enum(SYSTEM_MEMBER_STATES).default("active"),
});
export type SystemSourceMember = z.output<typeof systemSourceMemberSchema>;

export const systemSourceSchema = z.object({
  forge: z.enum(["gitlab", "github"]),
  url: z.string().refine(isForgeUrl, "url must be the forge's http(s) address"),
  /** The GitLab group (subgroups included) or the GitHub owner the system mirrors. */
  groupPath: z.string().max(300).regex(/^[\w.-]+(\/[\w.-]+)*$/).refine(noDotSegment, "no . or .. segment"),
  /**
   * One per repo of the group the system ever had. A member whose project is no longer in the system was taken out by
   * a person: a sync keeps it out instead of adding the repo again.
   */
  members: z.array(systemSourceMemberSchema).max(300).superRefine((members, ctx) => {
    const seen = { project: new Set<string>(), path: new Set<string>() };
    for (const m of members) {
      if (seen.project.has(m.project)) ctx.addIssue({ code: "custom", message: `project ${m.project} twice` });
      if (seen.path.has(m.pathWithNamespace.toLowerCase())) ctx.addIssue({ code: "custom", message: `${m.pathWithNamespace} twice` });
      seen.project.add(m.project);
      seen.path.add(m.pathWithNamespace.toLowerCase());
    }
  }),
  /** When a machine last compared it with the forge; null before the first sync. */
  syncedAt: z.iso.datetime().nullable().default(null),
});
export type SystemSource = z.output<typeof systemSourceSchema>;

/** Stored JSON read back; a row this version cannot read counts as no source rather than failing the whole list. */
export function parseSystemSource(json: string | null | undefined): SystemSource | null {
  if (!json) return null;
  try {
    const parsed = systemSourceSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The repo's path under the group: his/backend/svc-core for customer-ai/his/backend/svc-core. */
export function memberPath(groupPath: string, pathWithNamespace: string): string {
  const prefix = `${groupPath.toLowerCase()}/`;
  return pathWithNamespace.toLowerCase().startsWith(prefix) ? pathWithNamespace.slice(prefix.length) : pathWithNamespace.split("/").at(-1)!;
}

/** The subgroups between the group and the repo (["his", "backend"]); [] at the top or without a source. */
export function memberFolder(source: SystemSource | null | undefined, project: string): string[] {
  const m = source?.members.find((x) => x.project === project);
  return m ? memberPath(source!.groupPath, m.pathWithNamespace).split("/").slice(0, -1) : [];
}

/**
 * A system's projects by subgroup, the way they sit in the group and on disk (his › backend › svc-core): top-level
 * repos first, then each folder in path order, and inside each the projects by name.
 */
export function systemFolders(system: { projects: string[]; source?: SystemSource | null }): Array<{ folder: string[]; projects: string[] }> {
  const byFolder = new Map<string, { folder: string[]; projects: string[] }>();
  for (const project of system.projects) {
    const folder = memberFolder(system.source, project);
    const key = folder.join("/");
    const entry = byFolder.get(key) ?? { folder, projects: [] };
    entry.projects.push(project);
    byFolder.set(key, entry);
  }
  return [...byFolder.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([, v]) => ({ folder: v.folder, projects: [...v.projects].sort() }));
}
