import { describe, expect, it, vi } from "vitest";
import type * as VSCode from "vscode";
import type { HubStatus } from "@/codelens/hub-status.ts";
import { TasksLensProvider } from "@/codelens/tasks-lens.ts";
import { asLenses, fakeDocument } from "@/codelens/test-support.ts";

vi.mock("vscode", async (original) => {
  const base = await original<typeof VSCode>();
  const extras = await import("@/codelens/test-support.ts");
  return { ...base, Range: extras.Range, CodeLens: extras.CodeLens };
});

const path = "/repo/specs/017-vscode-extension/tasks.md";
const titles = (lenses: { command?: { title: string } }[]) => lenses.map((l) => l.command?.title);

function status(options: { signedOut?: boolean; running?: Record<string, string> } = {}) {
  return {
    isSignedOut: options.signedOut ?? false,
    lookup: (_root: string, _spec: string, code: string) =>
      options.running?.[code] ? { runId: options.running[code], kind: "running" as const } : undefined,
  } as unknown as HubStatus;
}
function provider(options: { trusted?: boolean; enabled?: boolean; status?: HubStatus } = {}) {
  const watch = vi.fn();
  return {
    watch,
    lens: new TasksLensProvider({
      enabled: () => options.enabled ?? true,
      trusted: () => options.trusted ?? true,
      status: options.status ?? status(),
      watch,
    }),
  };
}

const text = [
  "- [ ] **T001 — Khung**",
  "  - **PHẠM VI**: `a/**`",
  "- [x] **T002 — Xong rồi**",
  "- [ ] **T003 — Đang chạy**",
].join("\n");

describe("TasksLensProvider", () => {
  it("mỗi task chưa xong có lens Giao agent; task đã xong thì không", () => {
    const { lens, watch } = provider();
    const lenses = asLenses(lens.provideCodeLenses(fakeDocument(path, text) as never));
    expect(titles(lenses)).toEqual(["Giao agent", "Giao agent"]);
    expect(lenses.map((l) => l.range.start.line)).toEqual([0, 3]);
    expect(lenses[0]?.command.arguments).toEqual([
      { uri: `file://${path}`, code: "T001", spec: "017", title: "Khung" },
    ]);
    expect(watch).toHaveBeenCalledWith("/repo", "017");
  });

  it("hub có task đang chạy thì hiện run thay cho Giao agent", () => {
    const { lens } = provider({ status: status({ running: { T003: "abcdef12-0000-4000-8000-000000000000" } }) });
    const lenses = asLenses(lens.provideCodeLenses(fakeDocument(path, text) as never));
    expect(titles(lenses)).toEqual(["Giao agent", "Đang chạy · run #abcdef12"]);
    expect(lenses[1]?.command.command).toBe("xdevHive.run.openLog");
  });

  it("chưa đăng nhập: thêm lens Đăng nhập để thấy trạng thái", () => {
    const { lens } = provider({ status: status({ signedOut: true }) });
    const lenses = asLenses(lens.provideCodeLenses(fakeDocument(path, text) as never));
    expect(titles(lenses)).toEqual([
      "Giao agent",
      "Đăng nhập để thấy trạng thái",
      "Giao agent",
      "Đăng nhập để thấy trạng thái",
    ]);
    expect(lenses[1]?.command.command).toBe("xdevHive.signIn");
  });

  it("Restricted Mode: không có lens Giao agent", () => {
    const { lens } = provider({ trusted: false, status: status({ running: { T003: "abcdef12" } }) });
    const lenses = asLenses(lens.provideCodeLenses(fakeDocument(path, text) as never));
    expect(titles(lenses)).not.toContain("Giao agent");
    expect(titles(lenses)).toEqual(["Đang chạy · run #abcdef12"]);
  });

  it("tắt xdevHive.codeLens.enabled thì không có lens và không hỏi hub", () => {
    const { lens, watch } = provider({ enabled: false });
    expect(lens.provideCodeLenses(fakeDocument(path, text) as never)).toEqual([]);
    expect(watch).not.toHaveBeenCalled();
  });

  it("tasks.md 300 dòng dựng lens trong 50 ms", () => {
    const lines: string[] = [];
    for (let i = 0; lines.length < 300; i++) {
      lines.push(`- [ ] **T${String(i).padStart(3, "0")} [P] [US1] [vừa] · 1 ngày — Việc số ${i}**`);
      lines.push("  - **Phụ thuộc**: T001.", `  - **PHẠM VI**: \`apps/x/${i}/**\``);
    }
    const { lens } = provider({ status: status({ signedOut: true }) });
    // Lần đầu gồm cả parse; tính thời gian trên lần xấu nhất (tài liệu đổi version).
    const doc = fakeDocument(path, lines.slice(0, 300).join("\n"), 1);
    const start = performance.now();
    const lenses = asLenses(lens.provideCodeLenses(doc as never));
    const elapsed = performance.now() - start;
    expect(lenses.length).toBeGreaterThan(100);
    expect(elapsed).toBeLessThan(50);
  });

  it("không parse lại khi version không đổi", () => {
    const { lens } = provider();
    const doc = fakeDocument(path, text, 5);
    const getText = vi.spyOn(doc, "getText");
    lens.provideCodeLenses(doc as never);
    lens.provideCodeLenses(doc as never);
    expect(getText).toHaveBeenCalledTimes(1);
  });
});
