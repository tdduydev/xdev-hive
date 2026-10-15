import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ScopeIndex } from "@/codelens/scope-index.ts";

const root = resolve("/repo");
const tasks = (scope: string) =>
  `- [ ] **T023 — a**\n  - **PHẠM VI**: ${scope}\n- [ ] **T024 — b**\n  - **PHẠM VI**: \`apps/shared.ts\`\n`;
const second = "- [ ] **T001 — c**\n  - **PHẠM VI**: `apps/shared.ts`, `docs/**/*.md`\n";

function setup(files: Record<string, string>) {
  const contents = new Map(Object.entries(files));
  const reads: string[] = [];
  const index = new ScopeIndex({
    files: async () => [...contents.keys()],
    read: async (path) => {
      reads.push(path);
      const text = contents.get(path);
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
  });
  return { index, contents, reads };
}

const a = `${root}/specs/017-vscode-extension/tasks.md`;
const b = `${root}/specs/018-other/tasks.md`;

describe("ScopeIndex", () => {
  it("khớp đường dẫn chính xác, glob và mẫu nguyên văn", async () => {
    const { index } = setup({ [a]: tasks("`apps/vscode/src/codelens/**` và `apps/vscode/package.json`") });
    await index.rebuild();
    const owner = { code: "T023", spec: "017" };
    expect(index.lookup(root, "apps/vscode/src/codelens/hover.ts")).toEqual([owner]);
    expect(index.lookup(root, "apps/vscode/src/codelens/a/b/c.ts")).toEqual([owner]);
    expect(index.lookup(root, "apps/vscode/package.json")).toEqual([owner]);
    expect(index.lookup(root, "apps/vscode/src/codelens/**")).toEqual([owner]);
    expect(index.lookup(root, "apps/vscode/src/hub/client.ts")).toEqual([]);
    expect(index.lookup(root, "./apps/vscode/package.json")).toEqual([owner]);
  });

  it("một đường dẫn thuộc nhiều task thì trả hết, kể cả khác spec", async () => {
    const { index } = setup({ [a]: tasks("`x/**`"), [b]: second });
    await index.rebuild();
    expect(index.lookup(root, "apps/shared.ts")).toEqual([
      { code: "T024", spec: "017" },
      { code: "T001", spec: "018" },
    ]);
    expect(index.lookup(root, "docs/a/b/readme.md")).toEqual([{ code: "T001", spec: "018" }]);
  });

  it("không lẫn gốc repo khác", async () => {
    const { index } = setup({ [a]: tasks("`x/**`") });
    await index.rebuild();
    expect(index.lookup(resolve("/other"), "x/a.ts")).toEqual([]);
  });

  it("file đổi chỉ đọc lại file đó; file xoá thì rời khỏi chỉ mục", async () => {
    const { index, contents, reads } = setup({ [a]: tasks("`x/**`"), [b]: second });
    await index.rebuild();
    reads.length = 0;
    contents.set(a, tasks("`y/**`"));
    await index.update(a);
    expect(reads).toEqual([a]);
    expect(index.lookup(root, "x/a.ts")).toEqual([]);
    expect(index.lookup(root, "y/a.ts")).toEqual([{ code: "T023", spec: "017" }]);
    contents.delete(b);
    await index.update(b);
    expect(index.lookup(root, "apps/shared.ts")).toEqual([{ code: "T024", spec: "017" }]);
  });

  it("rootOf trả gốc repo chứa file", async () => {
    const { index } = setup({ [a]: tasks("`x/**`") });
    await index.rebuild();
    expect(index.rootOf(`${root}/apps/x.ts`)).toBe(root);
    expect(index.rootOf(resolve("/elsewhere/x.ts"))).toBeUndefined();
  });
});
