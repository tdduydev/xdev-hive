import { vi } from "vitest";

// Phần API `vscode` mà test CodeLens/Hover cần thêm vào bản giả chung; không import `vscode` để dùng được trong `vi.mock`.
export class Position {
  readonly line: number;
  readonly character: number;
  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
}
export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }
}
export class CodeLens {
  readonly range: Range;
  readonly command: { title: string; command: string; arguments?: unknown[] };
  constructor(range: Range, command: { title: string; command: string; arguments?: unknown[] }) {
    this.range = range;
    this.command = command;
  }
}
export class MarkdownString {
  value: string;
  isTrusted: boolean | undefined;
  supportHtml: boolean | undefined;
  constructor(value: string) {
    this.value = value;
  }
}
export class Hover {
  readonly contents: MarkdownString[];
  readonly range: Range | undefined;
  constructor(contents: MarkdownString[], range?: Range) {
    this.contents = contents;
    this.range = range;
  }
}
export const SymbolKind: Record<string | number, string | number> = {
  Module: 1,
  Namespace: 2,
  Class: 4,
  Method: 5,
  Constructor: 8,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Object: 18,
  Struct: 22,
};
for (const [name, value] of Object.entries(SymbolKind)) SymbolKind[value] = name;

export function fakeDocument(fsPath: string, text: string, version = 1) {
  const lines = text.split("\n");
  return {
    uri: { fsPath, toString: () => `file://${fsPath}` },
    version,
    lineCount: lines.length,
    getText: () => text,
    lineAt: (line: number) => ({
      text: lines[line] ?? "",
      range: new Range(line, 0, line, (lines[line] ?? "").length),
    }),
  };
}

export function symbol(name: string, kind: string, startLine: number, endLine: number, children: unknown[] = []) {
  return { name, kind: SymbolKind[kind], range: new Range(startLine, 0, endLine, 0), children };
}

export const pendingFetch = () => vi.fn(() => Promise.reject(new Error("fetch không được gọi")));

// Provider trả `vscode.CodeLens` (command tuỳ chọn); test luôn đặt command nên ép về bản giả để khỏi kiểm undefined.
export const asLenses = (lenses: unknown[]): CodeLens[] => lenses as CodeLens[];
