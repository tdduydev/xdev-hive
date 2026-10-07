#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Usage: node scripts/review-batch.mjs --name <batch> [options] ai/<task>…

  --base <ref>       Base commit/branch (default: main; no automatic pull)
  --worktree <dir>   New worktree (default: sibling review-<batch>)
  --gate            Typecheck → unit tests → web e2e → mobile e2e → desktop build → smoke
  --only <steps>    Forward comma-separated step names to both e2e commands (requires --gate)
  --help            Show this help

Sources: ai/<task> or host:path#branch (Git over SSH).
Merges and npm commands run in the new review/<batch> worktree only.
Installs dependencies with npm ci --prefer-offline before checking, and after manifest changes.
Logs/report: <worktree>/.xdev-hive/artifacts/review-batch/.
Exit 1: a source was skipped or the gate failed; exit 2: setup failed.
No push, release or changes to main. See scripts/review-batch.md.
`;

function parseArgs(argv) {
  const options = { base: "main", branches: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--gate") options.gate = true;
    else if (["--name", "--base", "--worktree", "--only"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = value;
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else options.branches.push(arg);
  }
  if (!options.name) throw new Error("--name is required");
  if (!options.branches.length) throw new Error("Provide at least one ai/<task> source");
  if (options.only && !options.gate) throw new Error("--only requires --gate");
  if (options.only && !/^[\w-]+(?:,[\w-]+)*$/.test(options.only)) throw new Error("--only expects comma-separated step names");
  return options;
}

// Git does not consult the caller's index or worktree, even if that checkout is dirty.
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" });
function git(cwd, args, log) {
  const result = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
  const output = (result.stdout ?? "") + (result.stderr ?? "") + (result.error ? `\n${result.error.message}\n` : "");
  if (log) {
    writeFileSync(log, `$ git ${args.join(" ")}\n${output}`);
    process.stdout.write(output);
  }
  return { code: result.error ? 1 : result.status ?? 1, output, stdout: result.stdout ?? "" };
}
function gitOK(cwd, ...args) {
  const result = git(cwd, args);
  if (result.code) throw new Error(`git ${args[0]} failed: ${result.output.trim()}`);
  return result.stdout.trim();
}

function sourceParts(source, repo) {
  if (/[\x00-\x1f\x7f]/.test(source)) throw new Error("Source contains control characters");
  const match = /^([\w][\w.@-]*):(.+)#(.+)$/.exec(source);
  const branch = match ? match[3] : source;
  if ((!match && !branch.startsWith("ai/")) || git(repo, ["check-ref-format", `refs/heads/${branch}`]).code) {
    throw new Error("Expected ai/<task> or host:path#branch");
  }
  return { branch, remote: match ? `${match[1]}:${match[2]}` : null };
}

function npmInvocation(args) {
  if (process.env.npm_execpath) return [process.execPath, [process.env.npm_execpath, ...args]];
  // The CLI is also usable directly with node on Windows, without putting user paths through cmd.exe.
  const bundled = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(bundled)) return [process.execPath, [bundled, ...args]];
  if (process.platform === "win32") throw new Error("Run this script via npm exec on Windows so npm_execpath is available");
  return ["npm", args];
}

async function npmStep(cwd, args, log, gui = false) {
  let [command, commandArgs] = npmInvocation(args);
  const env = { ...process.env };
  if (gui && process.platform === "linux") {
    env.ELECTRON_DISABLE_SANDBOX = "1";
    if (!env.DISPLAY) {
      commandArgs = ["-a", "-s", "-screen 0 1440x900x24", command, ...commandArgs];
      command = "xvfb-run";
    }
  }
  const fd = openSync(log, "w");
  const title = `$ ${command} ${commandArgs.join(" ")}\n`;
  writeSync(fd, title);
  process.stdout.write(title);
  try {
    return await new Promise((done) => {
      const child = spawn(command, commandArgs, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
        writeSync(fd, chunk);
        process.stdout.write(chunk);
      });
      child.on("error", (error) => {
        writeSync(fd, `${error.message}\n`);
        console.error(error.message);
      });
      child.on("close", (code, signal) => {
        const status = code ?? 1;
        writeSync(fd, `\nExit: ${status}${signal ? ` (${signal})` : ""}\n`);
        done(status);
      });
    });
  } finally {
    closeSync(fd);
  }
}

function manifestKey(worktree) {
  const files = gitOK(worktree, "ls-files", "-z").split("\0").filter((file) => /(^|\/)(package(?:-lock)?\.json|npm-shrinkwrap\.json)$/.test(file));
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(readFileSync(join(worktree, file)));
  return hash.digest("hex");
}

function reportConflicts(worktree) {
  const files = gitOK(worktree, "diff", "--name-only", "--diff-filter=U", "-z").split("\0").filter(Boolean);
  const conflicts = [];
  for (const file of files) {
    const path = join(worktree, file);
    const sections = [];
    // A conflicted symlink can point outside this review; report its Git stages instead of reading its target.
    if (existsSync(path) && lstatSync(path).isFile()) {
      const buffer = readFileSync(path);
      if (!buffer.includes(0)) {
        let section;
        buffer.toString("utf8").split("\n").forEach((line, index) => {
          if (/^<{7,} /.test(line)) section = [];
          if (section) section.push(`${index + 1}: ${line}`);
          if (section && /^>{7,} /.test(line)) { sections.push(section.join("\n")); section = undefined; }
        });
      }
    }
    // Binary, modify/delete and rename conflicts may have no text markers.
    if (!sections.length) {
      sections.push(gitOK(worktree, "ls-files", "--unmerged", "--", file));
    }
    const conflict = { file, sections };
    conflicts.push(conflict);
    console.log(`\nConflict: ${file}\n${sections.join("\n\n")}`);
  }
  return conflicts;
}

function gateSteps(out, only) {
  const e2e = (script, folder) => ["run", script, "-w", "@xdev-hive/web", "--", join(out, folder), ...(only ? ["--only", only] : [])];
  return [
    { name: "typecheck", args: ["run", "typecheck"] },
    { name: "test", args: ["test"] },
    { name: "e2e", args: e2e("e2e", "web"), gui: true },
    { name: "e2e-mobile", args: e2e("e2e:mobile", "mobile"), gui: true },
    { name: "desktop-build", args: ["run", "build", "-w", "@xdev-hive/desktop"] },
    { name: "desktop-smoke", args: ["run", "smoke", "-w", "@xdev-hive/desktop", "--", join(out, "desktop")], gui: true },
  ];
}

function physicalPath(path) {
  // Resolve existing parents too: a symlink outside the repo can lead a new destination back into it.
  return existsSync(path) ? realpathSync(path) : join(physicalPath(dirname(path)), basename(path));
}

export async function reviewBatch(options) {
  const repo = gitOK(resolve(options.repo ?? process.cwd()), "rev-parse", "--show-toplevel");
  const { name, branches, gate = false, only } = options;
  const review = `review/${name}`;
  if (!name || /[\x00-\x1f\x7f]/.test(name) || git(repo, ["check-ref-format", `refs/heads/${review}`]).code) throw new Error("Invalid batch name");
  if (!branches?.length) throw new Error("Provide at least one source");
  if (only && (!gate || !/^[\w-]+(?:,[\w-]+)*$/.test(only))) throw new Error("--only requires --gate and comma-separated step names");
  if (!git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${review}`]).code) throw new Error(`${review} already exists; choose a new name`);
  const baseRef = options.base ?? "main";
  const base = gitOK(repo, "rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`);
  const worktree = resolve(options.worktree ?? join(dirname(repo), `review-${name.replaceAll("/", "-")}`));
  const inRepo = relative(realpathSync(repo), physicalPath(worktree));
  if (!inRepo || (inRepo !== ".." && !inRepo.startsWith(`..${sep}`) && !isAbsolute(inRepo))) throw new Error("Worktree must be outside the source checkout");
  if (existsSync(worktree)) throw new Error(`Worktree path already exists: ${worktree}`);
  const out = join(worktree, ".xdev-hive", "artifacts", "review-batch");
  const report = { review, baseRef, base, worktree, out, branches: [], gate: [], exitCode: 0 };
  const fetched = [];
  const fetchNamespace = `refs/review-batch/${randomUUID()}`;
  let installed;
  let step = 0;
  const logPath = (label) => join(out, `${String(++step).padStart(3, "0")}-${label}.log`);
  const ensureDeps = async () => {
    const key = manifestKey(worktree);
    if (key === installed) return 0;
    // A failed npm ci can remove the previous node_modules, so no key remains valid.
    installed = undefined;
    const code = await npmStep(worktree, ["ci", "--prefer-offline"], logPath("install"));
    if (!code) installed = key;
    return code;
  };

  gitOK(repo, "worktree", "add", "-b", review, "--", worktree, base);
  mkdirSync(out, { recursive: true });
  console.log(`Review: ${review}\nBase: ${baseRef} (${base})\nWorktree: ${worktree}\nLogs: ${out}`);
  try {
    // Freeze every source before merging; a moving local or remote branch cannot change this batch halfway through.
    for (let i = 0; i < branches.length; i++) {
      const source = branches[i];
      const row = { source, status: "skipped", behind: null, reason: "", conflicts: [] };
      report.branches.push(row);
      try {
        const parts = sourceParts(source, repo);
        let ref = `refs/heads/${parts.branch}`;
        if (parts.remote) {
          ref = `${fetchNamespace}/${i}`;
          fetched.push(ref);
          const result = git(worktree, ["fetch", "--no-tags", "--no-write-fetch-head", "--", parts.remote, `refs/heads/${parts.branch}:${ref}`], logPath("fetch"));
          if (result.code) throw new Error(`fetch failed (exit ${result.code}); see fetch log`);
        }
        const commit = gitOK(worktree, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
        row.behind = Number(gitOK(worktree, "rev-list", "--count", `${commit}..${base}`));
        row.commit = commit;
      } catch (error) {
        row.reason = error.message;
        console.error(`${source}: ${row.reason}`);
      }
    }
    for (const row of report.branches) {
      if (!row.commit) continue;
      const before = gitOK(worktree, "rev-parse", "HEAD");
      console.log(`\nMerging ${row.source} (${row.commit}; ${row.behind} commits behind base)`);
      const result = git(worktree, ["-c", "rerere.enabled=false", "merge", "--no-ff", "--no-edit", "--no-gpg-sign", "-m", `Merge ${row.source} (${review})`, row.commit], logPath("merge"));
      if (result.code) {
        row.conflicts = reportConflicts(worktree);
        row.reason = row.conflicts.length ? "merge conflict" : `merge failed (exit ${result.code}); see merge log`;
        writeFileSync(join(out, `conflicts-${report.branches.indexOf(row) + 1}.json`), JSON.stringify(row.conflicts, null, 2) + "\n");
        if (git(worktree, ["rev-parse", "--verify", "MERGE_HEAD"]).code === 0) gitOK(worktree, "merge", "--abort");
        else gitOK(worktree, "reset", "--hard", before);
        continue;
      }
      const deps = await ensureDeps();
      const checked = deps || await npmStep(worktree, ["run", "typecheck"], logPath("typecheck"));
      if (checked) {
        row.reason = `${deps ? "dependency install" : "typecheck"} failed (exit ${checked}); rolled back`;
        gitOK(worktree, "reset", "--hard", before);
        continue;
      }
      row.status = "included";
      row.reason = before === gitOK(worktree, "rev-parse", "HEAD") ? "already included; typecheck passed" : "typecheck passed";
    }
    if (gate) {
      const deps = await ensureDeps();
      if (deps) report.gate.push({ name: "install", status: "failed", code: deps });
      else for (const check of gateSteps(out, only)) {
        const log = logPath(`gate-${check.name}`);
        const code = await npmStep(worktree, check.args, log, check.gui);
        report.gate.push({ name: check.name, status: code ? "failed" : "passed", code, log });
        if (code) break;
      }
    }
    report.exitCode = report.branches.some((row) => row.status === "skipped") || report.gate.some((check) => check.status === "failed") ? 1 : 0;
    return report;
  } catch (error) {
    report.error = error.message;
    report.exitCode = 2;
    throw error;
  } finally {
    for (const ref of fetched) gitOK(repo, "update-ref", "-d", ref);
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log("\nBatch result:");
    console.table(report.branches.map(({ source, status, behind, reason }) => ({ source, status, behind: behind ?? "?", reason })));
    if (gate) console.table(report.gate);
    console.log(`Review worktree retained: ${worktree}\nReport: ${join(out, "report.json")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else process.exitCode = (await reviewBatch(options)).exitCode;
  } catch (error) {
    console.error(`review-batch: ${error.message}`);
    process.exitCode = 2;
  }
}
