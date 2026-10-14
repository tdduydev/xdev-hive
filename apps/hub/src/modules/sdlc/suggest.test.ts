import { describe, expect, it } from "vitest";
import { foldText, type SuggestInput, type SuggestMode, suggestSdlc } from "./suggest.ts";

const bugfix: SuggestMode = { ref: "bugfix", name: "Sửa lỗi", sizes: ["S"], profile: "bugfix" };
const small: SuggestMode = { ref: "small", name: "Việc nhỏ", sizes: ["S"], profile: "small" };
const express: SuggestMode = { ref: "aidlc-express", name: "AI-DLC Express", sizes: ["M"], profile: "express" };
const speckit: SuggestMode = { ref: "speckit", name: "Spec Kit", sizes: ["M", "L"], profile: "feature" };

const base = (over: Partial<SuggestInput> = {}): SuggestInput => ({
  title: "Hoàn tiền một phần",
  idea: "Cho phép hoàn tiền một phần cho đơn đã giao để chăm sóc khách hàng xử lý nhanh hơn.",
  riskKeywords: [],
  modes: [speckit, bugfix, small],
  ...over,
});

const longIdea = (n: number) => Array.from({ length: n }, (_, i) => `Dòng mô tả số ${i} của tính năng.`).join(" ");

describe("suggestSdlc", () => {
  it("issue có nhãn bug và mô tả ngắn gợi ý bugfix cỡ S, lý do nhắc nhãn", () => {
    const s = suggestSdlc(
      base({
        title: "Trang đơn hàng bị trắng",
        idea: "Mở trang đơn hàng thì trắng.\nXảy ra trên Safari.\nConsole báo lỗi undefined.",
        labels: ["bug", "frontend"],
      }),
    );
    expect(s).toMatchObject({ size: "S", modeRef: "bugfix" });
    expect(s.reason).toContain("bug");
    expect(s.alternatives.map((a) => a.modeRef)).toContain("small");
  });

  it("ý tưởng hai đoạn có từ khoá rủi ro của dự án cho cỡ từ M, chế độ speckit", () => {
    const s = suggestSdlc(
      base({
        idea: "Cho phép hoàn tiền một phần cho đơn đã giao.\n\nPhần thanh toán cần ghi nhận hai lần đối soát với cổng.",
        riskKeywords: ["thanh toán"],
      }),
    );
    expect(["M", "L", "XL"]).toContain(s.size);
    expect(s.modeRef).toBe("speckit");
    expect(s.reason).toContain("thanh toán");
  });

  it("từ khoá khớp không phân biệt hoa thường và dấu, và khớp trọn từ", () => {
    const withKw = (kw: string, idea: string) => suggestSdlc(base({ idea, riskKeywords: [kw] })).size;
    expect(withKw("thanh toán", "Sửa luồng THANH TOAN của đơn hàng cho khách lẻ.")).not.toBe("S");
    expect(withKw("token", "Thêm hàm tokenize cho ô tìm kiếm của trang danh sách.")).toBe("S");
  });

  it("mô tả ngắn, không tín hiệu nào: cỡ S và chế độ cỡ S không phải sửa lỗi", () => {
    const s = suggestSdlc(base());
    expect(s).toMatchObject({ size: "S", modeRef: "small" });
  });

  it("mô tả dài nhiều gạch đầu dòng lên L hoặc hơn", () => {
    const idea = `${longIdea(60)}\n${Array.from({ length: 8 }, (_, i) => `- Mục ${i} cần làm cho màn hình`).join("\n")}`;
    const s = suggestSdlc(base({ idea, labels: ["enhancement"] }));
    expect(["L", "XL"]).toContain(s.size);
    expect(s.modeRef).toBe("speckit");
  });

  it("nhãn epic và breaking đẩy cỡ lên, XL dùng chế độ gần nhất và nói rõ", () => {
    const s = suggestSdlc(base({ idea: longIdea(40), labels: ["epic", "breaking-change", "feature"] }));
    expect(s.size).toBe("XL");
    expect(s.modeRef).toBe("speckit");
    expect(s.reason).toContain("gần nhất");
  });

  it("việc nhỏ có nhãn bug mà đụng rủi ro lên M, không dùng chế độ sửa lỗi cỡ S", () => {
    const s = suggestSdlc(
      base({
        modes: [express, bugfix, small],
        idea: "Lỗi hoàn tiền trả sai số tiền khi đơn có mã giảm giá và phí vận chuyển.",
        labels: ["bug"],
        riskKeywords: ["hoàn tiền"],
      }),
    );
    expect(s.size).toBe("M");
    expect(s.modeRef).toBe("aidlc-express");
  });

  it("chế độ mặc định của dự án thắng khi nhiều chế độ cùng hợp cỡ", () => {
    const modes = [express, { ...speckit, ref: "speckit-2", name: "Spec Kit 2" }, speckit] as const;
    const idea = longIdea(15);
    expect(suggestSdlc(base({ idea, modes, defaultMode: "speckit-2" })).modeRef).toBe("speckit-2");
    expect(suggestSdlc(base({ idea, modes, defaultMode: "speckit" })).modeRef).toBe("speckit");
  });

  it("kết quả không đổi giữa các lần gọi", () => {
    const input = base({ idea: longIdea(20), riskKeywords: ["mật khẩu"] });
    expect(suggestSdlc(input)).toEqual(suggestSdlc(input));
  });

  it("tiêu đề báo lỗi chỉ là tín hiệu yếu, nhãn tính năng thắng", () => {
    const s = suggestSdlc(base({ title: "Fix: thêm cột ngày", labels: ["feature"], modes: [bugfix, small] }));
    expect(s.modeRef).toBe("small");
  });
});

describe("foldText", () => {
  it("bỏ dấu tiếng Việt và hạ chữ thường", () => {
    expect(foldText("Đã THANH TOÁN, Hoàn tiền")).toBe("da thanh toan, hoan tien");
  });
});
