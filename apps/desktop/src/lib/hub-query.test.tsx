import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api, queryClient } from "@/lib/hub-query.tsx";

function fakeHub() {
  const paths: string[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        if (command !== "hub_rpc") throw new Error(`Không mong lệnh ${command}`);
        paths.push(String(args?.path));
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ json: [] }),
        } as T;
      },
    },
  };
  return paths;
}

function Teams() {
  const teams = useQuery(api.teams.list.queryOptions());
  return <p>{teams.data ? `${teams.data.length} đội` : "Đang đọc…"}</p>;
}

const mount = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <Teams />
    </QueryClientProvider>,
  );

describe("queryClient của app", () => {
  it("chuyển màn rồi quay lại trong lúc dữ liệu còn mới thì không gọi hub lần nữa", async () => {
    const paths = fakeHub();
    const first = mount();
    await screen.findByText("0 đội");
    first.unmount();
    mount();
    await screen.findByText("0 đội");
    await act(async () => {});
    expect(paths).toHaveLength(1);
  });

  it("invalidate sau khi ghi vẫn tải lại ngay", async () => {
    const paths = fakeHub();
    mount();
    await screen.findByText("0 đội");
    await act(() => queryClient.invalidateQueries());
    expect(paths).toHaveLength(2);
  });
});
