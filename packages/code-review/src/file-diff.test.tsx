import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FileDiff } from "./file-diff.tsx";
import { collectFindings } from "./findings.ts";
import { aiGate, file, files } from "./test-fixtures.ts";
import { codeReviewText } from "./text.ts";

const t = codeReviewText.vi;
const prUrl = "https://github.com/acme/pay/pull/128";
const findings = collectFindings([aiGate]);

// delay mặc định chờ một macrotask sau mỗi thao tác; máy tải cao thì mỗi lần chờ kéo dài và test chạm trần thời gian.
const user = userEvent.setup({ delay: null });

describe("FileDiff", () => {
  it("hiện thêm/xoá và gắn phát hiện AI ngay dưới dòng", () => {
    render(<FileDiff data={files()} findings={findings} prUrl={prUrl} t={t} />);
    const patch = screen.getByRole("region", { name: "Patch của src/refund.ts" });
    expect(within(patch).getByText(/return b;/)).toBeTruthy();
    // Phát hiện gắn dòng 11 hiện trong diff; phát hiện không có dòng hiện ở mục riêng.
    expect(within(patch).getByText("Chưa chặn tổng hoàn vượt số tiền gốc.")).toBeTruthy();
    expect(screen.getByText("Phát hiện không gắn dòng")).toBeTruthy();
    expect(screen.getByText("Nên tách hàm.")).toBeTruthy();
  });

  it("danh sách file có số phát hiện và +/−", () => {
    render(<FileDiff data={files()} findings={findings} prUrl={prUrl} t={t} />);
    const nav = screen.getByRole("navigation", { name: "Danh sách file" });
    expect(within(nav).getByLabelText("2 phát hiện của AI trong file này")).toBeTruthy();
    expect(within(nav).getAllByText("+2")[0]).toBeTruthy();
    expect(within(nav).getAllByText("−1")[0]).toBeTruthy();
  });

  it("file bị cắt patch hiện link mở trên nhà cung cấp Git thay vì diff", async () => {
    render(<FileDiff data={files()} findings={[]} prUrl={prUrl} t={t} />);
    await userEvent.click(screen.getByRole("button", { name: /src\/big\.ts/ }));
    expect(screen.getByText("File quá lớn để hiện ở đây")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mở trên GitHub" }).getAttribute("href")).toBe(prUrl);
    expect(screen.queryByRole("region", { name: /Patch của/ })).toBeNull();
  });

  it("GitLab: tên nhà cung cấp theo máy chủ", async () => {
    render(<FileDiff data={files()} findings={[]} prUrl="https://gitlab.acme.vn/a/b/-/merge_requests/3" t={t} />);
    await userEvent.click(screen.getByRole("button", { name: /src\/big\.ts/ }));
    expect(screen.getByRole("link", { name: "Mở trên GitLab" })).toBeTruthy();
  });

  it("patch vượt ngưỡng dòng cũng đưa link ra PR", () => {
    const huge = `@@ -1,1 +1,1 @@\n${"+x\n".repeat(3500)}`;
    render(<FileDiff data={files({ files: [file({ patch: huge })] })} findings={[]} prUrl={prUrl} t={t} />);
    expect(screen.getByText("File quá lớn để hiện ở đây")).toBeTruthy();
  });

  it("PR 100 file chỉ dựng patch của file đang chọn", async () => {
    const many = Array.from({ length: 100 }, (_, i) => file({ path: `src/f${i}.ts` }));
    render(<FileDiff data={files({ files: many })} findings={[]} prUrl={prUrl} t={t} />);
    expect(screen.getAllByRole("button")).toHaveLength(100);
    expect(screen.getAllByRole("region")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /src\/f42\.ts/ }));
    expect(screen.getByRole("region", { name: "Patch của src/f42.ts" })).toBeTruthy();
  });

  it("báo khi PR có nhiều file hơn giới hạn đọc", () => {
    render(<FileDiff data={files({ truncated: true })} findings={[]} prUrl={prUrl} t={t} />);
    expect(screen.getByText(/nhiều file hơn giới hạn/)).toBeTruthy();
  });

  it("PR không file nào", () => {
    render(<FileDiff data={files({ files: [] })} findings={[]} prUrl={prUrl} t={t} />);
    expect(screen.getByText("PR không có file nào đổi.")).toBeTruthy();
  });
});
