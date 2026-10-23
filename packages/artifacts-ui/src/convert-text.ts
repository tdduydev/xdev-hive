import { useArtifactsEnv } from "./env.tsx";

type Dict<T> = Record<"vi" | "en", T>;

/** Chữ của hộp "Chuyển thành tài liệu" (specs/012 US11). */
export interface ConvertText {
  convert: string;
  title: string;
  lead: string;
  keyLabel: string;
  keyHelp: string;
  keyInvalid: string;
  docTitleLabel: string;
  docTitleHelp: string;
  submit: string;
  submitting: string;
  close: string;
  offline: string;
  sent: string;
  proposalId: (id: string) => string;
}

export const convertText: Dict<ConvertText> = {
  vi: {
    convert: "Chuyển thành tài liệu",
    title: "Chuyển thành tài liệu",
    lead: "Tạo đề xuất tài liệu từ phiên bản này. Tài liệu chỉ đổi sau khi người duyệt chấp nhận đề xuất.",
    keyLabel: "Key tài liệu",
    keyHelp: "Dạng org/…, team/<đội>/… hoặc project/<dự án>/…; chữ thường không dấu, số, -, _, .",
    keyInvalid: "Key chưa đúng dạng. Ví dụ: project/payment-api/quy-trinh-hoan-tien.",
    docTitleLabel: "Tiêu đề tài liệu (tuỳ chọn)",
    docTitleHelp: "Bỏ trống thì dùng tiêu đề của artifact.",
    submit: "Gửi đề xuất",
    submitting: "Đang gửi…",
    close: "Đóng",
    offline: "Đang ngoại tuyến. Kết nối lại để chuyển thành tài liệu.",
    sent: "Đã gửi đề xuất tài liệu. Người duyệt sẽ thấy trong danh sách đề xuất.",
    proposalId: (id) => `Mã đề xuất: ${id}`,
  },
  en: {
    convert: "Convert to document",
    title: "Convert to document",
    lead: "Creates a document proposal from this version. The document changes only after a reviewer accepts it.",
    keyLabel: "Document key",
    keyHelp: "Use org/…, team/<team>/… or project/<project>/…; lowercase letters without accents, digits, -, _, .",
    keyInvalid: "Key has the wrong shape. Example: project/payment-api/refund-flow.",
    docTitleLabel: "Document title (optional)",
    docTitleHelp: "Leave empty to use the artifact title.",
    submit: "Send proposal",
    submitting: "Sending…",
    close: "Close",
    offline: "You are offline. Reconnect to convert to a document.",
    sent: "Document proposal sent. Reviewers will see it in the proposals list.",
    proposalId: (id) => `Proposal id: ${id}`,
  },
};

export function useConvertText(): ConvertText {
  return convertText[useArtifactsEnv().lang];
}
