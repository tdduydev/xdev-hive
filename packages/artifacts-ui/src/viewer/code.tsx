import { cn } from "cn";
import { type CSSProperties, useEffect, useId, useState } from "react";
import { useText } from "../env.tsx";
import type { CodeToken } from "./highlight.ts";

/**
 * Nguồn có số dòng, tô màu bằng shiki. Token thành `span` chữ (không `innerHTML`) nên nội dung do agent viết không bao
 * giờ thành HTML; shiki nặng nên chỉ tải khi có trình xem code trên màn.
 */
export function CodeViewer({ content, language }: { content: string; language: string | null }) {
  const t = useText();
  const wrapId = useId();
  const [wrap, setWrap] = useState(true);
  const [tokens, setTokens] = useState<CodeToken[][] | null>(null);

  useEffect(() => {
    let live = true;
    setTokens(null);
    if (language)
      void import("./highlight.ts")
        .then((m) => m.highlight(content, language))
        .then((result) => {
          if (live) setTokens(result);
        });
    return () => {
      live = false;
    };
  }, [content, language]);

  const lines =
    tokens ??
    content
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => [{ content: line } as CodeToken]);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor={wrapId} className="flex items-center gap-2 self-start text-sm">
        <input id={wrapId} type="checkbox" checked={wrap} onChange={() => setWrap(!wrap)} />
        {t.wrap}
      </label>
      <pre
        className={cn(
          "m-0 rounded-md bg-muted p-3 font-mono text-[0.8125rem] leading-relaxed",
          wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre",
        )}
        data-language={language ?? undefined}
      >
        <code className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4">
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: số dòng là khoá tự nhiên.
            <CodeLine key={i} n={i + 1} line={line} />
          ))}
        </code>
      </pre>
    </div>
  );
}

function CodeLine({ n, line }: { n: number; line: CodeToken[] }) {
  return (
    <>
      <span aria-hidden className="select-none text-right text-muted-foreground tabular-nums">
        {n}
      </span>
      <span>
        {line.map((token, i) =>
          token.light || token.dark ? (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: token trong một dòng không đổi thứ tự.
              key={i}
              className="text-(--shiki-light) dark:text-(--shiki-dark)"
              style={{ "--shiki-light": token.light, "--shiki-dark": token.dark } as CSSProperties}
            >
              {token.content}
            </span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: token trong một dòng không đổi thứ tự.
            <span key={i}>{token.content}</span>
          ),
        )}
        {line.length === 0 || line.every((token) => token.content === "") ? "\n" : null}
      </span>
    </>
  );
}
