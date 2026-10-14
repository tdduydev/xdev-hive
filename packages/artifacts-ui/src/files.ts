import type { ArtifactSummary, ArtifactType } from "@xdev-hive/contracts";

const TYPE_EXT: Record<ArtifactType, string> = {
  markdown: "md",
  code: "txt",
  html: "html",
  react: "tsx",
  svg: "svg",
  mermaid: "mmd",
  csv: "csv",
  json: "json",
  image: "bin",
  pdf: "pdf",
};

const CODE_EXT: Record<string, string> = {
  bash: "sh",
  c: "c",
  "c#": "cs",
  "c++": "cpp",
  cpp: "cpp",
  csharp: "cs",
  css: "css",
  dart: "dart",
  go: "go",
  html: "html",
  java: "java",
  javascript: "js",
  js: "js",
  json: "json",
  jsx: "jsx",
  kotlin: "kt",
  php: "php",
  py: "py",
  python: "py",
  rb: "rb",
  ruby: "rb",
  rs: "rs",
  rust: "rs",
  sh: "sh",
  shell: "sh",
  sql: "sql",
  swift: "swift",
  ts: "ts",
  tsx: "tsx",
  typescript: "ts",
  yaml: "yaml",
  yml: "yml",
};

/** Tên tệp khi tải về: tiêu đề bỏ ký tự hệ điều hành cấm, đuôi theo loại (code theo ngôn ngữ). */
export function artifactFileName(artifact: Pick<ArtifactSummary, "title" | "type" | "language">): string {
  const base =
    artifact.title
      .normalize("NFC")
      .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "artifact";
  const ext =
    artifact.type === "code" ? (CODE_EXT[artifact.language?.toLowerCase() ?? ""] ?? "txt") : TYPE_EXT[artifact.type];
  return `${base}.${ext}`;
}

/** Ngôn ngữ tô màu khi xem nguồn. */
export function sourceLanguage(artifact: Pick<ArtifactSummary, "type" | "language">): string | null {
  switch (artifact.type) {
    case "code":
      return artifact.language;
    case "html":
      return "html";
    case "react":
      return "tsx";
    case "mermaid":
      return "mermaid";
    case "markdown":
      return "markdown";
    case "svg":
      return "xml";
    case "json":
      return "json";
    default:
      return null;
  }
}

/** Tải chữ về máy bằng `<a download>` trên blob: không cần quyền ghi tệp của app desktop. */
export function downloadText(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
