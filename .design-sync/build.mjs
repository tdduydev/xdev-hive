#!/usr/bin/env node
// Builds the design-sync input for @xdev-hive/ui. The package ships TypeScript source only (no dist, no build
// script), and the converter needs a built entry with a .d.ts tree and a compiled stylesheet, so this makes one:
//
//   .design-sync/dist/index.js      ESM bundle of .design-sync/entry/index.ts (react, react-dom, jsx-runtime external)
//   .design-sync/dist/index.d.ts    tsc declarations; types/ holds the rest, with package aliases made relative
//   .design-sync/dist/hive.css      Tailwind v4 build of packages/ui/src/globals.css; its fonts copied to dist/fonts/
//   .design-sync/dist/font-aliases.css  the variable fonts again under their static names (cfg.extraFonts)
//   .design-sync/dist/package.json  names the package, so the converter's walk up from --entry stops here
//
// Run from the repo root: node .design-sync/build.mjs   (Node >= 24, after npm ci; Tailwind CLI lives in .ds-sync/)
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const ENTRY = join(HERE, "entry");
const DIST = join(HERE, "dist");
const UI = join(ROOT, "packages/ui");
const UI_SRC = join(UI, "src");
const rootRequire = createRequire(join(ROOT, "package.json"));

const log = (...a) => console.error("[ds-build]", ...a);
function die(msg) {
  console.error(`[ds-build] ✗ ${msg}`);
  process.exit(1);
}
function walk(dir, keep) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, keep));
    else if (keep(p)) out.push(p);
  }
  return out;
}
const posix = (p) => p.split(sep).join("/");
const toRelSpec = (fromFile, absNoExt) => {
  const r = posix(relative(dirname(fromFile), absNoExt));
  return r.startsWith(".") ? r : `./${r}`;
};

if (!existsSync(join(ROOT, "node_modules/react"))) die("node_modules missing: run `npm ci` at the repo root first");
const uiPkg = JSON.parse(readFileSync(join(UI, "package.json"), "utf8"));

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// -- 1. declarations --------------------------------------------------------------------------------------------
// rootDir is the repo root, so tsc mirrors paths under dist/types/; the entry's own files then move up to dist/.
{
  const tsc = join(dirname(rootRequire.resolve("typescript/package.json")), "bin/tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", join(ENTRY, "tsconfig.json")], { cwd: ROOT, encoding: "utf8" });
  if (r.stdout.trim() || r.stderr.trim()) console.error(r.stdout + r.stderr);
  // Fatal although tsc still emits: a name exported by two `export *` lines (TS2308) is silently dropped from the
  // JS bundle, and a type error can blank a component's props in its .d.ts.
  if (r.status !== 0) die(`tsc exited ${r.status} (errors above)`);
  const emittedEntry = join(DIST, "types/.design-sync/entry");
  if (!existsSync(join(emittedEntry, "index.d.ts"))) die("tsc emitted no index.d.ts");
  for (const f of readdirSync(emittedEntry)) renameSync(join(emittedEntry, f), join(DIST, f));
  rmSync(join(DIST, "types/.design-sync"), { recursive: true, force: true });

  // .d.ts keeps specifiers as written. Package aliases (#ui/*, @xdev-hive/ui/*) and .ts/.tsx extensions only resolve
  // inside the repo's own tsconfig, so point them at the emitted mirror instead (map: packages/ui/package.json).
  const uiAlias = (spec) => {
    if (spec === "@xdev-hive/ui") return join(UI_SRC, "index");
    if (spec === "@xdev-hive/ui/i18n") return join(UI_SRC, "i18n/translate");
    if (spec.startsWith("@xdev-hive/ui/")) return join(UI_SRC, spec.slice("@xdev-hive/ui/".length));
    if (spec.startsWith("#ui/")) return join(UI_SRC, spec.slice("#ui/".length));
    return null;
  };
  const stripExt = (s) => s.replace(/\.(?:d\.)?[mc]?tsx?$/, "");
  const mirror = (srcAbs) => join(DIST, "types", relative(ROOT, srcAbs));
  const missing = new Set();
  let rewrote = 0;
  for (const file of walk(DIST, (p) => p.endsWith(".d.ts"))) {
    const before = readFileSync(file, "utf8");
    const after = before.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g, (m, lead, q, spec) => {
      const alias = uiAlias(spec);
      let next = spec;
      if (alias) next = toRelSpec(file, mirror(stripExt(alias)));
      else if (spec.startsWith(".")) next = stripExt(spec);
      else return m;
      const target = resolve(dirname(file), next);
      if (!existsSync(`${target}.d.ts`) && !existsSync(join(target, "index.d.ts"))) missing.add(`${spec} (from ${posix(relative(DIST, file))})`);
      if (next !== spec) rewrote++;
      return `${lead}${q}${next}${q}`;
    });
    if (after !== before) writeFileSync(file, after);
  }
  if (missing.size) die(`declarations point at modules tsc did not emit:\n  ${[...missing].join("\n  ")}`);
  log(`d.ts: ${walk(DIST, (p) => p.endsWith(".d.ts")).length} files, ${rewrote} specifiers rewritten`);
}

// -- 2. JS bundle -------------------------------------------------------------------------------------------------
{
  let esbuild;
  try {
    esbuild = await import(rootRequire.resolve("esbuild"));
  } catch {
    esbuild = await import(createRequire(join(ROOT, ".ds-sync/package.json")).resolve("esbuild"));
  }
  const result = await esbuild.build({
    entryPoints: [join(ENTRY, "index.ts")],
    outfile: join(DIST, "index.js"),
    absWorkingDir: ROOT,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    external: ["react", "react/*", "react-dom", "react-dom/*"],
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
  });
  if (result.errors.length) die("esbuild failed");
  const inputs = Object.keys(result.metafile.inputs);
  const css = inputs.filter((p) => p.endsWith(".css"));
  // Component CSS ships through hive.css; a .css import in the JS graph would be a second, unscanned copy.
  if (css.length) log(`! JS graph imports CSS (left out of hive.css?): ${css.join(", ")}`);
  // theme.ts sets <html data-theme> from the OS at import time and would fight HiveTheme.
  if (inputs.some((p) => p.endsWith("packages/ui/src/lib/theme.ts"))) log("! lib/theme.ts is in the bundle: it re-themes <html> on load");
  log(`js: ${(statSync(join(DIST, "index.js")).size / 1024).toFixed(0)} KB from ${inputs.length} modules`);
}

// -- 3. CSS -------------------------------------------------------------------------------------------------------
{
  const cliPkg = join(ROOT, ".ds-sync/node_modules/@tailwindcss/cli/package.json");
  if (!existsSync(cliPkg)) {
    const tw = JSON.parse(readFileSync(rootRequire.resolve("tailwindcss/package.json"), "utf8")).version;
    die(`@tailwindcss/cli is not in the repo; install it next to the converter: (cd .ds-sync && npm i @tailwindcss/cli@${tw})`);
  }
  const cli = join(dirname(cliPkg), JSON.parse(readFileSync(cliPkg, "utf8")).bin.tailwindcss);
  const out = join(DIST, "hive.css");
  // --cwd entry/: Tailwind's automatic source detection scans the cwd. From the repo root it would sweep apps/ and
  // docs/ too; globals.css already adds packages/ui/src (@source "./") and hive.css adds the previews.
  const r = spawnSync(process.execPath, [cli, "--cwd", ENTRY, "-i", join(ENTRY, "hive.css"), "-o", out, "--optimize"], {
    cwd: ENTRY,
    encoding: "utf8",
  });
  if (r.status !== 0 || !existsSync(out)) die(`tailwind failed:\n${r.stdout}${r.stderr}`);

  // Inlined @fontsource files keep url(./files/…) relative to their own package, which no longer resolves. The
  // converter copies fonts only from paths under dist/, so copy each file to dist/fonts/ and point the url there.
  const fontFiles = new Map();
  for (const scope of ["@fontsource", "@fontsource-variable"]) {
    for (const nm of [join(UI, "node_modules"), join(ROOT, "node_modules")]) {
      const d = join(nm, scope);
      if (!existsSync(d)) continue;
      for (const pkg of readdirSync(d)) {
        const files = join(d, pkg, "files");
        if (!existsSync(files)) continue;
        for (const f of readdirSync(files)) if (!fontFiles.has(f)) fontFiles.set(f, join(files, f));
      }
    }
  }
  mkdirSync(join(DIST, "fonts"), { recursive: true });
  const unresolved = new Set();
  let copied = 0;
  const css = readFileSync(out, "utf8").replace(/@font-face\s*\{[^}]*\}/g, (block) =>
    block.replace(/src\s*:\s*([^;}]+)/, (_, list) => {
      const entries = list.split(/,(?![^(]*\))/).map((s) => s.trim());
      // Every browser the design app runs in reads woff2; the woff fallbacks would double the upload for nothing.
      const woff2 = entries.filter((e) => /\.woff2['")\s]|format\(\s*['"]woff2/.test(e));
      const kept = (woff2.length ? woff2 : entries).map((e) =>
        e.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/, (m, q, u) => {
          if (/^(?:data:|https?:)/.test(u)) return m;
          const name = basename(u.split(/[?#]/)[0]);
          const src = fontFiles.get(name);
          if (!src) {
            unresolved.add(u);
            return m;
          }
          cpSync(src, join(DIST, "fonts", name));
          copied++;
          return `url(./fonts/${name})`;
        }),
      );
      return `src: ${kept.join(", ")}`;
    }),
  );
  if (unresolved.size) die(`font urls with no file under node_modules/@fontsource*: ${[...unresolved].join(", ")}`);
  writeFileSync(out, css);
  log(`css: ${(statSync(out).size / 1024).toFixed(0)} KB, ${copied} font files → dist/fonts/`);

  // Token stacks name the static family after the variable build ('JetBrains Mono Variable','JetBrains Mono'). The
  // static name never ships, so validate reports it [FONT_MISSING]; the same faces under that name make the fallback
  // resolve to the files already shipped. Wired through cfg.extraFonts.
  const aliases = [];
  for (const block of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
    const m = /font-family\s*:\s*(['"]?)([^;'"}]+?) Variable\1\s*;/.exec(block);
    if (m) aliases.push(block.replace(m[0], `font-family: '${m[2]}';`));
  }
  writeFileSync(join(DIST, "font-aliases.css"), aliases.join("\n") + "\n");
  log(`font aliases: ${aliases.length} @font-face (static names of the variable families)`);
}

// -- 4. package.json ----------------------------------------------------------------------------------------------
writeFileSync(
  join(DIST, "package.json"),
  JSON.stringify(
    {
      name: uiPkg.name,
      version: uiPkg.version,
      private: true,
      type: "module",
      module: "./index.js",
      types: "./index.d.ts",
      style: "./hive.css",
    },
    null,
    2,
  ) + "\n",
);
log(`done → ${posix(relative(ROOT, DIST))}/`);
