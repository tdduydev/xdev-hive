import { parse } from "es-module-lexer/js";
import { describe, expect, it } from "vitest";
import { BOOTSTRAP_SOURCE } from "./bootstrap.ts";
import { buildCsp } from "./csp.ts";
import { LIB_BASE, TEST_MANIFEST } from "./fixtures.ts";
import { buildFrameDocument, escapeInlineScript, type FrameDocumentInput, jsonForScript } from "./frame-document.ts";

const build = (input: Partial<FrameDocumentInput> & Pick<FrameDocumentInput, "type" | "content">) =>
  buildFrameDocument({ theme: "light", manifest: TEST_MANIFEST, libBase: LIB_BASE, ...input });

// Snapshot không ôm cả bootstrap (đã có test riêng); đổi nó thành nhãn để diff dễ đọc.
const readable = (doc: string) => doc.replace(BOOTSTRAP_SOURCE, "<BOOTSTRAP>");

const modules = (doc: string) =>
  [...doc.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);
const tag = (doc: string, re: RegExp) => (doc.match(re) ?? []).length;

describe("buildFrameDocument · snapshot theo loại", () => {
  it("html", () => {
    expect(readable(build({ type: "html", content: "<h1>Xin chào</h1>" }))).toMatchSnapshot();
  });
  it("mermaid", () => {
    expect(readable(build({ type: "mermaid", content: "graph TD; A-->B", theme: "dark" }))).toMatchSnapshot();
  });
  it("svg", () => {
    expect(
      readable(build({ type: "svg", content: '<svg width="10" height="10"><circle r="4"/></svg>' })),
    ).toMatchSnapshot();
  });
  it("react", () => {
    const compiled = 'import { useState } from "react";\nexport default function App() { return useState(1)[0]; }';
    expect(readable(build({ type: "react", content: "", compiled, theme: "dark" }))).toMatchSnapshot();
  });
  it("react có lỗi biên dịch", () => {
    expect(readable(build({ type: "react", content: "", compileError: "Unexpected token (3:4)" }))).toMatchSnapshot();
  });
  it("markdown", () => {
    expect(readable(build({ type: "markdown", content: "# Tiêu đề\n\nchữ **đậm**" }))).toMatchSnapshot();
  });
  it("code", () => {
    expect(readable(build({ type: "code", content: "const a = 1 < 2;" }))).toMatchSnapshot();
  });
  it("csv (biểu đồ)", () => {
    expect(readable(build({ type: "csv", content: "Tháng,Thu\nT1,10\nT2,20" }))).toMatchSnapshot();
  });
});

describe("buildFrameDocument · svg và csv", () => {
  it("svg giữ nguyên văn trong khung, không qua script của runtime", () => {
    const doc = build({ type: "svg", content: "<svg><text>a</text></svg>" });
    expect(doc).toContain("<svg><text>a</text></svg>");
    expect(modules(doc)).toHaveLength(0);
  });

  it("csv: dữ liệu đi qua JSON, không thoát khỏi khối script", () => {
    const evil = "x</script><script>window.pwned=1</script>";
    const doc = build({ type: "csv", content: `a,b\n"${evil}",1\n` });
    expect(modules(doc)).toHaveLength(1);
    expect(tag(doc, /<script>window\.pwned/g)).toBe(0);
    expect(modules(doc)[0]).toContain("\\u003c/script");
  });

  it("csv: import map chỉ có thư viện của hub và có SRI", () => {
    const doc = build({ type: "csv", content: "a,b\n1,2" });
    expect(doc).toContain('"recharts"');
    expect(doc).toContain(LIB_BASE);
    expect(doc).toContain("sha384-");
  });

  it("csv không có cột số thì hiện thông báo, không nạp thư viện", () => {
    const doc = build({ type: "csv", content: "a,b\nx,y" });
    expect(doc).toContain("Không có cột số");
    expect(modules(doc)).toHaveLength(0);
    expect(doc).not.toContain("importmap");
  });
});

describe("buildFrameDocument · image và pdf", () => {
  const blobUrl = "https://hive.example.com/_artifact/blob/ticket.sig";

  it("image: thẻ img trỏ vào blobUrl, không script của runtime", () => {
    const doc = build({ type: "image", content: "", blobUrl });
    expect(doc).toContain(`<img alt="Ảnh" src="${blobUrl}"`);
    expect(modules(doc)).toHaveLength(0);
    expect(doc).not.toContain("importmap");
  });

  it("image: blobUrl được escape để không thoát khỏi thuộc tính", () => {
    const doc = build({ type: "image", content: "", blobUrl: 'https://h.example/b/"><script>1</script>' });
    expect(doc).not.toContain("<script>1</script>");
  });

  it("image và pdf không có blobUrl thì hiện trang lỗi, không trang trắng", () => {
    for (const type of ["image", "pdf"] as const) {
      const doc = build({ type, content: "" });
      expect(doc).toContain("Chưa có tệp");
      expect(doc).toContain('kind:"runtime"');
    }
  });

  it("pdf: tải tệp một lần từ blobUrl và dùng pdf.js qua import map có SRI", () => {
    const doc = build({ type: "pdf", content: "", blobUrl });
    const [script] = modules(doc);
    expect(modules(doc)).toHaveLength(1);
    expect(script).toContain(JSON.stringify(blobUrl));
    expect(script?.match(/fetch\(/g)).toHaveLength(1);
    expect(script).toContain("globalThis.pdfjsWorker = worker");
    expect(script).toContain("isEvalSupported: false");
    expect(doc).toContain('"pdfjs-dist/worker"');
    expect(doc).toContain("sha384-");
  });

  it("pdf: mọi URL ngoài chỉ nằm dưới libBase hoặc blobUrl", () => {
    const doc = build({ type: "pdf", content: "", blobUrl });
    const urls = doc.match(/https?:\/\/[^"'\s)]+/g) ?? [];
    for (const url of urls) expect(url.startsWith(LIB_BASE) || url === blobUrl, url).toBe(true);
  });
});

describe("buildFrameDocument · html", () => {
  it("giữ nội dung nguyên văn và đặt bootstrap trước nó", () => {
    const content = "<!doctype html><html><head><title>T</title></head><body><p>x</p><script>1</script></body></html>";
    const doc = build({ type: "html", content });
    expect(doc.endsWith(content)).toBe(true);
    expect(doc.indexOf(BOOTSTRAP_SOURCE)).toBeLessThan(doc.indexOf(content));
    expect(doc.indexOf(BOOTSTRAP_SOURCE)).toBeGreaterThan(doc.indexOf("<head>"));
  });

  it("chạy được khi nội dung không có <head> hay <html>", () => {
    const doc = build({ type: "html", content: "<p>chỉ có đoạn văn</p>" });
    expect(doc).toMatch(/^<!doctype html><html [^>]*><head>.*<script>/s);
    expect(doc.endsWith("<p>chỉ có đoạn văn</p>")).toBe(true);
  });

  it("báo chủ đề bằng thuộc tính, không ép color-scheme lên trang của agent", () => {
    const doc = build({ type: "html", content: "<p>x</p>", theme: "dark" });
    expect(doc).toContain('data-hive-theme="dark"');
    expect(doc).not.toContain("color-scheme");
  });

  it("không có nguồn ngoài nào do runtime thêm vào", () => {
    expect(build({ type: "html", content: "<p>x</p>" })).not.toMatch(/https?:\/\//);
  });
});

describe("buildFrameDocument · nội dung có </script>", () => {
  const hostile = '</script><img src=x onerror="alert(1)"><!-- <script>';

  it("mermaid: nguồn không thoát khỏi khối và đọc lại nguyên văn", () => {
    const content = `graph TD; A["${hostile}"]-->B`;
    const doc = build({ type: "mermaid", content });
    expect(tag(doc, /<script/gi)).toBe(tag(doc, /<\/script>/gi));
    expect(doc).not.toContain("<img");
    const literal = /mermaid\.render\("hive-diagram", ("(?:[^"\\]|\\.)*")\)/.exec(modules(doc)[0] ?? "")?.[1];
    expect(JSON.parse(literal as string)).toBe(content);
  });

  it("react: mã biên dịch không thoát khỏi khối", () => {
    const compiled = `export default function App() { return "${hostile.replace(/"/g, "'")}"; }`;
    const doc = build({ type: "react", content: "", compiled });
    // Bộ phân tích HTML kết thúc khối ở `</script` đầu tiên: đó phải là thẻ đóng thật, không phải chuỗi trong mã.
    const body = doc.slice(doc.indexOf('<script type="module">') + '<script type="module">'.length);
    expect(body.search(/<\/script[\s/>]/i)).toBe(body.lastIndexOf("</script>"));
    expect(modules(doc)).toHaveLength(1);
    // Vẫn là mã hợp lệ sau khi escape.
    expect(() => parse(modules(doc)[0] as string)).not.toThrow();
  });

  it("markdown: nội dung đi qua JSON", () => {
    const doc = build({ type: "markdown", content: hostile });
    expect(tag(doc, /<script/gi)).toBe(tag(doc, /<\/script>/gi));
    expect(doc).not.toContain("<img");
  });

  it("code: chữ được escape", () => {
    const doc = build({ type: "code", content: hostile });
    expect(doc).not.toContain("<img");
    expect(doc).toContain("&#60;/script&#62;");
  });

  it("jsonForScript và escapeInlineScript", () => {
    const text = "</script><!-- &";
    expect(jsonForScript(text)).not.toMatch(/[<>&]/);
    expect(JSON.parse(jsonForScript(text))).toBe(text);
    expect(escapeInlineScript("a</SCRIPT>b<!--c")).toBe("a<\\/SCRIPT>b<\\x21--c");
  });
});

describe("buildFrameDocument · react", () => {
  const mount = (compiled: string) => modules(build({ type: "react", content: "", compiled }))[0] ?? "";

  it("import map trỏ tới thư viện của hub, có SRI và Tailwind nạp bằng thẻ script", () => {
    const doc = build({ type: "react", content: "", compiled: "export default () => null" });
    const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/.exec(doc)?.[1] as string);
    expect(map.imports.react).toBe(`${LIB_BASE}react@19.0.0/index.js`);
    expect(map.imports["react/jsx-runtime"]).toBe(`${LIB_BASE}react@19.0.0/jsx-runtime.js`);
    expect(map.imports.recharts).toBe(`${LIB_BASE}recharts@3.0.0/index.js`);
    expect(map.integrity[map.imports.react]).toBe(TEST_MANIFEST.react?.integrity);
    expect(doc).toContain(`<script src="${LIB_BASE}@tailwindcss/browser@4.0.0/index.js" integrity="`);
    expect(doc).toContain('crossorigin="anonymous"');
    expect(doc).toContain("@custom-variant dark");
  });

  it("mọi URL trong tài liệu nằm dưới libBase", () => {
    const doc = build({ type: "react", content: "", compiled: "export default () => null" });
    for (const url of doc.match(/https?:\/\/[^"'\s<>)]+/g) ?? []) expect(url.startsWith(LIB_BASE)).toBe(true);
  });

  it("export default hàm có tên giữ khai báo và thêm tham chiếu tới tên đó", () => {
    const code = mount("export default function App() { return 1; }");
    expect(code).toContain("export default function App()");
    expect(code).toContain(";const __hiveComponent = App;");
    expect(code).toContain('__hiveCreateRoot(document.getElementById("root")).render(');
  });

  it("export default biểu thức được viết lại thành khai báo", () => {
    const code = mount("const n = 1;\nexport   default () => n;");
    expect(code).toContain("const __hiveComponent = () => n;");
    expect(code).not.toContain("export default");
    expect(() => parse(code)).not.toThrow();
    const [, exports] = parse(code);
    expect(exports.find((e) => e.type === "direct" && e.name === "default")).toBeUndefined();
  });

  it("export default class vô danh và hàm async vô danh", () => {
    expect(mount("export default class {}")).toContain("const __hiveComponent = class {}");
    expect(mount("export default async function () {}")).toContain("const __hiveComponent = async function () {}");
  });

  it("export { X as default }", () => {
    const code = mount("const App = () => 1; export { App as default };");
    expect(code).toContain(";const __hiveComponent = App;");
  });

  it("chuỗi chứa 'export default' không bị viết lại", () => {
    const code = mount('const s = "export default 1"; export default function App() {}');
    expect(code).toContain('const s = "export default 1";');
  });

  it("thiếu export default thì hiện lỗi và báo error", () => {
    const doc = build({ type: "react", content: "", compiled: "export const a = 1;" });
    expect(doc).toContain("Thiếu export default");
    expect(doc).toContain('kind:"runtime"');
    expect(modules(doc)).toHaveLength(0);
  });

  it("compileError hiện lỗi (escape) và báo error kind compile", () => {
    const doc = build({ type: "react", content: "", compileError: "<img src=x onerror=1> (3:4)" });
    expect(doc).toContain("&#60;img src=x onerror=1&#62; (3:4)");
    expect(doc).not.toContain("<img");
    expect(doc).toContain('kind:"compile"');
    expect(doc).not.toContain("importmap");
  });

  it("compileError thắng bản biên dịch cũ còn sót", () => {
    const doc = build({ type: "react", content: "", compiled: "export default () => 1", compileError: "lỗi" });
    expect(doc).toContain('kind:"compile"');
    expect(modules(doc)).toHaveLength(0);
  });

  it("mã biên dịch hỏng cú pháp thành trang lỗi biên dịch", () => {
    const doc = build({ type: "react", content: "", compiled: "export default function ( {" });
    expect(doc).toContain('kind:"compile"');
  });

  it("chưa có bản biên dịch cũng không để trang trắng", () => {
    expect(build({ type: "react", content: "" })).toContain("Chưa có bản chạy được");
  });
});

describe("buildFrameDocument · markdown và mermaid", () => {
  it("markdown tắt HTML thô và biến liên kết thành chữ", () => {
    const doc = build({ type: "markdown", content: "x" });
    expect(doc).toContain("html: false");
    expect(doc).toContain("a.replaceWith(span)");
    expect(doc).toContain(`"markdown-it":"${LIB_BASE}markdown-it@15.0.0/index.js"`);
  });

  it("mermaid dùng securityLevel strict và theo chủ đề", () => {
    expect(build({ type: "mermaid", content: "x", theme: "dark" })).toContain('securityLevel: "strict", theme: "dark"');
    expect(build({ type: "mermaid", content: "x", theme: "light" })).toContain('theme: "default"');
  });
});

describe("buildFrameDocument · điều kiện chung", () => {
  it("báo lỗi rõ khi thiếu thư viện trong manifest", () => {
    const { mermaid: _removed, ...rest } = TEST_MANIFEST;
    expect(() => build({ type: "mermaid", content: "x", manifest: rest })).toThrow(/mermaid/);
  });

  it("từ chối loại chưa có nhánh dựng", () => {
    expect(() => build({ type: "json" as never, content: "" })).toThrow(/json/);
  });

  it("mọi loại dùng cùng CSP với route khung", () => {
    // CSP nằm ở header chứ không trong tài liệu; test này khoá việc không có <meta http-equiv> thay thế nó.
    for (const type of ["html", "mermaid", "svg", "markdown", "code", "csv"] as const) {
      expect(build({ type, content: "x" })).not.toMatch(/http-equiv/i);
    }
    expect(buildCsp({ libBase: LIB_BASE })).toContain("connect-src 'none'");
  });
});
