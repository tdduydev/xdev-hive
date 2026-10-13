"use client";

import { cn } from "cn";
import { CheckIcon, CopyIcon, ListOrderedIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Line } from "./highlight.ts";
import { type ProseLang, pageLang, proseText } from "./prose-text.ts";

type HighlightModule = typeof import("./highlight.ts");

let loaded: HighlightModule | null = null;
let loading: Promise<HighlightModule> | null = null;

/** highlight.js nặng: chỉ tải khi có khối code cần tô, và chỉ tải một lần cho cả trang. */
function loadHighlight(): Promise<HighlightModule> {
  loading ??= import("./highlight.ts").then((m) => {
    loaded = m;
    return m;
  });
  return loading;
}

function useHighlight(): HighlightModule | null {
  const [mod, setMod] = useState<HighlightModule | null>(loaded);
  useEffect(() => {
    if (loaded) return;
    let alive = true;
    loadHighlight().then(
      (m) => alive && setMod(m),
      // Tải chunk lỗi (mạng): khối code vẫn đọc được, chỉ không có màu.
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);
  return mod;
}

/** Nút chép dùng chung cho khối code ở chế độ xem và trình soạn. */
export function CopyButton({
  text,
  lang = pageLang(),
  className,
}: {
  text: string;
  lang?: ProseLang;
  className?: string;
}) {
  const t = proseText[lang];
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      title={t.copyCode}
      aria-label={t.copyCode}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setDone(false), 1500);
          },
          () => {},
        );
      }}
      className={cn("hive-code-btn", className)}
    >
      {done ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      <span>{done ? t.copied : t.copy}</span>
    </button>
  );
}

function Lines({ lines, numbered }: { lines: Line[]; numbered: boolean }) {
  return lines.map((line, i) => (
    // Dòng của code tĩnh: vị trí là danh tính của dòng.
    // biome-ignore lint/suspicious/noArrayIndexKey: dòng không có id riêng
    <span key={i} className={cn("hive-line", numbered && "hive-line-num")}>
      {line.map((span, j) =>
        span.className ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: đoạn chữ không có id riêng
          <span key={j} className={span.className}>
            {span.text}
          </span>
        ) : (
          span.text
        ),
      )}
      {i < lines.length - 1 ? "\n" : null}
    </span>
  ));
}

/**
 * Khối code của chế độ xem Markdown: tên ngôn ngữ, nút chép, số dòng tuỳ chọn, cuộn ngang. Cùng khung CSS (`hive-code`)
 * với trình soạn nên hai chế độ giống nhau.
 */
export function CodeBlock({
  code,
  language,
  lineNumbers = false,
  lang = pageLang(),
  actions,
  className,
}: {
  code: string;
  language?: string | null | undefined;
  lineNumbers?: boolean | undefined;
  lang?: ProseLang;
  /** Nút thêm cạnh nút chép (vd. bật tắt mã nguồn của sơ đồ). */
  actions?: ReactNode;
  className?: string;
}) {
  const t = proseText[lang];
  const mod = useHighlight();
  const [numbered, setNumbered] = useState(lineNumbers);
  // Bỏ dòng trống cuối do fence kết thúc bằng xuống dòng.
  const text = code.replace(/\n$/, "");
  const lines = useMemo(
    () =>
      mod
        ? mod.highlightLines(text, language)
        : text.split("\n").map((row): Line => (row ? [{ text: row, className: undefined }] : [])),
    [mod, text, language],
  );
  const label = mod?.languageLabel(language) ?? (language ?? "").trim();
  return (
    <figure className={cn("hive-code", className)} data-language={mod?.resolveLanguage(language) ?? undefined}>
      <figcaption className="hive-code-bar">
        <span className="hive-code-lang">{label}</span>
        <span className="flex-1" />
        {actions}
        {lines.length > 1 && (
          <button
            type="button"
            title={t.lineNumbers}
            aria-label={t.lineNumbers}
            aria-pressed={numbered}
            onClick={() => setNumbered((v) => !v)}
            className="hive-code-btn"
          >
            <ListOrderedIcon aria-hidden="true" />
          </button>
        )}
        <CopyButton text={text} lang={lang} />
      </figcaption>
      {/* Vùng cuộn ngang phải focus được bằng bàn phím để người không dùng chuột đọc hết dòng dài. */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: vùng cuộn được */}
      <pre tabIndex={0}>
        <code className="hljs">
          <Lines lines={lines} numbered={numbered} />
        </code>
      </pre>
    </figure>
  );
}
