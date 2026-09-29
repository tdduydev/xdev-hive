// Skills: docs under org/skills/<name> (the whole team) and project/<project>/skills/<name> whose content is a
// SKILL.md in Claude Code's format: front matter with `name` and `description`, then the instructions.
// Browser-safe: the interface checks a skill with the same code before saving it.
import { HiveError } from "./errors.ts";
import type { DocScope } from "./types.ts";

/** Lowercase letters, digits and "-", like the folder Claude Code loads it from. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SKILL_DESCRIPTION_MAX = 1024;

export interface SkillMeta {
  name: string;
  /** What the skill is for and when to use it: agents choose skills by it. */
  description: string;
}

export interface SkillSummary extends SkillMeta {
  key: string;
  scope: DocScope;
  project: string | null;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export const skillDocKey = (name: string, project?: string | null): string => (project ? `project/${project}/skills/${name}` : `org/skills/${name}`);

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * The front matter's `name` and `description`. A value is on its line (quotes allowed), or a YAML block
 * (`description: >` or `|`) on the indented lines after it. Other keys (allowed-tools…) are left as they are.
 */
export function parseSkill(content: string): SkillMeta {
  const front = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!front) {
    throw new HiveError("bad_request", "A skill starts with front matter: ---, name: <name>, description: <when to use it>, ---.", { key: "errors.skillFrontMatter" });
  }
  const lines = front[1]!.split(/\r?\n/);
  const fields = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const field = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]!);
    if (!field) continue;
    let value = field[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) block.push(lines[++i]!.trim());
      value = block.join(value.startsWith(">") ? " " : "\n").trim();
    }
    fields.set(field[1]!, unquote(value));
  }
  const name = fields.get("name") ?? "";
  const description = (fields.get("description") ?? "").trim();
  if (!SKILL_NAME.test(name)) {
    throw new HiveError("bad_request", `Skill name "${name}": use lowercase letters, digits and "-" (at most 64).`, { key: "errors.skillName", vars: { name } });
  }
  if (!description || description.length > SKILL_DESCRIPTION_MAX) {
    throw new HiveError("bad_request", `A skill needs a description (at most ${SKILL_DESCRIPTION_MAX} characters): agents pick skills by it.`, {
      key: "errors.skillDescription",
      vars: { max: SKILL_DESCRIPTION_MAX },
    });
  }
  return { name, description };
}
