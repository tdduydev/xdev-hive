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
  );
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
