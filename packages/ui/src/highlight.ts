import type { Root, RootContent } from "hast";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";

/*
 * Chỉ nạp các ngôn ngữ tài liệu dự án hay dùng: highlight.js nạp đủ ~190 ngôn ngữ nặng gấp nhiều lần mà tài liệu không
 * cần. Module này nặng nên người dùng của gói tải bằng import() (code-block.tsx); trình soạn tải sẵn vì đã là chunk lazy.
 * Tô màu bằng lớp `hljs-*` (màu ở prose.css theo token) chứ không nhúng màu, để sáng/tối đổi tức thì không dựng lại.
 */
export const lowlight = createLowlight({
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  python,
  ruby,
  rust,
  sql,
  typescript,
  xml,
  yaml,
});

/** Tên hay gặp trong fence về tên chuẩn của ngôn ngữ đã đăng ký (cả bí danh highlight.js lẫn tên highlight.js không có). */
const ALIASES: Record<string, string> = {
  sh: "bash",
  js: "javascript",
  ts: "typescript",
  py: "python",
  rs: "rust",
  yml: "yaml",
  md: "markdown",
  cs: "csharp",
  h: "c",
  cc: "cpp",
  hpp: "cpp",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  tsx: "typescript",
  mts: "typescript",
  jsonc: "json",
  json5: "json",
  toml: "ini",
  html: "xml",
  vue: "xml",
  svg: "xml",
  patch: "diff",
  docker: "dockerfile",
  golang: "go",
  "c++": "cpp",
  "c#": "csharp",
  kt: "kotlin",
  rb: "ruby",
  postgres: "sql",
  postgresql: "sql",
  psql: "sql",
};

/** Tên ngôn ngữ trong fence → tên đã đăng ký, hoặc null nếu không tô được (không đoán ngôn ngữ: kết quả phải ổn định). */
export function resolveLanguage(language: string | null | undefined): string | null {
  const name = (language ?? "").trim().toLowerCase().split(/\s/)[0] ?? "";
  if (!name) return null;
  const target = ALIASES[name] ?? name;
  return lowlight.registered(target) ? target : null;
}

const LABELS: Record<string, string> = {
  bash: "Bash",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  diff: "Diff",
  dockerfile: "Dockerfile",
  go: "Go",
  ini: "TOML / INI",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  markdown: "Markdown",
  mermaid: "Mermaid",
  php: "PHP",
  python: "Python",
  ruby: "Ruby",
  rust: "Rust",
  sql: "SQL",
  typescript: "TypeScript",
  xml: "HTML / XML",
  yaml: "YAML",
};

/** Tên hiện trên đầu khối code; ngôn ngữ lạ thì giữ nguyên chữ người viết. */
export function languageLabel(language: string | null | undefined): string {
  const raw = (language ?? "").trim();
  if (!raw) return "";
  const name = raw.toLowerCase();
  return LABELS[name] ?? LABELS[resolveLanguage(name) ?? ""] ?? raw;
}

export interface Span {
  text: string;
  /** Lớp hljs-* (nhiều lớp nối bằng dấu cách) hoặc undefined với chữ thường. */
  className: string | undefined;
}
export type Line = Span[];

function collect(nodes: (Root | RootContent)[], inherited: string | undefined, lines: Line[]) {
  for (const node of nodes) {
    if (node.type === "text") {
      node.value.split("\n").forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part) lines.at(-1)?.push({ text: part, className: inherited });
      });
    } else if (node.type === "element") {
      const own = Array.isArray(node.properties.className) ? node.properties.className.join(" ") : undefined;
      collect(node.children, [inherited, own].filter(Boolean).join(" ") || undefined, lines);
    }
  }
}

/**
 * Tách code đã tô thành từng dòng để vẽ số dòng. Token nhiều dòng (chú thích khối, chuỗi nhiều dòng) giữ lớp ở mọi dòng
 * mà nó đi qua.
 */
export function highlightLines(code: string, language: string | null | undefined): Line[] {
  const lang = resolveLanguage(language);
  const lines: Line[] = [[]];
  if (!lang) {
    collect([{ type: "text", value: code }], undefined, lines);
    return lines;
  }
  collect(lowlight.highlight(lang, code).children, undefined, lines);
  return lines;
}
