// Links between doc pages and the files a page carries (roadmap 22j). Browser-safe: the page renders links and
// images with the same rules the hub uses to find backlinks.
//
//   [[deploy]]                 a page of the same space (a project's page falls back to the team's of that slug)
//   [[org/security|Bảo mật]]   any page by its key, with the text to show
//   ![Sơ đồ](assets/arch/overview.png)   a file attached to the page project/<p>/arch (or org/arch)
import { parseDocKey } from "./keys.ts";

/** Per file (as for chat files: images, PDF and text), and per page. */
export const DOC_ASSET_MAX_BYTES = 5 * 1024 * 1024;
export const DOC_ASSETS_PER_DOC = 60;

/** How deep pages nest under one another. */
export const DOC_TREE_DEPTH = 8;

const LINK = /\[\[([^\]\n|]{1,200})(?:\|([^\]\n]{1,200}))?\]\]/g;
const FENCE = /^(```|~~~)/;

/** Calls `fn` on the parts of Markdown outside code (fenced blocks and inline `code`) and joins the result. */
export function outsideCode(md: string, fn: (text: string) => string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let prose: string[] = [];
  const flush = () => {
    if (!prose.length) return;
    // Inline code spans stay as they are.
    out.push(
      prose
        .join("\n")
        .split(/(`+[^`\n]*`+)/)
        .map((part, i) => (i % 2 ? part : fn(part)))
        .join(""),
    );
    prose = [];
  };
  for (const line of md.split("\n")) {
    const m = FENCE.exec(line.trimStart());
    if (fence) {
      out.push(line);
      if (m && m[1] === fence) fence = null;
    } else if (m) {
      flush();
      fence = m[1]!;
      out.push(line);
    } else prose.push(line);
  }
  flush();
  return out.join("\n");
}

/** The owner part of a key: "org/" or "project/<p>/". */
export const keyPrefix = (key: string): string => /^project\/[^/]+\//.exec(key)?.[0] ?? "org/";

/**
 * The page a link means. A bare slug is a page of the linking page's space, else (from a project) the team's page of
 * that slug; `exists` says which pages there are. Returns the key it points at, and whether that page exists.
 */
export function resolveDocLink(target: string, from: string, exists: (key: string) => boolean): { key: string; exists: boolean } | null {
  const t = target.trim();
  const full = /^(org|project)\//.test(t);
  const candidates = full ? [t] : [keyPrefix(from) + t, ...(from.startsWith("project/") ? [`org/${t}`] : [])];
  const valid = candidates.filter((k) => {
    try {
      parseDocKey(k);
      return true;
    } catch {
      return false;
    }
  });
  if (!valid.length) return null;
  return { key: valid.find(exists) ?? valid[0]!, exists: valid.some(exists) };
}

export interface DocLinkRef {
  target: string;
  label: string | null;
}

/** The [[links]] a page's Markdown has, in order, each once. */
export function docLinkRefs(md: string): DocLinkRef[] {
  const seen = new Map<string, DocLinkRef>();
  outsideCode(md, (text) => {
    for (const m of text.matchAll(LINK)) {
      const target = m[1]!.trim();
      if (!seen.has(target)) seen.set(target, { target, label: m[2]?.trim() || null });
    }
    return text;
  });
  return [...seen.values()];
}

/** Rewrites [[links]] outside code with `to(target, label)` (the page turns them into Markdown links). */
export function replaceDocLinks(md: string, to: (target: string, label: string | null) => string): string {
  return outsideCode(md, (text) => text.replace(LINK, (_all, target: string, label?: string) => to(target.trim(), label?.trim() || null)));
}

/** A line of `md` around the first link to `key` from page `from`: what a backlink shows (links as their titles). */
export function linkSnippet(md: string, from: string, key: string, exists: (key: string) => boolean, title?: (key: string) => string | undefined): string {
  for (const line of md.split("\n")) {
    for (const m of line.matchAll(LINK)) {
      if (resolveDocLink(m[1]!, from, exists)?.key !== key) continue;
      const plain = line
        .replace(LINK, (_a, t: string, l?: string) => {
          const hit = resolveDocLink(t, from, exists);
          return l?.trim() || (hit?.exists ? title?.(hit.key) : undefined) || t.trim();
        })
        .replace(/^[#>\-*\s]+/, "")
        .trim();
      return plain.length > 160 ? `${plain.slice(0, 159)}…` : plain;
    }
  }
  return "";
}

/** `assets/<slug>/<name>` (a page's attached file) → the page's key and the file name; null for any other source. */
export function docAssetRef(src: string, from: string): { key: string; name: string } | null {
  const m = /^(?:\.\/)?assets\/([a-z0-9][a-z0-9-]{0,79})\/([^/?#]{1,200})$/.exec(src.trim());
  if (!m) return null;
  let name = m[2]!;
  try {
    name = decodeURIComponent(name);
  } catch {
    // not percent-encoded
  }
  return { key: keyPrefix(from) + m[1], name };
}

/** How a page refers to its file in Markdown. */
export function docAssetPath(key: string, name: string): string {
  const slug = key.slice(keyPrefix(key).length);
  return `assets/${slug}/${encodeURIComponent(name)}`;
}
