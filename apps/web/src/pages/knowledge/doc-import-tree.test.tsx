// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DocImportFile } from "@xdev-hive/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTree,
  DocImportTree,
  findingText,
  folderSelection,
  isImportable,
  toggleFolder,
  warningTone,
} from "@/pages/knowledge/doc-import-tree.tsx";

afterEach(cleanup);

const file = (path: string, patch: Partial<DocImportFile> = {}): DocImportFile => ({
  path,
  blobSha: "a".repeat(40),
  key: null,
  existingKey: null,
  kind: "markdown",
  size: 100,
  warnings: [],
  secretScan: "clean",
  findings: [],
  state: "pending",
  docId: null,
  assetId: null,
  error: null,
  ...patch,
});
const files = [
  file("docs/a.md"),
  file("docs/guide/b.md"),
  file("docs/guide/c.md", { secretScan: "found", findings: [{ line: 12, kind: "github_token" }] }),
  file("docs/guide/d.md", { existingKey: "project/x/d" }),
  file("README.md", { state: "done" }),
];
const all = (f: DocImportFile) => isImportable(f);

describe("buildTree", () => {
  it("gom file theo thư mục, thư mục trước file", () => {
    const root = buildTree(files);
    expect(root.children.map((node) => node.name)).toEqual(["docs", "README.md"]);
    const docs = root.children[0];
    expect(docs?.kind === "folder" && docs.files).toHaveLength(4);
    expect(root.files).toHaveLength(5);
  });
});

describe("chọn", () => {
  it("không cho chọn file bị bí mật, đã có hoặc trùng key chưa giải quyết", () => {
    expect(files.filter(all).map((f) => f.path)).toEqual(["docs/a.md", "docs/guide/b.md"]);
    expect(isImportable(files[3] as DocImportFile, new Set(["docs/guide/d.md"]))).toBe(true);
  });

  it("chọn cả thư mục rồi bỏ chọn", () => {
    const guide = buildTree(files).children[0];
    if (guide?.kind !== "folder") throw new Error("thiếu thư mục");
    expect(folderSelection(guide, new Set(), all)).toBe("none");
    const picked = toggleFolder(guide, new Set(), all);
    expect([...picked].sort()).toEqual(["docs/a.md", "docs/guide/b.md"]);
    expect(folderSelection(guide, picked, all)).toBe("all");
    expect(folderSelection(guide, new Set(["docs/a.md"]), all)).toBe("some");
    expect(toggleFolder(guide, picked, all).size).toBe(0);
  });
});

describe("cảnh báo", () => {
  it("phân loại màu và không hiện giá trị bí mật", () => {
    expect(warningTone("Có dấu hiệu bí mật")).toBe("bad");
    expect(warningTone("File quá lớn")).toBe("warn");
    expect(warningTone("Do SDLC quản lý")).toBe("neutral");
    expect(findingText({ line: 12, kind: "github_token" })).toBe("dòng 12 (GitHub token)");
  });
});

function Harness() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  return (
    <>
      <DocImportTree
        root={buildTree(files)}
        selected={selected}
        onSelectedChange={setSelected}
        importable={all}
        disabled={false}
      />
      <output>{[...selected].sort().join(",")}</output>
    </>
  );
}

describe("DocImportTree", () => {
  it("chọn thư mục chọn mọi file nhập được, hiện cảnh báo theo loại", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Chọn cả thư mục docs" }));
    expect(screen.getByRole("status").textContent).toBe("docs/a.md,docs/guide/b.md");
    fireEvent.click(screen.getByRole("button", { name: "Mở thư mục docs/guide" }));
    expect(screen.getByText(/dòng 12 \(GitHub token\)/)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Chọn docs/guide/c.md" }) as HTMLInputElement).ariaDisabled).toBe(
      "true",
    );
  });
});
