// Đồng bộ bộ skill mặc định từ kho tdduydev/xdev-skills (thư mục library/).
//
//   node packages/skill-pack/scripts/sync.ts pull <xdev-skills>    chép library/ ở HEAD (cây phải sạch), ghi pack.json
//   node packages/skill-pack/scripts/sync.ts check <xdev-skills>   so bản sao với library/ ở commit đã ghim
//   node packages/skill-pack/scripts/sync.ts dev                   chép skill UI vào .claude/skills của repo này
//
// Một nguồn: xdev-skills giữ danh sách, giấy phép (sources.json) và nội dung; ở đây chỉ là bản sao ghim theo commit, để
// hub chạy được không cần mạng và test chạy được trong CI.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  console.error(message);
  process.exit(1);
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** Kiểm thư mục library/ và dựng manifest. Lỗi thì dừng: bản sao hỏng không được vào hub. */
function buildManifest(library: string, sources: Sources, commit: string): SkillPackManifest {
  const skills: PackSkillMeta[] = [];
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
      hash: treeHash(dir),
      files: list.length,
      bytes,
    });
  }
  const extra = readdirSync(library).filter((n) => !sources.skills.some((s) => s.name === n));
  if (extra.length) fail(`library/ có thư mục không khai trong sources.json: ${extra.join(", ")}`);
  return { source: { repo: "tdduydev/xdev-skills", commit, path: "library" }, skills };
}

function pull(repoDir: string) {
  if (git(repoDir, "status", "--porcelain")) fail(`${repoDir} còn thay đổi chưa commit; commit trước để ghim được.`);
  const commit = git(repoDir, "rev-parse", "HEAD");
  const sources = JSON.parse(readFileSync(join(repoDir, "sources.json"), "utf8")) as Sources;
  const library = join(repoDir, "library");
  const manifest = buildManifest(library, sources, commit);
  const dest = join(PACK_DIR, "skills");
  rmSync(dest, { recursive: true, force: true });
  cpSync(library, dest, { recursive: true });
  cpSync(join(repoDir, "NOTICE.md"), join(PACK_DIR, "NOTICE.md"));
  writeFileSync(join(PACK_DIR, "pack.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${manifest.skills.length} skill @ ${commit.slice(0, 12)}`);
}

function check(repoDir: string) {
  const manifest = readManifest();
  const tmp = mkdtempSync(join(tmpdir(), "skill-pack-"));
  try {
    const tarFile = join(tmp, "library.tar");
    git(repoDir, "archive", "--format=tar", "-o", tarFile, manifest.source.commit, "library", "sources.json");
    execFileSync("tar", ["-x", "-f", tarFile, "-C", tmp]);
    rmSync(tarFile);
    const sources = JSON.parse(readFileSync(join(tmp, "sources.json"), "utf8")) as Sources;
    const expected = buildManifest(join(tmp, "library"), sources, manifest.source.commit);
    if (JSON.stringify(expected) !== JSON.stringify(manifest))
      fail(`pack.json khác library/ ở ${manifest.source.commit.slice(0, 12)}; chạy lại "pull".`);
    for (const s of manifest.skills) {
      if (treeHash(join(PACK_DIR, "skills", s.name)) !== s.hash) fail(`skills/${s.name} khác bản ở xdev-skills.`);
    }
    console.log(`khớp xdev-skills @ ${manifest.source.commit.slice(0, 12)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function dev() {
  const target = join(PACK_DIR, "..", "..", ".claude", "skills");
  for (const name of DEV_SKILLS) {
    rmSync(join(target, name), { recursive: true, force: true });
    cpSync(join(PACK_DIR, "skills", name), join(target, name), { recursive: true });
  }
  console.log(`đã chép ${DEV_SKILLS.length} skill vào .claude/skills`);
}

const [cmd, dir] = process.argv.slice(2);
if (cmd === "pull" && dir) pull(dir);
else if (cmd === "check" && dir) check(dir);
else if (cmd === "dev") dev();
else fail("Dùng: sync.ts pull <xdev-skills> | check <xdev-skills> | dev");
