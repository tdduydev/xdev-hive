// The full Lucide set from the installed lucide-react: every icon's SVG body, and which names are aliases.
// One JSON file instead of an upload per icon: the Icons page of the design system draws the grid from it.
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ATTR = /^[a-z][a-z-]*$/;
const escapeAttr = (v) => String(v).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** `[["path", {d, key}], …]` → `<path d="…"/>…`; React's `key` is not an SVG attribute. */
export function svgBody(node) {
  return node
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs).filter(([k]) => k !== "key" && ATTR.test(k)).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
      return `<${tag}${a}/>`;
    })
    .join("");
}

export async function lucideSet(resolveFrom) {
  const req = createRequire(resolveFrom);
  const pkg = req.resolve("lucide-react/package.json");
  const version = req("lucide-react/package.json").version;
  const dir = join(dirname(pkg), "dist/esm/icons");
  const icons = {};
  const byComponent = new Map();
  const aliasModules = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
    const mod = await import(pathToFileURL(join(dir, file)).href);
    const data = mod.__iconData;
    // Alias modules (activity-square → square-activity) re-export another icon and carry no data of their own.
    if (!data) aliasModules.push([file.slice(0, -4), mod.default]);
    else {
      icons[data.name] = svgBody(data.node);
      byComponent.set(mod.default, data.name);
    }
  }
  const aliases = {};
  for (const [name, component] of aliasModules) {
    const target = byComponent.get(component);
    if (target && target !== name) aliases[name] = target;
  }
  return { name: "lucide", version, license: "ISC", viewBox: "0 0 24 24", icons, aliases };
}
