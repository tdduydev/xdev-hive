import type { DirectExport } from "es-module-lexer";
import { parse } from "es-module-lexer/js";
import { BOOTSTRAP_SOURCE } from "./bootstrap.ts";
import { libSource } from "./csp.ts";
import type { LibManifest } from "./manifest.ts";
import { MAX_FRAME_TEXT } from "./messages.ts";

/** Loại đã có nhánh dựng; `pdf` và `csv-chart` do T061–T062 thêm vào đây. */
export const FRAME_TYPES = ["html", "mermaid", "svg", "react", "markdown", "code"] as const;
export type FrameType = (typeof FRAME_TYPES)[number];
export type FrameTheme = "light" | "dark";

export interface FrameDocumentInput {
  type: FrameType;
  content: string;
  /** Bản ESM đã biên dịch của `react` (T014). */
  compiled?: string | null;
  /** Lỗi biên dịch của `react`; có thì trang hiện lỗi thay cho nội dung. */
  compileError?: string | null;
  theme: FrameTheme;
  manifest: LibManifest;
  /** Thư mục thư viện: `https://<hub>/_artifact/lib/` hoặc `hive-artifact://…/lib/` ở app. */
  libBase: string;
}

const REACT_MODULES = ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "recharts", "lucide-react"];

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** JSON an toàn khi nằm trong `<script>`: không có `</script` hay `<!--` (đều cần `<`). */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

/**
 * Mã JS có sẵn (bản biên dịch của agent) nằm trong `<script type="module">`. Chỉ cần ngăn thoát khỏi khối: `</script` kết
 * thúc thẻ, `<!--` mở trạng thái "script escaped" của bộ phân tích HTML. Thay bằng dạng escape hợp lệ ở chuỗi, regex và template.
 */
export function escapeInlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\x21--");
}

function entry(manifest: LibManifest, name: string) {
  const e = manifest[name];
  if (!e) throw new Error(`Thiếu thư viện "${name}" trong manifest`);
  return e;
}

function libUrl(base: string, path: string): string {
  return `${base}${path}`;
}

function importMap(manifest: LibManifest, base: string, names: string[]): string {
  const imports: Record<string, string> = {};
  const integrity: Record<string, string> = {};
  for (const name of names) {
    const e = entry(manifest, name);
    const url = libUrl(base, e.path);
    imports[name] = url;
    integrity[url] = e.integrity;
  }
  return `<script type="importmap">${jsonForScript({ imports, integrity })}</script>`;
}

function themeCss(theme: FrameTheme): string {
  return `html{color-scheme:${theme}}body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}`;
}

/** Tailwind bản trình duyệt: `dark:` theo chủ đề của hub (khung nhận qua tham số), không theo `prefers-color-scheme`. */
function tailwindTags(manifest: LibManifest, base: string): string {
  const e = entry(manifest, "@tailwindcss/browser");
  return (
    `<script src="${escapeHtml(libUrl(base, e.path))}" integrity="${escapeHtml(e.integrity)}" crossorigin="anonymous"></script>` +
    '<style type="text/tailwindcss">@custom-variant dark (&:where([data-hive-theme=dark], [data-hive-theme=dark] *));</style>'
  );
}

function head(extra: string): string {
  return (
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<meta name="referrer" content="no-referrer"><script>${BOOTSTRAP_SOURCE}</script>${extra}`
  );
}

function page(theme: FrameTheme, headExtra: string, body: string): string {
  return `<!doctype html><html data-hive-theme="${theme}"><head>${head(headExtra)}</head><body>${body}</body></html>`;
}

/**
 * Trang lỗi cho phiên bản không chạy được. Gửi tin `error` để khung bên cạnh hiện "Nhờ Leader sửa" kể cả khi chưa có script
 * nào của artifact chạy (bootstrap chỉ bắt lỗi phát sinh sau khi nó nạp).
 */
function errorPage(theme: FrameTheme, kind: "compile" | "runtime", title: string, message: string): string {
  const text = message.slice(0, MAX_FRAME_TEXT);
  const style = `<style>${themeCss(theme)}main{padding:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace}</style>`;
  const report = `<script>window.parent.postMessage({type:"error",kind:${jsonForScript(kind)},message:${jsonForScript(text)}},"*")</script>`;
  return page(
    theme,
    style,
    `<main role="alert"><h1 style="font-size:1.125rem">${escapeHtml(title)}</h1><pre>${escapeHtml(text)}</pre></main>${report}`,
  );
}

const REACT_ROOT = "__hiveComponent";

/**
 * Đưa `export default` của bản biên dịch về một tên mà đoạn mount gọi được. Export mặc định kiểu biểu thức không có tên để
 * tham chiếu, nên viết lại đúng cụm `export default` thành khai báo; hàm/lớp có tên và `export { X as default }` giữ nguyên
 * và chỉ thêm khai báo trỏ tới tên đó, để hàm vẫn được hoist như mã gốc.
 */
function mountableModule(compiled: string): string | null {
  const [, exports] = parse(compiled);
  const def = exports.find((e): e is DirectExport => e.type === "direct" && e.name === "default");
  if (!def) return null;
  const assign = `;const ${REACT_ROOT} = `;
  let code = compiled;
  let tail = "";
  if (def.localName) {
    tail = `${assign}${def.localName};`;
  } else if (/^export\s+default$/.test(compiled.slice(def.exportStart, def.end))) {
    code = `${compiled.slice(0, def.exportStart)}const ${REACT_ROOT} =${compiled.slice(def.end)}`;
  } else {
    return null;
  }
  return [
    'import * as __hiveReact from "react";',
    'import { createRoot as __hiveCreateRoot } from "react-dom/client";',
    code,
    tail,
    `\n__hiveCreateRoot(document.getElementById("root")).render(__hiveReact.createElement(${REACT_ROOT}));`,
  ].join("\n");
}

function reactPage(input: FrameDocumentInput, base: string): string {
  const { theme, compiled, compileError, manifest } = input;
  if (compileError) return errorPage(theme, "compile", "Lỗi biên dịch", compileError);
  if (!compiled) return errorPage(theme, "runtime", "Chưa có bản chạy được", "Phiên bản này chưa có bản biên dịch.");
  let module: string | null;
  try {
    module = mountableModule(compiled);
  } catch (error) {
    return errorPage(theme, "compile", "Lỗi biên dịch", error instanceof Error ? error.message : String(error));
  }
  if (!module) {
    return errorPage(theme, "runtime", "Thiếu export default", "Artifact react cần `export default` là component gốc.");
  }
  return page(
    theme,
    `${importMap(manifest, base, REACT_MODULES)}${tailwindTags(manifest, base)}<style>${themeCss(theme)}</style>`,
    `<div id="root"></div><script type="module">${escapeInlineScript(module)}</script>`,
  );
}

function mermaidPage({ content, theme, manifest }: FrameDocumentInput, base: string): string {
  // Nguồn đi qua JSON chứ không nằm trong HTML nên không có đường thoát khỏi thẻ, và đọc ra nguyên văn.
  const script = `import mermaid from "mermaid";
const out = document.getElementById("out");
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: ${jsonForScript(theme === "dark" ? "dark" : "default")}, suppressErrorRendering: true });
try {
  const { svg } = await mermaid.render("hive-diagram", ${jsonForScript(content)});
  out.innerHTML = svg;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  out.textContent = message;
  console.error("Mermaid: " + message);
}`;
  return page(
    theme,
    `${importMap(manifest, base, ["mermaid"])}<style>${themeCss(theme)}#out{padding:1rem;overflow:auto}#out svg{max-width:100%;height:auto}</style>`,
    `<div id="out"></div><script type="module">${escapeInlineScript(script)}</script>`,
  );
}

const MARKDOWN_CSS = `.md{max-width:72ch;margin:0 auto;padding:1rem 1.25rem;overflow-wrap:anywhere}.md h1,.md h2,.md h3{line-height:1.25;margin:1.5em 0 .5em}.md h1{font-size:1.5rem}.md h2{font-size:1.25rem}.md h3{font-size:1.0625rem}.md p,.md ul,.md ol,.md blockquote,.md pre,.md table{margin:0 0 1em}.md code{font:.875em ui-monospace,monospace;background:rgba(127,127,127,.18);padding:.1em .3em;border-radius:4px}.md pre{overflow:auto;padding:.75rem 1rem;background:rgba(127,127,127,.14);border-radius:6px}.md pre code{background:none;padding:0}.md blockquote{margin-left:0;padding-left:1rem;border-left:3px solid rgba(127,127,127,.5)}.md table{border-collapse:collapse;display:block;overflow:auto}.md th,.md td{border:1px solid rgba(127,127,127,.5);padding:.35rem .6rem}.md img{max-width:100%}`;

function markdownPage({ content, theme, manifest }: FrameDocumentInput, base: string): string {
  // `html: false` để thẻ HTML trong markdown thành chữ. Liên kết thành chữ kèm địa chỉ: bấm vào sẽ điều hướng chính khung
  // (sandbox chỉ chặn trang cha), và trang công khai không nên dẫn người xem đi đâu từ một nội dung do agent viết.
  const script = `import MarkdownIt from "markdown-it";
const md = new MarkdownIt({ html: false, linkify: false });
const root = document.getElementById("md");
root.innerHTML = md.render(${jsonForScript(content)});
for (const a of Array.from(root.querySelectorAll("a"))) {
  const span = document.createElement("span");
  const href = a.getAttribute("href") || "";
  span.textContent = a.textContent === href || !href ? a.textContent : a.textContent + " (" + href + ")";
  a.replaceWith(span);
}`;
  return page(
    theme,
    `${importMap(manifest, base, ["markdown-it"])}<style>${themeCss(theme)}${MARKDOWN_CSS}</style>`,
    `<article class="md" id="md"></article><script type="module">${escapeInlineScript(script)}</script>`,
  );
}

function codePage({ content, theme }: FrameDocumentInput): string {
  const style = `<style>${themeCss(theme)}pre{margin:0;padding:1rem;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace}</style>`;
  return page(theme, style, `<pre><code>${escapeHtml(content)}</code></pre>`);
}

/**
 * HTML của agent giữ nguyên văn: bootstrap đứng trước nội dung trong một `<head>` còn mở. Bộ phân tích HTML gộp
 * `<html>`/`<head>` của người dùng vào phần này (thuộc tính html được trộn, `<head>` thừa bị bỏ, thẻ trong head vẫn vào head),
 * nên chạy đúng cả khi nội dung không có `<head>` hay không có `<html>`.
 */
function htmlPage({ content, theme }: FrameDocumentInput): string {
  return `<!doctype html><html data-hive-theme="${theme}"><head>${head("")}${content}`;
}

function svgPage({ content, theme }: FrameDocumentInput): string {
  // Nhúng SVG vào trang (không dùng `<img>`) để giữ tương tác và hoạt ảnh có script; khung đã cách ly.
  return page(theme, `<style>${themeCss(theme)}svg{max-width:100%;height:auto}</style>`, content);
}

/**
 * Tài liệu HTML đầy đủ cho một khung cách ly. Hub dựng (route khung, trang công khai) và app dùng lại qua
 * `artifacts.frameDocument`, nên không có bản sao logic ở hai nơi. Nội dung của agent không bao giờ đi qua `innerHTML` của
 * trang cha: mọi thứ nằm trong tài liệu này, chạy trong iframe `sandbox="allow-scripts"` với CSP của `buildCsp`.
 */
export function buildFrameDocument(input: FrameDocumentInput): string {
  const base = libSource(input.libBase);
  switch (input.type) {
    case "html":
      return htmlPage(input);
    case "svg":
      return svgPage(input);
    case "mermaid":
      return mermaidPage(input, base);
    case "react":
      return reactPage(input, base);
    case "markdown":
      return markdownPage(input, base);
    case "code":
      return codePage(input);
    default:
      throw new Error(`Loại "${input.type as string}" chưa có khung cách ly`);
  }
}
