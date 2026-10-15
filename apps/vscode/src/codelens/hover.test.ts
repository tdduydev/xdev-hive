import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as VSCode from "vscode";
import { Hovers } from "@/codelens/hover.ts";
import { MemoryTokens } from "@/codelens/memory-tokens.ts";
import { ScopeIndex } from "@/codelens/scope-index.ts";
import { fakeDocument, Position } from "@/codelens/test-support.ts";

vi.mock("vscode", async (original) => {
  const base = await original<typeof VSCode>();
  const extras = await import("@/codelens/test-support.ts");
  return { ...base, Range: extras.Range, Hover: extras.Hover, MarkdownString: extras.MarkdownString };
});

const root = resolve("/repo");
const tasksPath = `${root}/specs/017-vscode-extension/tasks.md`;
const tasksText = [
  "- [ ] **T023 — CodeLens và Hover**",
  "  - **PHẠM VI**: `apps/vscode/src/codelens/**` (+ test), `apps/vscode/package.json`",
].join("\n");

async function setup(
  scan: () => Promise<{ files?: { path: string; tokens: number }[] } | undefined> = async () => undefined,
  enabled = true,
) {
  const index = new ScopeIndex({ files: async () => [tasksPath], read: async () => tasksText });
  await index.rebuild();
  const scanSpy = vi.fn(scan);
  const hovers = new Hovers({ enabled: () => enabled, index, tokens: new MemoryTokens({ scan: scanSpy }) });
  return { hovers, scanSpy };
}
const value = (hover: { contents: { value: string }[] } | undefined) => hover?.contents.map((c) => c.value);

describe("Hover PHẠM VI", () => {
  it("đường dẫn trong mã nguồn khác hiện đúng task sở hữu", async () => {
    const { hovers } = await setup();
    const line = "xem apps/vscode/src/codelens/hover.ts, rồi sửa tiếp";
    const doc = fakeDocument(`${root}/docs/note.md`, line);
    const hover = await hovers.provideHover(doc as never, new Position(0, 12) as never);
    expect(value(hover as never)).toEqual(["Thuộc T023 (spec 017)"]);
    expect((hover as never as { range: { start: Position; end: Position } }).range.start.character).toBe(4);
    expect((hover as never as { range: { end: Position } }).range.end.character).toBe(
      4 + "apps/vscode/src/codelens/hover.ts".length,
    );
  });

  it("đường dẫn ngoài PHẠM VI thì không có hover", async () => {
    const { hovers } = await setup();
    const doc = fakeDocument(`${root}/docs/note.md`, "sửa apps/vscode/src/hub/client.ts");
    expect(await hovers.provideHover(doc as never, new Position(0, 10) as never)).toBeUndefined();
  });

  it("hover cả mẫu glob ngay trong tasks.md và bỏ dấu chấm câu cuối", async () => {
    const { hovers } = await setup();
    const doc = fakeDocument(tasksPath, tasksText);
    const glob = await hovers.provideHover(doc as never, new Position(1, 25) as never);
    expect(value(glob as never)).toEqual(["Thuộc T023 (spec 017)"]);
    const file = await hovers.provideHover(
      fakeDocument(`${root}/a.md`, "mở apps/vscode/package.json.") as never,
      new Position(0, 8) as never,
    );
    expect(value(file as never)).toEqual(["Thuộc T023 (spec 017)"]);
  });

  it("tắt setting thì không hover", async () => {
    const { hovers: off } = await setup(undefined, false);
    const doc = fakeDocument(`${root}/a.md`, "apps/vscode/package.json");
    expect(await off.provideHover(doc as never, new Position(0, 3) as never)).toBeUndefined();
  });
});

describe("Hover token", () => {
  const body = "# Hướng dẫn\n\nnội dung";

  it("dùng số token của memstore khi worker quét thấy file", async () => {
    const { hovers } = await setup(async () => ({ files: [{ path: `${root}/CLAUDE.md`, tokens: 1234 }] }));
    const hover = await hovers.provideHover(
      fakeDocument(`${root}/CLAUDE.md`, body) as never,
      new Position(0, 2) as never,
    );
    expect(value(hover as never)).toEqual(["Nạp khoảng 1234 token mỗi phiên"]);
  });

  it("không có worker thì ước tính ký tự / 4 và ghi rõ là thô", async () => {
    const { hovers } = await setup();
    const text = "a".repeat(401);
    const hover = await hovers.provideHover(
      fakeDocument(`${root}/AGENTS.md`, text) as never,
      new Position(0, 2) as never,
    );
    expect(value(hover as never)).toEqual(["Nạp khoảng 101 token mỗi phiên (ước tính thô, ký tự / 4)"]);
  });

  it("chỉ hiện ở dòng nội dung đầu tiên, và chỉ cho CLAUDE.md, AGENTS.md, MEMORY.md", async () => {
    const { hovers } = await setup();
    const doc = fakeDocument(`${root}/MEMORY.md`, "\n\n# Mục lục\n- a");
    expect(await hovers.provideHover(doc as never, new Position(3, 1) as never)).toBeUndefined();
    expect(await hovers.provideHover(doc as never, new Position(2, 1) as never)).toBeDefined();
    const other = fakeDocument(`${root}/README.md`, "# x");
    expect(await hovers.provideHover(other as never, new Position(0, 1) as never)).toBeUndefined();
  });

  it("nhiều lần hover liên tiếp chỉ quét một lần; quét lỗi vẫn ra ước tính", async () => {
    const { hovers, scanSpy } = await setup(async () => {
      throw new Error("boom");
    });
    const doc = fakeDocument(`${root}/CLAUDE.md`, body);
    await Promise.all([
      hovers.provideHover(doc as never, new Position(0, 1) as never),
      hovers.provideHover(doc as never, new Position(0, 1) as never),
    ]);
    await hovers.provideHover(doc as never, new Position(0, 1) as never);
    expect(scanSpy).toHaveBeenCalledTimes(1);
  });

  it("markdown của hover không tin cậy và không HTML", async () => {
    const { hovers } = await setup();
    const hover = await hovers.provideHover(
      fakeDocument(`${root}/CLAUDE.md`, body) as never,
      new Position(0, 2) as never,
    );
    const [md] = (hover as never as { contents: { isTrusted: boolean; supportHtml: boolean }[] }).contents;
    expect(md).toMatchObject({ isTrusted: false, supportHtml: false });
  });
});
