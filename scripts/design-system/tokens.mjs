// tokens.json of the design system artifact, read from packages/ui-kit/src/tokens/*.css.
// The values are what the app renders: the files are applied in globals.css import order, so the cosmic and
// Today layers override the 2026-09 colours where they overlap.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Import order of packages/ui/src/globals.css. */
export const TOKEN_FILES = ["primitives", "colors", "typography", "spacing", "shell", "motion", "cosmic", "today"];

/**
 * Applies the custom properties of each stylesheet in order. A rule on `:root` or bare `[data-theme]` reaches
 * both themes (the html element always matches :root, and selectors tie on specificity, so source order wins);
 * `[data-theme="dark"]` reaches dark only. @media and @keyframes blocks (reduced motion, animations) are skipped.
 */
export function cascade(sheets) {
  const light = new Map();
  const dark = new Map();
  for (const sheet of sheets) {
    const css = sheet
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@(media|keyframes)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim();
      const both = selector.includes(":root") || /\[data-theme\](?!=)/.test(selector);
      if (!both && !selector.includes('[data-theme="dark"]')) continue;
      // Split on ; outside parentheses: rgba() and gradients hold commas, not semicolons, but stay safe.
      for (const decl of m[2].split(/;(?![^(]*\))/)) {
        const i = decl.indexOf(":");
        if (i < 0) continue;
        const key = decl.slice(0, i).trim();
        if (!key.startsWith("--")) continue;
        const value = decl.slice(i + 1).trim();
        if (both) light.set(key.slice(2), value);
        dark.set(key.slice(2), value);
      }
    }
  }
  return { light, dark };
}

const isColorLiteral = (v) => /^#[0-9a-fA-F]{3,8}$/.test(v) || /^rgba?\([\d.,\s%]+\)$/.test(v);
const varRef = (v) => /^var\(--([\w-]+)\)$/.exec(v)?.[1];

/** Resolves var() references so shadows hold literal values (the page refuses var() in a shadow). */
const resolve = (map, v, depth = 0) =>
  v.replace(/var\(--([\w-]+)\)/g, (_, n) => (depth > 16 ? "" : resolve(map, map.get(n) ?? "", depth + 1)));

// Not representable as tokens (gradients, font shorthands, motion); the README describes them.
const SKIP = /^(brand-gradient|page-gradient|page-background|shell-backdrop|button-glass-overlay|font-|type-|text-body-sm$|text-caption$|text-micro$|ds-|design-|duration-|ease-|tracking-|weight-)/;
const SHADOW = /shadow|^ring-|-ring$|^hairline|glow|^shell-(ring|divider|sidebar-divider)$|^focus-ring$/;
// Named like a ring but holds a colour (the pill draws its own ring with it).
const COLOR_RINGS = new Set(["pill-violet-ring"]);
const LENGTH_FAMILIES = new Set(["focus-ring-width", "focus-ring-offset"]);

/** Splits the cascade into colour and shadow tokens; a colour that is var(--other) stays an alias "{other}". */
export function classify({ light, dark }) {
  const isColorName = (n, depth = 0) => {
    const v = light.get(n) ?? dark.get(n);
    if (!v || depth > 16) return false;
    return isColorLiteral(v) || (varRef(v) ? isColorName(varRef(v), depth + 1) : false);
  };
  const colorValue = (v) => {
    if (isColorLiteral(v)) return v.startsWith("#") ? v.toLowerCase() : v.replace(/\s+/g, "");
    const ref = varRef(v);
    return ref && isColorName(ref) ? `{${ref}}` : null;
  };
  const colors = [];
  const shadows = [];
  for (const name of new Set([...light.keys(), ...dark.keys()])) {
    if (SKIP.test(name)) continue;
    const lv = light.get(name);
    const dv = dark.get(name) ?? lv;
    if (SHADOW.test(name) && !COLOR_RINGS.has(name) && !LENGTH_FAMILIES.has(name)) {
      const l = resolve(light, lv ?? dv);
      const d = resolve(dark, dv);
      shadows.push({ name, value: l === d ? l : { light: l, dark: d } });
      continue;
    }
    const l = lv ? colorValue(lv) : null;
    const d = dv ? colorValue(dv) : null;
    if (!l && !d) continue;
    const value = {};
    if (l) value.light = l;
    if (d && d !== l) value.dark = d;
    colors.push({ name, value: Object.keys(value).length === 1 && value.light ? value.light : value });
  }
  return { colors, shadows };
}

// WCAG 2 contrast with rgba blended over its ground, to flag text pairs the source keeps below 4.5:1.
const parseColor = (v) => {
  if (v.startsWith("#")) {
    let h = v.slice(1);
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1);
  }
  return v.match(/[\d.]+/g).map(Number).concat([1]).slice(0, 4);
};
const luminance = (rgb) => {
  const f = (x) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
export function contrast(fg, bg) {
  const b = parseColor(bg);
  const f = parseColor(fg);
  const blended = [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3]));
  const [hi, lo] = [luminance(blended), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = /^(text-(strong|primary|secondary|muted|faint|link|brand)|status-\w+-fg|shell-text-faint|stage-done|mark-(ok|bad|changed|same)|diff-(add|del)-fg|chip-\w+-fg|pill-\w+-fg|os-\w+-fg|violet-soft|accent-violet-soft)$/;

export function buildTokens(repoRoot, { ref, repo, colorUsage, shadowUsage, families }) {
  const dir = join(repoRoot, "packages/ui-kit/src/tokens");
  const sheets = TOKEN_FILES.map((f) => readFileSync(join(dir, `${f}.css`), "utf8"));
  const maps = cascade(sheets);
  const { colors, shadows } = classify(maps);

  const byName = new Map(colors.map((c) => [c.name, c]));
  const valueIn = (name, theme, depth = 0) => {
    const c = byName.get(name);
    if (!c || depth > 16) return null;
    const v = typeof c.value === "string" ? c.value : (c.value[theme] ?? c.value.light);
    const alias = /^\{(.+)\}$/.exec(v);
    return alias ? valueIn(alias[1], theme, depth + 1) : v;
  };
  const missing = [];
  for (const c of colors) {
    let usage = colorUsage(c.name) ?? "";
    if (!usage) missing.push(c.name);
    if (TEXT.test(c.name)) {
      const low = [];
      for (const theme of ["light", "dark"])
        for (const ground of ["bg-canvas", "surface-1"]) {
          const r = contrast(valueIn(c.name, theme), valueIn(ground, theme));
          if (r < 4.5) low.push(`${r.toFixed(2)}:1 on ${ground} (${theme})`);
        }
      if (low.length) usage += ` Source pair below 4.5:1, kept exact: ${low.join(", ")}.`;
    }
    c.usage = usage.trim();
  }
  for (const s of shadows) {
    s.usage = shadowUsage[s.name] ?? "";
    if (!s.usage) missing.push(s.name);
  }

  const L = maps.light;
  const list = (usage) => Object.entries(usage).map(([name, u]) => {
    if (!L.has(name)) missing.push(name);
    return { name, value: L.get(name), usage: u };
  });
  return {
    tokens: {
      name: "xDev Hive",
      version: 1,
      meta: {
        source: "github",
        repo,
        ref,
        package: "packages/ui-kit",
        paths: {
          tokens: ["packages/ui-kit/src/tokens/*.css", "packages/ui/src/globals.css"],
          fonts: [],
          assets: ["packages/ui/src/assets/cosmic", "docs/design/2026-09-redesign/assets", "apps/web/client/public/favicon.svg"],
          docs: ["docs/design/2026-09-redesign/readme.md"],
        },
        synced: new Date().toISOString().slice(0, 10),
      },
      color: { themes: [{ id: "light", name: "Light" }, { id: "dark", name: "Dark" }], tokens: colors },
      type: families.type,
      spacing: { note: "4/8 px grid.", tokens: list(families.spacing) },
      radius: { tokens: list(families.radius) },
      shadow: { note: "Elevation only for floating layers; cards rest flat. Values resolved from var() references.", tokens: shadows },
      size: { note: "Control and icon sizes. [data-density=compact] sets row-h 32px, control-h-md 28px, control-h-lg 36px.", tokens: list(families.size) },
      layout: { tokens: list(families.layout) },
      border: { tokens: list(families.border) },
      zIndex: { tokens: list(families.zIndex) },
      breakpoint: { tokens: list(families.breakpoint) },
      tracking: { tokens: list(families.tracking) },
    },
    missing,
  };
}

/** Every custom property tokens.json declares, so a stylesheet can drop its own copy of them. */
export function tokenNames(tokens) {
  const names = new Set(Object.keys(tokens.type.families).map((k) => `font-${k}`));
  for (const family of Object.values(tokens)) if (family && Array.isArray(family.tokens)) for (const t of family.tokens) names.add(t.name);
  return names;
}

/** Removes declarations of the given custom properties, then the rules left empty. */
export function stripDeclarations(css, names) {
  let removed = 0;
  // Lookbehind, not a captured prefix: a match eats its own `;`, which the next declaration needs as its boundary.
  let out = css.replace(/(?<=^|[{;\s])--([\w-]+)\s*:[^;{}]*;?/g, (m, n) => (names.has(n) ? (removed++, "") : m));
  // Nested blocks empty from the inside out (a rule inside @layer inside @media…).
  for (let i = 0; i < 4; i++) out = out.replace(/(^|[{}])([^{}@;]*)\{\s*\}/g, "$1");
  return { css: out, removed };
}
