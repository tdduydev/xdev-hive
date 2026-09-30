// A doc rendered for reading (docs/design/2026-09-redesign: Tài liệu, Xem): GitHub-flavoured Markdown in the
// design's reading type. No raw HTML. With the page it belongs to (`doc`), [[links]] to other pages open them (a broken
// one is struck through) and assets/<slug>/<name> shows the page's attached file (roadmap 22j); other images are not
// fetched and show as a labelled frame. Links to another doc key (org/…, project/…/…) open it in the app.
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "cn";
import { docAssetRef, replaceDocLinks, resolveDocLink } from "@xdev-hive/core";
import { useT } from "../i18n/index.tsx";
import { docHeadings } from "../lib/doctree.ts";
import { AssetImage, AssetLink } from "./DocAssets.tsx";

const DOC_KEY = /^(org|project)\/[a-z0-9./-]+$/i;
const LINK_SCHEME = "hive-doc:";

/** The page being shown, for its links and files. */
export interface DocContext {
  key: string;
  /** Titles of the pages that exist: a link to any other is broken. */
  titles: ReadonlyMap<string, string>;
  /** Where a link to a page goes (the Docs page or the reader, in this frame). */
  href: (key: string) => string;
}

/** The hash a doc link opens: #/docs?doc=… or, in the Web Admin, #/admin/docs?doc=… (reader: page "read"). */
export function docHref(key: string, page: "docs" | "read" = "docs"): string {
  const admin = typeof window !== "undefined" && window.location.hash.startsWith("#/admin/");
  return `#/${admin ? "admin/" : ""}${page}?doc=${encodeURIComponent(key)}`;
}

const escapeLabel = (s: string) => s.replace(/([[\]\\])/g, "\\$1");

export function DocMarkdown({ text, className, doc, headingIds }: { text: string; className?: string; doc?: DocContext; headingIds?: boolean }) {
  const t = useT();
  const exists = (k: string) => doc?.titles.has(k) ?? false;
  const source = doc
    ? replaceDocLinks(text, (target, label) => {
        const hit = resolveDocLink(target, doc.key, exists);
        const shown = label ?? (hit?.exists ? doc.titles.get(hit.key)! : target);
        return `[${escapeLabel(shown)}](${LINK_SCHEME}${encodeURIComponent(target)})`;
      })
    : text;
  // A ## / ### gets the id the table of contents gives it, found by its line (rewriting links keeps the lines).
  const ids = new Map(headingIds ? docHeadings(text).map((h) => [h.line, h.id]) : []);
  const heading = (node: { position?: { start: { line: number } } } | undefined) => {
    const id = node?.position ? ids.get(node.position.start.line) : undefined;
    return id ? { id, className: "scroll-mt-4" } : {};
  };
  const components: Components = {
    h1: ({ children }) => <h1 className="m-0 mb-1 font-display text-[26px]/[34px] font-semibold tracking-[-0.01em] text-fg-strong">{children}</h1>,
    h2: ({ node, children }) => {
      const h = heading(node);
      return (
        <h2 id={h.id} className={cn("m-0 mt-2.5 font-display text-[17px]/6 font-semibold text-fg-strong", h.className)}>
          {children}
        </h2>
      );
    },
    h3: ({ node, children }) => {
      const h = heading(node);
      return (
        <h3 id={h.id} className={cn("m-0 mt-2 text-[15px]/6 font-semibold text-fg-strong", h.className)}>
          {children}
        </h3>
      );
    },
    h4: ({ children }) => <h4 className="m-0 mt-1.5 text-sm/[22px] font-semibold text-fg-strong">{children}</h4>,
    p: ({ children }) => <p className="m-0 text-[15px]/[25px] text-pretty text-fg-primary">{children}</p>,
    ul: ({ className: c, children }) => (
      <ul
        className={cn(
          "m-0 flex list-disc flex-col gap-0.5 pl-6 text-[15px]/[25px] text-fg-primary marker:text-fg-muted",
          c?.includes("contains-task-list") && "list-none pl-1",
        )}
      >
        {children}
      </ul>
    ),
    ol: ({ start, children }) => (
      <ol start={start} className="m-0 flex list-decimal flex-col gap-0.5 pl-6 text-[15px]/[25px] text-fg-primary marker:text-fg-muted">
        {children}
      </ol>
    ),
    blockquote: ({ children }) => (
      <blockquote className="m-0 rounded-md bg-info-soft px-3.5 py-2 text-sm/[22px] text-fg-strong [&_p]:text-sm/[22px] [&_p]:text-fg-strong">
        {children}
      </blockquote>
    ),
    pre: ({ children }) => (
      <pre className="m-0 overflow-x-auto rounded-md border border-line-subtle bg-code px-3.5 py-3 font-mono text-xs/5 whitespace-pre-wrap text-code-fg [overflow-wrap:anywhere] [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs">
        {children}
      </pre>
    ),
    code: ({ className: c, children }) => (
      <code className={cn("rounded-xs border border-line-subtle bg-code px-[5px] py-px font-mono text-[0.85em] text-code-fg", c)}>{children}</code>
    ),
    a: ({ href, children }) => {
      if (doc && href?.startsWith(LINK_SCHEME)) {
        const target = decodeURIComponent(href.slice(LINK_SCHEME.length));
        const hit = resolveDocLink(target, doc.key, exists);
        if (!hit?.exists) {
          return (
            <span title={t("docs.brokenLink", { target })} className="rounded-xs bg-danger-soft px-1 text-danger line-through decoration-danger/60">
              {children}
            </span>
          );
        }
        return (
          <a
            href={doc.href(hit.key)}
            title={hit.key}
            className="rounded-xs bg-selected px-1 font-medium text-selected-fg no-underline outline-none hover:underline focus-visible:focus-ring"
          >
            {children}
          </a>
        );
      }
      const file = doc && href ? docAssetRef(href, doc.key) : null;
      if (file) {
        return (
          <AssetLink docKey={file.key} name={file.name}>
            {children}
          </AssetLink>
        );
      }
      const key = href && DOC_KEY.test(href) ? href : null;
      return (
        <a
          href={key ? docHref(key) : href}
          className="font-medium text-fg-link underline underline-offset-2 hover:text-fg-link-hover"
          {...(key || href?.startsWith("#") ? {} : { target: "_blank", rel: "noreferrer noopener" })}
        >
          {children}
        </a>
      );
    },
    img: ({ src, alt }) => {
      const file = doc && typeof src === "string" ? docAssetRef(src, doc.key) : null;
      if (file) return <AssetImage docKey={file.key} name={file.name} alt={alt ?? ""} />;
      return (
        <span className="my-1 flex flex-col gap-1.5">
          <span className="grid h-40 place-items-center rounded-md border border-dashed border-line-control bg-subtle font-mono text-xs text-fg-muted">
            {t("docs.image", { src: String(src ?? "") })}
          </span>
          {alt ? <span className="text-xs text-fg-muted">{alt}</span> : null}
        </span>
      );
    },
    hr: () => <hr className="my-1 border-line-subtle" />,
    table: ({ children }) => (
      <div className="overflow-x-auto rounded-md border border-line-default">
        <table className="w-full border-collapse text-[13px]/5">{children}</table>
      </div>
    ),
    th: ({ style, children }) => (
      <th style={style} className="border-b border-line-subtle bg-sunken px-3 py-2 text-left type-caption text-fg-muted">
        {children}
      </th>
    ),
    td: ({ style, children }) => (
      <td style={style} className="border-t border-line-subtle px-3 py-2 align-top text-fg-primary">
        {children}
      </td>
    ),
  };
  return (
    <article className={cn("flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere]", className)}>
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={(url) => (url.startsWith(LINK_SCHEME) ? url : defaultUrlTransform(url))}
      >
        {source}
      </Markdown>
    </article>
  );
}
