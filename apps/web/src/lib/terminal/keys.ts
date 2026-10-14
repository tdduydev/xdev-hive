/**
 * Bảng phím của thanh phím trên điện thoại: phím → chuỗi byte gửi vào PTY. Bàn phím ảo không có Esc, Tab, Ctrl, mũi tên
 * nên thanh phím bù vào. Toàn hàm thuần để test không cần trình duyệt; trạng thái giữ Ctrl/Alt nằm ở component.
 */

export const KEY_NAMES = ["esc", "tab", "up", "down", "left", "right", "enter", "slash", "ctrl-c", "ctrl-d"] as const;
export type KeyName = (typeof KEY_NAMES)[number];

/** Ctrl và Alt "giữ": bấm một lần, áp cho phím kế tiếp rồi tự nhả (bàn phím ảo không giữ hai phím cùng lúc được). */
export interface Modifiers {
  ctrl: boolean;
  alt: boolean;
}

export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false };

const ESC = "\x1b";

const ARROWS = { up: "A", down: "B", right: "C", left: "D" } as const;

const PLAIN: Record<Exclude<KeyName, keyof typeof ARROWS>, string> = {
  esc: ESC,
  tab: "\t",
  // CR như Enter trên bàn phím thật: CLI đọc chế độ raw coi "\n" là Ctrl-J, không phải gửi.
  enter: "\r",
  slash: "/",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
};

export function hasModifier(mods: Modifiers): boolean {
  return mods.ctrl || mods.alt;
}

/** Mã modifier của xterm trong chuỗi CSI `1;<n>X`: 1 + (Alt 2) + (Ctrl 4). */
function modifierParam(mods: Modifiers): number {
  return 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
}

/** Ctrl + một ký tự → mã điều khiển (a-z → 1-26, `@ [ \ ] ^ _` → 0, 27-31, `/` → 31, `?` → 127, cách → 0). Ký tự khác: null. */
export function controlCode(char: string): string | null {
  if (char.length !== 1) return null;
  if (char === " ") return "\x00";
  if (char === "?") return "\x7f";
  if (char === "/") return "\x1f";
  const code = char.toUpperCase().charCodeAt(0);
  // '@' (64) đến '_' (95) gồm cả A-Z; chữ thường đã đổi sang hoa ở trên.
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code - 0x40) : null;
}

function withAlt(data: string, mods: Modifiers): string {
  return mods.alt ? `${ESC}${data}` : data;
}

/** Chuỗi byte của một nút trên thanh phím, có áp Ctrl/Alt đang giữ. */
export function encodeKey(key: KeyName, mods: Modifiers = NO_MODIFIERS): string {
  if (key === "up" || key === "down" || key === "left" || key === "right") {
    // Mũi tên mang modifier theo cú pháp của xterm để CLI phân biệt (vd Ctrl+← nhảy từ).
    return hasModifier(mods) ? `${ESC}[1;${modifierParam(mods)}${ARROWS[key]}` : `${ESC}[${ARROWS[key]}`;
  }
  // Ctrl-C/Ctrl-D đã là mã điều khiển nên giữ thêm Ctrl không đổi gì. Ctrl + `/` là 0x1f; Ctrl + Enter/Tab/Esc không có mã riêng.
  const base = key === "slash" && mods.ctrl ? "\x1f" : PLAIN[key];
  return withAlt(base, mods);
}

/**
 * Áp Ctrl/Alt đang giữ lên chữ vừa gõ trên bàn phím ảo (xterm `onData`). Chỉ đổi khi `data` là đúng một ký tự: chuỗi dài
 * là dán hoặc chuỗi phím đặc biệt của xterm (mũi tên, F-key), không có nghĩa "Ctrl + chữ".
 */
export function applyModifiers(data: string, mods: Modifiers): string {
  if (!hasModifier(mods) || [...data].length !== 1) return data;
  const ctrl = mods.ctrl ? controlCode(data) : null;
  // Ctrl + ký tự không có mã điều khiển (vd chữ có dấu): gửi ký tự gốc, không nuốt phím.
  return withAlt(ctrl ?? data, mods);
}

/**
 * Dòng soạn sẵn → byte gửi. Ô soạn để gõ chữ Việt bằng IME rồi gửi cả dòng, vì IME ngay trong xterm trên điện thoại hay
 * lặp hoặc mất dấu. Tách chữ và Enter thành hai phần: TUI coi cụm chữ dài đến cùng lúc là dán, và CR đi kèm khi đó
 * thành xuống dòng chứ không phải gửi.
 */
export function composeLine(line: string): { text: string; submit: string } {
  return { text: line.replace(/[\r\n]+/g, " "), submit: PLAIN.enter };
}
