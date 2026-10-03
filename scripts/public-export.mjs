#!/usr/bin/env node
// Clean export of the committed tree for the public repo (OPS-4). The private repo stays as is;
// the public one gets a single commit made from the folder this writes.
//
//   node scripts/public-export.mjs <dest> [--ref HEAD] [--config scripts/public-export.json]
//
// Steps: git archive <ref> → <dest>; drop `exclude`; in `docs` files apply `replace` and drop
// lines still holding a `forbid` term (counted); rules with their own `files` also rewrite code;
// `warn` terms outside docs are only reported (they are behaviour, a person decides);
// then scan every text file for `forbid` and exit 1 with file:line if anything is left.
// The config excludes this script, its json and its test: the lists themselves name what must not leak.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const matches = (file, globs) => globs.some((g) => g === "**" || posix.matchesGlob(file, g));

// Case-insensitive because the leaks come in every casing (customer, customer, customer).
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const literal = (s) => new RegExp(escape(s), "gi");

function walk(root, dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(root, p, out);
    else out.push(relative(root, p).split(sep).join("/"));
  }
  return out;
}

function pruneEmpty(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      pruneEmpty(p);
      if (!readdirSync(p).length) rmSync(p, { recursive: true });
    }
  }
}

// A NUL byte in the first 8 KB is how git decides "binary" too.
const isBinary = (buf) => buf.subarray(0, 8192).includes(0);

function excluded(file, exclude) {
  return exclude.some((e) => (e.endsWith("/") ? file.startsWith(e) : file === e));
}

// Also checks the line without backslashes: tests spell hosts as regexes (gitlab\.fis\.vn).
// Both forms, because some terms carry a backslash themselves (D:\src).
function holds(line, term) {
  const low = line.toLowerCase();
  const t = term.toLowerCase();
  return low.includes(t) || low.replaceAll("\\", "").includes(t);
}

/** Terms of `forbid` found in a text, as [{ line, term }] (1-based lines). */
export function findForbidden(text, forbid) {
  const hits = [];
  text.split("\n").forEach((l, i) => {
    for (const term of forbid) if (holds(l, term)) hits.push({ line: i + 1, term });
  });
  return hits;
}

/**
 * Rewrite one file's text. Docs get every rule without `files` plus line dropping; any file gets
 * the rules whose `files` match it. Returns { text, dropped }.
 */
export function rewrite(file, text, config) {
  const doc = matches(file, config.docs ?? []);
  let out = text;
  for (const r of config.replace ?? []) {
    if (r.files ? matches(file, r.files) : doc) out = out.replace(literal(r.from), () => r.to);
  }
  let dropped = 0;
  if (doc) {
    const kept = out.split("\n").filter((l) => {
      const bad = (config.forbid ?? []).some((t) => holds(l, t));
      if (bad) dropped++;
      return !bad;
    });
    out = kept.join("\n");
  }
  return { text: out, dropped };
}

/**
 * Export `ref` of `repo` into `dest` (must be missing or empty). Returns a report; `leaks` empty
 * means the tree is clean.
 */
export function exportTree({ repo, ref = "HEAD", dest, config }) {
  if (existsSync(dest) && readdirSync(dest).length) throw new Error(`${dest} is not empty`);
  mkdirSync(dest, { recursive: true });
  // Through a tar file, not a pipe: the tree has screenshots and a pipe needs a maxBuffer guess.
  const tar = join(dest, ".public-export.tar");
  execFileSync("git", ["-C", repo, "archive", "--format=tar", `--output=${tar}`, ref]);
  execFileSync("tar", ["-xf", tar, "-C", dest]);
  rmSync(tar);

  const report = { files: 0, excluded: [], dropped: [], rewritten: [], warnings: [], leaks: [], binary: [] };
  for (const file of walk(dest)) {
    const p = join(dest, file);
    if (excluded(file, config.exclude ?? [])) {
      rmSync(p);
      report.excluded.push(file);
      continue;
    }
    report.files++;
    const buf = readFileSync(p);
    if (isBinary(buf)) {
      report.binary.push(file);
      continue;
    }
    const before = buf.toString("utf8");
    const { text, dropped } = rewrite(file, before, config);
    if (text !== before) {
      writeFileSync(p, text);
      report.rewritten.push(file);
    }
    if (dropped) report.dropped.push({ file, lines: dropped });
    if (!matches(file, config.docs ?? [])) {
      for (const h of findForbidden(text, config.warn ?? [])) report.warnings.push({ file, ...h });
    }
    for (const h of findForbidden(text, config.forbid ?? [])) report.leaks.push({ file, ...h });
  }
  // Excluded files leave empty directories behind; git would not carry them, so neither do we.
  pruneEmpty(dest);
  return report;
}

function main(argv) {
  const args = { ref: "HEAD", config: join(here, "public-export.json") };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ref") args.ref = argv[++i];
    else if (argv[i] === "--config") args.config = argv[++i];
    else rest.push(argv[i]);
  }
  if (rest.length !== 1) {
    console.error("usage: node scripts/public-export.mjs <dest> [--ref HEAD] [--config file.json]");
    return 2;
  }
  const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim();
  const dest = resolve(rest[0]);
  if (dest === repo || dest.startsWith(repo + sep)) {
    console.error(`${dest} is inside the repo; export outside it`);
    return 2;
  }
  const config = JSON.parse(readFileSync(args.config, "utf8"));
  const r = exportTree({ repo, ref: args.ref, dest, config });
  const droppedTotal = r.dropped.reduce((n, d) => n + d.lines, 0);
  console.log(`exported ${args.ref} → ${dest}`);
  console.log(`files: ${r.files} (${r.binary.length} binary, not scanned), excluded: ${r.excluded.length}, rewritten: ${r.rewritten.length}`);
  console.log(`dropped lines: ${droppedTotal}`);
  for (const d of r.dropped) console.log(`  ${d.file}: ${d.lines}`);
  if (r.warnings.length) {
    console.log(`warnings (left as is, check by hand): ${r.warnings.length}`);
    for (const w of r.warnings) console.log(`  ${w.file}:${w.line}: ${w.term}`);
  }
  if (r.leaks.length) {
    console.error(`forbidden strings left: ${r.leaks.length}`);
    for (const l of r.leaks) console.error(`  ${l.file}:${l.line}: ${l.term}`);
    return 1;
  }
  console.log("clean: no forbidden strings");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
