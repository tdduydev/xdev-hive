// Docs that live in the repo (roadmap 26): `.xdev-hive/docs.json` says which file becomes which page, and the app
// mirrors them into Hive whenever the repo's main moves, so Hive shows what the repo says and the repo stays the source.
// AGENTS.md, decisions and skills go the other way (Hive → repo, see sync.ts) and cannot be mirrored.
// Browser-safe: planning reads files through a callback.
import { z } from "zod";
import { HiveError } from "./errors.ts";

export const MIRROR_CONFIG = ".xdev-hive/docs.json";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, "a page slug: lowercase letters, digits, -");
const file = z
  .string()
  .min(1)
  .max(300)
  .refine((f) => !f.startsWith("/") && !f.includes("\\") && !f.split("/").includes(".."), "a path from the repo root")
  .refine((f) => /\.md$/i.test(f), "a Markdown file");

const entry = z.union([
  /** One file, one page. */
  z.object({ file, key: slug, title: z.string().min(1).max(200).optional(), parent: slug.nullable().optional() }).strict(),
  /** One file, a page per `## section` under a folder page; what comes before the first section can be the folder's text. */
  z
    .object({
      file,
      split: z.literal("##"),
      folder: slug,
      folderTitle: z.string().min(1).max(200).optional(),
      prefix: z.string().regex(/^[a-z0-9-]{0,30}$/).default(""),
      intro: z.enum(["folder", "skip"]).default("skip"),
      /** Section titles without a leading "3. " and a trailing "(…)": "## 0. Đa ngôn ngữ (vi, en)" → "Đa ngôn ngữ". */
      short: z.boolean().default(false),
    })
    .strict(),
]);
export const mirrorConfigSchema = z.object({ docs: z.array(entry).max(50) }).strict();
export type MirrorEntry = z.output<typeof entry>;

/** Hive owns these and writes them into the repo: a mirror never overwrites them. */
const HIVE_OWNED = /^(agents|decisions)$/;

export function parseMirrorConfig(text: string): MirrorEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new HiveError("bad_request", `${MIRROR_CONFIG}: ${(err as Error).message}`, { key: "errors.mirrorConfig", vars: { reason: (err as Error).message } });
  }
  const parsed = mirrorConfigSchema.safeParse(json);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new HiveError("bad_request", `${MIRROR_CONFIG}: ${reason}`, { key: "errors.mirrorConfig", vars: { reason } });
  }
  return parsed.data.docs;
}

/** A page slug from a heading (Vietnamese marks dropped), as the Docs page makes them from titles. */
export function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

export interface MirrorPage {
  /** The page's slug in the project's space. */
  slug: string;
  title: string;
  /** null: a folder page that exists only to hold the sections (its text is left as it is in Hive). */
  content: string | null;
  parent: string | null;
  folder: boolean;
  /** Where it comes from, e.g. `README.md` or `README.md#Hub cho team`. */
  from: string;
}

/** The pages the config makes of the repo's files; `read` gives a file's text (null: not in the repo). */
export function planMirror(entries: MirrorEntry[], read: (file: string) => string | null): { pages: MirrorPage[]; missing: string[] } {
  const pages: MirrorPage[] = [];
  const missing: string[] = [];
  const add = (p: MirrorPage) => {
    if (HIVE_OWNED.test(p.slug)) throw new HiveError("bad_request", `${MIRROR_CONFIG}: ${p.slug} is written by Hive into the repo, not the other way.`, { key: "errors.mirrorOwned", vars: { slug: p.slug } });
    if (pages.some((x) => x.slug === p.slug)) throw new HiveError("bad_request", `${MIRROR_CONFIG}: two pages would be ${p.slug}.`, { key: "errors.mirrorTwice", vars: { slug: p.slug } });
    pages.push(p);
  };
  for (const e of entries) {
    const text = read(e.file);
    if (text === null) {
      missing.push(e.file);
      continue;
    }
    if (!("split" in e)) {
      const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
      add({ slug: e.key, title: e.title ?? heading ?? e.key, content: text.trim() + "\n", parent: e.parent ?? null, folder: false, from: e.file });
      continue;
    }
    const parts = text.replace(/\r\n/g, "\n").split(/\n(?=## )/);
    const intro = parts[0]!.startsWith("## ") ? "" : parts.shift()!;
    const introText = intro.replace(/^# .*\n?/, "").trim();
    add({
      slug: e.folder,
      title: e.folderTitle ?? /^#\s+(.+)$/m.exec(intro)?.[1]?.trim() ?? e.folder,
      content: e.intro === "folder" && introText ? `${introText}\n` : null,
      parent: null,
      folder: true,
      from: e.file,
    });
    for (const part of parts) {
      const heading = part.split("\n")[0]!.replace(/^##\s+/, "").trim();
      const title = e.short ? heading.replace(/^\d+[a-z]?\.\s*/, "").replace(/\s*\([^)]*\)\s*$/, "").trim() || heading : heading;
      const s = `${e.prefix}${slugFromTitle(title)}`.slice(0, 80).replace(/-+$/, "");
      if (!s) continue;
      add({ slug: s, title, content: part.split("\n").slice(1).join("\n").trim() + "\n", parent: e.folder, folder: false, from: `${e.file}#${heading}` });
    }
  }
  return { pages, missing };
}
