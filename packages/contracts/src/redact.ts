import { PRIVATE_KEY_END, secretSpans } from "./secret-scan.ts";

/**
 * Che bí mật trong log triển khai theo từng đoạn (specs/020 FR-019, plan.md mục 7): giá trị biến bí mật của đích cộng
 * bộ mẫu của `secret-scan.ts`. Khác `redactSecrets` (che một chuỗi trọn vẹn) ở chỗ bí mật cắt ngang hai đoạn vẫn bị che,
 * nên phải giữ lại đuôi của đoạn trước tới khi ghép được.
 */
export interface Redactor {
  /** Nhận một đoạn log, trả phần đã che chắc chắn; phần đuôi có thể là đầu của một bí mật thì giữ lại. */
  push(chunk: string): string;
  /** Hết log: trả phần còn giữ, đã che. */
  flush(): string;
}

/** Chữ thay cho bí mật trong log triển khai (plan.md mục 7), giống bộ che của worker (`terminal/redact.go`). */
export const LOG_SECRET_MASK = "***";

// Đuôi giữ lại của mỗi đoạn: đủ cho mọi token của bộ mẫu và dòng `KEY=value` thường gặp (plan.md mục 7).
const TAIL = 200;
// [Suy luận] Giá trị ngắn hơn thế ("1", "on") mà che thì nát cả log; biến bí mật thật hiếm khi ngắn vậy.
const MIN_SECRET = 4;
// [Suy luận] Khoá riêng chưa thấy dòng END thì phải giữ cả khối; quá ngưỡng này thì che luôn phần đã nhận và bỏ phần sau
// tới END, để log in khoá hỏng (thiếu END) không làm hub giữ bộ nhớ mãi.
const MAX_HELD = 64 * 1024;

// CSI (màu, di chuyển con trỏ), OSC (tiêu đề, link) và lệnh hai ký tự. Mã màu chen giữa `KEY=` và giá trị, hay giữa các
// ký tự của bí mật, làm mẫu không khớp nên phải so trên chữ đã bỏ mã.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC là ký tự mở đầu của mã ANSI.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

interface Span {
  /** Đầu đoạn khớp: cắt đoạn ở giữa [`index`, `end`) thì phần sau mất ngữ cảnh (tên biến, dòng BEGIN). */
  index: number;
  start: number;
  end: number;
  /** Khoá riêng chưa có dòng END. */
  open: boolean;
}

/** Bỏ mã ANSI; `at[i]` là vị trí trong chữ gốc của ký tự thứ `i`, `at[text.length]` là độ dài chữ gốc. */
function visible(raw: string): { text: string; at: number[]; codes: [number, number][] } {
  let text = "";
  const at: number[] = [];
  const codes: [number, number][] = [];
  let from = 0;
  const keep = (to: number) => {
    text += raw.slice(from, to);
    for (let i = from; i < to; i++) at.push(i);
  };
  for (const m of raw.matchAll(ANSI)) {
    keep(m.index);
    from = m.index + m[0].length;
    codes.push([m.index, from]);
  }
  keep(raw.length);
  at.push(raw.length);
  return { text, at, codes };
}

export function createRedactor(secrets: readonly string[]): Redactor {
  const values = [...new Set(secrets.filter((s) => s.length >= MIN_SECRET))];
  const keep = Math.max(TAIL, ...values.map((s) => s.length));
  const keyEnd = new RegExp(PRIVATE_KEY_END.source);
  let held = "";
  // Đã che phần đầu của một khoá riêng quá dài, đang bỏ chữ tới dòng END.
  let dropping = false;

  const spansOf = (raw: string): { spans: Span[]; codes: [number, number][] } => {
    const { text, at, codes } = visible(raw);
    const span = (index: number, start: number, end: number, open: boolean): Span => ({
      index: at[index] ?? raw.length,
      start: at[start] ?? raw.length,
      end: (at[end - 1] ?? raw.length - 1) + 1,
      open,
    });
    const spans = secretSpans(text).map((s) =>
      span(s.index, s.start, s.end, s.kind === "private_key" && !keyEnd.test(text.slice(s.start, s.end))),
    );
    for (const v of values) {
      for (let i = text.indexOf(v); i !== -1; i = text.indexOf(v, i + 1)) spans.push(span(i, i, i + v.length, false));
    }
    return { spans: spans.sort((a, b) => a.start - b.start), codes };
  };

  const mask = (raw: string, spans: Span[], cut: number): string => {
    let out = "";
    let from = 0;
    for (const s of spans) {
      if (s.start >= cut) break;
      if (s.end <= from) continue;
      if (s.start >= from) out += raw.slice(from, s.start) + LOG_SECRET_MASK;
      from = s.end;
    }
    return out + raw.slice(from, cut);
  };

  const process = (raw: string, final: boolean): string => {
    const { spans, codes } = spansOf(raw);
    if (final) {
      held = "";
      return mask(raw, spans, raw.length);
    }
    // Lùi chỗ cắt ra khỏi mọi đoạn khớp, mã ANSI và cặp surrogate nằm ngang nó; lùi có thể rơi vào đoạn khác nên lặp tới
    // khi đứng yên.
    let cut = Math.max(0, raw.length - keep);
    for (let prev = -1; prev !== cut; ) {
      prev = cut;
      for (const s of spans) if (s.index < cut && cut < s.end) cut = s.index;
      for (const [a, b] of codes) if (a < cut && cut < b) cut = a;
      const c = raw.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut--;
    }
    // Phần giữ quá lớn vì một đoạn khớp rất dài bắt đầu ở `cut`: che luôn nó. Khoá riêng còn mở thì bỏ chữ tới END; đoạn
    // khác (token dài bất thường) thì phần còn lại của nó tới sau không còn bị nhận ra, chấp nhận vì không có bí mật thật
    // nào dài như vậy.
    const long = spans.filter((s) => s.index === cut).sort((a, b) => b.end - a.end)[0];
    if (raw.length - cut <= MAX_HELD || !long) {
      held = raw.slice(cut);
      return mask(raw, spans, cut);
    }
    dropping = long.open;
    held = dropping ? "" : raw.slice(long.end);
    return mask(raw, spans, cut) + LOG_SECRET_MASK;
  };

  const skipKey = (raw: string): string => {
    const close = keyEnd.exec(raw);
    if (!close) {
      held = raw.slice(-TAIL);
      return "";
    }
    dropping = false;
    held = "";
    return raw.slice(close.index + close[0].length);
  };

  return {
    push(chunk) {
      let raw = held + chunk;
      if (dropping) {
        raw = skipKey(raw);
        if (dropping) return "";
      }
      return process(raw, false);
    },
    flush() {
      const raw = held;
      held = "";
      if (dropping) {
        dropping = false;
        return "";
      }
      return process(raw, true);
    },
  };
}
