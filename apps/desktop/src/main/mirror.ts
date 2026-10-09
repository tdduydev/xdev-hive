// The repo's docs into Hive (roadmap 26): `.xdev-hive/docs.json` on the project's target branch says which file is
// which page (see core mirror.ts). Reads the branch as committed and fetched, never the checkout, so what someone is
// still writing does not go out; a page whose text, title or place differs gets a new version naming the commit.
import { HiveError, MIRROR_CONFIG, parseMirrorConfig, planMirror, type Actor, type DesktopProject, type HiveBackend, type MirrorReport } from "@xdev-hive/core";
import { git, gitErrorText, gitOutputAsync, isGitRepo, isGitRepoAsync } from "./git.ts";
import { remoteStart } from "./runner/worktree.ts";

const show = (repo: string, ref: string, file: string): string | null => {
  try {
    return git(repo, ["show", `${ref}:${file}`]);
  } catch {
    return null;
  }
};
const showAsync = (repo: string, ref: string, file: string): Promise<string | null> =>
  gitOutputAsync(repo, ["show", `${ref}:${file}`]).catch(() => null);

/** Whether the checkout has a mirror config at all: no fetch for projects that do not mirror. */
export const mirrors = (repo: string): boolean => isGitRepo(repo) && show(repo, "HEAD", MIRROR_CONFIG) !== null;
export const mirrorsAsync = async (repo: string): Promise<boolean> => (await isGitRepoAsync(repo)) && (await showAsync(repo, "HEAD", MIRROR_CONFIG)) !== null;

/** `since`: the commit mirrored last time; the same one again is not read twice. */
export async function mirrorDocs(backend: HiveBackend, actor: Actor, project: DesktopProject, opts: { fetch?: boolean; since?: string } = {}): Promise<MirrorReport> {
  const report: MirrorReport = { commit: null, changed: [], unchanged: 0, missing: [], skipped: [] };
  if (!(await isGitRepoAsync(project.repo))) return report;
  const ref = (opts.fetch === false ? null : (await remoteStart(project.repo, project.targetBranch)).ref) ?? "HEAD";
  const config = await showAsync(project.repo, ref, MIRROR_CONFIG);
  if (config === null) return report;
  report.commit = await gitOutputAsync(project.repo, ["rev-parse", "--short", `${ref}^{commit}`]);
  if (opts.since && opts.since === report.commit) return report;
  const files = parseMirrorConfig(config);
  const contents = new Map<string, string | null>();
  for (const file of new Set(files.map((p) => p.file))) contents.set(file, await showAsync(project.repo, ref, file));
  const { pages, missing } = planMirror(files, (file) => contents.get(file) ?? null);
  report.missing = missing;
  const key = (slug: string) => `project/${project.name}/${slug}`;
  // Folders first: a section's page goes under one that must be there.
  for (const p of [...pages].sort((a, b) => Number(b.folder) - Number(a.folder))) {
    const k = key(p.slug);
    const parent = p.parent ? key(p.parent) : null;
    const mirror = { from: p.from, commit: report.commit };
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await backend.call("docs.get", { key: k }, actor);
      // A folder's own text stays as Hive has it, unless the config gives it the file's intro.
      const content = p.content ?? cur?.content ?? "";
      if (cur && cur.content === content && cur.title === p.title && cur.parent === parent && cur.folder === p.folder && cur.mirror?.from === p.from) {
        report.unchanged++;
        break;
      }
      try {
        await backend.call(
          "docs.save",
          { key: k, title: p.title, content, parent, folder: p.folder, baseVersion: cur?.version ?? 0, note: `Từ repo ${p.from} @ ${report.commit}`, mirror },
          actor,
        );
        report.changed.push(k);
        break;
      } catch (err) {
        // Another machine mirrored it in between: read it again once.
        if (err instanceof HiveError && err.code === "conflict" && attempt === 0) continue;
        if (err instanceof HiveError && (err.code === "forbidden" || err.code === "not_found" || err.code === "bad_request")) {
          report.skipped.push({ key: k, reason: err.message });
          break;
        }
        throw new HiveError("unavailable", `${k}: ${gitErrorText(err)}`, { key: "errors.mirrorFailed", vars: { key: k, reason: (err as Error).message } });
      }
    }
  }
  return report;
}
