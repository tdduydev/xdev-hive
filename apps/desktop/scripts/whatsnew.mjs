import { execFileSync } from "node:child_process";

function items(markdown) {
  const result = new Map();
  const parents = [];
  let heading = "Tính năng";
  for (const line of markdown.split(/\r?\n/)) {
    const section = /^##\s+(.+)/.exec(line);
    if (section) { heading = section[1]; parents.length = 0; }
    const entry = /^(\s*)-\s+(?:\[([ xX])\]\s+)?\*\*([^*]+)\*\*(.*)/.exec(line);
    if (!entry) continue;
    const [, indent, checked, title, detail] = entry;
    const id = /^(\d+[\w-]*)\./.exec(title)?.[1];
    if (!id) continue;
    while (parents.length && parents.at(-1).indent >= indent.length) parents.pop();
    result.set(id, { done: checked?.toLowerCase() === "x", title, detail, group: parents[0]?.title ?? heading });
    parents.push({ indent: indent.length, title });
  }
  return result;
}

export function generateWhatsNew(repoRoot, tag) {
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  // Ignore tags on unrelated branches and the current tag when re-uploading to the hub.
  const previous = git("tag", "--merged", "HEAD", "--list", "v*", "--sort=-v:refname")
    .split("\n").find((value) => value && value !== tag);
  const before = items(previous ? git("show", `${previous}:docs/roadmap.md`) : "");
  const after = items(git("show", "HEAD:docs/roadmap.md"));
  const groups = new Map();
  for (const [id, item] of after) {
    if (!item.done || before.get(id)?.done) continue;
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(`- **${item.title}**${item.detail}`);
  }
  const fixes = git("log", "--format=%s", previous ? `${previous}..HEAD` : "HEAD")
    .split("\n").filter((subject) => /^fix(?:\([^)]*\))?!?:\s/.test(subject));
  const sections = [...groups].map(([title, entries]) => `### ${title}\n\n${entries.join("\n")}`);
  if (fixes.length) sections.push(`### Sửa lỗi\n\n${[...new Set(fixes)].map((subject) => `- ${subject}`).join("\n")}`);
  return `## Có gì mới\n\n${sections.join("\n\n") || "- Không có thay đổi mới."}\n`;
}

export function readWhatsNewOverride(args, readFile) {
  const index = args.indexOf("--whatsnew");
  if (index < 0) return undefined;
  const file = args[index + 1];
  if (!file || file.startsWith("--")) throw new Error("--whatsnew requires a file path.");
  const content = readFile(file, "utf8").trim();
  if (!content) throw new Error("--whatsnew file is empty.");
  return `${content}\n`;
}
