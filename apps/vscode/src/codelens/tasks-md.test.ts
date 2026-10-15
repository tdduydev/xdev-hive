import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isTasksFile, parseScopes, parseTasks, specOf } from "@/codelens/tasks-md.ts";

const sample = [
  "# Tasks",
  "",
  "- [ ] **T023 [P] [US10] [vừa] · 1,5 ngày — CodeLens và Hover**",
  "  - **Phụ thuộc**: T003.",
  "  - **PHẠM VI**: `apps/vscode/src/codelens/**` (+ test)",
  "  - **Test**: `tasks.md` 300 dòng.",
  "- [x] **T010 [P] — Client hub**",
  "  - **PHẠM VI**:",
  "    - `apps/vscode/src/hub/**`",
  "    - `apps/hub/src/runs/stream-pat.db.test.ts` (mới) **[Giả định]**",
  "  - **Test**: `go test` chạy ở `worker/`.",
  "- [ ] **T024a — Ghi chú**",
].join("\n");

describe("parseTasks", () => {
  it("lấy mã, tiêu đề, trạng thái làm xong", () => {
    expect(parseTasks(sample)).toEqual([
      { line: 2, code: "T023", title: "CodeLens và Hover", done: false },
      { line: 6, code: "T010", title: "Client hub", done: true },
      { line: 11, code: "T024a", title: "Ghi chú", done: false },
    ]);
  });

  it("bỏ qua dòng thụt vào và dòng không phải task", () => {
    expect(parseTasks("  - [ ] **T001 — x**\n- [ ] T002 không in đậm\n- [ ] **TXYZ**")).toEqual([]);
  });
});

describe("parseScopes", () => {
  it("đọc đường dẫn ở dòng khai báo và các dòng con, bỏ lệnh và tên file chung chung", () => {
    expect(parseScopes(sample)).toEqual([
      { code: "T023", paths: ["apps/vscode/src/codelens/**"] },
      { code: "T010", paths: ["apps/vscode/src/hub/**", "apps/hub/src/runs/stream-pat.db.test.ts"] },
    ]);
  });

  it("không lấy backtick của mục khác sau PHẠM VI", () => {
    const [entry] = parseScopes("- [ ] **T001 — a**\n  - **PHẠM VI**: `a/b.ts`\n  - **Test**: `c/d.ts`");
    expect(entry?.paths).toEqual(["a/b.ts"]);
  });

  it("đọc đúng tasks.md thật của spec 017", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../../../../specs/017-vscode-extension/tasks.md", import.meta.url)),
      "utf8",
    );
    const scopes = new Map(parseScopes(text).map((entry) => [entry.code, entry.paths]));
    expect(scopes.get("T023")).toEqual(["apps/vscode/src/codelens/**"]);
    expect(scopes.get("T010")).toContain("apps/vscode/test/fake-hub.ts");
    expect(parseTasks(text).length).toBeGreaterThan(30);
  });
});

describe("đường dẫn", () => {
  it("chỉ nhận specs/<thư mục>/tasks.md", () => {
    expect(isTasksFile("/r/specs/017-x/tasks.md")).toBe(true);
    expect(isTasksFile("C:\\r\\specs\\017-x\\tasks.md")).toBe(true);
    expect(isTasksFile("/r/specs/tasks.md")).toBe(false);
    expect(isTasksFile("/r/docs/specs/a/b/tasks.md")).toBe(false);
  });

  it("tách gốc repo và số spec", () => {
    expect(specOf("/r/specs/017-vscode-extension/tasks.md")).toEqual({ root: "/r", spec: "017" });
    expect(specOf("/r/specs/misc/tasks.md").spec).toBe("misc");
  });
});
