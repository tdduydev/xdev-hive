import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DiffView, VersionCompare } from "./compare.tsx";
import { detail, fakeClient, ID_A, renderWithEnv, testEnv } from "./test-fixtures.tsx";

const user = userEvent.setup({ delay: null });

const client = () =>
  fakeClient({
    [`${ID_A}@1`]: detail({ version: 1, content: "a\nb\nc\n" }),
    [`${ID_A}@2`]: detail({ version: 2, content: "a\nB\nc\n" }),
    [`${ID_A}@3`]: detail({ version: 3, content: null }),
  });

describe("VersionCompare", () => {
  it("diff dòng: dòng xoá và dòng thêm, rồi chuyển sang cạnh nhau", async () => {
    renderWithEnv(<VersionCompare artifactId={ID_A} left={1} right={2} />, testEnv(client()));
    expect(await screen.findByRole("heading", { name: "v1 → v2" })).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();
    expect(screen.getByText("B")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Khác biệt" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Cạnh nhau" }));
    expect(screen.queryByRole("heading", { name: "v1 → v2" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cạnh nhau" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("hai phiên bản giống nhau thì không gọi hub", () => {
    const fake = client();
    renderWithEnv(<VersionCompare artifactId={ID_A} left={2} right={2} />, testEnv(fake));
    expect(screen.getByText("Chọn hai phiên bản khác nhau để so sánh.")).toBeTruthy();
    expect(fake.artifacts.get).not.toHaveBeenCalled();
  });

  it("bản đã bị xoá vì bí mật thì không so sánh được", async () => {
    renderWithEnv(<VersionCompare artifactId={ID_A} left={1} right={3} />, testEnv(client()));
    expect(await screen.findByText("Phiên bản này đã bị xoá vì chứa bí mật.")).toBeTruthy();
  });

  it("lỗi tải thì hiện lỗi và nút thử lại", async () => {
    renderWithEnv(<VersionCompare artifactId={ID_A} left={1} right={9} />, testEnv(client()));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Thử lại" })).toBeTruthy();
  });

  it("offline thì mời kết nối hub", () => {
    const fake = client();
    renderWithEnv(<VersionCompare artifactId={ID_A} left={1} right={2} />, testEnv(fake, { offline: true }));
    expect(screen.getByText("Đang offline — kết nối hub để dùng thao tác này.")).toBeTruthy();
    expect(fake.artifacts.get).not.toHaveBeenCalled();
  });
});

describe("DiffView", () => {
  it("giống nhau thì báo không đổi", () => {
    renderWithEnv(
      <DiffView before="x\n" after="x\n" beforeLabel="v1" afterLabel="v2" mode="diff" />,
      testEnv(fakeClient()),
    );
    expect(screen.getByText("Hai phiên bản giống nhau.")).toBeTruthy();
  });

  it("đoạn không đổi dài thì gộp thành khoảng 'N dòng không đổi'", () => {
    const body = Array.from({ length: 30 }, (_, i) => `d${i}`).join("\n");
    renderWithEnv(
      <DiffView before={`${body}\nx\n`} after={`${body}\ny\n`} beforeLabel="v1" afterLabel="v2" mode="diff" />,
      testEnv(fakeClient()),
    );
    expect(screen.getByText(/dòng không đổi/)).toBeTruthy();
  });
});
