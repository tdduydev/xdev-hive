// A SKILL.md as the Skills page edits it: the name and description as form fields, the instructions as text, and
// whatever else the front matter holds (allowed-tools…) kept as it was.
import type { SkillSummary } from "@xdev-hive/core";
import { fold } from "#ui/lib/text.ts";

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
  overridesBy: string[];
  /** Project view: a team skill this project does not use, because it has its own of the same name. */
  overridden: boolean;
}

/**
 * The skills to list: every one for the whole team (`project` null), or what a project's agents get — its own
 * skills and the team's — with the team skills its own replace kept, marked, so the page can say why they are unused.
 */
export function skillsFor(all: SkillSummary[], project: string | null): ListedSkill[] {
  const team = new Set(all.filter((s) => s.project === null).map((s) => s.name));
  const overridesBy = (s: SkillSummary) => s.project === null ? all.filter((own) => own.project !== null && own.name === s.name).map((own) => own.project!) : [];
  if (project === null) return all.map((s) => ({ ...s, overrides: s.project !== null && team.has(s.name), overridden: false, overridesBy: overridesBy(s) }));
  const own = new Set(all.filter((s) => s.project === project).map((s) => s.name));
  const shared = new Set(all.filter((s) => s.project === null).map((s) => s.name));
  return all
    .filter((s) => s.project === project || s.project === null)
    .map((s) => ({ ...s, overridesBy: overridesBy(s).filter((p) => p === project), overrides: s.project === project && shared.has(s.name), overridden: s.project === null && own.has(s.name) }))
    .sort((a, b) => a.name.localeCompare(b.name) || Number(a.overridden) - Number(b.overridden));
}

/** The chat leader's guide (roadmap 17c-2), edited per project on the Chat page (17i-1). */
export const LEADER_SKILL = "hive-leader";

/**
 * What the leader of a project reads, for the editor: the project's own guide when it has one, else the team's, else
 * an empty one to start from. `from` says which, and the version to save against is the project's (0: a new one).
 */
export function leaderGuide(
  own: { content: string; version: number } | null,
  team: { content: string } | null,
): { parts: SkillParts; from: "project" | "team" | "none"; baseVersion: number } {
  const source = own ?? team;
  const parts = source ? splitSkill(source.content) : { name: LEADER_SKILL, description: "", extra: [], body: "" };
  return { parts: { ...parts, name: LEADER_SKILL }, from: own ? "project" : team ? "team" : "none", baseVersion: own?.version ?? 0 };
}

/** Missing telemetry on an older hub must not classify a skill as unused. */
export function filterSkills<T extends SkillSummary>(skills: T[], query: string, unused: boolean): T[] {
  const needle = fold(query.trim());
  return skills.filter((s) => (!unused || s.usage?.lastUsedAt === null) && (!needle || fold(`${s.name} ${s.description}`).includes(needle)));
}
