// Đồng bộ bộ skill mặc định từ kho tdduydev/xdev-skills (thư mục library/).
//
//   node packages/skill-pack/scripts/sync.ts pull                  chép library/ của submodule, ghi pack.json
//   node packages/skill-pack/scripts/sync.ts check                 so bản sao và commit với submodule
//   node packages/skill-pack/scripts/sync.ts dev                   chép skill UI vào .claude/skills của repo này
//
// Một nguồn: xdev-skills giữ danh sách, giấy phép (sources.json) và nội dung; ở đây chỉ là bản sao ghim theo commit, để
// hub, Docker và bản git archive chạy được khi không có submodule hay mạng.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACK_DIR,
  type PackSkillMeta,
  parseFrontmatter,
  readManifest,
  type SkillPackManifest,
  treeHash,
} from "../src/index.ts";

const SKILL_MAX_CHARS = 100_000;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_DIR = resolve(PACK_DIR, "../../xdev-skills");
/** Skill UI repo dev dùng (CLAUDE.md, .claude/skills/agent-fleet/common.md). */
const DEV_SKILLS = [
  "ui-ux-pro-max",
  "ui-styling",
  "design-system",
  "frontend-design",
  "web-design-guidelines",
  "vercel-react-best-practices",
  "vercel-composition-patterns",
  "shadcn",
];

interface Sources {
  repos: Record<string, { commit: string }>;
  skills: { name: string; group: string; repo?: string; path?: string; license: string; defaultOn?: boolean }[];
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fail(message: string): never {
  throw new Error(message);
}

function sourceCommit(repoDir: string): string {
  // Git tìm ngược lên repo cha khi submodule chưa init; không được nhận nhầm HEAD của Hive.
  if (!existsSync(join(repoDir, ".git")))
    fail("Chưa khởi tạo xdev-skills; chạy git submodule update --init xdev-skills tại gốc repo.");
  if (git(repoDir, "status", "--porcelain", "--untracked-files=all"))
    fail("xdev-skills còn thay đổi chưa commit; commit trước để ghim được.");
  // status bỏ qua file ignored, nhưng cpSync vẫn chép chúng vào gói và làm sai nội dung của commit đã ghim.
  if (
    git(
      repoDir,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--",
      "library",
      "sources.json",
      "NOTICE.md",
    )
  )
    fail("Nguồn skill có file bị Git ignore; dọn các file đó trong library/ trước khi đồng bộ.");
  return git(repoDir, "rev-parse", "HEAD");
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** Kiểm thư mục library/ và dựng manifest. Lỗi thì dừng: bản sao hỏng không được vào hub. */
function buildManifest(
  library: string,
  sources: Sources,
  commit: string,
  previous: SkillPackManifest | null,
): SkillPackManifest {
  const skills: PackSkillMeta[] = [];
  const before = new Map(previous?.skills.map((s) => [s.name, s]));
  for (const s of sources.skills) {
    const dir = join(library, s.name);
    if (!NAME.test(s.name)) fail(`${s.name}: tên skill không hợp lệ`);
    if (!existsSync(join(dir, "SKILL.md"))) fail(`${s.name}: thiếu SKILL.md`);
    const text = readFileSync(join(dir, "SKILL.md"), "utf8");
    const fm = parseFrontmatter(text);
    if (fm.name !== s.name) fail(`${s.name}: name trong SKILL.md là "${fm.name}"`);
    if (!fm.description || fm.description.length > 1024) fail(`${s.name}: description trống hoặc dài quá 1024 ký tự`);
    if (text.length > SKILL_MAX_CHARS) fail(`${s.name}: SKILL.md dài quá ${SKILL_MAX_CHARS} ký tự`);
    let bytes = 0;
    const list = files(dir);
    for (const f of list) {
      const buf = readFileSync(f);
      // Gói đi qua JSON tới worker và app desktop dưới dạng chữ; file nhị phân phải bỏ ở xdev-skills (exclude).
      if (buf.length && (buf.includes(0) || Buffer.from(buf.toString("utf8"), "utf8").compare(buf) !== 0))
        fail(`${f}: không phải file chữ UTF-8`);
      bytes += buf.length;
    }
    const repo = s.repo ? sources.repos[s.repo] : undefined;
    const hash = treeHash(dir);
    const old = before.get(s.name);
    skills.push({
      name: s.name,
      description: fm.description,
      group: s.group,
      defaultOn: s.defaultOn === true,
      license: s.license,
      upstream:
        s.repo && repo
          ? {
              repo: s.repo,
              commit: repo.commit,
              path: s.path ?? "",
              url: `https://github.com/${s.repo}${s.path ? `/tree/${repo.commit}/${s.path}` : ""}`,
            }
          : null,
      hash,
      version: old?.hash === hash ? (old.version ?? 1) : (old?.version ?? 0) + 1,
      files: list.length,
      bytes,
    });
  }
  const extra = readdirSync(library).filter((n) => !sources.skills.some((s) => s.name === n));
  if (extra.length) fail(`library/ có thư mục không khai trong sources.json: ${extra.join(", ")}`);
  return { source: { repo: "tdduydev/xdev-skills", commit, path: "library" }, skills };
}

export function pull(repoDir = SOURCE_DIR, packDir = PACK_DIR) {
  const commit = sourceCommit(repoDir);
  const sources = JSON.parse(readFileSync(join(repoDir, "sources.json"), "utf8")) as Sources;
  const library = join(repoDir, "library");
  const previous = existsSync(join(packDir, "pack.json")) ? readManifest(packDir) : null;
  const manifest = buildManifest(library, sources, commit, previous);
  const dest = join(packDir, "skills");
  rmSync(dest, { recursive: true, force: true });
  cpSync(library, dest, { recursive: true });
  cpSync(join(repoDir, "NOTICE.md"), join(packDir, "NOTICE.md"));
  writeFileSync(join(packDir, "pack.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${manifest.skills.length} skill @ ${commit.slice(0, 12)}`);
}

export function check(repoDir = SOURCE_DIR, packDir = PACK_DIR) {
  const commit = sourceCommit(repoDir);
  const manifest = readManifest(packDir);
  if (commit !== manifest.source.commit)
    fail(`Commit submodule xdev-skills (${commit}) khác pack.json (${manifest.source.commit}); chạy lại "pull".`);
  const sources = JSON.parse(readFileSync(join(repoDir, "sources.json"), "utf8")) as Sources;
  const expected = buildManifest(join(repoDir, "library"), sources, commit, manifest);
  if (JSON.stringify(expected) !== JSON.stringify(manifest))
    fail(`pack.json khác library/ ở ${commit.slice(0, 12)}; chạy lại "pull".`);
  const names = readdirSync(join(packDir, "skills")).sort();
  if (JSON.stringify(names) !== JSON.stringify(manifest.skills.map((s) => s.name).sort()))
    fail('Danh sách skills/ khác pack.json; chạy lại "pull".');
  for (const s of manifest.skills) {
    if (treeHash(join(packDir, "skills", s.name)) !== s.hash) fail(`skills/${s.name} khác bản ở xdev-skills.`);
  }
  if (readFileSync(join(packDir, "NOTICE.md"), "utf8") !== readFileSync(join(repoDir, "NOTICE.md"), "utf8"))
    fail('NOTICE.md khác bản ở xdev-skills; chạy lại "pull".');
  console.log(`khớp xdev-skills @ ${commit.slice(0, 12)}`);
}

function dev() {
  const target = join(PACK_DIR, "..", "..", ".claude", "skills");
  for (const name of DEV_SKILLS) {
    rmSync(join(target, name), { recursive: true, force: true });
    cpSync(join(PACK_DIR, "skills", name), join(target, name), { recursive: true });
  }
  console.log(`đã chép ${DEV_SKILLS.length} skill vào .claude/skills`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [cmd, extra] = process.argv.slice(2);
    if (extra) fail("Dùng: sync.ts pull | check | dev (nguồn cố định: xdev-skills/)");
    if (cmd === "pull") pull();
    else if (cmd === "check") check();
    else if (cmd === "dev") dev();
    else fail("Dùng: sync.ts pull | check | dev");
  } catch (error) {
    console.error(`Không đồng bộ được bộ skill: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
