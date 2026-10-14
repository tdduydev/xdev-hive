import { buildFrameDocument, type LibManifest } from "@xdev-hive/artifacts-runtime";
import { describe, expect, it } from "vitest";
import { allowedReactImports, type CompileResult, compileReact, DYNAMIC_IMPORT, REACT_IMPORTS } from "./compile.ts";

const entry = (path: string, kind: "module" | "script" = "module") => ({
  path,
  integrity: `sha384-${path.replace(/[^A-Za-z0-9]/g, "A").padEnd(64, "A")}`,
  kind,
  bytes: 1,
});

// Manifest giả cùng dạng bản dựng thật: test không phải chạy build thư viện.
const MANIFEST: LibManifest = {
  react: entry("react@19.0.0/index.js"),
  "react/jsx-runtime": entry("react@19.0.0/jsx-runtime.js"),
  "react-dom": entry("react-dom@19.0.0/index.js"),
  "react-dom/client": entry("react-dom@19.0.0/client.js"),
  recharts: entry("recharts@3.0.0/index.js"),
  "lucide-react": entry("lucide-react@1.0.0/index.js"),
  "@tailwindcss/browser": entry("@tailwindcss/browser@4.0.0/index.js", "script"),
  mermaid: entry("mermaid@12.0.0/index.js"),
  "markdown-it": entry("markdown-it@15.0.0/index.js"),
};

function compiledOf(result: CompileResult): string {
  if (!("compiled" in result) || result.compiled === null)
    throw new Error(`Không biên dịch được: ${JSON.stringify(result)}`);
  return result.compiled;
}

function frameOf(compiled: string): string {
  return buildFrameDocument({
    type: "react",
    content: "",
    compiled,
    theme: "light",
    manifest: MANIFEST,
    libBase: "https://hive.example.com/_artifact/lib/",
  });
}

describe("compileReact", () => {
  it("JSX thành ESM dùng react/jsx-runtime, khung dựng được trang", async () => {
    const out = compiledOf(
      await compileReact(`export default function App() { return <div className="p-2">Xin chào</div>; }`, MANIFEST),
    );
    expect(out).toContain('from "react/jsx-runtime"');
    expect(out).not.toContain("<div");
    const page = frameOf(out);
    expect(page).toContain('<div id="root"></div>');
    expect(page).not.toContain("Lỗi biên dịch");
  });

  it("TSX: bỏ kiểu, giữ import của bộ đóng gói", async () => {
    const source = `import { useState } from "react";
import { LineChart, Line } from "recharts";
import { Plus } from "lucide-react";
interface Point { x: number; y: number }
type Props = { title?: string };
const data: Point[] = [{ x: 1, y: 2 }];
export default function Chart({ title = "Biểu đồ" }: Props) {
  const [n, setN] = useState<number>(0);
  return (
    <section>
      <h1>{title}</h1>
      <button onClick={() => setN(n + 1)}><Plus /> {n}</button>
      <LineChart width={200} height={100} data={data}><Line dataKey="y" /></LineChart>
    </section>
  );
}`;
    const out = compiledOf(await compileReact(source, MANIFEST));
    expect(out).not.toMatch(/interface Point|: Props|<number>/);
    expect(out).toContain('from "recharts"');
    expect(out).toContain('from "lucide-react"');
    expect(frameOf(out)).not.toContain("Lỗi biên dịch");
  });

  it("thiếu export default → compileError, không ném", async () => {
    const result = await compileReact(`export function App() { return <p/>; }`, MANIFEST);
    expect(result).toMatchObject({ compiled: null, compileError: expect.stringContaining("export default") });
  });

  it("lỗi cú pháp → compileError có vị trí", async () => {
    const result = await compileReact(`export default function App() { return <div>; }`, MANIFEST);
    expect(result).toMatchObject({ compiled: null, compileError: expect.stringMatching(/\(\d+:\d+\)/) });
  });

  it("import lạ, thư viện ngoài import map của trang react, import chỉ để chạy, re-export lạ → importNotAllowed", async () => {
    const result = await compileReact(
      `import _ from "lodash";
import mermaid from "mermaid";
import { useState } from "react";
import "./polyfill.js";
export { x } from "https://evil.example/x.js";
export default function App() { useState(0); mermaid.run(); return _.noop(); }`,
      MANIFEST,
    );
    expect(result).toEqual({
      importNotAllowed: ["lodash", "mermaid", "./polyfill.js", "https://evil.example/x.js"],
    });
  });

  it("import chỉ dùng làm kiểu bị bỏ khi biên dịch nên không chặn và không vào bản chạy", async () => {
    const out = compiledOf(
      await compileReact(
        `import type { CSSProperties } from "csstype";
import { type FC, type ReactNode } from "react";
import { Props } from "./types";
const Box: FC<{ children?: ReactNode; style?: CSSProperties }> = ({ children }) => <div>{children}</div>;
export default function App(p: Props) { return <Box>{String(p)}</Box>; }`,
        MANIFEST,
      ),
    );
    expect(out).not.toMatch(/csstype|\.\/types|from "react";/);
  });

  it("import() động bị từ chối dù tên có trong bộ đóng gói", async () => {
    const result = await compileReact(
      `export default function App() { import("react"); import(\`https://evil.example/\${1}\`); return null; }`,
      MANIFEST,
    );
    expect(result).toEqual({ importNotAllowed: [DYNAMIC_IMPORT] });
  });

  it("chỉ nhận tên có trong manifest đang phục vụ", async () => {
    const { recharts: _, ...noRecharts } = MANIFEST;
    expect(allowedReactImports(noRecharts).has("recharts")).toBe(false);
    const result = await compileReact(
      `import { Line } from "recharts"; export default () => <Line dataKey="y" />;`,
      noRecharts,
    );
    expect(result).toEqual({ importNotAllowed: ["recharts"] });
  });

  it("`</script>` trong chuỗi không thoát khỏi thẻ script của khung", async () => {
    const out = compiledOf(
      await compileReact(
        'export default function App() { const s = "</script><script>alert(1)</script>"; return <pre>{s}</pre>; }',
        MANIFEST,
      ),
    );
    expect(out).toContain("</script>");
    const page = frameOf(out);
    const body = page.slice(page.indexOf('<div id="root"></div>'));
    // Chỉ còn thẻ đóng của chính khối module.
    expect(body.match(/<\/script/gi)).toHaveLength(1);
  });

  it("danh sách import khớp import map của trang react trong khung", async () => {
    const page = frameOf(compiledOf(await compileReact("export default () => null;", MANIFEST)));
    const map = /<script type="importmap">(.*?)<\/script>/.exec(page)?.[1];
    expect(map).toBeDefined();
    expect(Object.keys(JSON.parse(map ?? "{}").imports).sort()).toEqual([...REACT_IMPORTS].sort());
  });

  it("SC-013: nguồn 1 MiB biên dịch khi luồng đã nóng", async () => {
    const row = (i: number) =>
      `function Row${i}({ v }: { v: number }) { return <li className="row" data-i={${i}}>{v * ${i}}</li>; }\n`;
    let source = "";
    for (let i = 0; source.length < 1024 * 1024; i++) source += row(i);
    source += "export default function App() { return <ul><Row0 v={1} /></ul>; }\n";
    expect(source.length).toBeGreaterThanOrEqual(1024 * 1024);
    compiledOf(await compileReact(source, MANIFEST));
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      compiledOf(await compileReact(source, MANIFEST));
      times.push(performance.now() - start);
    }
    // SC-013 đặt p95 300 ms trên máy chủ 34; runner CI chia sẻ CPU nên cho trung vị thêm dư địa,
    // vẫn dưới trần biên dịch 2 s. Đo p95 trên máy chủ thật, không suy ra từ các mẫu của runner CI.
    times.sort((a, b) => a - b);
    const maxMedianMs = process.env.CI === "true" ? 1500 : 300;
    expect(times[2], `Thời gian biên dịch (ms): ${times.map((time) => time.toFixed(1)).join(", ")}`).toBeLessThan(
      maxMedianMs,
    );
  }, 15_000);

  it("quá giờ → compileError, lần sau biên dịch lại bình thường", async () => {
    let source = "";
    for (let i = 0; i < 20_000; i++) source += `const a${i} = <div>{${i}}</div>;\n`;
    source += "export default () => null;";
    const slow = await compileReact(source, MANIFEST, { timeoutMs: 1 });
    expect(slow).toMatchObject({ compiled: null, compileError: expect.stringContaining("quá lâu") });
    compiledOf(await compileReact("export default () => <p>lại</p>;", MANIFEST));
  });

  it("nhiều lần biên dịch đồng thời trả đúng kết quả của từng nguồn", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => compileReact(`export default () => <p>số ${i}</p>;`, MANIFEST)),
    );
    results.forEach((r, i) => {
      expect(compiledOf(r)).toContain(`số ${i}`);
    });
  });
});
