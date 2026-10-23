import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ArtifactListQuery } from "@xdev-hive/contracts";
import { describe, expect, it, vi } from "vitest";
import { LinkedArtifacts } from "./linked.tsx";
import { detail, fakeClient, ID_A, ID_B, renderWithEnv, testEnv } from "./test-fixtures.tsx";

const TARGET = "00000000-0000-4000-8000-0000000000f1";

/** Hub giả: `mine` trả hai artifact của tôi, còn lọc theo đích trả những cái đã gắn. */
function linkedClient(attached = [detail({ id: ID_A, title: "Luồng hoàn tiền" }).artifact]) {
  const base = fakeClient();
  const mineItems = [attached[0], detail({ id: ID_B, title: "Checklist" }).artifact].filter((a) => a !== undefined);
  return {
    ...base,
    artifacts: {
      ...base.artifacts,
      list: vi.fn(async (input: ArtifactListQuery) => ({
        items: input.mine ? mineItems : attached,
        nextCursor: null as string | null,
      })),
      links: {
        add: vi.fn(async (_input: { id: string; targetKind: string; targetId: string }) => ({})),
        remove: vi.fn(async (_input: { id: string; targetKind: string; targetId: string }) => ({})),
      },
    },
  };
}

describe("LinkedArtifacts", () => {
  it("lọc theo đích: task, run, hạng mục, tài liệu và dự án đi qua đúng tham số của hub", async () => {
    const cases = [
      [{ kind: "task", id: TARGET }, { taskId: TARGET }],
      [{ kind: "run", id: TARGET }, { runId: TARGET }],
      [{ kind: "sdlc_item", id: TARGET }, { sdlcItemId: TARGET }],
      [{ kind: "doc", id: TARGET }, { docId: TARGET }],
      [{ kind: "project", projectKey: "payment-api" }, { projectKey: "payment-api" }],
    ] as const;
    for (const [target, filter] of cases) {
      const client = linkedClient();
      const view = renderWithEnv(<LinkedArtifacts target={target} />, testEnv(client));
      expect(await screen.findByText("Luồng hoàn tiền")).toBeTruthy();
      expect(client.artifacts.list).toHaveBeenCalledWith({ ...filter, limit: 50 }, expect.anything());
      view.unmount();
    }
  });

  it("danh sách trống hiện câu báo, và người chỉ xem không có nút gắn hay bỏ gắn", async () => {
    renderWithEnv(<LinkedArtifacts target={{ kind: "task", id: TARGET }} />, testEnv({ ...linkedClient([]) }));
    expect(await screen.findByText("Chưa có artifact nào được gắn.")).toBeTruthy();
    expect(screen.queryByText("Gắn artifact")).toBeNull();
    expect(screen.queryByText("Bỏ gắn")).toBeNull();
  });

  it("trang dự án chỉ liệt kê, không cho gắn tay dù canLink", async () => {
    renderWithEnv(
      <LinkedArtifacts target={{ kind: "project", projectKey: "payment-api" }} canLink />,
      testEnv(linkedClient()),
    );
    await screen.findByText("Luồng hoàn tiền");
    expect(screen.queryByText("Gắn artifact")).toBeNull();
  });

  it("gắn artifact của tôi chưa gắn, rồi bỏ gắn", async () => {
    const client = linkedClient();
    renderWithEnv(<LinkedArtifacts target={{ kind: "task", id: TARGET }} canLink />, testEnv(client));
    await screen.findByText("Luồng hoàn tiền");
    // Artifact đã gắn không còn trong ô chọn.
    const select = await screen.findByLabelText("Chọn artifact của bạn để gắn");
    await waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(2));
    expect(Array.from(select.querySelectorAll("option")).map((o) => o.textContent)).toEqual([
      "Chọn artifact của bạn để gắn",
      "Checklist",
    ]);
    fireEvent.change(select, { target: { value: ID_B } });
    fireEvent.click(screen.getByText("Gắn artifact"));
    await waitFor(() => expect(client.artifacts.links.add).toHaveBeenCalled());
    expect(client.artifacts.links.add.mock.calls[0]?.[0]).toEqual({ id: ID_B, targetKind: "task", targetId: TARGET });
    fireEvent.click(screen.getByLabelText("Bỏ gắn artifact Luồng hoàn tiền"));
    await waitFor(() => expect(client.artifacts.links.remove).toHaveBeenCalled());
    expect(client.artifacts.links.remove.mock.calls[0]?.[0]).toEqual({
      id: ID_A,
      targetKind: "task",
      targetId: TARGET,
    });
  });

  it("hiện lỗi của hub khi không đủ quyền gắn", async () => {
    const client = linkedClient();
    client.artifacts.links.add.mockRejectedValueOnce(new Error("Bạn không có quyền gắn vào đích này."));
    renderWithEnv(<LinkedArtifacts target={{ kind: "doc", id: TARGET }} canLink />, testEnv(client));
    const select = await screen.findByLabelText("Chọn artifact của bạn để gắn");
    await waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(2));
    fireEvent.change(select, { target: { value: ID_B } });
    fireEvent.click(screen.getByText("Gắn artifact"));
    expect((await screen.findByRole("alert")).textContent).toBe("Bạn không có quyền gắn vào đích này.");
  });
});
