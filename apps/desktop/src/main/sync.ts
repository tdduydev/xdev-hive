// Renders Hive docs into a repo (AGENTS.md, CLAUDE.md, docs/decisions.md, the docs for some paths:
// nested AGENTS.md, .claude/rules/xdev-hive/, and skills: .claude/skills/<name>/SKILL.md) and commits only those files.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  agentsDocKey,
  decisionsDocKey,
  ensureClaudeImport,
  HiveError,
  MANAGED_START,
  planProjectSync,
  RULES_DIR,
  SKILLS_DIR,
  stripManaged,
  withManagedBlock,
  type Actor,
  type DesktopProject,
  type Doc,
  type FileAction,
  type HiveBackend,
  type SyncReport,
} from "@xdev-hive/core";
import { git, gitErrorText, isGitRepo } from "./git.ts";
import { tr } from "./i18n.ts";

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);

/** AGENTS.md longer than this gets a note: move parts of it into docs for some paths. */
const LONG_AGENTS_LINES = 200;

/** Files a sync wrote for docs of some paths (nested AGENTS.md with a managed block, our rules) and for skills. */
function managedFiles(repo: string, gitRepo: boolean): string[] {
  const out: string[] = [];
  if (gitRepo) {
    // Tracked or not yet (sync without auto-commit), but never ignored ones such as node_modules.
    const listed = git(repo, ["ls-files", "-co", "--exclude-standard", "--", ":(glob)**/AGENTS.md"]).split("\n").filter(Boolean);
    for (const f of listed) if (f !== "AGENTS.md" && read(path.join(repo, f))?.includes(MANAGED_START)) out.push(f);
  }
  const walk = (dir: string) => {
    for (const e of readdirSync(path.join(repo, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".md")) out.push(rel);
    }
  };
  if (existsSync(path.join(repo, RULES_DIR))) walk(RULES_DIR);
  // A skill folder is Hive's when its SKILL.md has the managed block; the repo's own skills stay.
  if (existsSync(path.join(repo, SKILLS_DIR))) {
    for (const e of readdirSync(path.join(repo, SKILLS_DIR), { withFileTypes: true })) {
      const file = `${SKILLS_DIR}/${e.name}/SKILL.md`;
      if (e.isDirectory() && read(path.join(repo, file))?.includes(MANAGED_START)) out.push(file);
    }
  }
  return out;
}

const isSkillFile = (f: string) => f.startsWith(`${SKILLS_DIR}/`);

const defaultAgentsDoc = (project: string) => `# ${project}

Mô tả ngắn dự án, lệnh build/test/lint, cấu trúc thư mục và quy ước riêng của repo này.
`;

export async function syncProject(
  backend: HiveBackend,
  actor: Actor,
  project: DesktopProject,
  opts: { autoCommit: boolean },
): Promise<SyncReport> {
  const { name, repo } = project;
  if (!existsSync(repo)) throw new HiveError("not_found", `Không thấy thư mục repo: ${repo}`, { key: "errors.noFolder", vars: { path: repo } });
  const gitRepo = isGitRepo(repo);
  const notes: string[] = [];
  const imported: string[] = [];

  // First sync keeps what the repo already has by importing it into Hive.
  const seeds: Array<[key: string, file: string]> = [
    [agentsDocKey(name), "AGENTS.md"],
    [decisionsDocKey(name), "docs/decisions.md"],
  ];
  for (const [key, file] of seeds) {
    if (await backend.call("docs.get", { key }, actor)) continue;
    const existing = read(path.join(repo, file));
    const content = existing ? stripManaged(existing).trim() : file === "AGENTS.md" ? defaultAgentsDoc(name) : null;
    if (!content) continue;
    try {
      await backend.call("docs.save", { key, content, baseVersion: 0, note: existing ? `Imported from ${file}` : "Created by xDev Hive" }, actor);
      imported.push(key);
    } catch (err) {
      if (!(err instanceof HiveError && err.code === "forbidden")) throw err;
      notes.push(tr("syncNote.needAdmin", { key }));
    }
  }

  const summaries = await backend.call("docs.list", { project: name }, actor);
  const docs = (await Promise.all(summaries.map((s) => backend.call("docs.get", { key: s.key }, actor)))).filter(
    (d): d is Doc => d !== null,
  );
  const hasAgentsDoc = docs.some((d) => d.key === agentsDocKey(name));
  const planned = planProjectSync(name, docs).map((f) => (f.block ? { ...f, content: withManagedBlock(read(path.join(repo, f.path)), f.content) } : f));
  const files: Array<{ path: string; content: string | null }> = [
    ...planned,
    { path: "CLAUDE.md", content: ensureClaudeImport(read(path.join(repo, "CLAUDE.md"))) },
  ];
  // A doc whose paths changed or went away: take our block out of the file (the rest stays), or remove the file.
  const wanted = new Set(files.map((f) => f.path));
  for (const f of managedFiles(repo, gitRepo)) {
    if (wanted.has(f)) continue;
    const rest = f.startsWith(`${RULES_DIR}/`) || isSkillFile(f) ? "" : stripManaged(read(path.join(repo, f)) ?? "").trim();
    files.push({ path: f, content: rest ? `${rest}\n` : null });
  }
  const agentsLines = planned[0]!.content.split("\n").length;
  if (agentsLines > LONG_AGENTS_LINES) notes.push(tr("syncNote.longAgents", { lines: agentsLines, max: LONG_AGENTS_LINES }));

  const actions: FileAction[] = [];
  const changed: string[] = [];
  for (const f of files) {
    const abs = path.join(repo, f.path);
    const before = read(abs);
    if (before === f.content) {
      actions.push({ file: f.path, action: "unchanged" });
      continue;
    }
    if (f.path === "AGENTS.md" && !hasAgentsDoc && before && !before.includes(MANAGED_START)) {
      actions.push({ file: f.path, action: "skipped", note: tr("fileNote.notInHive") });
      continue;
    }
    // The repo has its own skill of that name: it stays, and Hive's does not go in.
    if (isSkillFile(f.path) && before !== null && !before.includes(MANAGED_START)) {
      actions.push({ file: f.path, action: "skipped", note: tr("fileNote.ownSkill") });
      continue;
    }
    // With auto-commit, every earlier sync was committed, so a dirty file means someone edited it by hand.
    if (opts.autoCommit && gitRepo && before !== null && /^(.M|M)/.test(git(repo, ["status", "--porcelain", "--", f.path]))) {
      actions.push({ file: f.path, action: "skipped", note: tr("fileNote.uncommitted") });
      continue;
    }
    if (f.content === null) {
      // Only a tracked file's removal can be committed; an untracked one just goes.
      if (gitRepo && git(repo, ["ls-files", "--", f.path])) changed.push(f.path);
      rmSync(abs, { force: true });
      // The skill's folder too, when nothing else is in it.
      if (isSkillFile(f.path)) {
        try {
          rmdirSync(path.dirname(abs));
        } catch {
          // not empty: the repo keeps what else it had there
        }
      }
      actions.push({ file: f.path, action: "removed" });
      continue;
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    actions.push({ file: f.path, action: before === null ? "created" : "updated" });
    changed.push(f.path);
  }

  let commit: string | null = null;
  if (changed.length && opts.autoCommit) {
    if (!gitRepo) {
      notes.push(tr("syncNote.notGitRepo"));
    } else {
      try {
        git(repo, ["add", "--", ...changed]);
        git(repo, ["commit", "-m", "docs(xdev-hive): sync shared docs", "--", ...changed], { HIVE_ADMIN: "1" });
        commit = git(repo, ["rev-parse", "--short", "HEAD"]);
      } catch (err) {
        notes.push(tr("syncNote.commitFailed", { reason: gitErrorText(err) }));
      }
    }
  }

  return { project: name, files: actions, imported, commit, note: notes.join(" · ") || undefined };
}
