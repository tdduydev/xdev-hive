import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { answerOf, Questions } from "./questions.tsx";
import { fakeClient, question, renderWithEnv, testEnv, uuid } from "./test-fixtures.tsx";

const user = userEvent.setup({ delay: null });

describe("answerOf", () => {
  const q = question(1);
  it("chữ tự viết thắng lựa chọn; chọn đúng đề xuất gửi useRecommended", () => {
    expect(answerOf(q, undefined)).toBeNull();
    expect(answerOf(q, { option: "Có" })).toEqual({ id: q.id, useRecommended: true });
    expect(answerOf(q, { option: "Không" })).toEqual({ id: q.id, answer: "Không" });
    expect(answerOf(q, { option: "Không", text: "  Chỉ thẻ  " })).toEqual({ id: q.id, answer: "Chỉ thẻ" });
  });
});

describe("Questions", () => {
  const other = question(9, {
    itemId: uuid(113),
    item: { ref: "013", title: "Xuất báo cáo tháng", projectKey: "web-shop" },
    text: "Báo cáo chốt lúc nào?",
    position: 1,
  });

  it("nhóm theo hạng mục và gửi câu trả lời của một hạng mục", async () => {
    const client = fakeClient({ questions: [question(1), question(2, { recommended: null }), other] });
    renderWithEnv(<Questions />, testEnv(client));
    expect(await screen.findByRole("link", { name: "012 · Hoàn tiền một phần" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "013 · Xuất báo cáo tháng" })).toBeTruthy();

    const [first] = screen.getAllByRole("radio", { name: /Không/ });
    await user.click(first as HTMLElement);
    await user.type(screen.getAllByPlaceholderText("Viết câu trả lời của bạn…")[1] as HTMLElement, "Chỉ thẻ");
    await user.click(screen.getByRole("button", { name: "Gửi câu trả lời (2/2)" }));
    await waitFor(() => expect(client.sdlc.questions.answer).toHaveBeenCalled());
    expect(client.sdlc.questions.answer.mock.calls[0]?.[0]).toEqual({
      itemId: uuid(112),
      answers: [
        { id: question(1).id, answer: "Không" },
        { id: question(2).id, answer: "Chỉ thẻ" },
      ],
    });
  });

  it("Dùng đề xuất gửi ngay một câu; lỗi gửi giữ nội dung", async () => {
    const client = fakeClient({ questions: [question(1), question(2)] });
    client.sdlc.questions.answer.mockRejectedValueOnce(new Error("Mất kết nối tới hub."));
    renderWithEnv(<Questions />, testEnv(client));
    await user.type((await screen.findAllByPlaceholderText("Viết câu trả lời của bạn…"))[1] as HTMLElement, "Giữ lại");
    await user.click(screen.getAllByRole("button", { name: "Dùng đề xuất" })[0] as HTMLElement);
    expect(await screen.findByText(/Mất kết nối tới hub\./)).toBeTruthy();
    expect(client.sdlc.questions.answer.mock.calls[0]?.[0]).toEqual({
      itemId: uuid(112),
      answers: [{ id: question(1).id, useRecommended: true }],
    });
    expect((screen.getAllByPlaceholderText("Viết câu trả lời của bạn…")[1] as HTMLTextAreaElement).value).toBe(
      "Giữ lại",
    );
  });

  it("rỗng khi không có câu hỏi; tab Đã trả lời hiện câu trả lời", async () => {
    const answered = question(3, {
      status: "answered",
      answer: "VND, số nguyên đồng",
      usedRecommended: true,
      answeredBy: { userId: "u1", name: "Trần Lan" },
      answeredAt: "2026-10-14T01:00:00.000Z",
    });
    renderWithEnv(<Questions />, testEnv(fakeClient({ questions: [answered] })));
    expect(await screen.findByText("Không có câu hỏi nào đang chờ bạn.")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Đã trả lời" }));
    expect(await screen.findByText("VND, số nguyên đồng")).toBeTruthy();
    expect(screen.getByText("Dùng đề xuất")).toBeTruthy();
  });

  it("người chỉ đọc thấy câu hỏi nhưng không trả lời được", async () => {
    renderWithEnv(
      <Questions />,
      testEnv(fakeClient({ questions: [question(1)] }), {
        can: { write: () => false, override: false, manageModes: false },
      }),
    );
    expect((await screen.findAllByText("Câu hỏi 1?")).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Dùng đề xuất" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
