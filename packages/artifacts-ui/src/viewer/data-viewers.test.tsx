import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { detail, fakeClient, ID_A, renderWithEnv, testEnv } from "../test-fixtures.tsx";
import { ArtifactViewer } from "./index.tsx";

const user = userEvent.setup({ delay: null });

function view(type: "svg" | "json" | "csv", content: string) {
  const d = detail({ type, content });
  const client = fakeClient({ [ID_A]: d });
  const out = renderWithEnv(
    <ArtifactViewer artifact={d.artifact} version={d.version} />,
    testEnv(client, { frameBase: "http://hub.test" }),
  );
  return { ...out, client };
}

describe("SvgViewer", () => {
  it("chạy trong khung cách ly, không chèn SVG vào DOM của trang", async () => {
    const content = '<svg onload="window.pwned=1"><script>window.pwned=1</script></svg>';
    const { container, client } = view("svg", content);
    const frame = (await screen.findByTitle("Trang của artifact Luồng hoàn tiền")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(container.querySelector("script, [onload]")).toBeNull();
    expect(client.artifacts.frameUrl).toHaveBeenCalled();
  });
});

describe("JsonViewer", () => {
  it("dựng cây thu mở được, khoá và chuỗi chỉ là chữ", async () => {
    const content = JSON.stringify({
      name: "<img src=x onerror=alert(1)>",
      tags: ["a", "b"],
      nested: { deep: { x: 1 } },
      empty: [],
    });
    const { container } = view("json", content);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('"<img src=x onerror=alert(1)>"');
    expect(container.textContent).toContain("[] (rỗng)");
    // Độ sâu 2 trở đi đóng sẵn: `x` nằm ở độ sâu 3.
    expect(container.textContent).not.toContain("x: 1");
    await user.click(screen.getByRole("button", { name: "Mở rộng deep" }));
    expect(container.textContent).toContain("x: 1");
    await user.click(screen.getByRole("button", { name: "Thu gọn deep" }));
    expect(container.textContent).not.toContain("x: 1");
  });

  it("JSON hỏng hiện lý do và nguồn", () => {
    const { container } = view("json", '{"a": ');
    expect(screen.getByRole("alert").textContent).toContain("JSON không hợp lệ");
    expect(container.querySelector("code")?.textContent).toContain('{"a": ');
  });

  it("giá trị gốc là null vẫn hiện", () => {
    const { container } = view("json", "null");
    expect(container.textContent).toContain("null");
  });
});

describe("CsvViewer", () => {
  const csv = 'Tháng,Doanh thu,Ghi chú\nT1,10,"có, dấu phẩy"\nT2,20,<b>đậm</b>\n';

  it("bảng bằng chữ thuần, giữ ô có dấu phẩy, không dựng HTML", () => {
    const { container } = view("csv", csv);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("có, dấu phẩy");
    expect(container.textContent).toContain("<b>đậm</b>");
  });

  it("chuyển sang biểu đồ thì vẽ trong khung", async () => {
    const { container } = view("csv", csv);
    expect(container.querySelector("iframe")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Biểu đồ" }));
    expect(await screen.findByTitle("Trang của artifact Luồng hoàn tiền")).toBeTruthy();
    expect(container.querySelector("table")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Bảng" }));
    expect(container.querySelector("table")).toBeTruthy();
  });

  it("không có cột số thì không có tab biểu đồ", () => {
    view("csv", "Tên,Vai trò\nAn,Dev\n");
    expect(screen.queryByRole("button", { name: "Biểu đồ" })).toBeNull();
  });

  it("tệp rỗng", () => {
    view("csv", "");
    expect(screen.getByText("Tệp CSV không có dữ liệu.")).toBeTruthy();
  });
});
