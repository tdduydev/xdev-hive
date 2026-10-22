import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharedContextSection } from "@/components/shared-context-section.tsx";
import type { ContextMigration, ContextProject } from "@/lib/context-sync.ts";
import { setLang } from "@/lib/i18n.ts";

const FOLDER = "/work/app";
const KEY = "p_1";

const project = (over: Partial<ContextProject> = {}): ContextProject => ({
  key: KEY,
  projectId: "7f3c1b52-0a1e-4c0e-9d57-2f4c8f0b6a11",
  folder: FOLDER,
  enabled: true,
  sourceTokens: 120,
  blockTokens: 340,
  targets: [
    { id: "claude", path: "CLAUDE.local.md", status: "ok", reason: null },
    { id: "codex", path: "AGENTS.override.md", status: "skipped", reason: "Chưa cài Codex." },
    {
      id: "gemini",
      path: "GEMINI.local.md",
      status: "conflict",
      reason: null,
      conflict: { file: "# Tại máy (sửa tay)\n", source: "# Nguồn\n" },
    },
    { id: "antigravity", path: ".agents/rules/xdev-hive.md", status: "stale", reason: null },
  ],
  hub: null,
  autoSync: { enabled: false, minutes: 60, source: "machine" },
  ...over,
});

type Handler = (args: Record<string, unknown>) => unknown;

/** Lệnh Tauri giả: mỗi lệnh `context_*` một hàm, ghi lại đối số theo thứ tự gọi. */
function fakeTauri(handlers: Record<string, Handler>) {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args: Record<string, unknown> = {}) => {
        calls.push({ command, args });
        const handler = handlers[command];
        if (!handler) throw new Error(`Lệnh chưa giả: ${command}`);
        return (await handler(args)) as T;
      },
    },
  };
  return calls;
}

const candidates = [{ folder: FOLDER, projectId: "7f3c1b52-0a1e-4c0e-9d57-2f4c8f0b6a11" }];
const renderSection = (onMigrated = vi.fn()) => {
  render(<SharedContextSection candidates={candidates} onMigrated={onMigrated} />);
  return onMigrated;
};

beforeEach(() => setLang("vi"));

describe("SharedContextSection", () => {
  it("bật: dự án chưa dùng chung thì nút Bật gọi context_enable với thư mục và id dự án", async () => {
    const calls = fakeTauri({
      context_status: () => ({ projects: [] }),
      context_enable: () => project(),
    });
    renderSection();
    const enable = await screen.findByRole("button", { name: "Bật ngữ cảnh dùng chung" });
    await userEvent.click(enable);
    expect(await screen.findByRole("switch", { name: "Dùng chung ngữ cảnh cho dự án này" })).toBeTruthy();
    expect(calls.find((c) => c.command === "context_enable")?.args).toEqual({
      folder: FOLDER,
      projectId: "7f3c1b52-0a1e-4c0e-9d57-2f4c8f0b6a11",
    });
  });

  it("bảng file đích hiện CLI, đường dẫn, trạng thái, lý do và ước lượng token của khối", async () => {
    fakeTauri({ context_status: () => ({ projects: [project()] }) });
    renderSection();
    const targets = await screen.findByRole("region", { name: "File đích" });
    const rows = within(targets).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(within(rows[0] as HTMLElement).getByText("CLAUDE.local.md")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Đúng")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Chưa cài Codex.")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Bỏ qua")).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText("Lệch")).toBeTruthy();
    expect(screen.getByText(/Nguồn 120 token · khối ghi vào file 340 token/)).toBeTruthy();
  });

  it("lưu nguồn: gửi nội dung đã soạn tới context_save_source rồi hiện trạng thái mới", async () => {
    const calls = fakeTauri({
      context_status: () => ({ projects: [project()] }),
      context_save_source: () =>
        project({
          sourceTokens: 7,
          targets: project().targets.map((t) => ({ ...t, status: "ok" as const, conflict: null })),
        }),
    });
    renderSection();
    const box = await screen.findByRole("textbox", { name: "Nguồn ngữ cảnh" });
    const save = screen.getByRole("button", { name: "Lưu và đồng bộ" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.type(box, "Dùng pnpm.");
    await userEvent.click(save);
    expect(await screen.findByText("Đã lưu nguồn và đồng bộ.")).toBeTruthy();
    expect(calls.find((c) => c.command === "context_save_source")?.args).toEqual({
      project: KEY,
      content: "Dùng pnpm.",
    });
    expect(screen.getByText(/Nguồn 7 token/)).toBeTruthy();
    expect(screen.queryByText("Xung đột")).toBeNull();
  });

  it("xung đột: hộp so sánh hai bản, giữ bản nguồn gọi context_resolve", async () => {
    const calls = fakeTauri({
      context_status: () => ({ projects: [project()] }),
      context_resolve: () =>
        project({ targets: project().targets.map((t) => ({ ...t, status: "ok" as const, conflict: null })) }),
    });
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "So sánh bản file và bản nguồn: Gemini" }));
    const box = screen.getByRole("region", { name: "So sánh bản file và bản nguồn" });
    expect((within(box).getByRole("textbox", { name: "Bản trong file" }) as HTMLTextAreaElement).value).toContain(
      "Tại máy (sửa tay)",
    );
    expect((within(box).getByRole("textbox", { name: "Bản từ nguồn" }) as HTMLTextAreaElement).value).toContain(
      "# Nguồn",
    );
    await userEvent.click(within(box).getByRole("button", { name: "Giữ bản nguồn" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "So sánh bản file và bản nguồn" })).toBeNull());
    expect(calls.find((c) => c.command === "context_resolve")?.args).toEqual({
      project: KEY,
      target: "gemini",
      keep: "source",
    });
  });

  it("tắt: gạt công tắc phải xác nhận, Huỷ không gọi gì, Tắt gọi context_disable", async () => {
    let enabled = true;
    const calls = fakeTauri({
      context_status: () => ({ projects: enabled ? [project()] : [] }),
      context_disable: () => {
        enabled = false;
        return { removed: ["CLAUDE.local.md"], trashed: [] };
      },
    });
    renderSection();
    const toggle = await screen.findByRole("switch", { name: "Dùng chung ngữ cảnh cho dự án này" });
    await userEvent.click(toggle);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Huỷ" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.command === "context_disable")).toBe(false);

    await userEvent.click(toggle);
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Tắt" }));
    expect(await screen.findByRole("button", { name: "Bật ngữ cảnh dùng chung" })).toBeTruthy();
    expect(calls.find((c) => c.command === "context_disable")?.args).toEqual({ project: KEY });
  });

  it("chuyển từ chia sẻ cũ: xem trước bản nháp, Chuyển gọi context_migrate với apply và báo màn Memory", async () => {
    const migration: ContextMigration = { draft: "# Bản nháp từ memory cũ\n", files: ["a.md", "b.md"] };
    const calls = fakeTauri({
      context_status: () => ({ projects: [] }),
      context_enable: () => ({ ...project(), migration }),
      context_migrate: () => migration,
    });
    const onMigrated = renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Bật ngữ cảnh dùng chung" }));
    const offer = await screen.findByRole("region", { name: "Chuyển từ cách chia sẻ memory cũ" });
    expect(within(offer).getByText(/chia sẻ 2 file memory/)).toBeTruthy();
    const draft = within(offer).getByRole("textbox", { name: "Bản nháp nguồn mới" }) as HTMLTextAreaElement;
    expect(draft.value).toBe("# Bản nháp từ memory cũ\n");
    expect(calls.some((c) => c.command === "context_migrate")).toBe(false);
    await userEvent.click(within(offer).getByRole("button", { name: "Chuyển sang nguồn mới" }));
    await waitFor(() => expect(onMigrated).toHaveBeenCalledTimes(1));
    expect(calls.find((c) => c.command === "context_migrate")?.args).toEqual({ project: KEY, apply: true });
    expect(screen.queryByRole("region", { name: "Chuyển từ cách chia sẻ memory cũ" })).toBeNull();
  });

  it("lỗi của sidecar hiện bằng thông báo, không làm mất màn", async () => {
    fakeTauri({
      context_status: () => ({ projects: [project()] }),
      context_save_source: () => {
        throw new Error("Nguồn ngữ cảnh quá lớn.");
      },
    });
    renderSection();
    await userEvent.type(await screen.findByRole("textbox", { name: "Nguồn ngữ cảnh" }), "x");
    await userEvent.click(screen.getByRole("button", { name: "Lưu và đồng bộ" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Nguồn ngữ cảnh quá lớn.");
    expect(screen.getByRole("textbox", { name: "Nguồn ngữ cảnh" })).toBeTruthy();
  });

  it("chữ tiếng Anh khi đổi ngôn ngữ", async () => {
    setLang("en");
    fakeTauri({ context_status: () => ({ projects: [] }) });
    renderSection();
    expect(await screen.findByRole("button", { name: "Turn on shared context" })).toBeTruthy();
  });
});
