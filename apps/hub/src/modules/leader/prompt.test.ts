import { describe, expect, it } from "vitest";
import { ARTIFACT_RULE, assembleLeaderPrompt, formatTranscript, SDLC_RULE, TIER_RULE } from "./prompt.ts";

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

describe("artifact trong prompt", () => {
  it("tin nhắn thẻ kèm id và phiên bản để Leader sửa đúng bản", () => {
    const id = "6f1d2c0e-0000-4000-8000-000000000001";
    const transcript = formatTranscript([
      { role: "user", content: "Vẽ sơ đồ" },
      { role: "leader", content: "Luồng đăng nhập", artifact: { id, version: 3 } },
    ]);
    expect(transcript).toBe(`user: Vẽ sơ đồ\n\nleader: Luồng đăng nhập [artifact ${id}, phiên bản 3]`);
  });

  it("phần đuôi của tin thẻ tính vào ngân sách ký tự", () => {
    const card = { role: "leader", content: "Sơ đồ", artifact: { id: "a".repeat(36), version: 1 } };
    const first = { role: "user", content: "Bối cảnh" };
    const budget = first.content.length + first.role.length + 4 + card.content.length + card.role.length + 4;
    expect(formatTranscript([first, { role: "user", content: "Tin cũ" }, card], budget)).not.toContain("[artifact");
  });

  it("prompt giữ hướng dẫn artifact cùng đề xuất AI SDLC và chọn cấp model", () => {
    const prompt = assembleLeaderPrompt({
      transcript: "",
      projectName: "Demo",
      projectKey: "DEMO",
      defaultBranch: null,
      context: "",
    });
    expect(prompt).toContain(ARTIFACT_RULE);
    expect(prompt).toContain(SDLC_RULE);
    expect(prompt.split(SDLC_RULE)).toHaveLength(2);
    expect(prompt).toContain(TIER_RULE);
    expect(ARTIFACT_RULE).toContain("artifact_create");
    expect(ARTIFACT_RULE).toContain("artifact_update");
    expect(ARTIFACT_RULE).toContain("30 dòng");
  });
});
