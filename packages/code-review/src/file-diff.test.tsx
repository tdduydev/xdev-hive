import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CodeReviewCommentThread } from "@xdev-hive/contracts";
import { describe, expect, it, vi } from "vitest";
import { FileDiff } from "./file-diff.tsx";
import { collectFindings } from "./findings.ts";
import { aiGate, file, files, HEAD } from "./test-fixtures.ts";
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

const humanThread = (over: Partial<CodeReviewCommentThread> = {}): CodeReviewCommentThread => ({
  id: "thread",
  path: "src/refund.ts",
  line: 11,
  side: "new",
  headSha: HEAD,
  outdated: false,
  resolved: false,
  resolvedAt: null,
  resolvedBy: null,
  comments: [],
  ...over,
});

describe("FileDiff comments", () => {
  it("thêm ở dòng xoá và dòng mới gửi đúng phía, đường dẫn và SHA", async () => {
    const onAddComment = vi.fn();
    render(<FileDiff data={files()} findings={[]} prUrl={prUrl} t={t} threads={[]} onAddComment={onAddComment} />);
    for (const side of ["old", "new"] as const) {
      await user.click(screen.getByRole("button", { name: t.commentAt(side, 11) }));
      await user.type(screen.getByRole("textbox"), "Thêm test");
      await user.click(screen.getByRole("button", { name: t.addComment }));
      expect(onAddComment).toHaveBeenLastCalledWith(
        { path: "src/refund.ts", line: 11, side, headSha: HEAD },
        "Thêm test",
      );
    }
  });

  it("luồng đúng phía gắn dòng; luồng cũ và ngoài hunk vẫn hiện ngoài patch", () => {
    render(
      <FileDiff
        data={files()}
        findings={[]}
        prUrl={prUrl}
        t={t}
        threads={[
          humanThread(),
          humanThread({ id: "old", side: "old", outdated: true }),
          humanThread({ id: "outside", line: 999 }),
        ]}
      />,
    );
    const patch = screen.getByRole("region", { name: t.patchOf("src/refund.ts") });
    expect(within(patch).getByRole("region", { name: /11 \(mới\)/ })).toBeTruthy();
    expect(within(patch).queryByRole("region", { name: /11 \(cũ\)/ })).toBeNull();
    expect(screen.getByText(t.outdatedThread)).toBeTruthy();
    expect(screen.getByRole("region", { name: /999/ })).toBeTruthy();
  });

  it("không gắn bình luận từ commit cũ vào dòng trùng số của commit mới", () => {
    render(
      <FileDiff
        data={files({ headSha: "b".repeat(40) })}
        findings={[]}
        prUrl={prUrl}
        t={t}
        threads={[humanThread()]}
      />,
    );
    expect(screen.getByText(t.outdatedThread)).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: t.patchOf("src/refund.ts") })).queryByText(t.outdatedThread),
    ).toBeNull();
  });

  it("luồng không mất khi file nhị phân hoặc file không còn trong PR", async () => {
    const view = render(
      <FileDiff
        data={files()}
        findings={[]}
        prUrl={prUrl}
        t={t}
        threads={[
          humanThread({ path: "src/big.ts" }),
          humanThread({ id: "gone", path: "src/deleted.ts", outdated: true }),
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /src\/big.ts/ }));
    expect(screen.getByRole("region", { name: /src\/big.ts:11/ })).toBeTruthy();
    expect(screen.getByRole("region", { name: /src\/deleted.ts:11/ })).toBeTruthy();
    view.rerender(<FileDiff data={files({ files: [] })} findings={[]} prUrl={prUrl} t={t} threads={[humanThread()]} />);
    expect(screen.getByRole("region", { name: /src\/refund.ts:11/ })).toBeTruthy();
  });
});
