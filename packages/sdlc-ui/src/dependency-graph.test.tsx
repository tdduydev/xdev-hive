import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DependencyGraph, lanesOf, layoutGraph } from "./dependency-graph.tsx";
import { breakdownView, fakeClient, renderWithEnv, testEnv } from "./test-fixtures.tsx";

const b = () => {
  const view = breakdownView().breakdown;
  if (!view) throw new Error("thiếu bản tách");
  return view;
};

describe("layoutGraph", () => {
  it("dự án chính đứng làn đầu dù task đầu thuộc dự án khác", () => {
    const first = b();
    const swapped = { ...first, tasks: [...first.tasks].reverse() };
    expect(lanesOf(swapped, "payment-api")).toEqual(["payment-api", "web-shop"]);
  });

  it("cột theo đợt, cạnh liên dự án nét đứt dày", () => {
    const { nodes, edges } = layoutGraph(b(), "payment-api");
    const x = (id: string) => nodes.find((n) => n.id === id)?.position.x ?? -1;
    expect(x("T002")).toBeGreaterThan(x("T001"));
    expect(x("T003")).toBeGreaterThan(x("T002"));
    const y = (id: string) => nodes.find((n) => n.id === id)?.position.y ?? -1;
    expect(y("T003")).toBeGreaterThan(y("T001"));
    const cross = edges.find((e) => e.id === "T002->T003");
    expect(cross?.data?.cross).toBe(true);
    expect(cross?.style?.strokeDasharray).toBeTruthy();
    expect(edges.find((e) => e.id === "T001->T002")?.data?.cross).toBe(false);
  });
});

describe("DependencyGraph", () => {
  it("dạng danh sách theo đợt ghi rõ phụ thuộc liên dự án", () => {
    renderWithEnv(<DependencyGraph breakdown={b()} homeProject="payment-api" view="list" />, testEnv(fakeClient()));
    const list = screen.getByRole("list", { name: "Task theo đợt" });
    expect(within(list).getByText("Đợt 3")).toBeTruthy();
    expect(within(list).getByText("Sau T002 (liên dự án)")).toBeTruthy();
    expect(within(list).getByText("Sau T001")).toBeTruthy();
  });
});
