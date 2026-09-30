// A leader's reply as Markdown (GitHub's flavour): the project's task ids and run ids link to their page, code blocks
// have a copy button, and raw HTML and images are left out (see REPLY_MARKDOWN).
import { useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn } from "cn";
import { useT } from "../i18n/index.tsx";
import { remarkHiveLinks, REPLY_MARKDOWN } from "../lib/chat.ts";

const LINK = "font-medium text-primary underline underline-offset-2";

/** Copies text, and says so for a moment. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={label}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => undefined,
        )
      }
    >
      {done ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      <span>{done ? t("chat.copied") : label}</span>
    </button>
  );
}

/** The text of a rendered node (a code block's), for its copy button. */
type Hast = { type: string; value?: string; children?: Hast[] };
const textOf = (n: Hast | undefined): string => (!n ? "" : n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join(""));

function CodeBlock({ text, children }: { text: string; children: ReactNode }) {
  const t = useT();
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md bg-muted p-2 pr-20 font-mono text-xs [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs">{children}</pre>
      <CopyButton text={text.replace(/\n$/, "")} label={t("chat.copyCode")} className="absolute top-1 right-1 bg-muted/90" />
    </div>
  );
}

const components: Components = {
  a: ({ href, children }) => {
    // The ids Hive links (#/tasks?task=…) stay in the app; any other link opens apart from it.
    const inside = href?.startsWith("#/") ?? false;
    return (
      <a className={cn(LINK, inside ? "font-mono text-[0.9em]" : "break-all")} href={href} {...(inside ? {} : { target: "_blank", rel: "noreferrer noopener" })}>
        {children}
      </a>
    );
  },
  pre: ({ node, children }) => <CodeBlock text={textOf(node as Hast | undefined)}>{children}</CodeBlock>,
  code: ({ className, children }) => <code className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]", className)}>{children}</code>,
  h1: ({ children }) => <h3 className="text-base font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="text-base font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="font-semibold">{children}</h4>,
  h4: ({ children }) => <h5 className="font-medium">{children}</h5>,
  ul: ({ className, children }) => <ul className={cn("flex list-disc flex-col gap-0.5 pl-5", className?.includes("contains-task-list") && "list-none pl-1")}>{children}</ul>,
  ol: ({ start, children }) => (
    <ol start={start} className="flex list-decimal flex-col gap-0.5 pl-5">
      {children}
    </ol>
  ),
  blockquote: ({ children }) => <blockquote className="border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
  hr: () => <hr className="border-border" />,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ style, children }) => (
    <th style={style} className="border px-2 py-1 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ style, children }) => (
    <td style={style} className="border px-2 py-1 align-top">
      {children}
    </td>
  ),
};

export function ReplyMarkdown({ text, taskIds }: { text: string; taskIds: string[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 leading-relaxed wrap-anywhere">
      <Markdown {...REPLY_MARKDOWN} remarkPlugins={[remarkGfm, [remarkHiveLinks, { taskIds }]]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}
