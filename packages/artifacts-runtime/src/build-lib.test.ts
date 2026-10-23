import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIB_MANIFEST_FILE } from "./manifest.ts";
import { LIB_DIST_DIR, readLibManifest } from "./node.ts";

// `pnpm test` của package chạy scripts/build-lib.ts trước nên dist/lib có sẵn.
const manifest = readLibManifest();
const NAMES = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "recharts",
  "lucide-react",
  "@tailwindcss/browser",
  "mermaid",
  "markdown-it",
  "pdfjs-dist",
  "pdfjs-dist/worker",
];
// Chỉ bốn tên này được là import ngoài: chúng đi qua import map về cùng một file nên cả khung có một bản React.
const SHARED = new Set(["react", "react/jsx-runtime", "react-dom", "react-dom/client"]);

describe("lib-manifest.json", () => {
  it("có đủ thư viện của MVP", () => {
    expect(Object.keys(manifest).sort()).toEqual([...NAMES].sort());
  });

  it("đường dẫn dạng <tên>@<ver>/… và Tailwind là script", () => {
    for (const [name, e] of Object.entries(manifest)) {
      expect(e.path).toMatch(/^(@[\w-]+\/)?[\w-]+@\d+\.\d+\.\d+[^/]*\/[\w.-]+\.js$/);
      expect(e.kind).toBe(name === "@tailwindcss/browser" ? "script" : "module");
    }
  });

  it("SRI sha384 khớp đúng nội dung file và cỡ khớp", () => {
    for (const e of Object.values(manifest)) {
      const data = readFileSync(join(LIB_DIST_DIR, e.path));
      expect(e.integrity).toBe(`sha384-${createHash("sha384").update(data).digest("base64")}`);
      expect(e.bytes).toBe(data.length);
    }
  });

  it("nằm cùng thư mục lib để chép một thư mục là đủ", () => {
    expect(readFileSync(join(LIB_DIST_DIR, LIB_MANIFEST_FILE), "utf8")).toContain('"react"');
  });
});

describe("thư viện đã dựng", () => {
  const specifiers = (code: string) =>
    [...code.matchAll(/(?:^|[;}\s])(?:import|export)\s*(?:[^;"'(]*?\sfrom\s*)?["']([^"']+)["']/g)].map(
      (m) => m[1] as string,
    );

  it("không nạp thêm file nào: chỉ import ngoài là React", () => {
    for (const [name, e] of Object.entries(manifest)) {
      if (e.kind !== "module") continue;
      const code = readFileSync(join(LIB_DIST_DIR, e.path), "utf8");
      for (const spec of specifiers(code)) expect(SHARED.has(spec), `${name} import "${spec}"`).toBe(true);
      expect(code, `${name} import() tương đối`).not.toMatch(/import\(\s*["']\.{0,2}\//);
    }
  });

  it("react và react-dom/client không tự gói bản React thứ hai", () => {
    const client = readFileSync(join(LIB_DIST_DIR, manifest["react-dom/client"]?.path as string), "utf8");
    expect(specifiers(client)).toEqual(expect.arrayContaining(["react", "react-dom"]));
    const recharts = readFileSync(join(LIB_DIST_DIR, manifest.recharts?.path as string), "utf8");
    expect(specifiers(recharts)).toContain("react");
    // Bản React gói sẵn sẽ chứa tên nội bộ này.
    expect(recharts).not.toContain("react.transitional.element");
  });

  it("pdf.js có bộ xử lý worker riêng để chạy trên luồng chính trong khung", () => {
    const worker = readFileSync(join(LIB_DIST_DIR, manifest["pdfjs-dist/worker"]?.path as string), "utf8");
    expect(worker).toMatch(/export\s*\{[^}]*\bWorkerMessageHandler\b/);
    const pdf = readFileSync(join(LIB_DIST_DIR, manifest["pdfjs-dist"]?.path as string), "utf8");
    expect(pdf).toMatch(/export\s*\{[^}]*\bgetDocument\b/);
  });

  it("export có tên dùng được qua import map", () => {
    const react = readFileSync(join(LIB_DIST_DIR, manifest.react?.path as string), "utf8");
    expect(react).toMatch(/export\s*\{[^}]*\buseState\b/);
    const jsx = readFileSync(join(LIB_DIST_DIR, manifest["react/jsx-runtime"]?.path as string), "utf8");
    expect(jsx).toMatch(/export\s*\{[^}]*\bjsx\b/);
  });
});
