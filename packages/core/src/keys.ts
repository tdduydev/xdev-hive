import { HiveError } from "./errors.ts";
import type { DocScope } from "./types.ts";

export const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SLUG = "[a-z0-9][a-z0-9-]{0,79}";
const ORG_KEY = new RegExp(`^org/(skills/)?(${SLUG})$`);
const PROJECT_KEY = new RegExp(`^project/([a-z0-9][a-z0-9._-]{0,99})/(skills/|research/)?(${SLUG})$`);
/** A system's docs (roadmap 19c); skills are not kept per system yet. */
const SYSTEM_KEY = new RegExp(`^system/([a-z0-9][a-z0-9._-]{0,99})/(research/)?(${SLUG})$`);

export interface ParsedDocKey {
  scope: DocScope;
  project: string | null;
  slug: string;
  /** org/skills/<name> or project/<project>/skills/<name>: the content is a SKILL.md (see skills.ts). */
  skill: boolean;
}

/**
 * Doc keys are `org/<slug>` (shared by every project), `project/<project>/<slug>` or `system/<system>/<slug>` (shared by
 * a system's services, roadmap 19c); skills put `skills/` before the slug (not in a system); research reports use `research/` in a project or system.
 */
export function parseDocKey(key: string): ParsedDocKey {
  const org = ORG_KEY.exec(key);
  if (org) return { scope: "org", project: null, slug: org[2]!, skill: Boolean(org[1]) };
  const proj = PROJECT_KEY.exec(key);
  if (proj) return { scope: "project", project: proj[1]!, slug: `${proj[2] === "research/" ? "research/" : ""}${proj[3]!}`, skill: proj[2] === "skills/" };
  const sys = SYSTEM_KEY.exec(key);
  // Owned by sys:<name> (access.ts systemOwner), which no project can be.
  if (sys) return { scope: "system", project: `sys:${sys[1]!}`, slug: `${sys[2] ?? ""}${sys[3]!}`, skill: false };
  throw new HiveError(
    "bad_request",
    `Invalid doc key "${key}". Use org/<slug>, project/<project>/<slug> or system/<system>/<slug>, with skills/ before the slug for a skill (lowercase, digits, "-").`,
    { key: "errors.badDocKey", vars: { key } },
  );
}

/** Generated proposal keys are review queue entries, not documents to publish. */
export const CLI_ACTION_SLUG_PREFIX = "cli-action-";
const CLI_ACTION_SLUG = new RegExp(`^${CLI_ACTION_SLUG_PREFIX}[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$`);
export const isCliActionProposalKey = (key: string): boolean => CLI_ACTION_SLUG.test(parseDocKey(key).slug);

/** Short name of one machine: lowercase letters, digits, "-" (max 24). */
export const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** `Duys-MacBook-Pro.local` → `duys-macbook-pro`. */
export function machineIdFrom(hostname: string): string {
  const id = (hostname.split(".")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return id || "host";
}

/**
 * Name an agent writes under, and so the owner of the leases it takes. A hub appends the token name
 * (`claude-1.duy-mbp@duy`); the machine part keeps two machines on one token from sharing a lease.
 * Local mode has one database per machine, so the OS user is enough.
 */
export function agentActorName(agent: string, mode: "local" | "hub", machine: string, user: string): string {
  return mode === "hub" ? `${agent}.${machine}` : `${agent}@${user}`;
}

export const agentsDocKey = (project: string) => `project/${project}/agents`;
export const systemDocKey = (system: string, slug: string) => `system/${system}/${slug}`;
export const decisionsDocKey = (project: string) => `project/${project}/decisions`;

export function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}
