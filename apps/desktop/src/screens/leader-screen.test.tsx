import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROBE_KEY } from "@/lib/artifacts-env.tsx";
import { queryClient } from "@/lib/hub-query.tsx";
import { setLang } from "@/lib/i18n.ts";
import { AT, artifactDetail, fakeArtifactsHub, ID_A, ID_B, settings, THREAD } from "@/lib/test-artifacts-hub.ts";
import { LeaderScreen } from "@/screens/leader-screen.tsx";

const user = userEvent.setup({ delay: null });
const PROJECT = "0a0a0a0a-0000-4000-8000-000000000003";
const APPROVAL = "00000000-0000-4000-8000-0000000000e1";
const msg = (id: string, role: "user" | "leader", content: string, artifact: unknown = null) => ({
  id,
  role,
  content,
  runId: null,
  createdAt: AT,
  artifact,
  pageErrors: null,
});
const ref = (id: string, title: string, type: string) => ({ id, version: 1, title, type, deleted: false });

const markdown = artifactDetail({ id: ID_A, title: "Luồng hoàn tiền", content: "# Tiêu đề hoàn tiền" });
const broken = artifactDetail({
  id: ID_B,
  title: "Máy tính phí",
  type: "react",
  compileError: "Unexpected token (3:4)",
});

const proposal = {
  id: APPROVAL,
  threadId: THREAD,
  action: { type: "task.create", projectId: PROJECT, title: "Làm màn hoàn tiền", body: "" },
  status: "pending",
  expiresAt: "2099-01-01T00:00:00.000Z",
  decidedBy: null,
  reason: null,
  createdAt: AT,
};

function hubWith(extra: Record<string, unknown> = {}) {
  const messages = [
    msg("00000000-0000-4000-8000-0000000000c1", "user", "Vẽ luồng hoàn tiền"),
    msg("00000000-0000-4000-8000-0000000000c2", "leader", "Luồng hoàn tiền", ref(ID_A, "Luồng hoàn tiền", "markdown")),
    msg("00000000-0000-4000-8000-0000000000c3", "leader", "Máy tính phí", ref(ID_B, "Máy tính phí", "react")),
  ];
  return fakeArtifactsHub({
    "artifacts/settings": settings,
    "leader/threads/list": [{ id: THREAD, projectId: null, title: "Hoàn tiền", createdAt: AT, updatedAt: AT }],
    "leader/threads/get": {
      thread: { id: THREAD, projectId: null, title: "Hoàn tiền", createdAt: AT, updatedAt: AT },
      messages,
    },
    "leader/approvals/list": [proposal],
    "projects/list": [],
    "artifacts/get": (input: unknown) => ((input as { id: string }).id === ID_B ? broken : markdown),
    "artifacts/versions/list": [markdown.version],
    "artifacts/frameDocument": { html: "<p>khung</p>", csp: "x" },
    ...extra,
  });
}

function setMedia(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: wide,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

describe("LeaderScreen", () => {
  beforeEach(() => {
    setLang("vi");
    location.hash = "#/leader";
    setMedia(true);
  });
  afterEach(() => {
    // @ts-expect-error jsdom không có matchMedia: trả về trạng thái gốc cho test khác.
    window.matchMedia = undefined;
  });

  it("hiện tin nhắn, thẻ artifact và thẻ đề xuất chờ duyệt", async () => {
    hubWith();
    render(<LeaderScreen />);
    expect(await screen.findByText("Vẽ luồng hoàn tiền")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Luồng hoàn tiền/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Máy tính phí/ })).toBeTruthy();
    expect(await screen.findByText(/Làm màn hoàn tiền/)).toBeTruthy();
  });

  it("duyệt đề xuất gọi hub với id của đề xuất", async () => {
    const hub = hubWith({
      "leader/approvals/approve": { approval: { ...proposal, status: "approved" }, result: null },
    });
    render(<LeaderScreen />);
    await user.click(await screen.findByRole("button", { name: "Duyệt và thực hiện" }));
    await waitFor(() =>
      expect(hub.calls.find((c) => c.path === "leader/approvals/approve")?.input).toMatchObject({ id: APPROVAL }),
    );
  });

  it("từ chối đề xuất cần lý do", async () => {
    const hub = hubWith({ "leader/approvals/reject": { ...proposal, status: "rejected", reason: "Chưa cần" } });
    render(<LeaderScreen />);
    await user.click(await screen.findByRole("button", { name: "Từ chối…" }));
    await user.type(await screen.findByLabelText("Lý do từ chối"), "Chưa cần");
    await user.click(screen.getByRole("button", { name: "Từ chối" }));
    await waitFor(() =>
      expect(hub.calls.find((c) => c.path === "leader/approvals/reject")?.input).toMatchObject({
        id: APPROVAL,
        reason: "Chưa cần",
      }),
    );
  });

  it("gửi tin bằng Enter", async () => {
    const hub = hubWith({
      "leader/threads/send": { message: msg("00000000-0000-4000-8000-0000000000c9", "user", "Chào"), runId: null },
    });
    render(<LeaderScreen />);
    await user.type(await screen.findByLabelText("Nhắn cho Leader"), "Chào{Enter}");
    await waitFor(() =>
      expect(hub.calls.find((c) => c.path === "leader/threads/send")?.input).toEqual({ id: THREAD, content: "Chào" }),
    );
  });

  it("bấm thẻ mở khung bên cạnh; mở bản đệm vào bộ đệm của máy", async () => {
    const hub = hubWith();
    render(<LeaderScreen />);
    await user.click(await screen.findByRole("button", { name: /Luồng hoàn tiền/ }));
    expect(await screen.findByRole("heading", { name: "Tiêu đề hoàn tiền" })).toBeTruthy();
    await waitFor(() => expect(hub.cache.has(`${ID_A}@1`)).toBe(true));
  });

  it("Nhờ Leader sửa: gửi lỗi biên dịch tới hub rồi sang cuộc trò chuyện nhận lời nhờ", async () => {
    const NEW = "00000000-0000-4000-8000-0000000000d2";
    const hub = hubWith({ "artifacts/askLeaderFix": { threadId: NEW, messageId: ID_A, runId: null } });
    render(<LeaderScreen />);
    await user.click(await screen.findByRole("button", { name: /Máy tính phí/ }));
    await user.click(await screen.findByRole("button", { name: "Nhờ Leader sửa" }));
    await user.click(await screen.findByRole("button", { name: "Gửi yêu cầu sửa" }));
    await waitFor(() => expect(hub.calls.some((c) => c.path === "artifacts/askLeaderFix")).toBe(true));
    expect(hub.calls.find((c) => c.path === "artifacts/askLeaderFix")?.input).toMatchObject({
      id: ID_B,
      version: 1,
      errors: [{ kind: "compile", message: "Unexpected token (3:4)" }],
    });
    await waitFor(() => expect(location.hash).toBe(`#/leader/${NEW}`));
  });

  it("offline: báo cần hub, trỏ sang màn Artifact (SC-009)", async () => {
    const hub = hubWith();
    render(<LeaderScreen />);
    await screen.findByText("Vẽ luồng hoàn tiền");
    hub.up = false;
    await act(() => queryClient.refetchQueries({ queryKey: PROBE_KEY }));
    expect(await screen.findByText(/Đang offline: Leader cần hub/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mở màn Artifact" }).getAttribute("href")).toBe("#/artifacts");
  });

  it("360 px: khung thay chỗ chat và có nút quay lại", async () => {
    setMedia(false);
    hubWith();
    render(<LeaderScreen />);
    await user.click(await screen.findByRole("button", { name: /Luồng hoàn tiền/ }));
    expect(await screen.findByRole("heading", { name: "Tiêu đề hoàn tiền" })).toBeTruthy();
    expect(screen.queryByLabelText("Nhắn cho Leader")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Về cuộc trò chuyện" }));
    const composer = await screen.findByLabelText("Nhắn cho Leader");
    expect(within(composer.closest("section") as HTMLElement).getByText(/Enter để gửi/)).toBeTruthy();
  });
});
