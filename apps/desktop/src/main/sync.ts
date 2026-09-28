// Renders Hive docs into a repo (AGENTS.md, CLAUDE.md, docs/decisions.md) and commits only those files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  agentsDocKey,
  decisionsDocKey,
  ensureClaudeImport,
  HiveError,
  MANAGED_START,
  planProjectSync,
  stripManaged,
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
  const files = [
    ...planProjectSync(name, docs),
    { path: "CLAUDE.md", content: ensureClaudeImport(read(path.join(repo, "CLAUDE.md"))) },
  ];

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
    // With auto-commit, every earlier sync was committed, so a dirty file means someone edited it by hand.
    if (opts.autoCommit && gitRepo && before !== null && /^(.M|M)/.test(git(repo, ["status", "--porcelain", "--", f.path]))) {
      actions.push({ file: f.path, action: "skipped", note: tr("fileNote.uncommitted") });
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
