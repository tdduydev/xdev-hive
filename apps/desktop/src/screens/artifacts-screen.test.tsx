import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { PROBE_KEY } from "@/lib/artifacts-env.tsx";
import { queryClient } from "@/lib/hub-query.tsx";
import { setLang } from "@/lib/i18n.ts";
import { AT, artifactDetail, fakeArtifactsHub, ID_A, ID_B, settings } from "@/lib/test-artifacts-hub.ts";
import { ArtifactsScreen } from "@/screens/artifacts-screen.tsx";
import { AppShell } from "@/shell/app-shell.tsx";

const user = userEvent.setup({ delay: null });

const markdown = artifactDetail({ id: ID_A, title: "Luồng hoàn tiền", content: "# Tiêu đề hoàn tiền" });
const react = artifactDetail({ id: ID_B, title: "Máy tính phí", type: "react", content: "export default () => <b/>" });

function hubWith(extra: Record<string, unknown> = {}) {
  return fakeArtifactsHub({
    "artifacts/settings": settings,
    "artifacts/list": { items: [markdown.artifact, react.artifact], nextCursor: null },
    "artifacts/get": (input: unknown) => ((input as { id: string }).id === ID_B ? react : markdown),
    "artifacts/versions/list": [markdown.version],
    "artifacts/frameDocument": { html: "<!doctype html><p>khung</p>", csp: "default-src 'none'" },
    ...extra,
  });
}

const goTo = (hash: string) => {
  location.hash = hash;
};

describe("ArtifactsScreen", () => {
  beforeEach(() => {
    setLang("vi");
    goTo("#/artifacts");
  });

  it("thư viện liệt kê artifact từ hub", async () => {
    hubWith();
    render(<ArtifactsScreen />);
    expect((await screen.findAllByText("Luồng hoàn tiền")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Máy tính phí").length).toBeGreaterThan(0);
  });

  it("mở chi tiết theo hash và đệm bản vừa đọc", async () => {
    const hub = hubWith();
    goTo(`#/artifacts/${ID_A}/1`);
    render(<ArtifactsScreen />);
    expect(await screen.findByRole("heading", { name: "Tiêu đề hoàn tiền" })).toBeTruthy();
    await waitFor(() => expect(hub.cache.has(`${ID_A}@1`)).toBe(true));
  });

  it("khung react nạp từ giao thức hive-artifact, không phải địa chỉ hub (CSP của app)", async () => {
    hubWith();
    goTo(`#/artifacts/${ID_B}/1`);
    render(<ArtifactsScreen />);
    const frame = (await screen.findByTitle("Trang của artifact Máy tính phí")) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(`hive-artifact://localhost/frame/${ID_B}/1?theme=light`);
  });

  it("offline: đọc lại artifact react từ bộ đệm khi hub đã tắt sau khi tải (SC-009)", async () => {
    const hub = hubWith();
    goTo(`#/artifacts/${ID_B}/1`);
    const { unmount } = render(<ArtifactsScreen />);
    await screen.findByTitle("Trang của artifact Máy tính phí");
    await waitFor(() => expect(hub.cache.get(`${ID_B}@1`)?.frames.light).toContain("khung"));
    unmount();

    hub.up = false;
    await act(() => queryClient.refetchQueries({ queryKey: PROBE_KEY }));
    queryClient.removeQueries({ queryKey: ["artifacts"] });
    render(<ArtifactsScreen />);
    const frame = (await screen.findByTitle("Trang của artifact Máy tính phí")) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(`hive-artifact://localhost/frame/${ID_B}/1?theme=light`);
    expect((await screen.findAllByText(/Đang offline/)).length).toBeGreaterThan(0);
  });

  it("offline: thư viện hiện các artifact đã đệm", async () => {
    const hub = hubWith();
    goTo(`#/artifacts/${ID_A}/1`);
    const { unmount } = render(<ArtifactsScreen />);
    await screen.findByRole("heading", { name: "Tiêu đề hoàn tiền" });
    await waitFor(() => expect(hub.cache.size).toBe(1));
    unmount();

    hub.up = false;
    await act(() => queryClient.refetchQueries({ queryKey: PROBE_KEY }));
    goTo("#/artifacts");
    render(<ArtifactsScreen />);
    expect(await screen.findByText("Luồng hoàn tiền")).toBeTruthy();
    expect(screen.getByText(/đọc được không cần hub/)).toBeTruthy();
    expect(screen.queryByText("Máy tính phí")).toBeNull();
  });

  it("offline: tắt Nhờ Leader sửa và Link công khai", async () => {
    const hub = hubWith();
    const broken = artifactDetail({ id: ID_B, type: "react", title: "Máy tính phí", compileError: "Unexpected token" });
    hub.replies["artifacts/get"] = broken;
    goTo(`#/artifacts/${ID_B}/1`);
    render(<ArtifactsScreen />);
    const fix = (await screen.findByRole("button", { name: "Nhờ Leader sửa" })) as HTMLButtonElement;
    expect(fix.disabled).toBe(false);

    hub.up = false;
    await act(() => queryClient.refetchQueries({ queryKey: PROBE_KEY }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Nhờ Leader sửa" }) as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it("tạo link công khai cho bản đang xem", async () => {
    hubWith({
      "artifacts/publicLinks/list": [],
      "artifacts/publicLinks/create": {
        link: {
          id: "00000000-0000-4000-8000-0000000000f1",
          artifactId: ID_A,
          version: 1,
          createdBy: "u1",
          createdAt: AT,
          expiresAt: "2099-01-01T00:00:00.000Z",
          revokedAt: null,
          revokedBy: null,
          revokeReason: null,
          viewCount: 0,
          lastViewedAt: null,
          active: true,
        },
        url: "/_artifact/s/SECRET",
      },
    });
    goTo(`#/artifacts/${ID_A}/1`);
    render(<ArtifactsScreen />);
    await user.click(await screen.findByRole("button", { name: "Link công khai" }));
    await user.click(await screen.findByRole("button", { name: "Tạo link" }));
    const field = (await screen.findByLabelText("Link công khai vừa tạo")) as HTMLInputElement;
    expect(field.value).toBe("http://hub.test/_artifact/s/SECRET");
  });

  it("360 px: không tràn ngang", async () => {
    hubWith();
    window.innerWidth = 360;
    render(<ArtifactsScreen />);
    const root = (await screen.findAllByText("Luồng hoàn tiền"))[0]?.closest("div.mx-auto");
    expect(root?.className).toContain("min-w-0");
    expect(root?.className).toContain("w-full");
  });
});

describe("menu theo khả năng của hub", () => {
  const nav = () => screen.getByRole("navigation", { name: "Điều hướng app" });

  it("hub có artifacts thì menu hiện mục Artifact", async () => {
    hubWith();
    render(<AppShell profile="dev" />);
    expect(await within(nav()).findByRole("link", { name: "Artifact" })).toBeTruthy();
  });

  it("hub cũ không có artifacts (404) thì ẩn mục Artifact, Leader vẫn còn", async () => {
    const hub = hubWith();
    delete hub.replies["artifacts/settings"];
    render(<AppShell profile="dev" />);
    await waitFor(() => expect(within(nav()).queryByRole("link", { name: "Artifact" })).toBeNull());
    expect(within(nav()).getByRole("link", { name: "Leader" })).toBeTruthy();
  });
});
