#!/usr/bin/env node
// Builds the files of the xDev Hive design system artifact from packages/ui-kit.
//
//   node scripts/design-system/build.mjs <out>
//
// Writes <out>/project/: tokens.json (from the token CSS), README.md and the other authored files of system/,
// and the live components: components/lib (React 19 as classic scripts), components/bundle.js
// (window.XdevHive), components/bundle.css (Tailwind v4), and a preview.html + README.md per component.
// Not written: project/design-system.json and the logo/illustration uploads; the artifact keeps those
// (README.md beside this script says how to publish).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPONENTS, previewHtml, readmeMd } from "./components.mjs";
import { buildTokens, stripDeclarations, tokenNames } from "./tokens.mjs";
import { colorUsage, FAMILIES, SHADOW_USAGE } from "./usage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
// The build tools are dependencies of the apps, not of ui-kit; resolve them where they are declared so a
// hoisting change in node_modules cannot pick another copy.
const fromWeb = createRequire(join(repoRoot, "apps/web/package.json"));
const fromDesktop = createRequire(join(repoRoot, "apps/desktop/package.json"));
const fromUi = createRequire(join(repoRoot, "packages/ui/package.json"));
const esbuild = fromDesktop("esbuild");
const tailwindVite = createRequire(fromWeb.resolve("@tailwindcss/vite"));
const { compile } = tailwindVite("@tailwindcss/node");
const { Scanner } = tailwindVite("@tailwindcss/oxide");

const NAMESPACE = "XdevHive";

/** Turns `react`, `react-dom` and the JSX runtime into the page's window.React / window.ReactDOM. */
const reactGlobals = {
  name: "react-globals",
  setup(b) {
    b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (a) => ({ path: a.path, namespace: "react-globals" }));
    b.onLoad({ filter: /.*/, namespace: "react-globals" }, (a) => ({
      contents: a.path.includes("jsx")
        ? "var R=window.React;function j(t,p,k){return R.createElement(t,k===undefined?p:Object.assign({},p,{key:k}))}module.exports={Fragment:R.Fragment,jsx:j,jsxs:j,jsxDEV:j};"
        : a.path.startsWith("react-dom") ? "module.exports=window.ReactDOM;" : "module.exports=window.React;",
    }));
  },
};

const iife = { bundle: true, minify: true, format: "iife", define: { "process.env.NODE_ENV": '"production"' }, legalComments: "none", logLevel: "warning" };

async function buildLibraries(outDir, tmp) {
  // React 19 ships no UMD build: wrap it as classic scripts that set the globals the page and bundle read.
  writeFileSync(join(tmp, "react.js"), `window.React=require("react");`);
  writeFileSync(join(tmp, "react-dom.js"), `window.ReactDOM=Object.assign({},require("react-dom"),require("react-dom/client"));`);
  const nodePaths = [join(repoRoot, "node_modules")];
  await esbuild.build({ ...iife, nodePaths, entryPoints: [join(tmp, "react.js")], outfile: join(outDir, "lib/react.production.min.js") });
  await esbuild.build({
    ...iife, nodePaths, entryPoints: [join(tmp, "react-dom.js")], outfile: join(outDir, "lib/react-dom.production.min.js"),
    plugins: [{ name: "react", setup(b) {
      b.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "g" }));
      b.onLoad({ filter: /.*/, namespace: "g" }, () => ({ contents: "module.exports=window.React;" }));
    } }],
  });
  return fromUi("react/package.json").version;
}

async function buildBundle(outDir) {
  const result = await esbuild.build({ ...iife, entryPoints: [join(here, "entry.ts")], globalName: "__ds", write: false, plugins: [reactGlobals], jsx: "automatic" });
  let js = result.outputFiles[0].text.trim();
  if (!js.startsWith("var __ds=")) throw new Error("unexpected bundle prologue");
  const header = { format: 4, namespace: NAMESPACE, components: Object.keys(COMPONENTS).map((name) => ({ name })) };
  // Consumers inline bundle.js in a <script>: neither may end or comment out that element.
  js = js.replace(/^var __ds=/, `window.${NAMESPACE}=`).replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "\\x3C!--");
  writeFileSync(join(outDir, "bundle.js"), `/* @ds-bundle: ${JSON.stringify(header)} */\n${js}\n`);
  return js.length;
}

async function buildStylesheet(outDir, names) {
  const kit = join(repoRoot, "packages/ui-kit/src/").replaceAll("\\", "/");
  const globals = readFileSync(join(repoRoot, "packages/ui/src/globals.css"), "utf8");
  // The shadcn aliases, @theme mappings, type utilities and base layer; the page-specific layers after it are not needed.
  const start = globals.indexOf("@custom-variant dark");
  const end = globals.indexOf("/* The Docs rich editor");
  if (start < 0 || end < 0) throw new Error("globals.css changed shape: update the slice in buildStylesheet");
  const input = [
    `@import "tailwindcss";`,
    `@import "tw-animate-css";`,
    ...["primitives", "colors", "typography", "spacing", "shell", "motion", "cosmic", "today"].map((f) => `@import "${kit}tokens/${f}.css";`),
    `@import "${kit}components/ui/cosmic.css";`,
    `@import "${kit}tokens/base.css" layer(base);`,
    globals.slice(start, end),
  ].join("\n");
  const compiler = await compile(input, { base: join(repoRoot, "packages/ui/src"), onDependency() {} });
  const scanner = new Scanner({ sources: [{ base: kit, pattern: "**/*", negated: false }, { base: outDir, pattern: "**/preview.html", negated: false }] });
  // tokens.css (made by the page from tokens.json) declares these; a second copy here would win over edits made on the page.
  const { css, removed } = stripDeclarations(compiler.build(scanner.scan()), names);
  if (/<\/style/i.test(css)) throw new Error("bundle.css holds </style");
  writeFileSync(join(outDir, "bundle.css"), `/* xDev Hive ui-kit: Tailwind v4 build; token values come from tokens.css */\n${css}`);
  return { size: css.length, removed };
}

function gitInfo() {
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  const ref = `${git("rev-parse", "--abbrev-ref", "HEAD")}@${git("rev-parse", "--short", "HEAD")}`;
  let repo = "";
  try {
    repo = git("remote", "get-url", "origin").replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
  } catch {}
  return { ref, repo };
}

export async function build(out) {
  const project = join(out, "project");
  const components = join(project, "components");
  rmSync(project, { recursive: true, force: true });
  mkdirSync(components, { recursive: true });
  cpSync(join(here, "system"), project, { recursive: true });

  const { tokens, missing } = buildTokens(repoRoot, { ...gitInfo(), colorUsage, shadowUsage: SHADOW_USAGE, families: FAMILIES });
  if (missing.length) console.warn(`tokens without a usage note or value (add them to usage.mjs): ${missing.join(", ")}`);
  writeFileSync(join(project, "tokens.json"), `${JSON.stringify(tokens, null, 2)}\n`);

  for (const [name, card] of Object.entries(COMPONENTS)) {
    mkdirSync(join(components, name), { recursive: true });
    writeFileSync(join(components, name, "preview.html"), previewHtml(name, card));
    writeFileSync(join(components, name, "README.md"), readmeMd(name, card));
  }

  const tmp = join(out, ".tmp");
  mkdirSync(tmp, { recursive: true });
  const react = await buildLibraries(components, tmp);
  rmSync(tmp, { recursive: true, force: true });
  const bundle = await buildBundle(components);
  const css = await buildStylesheet(components, tokenNames(tokens));

  const files = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
  console.log(`${files(project)} files in ${project}`);
  console.log(`tokens: ${tokens.color.tokens.length} colours, ${tokens.shadow.tokens.length} shadows (${tokens.meta.ref})`);
  console.log(`components: ${Object.keys(COMPONENTS).length}, bundle.js ${Math.round(bundle / 1024)} KB, bundle.css ${Math.round(css.size / 1024)} KB (${css.removed} token declarations left to tokens.css), React ${react}`);
  console.log(`index libraries: [{"name":"react","version":"${react}","global":"React","file":"components/lib/react.production.min.js"},{"name":"react-dom","version":"${react}","global":"ReactDOM","file":"components/lib/react-dom.production.min.js"}]`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: node scripts/design-system/build.mjs <out>");
    process.exit(2);
  }
  await build(resolve(out));
}
