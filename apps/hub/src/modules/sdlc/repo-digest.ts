import type { GitProvider, RepoRef } from "../scm/index.ts";

/*
 * Tóm tắt repo tham gia cho run soạn của hạng mục nhiều dự án (FR-066): run chỉ checkout repo dự án chính, nên agent
 * biết các repo khác qua file tóm tắt seed vào worktree. Chỉ đọc qua API Git của hub, không clone.
 */

/** Giới hạn mỗi repo; phần vượt bị cắt kèm ghi chú để agent biết còn thiếu. */
export const DIGEST_MAX_CHARS = 50_000;
const README_MAX = 8_000;
const MANIFEST_MAX = 4_000;
const CONTRACT_MAX = 6_000;
const MAX_CONTRACTS = 5;

const MANIFESTS = [
  "package.json",
  "pnpm-workspace.yaml",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
];
const README = /^readme(\.md|\.markdown|\.txt)?$/i;
// Contract có sẵn: định nghĩa API mà repo khác có thể phải theo.
const CONTRACT = /(^|\/)(openapi|swagger|asyncapi)[^/]*\.(ya?ml|json)$|\.proto$|\.graphqls?$|(^|\/)contracts\/[^/]+$/i;

/** Cây thư mục tới độ sâu 2: thư mục cấp 1 kèm số file, file ở gốc. */
export function treeOf(files: readonly string[]): string {
  const dirs = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  const root: string[] = [];
  for (const f of files) {
    const parts = f.split("/");
    if (parts.length === 1) {
      root.push(f);
      continue;
    }
    const top = parts[0] ?? "";
    counts.set(top, (counts.get(top) ?? 0) + 1);
    const second = parts.length > 2 ? `${parts[1]}/` : (parts[1] ?? "");
    const set = dirs.get(top) ?? new Set<string>();
    set.add(second);
    dirs.set(top, set);
  }
  const lines: string[] = [];
  for (const [dir, children] of [...dirs].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${dir}/ (${counts.get(dir)} file)`);
    const list = [...children].sort();
    for (const c of list.slice(0, 30)) lines.push(`  ${c}`);
    if (list.length > 30) lines.push(`  … và ${list.length - 30} mục khác`);
  }
  for (const f of root.sort()) lines.push(f);
  return lines.join("\n");
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n… (đã cắt, còn ${text.length - max} ký tự)` : text;

export interface DigestInput {
  provider: GitProvider;
  repo: RepoRef;
  projectKey: string;
  branch: string;
}

const cache = new Map<string, string>();
const CACHE_MAX = 200;

/**
 * Markdown tóm tắt một repo: cây 2 cấp, README, manifest gói, contract có sẵn. Cache theo SHA đầu nhánh vì nhiều bước
 * của cùng hạng mục đọc lại cùng repo; SHA đổi thì tóm tắt mới. null: nhánh chưa có commit.
 */
export async function repoDigest(input: DigestInput): Promise<string | null> {
  const sha = await input.provider.branchHead(input.repo, input.branch);
  if (!sha) return null;
  const cacheKey = `${input.repo.owner}/${input.repo.name}@${sha}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;

  const files = await input.provider.listFiles(input.repo, sha);
  const parts = [
    `# Repo ${input.projectKey} (${input.repo.owner}/${input.repo.name}, nhánh ${input.branch} @ ${sha.slice(0, 7)})`,
    "",
    "## Cây thư mục (2 cấp)",
    "",
    "```text",
    treeOf(files),
    "```",
  ];
  const readme = files.find((f) => README.test(f));
  if (readme) {
    const text = await input.provider.readFile(input.repo, readme, sha);
    if (text) parts.push("", `## ${readme}`, "", clip(text, README_MAX));
  }
  for (const name of MANIFESTS) {
    if (!files.includes(name)) continue;
    const text = await input.provider.readFile(input.repo, name, sha);
    if (text) parts.push("", `## ${name}`, "", "```", clip(text, MANIFEST_MAX), "```");
  }
  const contracts = files.filter((f) => CONTRACT.test(f));
  for (const path of contracts.slice(0, MAX_CONTRACTS)) {
    const text = await input.provider.readFile(input.repo, path, sha);
    if (text) parts.push("", `## Contract ${path}`, "", "```", clip(text, CONTRACT_MAX), "```");
  }
  if (contracts.length > MAX_CONTRACTS) parts.push("", `Contract khác: ${contracts.slice(MAX_CONTRACTS).join(", ")}`);
  const digest = clip(parts.join("\n"), DIGEST_MAX_CHARS);

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value ?? "");
  cache.set(cacheKey, digest);
  return digest;
}
