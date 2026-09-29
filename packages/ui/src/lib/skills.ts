// A SKILL.md as the Skills page edits it: the name and description as form fields, the instructions as text, and
// whatever else the front matter holds (allowed-tools…) kept as it was.
import type { SkillSummary } from "@xdev-hive/core";

export interface SkillParts {
  name: string;
  description: string;
  /** Front matter lines other than name and description, in their order. */
  extra: string[];
  /** The instructions after the front matter. */
  body: string;
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** Reads a skill for the form. Content without front matter (saved before Hive checked it) is all body. */
export function splitSkill(content: string): SkillParts {
  const front = FRONT.exec(content);
  if (!front) return { name: "", description: "", extra: [], body: content };
  const lines = front[1]!.split(/\r?\n/);
  const fields: Record<"name" | "description", string> = { name: "", description: "" };
  const extra: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const field = /^(name|description):[ \t]*(.*)$/.exec(lines[i]!);
    if (!field) {
      extra.push(lines[i]!);
      continue;
    }
    let value = field[2]!.trim();
    // A YAML block (description: > …): its indented lines belong to it.
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) block.push(lines[++i]!.trim());
      value = block.join(value.startsWith(">") ? " " : "\n").trim();
    }
    fields[field[1] as "name" | "description"] = unquote(value);
  }
  return { ...fields, extra, body: content.slice(front[0].length).replace(/^\r?\n/, "") };
}

/** A value on one line, quoted when YAML would read it as something else. */
function yamlLine(value: string): string {
  const flat = value.replace(/\s*\r?\n\s*/g, " ").trim();
  return /^$|^[\s'"[\]{}>|*&!%@`#,?-]|: | #|:$|\s$/.test(flat) ? `"${flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : flat;
}

/** The SKILL.md for the form's fields: front matter first, as Claude Code reads it. */
export function buildSkill(parts: SkillParts): string {
  const front = [`name: ${parts.name.trim()}`, `description: ${yamlLine(parts.description)}`, ...parts.extra];
  const body = parts.body.replace(/^\s*\n/, "").replace(/\s*$/, "");
  return `---\n${front.join("\n")}\n---\n\n${body}\n`;
}

export interface ListedSkill extends SkillSummary {
  /** Project view: a project skill that replaces the team's skill of the same name. */
  overrides: boolean;
  /** Project view: a team skill this project does not use, because it has its own of the same name. */
  overridden: boolean;
}

/**
 * The skills to list: every one for the whole team (`project` null), or what a project's agents get — its own
 * skills and the team's — with the team skills its own replace kept, marked, so the page can say why they are unused.
 */
export function skillsFor(all: SkillSummary[], project: string | null): ListedSkill[] {
  const plain = (s: SkillSummary): ListedSkill => ({ ...s, overrides: false, overridden: false });
  if (project === null) return all.map(plain);
  const own = new Set(all.filter((s) => s.project === project).map((s) => s.name));
  const shared = new Set(all.filter((s) => s.project === null).map((s) => s.name));
  return all
    .filter((s) => s.project === project || s.project === null)
    .map((s) => ({ ...s, overrides: s.project === project && shared.has(s.name), overridden: s.project === null && own.has(s.name) }))
    .sort((a, b) => a.name.localeCompare(b.name) || Number(a.overridden) - Number(b.overridden));
}
