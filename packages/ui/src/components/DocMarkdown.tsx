// A doc rendered for reading (docs/design/2026-09-redesign: Tài liệu, Xem): GitHub-flavoured Markdown in the
// design's reading type. No raw HTML; images are not fetched (a doc's images arrive with roadmap 22j) and show as
// a labelled frame. Links to another doc key (org/…, project/…/…) open it in the app.
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "cn";
import { useT } from "../i18n/index.tsx";

const DOC_KEY = /^(org|project)\/[a-z0-9./-]+$/i;

export function DocMarkdown({ text, className }: { text: string; className?: string }) {
  const t = useT();
  const components: Components = {
    h1: ({ children }) => <h1 className="m-0 mb-1 font-display text-[26px]/[34px] font-semibold tracking-[-0.01em] text-fg-strong">{children}</h1>,
    h2: ({ children }) => <h2 className="m-0 mt-2.5 font-display text-[17px]/6 font-semibold text-fg-strong">{children}</h2>,
    h3: ({ children }) => <h3 className="m-0 mt-2 text-[15px]/6 font-semibold text-fg-strong">{children}</h3>,
    h4: ({ children }) => <h4 className="m-0 mt-1.5 text-sm/[22px] font-semibold text-fg-strong">{children}</h4>,
    p: ({ children }) => <p className="m-0 text-[15px]/[25px] text-pretty text-fg-primary">{children}</p>,
    ul: ({ className: c, children }) => (
      <ul className={cn("m-0 flex list-disc flex-col gap-0.5 pl-6 text-[15px]/[25px] text-fg-primary marker:text-fg-muted", c?.includes("contains-task-list") && "list-none pl-1")}>{children}</ul>
    ),
    ol: ({ start, children }) => (
      <ol start={start} className="m-0 flex list-decimal flex-col gap-0.5 pl-6 text-[15px]/[25px] text-fg-primary marker:text-fg-muted">
        {children}
      </ol>
    ),
    blockquote: ({ children }) => <blockquote className="m-0 rounded-md bg-info-soft px-3.5 py-2 text-sm/[22px] text-fg-strong [&_p]:text-sm/[22px] [&_p]:text-fg-strong">{children}</blockquote>,
    pre: ({ children }) => (
      <pre className="m-0 overflow-x-auto rounded-md border border-line-subtle bg-code px-3.5 py-3 font-mono text-xs/5 whitespace-pre-wrap text-code-fg [overflow-wrap:anywhere] [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs">
        {children}
      </pre>
    ),
    code: ({ className: c, children }) => <code className={cn("rounded-xs border border-line-subtle bg-code px-[5px] py-px font-mono text-[0.85em] text-code-fg", c)}>{children}</code>,
    a: ({ href, children }) => {
      const doc = href && DOC_KEY.test(href) ? href : null;
      return (
        <a
          href={doc ? `#/docs?doc=${encodeURIComponent(doc)}` : href}
          className="font-medium text-fg-link underline underline-offset-2 hover:text-fg-link-hover"
          {...(doc || href?.startsWith("#") ? {} : { target: "_blank", rel: "noreferrer noopener" })}
        >
          {children}
        </a>
      );
    },
    img: ({ src, alt }) => (
      <span className="my-1 flex flex-col gap-1.5">
        <span className="grid h-40 place-items-center rounded-md border border-dashed border-line-control bg-subtle font-mono text-xs text-fg-muted">{t("docs.image", { src: String(src ?? "") })}</span>
        {alt ? <span className="text-xs text-fg-muted">{alt}</span> : null}
      </span>
    ),
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
      <Markdown skipHtml remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </article>
  );
}
