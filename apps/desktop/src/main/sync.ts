// Renders Hive docs into a repo (AGENTS.md, CLAUDE.md, docs/decisions.md, the docs for some paths:
// nested AGENTS.md, .claude/rules/xdev-hive/, and skills: .claude/skills/<name>/SKILL.md) and commits only those files.
//
// Two ways in (roadmap 38c), both from the same render:
//   commit mode: writes into the checkout and commits there (a repo with no forge to open an MR on)
//   mr mode:     writes into a worktree of its own, started at origin/<target branch>, and opens a merge request
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AGENTS_MD_LINES,
  agentsDocKey,
  CONTEXT_AGENTS_FILE,
  decisionsDocKey,
  ensureClaudeImport,
  HiveError,
  MANAGED_START,
  parseSkill,
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
  type Proposal,
  type SyncMr,
  type SyncReport,
} from "@xdev-hive/core";
import { contextWorktree, remoteStart } from "#desktop/main/runner/worktree.ts";
import { git, gitErrorText, isGitRepo } from "./git.ts";
import { tr } from "./i18n.ts";

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);

/** AGENTS.md longer than this gets a note: move parts of it into docs for some paths. */
const LONG_AGENTS_LINES = AGENTS_MD_LINES;

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

/** The project's pages, as a sync and a run both need them. */
async function loadDocs(backend: HiveBackend, actor: Actor, project: string): Promise<Doc[]> {
  const summaries = await backend.call("docs.list", { project }, actor);
  return (await Promise.all(summaries.map((s) => backend.call("docs.get", { key: s.key }, actor)))).filter((d): d is Doc => d !== null);
}

/**
 * Why the repo's own AGENTS.md stays, or null when Hive may write it (roadmap 38a, 38f). Without Hive's block the
 * file is the repo's, unless it says word for word what the hub page says: then the page already holds it and
 * rendering only wraps it in the block, so nothing of the repo is lost. A run's worktree, the project sync and the
 * context MR all ask here, so the three of them leave the same file alone.
 */
function ownAgentsNote(before: string | null, agentsDoc: Doc | null): string | null {
  if (before === null || before.includes(MANAGED_START)) return null;
  if (stripManaged(before).trim() === (agentsDoc?.content.trim() ?? "")) return null;
  return tr(agentsDoc ? "fileNote.ownAgents" : "fileNote.notInHive", { file: CONTEXT_AGENTS_FILE });
}

export interface ContextPlan {
  files: Array<{ path: string; content: string }>;
  /** A file the repo owns, left as it is, and why. */
  skipped: Array<{ file: string; note: string }>;
  /** Hive's AGENTS.md went here because the repo keeps its own; null when AGENTS.md itself holds it. */
  contextFile: string | null;
}

/**
 * What Hive's context looks like in `dir`, with the rule that keeps what the repo wrote itself: an AGENTS.md (the
 * main one or a nested one) or a skill already there without the managed block belongs to the repo, so it stays.
 * When the main AGENTS.md stays, Hive's goes to CONTEXT_AGENTS_FILE and CLAUDE.md imports both, so the agent still
 * reads the team's conventions. Shared by the runner (roadmap 38a), the project sync and the context MR, so the
 * three of them leave the same files alone.
 */
export function planContext(project: string, docs: Doc[], dir: string): ContextPlan {
  const at = (f: string) => read(path.join(dir, f));
  const repoOwns = (f: string) => {
    const before = at(f);
    return before !== null && !before.includes(MANAGED_START);
  };
  const agentsDoc = docs.find((d) => d.key === agentsDocKey(project)) ?? null;
  const files: Array<{ path: string; content: string }> = [];
  const skipped: ContextPlan["skipped"] = [];
  let contextFile: string | null = null;
  for (const f of planProjectSync(project, docs)) {
    const ownAgents = f.path === "AGENTS.md" ? ownAgentsNote(at(f.path), agentsDoc) : null;
    if (ownAgents) {
      contextFile = CONTEXT_AGENTS_FILE;
      skipped.push({ file: f.path, note: ownAgents });
      files.push({ path: CONTEXT_AGENTS_FILE, content: f.content });
      continue;
    }
    if ((f.block || isSkillFile(f.path)) && repoOwns(f.path)) {
      skipped.push({ file: f.path, note: tr(f.block ? "fileNote.ownNestedAgents" : "fileNote.ownSkill") });
      continue;
    }
    files.push({ path: f.path, content: f.block ? withManagedBlock(at(f.path), f.content) : f.content });
  }
  files.push({ path: "CLAUDE.md", content: ensureClaudeImport(at("CLAUDE.md"), contextFile ? [contextFile] : []) });
  return { files, skipped, contextFile };
}

export interface WorktreeSkill {
  name: string;
  description: string;
  path: string;
}

export interface WorktreeRule {
  globs: string[];
  path: string;
}

/** Parses path globs from a Claude Code rule's YAML frontmatter (paths: [...] or indented list). */
export function parseRulePaths(frontmatter: string): string[] {
  const globs: string[] = [];
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^[ \t]*paths:[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[1]!.trim();
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const items = rest.slice(1, -1).match(/(?:[^\s,"']+|"[^"]*"|'[^']*')+/g) ?? [];
      for (const item of items) {
        const clean = item.replace(/^["']|["']$/g, "").trim();
        if (clean) globs.push(clean);
      }
    } else if (rest && !rest.startsWith("#")) {
      const clean = rest.replace(/^["']|["']$/g, "").trim();
      if (clean) globs.push(clean);
    } else {
      while (i + 1 < lines.length && /^[ \t]+-[ \t]+/.test(lines[i + 1]!)) {
        i++;
        const item = lines[i]!.replace(/^[ \t]+-[ \t]+/, "").trim();
        const clean = item.replace(/^["']|["']$/g, "").trim();
        if (clean) globs.push(clean);
      }
    }
  }
  return globs;
}

/**
 * Reads skills available in `dir` (.claude/skills/<name>/SKILL.md), both Hive's and the repo's own.
 * Runs cannot rely on Claude Code loading them because --setting-sources user leaves project skills out.
 */
export function loadWorktreeSkills(dir: string): WorktreeSkill[] {
  if (!dir || !existsSync(dir)) return [];
  const skillsDir = path.join(dir, SKILLS_DIR);
  if (!existsSync(skillsDir)) return [];
  const out: WorktreeSkill[] = [];
  try {
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const file = path.join(skillsDir, e.name, "SKILL.md");
      if (!existsSync(file)) continue;
      const content = read(file);
      if (!content) continue;
      let name = e.name;
      let description = "";
      try {
        const meta = parseSkill(content);
        name = meta.name || e.name;
        description = meta.description.replace(/\s+/g, " ");
      } catch {
        const front = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
        if (front) {
          const mName = /^[ \t]*name:[ \t]*(.*)$/m.exec(front[1]!);
          if (mName) name = mName[1]!.replace(/^["']|["']$/g, "").trim() || e.name;
          const mDesc = /^[ \t]*description:[ \t]*(.*)$/m.exec(front[1]!);
          if (mDesc) description = mDesc[1]!.replace(/^["']|["']$/g, "").trim().replace(/\s+/g, " ");
        }
      }
      out.push({
        name,
        description,
        path: `${SKILLS_DIR}/${e.name}/SKILL.md`,
      });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Reads rules in `dir` (.claude/rules/**\/*.md), extracting their path globs from frontmatter.
 * Claude Code with --setting-sources user does not load repo rules; the prompt lists them so agents read them.
 */
export function loadWorktreeRules(dir: string): WorktreeRule[] {
  if (!dir || !existsSync(dir)) return [];
  const baseRules = path.join(dir, ".claude/rules");
  if (!existsSync(baseRules)) return [];
  const out: WorktreeRule[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        const content = read(full);
        if (!content) continue;
        const front = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
        const globs = front ? parseRulePaths(front[1]!) : [];
        const rel = path.relative(dir, full).replace(/\\/g, "/");
        out.push({
          globs: globs.length ? globs : ["*"],
          path: rel,
        });
      }
    }
  };
  try {
    walk(baseRules);
  } catch {
    return [];
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export interface ContextRender extends ContextPlan {
  /** Repo-relative files Hive owns in `dir` now: they must stay out of the branch. */
  owned: string[];
  /** Of those, the ones this call had to write; the rest were already right. */
  written: string[];
  /** Skills present in `dir` (.claude/skills), to be named in the run prompt (roadmap 38i). */
  skills: WorktreeSkill[];
  /** Rules present in `dir` (.claude/rules), to be named in the run prompt (roadmap 38i). */
  rules: WorktreeRule[];
}

/** A run must not wait on a slow hub: past this it goes on with the files the branch has. */
export const CONTEXT_TIMEOUT_MS = 30_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(tr("runNote.contextTimeout", { seconds: Math.round(ms / 1000) }))), ms);
    // A pending timer must not keep the process (or a test) alive once the docs are in.
    timer.unref?.();
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * Writes the project's Hive context into `dir` (a run's worktree, roadmap 38a): AGENTS.md and the nested ones,
 * CLAUDE.md with the import, the rules and the skills. Nothing is committed and nothing is removed: the caller
 * keeps `owned` out of its commit. Throws when the hub fails or is slower than `timeoutMs`; the run goes on then.
 */
export async function renderContext(
  backend: HiveBackend,
  actor: Actor,
  project: string,
  dir: string,
  timeoutMs = CONTEXT_TIMEOUT_MS,
): Promise<ContextRender> {
  const docs = await withTimeout(loadDocs(backend, actor, project), timeoutMs);
  const plan = planContext(project, docs, dir);
  const written: string[] = [];
  for (const f of plan.files) {
    const abs = path.join(dir, f.path);
    if (read(abs) === f.content) continue;
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    written.push(f.path);
  }
  const skills = loadWorktreeSkills(dir);
  const rules = loadWorktreeRules(dir);
  return { ...plan, owned: plan.files.map((f) => f.path), written, skills, rules };
}

const defaultAgentsDoc = (project: string) => `# ${project}

Mô tả ngắn dự án, lệnh build/test/lint, cấu trúc thư mục và quy ước riêng của repo này.
`;

interface Applied {
  files: FileAction[];
  /** Repo-relative paths written or removed, for the commit. */
  changed: string[];
  imported: string[];
  notes: string[];
  ownAgents: boolean;
}

/**
 * Renders the project's pages into `dir` and says what it did there; the caller commits. `dir` is the user's
 * checkout in commit mode and the docs worktree in MR mode (roadmap 38c), so the first import reads whichever of
 * the two the sync works on: in MR mode that is origin/<target branch>, never a checkout someone is working in.
 * `keepHandEdits`: leave a file someone edited since the last sync alone — only true of a checkout, since the
 * docs worktree is restarted from the remote and has no hand edits to lose.
 */
async function applySync(backend: HiveBackend, actor: Actor, name: string, dir: string, opts: { keepHandEdits: boolean }): Promise<Applied> {
  const gitRepo = isGitRepo(dir);
  const notes: string[] = [];
  const imported: string[] = [];

  // First sync keeps what the repo already has by importing it into Hive.
  const seeds: Array<[key: string, file: string]> = [
    [agentsDocKey(name), "AGENTS.md"],
    [decisionsDocKey(name), "docs/decisions.md"],
  ];
  for (const [key, file] of seeds) {
    if (await backend.call("docs.get", { key }, actor)) continue;
    const existing = read(path.join(dir, file));
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

  const docs = await loadDocs(backend, actor, name);
  const agentsDoc = docs.find((d) => d.key === agentsDocKey(name)) ?? null;
  const planned = planProjectSync(name, docs).map((f) => (f.block ? { ...f, content: withManagedBlock(read(path.join(dir, f.path)), f.content) } : f));
  // planProjectSync always puts AGENTS.md first; after it come the nested AGENTS.md, the rules and the skills.
  const hiveAgents = planned[0]!;
  // The repo wrote its own AGENTS.md (roadmap 38f): it stays, and Hive's part goes beside it with CLAUDE.md
  // importing both, exactly as a run's worktree gets it, so an agent still reads the team's conventions.
  const ownAgents = ownAgentsNote(read(path.join(dir, "AGENTS.md")), agentsDoc);
  const files: Array<{ path: string; content: string | null }> = [
    ownAgents ? { path: CONTEXT_AGENTS_FILE, content: hiveAgents.content } : hiveAgents,
    ...planned.slice(1),
    { path: "CLAUDE.md", content: ensureClaudeImport(read(path.join(dir, "CLAUDE.md")), ownAgents ? [CONTEXT_AGENTS_FILE] : []) },
  ];
  // The repo gave up its own AGENTS.md: the copy beside it is stale and CLAUDE.md no longer imports it.
  if (!ownAgents && existsSync(path.join(dir, CONTEXT_AGENTS_FILE))) files.push({ path: CONTEXT_AGENTS_FILE, content: null });
  // A doc whose paths changed or went away: take our block out of the file (the rest stays), or remove the file.
  const wanted = new Set(files.map((f) => f.path));
  for (const f of managedFiles(dir, gitRepo)) {
    if (wanted.has(f)) continue;
    const rest = f.startsWith(`${RULES_DIR}/`) || isSkillFile(f) ? "" : stripManaged(read(path.join(dir, f)) ?? "").trim();
    files.push({ path: f, content: rest ? `${rest}\n` : null });
  }
  const agentsLines = hiveAgents.content.split("\n").length;
  if (agentsLines > LONG_AGENTS_LINES) notes.push(tr("syncNote.longAgents", { lines: agentsLines, max: LONG_AGENTS_LINES }));

  const actions: FileAction[] = [];
  const changed: string[] = [];
  if (ownAgents) actions.push({ file: "AGENTS.md", action: "skipped", note: ownAgents });
  for (const f of files) {
    const abs = path.join(dir, f.path);
    const before = read(abs);
    if (before === f.content) {
      actions.push({ file: f.path, action: "unchanged" });
      continue;
    }
    // The repo has its own skill of that name: it stays, and Hive's does not go in.
    if (isSkillFile(f.path) && before !== null && !before.includes(MANAGED_START)) {
      actions.push({ file: f.path, action: "skipped", note: tr("fileNote.ownSkill") });
      continue;
    }
    // With auto-commit, every earlier sync was committed, so a dirty file means someone edited it by hand.
    if (opts.keepHandEdits && gitRepo && before !== null && /^(.M|M)/.test(git(dir, ["status", "--porcelain", "--", f.path]))) {
      actions.push({ file: f.path, action: "skipped", note: tr("fileNote.uncommitted") });
      continue;
    }
    if (f.content === null) {
      // Only a tracked file's removal can be committed; an untracked one just goes.
      if (gitRepo && git(dir, ["ls-files", "--", f.path])) changed.push(f.path);
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

  return { files: actions, changed, imported, notes, ownAgents: ownAgents !== null };
}

const SYNC_MESSAGE = "docs(xdev-hive): sync shared docs";

/** The branch and the worktree a sync in MR mode uses, one per project (roadmap 38c). */
export const CONTEXT_BRANCH = "chore/xdev-hive-context";
export const CONTEXT_WORKTREE = "_hive-context";

/** Commits what the sync wrote in `dir`, on its own; the agent's work, if any, is not ours to commit. */
function commitSync(dir: string, changed: string[], notes: string[]): string | null {
  try {
    git(dir, ["add", "--", ...changed]);
    git(dir, ["commit", "-m", SYNC_MESSAGE, "--", ...changed], { HIVE_ADMIN: "1" });
    return git(dir, ["rev-parse", "--short", "HEAD"]);
  } catch (err) {
    notes.push(tr("syncNote.commitFailed", { reason: gitErrorText(err) }));
    return null;
  }
}

/** Pushes the docs branch and opens or updates its merge request; the desktop passes MergeRequester.openContext. */
export type ContextMrOpener = (project: DesktopProject, branch: string) => Promise<SyncMr>;

export interface SyncOptions {
  autoCommit: boolean;
  /**
   * MR mode (roadmap 38c): the folder the docs worktree goes under, and how its branch becomes a merge request.
   * Left out for a project with no forge to open one on, which then syncs into the checkout as before.
   */
  mr?: { worktreeRoot: string; open: ContextMrOpener };
}

export async function syncProject(backend: HiveBackend, actor: Actor, project: DesktopProject, opts: SyncOptions): Promise<SyncReport> {
  const { name, repo } = project;
  if (!existsSync(repo)) throw new HiveError("not_found", `Không thấy thư mục repo: ${repo}`, { key: "errors.noFolder", vars: { path: repo } });
  if (opts.mr) return syncViaMr(backend, actor, project, opts.mr);

  const gitRepo = isGitRepo(repo);
  const applied = await applySync(backend, actor, name, repo, { keepHandEdits: opts.autoCommit && gitRepo });
  const notes = applied.notes;
  let commit: string | null = null;
  if (applied.changed.length && opts.autoCommit) {
    if (gitRepo) commit = commitSync(repo, applied.changed, notes);
    else notes.push(tr("syncNote.notGitRepo"));
  }
  return { project: name, files: applied.files, imported: applied.imported, commit, ownAgents: applied.ownAgents, note: notes.join(" · ") || undefined };
}

/**
 * The same sync as a merge request (roadmap 38c): the docs are rendered in a worktree of this project's own,
 * started at the target branch as the remote has it now, so the checkout the user works in keeps its branch and
 * its unfinished files — and so a run, which reads its context from the target branch, gets the docs once the MR
 * is merged. Nothing different from that branch means nothing to review: no push and no merge request then.
 */
async function syncViaMr(backend: HiveBackend, actor: Actor, project: DesktopProject, mr: { worktreeRoot: string; open: ContextMrOpener }): Promise<SyncReport> {
  const { name, repo } = project;
  const start = await remoteStart(repo, project.targetBranch ?? undefined);
  if (!start.ref) {
    // Without the target branch the sync would build on a checkout that may be days behind: it stops instead.
    const reason = start.error ?? tr("syncNote.notGitRepo");
    throw new HiveError("bad_request", `Không lấy được nhánh đích của ${name}: ${reason}`, { key: "errors.contextFetch", vars: { project: name, reason } });
  }
  const dir = path.join(mr.worktreeRoot, name, CONTEXT_WORKTREE);
  contextWorktree(repo, dir, CONTEXT_BRANCH, start.ref);

  const applied = await applySync(backend, actor, name, dir, { keepHandEdits: false });
  const notes = applied.notes;
  const report: SyncReport = {
    project: name,
    files: applied.files,
    imported: applied.imported,
    commit: null,
    ownAgents: applied.ownAgents,
  };
  if (!applied.changed.length) {
    notes.push(tr("syncNote.mrUpToDate", { branch: start.ref.replace("refs/remotes/", "") }));
    return { ...report, note: notes.join(" · ") || undefined };
  }
  report.commit = commitSync(dir, applied.changed, notes);
  // A commit that failed left nothing to push: say so instead of opening an empty merge request.
  if (report.commit) report.mr = await mr.open(project, CONTEXT_BRANCH);
  return { ...report, note: notes.join(" · ") || undefined };
}

/**
 * Sends the repo's own AGENTS.md to Hive as a proposal (roadmap 38f), for someone with the Context agent right to
 * review: the file and the page stop drifting apart without a sync overwriting either. Against the version of the
 * page read right now, so a page someone else just changed is not silently replaced.
 */
export async function proposeAgents(backend: HiveBackend, actor: Actor, project: DesktopProject): Promise<Proposal> {
  const { name, repo } = project;
  const content = stripManaged(read(path.join(repo, "AGENTS.md")) ?? "").trim();
  if (!content) throw new HiveError("not_found", `Repo ${repo} chưa có AGENTS.md`, { key: "errors.noAgentsFile", vars: { path: repo } });
  const key = agentsDocKey(name);
  const doc = await backend.call("docs.get", { key }, actor);
  // The reason is team data a reviewer reads on the hub, so it stays as it is, like the import note above.
  return backend.call("proposals.create", { docKey: key, baseVersion: doc?.version ?? 0, content, reason: "Imported from AGENTS.md in the repo" }, actor);
}
