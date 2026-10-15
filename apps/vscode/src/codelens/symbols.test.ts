import { describe, expect, it, vi } from "vitest";
import type * as VSCode from "vscode";
import { SymbolLensProvider } from "@/codelens/symbols.ts";
import { asLenses, fakeDocument, symbol } from "@/codelens/test-support.ts";

vi.mock("vscode", async (original) => {
  const base = await original<typeof VSCode>();
  const extras = await import("@/codelens/test-support.ts");
  return { ...base, Range: extras.Range, CodeLens: extras.CodeLens, SymbolKind: extras.SymbolKind };
});

const tree = [
  symbol("main", "Function", 0, 9, [symbol("inner", "Function", 2, 4)]),
  symbol("Service", "Class", 11, 40, [symbol("run", "Method", 12, 20), symbol("field", "Variable", 21, 21)]),
  symbol("VERSION", "Variable", 42, 42),
];

function provider(options: { trusted?: boolean; enabled?: boolean; result?: unknown } = {}) {
  const symbols = vi.fn(async () => ("result" in options ? options.result : tree) as never);
  return {
    symbols,
    lens: new SymbolLensProvider({
      enabled: () => options.enabled ?? true,
      trusted: () => options.trusted ?? true,
      symbols,
    }),
  };
}
const doc = fakeDocument("/repo/src/a.ts", "x");

describe("SymbolLensProvider", () => {
  it("lens Giao agent sửa trên hàm và phương thức, không trên biến hay hàm lồng", async () => {
    const lenses = asLenses(await provider().lens.provideCodeLenses(doc as never));
    expect(lenses.map((l) => l.command.title)).toEqual(["Giao agent sửa", "Giao agent sửa"]);
    expect(lenses.map((l) => (l.command.arguments as { name: string }[])[0]?.name)).toEqual(["main", "run"]);
    expect(lenses[1]?.command.arguments?.[0]).toMatchObject({
      uri: "file:///repo/src/a.ts",
      kind: "method",
      startLine: 12,
      endLine: 20,
    });
  });

  it("Restricted Mode, setting tắt hoặc tasks.md: không có lens và không hỏi symbol", async () => {
    for (const options of [{ trusted: false }, { enabled: false }]) {
      const { lens, symbols } = provider(options);
      expect(await lens.provideCodeLenses(doc as never)).toEqual([]);
      expect(symbols).not.toHaveBeenCalled();
    }
    const { lens } = provider();
    expect(await lens.provideCodeLenses(fakeDocument("/r/specs/017-x/tasks.md", "x") as never)).toEqual([]);
  });

  it("không có provider symbol hoặc chỉ có SymbolInformation thì không lens", async () => {
    expect(await provider({ result: undefined }).lens.provideCodeLenses(doc as never)).toEqual([]);
    expect(await provider({ result: [{ name: "f", kind: 11 }] }).lens.provideCodeLenses(doc as never)).toEqual([]);
  });

  it("giới hạn 200 lens mỗi tài liệu", async () => {
    const many = Array.from({ length: 500 }, (_, i) => symbol(`f${i}`, "Function", i, i));
    expect(await provider({ result: many }).lens.provideCodeLenses(doc as never)).toHaveLength(200);
  });
});
