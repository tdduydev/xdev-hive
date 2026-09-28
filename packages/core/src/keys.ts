import { HiveError } from "./errors.ts";
import type { DocScope } from "./types.ts";

export const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SLUG = "[a-z0-9][a-z0-9-]{0,79}";
const ORG_KEY = new RegExp(`^org/(${SLUG})$`);
const PROJECT_KEY = new RegExp(`^project/([a-z0-9][a-z0-9._-]{0,99})/(${SLUG})$`);

export interface ParsedDocKey {
  scope: DocScope;
  project: string | null;
  slug: string;
}

/** Doc keys are `org/<slug>` (shared by every project) or `project/<project>/<slug>`. */
export function parseDocKey(key: string): ParsedDocKey {
  const org = ORG_KEY.exec(key);
  if (org) return { scope: "org", project: null, slug: org[1]! };
  const proj = PROJECT_KEY.exec(key);
  if (proj) return { scope: "project", project: proj[1]!, slug: proj[2]! };
  throw new HiveError(
    "bad_request",
    `Invalid doc key "${key}". Use org/<slug> or project/<project>/<slug> (lowercase, digits, "-").`,
    { key: "errors.badDocKey", vars: { key } },
  );
}

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
export const decisionsDocKey = (project: string) => `project/${project}/decisions`;

export function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}
