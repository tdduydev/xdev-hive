import { describe, expect, it } from "vitest";
import { formatTranscript } from "./prompt.ts";

describe("formatTranscript", () => {
  it("trả về chuỗi rỗng khi danh sách tin nhắn trống", () => {
    expect(formatTranscript([])).toBe("");
  });

  it("giữ nguyên thứ tự thời gian khi tin nhắn nằm trong ngân sách", () => {
    const messages = [
      { role: "user", content: "Xin chào" },
      { role: "leader", content: "Chào bạn, tôi giúp gì được?" },
      { role: "user", content: "Hãy kiểm tra issue 1" },
    ];
    const transcript = formatTranscript(messages);
    expect(transcript).toBe("user: Xin chào\n\nleader: Chào bạn, tôi giúp gì được?\n\nuser: Hãy kiểm tra issue 1");
  });

  it("giữ tin đầu và các tin gần nhất khi vượt ngân sách", () => {
    const messages = [
      { role: "user", content: "Bối cảnh ban đầu rất quan trọng" },
      { role: "leader", content: "Tin cũ 1" },
      { role: "user", content: "Tin cũ 2" },
      { role: "leader", content: "Tin mới nhất" },
    ];
    const first = messages[0];
    const latest = messages[3];
    if (!first || !latest) throw new Error("Tin nhắn không tồn tại");
    const firstCost = first.content.length + first.role.length + 4;
    const latestCost = latest.content.length + latest.role.length + 4;
    const budget = firstCost + latestCost + 5;

    const transcript = formatTranscript(messages, budget);
    expect(transcript).toContain("Bối cảnh ban đầu rất quan trọng");
    expect(transcript).toContain("Tin mới nhất");
    expect(transcript).not.toContain("Tin cũ 1");
    expect(transcript).not.toContain("Tin cũ 2");
    // Thứ tự thời gian: tin đầu đứng trước tin mới nhất
    expect(transcript.indexOf("Bối cảnh ban đầu rất quan trọng")).toBeLessThan(transcript.indexOf("Tin mới nhất"));
  });
});
