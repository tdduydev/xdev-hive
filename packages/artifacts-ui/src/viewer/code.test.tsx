import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeClient, renderWithEnv, testEnv } from "../test-fixtures.tsx";
import { CodeViewer } from "./code.tsx";
import { highlight } from "./highlight.ts";

const user = userEvent.setup({ delay: null });

describe("CodeViewer", () => {
  it("tô màu bằng token chữ, có số dòng, không dựng HTML trong nguồn", async () => {
    const source = 'const html = "<img src=x onerror=alert(1)>";\n\nexport default html;';
    const { container } = renderWithEnv(<CodeViewer content={source} language="ts" />, testEnv(fakeClient()));
    await waitFor(() => expect(container.querySelector('span[style*="--shiki-light"]')).toBeTruthy(), {
      timeout: 15_000,
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("code")?.textContent).toContain('"<img src=x onerror=alert(1)>"');
    const numbers = [...container.querySelectorAll("code > span[aria-hidden]")].map((n) => n.textContent);
    expect(numbers).toEqual(["1", "2", "3"]);
  });

  it("ngôn ngữ lạ hiện chữ thường; bật tắt ngắt dòng", async () => {
    const { container } = renderWithEnv(<CodeViewer content="xin chào" language="không-có" />, testEnv(fakeClient()));
    expect(container.querySelector("code")?.textContent).toContain("xin chào");
    const pre = container.querySelector("pre");
    expect(pre?.className).toContain("whitespace-pre-wrap");
    await user.click(screen.getByLabelText("Ngắt dòng"));
    expect(pre?.className).toContain("overflow-x-auto");
    expect(await highlight("x", "không-có")).toBeNull();
  });
});
