import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ArtifactCard } from "./card.tsx";
import { fakeClient, ID_A, renderWithEnv, testEnv } from "./test-fixtures.tsx";

describe("ArtifactCard", () => {
  it("hiện loại, phiên bản và mở đúng bản của thẻ", async () => {
    const onOpen = vi.fn();
    const ref = { id: ID_A, version: 3, title: "Máy tính phí", type: "react" as const };
    renderWithEnv(<ArtifactCard artifact={ref} onOpen={onOpen} />, testEnv(fakeClient()));
    expect(screen.getByRole("article", { name: "Artifact Máy tính phí, phiên bản 3" })).toBeTruthy();
    expect(screen.getByText("react · v3")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Mở" }));
    expect(onOpen).toHaveBeenCalledWith(ref);
  });

  it("thẻ của artifact đã xoá hoặc không đọc được", () => {
    renderWithEnv(<ArtifactCard artifact={null} />, testEnv(fakeClient(), { lang: "en" }));
    expect(screen.getByText("Artifact is no longer accessible.")).toBeTruthy();
  });
});
